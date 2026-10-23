//go:build integration

package jobs

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/dockertest"
	"github.com/BankkRoll/Roundhouse/agent/internal/runtime"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// hostScratch has the same path on the daemon's host and in the test
// container (agent/test/integration.sh mounts it), so secret files written
// there can be bind-mounted into jobs.
const hostScratch = "/var/lib/roundhouse-it"

// itEnv is one test's isolated namespace, project network and state.
type itEnv struct {
	t       *testing.T
	c       *docker.Client
	ns      string
	project string
	state   string
	secrets string
}

func newITEnv(t *testing.T) *itEnv {
	t.Helper()
	c := dockertest.Client(t)
	e := &itEnv{
		t: t, c: c, ns: dockertest.Unique("node_it"), project: dockertest.Unique("prj_"),
		state: filepath.Join(t.TempDir(), "jobs.json"),
	}
	e.secrets = filepath.Join(hostScratch, dockertest.Unique("job-secrets-"))
	t.Cleanup(func() { _ = os.RemoveAll(e.secrets) })
	dockertest.Network(t, c, protocol.EnvironmentNetworkName(e.project, "env_1"), map[string]string{runtime.LabelNamespace: e.ns})
	t.Cleanup(func() { dockertest.RemoveLabelled(c, runtime.LabelNamespace+"="+e.ns) })
	dockertest.Pull(t, c, dockertest.BusyboxImage)
	return e
}

// itRunner is a runner against the real engine, with what it reported.
type itRunner struct {
	r    *Runner
	stop func()

	mu       sync.Mutex
	statuses []protocol.JobStatus
	logs     []protocol.LogLine
}

