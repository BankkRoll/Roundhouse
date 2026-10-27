//go:build integration

package runtime_test

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/dockertest"
	"github.com/BankkRoll/Roundhouse/agent/internal/ingress"
	"github.com/BankkRoll/Roundhouse/agent/internal/runtime"
	"github.com/BankkRoll/Roundhouse/agent/internal/sealtest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// itNode is the node ID workload environments are sealed to.
const itNode = "node_it"

func ptr[T any](v T) *T { return &v }

type statuses struct {
	mu   sync.Mutex
	reps []protocol.WorkloadStatusReport
}

func (s *statuses) report(_ context.Context, r protocol.WorkloadStatusReport) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := r.Validate(); err != nil {
		panic("invalid status: " + err.Error())
	}
	s.reps = append(s.reps, r)
}

func (s *statuses) last(id string) (protocol.WorkloadStatusReport, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := len(s.reps) - 1; i >= 0; i-- {
		if s.reps[i].WorkloadID == id {
			return s.reps[i], true
		}
	}
	return protocol.WorkloadStatusReport{}, false
}

func (s *statuses) states(id string) []protocol.WorkloadState {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []protocol.WorkloadState
	for _, r := range s.reps {
		if r.WorkloadID == id && (len(out) == 0 || out[len(out)-1] != r.State) {
			out = append(out, r.State)
		}
	}
	return out
}

type harness struct {
	t       *testing.T
	c       *docker.Client
	ns      string
	project string
	env     string
	network string
	caddy   string
	rt      *runtime.Runtime
	st      *statuses
	gen     int64
	http    *http.Client
	// volumes are listed in every desired state apply sends.
	volumes []protocol.VolumeSpec
}

// newHarness starts a runtime scoped to a fresh namespace and project, with
// a real Caddy the runtime's ingress manager configures. The test container
// joins the environment network, so it can probe replicas and reach Caddy.
func newHarness(t *testing.T, tweaks ...func(*runtime.Options)) *harness {
	c := dockertest.Client(t)
	ns := dockertest.Unique("it")
	h := &harness{
		t: t, c: c, ns: ns, project: "prj_" + ns, env: "env_" + ns, st: &statuses{},
		http: &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}},
	}
	h.network = protocol.EnvironmentNetworkName(h.project, h.env)
	// NOTE: registered first, so it runs last: networks can only go once
	// the runtime's containers on them are gone, and the cleanups that
	// remove networks earlier fail while they are not. It removes this
	// test's networks, made by the test or by the runtime under test.
	t.Cleanup(func() {
		dockertest.RemoveLabelled(c, runtime.LabelNamespace+"="+ns)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		_ = c.RemoveNetwork(ctx, h.network)
		nets, _ := c.ListNetworks(ctx, runtime.LabelNamespace+"="+ns)
		for _, n := range nets {
			_ = c.RemoveNetwork(ctx, n.ID)
		}
	})
	// Created up front (the runtime adopts it) so the test can join it.
	dockertest.Network(t, c, h.network, map[string]string{runtime.LabelManaged: "true"})
	dockertest.Attach(t, c, h.network)

	h.caddy = dockertest.Unique("roundhouse-it-caddy-")
	dockertest.Run(t, c, h.caddy, docker.ContainerCreate{
		Image: dockertest.CaddyImage,
		Entrypoint: []string{"sh", "-c",
			`printf '{"admin":{"listen":"0.0.0.0:2019"}}' > /tmp/boot.json && exec caddy run --config /tmp/boot.json`},
		HostConfig: docker.HostConfig{NetworkMode: h.network},
	})
	// The upstream DNS server runs in the test process, as in the agent;
	// Caddy reaches it on the test container's address.
	self := dockertest.IP(t, c, dockertest.Self(t, c), h.network)
	pc, ln := listenDNS(t, self)
	ing := ingress.New(ingress.Options{
		AdminURL:   "http://" + h.caddy + ":2019",
		Build:      ingress.BuildOptions{AdminListen: "0.0.0.0:2019", Resolver: pc.LocalAddr().String()},
		MinBackoff: 100 * time.Millisecond, MaxBackoff: time.Second,
	})
	opts := runtime.Options{
		Docker:            c,
		Ingress:           ing,
		DataDir:           "/tmp/roundhouse-it-" + ns,
		Report:            h.st.report,
		Interval:          500 * time.Millisecond,
		RestartBackoff:    200 * time.Millisecond,
		MaxRestartBackoff: time.Second,
		Namespace:         ns,
		MinDrain:          ingress.SwitchDelay,
		OpenEnv:           sealtest.Opener(sealtest.Key(), itNode),
	}
	for _, tweak := range tweaks {
		tweak(&opts)
	}
	h.rt = runtime.New(opts)
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); _ = ing.Run(ctx) }()
	go func() { defer wg.Done(); _ = ing.ServeDNSOn(ctx, pc, ln) }()
	go func() { defer wg.Done(); _ = h.rt.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		wg.Wait()
	})
	return h
}

