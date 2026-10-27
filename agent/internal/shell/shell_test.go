package shell

import (
	"bytes"
	"encoding/base64"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/jobs"
	"github.com/BankkRoll/Roundhouse/agent/internal/runtime"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

func TestOpenRelaysAndCloses(t *testing.T) {
	h := newHarness(t, nil)
	h.openWait(t, openFrame("shl_a", testWorkload))
	if u := h.rec.opened("shl_a").User; u != "app" {
		t.Fatalf("user %q", u)
	}
	p := h.f.proc(0)
	if !slices.Equal(p.cfg.Cmd, protocol.DefaultExecCommand) || p.cfg.User != "" || !p.cfg.Tty ||
		!p.cfg.AttachStdin || !p.cfg.AttachStdout || !p.cfg.AttachStderr ||
		!slices.Equal(p.cfg.Env, []string{"TERM=xterm-256color"}) {
		t.Fatalf("exec config %+v", p.cfg)
	}
	waitFor(t, "initial resize", func() bool { return len(h.f.resizesOf(p)) > 0 })
	if r := h.f.resizesOf(p)[0]; r != [2]int{24, 80} {
		t.Fatalf("initial size %v", r)
	}

	h.m.ExecInput(h.input(t, "shl_a", 0, "hello\r"))
	waitFor(t, "echo", func() bool { return strings.Contains(h.rec.output(t, "shl_a"), "hello") })
	h.m.ResizeExec(&protocol.ExecResize{Type: protocol.TypeExecResize, ControlHeader: header(), SessionID: "shl_a", Cols: 120, Rows: 40})
	waitFor(t, "resize", func() bool { return slices.Contains(h.f.resizesOf(p), [2]int{40, 120}) })

	h.m.CloseExec(&protocol.ExecClose{Type: protocol.TypeExecClose, ControlHeader: header(), SessionID: "shl_a", Reason: protocol.ExecCloseUser})
	e := h.rec.waitExit(t, "shl_a")
	if e.Reason != protocol.ExecExitClosed || e.ExitCode != nil {
		t.Fatalf("exit %+v", e)
	}
	if got := h.f.signalsOf(p); !slices.Equal(got, []syscall.Signal{syscall.SIGHUP}) {
		t.Fatalf("signals %v", got)
	}
	for i, o := range h.rec.outputs("shl_a") {
		if o.Seq != int64(i) {
			t.Fatalf("output %d has seq %d", i, o.Seq)
		}
	}
}

func TestCommandIsPassedVerbatim(t *testing.T) {
	h := newHarness(t, nil)
	f := openFrame("shl_argv", testWorkload)
	f.Command = []string{"/bin/echo", "a b; rm -rf /", "$(id)"}
	h.openWait(t, f)
	if got := h.f.proc(0).cfg.Cmd; !slices.Equal(got, f.Command) {
		t.Fatalf("cmd %q", got)
	}
}

func TestDefaultUserIsRoot(t *testing.T) {
	h := newHarness(t, nil)
	h.f.addContainer(testContainer, testWorkload, func(c *docker.ContainerInfo) { c.Config.User = "" })
	h.openWait(t, openFrame("shl_root", testWorkload))
	if u := h.rec.opened("shl_root").User; u != "root" {
		t.Fatalf("user %q", u)
	}
}

func TestProcessExitReportsCode(t *testing.T) {
	h := newHarness(t, nil)
	h.openWait(t, openFrame("shl_exit", testWorkload))
	h.m.ExecInput(h.input(t, "shl_exit", 0, "exit 3\r"))
	e := h.rec.waitExit(t, "shl_exit")
	if e.Reason != protocol.ExecExitExited || e.ExitCode == nil || *e.ExitCode != 3 {
		t.Fatalf("exit %+v", e)
	}
	if !strings.Contains(h.rec.output(t, "shl_exit"), "exit 3") {
		t.Fatal("output before the exit was lost")
	}
}

func TestInputSeqOrdering(t *testing.T) {
	h := newHarness(t, nil)
	h.openWait(t, openFrame("shl_seq", testWorkload))
	h.m.ExecInput(h.input(t, "shl_seq", 0, "first\r"))
	h.m.ExecInput(h.input(t, "shl_seq", 0, "replayed\r"))
	h.m.ExecInput(h.input(t, "shl_seq", 1, "second\r"))
	waitFor(t, "second", func() bool { return strings.Contains(h.rec.output(t, "shl_seq"), "second") })
	h.m.ExecInput(h.input(t, "shl_seq", 3, "skipped\r"))
	e := h.rec.waitExit(t, "shl_seq")
	if e.Reason != protocol.ExecExitError || e.Message != MessageOutOfOrder || e.ExitCode != nil {
		t.Fatalf("exit %+v", e)
	}
	out := h.rec.output(t, "shl_seq")
	if strings.Contains(out, "replayed") || strings.Contains(out, "skipped") || strings.Count(out, "first") != 1 {
		t.Fatalf("output %q", out)
	}
}

func TestInputThatCannotBeOpenedEnds(t *testing.T) {
	h := newHarness(t, nil)
	h.openWait(t, openFrame("shl_bad", testWorkload))
	// Sealed for another session: the AAD binds it there.
	in := h.input(t, "shl_other", 0, "SECRET-PASSWORD\r")
	in.SessionID = "shl_bad"
	h.m.ExecInput(in)
	e := h.rec.waitExit(t, "shl_bad")
	if e.Reason != protocol.ExecExitError || !strings.Contains(e.Message, "could not be opened") {
		t.Fatalf("exit %+v", e)
	}
	if strings.Contains(h.rec.output(t, "shl_bad"), "SECRET") {
		t.Fatal("unopenable input reached the process")
	}
}

func TestIdleTimeout(t *testing.T) {
	h := newHarness(t, nil)
	f := openFrame("shl_idle", testWorkload)
	f.IdleTimeoutS = 10 // 100 ms at the test unit
	start := time.Now()
	h.openWait(t, f)
	// Input keeps it open past one idle period.
	for i := range 4 {
		time.Sleep(40 * time.Millisecond)
		h.m.ExecInput(h.input(t, "shl_idle", int64(i), "x"))
	}
	e := h.rec.waitExit(t, "shl_idle")
	if e.Reason != protocol.ExecExitIdleTimeout || e.ExitCode != nil {
		t.Fatalf("exit %+v", e)
	}
	if d := time.Since(start); d < 200*time.Millisecond {
		t.Fatalf("idle timeout after %v despite input", d)
	}
}

func TestMaxDuration(t *testing.T) {
	h := newHarness(t, nil)
	f := openFrame("shl_max", testWorkload)
	f.MaxDurationS = 60 // 600 ms at the test unit
	h.openWait(t, f)
	stop, typed := make(chan struct{}), make(chan struct{})
	inputs := make([]*protocol.ExecInput, 40)
	for i := range inputs {
		inputs[i] = h.input(t, "shl_max", int64(i), "x")
	}
	go func() {
		defer close(typed)
		for _, in := range inputs {
			select {
			case <-stop:
				return
			case <-time.After(20 * time.Millisecond):
			}
			h.m.ExecInput(in)
		}
	}()
	e := h.rec.waitExit(t, "shl_max")
	close(stop)
	<-typed
	if e.Reason != protocol.ExecExitMaxDuration {
		t.Fatalf("exit %+v", e)
	}
}

func TestCloseKillsAfterGrace(t *testing.T) {
	h := newHarness(t, nil)
	h.f.ignoreHup = true
	h.openWait(t, openFrame("shl_kill", testWorkload))
	start := time.Now()
	h.m.CloseExec(&protocol.ExecClose{Type: protocol.TypeExecClose, ControlHeader: header(), SessionID: "shl_kill", Reason: protocol.ExecCloseRevoked})
	e := h.rec.waitExit(t, "shl_kill")
	if e.Reason != protocol.ExecExitClosed {
		t.Fatalf("exit %+v", e)
	}
	if got := h.f.signalsOf(h.f.proc(0)); !slices.Equal(got, []syscall.Signal{syscall.SIGHUP, syscall.SIGKILL}) {
		t.Fatalf("signals %v", got)
	}
	if d := time.Since(start); d < 100*time.Millisecond {
		t.Fatalf("SIGKILL after %v, before the grace", d)
	}
}

func TestRefusals(t *testing.T) {
	for _, tc := range []struct {
		name     string
		workload string
		edit     func(*docker.ContainerInfo)
		opts     func(*Options)
		want     string
	}{
		{name: "unknown workload", workload: "wl_missing", want: "not running on this node"},
		{name: "system workload", workload: runtime.RegistryWorkloadID, want: "system workload"},
		{name: "foreign namespace", workload: testWorkload, edit: func(c *docker.ContainerInfo) {
			c.Config.Labels[runtime.LabelNamespace] = "node_other"
		}, want: "another node"},
		{name: "unlabelled namespace", workload: testWorkload, edit: func(c *docker.ContainerInfo) {
			delete(c.Config.Labels, runtime.LabelNamespace)
		}, want: "another node"},
		{name: "other workload", workload: testWorkload, edit: func(c *docker.ContainerInfo) {
			c.Config.Labels[runtime.LabelWorkloadID] = "wl_other"
		}, want: "not workload"},
		{name: "job container", workload: testWorkload, edit: func(c *docker.ContainerInfo) {
			c.Config.Labels[jobs.LabelJob] = "true"
		}, want: "not a service workload"},
		{name: "job kind", workload: testWorkload, edit: func(c *docker.ContainerInfo) {
			c.Config.Labels[runtime.LabelKind] = string(protocol.WorkloadJob)
		}, want: "not a service workload"},
		{name: "privileged", workload: testWorkload, edit: func(c *docker.ContainerInfo) {
			c.HostConfig.Privileged = true
		}, want: "privileged"},
		{name: "stopped", workload: testWorkload, edit: func(c *docker.ContainerInfo) {
			c.State = docker.ContainerState{Status: "exited"}
		}, want: "not running"},
		{name: "paused", workload: testWorkload, edit: func(c *docker.ContainerInfo) {
			c.State.Status = "paused"
		}, want: "not running"},
		{name: "held", workload: testWorkload, opts: func(o *Options) {
			o.Workloads = heldWorkloads{}
		}, want: "restoring"},
		{name: "no namespace", workload: testWorkload, opts: func(o *Options) {
			o.Namespace = ""
		}, want: "does not run shell sessions"},
		{name: "plaintext connection", workload: testWorkload, opts: func(o *Options) {
			o.Refusal = "refusing over plaintext ws://"
		}, want: "plaintext"},
		{name: "invalid command", workload: testWorkload, opts: nil, want: "invalid command"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, tc.opts)
			if tc.edit != nil {
				h.f.addContainer(testContainer, testWorkload, tc.edit)
			}
			f := openFrame("shl_r", tc.workload)
			if tc.want == "invalid command" {
				f.Command = []string{""}
			}
			h.m.OpenExec(f)
			e := h.rec.waitExit(t, "shl_r")
			if e.Reason != protocol.ExecExitError || e.ExitCode != nil || !strings.Contains(e.Message, tc.want) {
				t.Fatalf("exit %+v, want message with %q", e, tc.want)
			}
			if h.rec.opened("shl_r") != nil || h.f.execs() != 0 {
				t.Fatal("a refused session reached the engine")
			}
		})
	}
}

