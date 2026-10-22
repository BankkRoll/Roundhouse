package runtime

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/BankkRoll/Open-Rail/agent/internal/docker"
	"github.com/BankkRoll/Open-Rail/agent/internal/leaktest"
	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
)

func ptr[T any](v T) *T { return &v }

// spec returns a valid service workload; mutate it before use.
func spec(id, service string) protocol.WorkloadSpec {
	w := protocol.WorkloadSpec{
		ID:            id,
		Kind:          protocol.WorkloadService,
		ProjectID:     ptr("prj_1"),
		EnvironmentID: ptr("env_1"),
		ServiceID:     ptr(service),
		DeploymentID:  ptr("dep_" + strings.TrimPrefix(id, "wl_")),
		Image:         "traefik/whoami:v1.10",
		Env:           map[string]string{"GREETING": "hello"},
		Ports:         []protocol.WorkloadPort{{ContainerPort: 80, Protocol: protocol.PortHTTP}},
		Routes:        []protocol.WorkloadRoute{{Hostname: "app.example.com", ContainerPort: 80}},
		Healthcheck: &protocol.Healthcheck{
			Type: protocol.HealthcheckHTTP, Path: "/health", Port: 80, IntervalS: 1, TimeoutS: 1, Retries: 2,
		},
		Resources: protocol.Resources{CPUMillis: 500, MemoryMB: 256, PIDs: 128},
		Restart:   protocol.Restart{Policy: protocol.RestartAlways},
		Network:   protocol.ProjectNetworkName("prj_1"),
		Labels:    map[string]string{"openrail.service_name": "web", LabelManaged: "false"},
		DrainS:    0,
	}
	return rehash(w)
}

func rehash(w protocol.WorkloadSpec) protocol.WorkloadSpec {
	h, err := protocol.ComputeSpecHash(w)
	if err != nil {
		panic(err)
	}
	w.SpecHash = h
	return w
}

func desired(gen int64, ws ...protocol.WorkloadSpec) *protocol.DesiredState {
	return &protocol.DesiredState{
		Type:          protocol.TypeDesiredState,
		ControlHeader: protocol.ControlHeader{ID: "msg", NodeID: "node_1"},
		Generation:    gen,
		Workloads:     ws,
		TLSMode:       protocol.TLSOff,
	}
}

type harness struct {
	t       *testing.T
	d       *fakeDocker
	ing     *fakeIngress
	probes  *probes
	status  *statusLog
	rt      *Runtime
	cancel  context.CancelFunc
	done    chan error
	targets chan []Container
}

func newHarness(t *testing.T, tweak func(*Options)) *harness {
	t.Helper()
	leaktest.Check(t)
	d := newFakeDocker()
	h := &harness{
		t: t, d: d, ing: &fakeIngress{f: d}, probes: &probes{ok: map[string]bool{}}, status: &statusLog{},
		targets: make(chan []Container, 1),
	}
	opts := Options{
		Docker:            d,
		Ingress:           h.ing,
		DataDir:           "/var/lib/openrail",
		Report:            h.status.report,
		Interval:          20 * time.Millisecond,
		RestartBackoff:    20 * time.Millisecond,
		MaxRestartBackoff: 80 * time.Millisecond,
		Prober:            h.probes.probe,
		Containers: func(cs []Container) {
			select {
			case <-h.targets:
			default:
			}
			h.targets <- cs
		},
	}
	if tweak != nil {
		tweak(&opts)
	}
	h.rt = New(opts)
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	h.done = make(chan error, 1)
	go func() { h.done <- h.rt.Run(ctx) }()
	t.Cleanup(h.stop)
	return h
}

func (h *harness) stop() {
	if h.cancel == nil {
		return
	}
	h.cancel()
	h.cancel = nil
	select {
	case err := <-h.done:
		if err != nil {
			h.t.Errorf("Run: %v", err)
		}
	case <-time.After(5 * time.Second):
		h.t.Error("Run did not return after cancel")
	}
}

func (h *harness) state(id string) protocol.WorkloadState {
	for _, s := range h.rt.Statuses() {
		if s.WorkloadID == id {
			return s.State
		}
	}
	return ""
}

