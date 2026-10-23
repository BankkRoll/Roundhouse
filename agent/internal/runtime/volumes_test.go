package runtime

import (
	"context"
	"io"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// fakeVolumes is a volume source whose readiness the test controls.
type fakeVolumes struct {
	mu      sync.Mutex
	notYet  map[string]string
	sources []string
}

func (f *fakeVolumes) VolumeReady(id string) (bool, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if why, ok := f.notYet[id]; ok {
		return false, why
	}
	return true, ""
}

func (f *fakeVolumes) MountSource(id, _ string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sources = append(f.sources, id)
	return "/volumes/mnt/" + id + "/data", nil
}

func (f *fakeVolumes) setReady(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.notYet, id)
}

// fakeExec answers exec probes with the exit code set per container.
type fakeExec struct {
	mu    sync.Mutex
	codes map[string]int
	cmds  [][]string
}

func (f *fakeExec) RunExec(_ context.Context, id string, run docker.ExecRun) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cmds = append(f.cmds, run.Cmd)
	code := f.codes[id]
	if code != 0 && run.Stderr != nil {
		_, _ = io.WriteString(run.Stderr, "no response\n")
	}
	return code, nil
}

func (f *fakeExec) set(id string, code int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.codes[id] = code
}

func volumeSpec(id, service string) protocol.VolumeSpec {
	return protocol.VolumeSpec{ID: id, SizeMB: 512, ProjectID: "prj_1", EnvironmentID: "env_1", ServiceID: service}
}

// dbSpec returns a database-like workload of service svc_db mounting vol_1.
func dbSpec(id string) protocol.WorkloadSpec {
	w := spec(id, "svc_db")
	w.Routes = nil
	w.Ports = []protocol.WorkloadPort{{ContainerPort: 5432, Protocol: protocol.PortTCP}}
	w.Healthcheck = nil
	w.Mounts = []protocol.WorkloadMount{{VolumeID: "vol_1", Path: "/var/lib/postgresql"}}
	w.Rollout = protocol.RolloutStopFirst
	w.StopGraceS = ptr(60)
	return rehash(w)
}

func withVolumes(ds *protocol.DesiredState, vs ...protocol.VolumeSpec) *protocol.DesiredState {
	ds.Volumes = vs
	return ds
}

func (h *harness) message(id string) string {
	for _, s := range h.rt.Statuses() {
		if s.WorkloadID == id {
			return s.Message
		}
	}
	return ""
}

func TestMountWaitsForTheVolumeThenBindsIt(t *testing.T) {
	vols := &fakeVolumes{notYet: map[string]string{"vol_1": "volume vol_1 is being created"}}
	h := newHarness(t, func(o *Options) { o.Volumes = vols })
	w := dbSpec("wl_a")
	h.rt.Apply(withVolumes(desired(1, w), volumeSpec("vol_1", "svc_db")))
	eventually(t, "pending on the volume", func() bool {
		return h.state("wl_a") == protocol.StatePending && strings.Contains(h.message("wl_a"), "being created")
	})
	if n := len(h.d.byWorkload("wl_a")); n != 0 {
		t.Fatalf("%d containers created before the volume was ready", n)
	}
	vols.setReady("vol_1")
	h.waitState("wl_a", protocol.StateHealthy)
	c := h.running("wl_a")
	want := []docker.Mount{{Type: docker.MountBind, Source: "/volumes/mnt/vol_1/data", Target: "/var/lib/postgresql"}}
	if !slices.Equal(c.spec.HostConfig.Mounts, want) {
		t.Fatalf("mounts %+v", c.spec.HostConfig.Mounts)
	}
	if c.spec.StopTimeout == nil || *c.spec.StopTimeout != 60 {
		t.Fatalf("stop timeout %v", c.spec.StopTimeout)
	}
	if c.spec.Labels[LabelVolumes] != "vol_1" || c.spec.Labels[LabelStopGrace] != "60" {
		t.Fatalf("labels %v", c.spec.Labels)
	}
	if !h.rt.VolumeInUse("vol_1") || h.rt.VolumeInUse("vol_2") {
		t.Fatal("VolumeInUse disagrees with the containers")
	}
}

