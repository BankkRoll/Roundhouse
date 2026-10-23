package volumes

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/leaktest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

func spec(id string, sizeMB int) protocol.VolumeSpec {
	return protocol.VolumeSpec{ID: id, SizeMB: sizeMB, ProjectID: "prj_1", EnvironmentID: "env_1", ServiceID: "svc_1"}
}

type sent struct {
	mu   sync.Mutex
	msgs []*protocol.VolumeStatus
	fail bool
}

func (s *sent) send(_ context.Context, m *protocol.VolumeStatus) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return errors.New("not connected")
	}
	if err := m.Validate(); err != nil {
		panic(err)
	}
	s.msgs = append(s.msgs, m)
	return nil
}

func (s *sent) last() *protocol.VolumeStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.msgs) == 0 {
		return nil
	}
	return s.msgs[len(s.msgs)-1]
}

func newManager(t *testing.T, root string, tweak func(*Options)) *Manager {
	t.Helper()
	opts := Options{Root: root, Quota: QuotaNone, StatePath: filepath.Join(root, "volumes.json")}
	if tweak != nil {
		tweak(&opts)
	}
	m, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// assignableOwner returns a uid:gid the test process may chown to: a foreign
// owner as root, its own ids otherwise (an unprivileged chown to another user
// fails with EPERM, as on CI runners).
func assignableOwner() string {
	if uid := os.Geteuid(); uid > 0 {
		return fmt.Sprintf("%d:%d", uid, os.Getegid())
	}
	return "999:998"
}

func runManager(t *testing.T, m *Manager) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	m.Start(ctx)
	go func() { done <- m.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	})
}

func stateOf(m *Manager, id string) protocol.VolumeState {
	for _, r := range m.Statuses() {
		if r.VolumeID == id {
			return r.State
		}
	}
	return ""
}