func (h *harness) waitState(id string, want protocol.WorkloadState) {
	h.t.Helper()
	eventually(h.t, "workload "+id+" to be "+string(want), func() bool { return h.state(id) == want })
}

func (h *harness) running(id string) *fakeContainer {
	h.t.Helper()
	var c *fakeContainer
	eventually(h.t, "a running container for "+id, func() bool {
		for _, x := range h.d.byWorkload(id) {
			if x.state.Running {
				c = x
			}
		}
		return c != nil
	})
	return c
}

func TestCreatesHardenedContainer(t *testing.T) {
	h := newHarness(t, nil)
	w := spec("wl_a", "svc_web")
	w.Healthcheck = nil
	w.Command = []string{"/whoami", "--port", "80"}
	h.rt.Apply(desired(1, w))
	h.waitState("wl_a", protocol.StateHealthy)

	c := h.running("wl_a")
	hc := c.spec.HostConfig
	switch {
	case hc.RestartPolicy.Name != "no":
		t.Errorf("restart policy %q: the agent must own restarts", hc.RestartPolicy.Name)
	case !slices.Equal(hc.SecurityOpt, []string{"no-new-privileges:true"}):
		t.Errorf("security opts %v", hc.SecurityOpt)
	case !slices.Equal(hc.CapDrop, []string{"ALL"}) || !slices.Equal(hc.CapAdd, DefaultCapAdd):
		t.Errorf("caps drop=%v add=%v", hc.CapDrop, hc.CapAdd)
	case hc.PidsLimit == nil || *hc.PidsLimit != 128:
		t.Errorf("pids limit %v", hc.PidsLimit)
	case hc.Memory != 256<<20 || hc.MemorySwap != hc.Memory:
		t.Errorf("memory %d swap %d", hc.Memory, hc.MemorySwap)
	case hc.NanoCPUs != 500_000_000:
		t.Errorf("nano cpus %d", hc.NanoCPUs)
	case hc.ReadonlyRootfs:
		t.Error("read-only root must be off by default")
	case hc.LogConfig.Type != "json-file" || hc.LogConfig.Config["max-size"] == "":
		t.Errorf("log config %+v", hc.LogConfig)
	case hc.NetworkMode != "openrail-prj_1":
		t.Errorf("network %q", hc.NetworkMode)
	}
	if !slices.Equal(c.spec.Env, []string{"GREETING=hello"}) || !slices.Equal(c.spec.Cmd, w.Command) {
		t.Errorf("env %v cmd %v", c.spec.Env, c.spec.Cmd)
	}
	l := c.spec.Labels
	if l[LabelManaged] != "true" || l[LabelWorkloadID] != "wl_a" || l[LabelSpecHash] != w.SpecHash ||
		l[LabelDeploymentID] != "dep_a" || l[LabelProjectID] != "prj_1" || l[LabelGeneration] != "1" ||
		l["openrail.service_name"] != "web" {
		t.Errorf("labels %v", l)
	}
	if _, ok := h.d.networks["openrail-prj_1"]; !ok {
		t.Error("project network not created")
	}
	got, _ := h.status.lastOf("wl_a")
	if got.ContainerID != c.id || got.DeploymentID == nil || *got.DeploymentID != "dep_a" || got.TS == 0 {
		t.Errorf("status %+v", got)
	}
	if err := got.Validate(); err != nil {
		t.Errorf("invalid status: %v", err)
	}
	states := h.status.states("wl_a")
	if !slices.Contains(states, protocol.StatePulling) || states[len(states)-1] != protocol.StateHealthy {
		t.Errorf("states %v", states)
	}
}

func TestGenerationOrdering(t *testing.T) {
	rt := New(Options{Docker: newFakeDocker()})
	if rt.HasDesiredState() {
		t.Fatal("fresh runtime has desired state")
	}
	if !rt.Apply(desired(5)) || !rt.HasDesiredState() {
		t.Fatal("first state rejected")
	}
	if rt.Apply(desired(5)) || rt.Apply(desired(4)) {
		t.Fatal("stale generation accepted")
	}
	if !rt.Apply(desired(6)) {
		t.Fatal("newer generation rejected")
	}
}