func TestStopFirstRemovesThePredecessorBeforeCreating(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Volumes = &fakeVolumes{} })
	vol := volumeSpec("vol_1", "svc_db")
	h.rt.Apply(withVolumes(desired(1, dbSpec("wl_a")), vol))
	old := h.running("wl_a")
	h.waitState("wl_a", protocol.StateHealthy)

	// The next deployment is a new workload of the same service and volume.
	h.rt.Apply(withVolumes(desired(2, dbSpec("wl_b")), vol))
	h.waitState("wl_b", protocol.StateHealthy)
	ops := h.d.opLog()
	stop := slices.Index(ops, "stop "+old.name)
	remove := slices.Index(ops, "remove "+old.name)
	create := slices.IndexFunc(ops, func(op string) bool { return strings.HasPrefix(op, "create roundhouse-wl_b-") })
	if stop < 0 || remove < 0 || create < 0 || !(stop < remove && remove < create) {
		t.Fatalf("old container must stop and go before the new one is created: %v", ops)
	}

	// A spec change of the same workload with stop_first and no volume.
	w := spec("wl_c", "svc_web")
	w.Rollout = protocol.RolloutStopFirst
	w = rehash(w)
	h.rt.Apply(desired(3, w))
	first := h.running("wl_c")
	h.probes.set(first.ip, true)
	h.waitState("wl_c", protocol.StateHealthy)
	w.Command = []string{"--changed"}
	w = rehash(w)
	h.rt.Apply(desired(4, w))
	eventually(t, "the replacement", func() bool {
		cs := h.d.byWorkload("wl_c")
		return len(cs) == 1 && cs[0].id != first.id && cs[0].state.Running
	})
	ops = h.d.opLog()
	if slices.Index(ops, "remove "+first.name) > slices.IndexFunc(ops, func(op string) bool {
		return strings.HasPrefix(op, "create roundhouse-wl_c-") && op != "create "+first.name
	}) {
		t.Fatalf("stop_first created before removing: %v", ops)
	}
}

func TestTwoWorkloadsNeverMountOneVolume(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Volumes = &fakeVolumes{} })
	a, b := dbSpec("wl_a"), dbSpec("wl_b")
	h.rt.Apply(withVolumes(desired(1, a, b), volumeSpec("vol_1", "svc_db")))
	eventually(t, "one healthy, one waiting", func() bool {
		sa, sb := h.state("wl_a"), h.state("wl_b")
		return (sa == protocol.StateHealthy && sb == protocol.StatePending) || (sb == protocol.StateHealthy && sa == protocol.StatePending)
	})
	time.Sleep(100 * time.Millisecond)
	total := 0
	for _, id := range []string{"wl_a", "wl_b"} {
		total += len(h.d.byWorkload(id))
	}
	if total != 1 {
		t.Fatalf("%d containers mount vol_1", total)
	}
	waiting := "wl_b"
	if h.state("wl_a") == protocol.StatePending {
		waiting = "wl_a"
	}
	if !strings.Contains(h.message(waiting), "mounts it") {
		t.Fatalf("message %q", h.message(waiting))
	}
}

func TestHoldStopsAndReleaseRestarts(t *testing.T) {
	dir := t.TempDir()
	h := newHarness(t, func(o *Options) { o.Volumes = &fakeVolumes{}; o.DataDir = dir })
	w := dbSpec("wl_a")
	w.Restart = protocol.Restart{Policy: protocol.RestartOnFailure}
	w = rehash(w)
	h.rt.Apply(withVolumes(desired(1, w), volumeSpec("vol_1", "svc_db")))
	c := h.running("wl_a")
	h.waitState("wl_a", protocol.StateHealthy)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	release, err := h.rt.Hold(ctx, "", "vol_1", "stopped for backup bak_1")
	if err != nil {
		t.Fatal(err)
	}
	if cs := h.d.byWorkload("wl_a"); len(cs) != 1 || cs[0].state.Running || cs[0].id != c.id {
		t.Fatalf("hold did not stop the container in place: %+v", cs)
	}
	eventually(t, "pending while held", func() bool {
		return h.state("wl_a") == protocol.StatePending && strings.Contains(h.message("wl_a"), "bak_1")
	})
	time.Sleep(100 * time.Millisecond)
	if cs := h.d.byWorkload("wl_a"); cs[0].state.Running {
		t.Fatal("restarted while held")
	}
	release()
	h.waitState("wl_a", protocol.StateHealthy)
	if cs := h.d.byWorkload("wl_a"); len(cs) != 1 || cs[0].id != c.id {
		t.Fatalf("release recreated instead of restarting: %+v", cs)
	}

	// A hold that can't settle gives up with ctx and releases itself.
	short, cancelShort := context.WithCancel(context.Background())
	cancelShort()
	if _, err := h.rt.Hold(short, "wl_a", "", "never"); err == nil {
		t.Fatal("hold with an ended context succeeded")
	}
	h.waitState("wl_a", protocol.StateHealthy)

	info, ok := h.rt.Workload("wl_a")
	if !ok || info.ContainerID != c.id || !info.Running || !info.Healthy || info.IP == "" || info.Spec.Env != nil {
		t.Fatalf("workload info %+v", info)
	}
}

