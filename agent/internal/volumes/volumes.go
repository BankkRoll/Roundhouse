// Package volumes manages the node's persistent volumes (ADR 0004,
// "Volumes").
//
// Responsibilities:
//   - create every volume desired_state.volumes lists as a filesystem (or a
//     plain directory) mounted at <root>/mnt/<id>, whose data subdirectory
//     is what containers bind, and grow it when its size rises;
//   - enforce quotas with the node's mode: loop (a sparse ext4 image per
//     volume) or none;
//   - persist what the node holds in <data-dir>/volumes.json and mount
//     every loop volume at start, before any workload is reconciled;
//   - never delete a volume that drops out of the desired state (it is
//     reported orphaned): only [Manager.Delete], for a signed volume_delete,
//     removes data, and never while a container or a task uses it;
//   - report volume_status every minute and on change.
package volumes

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/BankkRoll/Roundhouse/agent/internal/atomicfile"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// DefaultRoot is the volumes root on a node.
const DefaultRoot = "/var/lib/roundhouse/volumes"

// Quota settings accepted in the agent config's volumes.quota.
const (
	QuotaAuto = "auto"
	QuotaXFS  = "xfs"
	QuotaExt4 = "ext4"
	QuotaLoop = "loop"
	QuotaNone = "none"
)

// DefaultStatusInterval is how often volume_status is sent without a change.
const DefaultStatusInterval = time.Minute

// statusDebounce coalesces bursts of changes into one volume_status.
const statusDebounce = time.Second

// ErrNotReady is wrapped by errors for volumes that can't be mounted yet.
var ErrNotReady = errors.New("volume not ready")

// Options configures a [Manager].
type Options struct {
	// Root is the volumes root; empty means [DefaultRoot].
	Root string
	// Quota is the agent config's volumes.quota: auto, xfs, ext4, loop or
	// none; empty means auto.
	Quota string
	// StatePath is where the manager persists what it holds.
	StatePath string
	Logger    *slog.Logger
	// Send delivers volume_status; nil sends nothing.
	Send func(ctx context.Context, m *protocol.VolumeStatus) error
	// Enabled reports whether the control plane speaks volume_status
	// ([protocol.VolumesProtocolVersion]); nil means it does.
	Enabled func() bool
	// OnChange is called, without the manager's lock, whenever a volume
	// becomes mountable or stops being so; the runtime re-reconciles.
	OnChange func()
	// InUse reports whether any container mounts the volume. Delete refuses
	// a volume in use; nil treats every volume as unused.
	InUse func(volumeID string) bool
	// StatusInterval overrides [DefaultStatusInterval].
	StatusInterval time.Duration

	// backend replaces the mode's backend in tests.
	backend backend
}

// record is one volume as the node holds it. The exported fields are
// persisted.
type record struct {
	ID            string                   `json:"id"`
	ProjectID     string                   `json:"project_id"`
	EnvironmentID string                   `json:"environment_id"`
	ServiceID     string                   `json:"service_id"`
	SizeMB        int                      `json:"size_mb"`
	Owner         *string                  `json:"owner,omitempty"`
	Quota         protocol.VolumeQuotaMode `json:"quota"`
	// Created is set once the filesystem and its data directory exist.
	Created bool `json:"created"`
	// Fresh marks a data directory no workload has used yet: the first
	// mount gives it to the image's user when the volume names no owner.
	Fresh bool `json:"fresh,omitempty"`
	// Deleted is a tombstone kept until volume_status has reported it.
	Deleted bool `json:"deleted,omitempty"`

	listed     bool
	wantSizeMB int
	// conflict is why a listing that disagrees with the volume's owner is
	// refused.
	conflict string
	err      string
	note     string
	busy     bool
	resizing bool
	deleting bool
	// users counts backup and restore tasks reading or writing the volume.
	users     int
	sizeBytes int64
	usedBytes int64
}

// Manager holds the node's volumes. Create it with [New], call
// [Manager.Start] before the runtime starts, then [Manager.Run].
type Manager struct {
	opts  Options
	log   *slog.Logger
	root  string
	mode  protocol.VolumeQuotaMode
	modes map[protocol.VolumeQuotaMode]backend

	work    chan struct{}
	changed chan struct{}

	mu   sync.Mutex
	recs map[string]*record
	// known is set by the first Apply; until then every held volume counts
	// as listed, so a restart does not report them orphaned.
	known bool
	gen   int64
	// sentAny records that the last volume_status listed volumes, so their
	// disappearance is reported once.
	sentAny bool
}

