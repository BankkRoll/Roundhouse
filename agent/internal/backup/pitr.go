package backup

// Point-in-time recovery for Postgres (ADR 0004): base backups, and base
// restores that replay archived WAL up to a target time.
//
// A base backup is pg_basebackup's tar of the data directory, with the WAL
// it needs (-X fetch), as one RHBK entry. Its backup_label, the tar's first
// member, names the WAL segment replay starts from, which the result
// reports so the control plane knows what to fetch for a later restore.
//
// A base restore never replays inside the workload: the agent stops it,
// moves the volume's data aside, extracts the base backup into the data
// directory's place, downloads the WAL files into a directory next to it,
// and runs a one-off server of the workload's image on the volume, with no
// network and no archiving, until it has recovered and promoted. It then
// puts the target's own passwords back, shuts that server down cleanly and
// starts the workload. Anything that fails before the workload is healthy
// puts the old data back.

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"filippo.io/age"
	"github.com/klauspost/compress/zstd"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/rhbk"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// restoreWALDir is where a base restore puts the WAL it replays, next to
// the data directory on the volume, so restore_command is a plain copy.
const restoreWALDir = "roundhouse-restore-wal"

// labelPrefixBytes is how much of a base backup's tar is kept to find its
// backup_label, which the server writes first.
const labelPrefixBytes = 64 << 10

// walFetchTimeout bounds one wal_fetch_request's answer.
const walFetchTimeout = time.Minute

// walFetchAttempts is how often an unanswered wal_fetch_request is sent.
const walFetchAttempts = 3

// recoveryPoll is how often a recovering server is asked whether it is done.
const recoveryPoll = time.Second

var startWALRE = regexp.MustCompile(`(?m)^START WAL LOCATION: [0-9A-F]+/[0-9A-F]+ \(file ([0-9A-F]{24})\)$`)

// -----------------------------------------------------------------------------
// Base backups
// -----------------------------------------------------------------------------

// prefixWriter keeps the first max bytes written through it.
type prefixWriter struct {
	buf []byte
	max int
}

func (p *prefixWriter) Write(b []byte) (int, error) {
	if room := p.max - len(p.buf); room > 0 {
		p.buf = append(p.buf, b[:min(room, len(b))]...)
	}
	return len(b), nil
}

// walStartOf finds backup_label in the start of a base backup's tar and
// returns the segment its START WAL LOCATION names.
func walStartOf(prefix []byte) (string, error) {
	tr := tar.NewReader(bytes.NewReader(prefix))
	for {
		hdr, err := tr.Next()
		if err != nil {
			return "", errors.New("backup_label is not at the start of the base backup")
		}
		if path.Clean(hdr.Name) != "backup_label" {
			continue
		}
		label, err := io.ReadAll(io.LimitReader(tr, 16<<10))
		if err != nil {
			return "", fmt.Errorf("read backup_label: %w", err)
		}
		m := startWALRE.FindSubmatch(label)
		if m == nil {
			return "", errors.New("backup_label has no START WAL LOCATION")
		}
		return string(m[1]), nil
	}
}

// baseBackup writes pg_basebackup's tar as one entry and returns the WAL
// segment its replay starts from.
func (t *engineTarget) baseBackup(ctx context.Context, backupID string, w *rhbk.Writer) (string, error) {
	e, err := w.Create(rhbk.Header{Name: "base.tar", Engine: string(protocol.EnginePostgres), Format: rhbk.FormatPGBaseTar})
	if err != nil {
		return "", err
	}
	prefix := &prefixWriter{max: labelPrefixBytes}
	// NOTE: -X fetch puts the WAL the backup needs into the tar, so it
	// restores on its own; -X stream can't write to stdout. The label
	// carries only the backup ID, which reaches the script as $1.
	if err := t.run(ctx, pgPrefix+`exec pg_basebackup -U "$U" --no-password -D - -F tar -X fetch -c fast -l "$1"`,
		[]string{"roundhouse " + backupID}, nil, io.MultiWriter(ctxWriter{ctx, e}, prefix)); err != nil {
		return "", fmt.Errorf("pg_basebackup: %w", err)
	}
	if err := e.Close(); err != nil {
		return "", err
	}
	return walStartOf(prefix.buf)
}

// -----------------------------------------------------------------------------
// WAL for a restore
// -----------------------------------------------------------------------------

// walBook collects the wal_fetch answers of one running restore.
type walBook struct {
	files chan []protocol.WALFetchFile
}