// heldWorkloads answers as the runtime does while a restore holds the
// workload stopped.
type heldWorkloads struct{}

func (heldWorkloads) ShellContainer(id string) (string, error) {
	return "", &heldError{id}
}

type heldError struct{ id string }

func (e *heldError) Error() string { return "workload " + e.id + " is stopped: restoring a backup" }

func TestSessionLimitAndDuplicates(t *testing.T) {
	h := newHarness(t, nil)
	for i := range protocol.MaxExecSessionsPerNode {
		h.openWait(t, openFrame("shl_"+string(rune('a'+i)), testWorkload))
	}
	h.m.OpenExec(openFrame("shl_fifth", testWorkload))
	if e := h.rec.waitExit(t, "shl_fifth"); e.Reason != protocol.ExecExitError || e.Message != MessageBusy || e.ExitCode != nil {
		t.Fatalf("fifth: %+v", e)
	}
	h.m.OpenExec(openFrame("shl_a", testWorkload))
	waitFor(t, "duplicate refusal", func() bool { return len(h.rec.exits("shl_a")) == 1 })
	if e := h.rec.exits("shl_a")[0]; e.Message != MessageDuplicate {
		t.Fatalf("duplicate: %+v", e)
	}
	if h.f.execs() != protocol.MaxExecSessionsPerNode {
		t.Fatalf("%d execs", h.f.execs())
	}

	// An ended session's ID stays used, and its slot frees.
	h.m.ExecInput(h.input(t, "shl_b", 0, "exit 0\r"))
	waitFor(t, "shl_b exit", func() bool { return len(h.rec.exits("shl_b")) == 1 })
	waitFor(t, "slot freed", func() bool {
		h.m.mu.Lock()
		defer h.m.mu.Unlock()
		return len(h.m.sessions) < protocol.MaxExecSessionsPerNode
	})
	h.m.OpenExec(openFrame("shl_b", testWorkload))
	waitFor(t, "reuse refusal", func() bool { return len(h.rec.exits("shl_b")) == 2 })
	if e := h.rec.exits("shl_b")[1]; e.Message != MessageDuplicate {
		t.Fatalf("reuse: %+v", e)
	}
	h.openWait(t, openFrame("shl_new", testWorkload))
}