func TestNoDesiredStateNeverRemoves(t *testing.T) {
	h := newHarness(t, nil)
	w := spec("wl_a", "svc_web")
	w.Healthcheck = nil
	h.rt.Apply(desired(1, w))
	h.waitState("wl_a", protocol.StateHealthy)
	h.stop()

	// A restarted agent sees the container before any desired state.
	h2 := newHarness(t, func(o *Options) { o.Docker = h.d })
	h2.d = h.d
	eventually(t, "the restarted agent to report the container", func() bool { return h2.state("wl_a") != "" })
	time.Sleep(100 * time.Millisecond)
	if n := len(h.d.byWorkload("wl_a")); n != 1 {
		t.Fatalf("%d containers after restart without desired state", n)
	}
}

// A restarted agent must not take routes away from containers that kept
// serving through the restart while their first probe is still pending.
func TestRestartKeepsRoutesUntilFirstProbe(t *testing.T) {
	h := newHarness(t, nil)
	w := spec("wl_a", "svc_web")
	h.rt.Apply(desired(1, w))
	c := h.running("wl_a")
	h.probes.set(c.ip, true)
	h.waitState("wl_a", protocol.StateHealthy)
	h.stop()

	h.probes.set(c.ip, false)
	h2 := newHarness(t, func(o *Options) { o.Docker = h.d; o.Prober = h.probes.probe })
	h2.d = h.d
	h2.rt.Apply(desired(1, w))
	eventually(t, "the restarted agent to load a config", func() bool { return len(h2.ing.all()) > 0 })
	first := h2.ing.all()[0].Routes
	if len(first) != 1 || !slices.Equal(first[0].Upstreams, []string{c.ip + ":80"}) {
		t.Fatalf("first config after the restart dropped the running container: %v", first)
	}
	if n := len(h.d.byWorkload("wl_a")); n != 1 {
		t.Fatalf("%d containers after restart", n)
	}
}

func TestRecreateIsZeroDowntime(t *testing.T) {
	h := newHarness(t, nil)
	w := spec("wl_a", "svc_web")
	w.DrainS = 1
	h.rt.Apply(desired(1, w))
	old := h.running("wl_a")
	h.probes.set(old.ip, true)
	h.waitState("wl_a", protocol.StateHealthy)
	eventually(t, "routes to the first container", func() bool {
		r := h.ing.last().Routes
		return len(r) == 1 && slices.Equal(r[0].Upstreams, []string{old.ip + ":80"})
	})

	w2 := w
	w2.Env = map[string]string{"GREETING": "bonjour"}
	w2 = rehash(w2)
	h.rt.Apply(desired(2, w2))
	var next *fakeContainer
	eventually(t, "the replacement to start", func() bool {
		for _, c := range h.d.byWorkload("wl_a") {
			if c.id != old.id && c.state.Running {
				next = c
			}
		}
		return next != nil
	})
	// Until the replacement passes its probe, traffic stays on the old one.
	time.Sleep(150 * time.Millisecond)
	if r := h.ing.last().Routes; len(r) != 1 || !slices.Equal(r[0].Upstreams, []string{old.ip + ":80"}) {
		t.Fatalf("routes moved before the replacement was healthy: %v", r)
	}
	if len(h.d.byWorkload("wl_a")) != 2 {
		t.Fatal("old container removed before the replacement was healthy")
	}

	h.probes.set(next.ip, true)
	eventually(t, "the old container to be removed", func() bool { return len(h.d.byWorkload("wl_a")) == 1 })
	if r := h.ing.last().Routes; len(r) != 1 || !slices.Equal(r[0].Upstreams, []string{next.ip + ":80"}) {
		t.Fatalf("routes after swap: %v", r)
	}
	ops := h.d.opLog()
	switchAt := slices.Index(ops, "routes [{app.example.com  ["+next.ip+":80]}]")
	stopAt := slices.Index(ops, "stop "+old.name)
	removeAt := slices.Index(ops, "remove "+old.name)
	if switchAt < 0 || stopAt < switchAt || removeAt < stopAt {
		t.Fatalf("wrong order (switch %d, stop %d, remove %d): %v", switchAt, stopAt, removeAt, ops)
	}
	if h.state("wl_a") != protocol.StateHealthy {
		t.Fatalf("state %s", h.state("wl_a"))
	}
}

