// Package walship ships the WAL Postgres archives into a volume's spool to
// object storage, for point-in-time recovery (ADR 0004).
//
// Responsibilities:
//   - for every volume desired_state lists with wal_archive, keep its spool
//     directory (protocol.WALSpoolDir under the volume's data) present and
//     owned by the database's user, so archive_command can write into it;
//   - report the spool to the control plane with wal_archive: files waiting
//     for an upload URL (pending) and files uploaded but not yet recorded
//     (archived), whenever that changes and every [DefaultResend] until it
//     is acknowledged;
//   - upload each file a wal_archive_ack hands a URL for, compressed with
//     zstd and encrypted to the project's age recipient, then replace it
//     with a small "<name>.done" record of what was stored;
//   - delete the records the control plane acknowledges, which is the only
//     time a shipped file leaves the volume.
//
// SECURITY: the spool lives on a volume a database container writes, so
// everything in it is untrusted. Files are opened through an [os.Root] on
// the spool, so a symlink can't reach outside it; only regular files with
// WAL file names are read; and the spool must be a real directory.
package walship

import (
	"bytes"
	"cmp"
	"context"
	"crypto/ecdh"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"filippo.io/age"
	"github.com/klauspost/compress/zstd"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// DefaultInterval is how often every spool is scanned.
const DefaultInterval = 5 * time.Second

// DefaultResend is how long an unanswered report waits before it is sent
// again unchanged.
const DefaultResend = 30 * time.Second

// doneSuffix marks the record of a file that was uploaded and awaits its ack.
const doneSuffix = ".done"

// staleTempAge is how old a file archive_command left half-copied (a crash
// between cp and mv) must be before it is removed.
const staleTempAge = time.Hour

// Volumes is the volume manager's side: a volume's data directory, pinned
// against deletion while it is read.
type Volumes interface {
	Use(volumeID string) (dataPath string, release func(), err error)
}

// Options configures a [Shipper].
type Options struct {
	NodeID string
	// Key opens the sealed upload URLs.
	Key     *ecdh.PrivateKey
	Volumes Volumes
	// Send delivers wal_archive frames.
	Send func(ctx context.Context, m protocol.AgentMessage) error
	// Enabled reports whether the control plane speaks
	// [protocol.PITRProtocolVersion]; nil means it does.
	Enabled func() bool
	// HTTPClient makes the uploads; nil uses one that never follows
	// redirects.
	HTTPClient *http.Client
	// Interval overrides [DefaultInterval]; Resend [DefaultResend].
	Interval, Resend time.Duration
	Logger           *slog.Logger
}

// stream is one volume's archiving.
type stream struct {
	volumeID, streamID, recipient string
	// sent is the last report's content and when it went out.
	sent     string
	sentAt   time.Time
	busy     bool
	warnedAt time.Time
}

// record is what a "<name>.done" file holds.
type record struct {
	SizeRaw    int64  `json:"size_raw"`
	SizeStored int64  `json:"size_stored"`
	SHA256     string `json:"sha256"`
	ArchivedAt int64  `json:"archived_at"`
}

// Shipper ships every listed volume's spool. Create it with [New] and run
// it with [Shipper.Run].
type Shipper struct {
	opts Options
	log  *slog.Logger
	http *http.Client
	kick chan struct{}

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu      sync.Mutex
	gen     int64
	streams map[string]*stream
}

// New returns a shipper.
func New(opts Options) *Shipper {
	hc := opts.HTTPClient
	if hc == nil {
		hc = &http.Client{
			// SECURITY: a presigned URL is a bearer credential for one object;
			// a redirect would carry the body somewhere else.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
			Timeout:       5 * time.Minute,
		}
	}
	opts.Interval = cmp.Or(opts.Interval, DefaultInterval)
	opts.Resend = cmp.Or(opts.Resend, DefaultResend)
	ctx, cancel := context.WithCancel(context.Background())
	return &Shipper{
		opts: opts, log: cmp.Or(opts.Logger, slog.New(slog.DiscardHandler)), http: hc,
		kick: make(chan struct{}, 1), ctx: ctx, cancel: cancel, streams: map[string]*stream{},
	}
}

// Apply takes a desired state's volumes: those with wal_archive are
// shipped, the rest no longer are. A generation it has seen is ignored.
func (s *Shipper) Apply(generation int64, specs []protocol.VolumeSpec) {
	s.mu.Lock()
	if generation <= s.gen && s.gen != 0 {
		s.mu.Unlock()
		return
	}
	s.gen = generation
	next := map[string]*stream{}
	for _, v := range specs {
		if v.WALArchive == nil {
			continue
		}
		st := s.streams[v.ID]
		if st == nil || st.streamID != v.WALArchive.StreamID || st.recipient != v.WALArchive.AgeRecipient {
			st = &stream{volumeID: v.ID, streamID: v.WALArchive.StreamID, recipient: v.WALArchive.AgeRecipient}
		}
		next[v.ID] = st
	}
	s.streams = next
	s.mu.Unlock()
	s.poke()
}

// Connected makes every stream report again at once, as after a reconnect
// any earlier report may have been lost.
func (s *Shipper) Connected() {
	s.mu.Lock()
	for _, st := range s.streams {
		st.sent = ""
	}
	s.mu.Unlock()
	s.poke()
}

func (s *Shipper) poke() {
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

// Run scans the spools until ctx ends, then waits for uploads in flight.
func (s *Shipper) Run(ctx context.Context) error {
	t := time.NewTicker(s.opts.Interval)
	defer t.Stop()
	defer func() {
		s.cancel()
		s.wg.Wait()
	}()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		case <-s.kick:
		}
		if s.opts.Enabled != nil && !s.opts.Enabled() {
			continue
		}
		s.mu.Lock()
		var idle []*stream
		for _, st := range s.streams {
			if !st.busy {
				idle = append(idle, st)
			}
		}
		s.mu.Unlock()
		for _, st := range idle {
			s.scan(ctx, st)
		}
	}
}

