package cli

import (
	"context"
	"io"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// fakeTerminal is a terminal of a fixed size that resizes to resizeTo once
// WatchResize is called, when resizeTo is set.
type fakeTerminal struct {
	mu         sync.Mutex
	cols, rows int
	resizeTo   [2]int
	raw        bool
	restored   int
}

func (t *fakeTerminal) IsTerminal() bool { return true }

func (t *fakeTerminal) Size() (int, int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.cols, t.rows, nil
}

func (t *fakeTerminal) MakeRaw() (func(), error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.raw = true
	var once sync.Once
	return func() {
		once.Do(func() {
			t.mu.Lock()
			t.restored++
			t.mu.Unlock()
		})
	}, nil
}

func (t *fakeTerminal) WatchResize(context.Context) <-chan struct{} {
	ch := make(chan struct{}, 1)
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.resizeTo != [2]int{} {
		t.cols, t.rows = t.resizeTo[0], t.resizeTo[1]
		ch <- struct{}{}
	}
	return ch
}

// blockingStdin is stdin that never ends while the test runs.
func blockingStdin(t *testing.T) io.Reader {
	r, w := io.Pipe()
	t.Cleanup(func() { _ = w.Close() })
	return r
}

func onlySession(t *testing.T, f *apitest.Fake) *apitest.ShellSession {
	t.Helper()
	s := f.ShellSessions()
	if len(s) != 1 {
		t.Fatalf("%d shell sessions, want 1", len(s))
	}
	return s[0]
}

func TestShellPassesArgvVerbatim(t *testing.T) {
	h := newHarness(t)
	h.link()
	argv := []string{"sh", "-c", `echo "a b" 'c'; exit 0`, "x y", "--", "-n", "", "ünï"}
	r := h.ok("", append([]string{"shell", "--"}, argv...)...)
	s := onlySession(t, h.fake)
	if got := s.Query["cmd"]; !slices.Equal(got, argv) {
		t.Errorf("cmd = %q, want %q", got, argv)
	}
	contains(t, r.stdout, `argv ["sh","-c","echo \"a b\" 'c'; exit 0","x y","--","-n","","ünï"]`)
	if s.Query.Has("cols") || s.Query.Has("rows") {
		t.Errorf("non-terminal session sent a size: %v", s.Query)
	}
	if s.Header.Get("Origin") != h.fake.URL {
		t.Errorf("Origin = %q, want the control plane's", s.Header.Get("Origin"))
	}
	notContains(t, r.stderr, "Connected to")
}

func TestShellPipesStdinAndExitCode(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.HandleShells(func(s *apitest.ShellSession) {
		s.ExitCode = 3
		s.Serve()
	})
	r := h.expect(3, "echo hi\nexit 3\n", "shell")
	if r.stdout != "echo hi\nexit 3\n" {
		t.Errorf("stdout = %q", r.stdout)
	}
	if r.stderr != "" {
		t.Errorf("stderr = %q, want nothing", r.stderr)
	}
	s := onlySession(t, h.fake)
	if got := string(s.Input()); got != "echo hi\nexit 3\n\x04" {
		t.Errorf("input = %q, want the piped bytes then Ctrl-D", got)
	}
	if s.Query.Has("cmd") {
		t.Errorf("cmd sent without a command: %v", s.Query)
	}
}

func TestShellCoalescesInputFrames(t *testing.T) {
	h := newHarness(t)
	h.link()
	var mu sync.Mutex
	var frames []int
	h.fake.HandleShells(func(s *apitest.ShellSession) {
		s.Opened()
		for {
			in, _, ok := s.Next()
			if !ok {
				return
			}
			mu.Lock()
			frames = append(frames, len(in))
			mu.Unlock()
			if slices.Contains(in, 0x04) {
				code := 0
				s.Exit(&code, "exited")
				return
			}
		}
	})
	h.ok(strings.Repeat("x", 40000), "shell", "--", "cat")
	mu.Lock()
	defer mu.Unlock()
	total := 0
	for _, n := range frames {
		if n > api.MaxShellInputFrame {
			t.Errorf("frame of %d bytes, over %d", n, api.MaxShellInputFrame)
		}
		total += n
	}
	if total != 40001 {
		t.Errorf("sent %d bytes, want 40001", total)
	}
}

func TestShellAPITokenSendsNoOrigin(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.env[EnvToken] = h.fake.AddToken("ci", "projects:read", "services:read", "shell:open")
	h.ok("", "shell", "--", "true")
	s := onlySession(t, h.fake)
	if s.Header.Get("Origin") != "" {
		t.Errorf("Origin = %q with a bearer token", s.Header.Get("Origin"))
	}
	if !strings.HasPrefix(s.Header.Get("Authorization"), "Bearer tok_") {
		t.Errorf("Authorization = %q", s.Header.Get("Authorization"))
	}

	h.env[EnvToken] = h.fake.AddToken("readonly", "projects:read", "services:read")
	r := h.expect(exitcode.Forbidden, "", "shell")
	contains(t, r.stderr, "4403")
	contains(t, r.stderr, "the API token needs the shell:open scope")
}

func TestShellCloseCodes(t *testing.T) {
	for _, tc := range []struct {
		code int
		exit int
		hint string
	}{
		{4401, exitcode.Unauthenticated, "run `roundhouse login`"},
		{4403, exitcode.Forbidden, "shell:open permission"},
		{4404, exitcode.NotFound, "run the command again"},
		{4409, exitcode.Conflict, "edge-1 runs its maximum number of shell sessions"},
		{4426, exitcode.Unavailable, "upgrade the agent on edge-1"},
		{4428, exitcode.Unauthenticated, "a shell needs a sign-in within 10 minutes"},
		{4430, exitcode.Forbidden, "turn on two-factor authentication"},
		{4431, exitcode.Forbidden, "unset ROUNDHOUSE_TOKEN"},
		{4503, exitcode.Network, "the agent on edge-1 is not connected"},
		{1008, exitcode.Error, "protocol error"},
	} {
		h := newHarness(t)
		h.link()
		h.fake.RefuseShells(tc.code)
		r := h.expect(tc.exit, "", "shell")
		contains(t, r.stderr, tc.hint)
		if r.stdout != "" {
			t.Errorf("%d: stdout = %q", tc.code, r.stdout)
		}
	}
}

func TestShellGate(t *testing.T) {
	for _, tc := range []struct {
		reason string
		exit   int
		hint   string
	}{
		{api.ShellDenialReauthRequired, exitcode.Unauthenticated, "run `roundhouse login` again (a shell needs a sign-in within 10 minutes), then retry"},
		{api.ShellDenialProtectedEnvironment, exitcode.Forbidden, "API tokens can't open shells in protected environments; unset ROUNDHOUSE_TOKEN and sign in with `roundhouse login`"},
		{api.ShellDenialTwoFactorRequired, exitcode.Forbidden, "turn on two-factor authentication in the dashboard"},
		{api.ShellDenialForbidden, exitcode.Forbidden, "shell:open permission"},
		{api.ShellDenialOAuthToken, exitcode.Forbidden, "OAuth tokens can't open shells"},
	} {
		h := newHarness(t)
		h.link()
		reason := tc.reason
		h.fake.SetShellTargets(apitest.APIServiceID, apitest.ProductionID, api.ShellTargets{
			Targets: []api.ShellTarget{{WorkloadID: apitest.ShellWorkloadID, Replica: 0, NodeID: apitest.NodeID, State: "healthy", ShellSupported: true}},
			Gate:    api.ShellGate{Allowed: false, Reason: &reason},
		})
		r := h.expect(tc.exit, "", "shell")
		contains(t, r.stderr, tc.hint)
		if n := len(h.fake.ShellSessions()); n != 0 {
			t.Errorf("%s: %d sessions opened despite the gate", tc.reason, n)
		}
	}
}

func TestShellReplicaSelection(t *testing.T) {
	h := newHarness(t)
	h.link()
	set := func(targets ...api.ShellTarget) {
		h.fake.SetShellTargets(apitest.APIServiceID, apitest.ProductionID, api.ShellTargets{Targets: targets, Gate: api.ShellGate{Allowed: true}})
	}
	target := func(wl string, replica int, state string, supported bool) api.ShellTarget {
		return api.ShellTarget{WorkloadID: wl, DeploymentID: apitest.ActiveDeploy, Replica: replica, NodeID: apitest.NodeID, NodeName: "edge-1", State: state, ShellSupported: supported}
	}

	set(target("wl_9", 2, "healthy", true), target("wl_0", 0, "starting", true), target(apitest.ShellWorkloadID, 1, "running", true))
	h.ok("", "shell", "--", "true")

	r := h.expect(exitcode.Conflict, "", "shell", "--replica", "0")
	contains(t, r.stderr, "replica 0 of API is starting, not running")
	r = h.expect(exitcode.NotFound, "", "shell", "--replica", "5")
	contains(t, r.stderr, "API has no replica 5 in production; its replicas are 0, 1, 2")
	h.expect(exitcode.Usage, "", "shell", "--replica", "-1")

	set(target("wl_0", 0, "healthy", false))
	r = h.expect(exitcode.Unavailable, "", "shell")
	contains(t, r.stderr, "the agent on edge-1 is too old for shells")
	contains(t, r.stderr, "upgrade the agent")

	set(target("wl_0", 0, "crashed", true))
	r = h.expect(exitcode.Conflict, "", "shell")
	contains(t, r.stderr, "API has no running replica in production")

	set()
	r = h.expect(exitcode.NotFound, "", "shell")
	contains(t, r.stderr, "API has no replicas in production; deploy it first")
}

func TestShellServiceArgument(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.ok("", "shell", "api", "--", "true")
	r := h.expect(exitcode.Usage, "", "shell", "api", "ls", "/app")
	contains(t, r.stderr, "put the command after --, e.g. `roundhouse shell api -- ls /app`")
	h.expect(exitcode.Usage, "", "shell", "api", "--service", "db")
	h.expect(exitcode.NotFound, "", "shell", "nope")
}

func TestShellTerminalSizeAndResize(t *testing.T) {
	h := newHarness(t)
	h.link()
	term := &fakeTerminal{cols: 80, rows: 24, resizeTo: [2]int{120, 50}}
	h.terminal = term
	h.stdin = blockingStdin(t)
	h.fake.HandleShells(func(s *apitest.ShellSession) {
		s.Opened()
		for {
			_, control, ok := s.Next()
			if !ok {
				return
			}
			if control["type"] == "resize" {
				s.Output([]byte("resized\r\n"))
				code := 0
				s.Exit(&code, "exited")
				return
			}
		}
	})
	r := h.ok("", "shell")
	s := onlySession(t, h.fake)
	if s.Query.Get("cols") != "80" || s.Query.Get("rows") != "24" {
		t.Errorf("size at connect = %sx%s, want 80x24", s.Query.Get("cols"), s.Query.Get("rows"))
	}
	if s.Query.Get("term") != defaultShellTerm {
		t.Errorf("term = %q, want %q", s.Query.Get("term"), defaultShellTerm)
	}
	if got := s.Resizes(); !slices.Equal(got, []apitest.ShellResize{{Cols: 120, Rows: 50}}) {
		t.Errorf("resizes = %v", got)
	}
	if r.stdout != "resized\r\n" {
		t.Errorf("stdout = %q", r.stdout)
	}
	if r.stderr != "Connected to API replica 0 on edge-1 as root. Exit the shell or press Ctrl-] then q to disconnect.\n" {
		t.Errorf("stderr = %q", r.stderr)
	}
	if !term.raw || term.restored != 1 {
		t.Errorf("raw = %v, restored %d times; want raw mode restored once", term.raw, term.restored)
	}
}

func TestShellTermFromEnvironment(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.env["TERM"] = "screen-256color"
	h.ok("", "shell", "--", "true")
	if got := onlySession(t, h.fake).Query.Get("term"); got != "screen-256color" {
		t.Errorf("term = %q", got)
	}
}

func TestShellEscapeDisconnects(t *testing.T) {
	h := newHarness(t)
	h.link()
	term := &fakeTerminal{cols: 80, rows: 24}
	h.terminal = term
	r := h.ok("ls\r\x1d\x1dz\x1dxq\x1dq", "shell")
	s := onlySession(t, h.fake)
	if got := string(s.Input()); got != "ls\r\x1dz\x1dxq" {
		t.Errorf("input = %q", got)
	}
	if !s.CloseRequested() {
		t.Error("no close message after Ctrl-] q")
	}
	contains(t, r.stderr, "Disconnected.")
	if term.restored != 1 {
		t.Errorf("terminal restored %d times", term.restored)
	}
}

func TestShellEscapeLeavesHungSession(t *testing.T) {
	if testing.Short() {
		t.Skip("waits for the detach grace period")
	}
	h := newHarness(t)
	h.link()
	h.terminal = &fakeTerminal{cols: 80, rows: 24}
	h.fake.HandleShells(func(s *apitest.ShellSession) {
		s.Opened()
		for {
			if _, _, ok := s.Next(); !ok {
				return
			}
		}
	})
	r := h.ok("\x1dq", "shell")
	contains(t, r.stderr, "Disconnected.")
}

func TestShellExitReasons(t *testing.T) {
	for _, tc := range []struct {
		reason string
		exit   int
		msg    string
	}{
		{"idle_timeout", exitcode.Error, "idle too long"},
		{"max_duration", exitcode.Error, "maximum duration"},
		{"revoked", exitcode.Forbidden, "your access changed"},
		{"node_disconnected", exitcode.Network, "agent disconnected"},
		{"closed", exitcode.OK, ""},
	} {
		h := newHarness(t)
		h.link()
		h.stdin = blockingStdin(t)
		h.fake.HandleShells(func(s *apitest.ShellSession) {
			s.Opened()
			s.Output([]byte("bye\n"))
			s.Exit(nil, tc.reason)
		})
		r := h.expect(tc.exit, "", "shell")
		if r.stdout != "bye\n" {
			t.Errorf("%s: stdout = %q", tc.reason, r.stdout)
		}
		if tc.msg != "" {
			contains(t, r.stderr, tc.msg)
		}
	}
}

func TestEscapeFilterAcrossReads(t *testing.T) {
	var e escapeFilter
	out, detach := e.filter([]byte("a\x1d"))
	if string(out) != "a" || detach {
		t.Fatalf("first read = %q, %v", out, detach)
	}
	out, detach = e.filter([]byte("q"))
	if len(out) != 0 || !detach {
		t.Fatalf("second read = %q, %v; want detach", out, detach)
	}
}

func TestShellDebugRedactsCommandAndBytes(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("typed-secret\n", "shell", "--debug", "--", "psql", "postgres://app:pw-hunter2@db/shop")
	contains(t, r.stderr, "/v1/workloads/wl_0001/shell")
	contains(t, r.stderr, "cmd=%5BREDACTED%5D")
	notContains(t, r.stderr, "hunter2")
	notContains(t, r.stderr, "typed-secret")
	contains(t, r.stdout, "typed-secret")
}

func TestShellChecksCommandLocally(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.expect(exitcode.Usage, "", "shell", "--", "")
	contains(t, r.stderr, "must not start with an empty argument")
	many := make([]string, 33)
	for i := range many {
		many[i] = "a"
	}
	r = h.expect(exitcode.Usage, "", append([]string{"shell", "--"}, many...)...)
	contains(t, r.stderr, "at most 32 are allowed")
	r = h.expect(exitcode.Usage, "", "shell", "--", "echo", strings.Repeat("x", 4096))
	contains(t, r.stderr, "at most 4096 are allowed")
	if n := len(h.fake.ShellSessions()); n != 0 {
		t.Errorf("%d sessions opened", n)
	}

	h.env["TERM"] = "xterm 256color"
	h.ok("", "shell", "--", "true")
	if q := onlySession(t, h.fake).Query; q.Has("term") {
		t.Errorf("invalid TERM sent: %q", q.Get("term"))
	}
}

func TestClampSize(t *testing.T) {
	if c, r := clampSize(5000, 0); c != 1000 || r != 1 {
		t.Errorf("clampSize = %dx%d", c, r)
	}
}

func TestShellSaysWhenRecorded(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.HandleShells(func(s *apitest.ShellSession) {
		s.Recorded = true
		s.Serve()
	})
	r := h.ok("exit\n", "shell")
	if r.stderr != "This session is recorded.\n" {
		t.Errorf("piped stderr = %q", r.stderr)
	}
	if r.stdout != "exit\n" {
		t.Errorf("stdout = %q", r.stdout)
	}

	h.terminal = &fakeTerminal{cols: 80, rows: 24}
	h.stdin = strings.NewReader("\x04")
	r = h.ok("", "shell")
	want := "Connected to API replica 0 on edge-1 as root. Exit the shell or press Ctrl-] then q to disconnect.\nThis session is recorded.\n"
	if !strings.HasPrefix(r.stderr, want) {
		t.Errorf("terminal stderr = %q, want it to start with %q", r.stderr, want)
	}
}