func (e *itEnv) start() *itRunner {
	ir := &itRunner{}
	ir.r = New(Options{
		Docker: e.c,
		Send: func(_ context.Context, m *protocol.JobStatus) error {
			if err := m.Validate(); err != nil {
				e.t.Errorf("invalid status %+v: %v", m, err)
			}
			ir.mu.Lock()
			ir.statuses = append(ir.statuses, *m)
			ir.mu.Unlock()
			return nil
		},
		Logs: func(_ context.Context, l protocol.Logs) error {
			if l.Source.Type != protocol.LogSourceJob || l.Source.RunID == "" || l.Source.WorkloadID == "" {
				e.t.Errorf("log source %+v", l.Source)
			}
			ir.mu.Lock()
			ir.logs = append(ir.logs, l.Lines...)
			ir.mu.Unlock()
			return nil
		},
		OpenEnv: func(_ string, w *protocol.WorkloadSpec) error {
			w.Env = map[string]string{"GREETING": "hello from a job"}
			w.SecretFiles = map[string]string{"TOKEN": "file secret"}
			return nil
		},
		Namespace:  e.ns,
		StatePath:  e.state,
		SecretsDir: e.secrets,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = ir.r.Run(ctx)
	}()
	var once sync.Once
	ir.stop = func() { once.Do(func() { cancel(); <-done }) }
	e.t.Cleanup(ir.stop)
	return ir
}

func (e *itEnv) job(runID string, timeoutS, graceS int, cmd ...string) *protocol.JobRun {
	m := jobRun(runID, timeoutS, graceS)
	m.Workload.ProjectID = &e.project
	m.Workload.Network = protocol.EnvironmentNetworkName(e.project, "env_1")
	m.Workload.Image = dockertest.BusyboxImage
	m.Workload.Command = cmd
	return m
}

func (ir *itRunner) final(runID string) (protocol.JobStatus, bool) {
	ir.mu.Lock()
	defer ir.mu.Unlock()
	for _, s := range ir.statuses {
		if s.RunID == runID && s.State.Terminal() {
			return s, true
		}
	}
	return protocol.JobStatus{}, false
}

func (ir *itRunner) waitFinal(t *testing.T, runID string, timeout time.Duration) protocol.JobStatus {
	t.Helper()
	dockertest.Eventually(t, timeout, "terminal status of "+runID, func() bool { _, ok := ir.final(runID); return ok })
	s, _ := ir.final(runID)
	return s
}

func (ir *itRunner) running(runID string) bool {
	ir.mu.Lock()
	defer ir.mu.Unlock()
	return slices.ContainsFunc(ir.statuses, func(s protocol.JobStatus) bool { return s.RunID == runID && s.State == protocol.JobRunning })
}

func (ir *itRunner) texts(stream protocol.LogStream) []string {
	ir.mu.Lock()
	defer ir.mu.Unlock()
	var out []string
	for _, l := range ir.logs {
		if l.Stream == stream {
			out = append(out, l.Text)
		}
	}
	return out
}

func (e *itEnv) gone(runID string) bool {
	_, err := e.c.InspectContainer(context.Background(), ContainerPrefix+runID)
	return docker.IsNotFound(err)
}

func TestIntegrationJobSucceeds(t *testing.T) {
	e := newITEnv(t)
	run := dockertest.Unique("crn_")
	ir := e.start()
	ir.r.Start(e.job(run, 60, 2, "sh", "-c", `echo "$GREETING"; cat /run/secrets/TOKEN; echo; echo oops >&2`))
	st := ir.waitFinal(t, run, time.Minute)
	if st.State != protocol.JobSucceeded || *st.ExitCode != 0 || st.StartedAt == nil {
		t.Fatalf("status %+v", st)
	}
	if out := ir.texts(protocol.StreamStdout); !slices.Contains(out, "hello from a job") || !slices.Contains(out, "file secret") {
		t.Fatalf("stdout %q", out)
	}
	if errs := ir.texts(protocol.StreamStderr); !slices.Equal(errs, []string{"oops"}) {
		t.Fatalf("stderr %q", errs)
	}
	dockertest.Eventually(t, 30*time.Second, "the container's removal", func() bool { return e.gone(run) })
}

func TestIntegrationJobFails(t *testing.T) {
	e := newITEnv(t)
	run := dockertest.Unique("crn_")
	ir := e.start()
	ir.r.Start(e.job(run, 60, 2, "sh", "-c", "exit 3"))
	if st := ir.waitFinal(t, run, time.Minute); st.State != protocol.JobFailed || *st.ExitCode != 3 {
		t.Fatalf("status %+v", st)
	}
}

func TestIntegrationJobTimesOut(t *testing.T) {
	e := newITEnv(t)
	run := dockertest.Unique("crn_")
	ir := e.start()
	start := time.Now()
	// NOTE: sleep runs as PID 1, which ignores SIGTERM, so this also takes
	// the SIGKILL path.
	ir.r.Start(e.job(run, protocol.MinJobTimeoutS, 2, "sleep", "600"))
	st := ir.waitFinal(t, run, time.Minute)
	took := time.Since(start)
	if st.State != protocol.JobTimedOut {
		t.Fatalf("status %+v", st)
	}
	if took < 10*time.Second || took > 30*time.Second {
		t.Fatalf("timed out after %v, want about 12s", took)
	}
	if sys := ir.texts(protocol.StreamSystem); !slices.Contains(sys, "timed out after 10s: sending SIGTERM") {
		t.Fatalf("system lines %q", sys)
	}
}

func TestIntegrationJobCancelled(t *testing.T) {
	e := newITEnv(t)
	run := dockertest.Unique("crn_")
	ir := e.start()
	ir.r.Start(e.job(run, 600, 2, "sleep", "600"))
	dockertest.Eventually(t, time.Minute, "running", func() bool { return ir.running(run) })
	ir.r.Cancel(&protocol.JobCancel{Type: protocol.TypeJobCancel, RunID: run, Reason: "test"})
	if st := ir.waitFinal(t, run, 30*time.Second); st.State != protocol.JobCancelled || st.Message != "cancelled: test" {
		t.Fatalf("status %+v", st)
	}
	dockertest.Eventually(t, 30*time.Second, "the container's removal", func() bool { return e.gone(run) })
}

func TestIntegrationJobSurvivesAnAgentRestart(t *testing.T) {
	e := newITEnv(t)
	run := dockertest.Unique("crn_")
	a := e.start()
	a.r.Start(e.job(run, 600, 2, "sh", "-c", "echo one; sleep 4; echo two; exit 5"))
	dockertest.Eventually(t, time.Minute, "the first line", func() bool { return slices.Contains(a.texts(protocol.StreamStdout), "one") })
	a.stop()
	info, err := e.c.InspectContainer(context.Background(), ContainerPrefix+run)
	if err != nil || !info.State.Running {
		t.Fatalf("the job did not keep running without the agent: %v", err)
	}

	b := e.start()
	st := b.waitFinal(t, run, time.Minute)
	if st.State != protocol.JobFailed || *st.ExitCode != 5 || st.StartedAt == nil {
		t.Fatalf("status %+v", st)
	}
	if out := b.texts(protocol.StreamStdout); !slices.Equal(out, []string{"two"}) {
		t.Fatalf("lines after the restart %q", out)
	}
	dockertest.Eventually(t, 30*time.Second, "the container's removal", func() bool { return e.gone(run) })
}