func (h *harness) workload(id string, env map[string]string) protocol.WorkloadSpec {
	w := protocol.WorkloadSpec{
		ID:            id,
		Kind:          protocol.WorkloadService,
		ProjectID:     ptr(h.project),
		EnvironmentID: ptr(h.env),
		ServiceID:     ptr("svc_" + h.ns),
		DeploymentID:  ptr("dep_" + strings.TrimPrefix(id, "wl_")),
		Image:         dockertest.WhoamiImage,
		Env:           env,
		Ports:         []protocol.WorkloadPort{{ContainerPort: 80, Protocol: protocol.PortHTTP}},
		Routes:        []protocol.WorkloadRoute{{Hostname: "app.roundhouse.test", ContainerPort: 80}},
		Healthcheck: &protocol.Healthcheck{
			Type: protocol.HealthcheckHTTP, Path: "/health", Port: 80, IntervalS: 1, TimeoutS: 1, Retries: 2,
		},
		Resources: protocol.Resources{CPUMillis: 250, MemoryMB: 64, PIDs: 64},
		Restart:   protocol.Restart{Policy: protocol.RestartAlways},
		Network:   h.network,
		Labels:    map[string]string{},
		DrainS:    2,
	}
	return rehash(w)
}

func rehash(w protocol.WorkloadSpec) protocol.WorkloadSpec {
	hash, err := protocol.ComputeSpecHash(w)
	if err != nil {
		panic(err)
	}
	w.SpecHash = hash
	return w
}

func (h *harness) apply(ws ...protocol.WorkloadSpec) {
	h.gen++
	ds := &protocol.DesiredState{Type: protocol.TypeDesiredState, Generation: h.gen, Workloads: ws, TLSMode: protocol.TLSOff}
	ds.Volumes = h.volumes
	for i := range ws {
		sealtest.SealWorkload(h.t, sealtest.Key().PublicKey(), itNode, h.gen, &ws[i], ws[i].Env, nil)
		if err := ws[i].Validate(); err != nil {
			h.t.Fatalf("invalid workload: %v", err)
		}
	}
	if !h.rt.Apply(ds) {
		h.t.Fatal("desired state rejected")
	}
}

func (h *harness) waitState(id string, want protocol.WorkloadState, timeout time.Duration) protocol.WorkloadStatusReport {
	h.t.Helper()
	var r protocol.WorkloadStatusReport
	dockertest.Eventually(h.t, timeout, id+" "+string(want), func() bool {
		var ok bool
		r, ok = h.st.last(id)
		return ok && r.State == want
	})
	return r
}

func (h *harness) containers(workloadID string) []docker.ContainerSummary {
	list, err := h.c.ListContainers(context.Background(), runtime.LabelNamespace+"="+h.ns, runtime.LabelWorkloadID+"="+workloadID)
	if err != nil {
		h.t.Fatal(err)
	}
	return list
}

// hostname asks the app through Caddy which container answered.
func (h *harness) hostname() (string, error) {
	req, _ := http.NewRequest(http.MethodGet, "http://"+h.caddy+"/", nil)
	req.Host = "app.roundhouse.test"
	resp, err := h.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", &statusError{resp.StatusCode, string(body)}
	}
	for _, line := range strings.Split(string(body), "\n") {
		if v, ok := strings.CutPrefix(line, "Hostname: "); ok {
			return strings.TrimSpace(v), nil
		}
	}
	return "", &statusError{resp.StatusCode, "no hostname in " + string(body)}
}

type statusError struct {
	code int
	body string
}

func (e *statusError) Error() string { return http.StatusText(e.code) + ": " + e.body }

