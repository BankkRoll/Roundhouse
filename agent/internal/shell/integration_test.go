//go:build integration

package shell

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"fmt"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/dockertest"
	"github.com/BankkRoll/Roundhouse/agent/internal/runtime"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// itWorkload starts a long-running busybox container labelled as the
// runtime labels a service workload of namespace, and returns its ID.
func itWorkload(t *testing.T, c *docker.Client, namespace, workloadID string) string {
	t.Helper()
	return dockertest.Run(t, c, dockertest.Unique("roundhouse-it-shell-"), docker.ContainerCreate{
		Image: dockertest.BusyboxImage,
		Cmd:   []string{"sleep", "86400"},
		Env:   []string{"RH_TEST=hello"},
		Labels: map[string]string{
			runtime.LabelManaged: "true", runtime.LabelWorkloadID: workloadID,
			runtime.LabelKind: string(protocol.WorkloadService), runtime.LabelNamespace: namespace,
		},
	})
}

// hostPIDDocker signals exec processes from a sibling container in the
// engine's PID namespace.
//
// NOTE: the tests run in a container with its own PID namespace, where
// [docker.Client.SignalExec] finds no process to signal (its cgroup check
// refuses the PID). An agent on a node runs on the host; the sibling, with
// PidMode host, applies the same cgroup check and kill as it would.
type hostPIDDocker struct {
	*docker.Client

	mu   sync.Mutex
	sent []syscall.Signal
}

func (d *hostPIDDocker) SignalExec(ctx context.Context, containerID, execID string, sig syscall.Signal) (bool, error) {
	info, err := d.InspectExec(ctx, execID)
	if err != nil {
		return false, err
	}
	if !info.Running || info.Pid <= 0 {
		return false, nil
	}
	if info.ContainerID != "" {
		containerID = info.ContainerID
	}
	script := fmt.Sprintf("grep -q %s /proc/%d/cgroup && kill -%d %d", containerID, info.Pid, int(sig), info.Pid)
	id, err := d.CreateContainer(ctx, dockertest.Unique("roundhouse-it-kill-"), docker.ContainerCreate{
		Image:      dockertest.BusyboxImage,
		Cmd:        []string{"sh", "-c", script},
		Labels:     map[string]string{dockertest.TestLabel: "true"},
		HostConfig: docker.HostConfig{PidMode: "host"},
	})
	if err != nil {
		return false, err
	}
	defer func() { _ = d.RemoveContainer(context.WithoutCancel(ctx), id) }()
	if err := d.StartContainer(ctx, id); err != nil {
		return false, err
	}
	code, err := d.WaitContainer(ctx, id, "")
	if err != nil || code != 0 {
		return false, err
	}
	d.mu.Lock()
	d.sent = append(d.sent, sig)
	d.mu.Unlock()
	return true, nil
}

func (d *hostPIDDocker) signals() []syscall.Signal {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.sent)
}