// New resolves the quota mode and loads the persisted volumes. An explicit
// mode the node can't provide is an error.
func New(opts Options) (*Manager, error) {
	m := &Manager{
		opts:    opts,
		log:     cmp.Or(opts.Logger, slog.New(slog.DiscardHandler)),
		root:    cmp.Or(opts.Root, DefaultRoot),
		work:    make(chan struct{}, 1),
		changed: make(chan struct{}, 1),
		recs:    map[string]*record{},
		modes:   map[protocol.VolumeQuotaMode]backend{},
	}
	if !filepath.IsAbs(m.root) {
		return nil, fmt.Errorf("volumes.root must be absolute, got %q", m.root)
	}
	m.modes[protocol.QuotaNone] = noneBackend{}
	if lb, err := newLoopBackend(filepath.Join(m.root, "images")); err == nil {
		m.modes[protocol.QuotaLoop] = lb
	} else if opts.Quota == QuotaLoop {
		return nil, fmt.Errorf("volumes.quota is loop, but %w", err)
	}
	switch opts.Quota {
	case "", QuotaAuto:
		m.mode = protocol.QuotaNone
		if m.modes[protocol.QuotaLoop] != nil {
			m.mode = protocol.QuotaLoop
		}
		// TODO: prefer xfs_project / ext4_project when the root's
		// filesystem has project quotas (ADR 0004); auto falls back to
		// loop or none until they are implemented.
	case QuotaLoop:
		m.mode = protocol.QuotaLoop
	case QuotaNone:
		m.mode = protocol.QuotaNone
	case QuotaXFS, QuotaExt4:
		return nil, fmt.Errorf("volumes.quota %q: project quotas are not implemented yet; use auto, loop or none", opts.Quota)
	default:
		return nil, fmt.Errorf("volumes.quota: invalid %q (auto, xfs, ext4, loop or none)", opts.Quota)
	}
	if opts.backend != nil {
		m.modes[m.mode] = opts.backend
	}
	if err := m.load(); err != nil {
		return nil, err
	}
	return m, nil
}

// Mode is how this node enforces quotas, for hello.volume_quota.
func (m *Manager) Mode() protocol.VolumeQuotaMode { return m.mode }

// Root returns the volumes root.
func (m *Manager) Root() string { return m.root }

// TempDir returns a directory on the volumes' filesystem for task scratch
// files, created on first use.
func (m *Manager) TempDir() (string, error) {
	dir := filepath.Join(m.root, "tmp")
	return dir, os.MkdirAll(dir, 0o700)
}

func (m *Manager) mntDir(id string) string { return filepath.Join(m.root, "mnt", id) }

// DataPath returns the host directory containers bind for a volume.
func (m *Manager) DataPath(id string) string { return filepath.Join(m.mntDir(id), "data") }

func (m *Manager) load() error {
	data, err := os.ReadFile(m.opts.StatePath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var st struct {
		Volumes []*record `json:"volumes"`
	}
	if err := json.Unmarshal(data, &st); err != nil {
		return fmt.Errorf("parse %s: %w", m.opts.StatePath, err)
	}
	for _, r := range st.Volumes {
		if r.ID == "" || strings.ContainsAny(r.ID, `/\.`) {
			return fmt.Errorf("%s: invalid volume id %q", m.opts.StatePath, r.ID)
		}
		r.wantSizeMB = r.SizeMB
		m.recs[r.ID] = r
	}
	return nil
}

// saveLocked persists the records. Caller holds m.mu.
func (m *Manager) saveLocked() {
	recs := slices.SortedFunc(maps.Values(m.recs), func(a, b *record) int { return strings.Compare(a.ID, b.ID) })
	data, err := json.MarshalIndent(struct {
		Volumes []*record `json:"volumes"`
	}{recs}, "", "  ")
	if err == nil {
		err = atomicfile.Write(m.opts.StatePath, append(data, '\n'), 0o600)
	}
	if err != nil {
		m.log.Error("persist volumes", "path", m.opts.StatePath, "err", err)
	}
}

func (m *Manager) backendFor(r *record) (backend, error) {
	b := m.modes[r.Quota]
	if b == nil {
		return nil, fmt.Errorf("volume %s uses quota mode %s, which this node does not provide", r.ID, r.Quota)
	}
	return b, nil
}

// Start mounts every volume the node holds, so workloads find their data
// when the runtime starts them. Failures are recorded on the volume (its
// workloads stay pending) rather than returned.
func (m *Manager) Start(ctx context.Context) {
	if err := os.MkdirAll(filepath.Join(m.root, "mnt"), 0o700); err != nil {
		m.log.Error("create volumes root", "root", m.root, "err", err)
	}
	m.cleanTemp()
	m.mu.Lock()
	var held []*record
	for _, r := range m.recs {
		if r.Created && !r.Deleted {
			held = append(held, r)
		}
	}
	m.mu.Unlock()
	for _, r := range held {
		err := m.mountExisting(ctx, r)
		m.mu.Lock()
		r.err = ""
		if err != nil {
			r.err = err.Error()
			m.log.Error("mount volume", "volume_id", r.ID, "err", err)
		}
		m.mu.Unlock()
	}
	m.notify()
}

// cleanTemp removes task scratch files a previous process left behind.
func (m *Manager) cleanTemp() {
	dir := filepath.Join(m.root, "tmp")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		_ = os.RemoveAll(filepath.Join(dir, e.Name()))
	}
}

