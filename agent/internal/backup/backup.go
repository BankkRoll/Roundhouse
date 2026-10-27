// Package backup runs the node's side of backups, restores and volume
// migration copies (ADR 0004, "Backups", "Restore" and "Volume migration";
// ADR 0015 for the sealed frames).
//
// Responsibilities:
//   - open each job's sealed part URLs or download secrets with the node's
//     key, bound to the node and the job;
//   - back up: read the source (an engine dump run inside the database
//     container, or a tar walk of the volume, optionally with the workload
//     stopped), write it as RHBK1, compress it with zstd, encrypt it to the
//     project's age recipient, cut it into parts of exactly part_size_bytes
//     (the last shorter) and PUT them two at a time to the presigned URLs,
//     asking for more URLs as needed; report ETags in backup_progress and
//     the outcome in backup_result;
//   - restore: download the object to scratch space while hashing it,
//     verify its SHA-256 before anything is applied, then decrypt,
//     decompress and apply each entry, and answer restore_result;
//   - take Postgres base backups and run point-in-time restores from them
//     (./pitr.go);
//   - never leave a workload stopped: every stop is paired with a start,
//     and a snapshot or base restore that doesn't come up healthy is
//     rolled back.
package backup

import (
	"context"
	"crypto/ecdh"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"filippo.io/age"
	"github.com/klauspost/compress/zstd"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/rhbk"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// Docker is the subset of the engine API tasks use; *docker.Client
// implements it.
type Docker interface {
	InspectContainer(ctx context.Context, id string) (docker.ContainerInfo, error)
	RunExec(ctx context.Context, containerID string, run docker.ExecRun) (int, error)
	CreateContainer(ctx context.Context, name string, spec docker.ContainerCreate) (string, error)
	StartContainer(ctx context.Context, id string) error
	StopContainer(ctx context.Context, id string, timeout time.Duration) error
	RemoveContainer(ctx context.Context, id string) error
}

// Workloads is the runtime's side of a task: finding a workload's
// container, keeping it stopped for a while, and waiting for it to be
// healthy again.
type Workloads interface {
	// Container returns the ID of the workload's current container and
	// whether it is running.
	Container(workloadID string) (id string, running, ok bool)
	// Hold stops the workload (SIGTERM, its stop grace, SIGKILL) and keeps
	// it stopped until release is called, which starts it again.
	Hold(ctx context.Context, workloadID, reason string) (release func(), err error)
	// WaitHealthy waits until the workload's container is running and
	// healthy.
	WaitHealthy(ctx context.Context, workloadID string) error
}

// Volumes is the volume manager's side of a task.
type Volumes interface {
	// Use pins a ready volume against deletion until release is called and
	// returns its data directory.
	Use(volumeID string) (dataPath string, release func(), err error)
	// TempDir is scratch space on the volumes' filesystem.
	TempDir() (string, error)
}

// Options configures a [Runner].
type Options struct {
	Docker    Docker
	Workloads Workloads
	Volumes   Volumes
	// Key is the node's X25519 key, which opens the jobs' sealed boxes.
	Key    *ecdh.PrivateKey
	NodeID string
	// Send delivers backup_progress, backup_parts_request, backup_result
	// and restore_result frames.
	Send func(ctx context.Context, m protocol.AgentMessage) error
	// Log receives task output lines (the "task" log source); nil drops
	// them.
	Log    func(taskID string, stream protocol.LogStream, text string)
	Logger *slog.Logger
	// HTTPClient makes the presigned requests; nil uses a client that
	// never follows redirects.
	HTTPClient *http.Client
	// ResultRetry bounds how long a result is retried while the connection
	// is down; zero means 15 minutes.
	ResultRetry time.Duration
	// HealthTimeout bounds the wait for a workload to be healthy after a
	// snapshot restore; zero means 10 minutes.
	HealthTimeout time.Duration
}

// Runner executes backup, restore and copy tasks. Create it with [New] and
// run it with [Runner.Run]; tasks started before Run returns finish or are
// cancelled when it does.
type Runner struct {
	opts Options
	log  *slog.Logger
	http *http.Client

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu sync.Mutex
	// backups holds the URL book of every running backup by backup ID.
	backups map[string]*partURLs
	// tasks holds the IDs of running tasks, so a redelivered job is not run
	// twice.
	tasks map[string]bool
	// volumes holds the volume each running task works on, so two tasks
	// never touch one volume at once.
	volumes map[string]string
	// walBooks holds the WAL URL inbox of every running base restore.
	walBooks map[string]*walBook
}

// New returns a runner.
func New(opts Options) *Runner {
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	hc := opts.HTTPClient
	if hc == nil {
		hc = &http.Client{
			// SECURITY: a presigned URL is a bearer credential scoped to one
			// object; a redirect would carry the body somewhere else.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
	}
	if opts.ResultRetry == 0 {
		opts.ResultRetry = 15 * time.Minute
	}
	if opts.HealthTimeout == 0 {
		opts.HealthTimeout = 10 * time.Minute
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Runner{
		opts: opts, log: log, http: hc, ctx: ctx, cancel: cancel,
		backups: map[string]*partURLs{}, tasks: map[string]bool{}, volumes: map[string]string{},
		walBooks: map[string]*walBook{},
	}
}

// Run waits until ctx ends, then cancels running tasks and waits for them
// (each restarts any workload it stopped).
func (r *Runner) Run(ctx context.Context) error {
	<-ctx.Done()
	r.cancel()
	r.wg.Wait()
	return nil
}

// claim registers a task on a volume, refusing a duplicate or a second task
// on the same volume.
func (r *Runner) claim(taskID, volumeID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.tasks[taskID] {
		return fmt.Errorf("task %s is already running", taskID)
	}
	if other, busy := r.volumes[volumeID]; busy {
		return fmt.Errorf("volume %s is busy with task %s", volumeID, other)
	}
	r.tasks[taskID] = true
	r.volumes[volumeID] = taskID
	return nil
}

func (r *Runner) unclaim(taskID, volumeID string) {
	r.mu.Lock()
	delete(r.tasks, taskID)
	if r.volumes[volumeID] == taskID {
		delete(r.volumes, volumeID)
	}
	r.mu.Unlock()
}

func (r *Runner) taskLog(taskID string) func(string) {
	return func(line string) {
		if r.opts.Log != nil {
			r.opts.Log(taskID, protocol.StreamStderr, line)
		}
	}
}

func (r *Runner) system(taskID, format string, args ...any) {
	if r.opts.Log != nil {
		r.opts.Log(taskID, protocol.StreamSystem, fmt.Sprintf(format, args...))
	}
}

// deliver sends a frame that must arrive (a result or progress), retrying
// while the connection is down.
func (r *Runner) deliver(ctx context.Context, m protocol.AgentMessage) error {
	deadline := time.Now().Add(r.opts.ResultRetry)
	delay := time.Second
	for {
		sctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := r.opts.Send(sctx, m)
		cancel()
		if err == nil || ctx.Err() != nil || time.Now().After(deadline) {
			return err
		}
		if !sleepCtx(ctx, delay) {
			return ctx.Err()
		}
		delay = min(delay*2, 30*time.Second)
	}
}

// -----------------------------------------------------------------------------
// Backups
// -----------------------------------------------------------------------------

// backupTask is a backup_job or volume_copy_out, normalised.
type backupTask struct {
	backupID string
	source   protocol.BackupSource
	quiesce  bool
	dbs      *[]string
	// recipient is the project's age recipient.
	recipient string
	partSize  int64
	parts     []protocol.BackupPartURL
	timeout   time.Duration
}

// StartBackup opens a backup_job's part URLs and runs it in the background.
// A job that can't start is answered with a failed backup_result at once.
func (r *Runner) StartBackup(m *protocol.BackupJob) {
	parts, err := protocol.OpenBackupParts(r.opts.Key, r.opts.NodeID, m.BackupID, &m.PartsSealed)
	t := backupTask{
		backupID: m.BackupID, source: m.BackupSource, quiesce: m.Quiesce == "stop", dbs: m.Databases,
		recipient: m.AgeRecipient, partSize: m.PartSizeBytes, parts: parts,
		timeout: time.Duration(m.TimeoutS) * time.Second,
	}
	r.startBackup(t, err)
}

// StartCopyOut runs a volume_copy_out: a snapshot backup with the workload,
// if one still runs, stopped. It is answered like a backup of BackupID.
func (r *Runner) StartCopyOut(m *protocol.VolumeCopyOut) {
	parts, err := protocol.OpenBackupParts(r.opts.Key, r.opts.NodeID, m.BackupID, &m.PartsSealed)
	t := backupTask{
		backupID: m.BackupID,
		source: protocol.BackupSource{
			Method: protocol.BackupSnapshot, WorkloadID: m.WorkloadID, VolumeID: m.VolumeID,
		},
		quiesce: m.WorkloadID != "", recipient: m.AgeRecipient, partSize: m.PartSizeBytes, parts: parts,
		timeout: time.Duration(m.TimeoutS) * time.Second,
	}
	r.startBackup(t, err)
}

func (r *Runner) startBackup(t backupTask, openErr error) {
	start := time.Now()
	fail := func(err error) {
		r.log.Error("backup failed", "backup_id", t.backupID, "err", err)
		r.wg.Add(1)
		go func() {
			defer r.wg.Done()
			r.sendBackupResult(t.backupID, start, nil, err)
		}()
	}
	if openErr != nil {
		fail(openErr)
		return
	}
	if err := r.claim(t.backupID, t.source.VolumeID); err != nil {
		// NOTE: a redelivered job for a running backup is not answered; the
		// running one answers.
		r.log.Warn("not starting backup", "backup_id", t.backupID, "err", err)
		r.mu.Lock()
		dup := r.tasks[t.backupID]
		r.mu.Unlock()
		if !dup {
			fail(err)
		}
		return
	}
	book := newPartURLs(t.parts, func(ctx context.Context, from, count int) error {
		return r.opts.Send(ctx, &protocol.BackupPartsRequest{
			Type: protocol.TypeBackupPartsRequest, BackupID: t.backupID, FromPart: from, Count: count,
		})
	})
	r.mu.Lock()
	r.backups[t.backupID] = book
	r.mu.Unlock()
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		defer func() {
			r.mu.Lock()
			delete(r.backups, t.backupID)
			r.mu.Unlock()
			r.unclaim(t.backupID, t.source.VolumeID)
		}()
		ctx, cancel := context.WithTimeout(r.ctx, t.timeout)
		defer cancel()
		stats, err := r.runBackup(ctx, t, book)
		if err != nil {
			r.log.Error("backup failed", "backup_id", t.backupID, "err", err)
			r.system(t.backupID, "backup failed: %v", err)
		} else {
			r.log.Info("backup finished", "backup_id", t.backupID, "parts", stats.parts, "bytes_stored", stats.stored)
			r.system(t.backupID, "backup finished: %d parts, %d bytes stored", stats.parts, stats.stored)
		}
		r.sendBackupResult(t.backupID, start, &stats, err)
	}()
}

// AddParts hands a backup_parts frame's URLs to its running backup.
func (r *Runner) AddParts(m *protocol.BackupParts) {
	r.mu.Lock()
	book := r.backups[m.BackupID]
	r.mu.Unlock()
	if book == nil {
		r.log.Warn("dropping part URLs for a backup that is not running", "backup_id", m.BackupID)
		return
	}
	parts, err := protocol.OpenBackupParts(r.opts.Key, r.opts.NodeID, m.BackupID, &m.PartsSealed)
	if err != nil {
		r.log.Error("cannot open part URLs", "backup_id", m.BackupID, "err", err)
		return
	}
	book.add(parts)
}

type backupStats struct {
	parts       int
	raw, stored int64
	sha256      string
	// walStart is a base backup's first WAL segment.
	walStart string
}

func (r *Runner) sendBackupResult(backupID string, start time.Time, st *backupStats, err error) {
	res := &protocol.BackupResult{
		Type: protocol.TypeBackupResult, BackupID: backupID, OK: err == nil,
		DurationMS: time.Since(start).Milliseconds(),
	}
	if err != nil {
		res.Error = truncate(err.Error(), protocol.MaxMessageBytes)
	} else {
		parts, raw, stored := st.parts, st.raw, st.stored
		res.PartCount, res.BytesRaw, res.BytesStored, res.SHA256 = &parts, &raw, &stored, st.sha256
		res.WALStart = st.walStart
	}
	if sendErr := r.deliver(r.ctx, res); sendErr != nil {
		r.log.Error("could not deliver backup_result", "backup_id", backupID, "err", sendErr)
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for len(s) > 0 && s[len(s)-1]&0xc0 == 0x80 {
		s = s[:len(s)-1]
	}
	if len(s) > 0 && s[len(s)-1] >= 0xc0 {
		s = s[:len(s)-1]
	}
	return s
}

// progress batches uploaded parts into backup_progress frames.
type progress struct {
	r        *Runner
	backupID string
	raw      func() int64

	mu      sync.Mutex
	pending []protocol.UploadedPart
}

func (p *progress) add(ctx context.Context, part protocol.UploadedPart) {
	p.mu.Lock()
	p.pending = append(p.pending, part)
	p.mu.Unlock()
	p.flush(ctx, false)
}

// flush sends the pending parts. With must set it retries until they are
// delivered (the result may not precede them); otherwise a failed send
// keeps them for the next flush.
func (p *progress) flush(ctx context.Context, must bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	for len(p.pending) > 0 {
		n := min(len(p.pending), protocol.MaxBackupProgressParts)
		m := &protocol.BackupProgress{
			Type: protocol.TypeBackupProgress, BackupID: p.backupID, Parts: p.pending[:n:n], BytesRaw: p.raw(),
		}
		var err error
		if must {
			err = p.r.deliver(ctx, m)
		} else {
			sctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err = p.r.opts.Send(sctx, m)
			cancel()
		}
		if err != nil {
			return err
		}
		p.pending = p.pending[n:]
	}
	return nil
}

// countWriter counts bytes on their way to w.
type countWriter struct {
	w io.Writer
	n int64
	sync.Mutex
}

func (c *countWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.Lock()
	c.n += int64(n)
	c.Unlock()
	return n, err
}

func (c *countWriter) count() int64 {
	c.Lock()
	defer c.Unlock()
	return c.n
}

func (r *Runner) runBackup(ctx context.Context, t backupTask, book *partURLs) (backupStats, error) {
	recipient, err := age.ParseX25519Recipient(t.recipient)
	if err != nil {
		return backupStats{}, fmt.Errorf("age recipient: %w", err)
	}
	dataPath, release, err := r.opts.Volumes.Use(t.source.VolumeID)
	if err != nil {
		return backupStats{}, err
	}
	defer release()
	scratch, err := r.opts.Volumes.TempDir()
	if err != nil {
		return backupStats{}, err
	}

	var raw *countWriter
	prog := &progress{r: r, backupID: t.backupID, raw: func() int64 { return raw.count() }}
	up := newUploader(ctx, t.partSize, book, r.http, scratch, func(p protocol.UploadedPart) { prog.add(ctx, p) })
	enc, err := age.Encrypt(up, recipient)
	if err != nil {
		return backupStats{}, err
	}
	zw, err := zstd.NewWriter(enc, zstd.WithEncoderLevel(zstd.SpeedDefault), zstd.WithEncoderConcurrency(2))
	if err != nil {
		return backupStats{}, err
	}
	raw = &countWriter{w: zw}
	w, err := rhbk.NewWriter(raw)
	if err != nil {
		zw.Close()
		return backupStats{}, err
	}

	walStart, srcErr := r.readSource(ctx, t, dataPath, w)
	if srcErr == nil {
		srcErr = w.Close()
	}
	if srcErr == nil {
		srcErr = zw.Close()
	} else {
		zw.Close()
	}
	if srcErr == nil {
		srcErr = enc.Close()
	}
	if srcErr != nil {
		// Stop the uploads before reporting: a failure upstream must not
		// leave PUTs running.
		up.fail(srcErr)
	}
	parts, upErr := up.Close()
	if srcErr != nil {
		return backupStats{}, srcErr
	}
	if upErr != nil {
		return backupStats{}, upErr
	}
	if err := prog.flush(ctx, true); err != nil {
		return backupStats{}, fmt.Errorf("report uploaded parts: %w", err)
	}
	return backupStats{parts: parts, raw: w.RawBytes(), stored: up.stored, sha256: up.digest(), walStart: walStart}, nil
}

// readSource writes the backup's entries and, for a base backup, returns
// the WAL segment its replay starts from.
func (r *Runner) readSource(ctx context.Context, t backupTask, dataPath string, w *rhbk.Writer) (string, error) {
	switch t.source.Method {
	case protocol.BackupDump:
		target, err := r.target(ctx, t.source.WorkloadID, t.backupID)
		if err != nil {
			return "", err
		}
		r.system(t.backupID, "dumping %s from workload %s", t.source.Engine, t.source.WorkloadID)
		return "", target.dump(ctx, t.source.Engine, t.dbs, w)
	case protocol.BackupBase:
		target, err := r.target(ctx, t.source.WorkloadID, t.backupID)
		if err != nil {
			return "", err
		}
		r.system(t.backupID, "taking a base backup of workload %s", t.source.WorkloadID)
		return target.baseBackup(ctx, t.backupID, w)
	case protocol.BackupSnapshot:
		if t.quiesce {
			release, err := r.opts.Workloads.Hold(ctx, t.source.WorkloadID, "stopped for a snapshot backup")
			if err != nil {
				return "", fmt.Errorf("stop workload %s: %w", t.source.WorkloadID, err)
			}
			defer release()
		}
		r.system(t.backupID, "archiving volume %s", t.source.VolumeID)
		e, err := w.Create(rhbk.Header{Name: "volume.tar", Engine: string(t.source.Engine), Format: rhbk.FormatTar})
		if err != nil {
			return "", err
		}
		if err := writeTar(ctxWriter{ctx, e}, dataPath, func(name string) {
			r.system(t.backupID, "skipped %s: not a file, directory or link", name)
		}); err != nil {
			return "", fmt.Errorf("archive volume: %w", err)
		}
		return "", e.Close()
	}
	return "", fmt.Errorf("unsupported method %q", t.source.Method)
}

// ctxWriter fails writes once ctx ends, so a tar walk stops on timeout.
type ctxWriter struct {
	ctx context.Context
	w   io.Writer
}

func (c ctxWriter) Write(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.w.Write(p)
}

// target resolves the running database container of a workload.
func (r *Runner) target(ctx context.Context, workloadID, taskID string) (*engineTarget, error) {
	id, running, ok := r.opts.Workloads.Container(workloadID)
	if !ok || !running {
		return nil, fmt.Errorf("workload %s has no running container on this node", workloadID)
	}
	info, err := r.opts.Docker.InspectContainer(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("inspect workload %s: %w", workloadID, err)
	}
	return &engineTarget{d: r.opts.Docker, container: id, env: envMap(info.Config.Env), log: r.taskLog(taskID)}, nil
}

// -----------------------------------------------------------------------------
// Restores
// -----------------------------------------------------------------------------

// restoreTask is a restore_job or volume_copy_in, normalised.
type restoreTask struct {
	// id is the restore ID, or the migration ID of a copy-in.
	id      string
	source  protocol.BackupSource
	target  protocol.RestoreTarget
	secrets protocol.SealedRestoreSecrets
	// pitr is set for a base restore.
	pitr *protocol.PITRRecovery
}

// StartRestore runs a restore_job in the background.
func (r *Runner) StartRestore(m *protocol.RestoreJob) {
	s, err := protocol.OpenRestoreSecrets(r.opts.Key, r.opts.NodeID, m.RestoreID, &m.SecretsSealed)
	if err == nil && (m.Method == protocol.BackupBase) != (m.PITR != nil) {
		err = errors.New("a base restore needs its recovery settings")
	}
	r.startRestore(restoreTask{id: m.RestoreID, source: m.BackupSource, target: m.RestoreTarget, secrets: s, pitr: m.PITR}, err)
}

// StartCopyIn runs a volume_copy_in: a snapshot restore into a volume no
// workload uses yet, answered by restore_result for the migration ID.
func (r *Runner) StartCopyIn(m *protocol.VolumeCopyIn) {
	s, err := protocol.OpenRestoreSecrets(r.opts.Key, r.opts.NodeID, m.MigrationID, &m.SecretsSealed)
	r.startRestore(restoreTask{
		id:     m.MigrationID,
		source: protocol.BackupSource{Method: protocol.BackupSnapshot, VolumeID: m.VolumeID},
		target: m.RestoreTarget, secrets: s,
	}, err)
}

func (r *Runner) startRestore(t restoreTask, openErr error) {
	start := time.Now()
	if openErr == nil {
		openErr = r.claim(t.id, t.source.VolumeID)
		if openErr != nil {
			r.mu.Lock()
			dup := r.tasks[t.id]
			r.mu.Unlock()
			if dup {
				r.log.Warn("not starting restore", "restore_id", t.id, "err", openErr)
				return
			}
		}
	}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		var bytes int64
		err := openErr
		if err == nil {
			defer r.unclaim(t.id, t.source.VolumeID)
			ctx, cancel := context.WithTimeout(r.ctx, time.Duration(t.target.TimeoutS)*time.Second)
			bytes, err = r.runRestore(ctx, t)
			cancel()
		}
		res := &protocol.RestoreResult{
			Type: protocol.TypeRestoreResult, RestoreID: t.id, OK: err == nil, DurationMS: time.Since(start).Milliseconds(),
		}
		if err != nil {
			r.log.Error("restore failed", "restore_id", t.id, "err", err)
			r.system(t.id, "restore failed: %v", err)
			res.Error = truncate(err.Error(), protocol.MaxMessageBytes)
		} else {
			r.log.Info("restore finished", "restore_id", t.id, "bytes", bytes)
			r.system(t.id, "restore finished: %d bytes", bytes)
			res.Bytes = &bytes
		}
		if sendErr := r.deliver(r.ctx, res); sendErr != nil {
			r.log.Error("could not deliver restore_result", "restore_id", t.id, "err", sendErr)
		}
	}()
}

func (r *Runner) runRestore(ctx context.Context, t restoreTask) (int64, error) {
	identity, err := age.ParseX25519Identity(t.secrets.AgeIdentity)
	if err != nil {
		return 0, errors.New("age identity: invalid")
	}
	dataPath, release, err := r.opts.Volumes.Use(t.source.VolumeID)
	if err != nil {
		return 0, err
	}
	defer release()
	scratch, err := r.opts.Volumes.TempDir()
	if err != nil {
		return 0, err
	}
	r.system(t.id, "downloading backup %s (%d bytes)", t.target.BackupID, t.target.SizeBytes)
	f, err := r.download(ctx, t, scratch)
	if err != nil {
		return 0, err
	}
	defer func() {
		f.Close()
		os.Remove(f.Name())
	}()

	dec, err := age.Decrypt(f, identity)
	if err != nil {
		return 0, fmt.Errorf("decrypt: %w", err)
	}
	zr, err := zstd.NewReader(dec, zstd.WithDecoderConcurrency(2))
	if err != nil {
		return 0, err
	}
	defer zr.Close()
	rr, err := rhbk.NewReader(zr)
	if err != nil {
		return 0, err
	}
	switch t.source.Method {
	case protocol.BackupSnapshot:
		return r.restoreSnapshot(ctx, t, dataPath, rr)
	case protocol.BackupDump:
		return r.restoreDump(ctx, t, dataPath, rr)
	case protocol.BackupBase:
		return r.restoreBase(ctx, t, identity, dataPath, rr)
	}
	return 0, fmt.Errorf("unsupported method %q", t.source.Method)
}

// download fetches the object into scratch, hashing it on the way, and
// returns the file once its size and SHA-256 match the job.
//
// SECURITY: nothing is decrypted or applied before the digest matches, so
// a tampered or truncated object is refused whole.
func (r *Runner) download(ctx context.Context, t restoreTask, scratch string) (*os.File, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, t.secrets.DownloadURL, nil)
	if err != nil {
		return nil, errors.New("download: invalid URL")
	}
	resp, err := r.http.Do(req)
	if err != nil {
		return nil, errors.New("download: " + redactURLError(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download: HTTP %d", resp.StatusCode)
	}
	f, err := os.CreateTemp(scratch, "restore-*")
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*os.File, error) {
		f.Close()
		os.Remove(f.Name())
		return nil, err
	}
	sum := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, sum), io.LimitReader(resp.Body, t.target.SizeBytes+1))
	if err != nil {
		return fail(fmt.Errorf("download: %w", err))
	}
	if n != t.target.SizeBytes {
		return fail(fmt.Errorf("download: got %d bytes, expected %d", n, t.target.SizeBytes))
	}
	if got := hex.EncodeToString(sum.Sum(nil)); got != t.target.SHA256 {
		return fail(errors.New("download: SHA-256 mismatch; the stored backup does not match its record"))
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return fail(err)
	}
	return f, nil
}