func TestExecProbe(t *testing.T) {
	ex := &fakeExec{codes: map[string]int{}}
	h := newHarness(t, func(o *Options) { o.Exec = ex })
	w := spec("wl_a", "svc_db")
	w.Routes = nil
	w.Healthcheck = &protocol.Healthcheck{
		Type: protocol.HealthcheckExec, Command: []string{"pg_isready", "-h", "127.0.0.1"},
		IntervalS: 1, TimeoutS: 1, Retries: 1,
	}
	w = rehash(w)
	h.rt.Apply(desired(1, w))
	c := h.running("wl_a")
	h.waitState("wl_a", protocol.StateHealthy)
	ex.set(c.id, 2)
	h.waitState("wl_a", protocol.StateUnhealthy)
	if m := h.message("wl_a"); !strings.Contains(m, "pg_isready exited with code 2: no response") {
		t.Fatalf("message %q", m)
	}
	ex.mu.Lock()
	cmd := ex.cmds[0]
	ex.mu.Unlock()
	if !slices.Equal(cmd, w.Healthcheck.Command) {
		t.Fatalf("ran %v", cmd)
	}
}

func TestRefusesUnsafeDataWorkloads(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Volumes = &fakeVolumes{} })
	published := spec("wl_pub", "svc_db")
	published.Ports[0].Publish = &protocol.PortPublish{HostPort: 25432, HostIP: "0.0.0.0"}
	published.PublishAllowedCIDRs = []string{"203.0.113.0/24"}
	published = rehash(published)

	foreign := dbSpec("wl_foreign")
	unlisted := dbSpec("wl_unlisted")
	unlisted.Mounts[0].VolumeID = "vol_9"
	unlisted = rehash(unlisted)
	unsafe := dbSpec("wl_unsafe")
	unsafe.Mounts[0].Path = "/proc"
	unsafe = rehash(unsafe)

	ds := withVolumes(desired(1, published, foreign, unlisted, unsafe), volumeSpec("vol_1", "svc_other"))
	h.rt.Apply(ds)
	for id, want := range map[string]string{
		"wl_pub":      "source allowlist",
		"wl_foreign":  "belongs to another service",
		"wl_unlisted": "does not list it",
		"wl_unsafe":   "mount path",
	} {
		eventually(t, id+" refused", func() bool {
			return h.state(id) == protocol.StatePending && strings.Contains(h.message(id), want)
		})
	}
	time.Sleep(50 * time.Millisecond)
	if ops := h.d.opLog(); slices.ContainsFunc(ops, func(op string) bool { return strings.HasPrefix(op, "create") }) {
		t.Fatalf("created a refused workload: %v", ops)
	}

	noVolumes := newHarness(t, nil)
	noVolumes.rt.Apply(withVolumes(desired(1, dbSpec("wl_a")), volumeSpec("vol_1", "svc_db")))
	eventually(t, "refused without volumes", func() bool {
		return strings.Contains(noVolumes.message("wl_a"), "does not hold volumes")
	})
	w := spec("wl_exec", "svc_db")
	w.Healthcheck = &protocol.Healthcheck{Type: protocol.HealthcheckExec, Command: []string{"true"}, IntervalS: 1, TimeoutS: 1}
	noVolumes.rt.Apply(desired(2, rehash(w)))
	eventually(t, "exec refused without an exec runner", func() bool {
		return strings.Contains(noVolumes.message("wl_exec"), "exec health check")
	})
}

func TestHeldStopSurvivesAnAgentRestart(t *testing.T) {
	dir := t.TempDir()
	h := newHarness(t, func(o *Options) { o.Volumes = &fakeVolumes{}; o.DataDir = dir })
	w := dbSpec("wl_a")
	w.Restart = protocol.Restart{Policy: protocol.RestartOnFailure}
	w = rehash(w)
	ds := withVolumes(desired(1, w), volumeSpec("vol_1", "svc_db"))
	h.rt.Apply(ds)
	c := h.running("wl_a")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := h.rt.Hold(ctx, "wl_a", "", "stopped for backup bak_1"); err != nil {
		t.Fatal(err)
	}
	// The agent dies mid-hold; the container exited 0, which on_failure
	// alone would never restart.
	h.stop()
	h2 := newHarness(t, func(o *Options) { o.Docker = h.d; o.Volumes = &fakeVolumes{}; o.DataDir = dir })
	h2.rt.Apply(ds)
	h2.waitState("wl_a", protocol.StateHealthy)
	if cs := h.d.byWorkload("wl_a"); len(cs) != 1 || cs[0].id != c.id || !cs[0].state.Running {
		t.Fatalf("containers %+v", cs)
	}
}