func TestRouteChangeDoesNotRecreate(t *testing.T) {
	h := newHarness(t, nil)
	w := spec("wl_a", "svc_web")
	w.Healthcheck = nil
	w = rehash(w)
	h.rt.Apply(desired(1, w))
	c := h.running("wl_a")
	w.Routes = append(w.Routes, protocol.WorkloadRoute{Hostname: "www.example.com", ContainerPort: 80})
	w.DrainS = 30
	w = rehash(w)
	h.rt.Apply(desired(2, w))
	eventually(t, "the new route", func() bool { return len(h.ing.last().Routes) == 2 })
	if cs := h.d.byWorkload("wl_a"); len(cs) != 1 || cs[0].id != c.id {
		t.Fatalf("route change recreated the container: %v", h.d.opLog())
	}
	if !slices.Contains(h.ing.last().AllowedHosts, "www.example.com") {
		t.Fatalf("allowed hosts %v", h.ing.last().AllowedHosts)
	}
}

func TestOldDeploymentWaitsForNewOne(t *testing.T) {
	h := newHarness(t, nil)
	a := spec("wl_a", "svc_web")
	h.rt.Apply(desired(1, a))
	ca := h.running("wl_a")
	h.probes.set(ca.ip, true)
	h.waitState("wl_a", protocol.StateHealthy)

	b := spec("wl_b", "svc_web")
	h.rt.Apply(desired(2, b))
	cb := h.running("wl_b")
	time.Sleep(150 * time.Millisecond)
	if len(h.d.byWorkload("wl_a")) != 1 {
		t.Fatal("old deployment removed before the new one was healthy")
	}
	if r := h.ing.last().Routes; len(r) != 1 || !slices.Equal(r[0].Upstreams, []string{ca.ip + ":80"}) {
		t.Fatalf("routes %v", r)
	}
	h.probes.set(cb.ip, true)
	eventually(t, "old deployment removal", func() bool { return len(h.d.byWorkload("wl_a")) == 0 })
	eventually(t, "removed status", func() bool {
		r, ok := h.status.lastOf("wl_a")
		return ok && r.State == protocol.StateRemoved
	})
	for _, s := range h.rt.Statuses() {
		if s.WorkloadID == "wl_a" {
			t.Fatal("removed workload still in hello statuses")
		}
	}
}

func TestRemoveWithoutReplacement(t *testing.T) {
	h := newHarness(t, nil)
	w := spec("wl_a", "svc_web")
	w.Healthcheck = nil
	h.rt.Apply(desired(1, w))
	h.running("wl_a")
	h.rt.Apply(desired(2))
	eventually(t, "container removal", func() bool { return len(h.d.byWorkload("wl_a")) == 0 })
	eventually(t, "routes cleared", func() bool { return len(h.ing.last().Routes) == 0 })
}