// AddWALFiles hands a wal_fetch frame's files to its running restore.
func (r *Runner) AddWALFiles(m *protocol.WALFetch) {
	r.mu.Lock()
	book := r.walBooks[m.RestoreID]
	r.mu.Unlock()
	if book == nil {
		r.log.Warn("dropping WAL URLs for a restore that is not running", "restore_id", m.RestoreID)
		return
	}
	files, err := protocol.OpenWALFiles(r.opts.Key, r.opts.NodeID, m)
	if err != nil {
		r.log.Error("cannot open WAL URLs", "restore_id", m.RestoreID, "err", err)
		return
	}
	select {
	case book.files <- files:
	default:
		r.log.Warn("dropping WAL URLs nobody waits for", "restore_id", m.RestoreID)
	}
}

// fetchWAL downloads a restore's WAL files into dir, owned by uid:gid,
// asking for their URLs a batch at a time.
func (r *Runner) fetchWAL(ctx context.Context, t restoreTask, identity age.Identity, dir string, uid, gid int) (int64, error) {
	book := &walBook{files: make(chan []protocol.WALFetchFile, 1)}
	r.mu.Lock()
	r.walBooks[t.id] = book
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		delete(r.walBooks, t.id)
		r.mu.Unlock()
	}()
	var total int64
	for from := 0; from < t.pitr.WALFiles; {
		files, err := r.requestWAL(ctx, t.id, book, from, min(protocol.MaxWALFetchPerFrame, t.pitr.WALFiles-from))
		if err != nil {
			return total, err
		}
		for _, f := range files {
			n, err := r.downloadWALFile(ctx, f, identity, dir, uid, gid)
			if err != nil {
				return total, fmt.Errorf("WAL file %s: %w", f.Name, err)
			}
			total += n
		}
		from += len(files)
		r.system(t.id, "fetched %d of %d WAL files", from, t.pitr.WALFiles)
	}
	return total, nil
}

// requestWAL asks for the files from index from on and waits for them.
func (r *Runner) requestWAL(ctx context.Context, restoreID string, book *walBook, from, count int) ([]protocol.WALFetchFile, error) {
	for attempt := 0; attempt < walFetchAttempts; attempt++ {
		req := &protocol.WALFetchRequest{Type: protocol.TypeWALFetchRequest, RestoreID: restoreID, From: from, Count: count}
		if err := r.deliver(ctx, req); err != nil {
			return nil, fmt.Errorf("ask for WAL files: %w", err)
		}
		timer := time.NewTimer(walFetchTimeout)
		select {
		case files := <-book.files:
			timer.Stop()
			if len(files) == 0 || files[0].Index != from || len(files) > count {
				return nil, fmt.Errorf("the control plane answered with WAL files from %d, not %d", files[0].Index, from)
			}
			return files, nil
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		}
	}
	return nil, errors.New("the control plane did not send the WAL files' URLs")
}