func TestDisconnectedEndsEverySession(t *testing.T) {
	h := newHarness(t, nil)
	ids := []string{"shl_x", "shl_y", "shl_z"}
	for _, id := range ids {
		h.openWait(t, openFrame(id, testWorkload))
	}
	h.m.Disconnected()
	for _, id := range ids {
		e := h.rec.waitExit(t, id)
		if e.Reason != protocol.ExecExitError || e.Message != MessageDisconnected {
			t.Fatalf("%s: %+v", id, e)
		}
	}
	h.m.Disconnected()
	time.Sleep(100 * time.Millisecond)
	for _, id := range ids {
		if n := len(h.rec.exits(id)); n != 1 {
			t.Fatalf("%s: %d exec_exit frames", id, n)
		}
	}
	for i := range len(ids) {
		if got := h.f.signalsOf(h.f.proc(i)); len(got) == 0 || got[0] != syscall.SIGHUP {
			t.Fatalf("process %d signals %v", i, got)
		}
	}
}

func TestShutdownEndsEverySession(t *testing.T) {
	h := newHarness(t, nil)
	h.openWait(t, openFrame("shl_s1", testWorkload))
	h.openWait(t, openFrame("shl_s2", testWorkload))
	h.stop()
	<-h.done
	for _, id := range []string{"shl_s1", "shl_s2"} {
		if e := h.rec.exits(id); len(e) != 1 || e[0].Message != MessageShutdown {
			t.Fatalf("%s: %+v", id, e)
		}
	}
	h.m.OpenExec(openFrame("shl_late", testWorkload))
	if e := h.rec.waitExit(t, "shl_late"); e.Message != MessageShutdown {
		t.Fatalf("late: %+v", e)
	}
}

