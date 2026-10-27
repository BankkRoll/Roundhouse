package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/leaktest"
	"github.com/BankkRoll/Roundhouse/agent/internal/runtime"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

const (
	testNamespace = "node_test"
	image         = "busybox:1"
	// unit is how long one second of timeout_s or kill_grace_s lasts here.
	unit = 20 * time.Millisecond
)

var errNotConnected = errors.New("not connected")

// harness is a runner on a fake engine with recorded statuses and logs.
type harness struct {
	t         *testing.T
	d         *fakeDocker
	dir       string
	connected atomic.Bool
	network   atomic.Int32

	mu       sync.Mutex
	statuses []protocol.JobStatus
	logs     []protocol.Logs

	r    *Runner
	stop func()
}

func newHarness(t *testing.T, d *fakeDocker, dir string, tweak func(*Options)) *harness {
	t.Helper()
	h := &harness{t: t, d: d, dir: dir}
	h.connected.Store(true)
	opts := Options{
		Docker: d,
		Send: func(_ context.Context, m *protocol.JobStatus) error {
			if !h.connected.Load() {
				return errNotConnected
			}
			if err := m.Validate(); err != nil {
				t.Errorf("invalid status %+v: %v", m, err)
			}
			if b, _ := json.Marshal(m); strings.Contains(string(b), "s3cret") {
				t.Errorf("a secret value reached a status: %s", b)
			}
			h.mu.Lock()
			h.statuses = append(h.statuses, *m)
			h.mu.Unlock()
			return nil
		},
		Logs: func(_ context.Context, l protocol.Logs) error {
			if err := l.Validate(); err != nil {
				t.Errorf("invalid logs frame: %v", err)
			}
			h.mu.Lock()
			h.logs = append(h.logs, l)
			h.mu.Unlock()
			return nil
		},
		OpenEnv: func(_ string, w *protocol.WorkloadSpec) error {
			w.Env = map[string]string{"GREETING": "hi", "API_KEY": "s3cret"}
			w.SecretFiles = map[string]string{"TOKEN": "s3cret-file"}
			return nil
		},
		Network: func(context.Context, *protocol.WorkloadSpec) error {
			h.network.Add(1)
			return nil
		},
		Namespace:     testNamespace,
		StatePath:     filepath.Join(dir, "jobs.json"),
		SecretsDir:    filepath.Join(dir, "job-secrets"),
		FlushInterval: 10 * time.Millisecond,
		unit:          unit,
		retryInterval: 10 * time.Millisecond,
		logWait:       2 * time.Second,
	}
	if tweak != nil {
		tweak(&opts)
	}
	h.r = New(opts)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = h.r.Run(ctx)
	}()
	var once sync.Once
	h.stop = func() {
		once.Do(func() {
			cancel()
			<-done
		})
	}
	t.Cleanup(h.stop)
	return h
}

// final returns the terminal status delivered for runID.
func (h *harness) final(runID string) (protocol.JobStatus, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, s := range h.statuses {
		if s.RunID == runID && s.State.Terminal() {
			return s, true
		}
	}
	return protocol.JobStatus{}, false
}

func (h *harness) waitFinal(runID string) protocol.JobStatus {
	h.t.Helper()
	waitFor(h.t, "terminal status of "+runID, func() bool { _, ok := h.final(runID); return ok })
	s, _ := h.final(runID)
	return s
}

func (h *harness) states(runID string) []protocol.JobState {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []protocol.JobState
	for _, s := range h.statuses {
		if s.RunID == runID {
			out = append(out, s.State)
		}
	}
	return out
}

// lines returns the text of runID's log lines of stream.
func (h *harness) lines(runID string, stream protocol.LogStream) []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []string
	for _, l := range h.logs {
		if l.Source.Type != protocol.LogSourceJob || l.Source.RunID != runID {
			continue
		}
		for _, line := range l.Lines {
			if line.Stream == stream {
				out = append(out, line.Text)
			}
		}
	}
	return out
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func ptr[T any](v T) *T { return &v }