// spool opens a volume's spool directory, creating it (owned like the
// database's data directory) when it doesn't exist.
func (s *Shipper) spool(st *stream) (*os.Root, func(), error) {
	dataPath, release, err := s.opts.Volumes.Use(st.volumeID)
	if err != nil {
		return nil, nil, err
	}
	data, err := os.OpenRoot(dataPath)
	if err != nil {
		release()
		return nil, nil, err
	}
	fail := func(err error) (*os.Root, func(), error) {
		data.Close()
		release()
		return nil, nil, err
	}
	info, err := data.Lstat(protocol.WALSpoolDir)
	if errors.Is(err, fs.ErrNotExist) {
		uid, gid, ok := databaseOwner(dataPath)
		if !ok {
			return fail(errors.New("the database has not created its data directory yet"))
		}
		if err := data.Mkdir(protocol.WALSpoolDir, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
			return fail(err)
		}
		if err := lchown(filepath.Join(dataPath, protocol.WALSpoolDir), uid, gid); err != nil {
			return fail(err)
		}
		info, err = data.Lstat(protocol.WALSpoolDir)
	}
	if err != nil {
		return fail(err)
	}
	if !info.IsDir() {
		return fail(fmt.Errorf("%s is not a directory", protocol.WALSpoolDir))
	}
	root, err := data.OpenRoot(protocol.WALSpoolDir)
	if err != nil {
		return fail(err)
	}
	return root, func() {
		root.Close()
		data.Close()
		release()
	}, nil
}

// spooled is one file waiting in the spool.
type spooled struct {
	name  string
	mtime time.Time
}

// listing is what a spool holds.
type listing struct {
	pending  []spooled
	archived []protocol.ArchivedWALFile
}

func (s *Shipper) list(root *os.Root) (listing, error) {
	dir, err := root.Open(".")
	if err != nil {
		return listing{}, err
	}
	entries, err := dir.ReadDir(-1)
	dir.Close()
	if err != nil {
		return listing{}, err
	}
	var l listing
	done := map[string]bool{}
	for _, e := range entries {
		name := e.Name()
		if wal, ok := strings.CutSuffix(name, doneSuffix); ok && protocol.ValidWALFileName(wal) && e.Type().IsRegular() {
			rec, err := readRecord(root, name)
			if err != nil {
				s.log.Warn("unreadable WAL upload record", "file", name, "err", err)
				continue
			}
			done[wal] = true
			l.archived = append(l.archived, protocol.ArchivedWALFile{
				Name: wal, SizeRaw: rec.SizeRaw, SizeStored: rec.SizeStored, SHA256: rec.SHA256, ArchivedAt: rec.ArchivedAt,
			})
		}
	}
	for _, e := range entries {
		name := e.Name()
		info, err := e.Info()
		if err != nil {
			continue
		}
		if strings.HasPrefix(name, ".") && strings.HasSuffix(name, ".tmp") && e.Type().IsRegular() &&
			time.Since(info.ModTime()) > staleTempAge {
			_ = root.Remove(name)
			continue
		}
		if !protocol.ValidWALFileName(name) || !e.Type().IsRegular() || done[name] {
			continue
		}
		l.pending = append(l.pending, spooled{name: name, mtime: info.ModTime()})
	}
	slices.SortFunc(l.archived, func(a, b protocol.ArchivedWALFile) int { return strings.Compare(a.Name, b.Name) })
	slices.SortFunc(l.pending, func(a, b spooled) int {
		return cmp.Or(a.mtime.Compare(b.mtime), strings.Compare(a.name, b.name))
	})
	return l, nil
}