func TestCrashLoopBackoffThenGiveUp(t *testing.T) {
	h := newHarness(t, nil)
	h.d.exitOnStart["busybox:1"] = 1
	w := spec("wl_a", "svc_job")
	w.Image = "busybox:1"
	w.Healthcheck = nil
	w.Routes = nil
	w.Restart = protocol.Restart{Policy: protocol.RestartOnFailure, MaxRetries: 3}
	w = rehash(w)
	h.rt.Apply(desired(1, w))
	eventually(t, "giving up", func() bool {
		r, ok := h.status.lastOf("wl_a")
		return ok && r.State == protocol.StateCrashed && strings.Contains(r.Message, "gave up after 3 restarts")
	})
	r, _ := h.status.lastOf("wl_a")
	if r.ExitCode == nil || *r.ExitCode != 1 || r.Restarts != 3 {
		t.Fatalf("status %+v", r)
	}
	c := h.d.byWorkload("wl_a")[0]
	if len(c.starts) != 4 {
		t.Fatalf("%d starts, want 4", len(c.starts))
	}
	// Backoff doubles: 20ms, 40ms, 80ms.
	for i, want := range []time.Duration{20, 40, 80} {
		if gap := c.starts[i+1].Sub(c.starts[i]); gap < want*time.Millisecond {
			t.Errorf("restart %d after %v, want at least %v", i+1, gap, want*time.Millisecond)
		}
	}
	time.Sleep(150 * time.Millisecond)
	if n := len(h.d.byWorkload("wl_a")[0].starts); n != 4 {
		t.Fatalf("restarted after giving up: %d starts", n)
	}
	if !slices.Contains(h.status.states("wl_a"), protocol.StateCrashed) {
		t.Fatal("crash never reported")
	}
}

func TestCleanExitWithOnFailureStaysExited(t *testing.T) {
	h := newHarness(t, nil)
	h.d.exitOnStart["busybox:1"] = 0
	w := spec("wl_a", "svc_job")
	w.Image, w.Healthcheck, w.Routes = "busybox:1", nil, nil
	w.Restart = protocol.Restart{Policy: protocol.RestartOnFailure}
	h.rt.Apply(desired(1, rehash(w)))
	h.waitState("wl_a", protocol.StateExited)
	time.Sleep(100 * time.Millisecond)
	if n := len(h.d.byWorkload("wl_a")[0].starts); n != 1 {
		t.Fatalf("%d starts", n)
	}
}

func TestCrashedContainerIsRestarted(t *testing.T) {
	h := newHarness(t, nil)
	w := spec("wl_a", "svc_web")
	w.Healthcheck = nil
	h.rt.Apply(desired(1, w))
	c := h.running("wl_a")
	h.d.crash(c.id, 137)
	eventually(t, "restart", func() bool {
		cs := h.d.byWorkload("wl_a")
		return len(cs) == 1 && len(cs[0].starts) == 2 && cs[0].state.Running
	})
	h.waitState("wl_a", protocol.StateHealthy)
	r, _ := h.status.lastOf("wl_a")
	if r.Restarts != 1 {
		t.Fatalf("restarts %d", r.Restarts)
	}
	if !slices.Contains(h.status.states("wl_a"), protocol.StateCrashed) {
		t.Fatal("crash not reported before the restart")
	}
}

func TestPullFailureReportsCrashedAndRetries(t *testing.T) {
	h := newHarness(t, nil)
	h.d.pullErr["ghcr.io/acme/private:1"] = errors.New("unauthorized: authentication required")
	w := spec("wl_a", "svc_web")
	w.Image = "ghcr.io/acme/private:1"
	w.RegistryAuth = &protocol.RegistryAuth{Server: "ghcr.io", Username: "u", Password: "p"}
	h.rt.Apply(desired(1, rehash(w)))
	eventually(t, "crashed status", func() bool {
		r, ok := h.status.lastOf("wl_a")
		return ok && r.State == protocol.StateCrashed && strings.Contains(r.Message, "unauthorized")
	})
	states := h.status.states("wl_a")
	if i := slices.Index(states, protocol.StatePulling); i < 0 || !slices.Contains(states[i:], protocol.StateCrashed) {
		t.Fatalf("states %v", states)
	}
	h.d.mu.Lock()
	first := h.d.pulls[0]
	delete(h.d.pullErr, "ghcr.io/acme/private:1")
	h.d.mu.Unlock()
	if first.auth == nil || first.auth.Username != "u" || first.auth.ServerAddress != "ghcr.io" {
		t.Fatalf("auth %+v", first.auth)
	}
	h.running("wl_a")
}