func TestNoneModeCreatesOrphansAndDeletesOnlyOnRequest(t *testing.T) {
	leaktest.Check(t)
	root := t.TempDir()
	out := &sent{}
	inUse := map[string]bool{}
	var mu sync.Mutex
	m := newManager(t, root, func(o *Options) {
		o.Send = out.send
		o.InUse = func(id string) bool { mu.Lock(); defer mu.Unlock(); return inUse[id] }
	})
	if m.Mode() != protocol.QuotaNone {
		t.Fatalf("mode %s", m.Mode())
	}
	runManager(t, m)

	m.Apply(1, []protocol.VolumeSpec{spec("vol_a", 256)})
	eventually(t, "vol_a ready", func() bool { ok, _ := m.VolumeReady("vol_a"); return ok })
	data := m.DataPath("vol_a")
	if err := os.WriteFile(filepath.Join(data, "keep"), []byte("precious"), 0o600); err != nil {
		t.Fatal(err)
	}
	eventually(t, "a ready volume_status", func() bool {
		l := out.last()
		return l != nil && len(l.Volumes) == 1 && l.Volumes[0].State == protocol.VolumeReady && l.Volumes[0].UsedBytes > 0
	})

	// Dropped from the desired state: orphaned, never deleted.
	m.Apply(2, nil)
	eventually(t, "orphaned", func() bool { return stateOf(m, "vol_a") == protocol.VolumeOrphaned })
	if ok, _ := m.VolumeReady("vol_a"); ok {
		t.Fatal("an orphaned volume must not be mountable")
	}
	if b, err := os.ReadFile(filepath.Join(data, "keep")); err != nil || string(b) != "precious" {
		t.Fatalf("orphaned data lost: %q %v", b, err)
	}

	// Listed again: back to ready, data intact.
	m.Apply(3, []protocol.VolumeSpec{spec("vol_a", 256)})
	eventually(t, "ready again", func() bool { return stateOf(m, "vol_a") == protocol.VolumeReady })
	if err := m.Delete(context.Background(), "vol_a"); err == nil {
		t.Fatal("deleted a volume the desired state still lists")
	}

	m.Apply(4, nil)
	mu.Lock()
	inUse["vol_a"] = true
	mu.Unlock()
	if err := m.Delete(context.Background(), "vol_a"); err == nil {
		t.Fatal("deleted a volume a container mounts")
	}
	if _, err := os.Stat(filepath.Join(data, "keep")); err != nil {
		t.Fatal("refused delete removed data")
	}
	_, release, err := m.Use("vol_a")
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	inUse["vol_a"] = false
	mu.Unlock()
	if err := m.Delete(context.Background(), "vol_a"); err == nil {
		t.Fatal("deleted a volume a task uses")
	}
	release()

	if err := m.Delete(context.Background(), "vol_a"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(m.mntDir("vol_a")); !os.IsNotExist(err) {
		t.Fatalf("volume directory still there: %v", err)
	}
	eventually(t, "deleted reported then forgotten", func() bool {
		l := out.last()
		return l != nil && len(l.Volumes) == 0 && len(m.Statuses()) == 0
	})
	out.mu.Lock()
	reported := false
	for _, msg := range out.msgs {
		for _, v := range msg.Volumes {
			reported = reported || v.State == protocol.VolumeDeleted
		}
	}
	out.mu.Unlock()
	if !reported {
		t.Fatal("deletion never reported")
	}
}

func TestStatePersistsAcrossRestartsWithoutOrphaning(t *testing.T) {
	leaktest.Check(t)
	root := t.TempDir()
	owner := assignableOwner()
	m := newManager(t, root, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	m.Start(ctx)
	go func() { done <- m.Run(ctx) }()
	s := spec("vol_b", 512)
	s.Owner = &owner
	m.Apply(7, []protocol.VolumeSpec{s, spec("vol_c", 256)})
	eventually(t, "both ready", func() bool {
		for _, r := range m.Statuses() {
			if r.State == protocol.VolumeError {
				t.Fatalf("%s: %s", r.VolumeID, r.Message)
			}
		}
		a, _ := m.VolumeReady("vol_b")
		b, _ := m.VolumeReady("vol_c")
		return a && b
	})
	cancel()
	<-done

	m2 := newManager(t, root, nil)
	runManager(t, m2)
	// Before the first desired state, held volumes are neither orphaned nor
	// unmountable.
	if st := stateOf(m2, "vol_b"); st != protocol.VolumeReady {
		t.Fatalf("after restart: %s", st)
	}
	if ok, why := m2.VolumeReady("vol_c"); !ok {
		t.Fatal(why)
	}
	m2.Apply(8, []protocol.VolumeSpec{s})
	eventually(t, "vol_c orphaned", func() bool { return stateOf(m2, "vol_c") == protocol.VolumeOrphaned })
	if _, err := os.Stat(m2.DataPath("vol_c")); err != nil {
		t.Fatal("orphan lost its data")
	}
	// Stale generations are ignored.
	m2.Apply(5, []protocol.VolumeSpec{s, spec("vol_c", 256)})
	if st := stateOf(m2, "vol_c"); st != protocol.VolumeOrphaned {
		t.Fatalf("stale generation applied: %s", st)
	}
}

func TestOwnerConflictIsRefused(t *testing.T) {
	leaktest.Check(t)
	root := t.TempDir()
	m := newManager(t, root, nil)
	runManager(t, m)
	m.Apply(1, []protocol.VolumeSpec{spec("vol_a", 256)})
	eventually(t, "ready", func() bool { ok, _ := m.VolumeReady("vol_a"); return ok })
	other := spec("vol_a", 256)
	other.ProjectID = "prj_2"
	m.Apply(2, []protocol.VolumeSpec{other})
	ok, why := m.VolumeReady("vol_a")
	if ok || why == "" {
		t.Fatal("a volume was handed to another project")
	}
	if _, err := m.MountSource("vol_a", ""); !errors.Is(err, ErrNotReady) {
		t.Fatalf("mount source: %v", err)
	}
	if st := stateOf(m, "vol_a"); st != protocol.VolumeError {
		t.Fatalf("state %s", st)
	}
}

// fakeBackend records operations, standing in for loop volumes.
type fakeBackend struct {
	mu    sync.Mutex
	ops   []string
	sizes map[string]int
	fail  error
}

func (f *fakeBackend) create(_ context.Context, id, dir string, sizeMB int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return f.fail
	}
	f.ops = append(f.ops, "create "+id)
	f.sizes[id] = sizeMB
	return os.MkdirAll(dir, 0o700)
}

func (f *fakeBackend) mount(_ context.Context, id, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, "mount "+id)
	return nil
}