func readRecord(root *os.Root, name string) (record, error) {
	f, err := root.Open(name)
	if err != nil {
		return record{}, err
	}
	defer f.Close()
	var rec record
	if err := json.NewDecoder(io.LimitReader(f, 4096)).Decode(&rec); err != nil {
		return record{}, err
	}
	if rec.SizeRaw < 1 || rec.SizeStored < 1 || rec.ArchivedAt < 1 || len(rec.SHA256) != 64 {
		return record{}, errors.New("incomplete record")
	}
	return rec, nil
}

// scan reports a stream's spool when it changed or the last report went
// unanswered for too long.
func (s *Shipper) scan(ctx context.Context, st *stream) {
	root, done, err := s.spool(st)
	if err != nil {
		s.warn(st, "cannot open the WAL spool", err)
		return
	}
	l, err := s.list(root)
	done()
	if err != nil {
		s.warn(st, "cannot read the WAL spool", err)
		return
	}
	if len(l.pending) == 0 && len(l.archived) == 0 {
		return
	}
	m := &protocol.WALArchive{
		Type: protocol.TypeWALArchive, VolumeID: st.volumeID, StreamID: st.streamID,
		Archived: append([]protocol.ArchivedWALFile{}, l.archived[:min(len(l.archived), protocol.MaxWALArchivedPerFrame)]...),
		Pending:  []string{},
	}
	for _, p := range l.pending[:min(len(l.pending), protocol.MaxWALUploadsPerFrame)] {
		m.Pending = append(m.Pending, p.name)
	}
	key := st.streamID + "|" + strings.Join(m.Pending, ",") + "|" + fmt.Sprint(len(m.Archived))
	for _, a := range m.Archived {
		key += "," + a.Name
	}
	s.mu.Lock()
	fresh := key != st.sent || time.Since(st.sentAt) >= s.opts.Resend
	if fresh {
		st.sent, st.sentAt = key, time.Now()
	}
	s.mu.Unlock()
	if !fresh {
		return
	}
	sctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := s.opts.Send(sctx, m); err != nil {
		s.mu.Lock()
		st.sent = ""
		s.mu.Unlock()
		s.log.Debug("send wal_archive", "volume_id", st.volumeID, "err", err)
	}
}

func (s *Shipper) warn(st *stream, msg string, err error) {
	s.mu.Lock()
	quiet := time.Since(st.warnedAt) < 10*time.Minute
	if !quiet {
		st.warnedAt = time.Now()
	}
	s.mu.Unlock()
	if !quiet {
		s.log.Warn(msg, "volume_id", st.volumeID, "err", err)
	}
}

// Ack applies a wal_archive_ack: it forgets the acknowledged files and
// uploads the ones it got URLs for, in the background.
func (s *Shipper) Ack(m *protocol.WALArchiveAck) {
	s.mu.Lock()
	st := s.streams[m.VolumeID]
	if st == nil || st.streamID != m.StreamID || st.busy {
		s.mu.Unlock()
		s.log.Debug("dropping wal_archive_ack", "volume_id", m.VolumeID, "stream_id", m.StreamID)
		return
	}
	st.busy = true
	s.mu.Unlock()
	uploads, openErr := protocol.OpenWALUploads(s.opts.Key, s.opts.NodeID, m)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer func() {
			s.mu.Lock()
			st.busy, st.sent = false, ""
			s.mu.Unlock()
			s.poke()
		}()
		if openErr != nil {
			s.log.Error("cannot open WAL upload URLs", "volume_id", m.VolumeID, "err", openErr)
		}
		s.apply(st, m.Acked, uploads)
	}()
}