// downloadWALFile fetches one stored WAL file, checks its size and digest
// before decrypting it, and writes the plain file into dir.
//
// SECURITY: the name comes from a sealed, validated box and is a bare WAL
// file name, never a path; the file is created exclusively.
func (r *Runner) downloadWALFile(ctx context.Context, f protocol.WALFetchFile, identity age.Identity, dir string, uid, gid int) (int64, error) {
	if !protocol.ValidWALFileName(f.Name) {
		return 0, errors.New("invalid name")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.URL, nil)
	if err != nil {
		return 0, errors.New("invalid URL")
	}
	resp, err := r.http.Do(req)
	if err != nil {
		return 0, errors.New("download: " + redactURLError(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("download: HTTP %d", resp.StatusCode)
	}
	stored, err := io.ReadAll(io.LimitReader(resp.Body, f.Size+1))
	if err != nil {
		return 0, fmt.Errorf("download: %w", err)
	}
	sum := sha256.Sum256(stored)
	if int64(len(stored)) != f.Size || hex.EncodeToString(sum[:]) != f.SHA256 {
		return 0, errors.New("the stored file does not match its record")
	}
	dec, err := age.Decrypt(bytes.NewReader(stored), identity)
	if err != nil {
		return 0, fmt.Errorf("decrypt: %w", err)
	}
	zr, err := zstd.NewReader(dec)
	if err != nil {
		return 0, err
	}
	defer zr.Close()
	target := filepath.Join(dir, f.Name)
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(out, io.LimitReader(zr, protocol.MaxWALFileBytes+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil && n > protocol.MaxWALFileBytes {
		err = errors.New("larger than any WAL file")
	}
	if err == nil {
		err = lchown(target, uid, gid)
	}
	if err != nil {
		os.Remove(target)
		return 0, err
	}
	return n, nil
}

// -----------------------------------------------------------------------------
// Base restores
// -----------------------------------------------------------------------------

// pgLayout is where a Postgres workload keeps its data on the volume.
type pgLayout struct {
	// mountPath is the volume's path in the container.
	mountPath string
	// rel is PGDATA relative to the mount path, e.g. "18/docker".
	rel string
	// uid and gid own the data directory.
	uid, gid int
}

// layoutOf reads a workload container's PGDATA and volume mount.
func layoutOf(info docker.ContainerInfo, dataPath string) (pgLayout, error) {
	l := pgLayout{}
	for _, m := range info.Mounts {
		if filepath.Clean(m.Source) == filepath.Clean(dataPath) {
			l.mountPath = m.Destination
		}
	}
	if l.mountPath == "" {
		return l, errors.New("the database container does not mount the volume")
	}
	pgdata := envMap(info.Config.Env)["PGDATA"]
	if pgdata == "" {
		pgdata = "/var/lib/postgresql/data"
	}
	rel, ok := strings.CutPrefix(path.Clean(pgdata), path.Clean(l.mountPath)+"/")
	if !ok || rel == "" || path.Clean(rel) != rel || strings.HasPrefix(rel, "..") {
		return l, fmt.Errorf("PGDATA %s is not inside the volume at %s", pgdata, l.mountPath)
	}
	l.rel = rel
	return l, nil
}

// restoreBase replaces the volume's Postgres data with a base backup
// recovered to the job's target; see the file comment.
func (r *Runner) restoreBase(ctx context.Context, t restoreTask, identity age.Identity, dataPath string, rr *rhbk.Reader) (int64, error) {
	h, err := rr.Next()
	if err != nil {
		return 0, fmt.Errorf("read backup: %w", err)
	}
	if h.Format != rhbk.FormatPGBaseTar || h.Engine != string(protocol.EnginePostgres) {
		return 0, fmt.Errorf("backup entry %s is not a Postgres base backup", h.Name)
	}
	id, _, ok := r.opts.Workloads.Container(t.source.WorkloadID)
	if !ok {
		return 0, fmt.Errorf("workload %s has no container on this node", t.source.WorkloadID)
	}
	info, err := r.opts.Docker.InspectContainer(ctx, id)
	if err != nil {
		return 0, fmt.Errorf("inspect workload %s: %w", t.source.WorkloadID, err)
	}
	layout, err := layoutOf(info, dataPath)
	if err != nil {
		return 0, err
	}

	release, err := r.opts.Workloads.Hold(ctx, t.source.WorkloadID, "stopped for a point-in-time restore")
	if err != nil {
		return 0, fmt.Errorf("stop workload %s: %w", t.source.WorkloadID, err)
	}
	releaseOnce := sync.OnceFunc(release)
	defer releaseOnce()

	aside := dataPath + ".pre-restore"
	if err := os.RemoveAll(aside); err != nil {
		return 0, err
	}
	rootInfo, err := os.Lstat(dataPath)
	if err != nil {
		return 0, err
	}
	pgInfo, err := os.Lstat(filepath.Join(dataPath, filepath.FromSlash(layout.rel)))
	if err != nil || !pgInfo.IsDir() {
		return 0, errors.New("the database has no data directory on the volume yet; deploy it before restoring")
	}
	var owned bool
	if layout.uid, layout.gid, owned = ownerOf(pgInfo); !owned {
		layout.uid, layout.gid = 0, 0
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
	pgdata, err := r.prepareDataDir(aside, dataPath, rootInfo, layout)
	if err != nil {
		return rollback(err)
	}
	r.system(t.id, "extracting the base backup")
	n, err := extractTar(rr, pgdata)
	if err == nil {
		if _, err = rr.Next(); errors.Is(err, io.EOF) {
			err = nil
		} else if err == nil {
			err = errors.New("a base backup holds exactly one entry")
		}
	}
	if err != nil {
		return rollback(fmt.Errorf("extract: %w", err))
	}
	walDir := filepath.Join(dataPath, restoreWALDir)
	if err := mkdirOwned(walDir, 0o700, layout.uid, layout.gid); err != nil {
		return rollback(err)
	}
	if t.pitr.WALFiles > 0 {
		wn, err := r.fetchWAL(ctx, t, identity, walDir, layout.uid, layout.gid)
		if err != nil {
			return rollback(err)
		}
		n += wn
	}
	if err := r.recover(ctx, t, info, dataPath, pgdata, layout); err != nil {
		return rollback(err)
	}
	if err := os.RemoveAll(walDir); err != nil {
		return rollback(err)
	}

	releaseOnce()
	hctx, cancel := context.WithTimeout(ctx, r.opts.HealthTimeout)
	err = r.opts.Workloads.WaitHealthy(hctx, t.source.WorkloadID)
	cancel()
	if err == nil {
		return n, os.RemoveAll(aside)
	}
	r.system(t.id, "workload did not become healthy on the restored data: %v", err)
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

// prepareDataDir recreates the volume's data directory with the owners and
// modes the old one had down to PGDATA, which it returns, empty.
func (r *Runner) prepareDataDir(aside, dataPath string, rootInfo fs.FileInfo, l pgLayout) (string, error) {
	uid, gid, _ := ownerOf(rootInfo)
	if err := mkdirOwned(dataPath, rootInfo.Mode().Perm(), uid, gid); err != nil {
		return "", err
	}
	parts := strings.Split(l.rel, "/")
	cur, old := dataPath, aside
	for i, p := range parts {
		cur, old = filepath.Join(cur, p), filepath.Join(old, p)
		if i == len(parts)-1 {
			// Postgres refuses a data directory others can read.
			return cur, mkdirOwned(cur, 0o700, l.uid, l.gid)
		}
		perm, du, dg := fs.FileMode(0o755), 0, 0
		if fi, err := os.Lstat(old); err == nil && fi.IsDir() {
			perm = fi.Mode().Perm()
			du, dg, _ = ownerOf(fi)
		}
		if err := mkdirOwned(cur, perm, du, dg); err != nil {
			return "", err
		}
	}
	return "", errors.New("empty PGDATA path")
}

func mkdirOwned(dir string, perm fs.FileMode, uid, gid int) error {
	if err := os.Mkdir(dir, perm); err != nil {
		return err
	}
	if err := lchown(dir, uid, gid); err != nil {
		return err
	}
	return os.Chmod(dir, perm)
}

// recover runs the one-off server until it has recovered and promoted, puts
// the target's passwords back, and shuts it down. A server that stops before
// promoting with a target time set gets one more run without the target: a
// target with no commit after it is never "reached", yet the WAL fetched
// then holds exactly the state at that time, so replaying all of it is the
// restore; that run must replay through wal_end, or the restore fails
// rather than stop early at a gap.
func (r *Runner) recover(ctx context.Context, t restoreTask, workload docker.ContainerInfo, dataPath, pgdata string, l pgLayout) error {
	if err := writeOwned(filepath.Join(pgdata, "recovery.signal"), nil, l.uid, l.gid); err != nil {
		return err
	}
	promoted, err := r.recoveryRun(ctx, t, workload, dataPath, l, true)
	if err != nil {
		return err
	}
	if !promoted && t.pitr.TargetTime != nil {
		r.system(t.id, "no commit after the target time; replaying every fetched WAL file instead")
		if promoted, err = r.recoveryRun(ctx, t, workload, dataPath, l, false); err != nil {
			return err
		}
		if promoted {
			if err := checkReplayedThrough(pgdata, *t.pitr.WALEnd); err != nil {
				return err
			}
		}
	}
	if !promoted {
		return errors.New("the database stopped before it finished recovering; see the task log")
	}
	return nil
}

// recoveryRun starts the one-off server with or without the target and
// reports whether it promoted. It returns an error only for failures of
// its own (Docker, the password reset).
func (r *Runner) recoveryRun(ctx context.Context, t restoreTask, workload docker.ContainerInfo, dataPath string, l pgLayout, withTarget bool) (bool, error) {
	wal := l.mountPath + "/" + restoreWALDir
	cmd := []string{
		"postgres",
		"-c", `restore_command=cp "` + wal + `/%f" "%p"`,
		"-c", "recovery_target_timeline=current",
		"-c", "recovery_target_action=promote",
		"-c", "archive_mode=off",
		"-c", "listen_addresses=",
	}
	switch {
	case !withTarget:
	case t.pitr.TargetTime != nil:
		target := time.UnixMilli(*t.pitr.TargetTime).UTC().Format("2006-01-02 15:04:05.000000+00")
		cmd = append(cmd, "-c", "recovery_target_time="+target)
	default:
		cmd = append(cmd, "-c", "recovery_target=immediate")
	}
	name := "roundhouse-task-" + t.id
	_ = r.opts.Docker.RemoveContainer(ctx, name)
	grace := 120
	id, err := r.opts.Docker.CreateContainer(ctx, name, docker.ContainerCreate{
		Image:  workload.Image,
		Cmd:    cmd,
		Env:    workload.Config.Env,
		Labels: map[string]string{"roundhouse.task_id": t.id},
		// The image's entrypoint drops to the postgres user.
		StopTimeout: &grace,
		HostConfig: docker.HostConfig{
			NetworkMode:   "none",
			RestartPolicy: docker.RestartPolicy{Name: "no"},
			SecurityOpt:   []string{"no-new-privileges:true"},
			CapDrop:       []string{"ALL"},
			CapAdd:        []string{"CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"},
			Mounts:        []docker.Mount{{Type: docker.MountBind, Source: dataPath, Target: l.mountPath}},
			LogConfig:     docker.LogConfig{Type: "json-file"},
		},
	})
	if err != nil {
		return false, err
	}
	defer func() {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
		_ = r.opts.Docker.RemoveContainer(rctx, id)
		cancel()
	}()
	if err := r.opts.Docker.StartContainer(ctx, id); err != nil {
		return false, err
	}
	target := &engineTarget{d: r.opts.Docker, container: id, env: envMap(workload.Config.Env), log: r.taskLog(t.id)}
	quiet := &engineTarget{d: r.opts.Docker, container: id, env: target.env}
	for {
		ci, err := r.opts.Docker.InspectContainer(ctx, id)
		if err != nil {
			return false, err
		}
		if !ci.State.Running {
			return false, nil
		}
		out, err := quiet.output(ctx, pgPrefix+`exec psql -X -U "$U" -d postgres -Atc 'SELECT pg_is_in_recovery()'`, nil, nil)
		if err == nil && strings.TrimSpace(out) == "f" {
			break
		}
		if !sleepCtx(ctx, recoveryPoll) {
			return false, ctx.Err()
		}
	}
	r.system(t.id, "recovered; restoring this database's own passwords")
	if err := target.reapplyPostgresCredentials(ctx); err != nil {
		return false, fmt.Errorf("re-apply credentials: %w", err)
	}
	// A clean shutdown checkpoints, so the workload starts without replaying.
	if err := r.opts.Docker.StopContainer(ctx, id, time.Duration(grace)*time.Second); err != nil {
		return false, err
	}
	return true, nil
}

func writeOwned(path string, data []byte, uid, gid int) error {
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	return lchown(path, uid, gid)
}

// checkReplayedThrough reads the newest timeline history file Postgres wrote
// when it promoted and checks the switch point lies in walEnd or later.
func checkReplayedThrough(pgdata, walEnd string) error {
	entries, err := os.ReadDir(filepath.Join(pgdata, "pg_wal"))
	if err != nil {
		return err
	}
	newest := ""
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".history") && protocol.ValidWALFileName(e.Name()) && e.Name() > newest {
			newest = e.Name()
		}
	}
	if newest == "" {
		return errors.New("the database promoted without writing a timeline history")
	}
	f, err := os.Open(filepath.Join(pgdata, "pg_wal", newest))
	if err != nil {
		return err
	}
	defer f.Close()
	var last string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if l := strings.TrimSpace(sc.Text()); l != "" && !strings.HasPrefix(l, "#") {
			last = l
		}
	}
	fields := strings.Fields(last)
	if len(fields) < 2 {
		return fmt.Errorf("timeline history %s has no switch point", newest)
	}
	reached, err := segmentOfLSN(fields[1])
	if err != nil {
		return err
	}
	end, err := segmentNumber(walEnd)
	if err != nil {
		return err
	}
	if reached < end {
		return fmt.Errorf("replay stopped before WAL segment %s: the archive has a gap", walEnd)
	}
	return nil
}

// walSegmentBytes is the default wal_segment_size the templates keep.
const walSegmentBytes = 16 << 20

// segmentOfLSN returns the segment number an LSN such as 0/3000148 is in.
func segmentOfLSN(lsn string) (uint64, error) {
	hi, lo, ok := strings.Cut(lsn, "/")
	if !ok {
		return 0, fmt.Errorf("invalid LSN %q", lsn)
	}
	h, err1 := strconv.ParseUint(hi, 16, 32)
	l, err2 := strconv.ParseUint(lo, 16, 32)
	if err1 != nil || err2 != nil {
		return 0, fmt.Errorf("invalid LSN %q", lsn)
	}
	return (h<<32 | l) / walSegmentBytes, nil
}

// segmentNumber returns a segment name's number on its timeline.
func segmentNumber(name string) (uint64, error) {
	if !protocol.ValidWALSegmentName(name) {
		return 0, fmt.Errorf("invalid WAL segment %q", name)
	}
	log, _ := strconv.ParseUint(name[8:16], 16, 32)
	seg, _ := strconv.ParseUint(name[16:24], 16, 32)
	return log*(1<<32/walSegmentBytes) + seg, nil
}