func (m *Manager) mountExisting(ctx context.Context, r *record) error {
	b, err := m.backendFor(r)
	if err != nil {
		return err
	}
	if err := b.mount(ctx, r.ID, m.mntDir(r.ID)); err != nil {
		return err
	}
	if _, err := os.Lstat(m.DataPath(r.ID)); err != nil {
		return fmt.Errorf("data directory: %w", err)
	}
	return nil
}

// Apply takes desired_state.volumes for generation. A volume missing from
// specs is kept and reported orphaned; nil and empty mean the same.
func (m *Manager) Apply(generation int64, specs []protocol.VolumeSpec) {
	m.mu.Lock()
	if m.known && generation <= m.gen {
		m.mu.Unlock()
		return
	}
	m.known, m.gen = true, generation
	listed := map[string]bool{}
	dirty := false
	for _, s := range specs {
		listed[s.ID] = true
		r := m.recs[s.ID]
		if r == nil || r.Deleted {
			r = &record{
				ID: s.ID, ProjectID: s.ProjectID, EnvironmentID: s.EnvironmentID, ServiceID: s.ServiceID,
				SizeMB: s.SizeMB, Owner: s.Owner, Quota: m.mode,
			}
			m.recs[s.ID] = r
			dirty = true
		}
		r.listed = true
		r.wantSizeMB = s.SizeMB
		r.conflict = ""
		// SECURITY: a volume belongs to the service it was created for, for
		// good: a listing that names another owner is refused, so a wrong
		// frame can't hand one project's data to another.
		if r.ProjectID != s.ProjectID || r.EnvironmentID != s.EnvironmentID || r.ServiceID != s.ServiceID {
			r.conflict = fmt.Sprintf("listed for service %s, but it belongs to service %s of project %s", s.ServiceID, r.ServiceID, r.ProjectID)
		}
	}
	for id, r := range m.recs {
		if !listed[id] {
			r.listed = false
		}
	}
	if dirty {
		m.saveLocked()
	}
	m.mu.Unlock()
	m.kick()
	m.notify()
}

func (m *Manager) kick() {
	select {
	case m.work <- struct{}{}:
	default:
	}
}

// notify signals a change to the status loop and the runtime.
func (m *Manager) notify() {
	select {
	case m.changed <- struct{}{}:
	default:
	}
	if m.opts.OnChange != nil {
		m.opts.OnChange()
	}
}

// Run converges volumes and reports their status until ctx ends.
func (m *Manager) Run(ctx context.Context) error {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-ctx.Done():
				return
			case <-m.work:
				m.converge(ctx)
			}
		}
	}()
	m.kick()
	interval := cmp.Or(m.opts.StatusInterval, DefaultStatusInterval)
	tick := time.NewTicker(interval)
	defer tick.Stop()
	m.refreshUsage()
	for {
		select {
		case <-ctx.Done():
			wg.Wait()
			return nil
		case <-tick.C:
			m.refreshUsage()
			m.report(ctx)
		case <-m.changed:
			t := time.NewTimer(statusDebounce)
			select {
			case <-ctx.Done():
				t.Stop()
				wg.Wait()
				return nil
			case <-t.C:
			}
			m.refreshUsage()
			m.report(ctx)
		}
	}
}