func TestOutputIsCoalescedAndNumbered(t *testing.T) {
	h := newHarness(t, nil)
	banner := bytes.Repeat([]byte("0123456789abcdef"), 100*1024/16) // 100 KiB
	h.f.banner = banner
	h.openWait(t, openFrame("shl_out", testWorkload))
	waitFor(t, "banner", func() bool { return len(h.rec.output(t, "shl_out")) >= len(banner) })
	outs := h.rec.outputs("shl_out")
	if len(outs) < 4 {
		t.Fatalf("%d frames for 100 KiB", len(outs))
	}
	for i, o := range outs {
		raw, _ := base64.StdEncoding.DecodeString(o.Data)
		if o.Seq != int64(i) || len(raw) > protocol.MaxExecOutputBytes {
			t.Fatalf("frame %d: seq %d, %d bytes", i, o.Seq, len(raw))
		}
	}
	if h.rec.output(t, "shl_out") != string(banner) {
		got := h.rec.output(t, "shl_out")
		i := 0
		for i < len(got) && i < len(banner) && got[i] == banner[i] {
			i++
		}
		t.Fatalf("output reassembled differently: %d vs %d bytes, first diff at %d: %q", len(got), len(banner), i, got[i:min(len(got), i+40)])
	}
}

func TestOutputFrameBudget(t *testing.T) {
	rec := newRecorder()
	m := New(Options{Send: rec.Send})
	s := &session{m: m, id: "shl_budget"}
	o := outputFrames{s: s, pending: bytes.Repeat([]byte("x"), 70*protocol.MaxExecOutputBytes)}
	t0 := time.Unix(1000, 0)
	o.flush(t0)
	if n := len(rec.outputs("shl_budget")); n != protocol.MaxExecOutputFramesPerSecond {
		t.Fatalf("%d frames in the first second", n)
	}
	o.flush(t0.Add(999 * time.Millisecond))
	if n := len(rec.outputs("shl_budget")); n != protocol.MaxExecOutputFramesPerSecond {
		t.Fatalf("%d frames before the window passed", n)
	}
	o.flush(t0.Add(time.Second))
	outs := rec.outputs("shl_budget")
	if len(outs) != 70 || len(o.pending) != 0 {
		t.Fatalf("%d frames, %d bytes pending", len(outs), len(o.pending))
	}
	for i, f := range outs {
		if f.Seq != int64(i) {
			t.Fatalf("frame %d seq %d", i, f.Seq)
		}
	}
}