// itManager runs a manager against the engine, with workloads mapping
// workload IDs to containers as the runtime would.
func itManager(t *testing.T, d Docker, namespace string, workloads fakeWorkloads) (*Manager, *recorder, *ecdh.PrivateKey, *syncBuffer) {
	t.Helper()
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rec := newRecorder()
	logs := &syncBuffer{}
	m := New(Options{
		Docker: d, Workloads: workloads, NodeID: namespace, Key: key, Namespace: namespace,
		Send: rec.Send, Logger: newTestLogger(logs),
		killGrace: time.Second,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = m.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return m, rec, key, logs
}

// processes lists the container's processes whose command line ends in
// suffix.
func processes(t *testing.T, c *docker.Client, id, suffix string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var out bytes.Buffer
	if _, err := c.RunExec(ctx, id, docker.ExecRun{Cmd: []string{"ps", "-o", "pid,args"}, Stdout: &out}); err != nil {
		t.Fatal(err)
	}
	var found []string
	for line := range strings.SplitSeq(out.String(), "\n") {
		if strings.HasSuffix(strings.TrimSpace(line), suffix) {
			found = append(found, strings.TrimSpace(line))
		}
	}
	return strings.Join(found, "; ")
}

func itOpen(t *testing.T, m *Manager, rec *recorder, nodeID, sessionID, workloadID string, command []string) {
	t.Helper()
	f := openFrame(sessionID, workloadID)
	f.NodeID = nodeID
	if command != nil {
		f.Command = command
	}
	m.OpenExec(f)
	waitFor(t, "exec_opened", func() bool {
		if e := rec.exits(sessionID); len(e) > 0 {
			t.Fatalf("session ended: %+v", e[0])
		}
		return rec.opened(sessionID) != nil
	})
}

func itClose(m *Manager, sessionID string) {
	m.CloseExec(&protocol.ExecClose{Type: protocol.TypeExecClose, ControlHeader: header(), SessionID: sessionID, Reason: protocol.ExecCloseUser})
}

func TestShellIntegrationSession(t *testing.T) {
	c := dockertest.Client(t)
	ns := dockertest.Unique("node_it")
	ctr := itWorkload(t, c, ns, "wl_web")
	d := &hostPIDDocker{Client: c}
	m, rec, key, logs := itManager(t, d, ns, fakeWorkloads{"wl_web": ctr})

	itOpen(t, m, rec, ns, "shl_it", "wl_web", nil)
	if u := rec.opened("shl_it").User; u != "root" {
		t.Fatalf("user %q", u)
	}
	m.ExecInput(sealInput(t, key, ns, "shl_it", 0, "echo $RH_TEST\r"))
	waitFor(t, "the workload's environment in the output", func() bool {
		return strings.Contains(rec.output(t, "shl_it"), "hello")
	})

	m.ResizeExec(&protocol.ExecResize{Type: protocol.TypeExecResize, ControlHeader: header(), SessionID: "shl_it", Cols: 123, Rows: 45})
	// The resize and the input batch travel separately; give the engine a
	// moment to apply the size before stty reads it.
	time.Sleep(200 * time.Millisecond)
	m.ExecInput(sealInput(t, key, ns, "shl_it", 1, "stty size\r"))
	waitFor(t, "the new terminal size", func() bool {
		return strings.Contains(rec.output(t, "shl_it"), "45 123")
	})
	if processes(t, c, ctr, "sh -l") == "" {
		t.Fatal("no login shell runs during the session")
	}

	itClose(m, "shl_it")
	if e := rec.waitExit(t, "shl_it"); e.Reason != protocol.ExecExitClosed || e.ExitCode != nil {
		t.Fatalf("exit %+v", e)
	}
	if p := processes(t, c, ctr, "sh -l"); p != "" {
		t.Fatalf("the shell outlived its session: %s", p)
	}
	if got := d.signals(); !slices.Equal(got, []syscall.Signal{syscall.SIGHUP}) {
		t.Fatalf("signals %v", got)
	}
	if l := logs.String(); strings.Contains(l, "RH_TEST") || strings.Contains(l, "stty") || strings.Contains(l, "hello") {
		t.Fatalf("logs carry terminal bytes: %s", l)
	}
}

func TestShellIntegrationKillsIgnoredHangup(t *testing.T) {
	c := dockertest.Client(t)
	ns := dockertest.Unique("node_it")
	ctr := itWorkload(t, c, ns, "wl_web")
	d := &hostPIDDocker{Client: c}
	m, rec, _, _ := itManager(t, d, ns, fakeWorkloads{"wl_web": ctr})

	itOpen(t, m, rec, ns, "shl_hup", "wl_web", []string{"/bin/sh", "-c", "trap '' HUP; exec sleep 3600"})
	waitFor(t, "the process", func() bool { return processes(t, c, ctr, "sleep 3600") != "" })
	start := time.Now()
	itClose(m, "shl_hup")
	if e := rec.waitExit(t, "shl_hup"); e.Reason != protocol.ExecExitClosed {
		t.Fatalf("exit %+v", e)
	}
	if p := processes(t, c, ctr, "sleep 3600"); p != "" {
		t.Fatalf("the process outlived its session: %s", p)
	}
	if got := d.signals(); !slices.Equal(got, []syscall.Signal{syscall.SIGHUP, syscall.SIGKILL}) {
		t.Fatalf("signals %v", got)
	}
	if time.Since(start) < time.Second {
		t.Fatal("SIGKILL came before the grace")
	}
}

// TestShellIntegrationWithoutHostPID pins down what happens where the agent
// cannot signal by host PID: the session still ends with one exec_exit, but
// the engine keeps a TTY exec's terminal open after its client goes, so the
// shell runs on and the agent says so.
func TestShellIntegrationWithoutHostPID(t *testing.T) {
	c := dockertest.Client(t)
	ns := dockertest.Unique("node_it")
	ctr := itWorkload(t, c, ns, "wl_web")
	m, rec, _, logs := itManager(t, c, ns, fakeWorkloads{"wl_web": ctr})

	itOpen(t, m, rec, ns, "shl_nopid", "wl_web", nil)
	itClose(m, "shl_nopid")
	if e := rec.waitExit(t, "shl_nopid"); e.Reason != protocol.ExecExitClosed {
		t.Fatalf("exit %+v", e)
	}
	if len(rec.exits("shl_nopid")) != 1 {
		t.Fatal("more than one exec_exit")
	}
	if processes(t, c, ctr, "sh -l") != "" && !strings.Contains(logs.String(), "could not be signalled") {
		t.Fatalf("a shell outlived its session without a warning: %s", logs.String())
	}
}

func TestShellIntegrationRefusals(t *testing.T) {
	c := dockertest.Client(t)
	ns := dockertest.Unique("node_it")
	foreign := itWorkload(t, c, dockertest.Unique("node_other"), "wl_foreign")
	system := itWorkload(t, c, ns, runtime.RegistryWorkloadID)
	m, rec, _, _ := itManager(t, c, ns, fakeWorkloads{"wl_foreign": foreign, runtime.RegistryWorkloadID: system})
	for _, tc := range []struct{ session, workload, want string }{
		{"shl_foreign", "wl_foreign", "another node"},
		{"shl_system", runtime.RegistryWorkloadID, "system workload"},
	} {
		f := openFrame(tc.session, tc.workload)
		f.NodeID = ns
		m.OpenExec(f)
		e := rec.waitExit(t, tc.session)
		if e.Reason != protocol.ExecExitError || !strings.Contains(e.Message, tc.want) || rec.opened(tc.session) != nil {
			t.Fatalf("%s: %+v", tc.workload, e)
		}
	}
	for _, id := range []string{foreign, system} {
		if p := processes(t, c, id, "sh -l"); p != "" {
			t.Fatalf("a refused session started a shell in %s: %s", id, p)
		}
	}
}