// Connected sends a volume_status right away, for a new connection.
func (m *Manager) Connected() {
	m.mu.Lock()
	m.sentAny = true
	m.mu.Unlock()
	select {
	case m.changed <- struct{}{}:
	default:
	}
}

// converge creates and grows listed volumes, one at a time.
func (m *Manager) converge(ctx context.Context) {
	for ctx.Err() == nil {
		r, op := m.nextOp()
		if r == nil {
			return
		}
		var err error
		switch op {
		case opCreate:
			err = m.create(ctx, r)
		case opGrow:
			err = m.grow(ctx, r)
		}
		m.mu.Lock()
		r.busy, r.resizing = false, false
		switch {
		case err != nil && op == opCreate:
			r.err = err.Error()
			m.log.Error("create volume", "volume_id", r.ID, "err", err)
		case err != nil:
			r.note = "grow failed: " + err.Error()
			m.log.Error("grow volume", "volume_id", r.ID, "size_mb", r.wantSizeMB, "err", err)
		case op == opCreate:
			r.Created, r.err = true, ""
			m.log.Info("created volume", "volume_id", r.ID, "size_mb", r.SizeMB, "quota", r.Quota)
		default:
			m.log.Info("grew volume", "volume_id", r.ID, "size_mb", r.SizeMB)
		}
		m.saveLocked()
		m.mu.Unlock()
		m.notify()
	}
}

type op int

const (
	opCreate op = iota + 1
	opGrow
)

// nextOp picks the next volume needing work and marks it busy.
func (m *Manager) nextOp() (*record, op) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, id := range slices.Sorted(maps.Keys(m.recs)) {
		r := m.recs[id]
		if r.busy || r.deleting || r.Deleted || !r.listed || r.conflict != "" {
			continue
		}
		switch {
		case !r.Created && r.err == "":
			r.busy = true
			return r, opCreate
		case r.Created && r.wantSizeMB > r.SizeMB && r.note == "":
			r.busy, r.resizing = true, true
			return r, opGrow
		case r.Created && r.wantSizeMB < r.SizeMB:
			r.note = fmt.Sprintf("shrinking is not supported; keeping %d MB", r.SizeMB)
		case r.wantSizeMB == r.SizeMB:
			r.note = ""
		}
	}
	return nil, 0
}

func (m *Manager) create(ctx context.Context, r *record) error {
	b, err := m.backendFor(r)
	if err != nil {
		return err
	}
	dir := m.mntDir(r.ID)
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		return err
	}
	if err := b.create(ctx, r.ID, dir, r.SizeMB); err != nil {
		return err
	}
	data := m.DataPath(r.ID)
	if err := os.Mkdir(data, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	// NOTE: Mkdir applies the umask; the mode is set explicitly so every
	// image user can enter the directory it is about to own.
	if err := os.Chmod(data, 0o755); err != nil {
		return err
	}
	m.mu.Lock()
	owner := r.Owner
	m.mu.Unlock()
	if owner != nil {
		uid, gid, ok := ParseNumericUser(*owner)
		if !ok {
			return fmt.Errorf("owner %q is not uid:gid", *owner)
		}
		if err := chown(data, uid, gid); err != nil {
			return fmt.Errorf("chown data directory: %w", err)
		}
	} else {
		m.mu.Lock()
		r.Fresh = true
		m.mu.Unlock()
	}
	return nil
}

func (m *Manager) grow(ctx context.Context, r *record) error {
	b, err := m.backendFor(r)
	if err != nil {
		return err
	}
	m.mu.Lock()
	want := r.wantSizeMB
	m.mu.Unlock()
	m.notify()
	if err := b.grow(ctx, r.ID, m.mntDir(r.ID), want); err != nil {
		return err
	}
	m.mu.Lock()
	r.SizeMB = want
	m.mu.Unlock()
	return nil
}

// ParseNumericUser parses "uid" or "uid:gid" with numeric ids, as a volume
// owner or an image's User; a bare uid gets gid 0, as Docker gives a user
// the image doesn't name.
func ParseNumericUser(s string) (uid, gid int, ok bool) {
	u, g, hasGroup := strings.Cut(s, ":")
	uid, err := strconv.Atoi(u)
	if err != nil || uid < 0 || u == "" {
		return 0, 0, false
	}
	if !hasGroup {
		return uid, 0, true
	}
	gid, err = strconv.Atoi(g)
	if err != nil || gid < 0 {
		return 0, 0, false
	}
	return uid, gid, true
}