// jobRun is a valid job_run for prj_1/env_1/svc_1.
func jobRun(runID string, timeoutS, graceS int) *protocol.JobRun {
	return &protocol.JobRun{
		Type:  protocol.TypeJobRun,
		RunID: runID,
		Workload: protocol.WorkloadSpec{
			ID:            "wl_" + strings.TrimPrefix(runID, "crn_"),
			Kind:          protocol.WorkloadJob,
			ProjectID:     ptr("prj_1"),
			EnvironmentID: ptr("env_1"),
			ServiceID:     ptr("svc_1"),
			DeploymentID:  ptr("dep_1"),
			Image:         image,
			Command:       []string{"sh", "-c", "echo $GREETING"},
			Ports:         []protocol.WorkloadPort{},
			Routes:        []protocol.WorkloadRoute{},
			Resources:     protocol.Resources{CPUMillis: 500, MemoryMB: 128, PIDs: 64},
			Restart:       protocol.Restart{Policy: protocol.RestartNever},
			Network:       protocol.EnvironmentNetworkName("prj_1", "env_1"),
			Labels:        map[string]string{"team": "a", runtime.LabelManaged: "true"},
		},
		TimeoutS:   timeoutS,
		KillGraceS: graceS,
	}
}

func TestSucceedsAndCleansUp(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	d.behave[image] = behaviour{lines: []string{"hi", "done"}, exit: ptr(0)}
	h := newHarness(t, d, t.TempDir(), nil)

	h.r.Start(jobRun("crn_1", 60, 2))
	st := h.waitFinal("crn_1")
	if st.State != protocol.JobSucceeded || *st.ExitCode != 0 || st.StartedAt == nil || st.FinishedAt == nil || st.WorkloadID != "wl_1" {
		t.Fatalf("final status %+v", st)
	}
	if got := h.lines("crn_1", protocol.StreamStdout); !slices.Equal(got, []string{"hi", "done"}) {
		t.Fatalf("stdout %v", got)
	}
	waitFor(t, "the container's and secret files' removal", func() bool {
		_, err := os.Stat(filepath.Join(h.dir, "job-secrets", "wl_1"))
		return d.count() == 0 && os.IsNotExist(err)
	})
	if got := h.states("crn_1"); got[len(got)-1] != protocol.JobSucceeded || slices.Contains(got[:len(got)-1], protocol.JobSucceeded) {
		t.Fatalf("states %v", got)
	}
	h.stop()
	data, err := os.ReadFile(filepath.Join(h.dir, "jobs.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "s3cret") || strings.Contains(string(data), "GREETING") {
		t.Fatalf("jobs.json holds environment values: %s", data)
	}
}

func TestContainerIsHardenedAndLabelled(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	h := newHarness(t, d, t.TempDir(), nil)
	h.r.Start(jobRun("crn_1", 60, 2))
	waitFor(t, "running", func() bool { return slices.Contains(h.states("crn_1"), protocol.JobRunning) })

	c, ok := d.container(ContainerPrefix + "crn_1")
	if !ok {
		t.Fatal("no container")
	}
	hc := c.spec.HostConfig
	if !slices.Equal(hc.CapDrop, []string{"ALL"}) || !slices.Equal(hc.CapAdd, runtime.DefaultCapAdd) ||
		!slices.Contains(hc.SecurityOpt, "no-new-privileges:true") || hc.RestartPolicy.Name != "no" ||
		hc.Memory != 128<<20 || hc.MemorySwap != hc.Memory || hc.NanoCPUs != 500_000_000 || *hc.PidsLimit != 64 ||
		hc.NetworkMode != protocol.EnvironmentNetworkName("prj_1", "env_1") || len(hc.PortBindings) > 0 {
		t.Fatalf("host config %+v", hc)
	}
	if len(hc.Binds) != 1 || !strings.HasSuffix(hc.Binds[0], ":"+runtime.SecretsMountPath+":ro") {
		t.Fatalf("binds %v", hc.Binds)
	}
	secret, err := os.ReadFile(filepath.Join(h.dir, "job-secrets", "wl_1", "TOKEN"))
	if err != nil || string(secret) != "s3cret-file" {
		t.Fatalf("secret file %q, %v", secret, err)
	}
	if ep := c.spec.NetworkingConfig.EndpointsConfig[hc.NetworkMode]; len(ep.Aliases) > 0 {
		t.Fatalf("aliases %v", ep.Aliases)
	}
	if !slices.Equal(c.spec.Env, []string{"API_KEY=s3cret", "GREETING=hi"}) || !slices.Equal(c.spec.Cmd, []string{"sh", "-c", "echo $GREETING"}) {
		t.Fatalf("env %v cmd %v", c.spec.Env, c.spec.Cmd)
	}
	want := map[string]string{
		LabelJob: "true", runtime.LabelKind: "job", LabelRunID: "crn_1", runtime.LabelWorkloadID: "wl_1",
		runtime.LabelNamespace: testNamespace, runtime.LabelProjectID: "prj_1", runtime.LabelEnvironmentID: "env_1",
		runtime.LabelServiceID: "svc_1", runtime.LabelDeploymentID: "dep_1", "team": "a",
	}
	for k, v := range want {
		if c.spec.Labels[k] != v {
			t.Errorf("label %s = %q, want %q", k, c.spec.Labels[k], v)
		}
	}
	if _, ok := c.spec.Labels[runtime.LabelManaged]; ok {
		t.Fatal("a job container carries roundhouse.managed, so the reconciler would collect it")
	}
	if h.network.Load() != 1 {
		t.Fatalf("network ensured %d times", h.network.Load())
	}
}

func TestNonZeroExitAndOOM(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	d.behave[image] = behaviour{exit: ptr(3)}
	d.behave["oom:1"] = behaviour{exit: ptr(137), oom: true}
	h := newHarness(t, d, t.TempDir(), nil)

	h.r.Start(jobRun("crn_1", 60, 2))
	oom := jobRun("crn_2", 60, 2)
	oom.Workload.Image = "oom:1"
	h.r.Start(oom)
	if st := h.waitFinal("crn_1"); st.State != protocol.JobFailed || *st.ExitCode != 3 || st.Message != "exited with code 3" {
		t.Fatalf("exit 3: %+v", st)
	}
	if st := h.waitFinal("crn_2"); st.State != protocol.JobFailed || *st.ExitCode != 137 || st.Message != MessageOOM {
		t.Fatalf("oom: %+v", st)
	}
}

func TestTimeoutSendsSIGTERMThenSIGKILL(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	h := newHarness(t, d, t.TempDir(), nil)

	start := time.Now()
	h.r.Start(jobRun("crn_1", 5, 5))
	st := h.waitFinal("crn_1")
	if st.State != protocol.JobTimedOut || st.ExitCode == nil || *st.ExitCode != 137 || st.Message != "timed out after 5s" {
		t.Fatalf("status %+v", st)
	}
	if took := time.Since(start); took < 10*unit {
		t.Fatalf("killed after %v, before timeout and grace", took)
	}
	c, _ := d.container(ContainerPrefix + "crn_1")
	if c.id != "" && !slices.Equal(c.signals, []string{"SIGTERM", "SIGKILL"}) {
		t.Fatalf("signals %v", c.signals)
	}
	sys := h.lines("crn_1", protocol.StreamSystem)
	if !slices.Contains(sys, "timed out after 5s: sending SIGTERM") || !slices.Contains(sys, "killed after 5s grace") {
		t.Fatalf("system lines %v", sys)
	}
}

func TestCancelRunning(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	d.behave[image] = behaviour{termExits: true}
	h := newHarness(t, d, t.TempDir(), nil)

	h.r.Start(jobRun("crn_1", 600, 5))
	waitFor(t, "running", func() bool { return slices.Contains(h.states("crn_1"), protocol.JobRunning) })
	c, _ := d.container(ContainerPrefix + "crn_1")
	h.r.Cancel(&protocol.JobCancel{Type: protocol.TypeJobCancel, RunID: "crn_1", Reason: "replaced by crn_2"})
	st := h.waitFinal("crn_1")
	if st.State != protocol.JobCancelled || *st.ExitCode != 143 || st.Message != "cancelled: replaced by crn_2" || st.StartedAt == nil {
		t.Fatalf("status %+v", st)
	}
	waitFor(t, "removal", func() bool { return d.count() == 0 })
	if !slices.Equal(c.signals, nil) {
		t.Fatalf("signals before cancel %v", c.signals)
	}
	if sys := h.lines("crn_1", protocol.StreamSystem); !slices.Contains(sys, "cancelled: replaced by crn_2: sending SIGTERM") {
		t.Fatalf("system lines %v", sys)
	}
	// A second cancel, or one for an unknown run, changes nothing.
	h.r.Cancel(&protocol.JobCancel{RunID: "crn_1"})
	h.r.Cancel(&protocol.JobCancel{RunID: "crn_9"})
}

func TestCancelWhilePulling(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	d.blockPull[image] = true
	h := newHarness(t, d, t.TempDir(), nil)

	h.r.Start(jobRun("crn_1", 60, 2))
	waitFor(t, "pulling", func() bool { return slices.Contains(h.states("crn_1"), protocol.JobPulling) })
	h.r.Cancel(&protocol.JobCancel{RunID: "crn_1", Reason: "user"})
	st := h.waitFinal("crn_1")
	if st.State != protocol.JobCancelled || st.StartedAt != nil || st.ExitCode != nil || st.Message != "cancelled: user" {
		t.Fatalf("status %+v", st)
	}
	if d.count() != 0 {
		t.Fatal("a cancelled run created a container")
	}
}

func TestNodeBusy(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	h := newHarness(t, d, t.TempDir(), func(o *Options) { o.MaxConcurrent = 1 })

	h.r.Start(jobRun("crn_1", 600, 1))
	waitFor(t, "running", func() bool { return slices.Contains(h.states("crn_1"), protocol.JobRunning) })
	h.r.Start(jobRun("crn_2", 600, 1))
	if st := h.waitFinal("crn_2"); st.State != protocol.JobFailed || st.Message != MessageNodeBusy {
		t.Fatalf("status %+v", st)
	}
	if d.count() != 1 {
		t.Fatalf("%d containers", d.count())
	}
}

func TestAdmissionRefusals(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	h := newHarness(t, d, t.TempDir(), nil)

	cases := map[string]func(*protocol.JobRun){
		"crn_net":    func(m *protocol.JobRun) { m.Workload.Network = protocol.EnvironmentNetworkName("prj_2", "env_1") },
		"crn_legacy": func(m *protocol.JobRun) { m.Workload.Network = protocol.ProjectNetworkName("prj_1") },
		"crn_host":   func(m *protocol.JobRun) { m.Workload.Network = "host" },
		"crn_image": func(m *protocol.JobRun) {
			m.Workload.Image = protocol.LocalImageRepository("prj_2", "svc_9") + "@sha256:" + strings.Repeat("a", 64)
		},
		"crn_kind":    func(m *protocol.JobRun) { m.Workload.Kind = protocol.WorkloadService },
		"crn_owner":   func(m *protocol.JobRun) { m.Workload.DeploymentID = nil },
		"crn_ports":   func(m *protocol.JobRun) { m.Workload.Ports = []protocol.WorkloadPort{{ContainerPort: 80}} },
		"crn_timeout": func(m *protocol.JobRun) { m.TimeoutS = 0 },
	}
	for id, mutate := range cases {
		m := jobRun(id, 60, 2)
		mutate(m)
		h.r.Start(m)
	}
	for id := range cases {
		if st := h.waitFinal(id); st.State != protocol.JobFailed || !strings.HasPrefix(st.Message, "refusing") {
			t.Errorf("%s: %+v", id, st)
		}
	}
	own := jobRun("crn_own", 60, 2)
	own.Workload.Image = protocol.LocalImageRepository("prj_1", "svc_1") + "@sha256:" + strings.Repeat("b", 64)
	d.images[own.Workload.Image] = true
	d.behave[own.Workload.Image] = behaviour{exit: ptr(0)}
	h.r.Start(own)
	if st := h.waitFinal("crn_own"); st.State != protocol.JobSucceeded {
		t.Fatalf("own local image: %+v", st)
	}
	if slices.Contains(d.pulls, own.Workload.Image) {
		t.Fatal("a present digest image was pulled again")
	}
}

func TestRefusalFailsEveryRun(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	h := newHarness(t, d, t.TempDir(), func(o *Options) { o.Refusal = "plaintext connection" })
	h.r.Start(jobRun("crn_1", 60, 2))
	if st := h.waitFinal("crn_1"); st.State != protocol.JobFailed || st.Message != "plaintext connection" {
		t.Fatalf("status %+v", st)
	}
}

func TestEnvOpenFailure(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	h := newHarness(t, d, t.TempDir(), func(o *Options) {
		o.OpenEnv = func(string, *protocol.WorkloadSpec) error {
			return errors.Join(errors.New("job crn_1"), protocol.ErrBoxWrongKey)
		}
	})
	h.r.Start(jobRun("crn_1", 60, 2))
	if st := h.waitFinal("crn_1"); st.State != protocol.JobFailed || !strings.Contains(st.Message, "re-join") {
		t.Fatalf("status %+v", st)
	}
	if d.count() != 0 || len(d.pulls) != 0 {
		t.Fatal("a run whose environment didn't open got further")
	}
}

func TestPullFailure(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	d.pullErr[image] = errors.New("manifest unknown")
	h := newHarness(t, d, t.TempDir(), nil)
	h.r.Start(jobRun("crn_1", 60, 2))
	if st := h.waitFinal("crn_1"); st.State != protocol.JobFailed || !strings.Contains(st.Message, "manifest unknown") {
		t.Fatalf("status %+v", st)
	}
	if sys := h.lines("crn_1", protocol.StreamSystem); len(sys) != 1 || !strings.HasPrefix(sys[0], "pull failed: ") {
		t.Fatalf("system lines %v", sys)
	}
}

func TestNetworkVanishedIsEnsuredAgain(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	d.behave[image] = behaviour{exit: ptr(0)}
	d.createErrs = []error{notFound("network")}
	h := newHarness(t, d, t.TempDir(), nil)
	h.r.Start(jobRun("crn_1", 60, 2))
	if st := h.waitFinal("crn_1"); st.State != protocol.JobSucceeded {
		t.Fatalf("status %+v", st)
	}
	if n := h.network.Load(); n != 2 {
		t.Fatalf("network ensured %d times", n)
	}
}

func TestDuplicateJobRunIsIdempotent(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	h := newHarness(t, d, t.TempDir(), nil)
	h.r.Start(jobRun("crn_1", 600, 1))
	waitFor(t, "running", func() bool { return slices.Contains(h.states("crn_1"), protocol.JobRunning) })
	before := len(h.states("crn_1"))
	h.r.Start(jobRun("crn_1", 600, 1))
	waitFor(t, "the status re-sent", func() bool { return len(h.states("crn_1")) > before })
	if got := h.states("crn_1"); got[len(got)-1] != protocol.JobRunning || d.count() != 1 {
		t.Fatalf("states %v, %d containers", got, d.count())
	}

	c, _ := d.container(ContainerPrefix + "crn_1")
	d.exit(c.id, 0)
	h.waitFinal("crn_1")
	waitFor(t, "removal", func() bool { return d.count() == 0 })
	n := len(h.states("crn_1"))
	h.r.Start(jobRun("crn_1", 600, 1))
	waitFor(t, "the final status re-sent", func() bool { return len(h.states("crn_1")) > n })
	if got := h.states("crn_1"); got[len(got)-1] != protocol.JobSucceeded || d.count() != 0 {
		t.Fatalf("a finished run ran again: %v, %d containers", got, d.count())
	}
}

func TestTerminalStatusWaitsForDeliveryBeforeRemoval(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	d.behave[image] = behaviour{lines: []string{"out"}, exit: ptr(0)}
	dir := t.TempDir()
	h := newHarness(t, d, dir, nil)
	h.connected.Store(false)

	h.r.Start(jobRun("crn_1", 60, 2))
	waitFor(t, "the outcome recorded", func() bool {
		data, _ := os.ReadFile(filepath.Join(dir, "jobs.json"))
		return strings.Contains(string(data), `"state":"succeeded"`)
	})
	time.Sleep(50 * time.Millisecond)
	if d.count() != 1 {
		t.Fatal("the container was removed before the status was delivered")
	}
	h.connected.Store(true)
	h.r.Connected()
	if st := h.waitFinal("crn_1"); st.State != protocol.JobSucceeded {
		t.Fatalf("status %+v", st)
	}
	waitFor(t, "removal after delivery", func() bool { return d.count() == 0 })
}

func TestPendingTerminalStatusSurvivesARestart(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	d.behave[image] = behaviour{exit: ptr(4)}
	dir := t.TempDir()
	a := newHarness(t, d, dir, nil)
	a.connected.Store(false)
	a.r.Start(jobRun("crn_1", 60, 2))
	waitFor(t, "the outcome recorded", func() bool {
		data, _ := os.ReadFile(filepath.Join(dir, "jobs.json"))
		return strings.Contains(string(data), `"state":"failed"`)
	})
	a.stop()

	b := newHarness(t, d, dir, nil)
	b.r.Connected()
	if st := b.waitFinal("crn_1"); st.State != protocol.JobFailed || *st.ExitCode != 4 {
		t.Fatalf("status %+v", st)
	}
	waitFor(t, "removal", func() bool { return d.count() == 0 })
}

func TestReattachKeepsTheOriginalDeadline(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	dir := t.TempDir()
	a := newHarness(t, d, dir, nil)
	a.r.Start(jobRun("crn_1", 25, 1))
	waitFor(t, "running", func() bool { return slices.Contains(a.states("crn_1"), protocol.JobRunning) })
	a.r.mu.Lock()
	deadline := time.UnixMilli(a.r.runs["crn_1"].deadline)
	a.r.mu.Unlock()
	a.stop()
	c, _ := d.container(ContainerPrefix + "crn_1")
	if !c.state.Running {
		t.Fatal("stopping the runner stopped the job")
	}
	time.Sleep(20 * unit)

	b := newHarness(t, d, dir, nil)
	st := b.waitFinal("crn_1")
	killed := time.Now()
	if st.State != protocol.JobTimedOut {
		t.Fatalf("status %+v", st)
	}
	// Under a fresh deadline the kill would come at least 20 units later; the
	// margin absorbs the grace period and a loaded machine.
	if late := killed.Sub(deadline); late > 15*unit {
		t.Fatalf("killed %v after the original deadline", late)
	}
	if sys := b.lines("crn_1", protocol.StreamSystem); !slices.Contains(sys, "agent restarted: re-attached to the running job") {
		t.Fatalf("system lines %v", sys)
	}
}

func TestReattachReportsARunThatExitedMeanwhile(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	dir := t.TempDir()
	a := newHarness(t, d, dir, nil)
	a.r.Start(jobRun("crn_1", 600, 1))
	waitFor(t, "running", func() bool { return slices.Contains(a.states("crn_1"), protocol.JobRunning) })
	c, _ := d.container(ContainerPrefix + "crn_1")
	d.print(c.id, "before")
	waitFor(t, "the first line", func() bool { return len(a.lines("crn_1", protocol.StreamStdout)) == 1 })
	a.stop()

	time.Sleep(5 * time.Millisecond)
	d.print(c.id, "while down")
	d.exit(c.id, 0)

	b := newHarness(t, d, dir, nil)
	if st := b.waitFinal("crn_1"); st.State != protocol.JobSucceeded || st.StartedAt == nil {
		t.Fatalf("status %+v", st)
	}
	if got := b.lines("crn_1", protocol.StreamStdout); !slices.Equal(got, []string{"while down"}) {
		t.Fatalf("lines after the restart %v", got)
	}
	waitFor(t, "removal", func() bool { return d.count() == 0 })
}

func TestReattachHonoursACancelFromBeforeTheRestart(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	d.behave[image] = behaviour{termExits: true}
	dir := t.TempDir()
	a := newHarness(t, d, dir, nil)
	a.r.Start(jobRun("crn_1", 600, 1))
	waitFor(t, "running", func() bool { return slices.Contains(a.states("crn_1"), protocol.JobRunning) })
	a.stop()
	// A cancel recorded but not acted on: the agent stopped first.
	a.r.mu.Lock()
	a.r.runs["crn_1"].cancelled, a.r.runs["crn_1"].cancelReason = true, "stop"
	a.r.mu.Unlock()
	a.r.persist()

	b := newHarness(t, d, dir, nil)
	if st := b.waitFinal("crn_1"); st.State != protocol.JobCancelled || st.Message != "cancelled: stop" {
		t.Fatalf("status %+v", st)
	}
}

func TestPlainID(t *testing.T) {
	for id, want := range map[string]bool{"crn_1": true, "wl_A-b": true, "": false, "../wl": false, "a/b": false, `a\b`: false, "a.b": false} {
		if got := plainID(id); got != want {
			t.Errorf("plainID(%q) = %v", id, got)
		}
	}
}

func TestReattachFailsALostContainer(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	dir := t.TempDir()
	a := newHarness(t, d, dir, nil)
	a.r.Start(jobRun("crn_1", 600, 1))
	waitFor(t, "running", func() bool { return slices.Contains(a.states("crn_1"), protocol.JobRunning) })
	a.stop()
	c, _ := d.container(ContainerPrefix + "crn_1")
	_ = d.RemoveContainer(context.Background(), c.id)

	b := newHarness(t, d, dir, nil)
	if st := b.waitFinal("crn_1"); st.State != protocol.JobFailed || st.Message != MessageLost {
		t.Fatalf("status %+v", st)
	}
}

func TestReattachFailsARunInterruptedWhilePulling(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	d.blockPull[image] = true
	dir := t.TempDir()
	a := newHarness(t, d, dir, nil)
	a.r.Start(jobRun("crn_1", 60, 1))
	waitFor(t, "pulling", func() bool { return slices.Contains(a.states("crn_1"), protocol.JobPulling) })
	a.stop()

	b := newHarness(t, d, dir, nil)
	if st := b.waitFinal("crn_1"); st.State != protocol.JobFailed || st.Message != MessageInterrupted {
		t.Fatalf("status %+v", st)
	}
}

func TestOrphansAreRemoved(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	d.images[image] = true
	ctx := context.Background()
	orphan, _ := d.CreateContainer(ctx, ContainerPrefix+"crn_old", docker.ContainerCreate{Image: image,
		Labels: map[string]string{LabelJob: "true", LabelRunID: "crn_old", runtime.LabelNamespace: testNamespace}})
	other, _ := d.CreateContainer(ctx, "roundhouse-job-crn_theirs", docker.ContainerCreate{Image: image,
		Labels: map[string]string{LabelJob: "true", LabelRunID: "crn_theirs", runtime.LabelNamespace: "node_other"}})
	dir := t.TempDir()
	stale := filepath.Join(dir, "job-secrets", "wl_old")
	if err := os.MkdirAll(stale, 0o700); err != nil {
		t.Fatal(err)
	}

	newHarness(t, d, dir, nil)
	waitFor(t, "the orphan's removal", func() bool { _, ok := d.container(orphan); return !ok })
	if _, ok := d.container(other); !ok {
		t.Fatal("another namespace's job container was removed")
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale secret files: %v", err)
	}
}

func TestClip(t *testing.T) {
	long := strings.Repeat("é", protocol.MaxMessageBytes)
	got := clip(long)
	if len(got) > protocol.MaxMessageBytes || !strings.HasPrefix(long, got) || len(got)%2 != 0 {
		t.Fatalf("clip cut %d bytes", len(got))
	}
}

func TestReattachDoesNotTimeOutARunThatExitedInTime(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	dir := t.TempDir()
	a := newHarness(t, d, dir, nil)
	// A deadline well past the first harness's lifetime, so it can only pass
	// while no agent runs, even on a slow machine under -race.
	a.r.Start(jobRun("crn_1", 25, 1))
	waitFor(t, "running", func() bool { return slices.Contains(a.states("crn_1"), protocol.JobRunning) })
	a.stop()
	c, _ := d.container(ContainerPrefix + "crn_1")
	d.exit(c.id, 0)
	// The deadline passes while the agent is down, after the exit.
	time.Sleep(30 * unit)

	b := newHarness(t, d, dir, nil)
	if st := b.waitFinal("crn_1"); st.State != protocol.JobSucceeded {
		t.Fatalf("status %+v", st)
	}
	if c, _ := d.container(ContainerPrefix + "crn_1"); len(c.signals) > 0 {
		t.Fatalf("an exited container was signalled: %v", c.signals)
	}
}