func TestTerminalBytesNeverLogged(t *testing.T) {
	h := newHarness(t, nil)
	h.f.banner = []byte("BANNER-OUTPUT-SECRET")
	h.openWait(t, openFrame("shl_log", testWorkload))
	h.m.ExecInput(h.input(t, "shl_log", 0, "TYPED-PASSWORD\r"))
	waitFor(t, "echo", func() bool { return strings.Contains(h.rec.output(t, "shl_log"), "TYPED-PASSWORD") })
	bad := h.input(t, "shl_zz", 1, "SEALED-ELSEWHERE")
	bad.SessionID = "shl_log"
	h.m.ExecInput(bad)
	h.rec.waitExit(t, "shl_log")
	logs := h.logText()
	if !strings.Contains(logs, "shl_log") {
		t.Fatalf("logs missing the session: %s", logs)
	}
	for _, secret := range []string{"TYPED-PASSWORD", "BANNER-OUTPUT-SECRET", "SEALED-ELSEWHERE"} {
		if strings.Contains(logs, secret) || strings.Contains(logs, base64.StdEncoding.EncodeToString([]byte(secret))) {
			t.Fatalf("logs carry %q: %s", secret, logs)
		}
	}
}

func TestEndSendsOneExitWhenSendFails(t *testing.T) {
	h := newHarness(t, nil)
	h.openWait(t, openFrame("shl_down", testWorkload))
	h.rec.mu.Lock()
	h.rec.fail = true
	h.rec.mu.Unlock()
	h.m.Disconnected()
	waitFor(t, "session removed", func() bool { return h.m.session("shl_down") == nil })
	if n := h.f.execs(); n != 1 {
		t.Fatalf("%d execs", n)
	}
}