// mountableLocked returns why a volume can't be mounted, "" when it can.
// Caller holds m.mu.
func (m *Manager) mountableLocked(id string) string {
	r := m.recs[id]
	switch {
	case r == nil || r.Deleted:
		return "volume " + id + " does not exist on this node yet"
	case r.conflict != "":
		return "volume " + id + " refused: " + r.conflict
	case r.deleting:
		return "volume " + id + " is being deleted"
	case r.err != "":
		return "volume " + id + " failed: " + r.err
	case !r.Created:
		return "volume " + id + " is being created"
	case m.known && !r.listed:
		return "volume " + id + " is not listed in the desired state"
	}
	return ""
}

// VolumeReady reports whether a volume can be mounted, and why not.
func (m *Manager) VolumeReady(id string) (bool, string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	why := m.mountableLocked(id)
	return why == "", why
}

// MountSource returns the host directory to bind for a volume. A fresh data
// directory of a volume without an owner is first given to imageUser when
// that is numeric ("uid" or "uid:gid"); otherwise it stays root's, and
// images that start as root chown it themselves (ADR 0004).
func (m *Manager) MountSource(id, imageUser string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if why := m.mountableLocked(id); why != "" {
		return "", fmt.Errorf("%w: %s", ErrNotReady, why)
	}
	r := m.recs[id]
	path := m.DataPath(id)
	if r.Fresh {
		if uid, gid, ok := ParseNumericUser(imageUser); ok && uid != 0 {
			if err := chown(path, uid, gid); err != nil {
				return "", fmt.Errorf("chown volume %s to %s: %w", id, imageUser, err)
			}
		}
		r.Fresh = false
		m.saveLocked()
	}
	return path, nil
}

// Volume describes a held volume for tasks.
type Volume struct {
	ID            string
	ProjectID     string
	EnvironmentID string
	ServiceID     string
	// DataPath is the host directory containers bind.
	DataPath string
	Quota    protocol.VolumeQuotaMode
}

// Use marks a volume as used by a backup or restore task until release is
// called, so it can't be deleted meanwhile.
func (m *Manager) Use(id string) (Volume, func(), error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.recs[id]
	if r == nil || r.Deleted || !r.Created || r.deleting {
		return Volume{}, nil, fmt.Errorf("%w: volume %s does not exist on this node", ErrNotReady, id)
	}
	if r.err != "" {
		return Volume{}, nil, fmt.Errorf("%w: volume %s failed: %s", ErrNotReady, id, r.err)
	}
	r.users++
	var once sync.Once
	release := func() {
		once.Do(func() {
			m.mu.Lock()
			r.users--
			m.mu.Unlock()
		})
	}
	return Volume{
		ID: r.ID, ProjectID: r.ProjectID, EnvironmentID: r.EnvironmentID, ServiceID: r.ServiceID,
		DataPath: m.DataPath(id), Quota: r.Quota,
	}, release, nil
}

// Delete removes a volume and its data, for a signed volume_delete: the only
// path that deletes data. It refuses a volume that the desired state still
// lists, that a task uses, or that any container mounts. Deleting a volume
// the node doesn't hold just reports it deleted.
func (m *Manager) Delete(ctx context.Context, id string) error {
	m.mu.Lock()
	r := m.recs[id]
	if r == nil {
		m.recs[id] = &record{ID: id, Quota: m.mode, Deleted: true}
		m.saveLocked()
		m.mu.Unlock()
		m.notify()
		return nil
	}
	if r.Deleted {
		m.mu.Unlock()
		m.notify()
		return nil
	}
	var refuse string
	switch {
	case r.busy || r.deleting:
		refuse = "an operation on it is in progress"
	case r.listed && m.known:
		refuse = "the desired state still lists it"
	case r.users > 0:
		refuse = "a backup or restore is using it"
	}
	if refuse != "" {
		r.note = "delete refused: " + refuse
		m.mu.Unlock()
		m.notify()
		return fmt.Errorf("volume %s: delete refused: %s", id, refuse)
	}
	// Marked first so the runtime stops treating it as mountable before the
	// in-use check, which takes the runtime's lock and so runs unlocked.
	r.deleting = true
	m.mu.Unlock()
	m.notify()

	err := func() error {
		if m.opts.InUse != nil && m.opts.InUse(id) {
			return errors.New("a container still mounts it")
		}
		if r.Created {
			b, err := m.backendFor(r)
			if err != nil {
				return err
			}
			if err := b.remove(ctx, id, m.mntDir(id)); err != nil {
				return err
			}
		}
		return os.RemoveAll(m.mntDir(id))
	}()
	m.mu.Lock()
	r.deleting = false
	if err != nil {
		r.note = "delete refused: " + err.Error()
	} else {
		*r = record{ID: id, Quota: r.Quota, Deleted: true}
	}
	m.saveLocked()
	m.mu.Unlock()
	m.notify()
	if err != nil {
		return fmt.Errorf("volume %s: delete: %w", id, err)
	}
	m.log.Info("deleted volume", "volume_id", id)
	return nil
}