func TestWorkloadLifecycleWithZeroDowntime(t *testing.T) {
	h := newHarness(t)
	id := "wl_a" + h.ns
	h.apply(h.workload(id, map[string]string{"GREETING": "hello"}))
	first := h.waitState(id, protocol.StateHealthy, 2*time.Minute)
	if first.ContainerID == "" || first.DeploymentID == nil {
		t.Fatalf("status %+v", first)
	}
	states := h.st.states(id)
	if states[len(states)-1] != protocol.StateHealthy {
		t.Fatalf("states %v", states)
	}
	var oldHost string
	dockertest.Eventually(t, 30*time.Second, "the route through caddy", func() bool {
		var err error
		oldHost, err = h.hostname()
		return err == nil
	})
	if !strings.HasPrefix(first.ContainerID, oldHost) {
		t.Fatalf("caddy routed to %s, want %s", oldHost, first.ContainerID)
	}

	// Change the environment: the container is recreated, and requests
	// polled throughout the swap never fail.
	var failures, served atomic.Int64
	seen := sync.Map{}
	stop := make(chan struct{})
	pollDone := make(chan struct{})
	go func() {
		defer close(pollDone)
		for {
			select {
			case <-stop:
				return
			default:
			}
			host, err := h.hostname()
			if err != nil {
				failures.Add(1)
				t.Logf("request failed during the swap: %v", err)
			} else {
				served.Add(1)
				seen.Store(host, true)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	next := h.workload(id, map[string]string{"GREETING": "bonjour"})
	// NOTE: env is outside the spec hash (a workload ID's environment never
	// changes), so a hashed field drives the rollout.
	next.Labels["rev"] = "2"
	next = rehash(next)
	h.apply(next)
	var newID string
	dockertest.Eventually(t, 2*time.Minute, "the replacement to take over and the old container to go", func() bool {
		cs := h.containers(id)
		if len(cs) != 1 || strings.HasPrefix(first.ContainerID, cs[0].ID) {
			return false
		}
		newID = cs[0].ID
		r, _ := h.st.last(id)
		return r.State == protocol.StateHealthy && r.ContainerID == newID
	})
	time.Sleep(300 * time.Millisecond)
	close(stop)
	<-pollDone
	if failures.Load() != 0 {
		t.Fatalf("%d of %d requests failed during the swap", failures.Load(), failures.Load()+served.Load())
	}
	if _, ok := seen.Load(newID[:12]); !ok {
		t.Fatalf("the replacement never served (served %d)", served.Load())
	}
	t.Logf("swap served %d requests without a failure", served.Load())
	info, err := h.c.InspectContainer(context.Background(), newID)
	if err != nil {
		t.Fatal(err)
	}
	if info.Config.Labels[runtime.LabelSpecHash] != next.SpecHash || !info.State.Running {
		t.Fatalf("replacement labels %v state %+v", info.Config.Labels, info.State)
	}

	// Remove it: the container goes and the status says so.
	h.apply()
	dockertest.Eventually(t, time.Minute, "removal", func() bool { return len(h.containers(id)) == 0 })
	h.waitState(id, protocol.StateRemoved, 30*time.Second)
	dockertest.Eventually(t, 30*time.Second, "the route to go", func() bool {
		_, err := h.hostname()
		se, ok := err.(*statusError)
		return ok && se.code == 404
	})
}

func TestCrashLoopBacksOffThenCrashed(t *testing.T) {
	h := newHarness(t)
	id := "wl_crash" + h.ns
	w := h.workload(id, map[string]string{})
	w.Image = dockertest.BusyboxImage
	w.Command = []string{"sh", "-c", "echo dying; exit 3"}
	w.Ports, w.Routes, w.Healthcheck = nil, nil, nil
	w.Restart = protocol.Restart{Policy: protocol.RestartOnFailure, MaxRetries: 3}
	h.apply(rehash(w))
	r := h.waitState(id, protocol.StateCrashed, 2*time.Minute)
	dockertest.Eventually(t, time.Minute, "giving up", func() bool {
		r, _ = h.st.last(id)
		return r.Restarts == 3 && strings.Contains(r.Message, "gave up")
	})
	if r.ExitCode == nil || *r.ExitCode != 3 {
		t.Fatalf("status %+v", r)
	}
	cs := h.containers(id)
	if len(cs) != 1 || cs[0].State != "exited" {
		t.Fatalf("containers %+v", cs)
	}
	time.Sleep(2 * time.Second)
	if r2, _ := h.st.last(id); r2.Restarts != 3 {
		t.Fatalf("restarted after giving up: %+v", r2)
	}
}

func TestRegistrySystemWorkload(t *testing.T) {
	h := newHarness(t)
	ds := &protocol.DesiredState{
		Type: protocol.TypeDesiredState, Generation: 1, TLSMode: protocol.TLSOff, Workloads: []protocol.WorkloadSpec{},
		Registry: &protocol.RegistryConfig{Listen: protocol.RegistryListen, Storage: protocol.RegistryStorage{Type: protocol.StorageFilesystem}},
	}
	h.rt.Apply(ds)
	dockertest.Eventually(t, 2*time.Minute, "the system network", func() bool {
		_, err := h.c.InspectNetwork(context.Background(), runtime.SystemNetwork)
		return err == nil
	})
	dockertest.Attach(t, h.c, runtime.SystemNetwork)
	r := h.waitState(runtime.RegistryWorkloadID, protocol.StateHealthy, 3*time.Minute)
	if r.DeploymentID != nil {
		t.Fatal("system workload has a deployment")
	}
	if addr, ok := h.rt.RegistryAddr(); !ok || addr != protocol.RegistryListen {
		t.Fatalf("RegistryAddr = %q, %v", addr, ok)
	}
	ip := dockertest.IP(t, h.c, r.ContainerID, runtime.SystemNetwork)
	resp, err := h.http.Get("http://" + ip + ":5000/v2/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/v2/ = %d", resp.StatusCode)
	}

	// Recreated if it disappears.
	if err := h.c.RemoveContainer(context.Background(), r.ContainerID); err != nil {
		t.Fatal(err)
	}
	dockertest.Eventually(t, 2*time.Minute, "the registry to come back", func() bool {
		r2, _ := h.st.last(runtime.RegistryWorkloadID)
		return r2.State == protocol.StateHealthy && r2.ContainerID != r.ContainerID
	})

	// Unconfigured, it is removed.
	h.rt.Apply(&protocol.DesiredState{Type: protocol.TypeDesiredState, Generation: 2, TLSMode: protocol.TLSOff, Workloads: []protocol.WorkloadSpec{}})
	h.waitState(runtime.RegistryWorkloadID, protocol.StateRemoved, time.Minute)
	t.Cleanup(func() { _ = h.c.RemoveNetwork(context.Background(), runtime.SystemNetwork) })
}

func TestPrivateDomainResolvesOnEnvironmentNetwork(t *testing.T) {
	h := newHarness(t)
	apiID, clientID := "wl_api"+h.ns, "wl_cli"+h.ns
	api := h.workload(apiID, map[string]string{})
	api.Labels = map[string]string{runtime.LabelPrivateDomain: "api.production.internal"}
	api.Routes = nil
	api = rehash(api)

	client := h.workload(clientID, map[string]string{})
	client.ServiceID = ptr("svc_cli" + h.ns)
	client.Image = dockertest.BusyboxImage
	client.Command = []string{"/bin/sh", "-c",
		`for i in $(seq 1 60); do wget -qO- http://api.production.internal/ && exit 0; sleep 1; done; exit 1`}
	client.Ports, client.Routes, client.Healthcheck = nil, nil, nil
	client.Restart = protocol.Restart{Policy: protocol.RestartNever}
	client = rehash(client)

	h.apply(api, client)
	apiStatus := h.waitState(apiID, protocol.StateHealthy, 2*time.Minute)
	r := h.waitState(clientID, protocol.StateExited, 2*time.Minute)
	if r.ExitCode == nil || *r.ExitCode != 0 {
		t.Fatalf("client status %+v", r)
	}
	rc, err := h.c.ContainerLogs(context.Background(), r.ContainerID, docker.LogsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	var out strings.Builder
	d := docker.NewDemuxer(rc)
	for {
		_, p, err := d.Next()
		if err != nil {
			break
		}
		out.Write(p)
	}
	if !strings.Contains(out.String(), "Hostname: "+apiStatus.ContainerID[:12]) {
		t.Fatalf("client did not reach the api by its private domain:\n%s", out.String())
	}
}

// containerOutput returns everything a container wrote.
func containerOutput(t *testing.T, c *docker.Client, id string) string {
	t.Helper()
	rc, err := c.ContainerLogs(context.Background(), id, docker.LogsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	var out strings.Builder
	d := docker.NewDemuxer(rc)
	for {
		_, p, err := d.Next()
		if err != nil {
			break
		}
		out.Write(p)
	}
	return out.String()
}

// Two environments of one project run on separate networks: a container in
// one reaches its own environment by private domain and IP, and the other
// environment by neither.
func TestEnvironmentsAreIsolated(t *testing.T) {
	h := newHarness(t)
	staging := "env_stg" + h.ns
	stagingNet := protocol.EnvironmentNetworkName(h.project, staging)
	if stagingNet == h.network {
		t.Fatal("two environments got the same network")
	}
	t.Cleanup(func() { _ = h.c.RemoveNetwork(context.Background(), stagingNet) })

	prodID, stagingID, clientID := "wl_prd"+h.ns, "wl_stg"+h.ns, "wl_cli"+h.ns
	prod := h.workload(prodID, map[string]string{})
	prod.Labels = map[string]string{runtime.LabelPrivateDomain: "api.production.internal"}
	prod.Routes = nil
	prod = rehash(prod)

	stg := h.workload(stagingID, map[string]string{})
	stg.EnvironmentID = ptr(staging)
	stg.Network = stagingNet
	stg.Labels = map[string]string{runtime.LabelPrivateDomain: "api.staging.internal"}
	stg.Routes = nil
	stg = rehash(stg)

	h.apply(prod, stg)
	// The agent probes replicas from the host, which reaches every bridge;
	// the test process stands in for it, so it joins staging too.
	dockertest.Eventually(t, time.Minute, "the staging network", func() bool {
		_, err := h.c.InspectNetwork(context.Background(), stagingNet)
		return err == nil
	})
	dockertest.Attach(t, h.c, stagingNet)
	prodStatus := h.waitState(prodID, protocol.StateHealthy, 2*time.Minute)
	stgStatus := h.waitState(stagingID, protocol.StateHealthy, 2*time.Minute)
	prodIP := dockertest.IP(t, h.c, prodStatus.ContainerID, h.network)
	stgIP := dockertest.IP(t, h.c, stgStatus.ContainerID, stagingNet)
	if info, err := h.c.InspectContainer(context.Background(), stgStatus.ContainerID); err != nil {
		t.Fatal(err)
	} else if _, onProd := info.NetworkSettings.Networks[h.network]; onProd || len(info.NetworkSettings.Networks) != 1 {
		t.Fatalf("staging replica networks: %v", info.NetworkSettings.Networks)
	}

	client := h.workload(clientID, map[string]string{"OWN_IP": prodIP, "OTHER_IP": stgIP})
	client.ServiceID = ptr("svc_cli" + h.ns)
	client.Image = dockertest.BusyboxImage
	client.Command = []string{"/bin/sh", "-c", `
ok=0
for i in $(seq 1 60); do wget -T 2 -qO- http://api.production.internal/ >/dev/null && ok=1 && break; sleep 1; done
[ "$ok" = 1 ] || { echo "OWN_NAME_UNREACHABLE"; exit 1; }
wget -T 2 -qO- "http://$OWN_IP/" >/dev/null || { echo "OWN_IP_UNREACHABLE"; exit 1; }
echo "OWN_OK"
if nslookup api.staging.internal >/dev/null 2>&1; then echo "LEAK_DNS"; exit 2; fi
if wget -T 2 -qO- http://api.staging.internal/ >/dev/null 2>&1; then echo "LEAK_NAME"; exit 2; fi
if wget -T 3 -qO- "http://$OTHER_IP/" >/dev/null 2>&1; then echo "LEAK_IP"; exit 2; fi
echo "ISOLATED"
`}
	client.Ports, client.Routes, client.Healthcheck = nil, nil, nil
	client.Restart = protocol.Restart{Policy: protocol.RestartNever}
	client = rehash(client)
	h.apply(prod, stg, client)

	r := h.waitState(clientID, protocol.StateExited, 3*time.Minute)
	out := containerOutput(t, h.c, r.ContainerID)
	if r.ExitCode == nil || *r.ExitCode != 0 || !strings.Contains(out, "OWN_OK") || !strings.Contains(out, "ISOLATED") {
		t.Fatalf("exit %v; a production container reached staging or not even production:\n%s", r.ExitCode, out)
	}
}

// listenDNS opens UDP and TCP listeners on one port of host. The UDP port is
// picked by the kernel, so another process may already hold the same TCP
// port; retry with a fresh one instead of failing the test.
func listenDNS(t *testing.T, host string) (net.PacketConn, net.Listener) {
	t.Helper()
	for range 20 {
		pc, err := net.ListenPacket("udp", host+":0")
		if err != nil {
			t.Fatal(err)
		}
		ln, err := net.Listen("tcp", pc.LocalAddr().String())
		if err == nil {
			return pc, ln
		}
		pc.Close()
	}
	t.Fatal("no port free for both UDP and TCP")
	return nil, nil
}