func (s *Shipper) apply(st *stream, acked []string, uploads []protocol.WALUpload) {
	root, done, err := s.spool(st)
	if err != nil {
		s.warn(st, "cannot open the WAL spool", err)
		return
	}
	defer done()
	for _, name := range acked {
		if !protocol.ValidWALFileName(name) {
			continue
		}
		// The record is removed last: if the spool copy is still there it
		// would otherwise be shipped again.
		if err := root.Remove(name); err != nil && !errors.Is(err, fs.ErrNotExist) {
			s.log.Warn("cannot remove a shipped WAL file", "file", name, "err", err)
			continue
		}
		if err := root.Remove(name + doneSuffix); err != nil && !errors.Is(err, fs.ErrNotExist) {
			s.log.Warn("cannot remove a WAL upload record", "file", name, "err", err)
		}
	}
	recipient, err := age.ParseX25519Recipient(st.recipient)
	if err != nil {
		s.log.Error("invalid age recipient for WAL", "volume_id", st.volumeID)
		return
	}
	for _, u := range uploads {
		if s.ctx.Err() != nil {
			return
		}
		if err := s.upload(root, u, recipient); err != nil {
			s.log.Warn("WAL upload failed", "volume_id", st.volumeID, "file", u.Name, "err", err)
		}
	}
}

// upload ships one spooled file and replaces it with its record.
func (s *Shipper) upload(root *os.Root, u protocol.WALUpload, recipient age.Recipient) error {
	if !protocol.ValidWALFileName(u.Name) {
		return errors.New("invalid name")
	}
	f, err := root.Open(u.Name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > protocol.MaxWALFileBytes {
		return errors.New("not a WAL file")
	}
	var buf bytes.Buffer
	enc, err := age.Encrypt(&buf, recipient)
	if err != nil {
		return err
	}
	zw, err := zstd.NewWriter(enc, zstd.WithEncoderLevel(zstd.SpeedDefault), zstd.WithEncoderConcurrency(1))
	if err != nil {
		return err
	}
	n, err := io.Copy(zw, io.LimitReader(f, protocol.MaxWALFileBytes+1))
	if err == nil {
		err = zw.Close()
	} else {
		zw.Close()
	}
	if err == nil {
		err = enc.Close()
	}
	if err != nil {
		return err
	}
	if n != info.Size() {
		return errors.New("the file changed while it was read")
	}
	sum := sha256.Sum256(buf.Bytes())
	stored := int64(buf.Len())
	req, err := http.NewRequestWithContext(s.ctx, http.MethodPut, u.URL, bytes.NewReader(buf.Bytes()))
	if err != nil {
		return errors.New("invalid URL")
	}
	req.ContentLength = stored
	resp, err := s.http.Do(req)
	if err != nil {
		return errors.New("upload: " + redact(err))
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("upload: HTTP %d", resp.StatusCode)
	}
	rec, _ := json.Marshal(record{
		SizeRaw: n, SizeStored: stored, SHA256: hex.EncodeToString(sum[:]), ArchivedAt: info.ModTime().UnixMilli(),
	})
	tmp := "." + u.Name + doneSuffix + ".tmp"
	if err := root.WriteFile(tmp, rec, 0o600); err != nil {
		return err
	}
	if err := root.Rename(tmp, u.Name+doneSuffix); err != nil {
		_ = root.Remove(tmp)
		return err
	}
	if err := root.Remove(u.Name); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// redact keeps a transport error but drops the URL it quotes, which is a
// bearer credential.
func redact(err error) string {
	var ue interface{ Unwrap() error }
	if errors.As(err, &ue) {
		if inner := ue.Unwrap(); inner != nil {
			return inner.Error()
		}
	}
	return "request failed"
}

// databaseOwner finds Postgres's data directory under a volume's data
// (PG_VERSION at most three levels down) and returns who owns it.
func databaseOwner(dataPath string) (uid, gid int, ok bool) {
	for _, pattern := range []string{"PG_VERSION", "*/PG_VERSION", "*/*/PG_VERSION"} {
		matches, _ := filepath.Glob(filepath.Join(dataPath, pattern))
		for _, m := range matches {
			if info, err := os.Lstat(m); err == nil && info.Mode().IsRegular() {
				if uid, gid, ok := ownerOf(info); ok {
					return uid, gid, true
				}
			}
		}
	}
	return 0, 0, false
}

// Streams returns the shipped volumes' IDs, for tests and diagnostics.
func (s *Shipper) Streams() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Sorted(maps.Keys(s.streams))
}