// refreshUsage measures every created volume.
func (m *Manager) refreshUsage() {
	type item struct {
		id     string
		b      backend
		sizeMB int
	}
	m.mu.Lock()
	var items []item
	for _, r := range m.recs {
		if r.Created && !r.Deleted && !r.deleting {
			if b, err := m.backendFor(r); err == nil {
				items = append(items, item{r.ID, b, r.SizeMB})
			}
		}
	}
	m.mu.Unlock()
	for _, it := range items {
		size, used, err := it.b.usage(it.id, m.mntDir(it.id), it.sizeMB)
		m.mu.Lock()
		if r := m.recs[it.id]; r != nil && err == nil {
			r.sizeBytes, r.usedBytes = size, used
		}
		m.mu.Unlock()
	}
}

// Statuses returns every held volume's report, ordered by ID.
func (m *Manager) Statuses() []protocol.VolumeStatusReport {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]protocol.VolumeStatusReport, 0, len(m.recs))
	for _, id := range slices.Sorted(maps.Keys(m.recs)) {
		r := m.recs[id]
		rep := protocol.VolumeStatusReport{VolumeID: id, Quota: r.Quota, SizeBytes: r.sizeBytes, UsedBytes: r.usedBytes}
		if rep.SizeBytes == 0 {
			rep.SizeBytes = int64(r.SizeMB) << 20
		}
		switch {
		case r.Deleted:
			rep.State, rep.SizeBytes, rep.UsedBytes = protocol.VolumeDeleted, 0, 0
		case r.err != "":
			rep.State, rep.Message = protocol.VolumeError, r.err
		case r.conflict != "":
			rep.State, rep.Message = protocol.VolumeError, r.conflict
		case !r.Created:
			rep.State = protocol.VolumeCreating
		case r.resizing:
			rep.State = protocol.VolumeResizing
		case m.known && !r.listed:
			rep.State = protocol.VolumeOrphaned
		default:
			rep.State = protocol.VolumeReady
		}
		if rep.Message == "" {
			rep.Message = r.note
		}
		rep.Message = truncate(rep.Message, protocol.MaxMessageBytes)
		out = append(out, rep)
		if len(out) == protocol.MaxVolumesPerNode {
			break
		}
	}
	return out
}

// report sends volume_status, then forgets the tombstones it carried.
func (m *Manager) report(ctx context.Context) {
	if m.opts.Send == nil || (m.opts.Enabled != nil && !m.opts.Enabled()) {
		return
	}
	reps := m.Statuses()
	m.mu.Lock()
	skip := len(reps) == 0 && !m.sentAny
	m.mu.Unlock()
	if skip {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := m.opts.Send(ctx, &protocol.VolumeStatus{Type: protocol.TypeVolumeStatus, Volumes: reps}); err != nil {
		m.log.Debug("send volume status", "err", err)
		return
	}
	m.mu.Lock()
	m.sentAny = len(reps) > 0
	dropped := false
	for _, rep := range reps {
		if r := m.recs[rep.VolumeID]; rep.State == protocol.VolumeDeleted && r != nil && r.Deleted {
			delete(m.recs, rep.VolumeID)
			dropped = true
		}
	}
	if dropped {
		m.saveLocked()
	}
	m.mu.Unlock()
}

// truncate cuts s to at most n bytes on a rune boundary.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