func TestRegistryAuthNotSentToOtherRegistry(t *testing.T) {
	h := newHarness(t, nil)
	w := spec("wl_a", "svc_web")
	w.Healthcheck = nil
	w.Image = "docker.io/library/nginx:1"
	w.RegistryAuth = &protocol.RegistryAuth{Server: "ghcr.io", Username: "u", Password: "p"}
	h.rt.Apply(desired(1, rehash(w)))
	h.running("wl_a")
	h.d.mu.Lock()
	defer h.d.mu.Unlock()
	if h.d.pulls[0].auth != nil {
		t.Fatal("ghcr.io credential sent to docker.io")
	}
}

func TestDigestImagePresentIsNotPulled(t *testing.T) {
	h := newHarness(t, nil)
	ref := "127.0.0.1:5000/prj_1/svc_web@sha256:" + strings.Repeat("ab", 32)
	h.d.mu.Lock()
	h.d.addImageLocked(ref, 1)
	h.d.mu.Unlock()
	w := spec("wl_a", "svc_web")
	w.Image, w.Healthcheck = ref, nil
	h.rt.Apply(desired(1, rehash(w)))
	h.running("wl_a")
	h.d.mu.Lock()
	defer h.d.mu.Unlock()
	if len(h.d.pulls) != 0 {
		t.Fatalf("pulled a present digest: %v", h.d.pulls)
	}
}

func TestUnhealthyAfterRetries(t *testing.T) {
	h := newHarness(t, nil)
	w := spec("wl_a", "svc_web")
	h.rt.Apply(desired(1, w))
	c := h.running("wl_a")
	h.probes.set(c.ip, true)
	h.waitState("wl_a", protocol.StateHealthy)
	h.probes.set(c.ip, false)
	h.waitState("wl_a", protocol.StateUnhealthy)
	r, _ := h.status.lastOf("wl_a")
	if !strings.Contains(r.Message, "probe") {
		t.Fatalf("message %q", r.Message)
	}
	// A failing replica still serves when it is the only one.
	if rt := h.ing.last().Routes; len(rt) != 1 || rt[0].Upstreams[0] != c.ip+":80" {
		t.Fatalf("routes %v", rt)
	}
}

func TestRegistrySystemWorkload(t *testing.T) {
	h := newHarness(t, nil)
	ds := desired(1)
	ds.Registry = &protocol.RegistryConfig{Listen: protocol.RegistryListen, Storage: protocol.RegistryStorage{Type: protocol.StorageFilesystem}}
	h.rt.Apply(ds)
	c := h.running(RegistryWorkloadID)
	h.probes.set(c.ip, true)
	h.waitState(RegistryWorkloadID, protocol.StateHealthy)
	if addr, ok := h.rt.RegistryAddr(); !ok || addr != "127.0.0.1:5000" {
		t.Fatalf("registry addr %q %v", addr, ok)
	}
	hc := c.spec.HostConfig
	if b := hc.PortBindings["5000/tcp"]; len(b) != 1 || b[0].HostIP != "127.0.0.1" || b[0].HostPort != "5000" {
		t.Fatalf("port bindings %v", hc.PortBindings)
	}
	if !slices.Equal(hc.Binds, []string{"/var/lib/openrail/registry:/var/lib/registry"}) {
		t.Fatalf("binds %v", hc.Binds)
	}
	if c.spec.Image != RegistryImage || c.spec.Labels[LabelDeploymentID] != "" {
		t.Fatalf("image %s labels %v", c.spec.Image, c.spec.Labels)
	}
	r, _ := h.status.lastOf(RegistryWorkloadID)
	if r.DeploymentID != nil {
		t.Fatal("system workload reported a deployment")
	}

	// Switching to S3 recreates it; the old one must go first since both
	// want host port 5000.
	ds2 := desired(2)
	ds2.Registry = &protocol.RegistryConfig{Listen: protocol.RegistryListen, Storage: protocol.RegistryStorage{
		Type: protocol.StorageS3, Endpoint: "https://r2.example.com", Bucket: "reg", Region: "auto",
		AccessKeyID: "AK", SecretAccessKey: "SK",
	}}
	h.rt.Apply(ds2)
	eventually(t, "the S3 registry", func() bool {
		cs := h.d.byWorkload(RegistryWorkloadID)
		return len(cs) == 1 && cs[0].id != c.id && cs[0].state.Running
	})
	n := h.d.byWorkload(RegistryWorkloadID)[0]
	if !slices.Contains(n.spec.Env, "REGISTRY_STORAGE_S3_SECRETKEY=SK") || n.spec.HostConfig.Binds != nil {
		t.Fatalf("env %v binds %v", n.spec.Env, n.spec.HostConfig.Binds)
	}
	ops := h.d.opLog()
	if slices.Index(ops, "remove "+c.name) > slices.Index(ops, "create "+n.name) {
		t.Fatalf("new registry created before the old one was removed: %v", ops)
	}

	// Unconfigured, it goes away.
	h.rt.Apply(desired(3))
	eventually(t, "registry removal", func() bool { return len(h.d.byWorkload(RegistryWorkloadID)) == 0 })
	if _, ok := h.rt.RegistryAddr(); ok {
		t.Fatal("registry still reported available")
	}
}