// restoreSnapshot replaces the volume's data with the archive's. With a
// workload it is stopped first, and the old data is kept aside until the
// workload is healthy on the new data, else put back.
func (r *Runner) restoreSnapshot(ctx context.Context, t restoreTask, dataPath string, rr *rhbk.Reader) (int64, error) {
	h, err := rr.Next()
	if err != nil {
		return 0, fmt.Errorf("read backup: %w", err)
	}
	if h.Format != rhbk.FormatTar {
		return 0, fmt.Errorf("backup entry %s is not a snapshot", h.Name)
	}
	var release func()
	if t.source.WorkloadID != "" {
		if release, err = r.opts.Workloads.Hold(ctx, t.source.WorkloadID, "stopped for a restore"); err != nil {
			return 0, fmt.Errorf("stop workload %s: %w", t.source.WorkloadID, err)
		}
	}
	// releaseOnce restarts the workload exactly once, whatever path returns.
	releaseOnce := sync.OnceFunc(func() {
		if release != nil {
			release()
		}
	})
	defer releaseOnce()

	aside := dataPath + ".pre-restore"
	if err := os.RemoveAll(aside); err != nil {
		return 0, err
	}
	if err := os.Rename(dataPath, aside); err != nil {
		return 0, fmt.Errorf("move data aside: %w", err)
	}
	rollback := func(cause error) (int64, error) {
		if err := os.RemoveAll(dataPath); err != nil {
			return 0, fmt.Errorf("%w; rollback failed, previous data kept at %s: %v", cause, filepath.Base(aside), err)
		}
		if err := os.Rename(aside, dataPath); err != nil {
			return 0, fmt.Errorf("%w; rollback failed, previous data kept at %s: %v", cause, filepath.Base(aside), err)
		}
		r.system(t.id, "rolled back to the previous data")
		return 0, cause
	}
	if err := os.Mkdir(dataPath, 0o700); err != nil {
		return rollback(err)
	}
	r.system(t.id, "extracting snapshot")
	n, err := extractTar(rr, dataPath)
	if err == nil {
		if _, err = rr.Next(); errors.Is(err, io.EOF) {
			err = nil
		} else if err == nil {
			err = errors.New("snapshot backup holds more than one entry")
		}
	}
	if err != nil {
		return rollback(fmt.Errorf("extract: %w", err))
	}
	if t.source.WorkloadID == "" {
		return n, os.RemoveAll(aside)
	}
	releaseOnce()
	hctx, cancel := context.WithTimeout(ctx, r.opts.HealthTimeout)
	err = r.opts.Workloads.WaitHealthy(hctx, t.source.WorkloadID)
	cancel()
	if err == nil {
		return n, os.RemoveAll(aside)
	}
	r.system(t.id, "workload did not become healthy on the restored data: %v", err)
	// Roll back with the workload stopped again, on a context that outlives
	// the task's timeout: the old data must go back.
	rctx, rcancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Minute)
	defer rcancel()
	again, herr := r.opts.Workloads.Hold(rctx, t.source.WorkloadID, "stopped to roll back a restore")
	if herr != nil {
		return 0, fmt.Errorf("workload unhealthy after restore (%v), and stopping it to roll back failed: %v; previous data kept at %s",
			err, herr, filepath.Base(aside))
	}
	defer again()
	return rollback(fmt.Errorf("workload unhealthy after restore: %w", err))
}

// restoreDump applies each dump entry to the running database.
func (r *Runner) restoreDump(ctx context.Context, t restoreTask, dataPath string, rr *rhbk.Reader) (int64, error) {
	if t.source.Engine == protocol.EngineRedis {
		return r.restoreRedis(ctx, t, dataPath, rr)
	}
	target, err := r.target(ctx, t.source.WorkloadID, t.id)
	if err != nil {
		return 0, err
	}
	var total int64
	for {
		h, err := rr.Next()
		if errors.Is(err, io.EOF) {
			return total, nil
		}
		if err != nil {
			return total, fmt.Errorf("read backup: %w", err)
		}
		r.system(t.id, "restoring %s", h.Name)
		c := &countReader{r: rr}
		if err := target.restoreEntry(ctx, t.source.Engine, h, c); err != nil {
			return total, fmt.Errorf("restore %s: %w", h.Name, err)
		}
		total += c.n
	}
}

type countReader struct {
	r io.Reader
	n int64
}

func (c *countReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}
