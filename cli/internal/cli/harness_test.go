package cli

import (
	"bytes"
	"context"
	"flag"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Open-Rail/cli/internal/apitest"
	"github.com/BankkRoll/Open-Rail/cli/internal/ui"
)

var update = flag.Bool("update", false, "rewrite golden files in testdata/golden")

// harness runs CLI invocations against a fake control plane, with an
// isolated config directory and working directory.
type harness struct {
	t         *testing.T
	fake      *apitest.Fake
	env       map[string]string
	dir       string
	configDir string
	// transport, when set, carries every HTTP request.
	transport http.RoundTripper

	mu       sync.Mutex
	opened   []string
	execArgv []string
	execEnv  []string
	execCode int
}

type result struct {
	stdout string
	stderr string
	code   int
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{t: t, fake: apitest.New(t), dir: t.TempDir(), configDir: t.TempDir()}
	h.env = map[string]string{EnvConfigDir: h.configDir}
	return h
}

func (h *harness) envFor(stdin string, stdout, stderr *bytes.Buffer, interactive bool) Env {
	io := ui.Test(stdin, stdout, stderr)
	if interactive {
		io.ForceInteractive()
	}
	return Env{
		IO:           io,
		Getenv:       func(k string) string { return h.env[k] },
		Environ:      func() []string { return []string{"PATH=/usr/bin", "HOME=/home/ada"} },
		WorkDir:      h.dir,
		Version:      "1.2.3",
		Commit:       "abc1234",
		Now:          func() time.Time { return time.UnixMilli(apitest.Now) },
		PollInterval: time.Millisecond,
		Transport:    h.transport,
		OpenURL: func(u string) error {
			h.mu.Lock()
			h.opened = append(h.opened, u)
			h.mu.Unlock()
			return nil
		},
		Exec: func(_ context.Context, argv, env []string, io *ui.IO) (int, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.execArgv, h.execEnv = argv, env
			return h.execCode, nil
		},
	}
}

func (h *harness) exec(ctx context.Context, stdin string, interactive bool, args ...string) result {
	h.t.Helper()
	var stdout, stderr bytes.Buffer
	code := Run(ctx, args, h.envFor(stdin, &stdout, &stderr, interactive))
	return result{stdout: stdout.String(), stderr: stderr.String(), code: code}
}

// run executes the CLI non-interactively, as in a script.
func (h *harness) run(stdin string, args ...string) result {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return h.exec(ctx, stdin, false, args...)
}

// interactive executes the CLI as if on a terminal, answering prompts from stdin.
func (h *harness) interactive(stdin string, args ...string) result {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return h.exec(ctx, stdin, true, args...)
}

// ok runs the CLI and fails the test unless it exits 0.
func (h *harness) ok(stdin string, args ...string) result {
	h.t.Helper()
	r := h.run(stdin, args...)
	if r.code != 0 {
		h.t.Fatalf("roundhouse %s: exit %d\nstdout:\n%s\nstderr:\n%s", strings.Join(args, " "), r.code, r.stdout, r.stderr)
	}
	return r
}

// expect runs the CLI and fails the test unless it exits with code.
func (h *harness) expect(code int, stdin string, args ...string) result {
	h.t.Helper()
	r := h.run(stdin, args...)
	if r.code != code {
		h.t.Fatalf("roundhouse %s: exit %d, want %d\nstdout:\n%s\nstderr:\n%s", strings.Join(args, " "), r.code, code, r.stdout, r.stderr)
	}
	return r
}

// login signs in through the CLI.
func (h *harness) login() {
	h.t.Helper()
	h.ok(apitest.Password+"\n", "login", "--url", h.fake.URL, "--insecure", "--email", apitest.Email, "--password-stdin")
}

// link signs in and links the work dir to the seeded project and API service.
func (h *harness) link() {
	h.t.Helper()
	h.login()
	h.ok("", "link", "--project", "shop", "--service", "api", "--gitignore=false")
}

// normalize replaces run-specific values so output can be compared to golden files.
func (h *harness) normalize(s string) string {
	s = strings.ReplaceAll(s, h.fake.URL, "{{URL}}")
	for _, dir := range []string{h.dir, h.configDir} {
		s = strings.ReplaceAll(s, strings.ReplaceAll(dir, `\`, `\\`), "{{DIR}}")
		s = strings.ReplaceAll(s, dir, "{{DIR}}")
	}
	s = strings.ReplaceAll(s, `{{DIR}}\\`, "{{DIR}}/")
	return strings.ReplaceAll(s, `.roundhouse\\config.json`, ".roundhouse/config.json")
}

// golden compares got with testdata/golden/name, or rewrites it with -update.
func (h *harness) golden(name, got string) {
	h.t.Helper()
	got = h.normalize(got)
	path := filepath.Join("testdata", "golden", name)
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			h.t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			h.t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		h.t.Fatalf("read golden file (run go test -update to create it): %v", err)
	}
	if got != strings.ReplaceAll(string(want), "\r\n", "\n") {
		h.t.Errorf("%s differs from golden file (go test -update to accept)\n--- got ---\n%s\n--- want ---\n%s", name, got, want)
	}
}

func contains(t *testing.T, haystack, needle string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Errorf("output does not contain %q:\n%s", needle, haystack)
	}
}

func notContains(t *testing.T, haystack, needle string) {
	t.Helper()
	if strings.Contains(haystack, needle) {
		t.Errorf("output contains %q:\n%s", needle, haystack)
	}
}