func TestSystemWorkloadRecreatedIfMissing(t *testing.T) {
	h := newHarness(t, nil)
	ds := desired(1)
	ds.Registry = &protocol.RegistryConfig{Listen: protocol.RegistryListen, Storage: protocol.RegistryStorage{Type: protocol.StorageFilesystem}}
	h.rt.Apply(ds)
	c := h.running(RegistryWorkloadID)
	_ = h.d.RemoveContainer(context.Background(), c.id)
	eventually(t, "registry recreation", func() bool {
		cs := h.d.byWorkload(RegistryWorkloadID)
		return len(cs) == 1 && cs[0].id != c.id
	})
}

func TestContainersCallback(t *testing.T) {
	h := newHarness(t, nil)
	w := spec("wl_a", "svc_web")
	w.Healthcheck = nil
	h.rt.Apply(desired(1, w))
	c := h.running("wl_a")
	eventually(t, "log targets", func() bool {
		select {
		case cs := <-h.targets:
			return len(cs) == 1 && cs[0].ID == c.id && cs[0].DeploymentID == "dep_a" && cs[0].Running
		default:
			return false
		}
	})
}

func TestImageGC(t *testing.T) {
	d := newFakeDocker()
	d.mu.Lock()
	inUse := d.addImageLocked("busybox:1", 100)
	desiredID := d.addImageLocked("traefik/whoami:v1.10", 50)
	old := d.addImageLocked("old:1", 10)
	older := d.addImageLocked("older:1", 5)
	newer := d.addImageLocked("newer:1", 200)
	d.containers["c1"] = &fakeContainer{id: "c1", spec: docker.ContainerCreate{Image: "busybox:1", Labels: map[string]string{}}}
	d.mu.Unlock()

	usage := 90.0
	rt := New(Options{Docker: d})
	w := spec("wl_a", "svc_web")
	rt.Apply(desired(1, w))
	o := GCOptions{DiskUsage: func(context.Context, string) (float64, error) {
		d.mu.Lock()
		defer d.mu.Unlock()
		usage = 90 - 10*float64(5-len(d.images))
		return usage, nil
	}}.withDefaults()

	n, err := rt.collectImages(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	// Oldest unused first, stopping once below the low watermark (75%):
	// older → 80%, old → 70%.
	if n != 2 {
		t.Fatalf("removed %d images", n)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, id := range []string{inUse, desiredID, newer} {
		if _, ok := d.images[id]; !ok {
			t.Errorf("removed %s", id)
		}
	}
	for _, id := range []string{old, older} {
		if _, ok := d.images[id]; ok {
			t.Errorf("kept %s", id)
		}
	}
}

func TestImageGCIdleBelowWatermark(t *testing.T) {
	d := newFakeDocker()
	d.mu.Lock()
	d.addImageLocked("old:1", 1)
	d.mu.Unlock()
	rt := New(Options{Docker: d})
	o := GCOptions{DiskUsage: func(context.Context, string) (float64, error) { return 50, nil }}.withDefaults()
	if n, err := rt.collectImages(context.Background(), o); n != 0 || err != nil {
		t.Fatalf("removed %d, %v", n, err)
	}
}