func (f *fakeBackend) grow(_ context.Context, id, _ string, sizeMB int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, "grow "+id)
	f.sizes[id] = sizeMB
	return nil
}

func (f *fakeBackend) remove(_ context.Context, id, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, "remove "+id)
	return nil
}

func (f *fakeBackend) usage(id, _ string, _ int) (int64, int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return int64(f.sizes[id]) << 20, 4096, nil
}

func (f *fakeBackend) log() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.ops...)
}

func TestGrowOnlyAndMountAtStart(t *testing.T) {
	leaktest.Check(t)
	root := t.TempDir()
	fb := &fakeBackend{sizes: map[string]int{}}
	m := newManager(t, root, func(o *Options) { o.backend = fb })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	m.Start(ctx)
	go func() { done <- m.Run(ctx) }()
	m.Apply(1, []protocol.VolumeSpec{spec("vol_a", 256)})
	eventually(t, "ready", func() bool { ok, _ := m.VolumeReady("vol_a"); return ok })
	m.Apply(2, []protocol.VolumeSpec{spec("vol_a", 1024)})
	eventually(t, "grown", func() bool {
		fb.mu.Lock()
		defer fb.mu.Unlock()
		return fb.sizes["vol_a"] == 1024
	})
	m.Apply(3, []protocol.VolumeSpec{spec("vol_a", 512)})
	eventually(t, "shrink refused", func() bool {
		for _, r := range m.Statuses() {
			if r.Message != "" && r.SizeBytes == 1024<<20 {
				return true
			}
		}
		return false
	})
	cancel()
	<-done

	m2 := newManager(t, root, func(o *Options) { o.backend = fb })
	m2.Start(context.Background())
	if ops := fb.log(); ops[len(ops)-1] != "mount vol_a" {
		t.Fatalf("not mounted at start: %v", ops)
	}
	if ok, why := m2.VolumeReady("vol_a"); !ok {
		t.Fatal(why)
	}
}

func TestCreateFailureIsReportedAndNotMountable(t *testing.T) {
	leaktest.Check(t)
	root := t.TempDir()
	fb := &fakeBackend{sizes: map[string]int{}, fail: errors.New("mkfs.ext4: disk full")}
	m := newManager(t, root, func(o *Options) { o.backend = fb })
	runManager(t, m)
	m.Apply(1, []protocol.VolumeSpec{spec("vol_a", 256)})
	eventually(t, "error", func() bool { return stateOf(m, "vol_a") == protocol.VolumeError })
	if ok, why := m.VolumeReady("vol_a"); ok || why == "" {
		t.Fatal("a failed volume is mountable")
	}
}

func TestQuotaSettings(t *testing.T) {
	root := t.TempDir()
	for _, q := range []string{QuotaXFS, QuotaExt4, "bogus"} {
		if _, err := New(Options{Root: root, Quota: q, StatePath: filepath.Join(root, "v.json")}); err == nil {
			t.Errorf("quota %q accepted", q)
		}
	}
	if _, err := New(Options{Root: "relative", StatePath: filepath.Join(root, "v.json")}); err == nil {
		t.Error("relative root accepted")
	}
	m, err := New(Options{Root: root, Quota: QuotaAuto, StatePath: filepath.Join(root, "v.json")})
	if err != nil {
		t.Fatal(err)
	}
	if m.Mode() != protocol.QuotaNone && m.Mode() != protocol.QuotaLoop {
		t.Fatalf("auto picked %s", m.Mode())
	}
}

func TestParseNumericUser(t *testing.T) {
	for in, want := range map[string][3]int{
		"999":       {999, 0, 1},
		"999:998":   {999, 998, 1},
		"postgres":  {0, 0, 0},
		"999:group": {0, 0, 0},
		"":          {0, 0, 0},
		"-1":        {0, 0, 0},
	} {
		uid, gid, ok := ParseNumericUser(in)
		got := [3]int{uid, gid, 0}
		if ok {
			got[2] = 1
		}
		if got != want {
			t.Errorf("%q: got %v, want %v", in, got, want)
		}
	}
}
