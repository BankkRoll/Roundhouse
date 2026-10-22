package builder

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
)

const testToken = "ghs_unitTestToken_ABCDEFGHIJKLMNOP"

func TestGitCommandKeepsTokenOutOfArgs(t *testing.T) {
	g := &gitSource{git: "git", home: t.TempDir(), url: "https://github.com/acme/app.git", token: testToken}
	sha := strings.Repeat("b", 40)
	for _, args := range [][]string{fetchArgs(g.url, sha), fallbackFetchArgs(g.url, "refs/heads/main"), fallbackFetchArgs(g.url, "")} {
		cmd, _ := g.command(context.Background(), t.TempDir(), args...)
		joined := strings.Join(cmd.Args, " ")
		if strings.Contains(joined, testToken) || strings.Contains(joined, base64.StdEncoding.EncodeToString([]byte(gitTokenUser+":"+testToken))) {
			t.Fatalf("token in argv: %q", cmd.Args)
		}
		if strings.Contains(joined, "@") {
			t.Fatalf("credentials-like URL in argv: %q", cmd.Args)
		}
	}

	env := g.env()
	header := "Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(gitTokenUser+":"+testToken))
	if !hasEnvPair(env, "http.https://github.com/.extraHeader", header) {
		t.Fatalf("scoped auth header missing from GIT_CONFIG_* env: %q", env)
	}
	if !hasEnvPair(env, "http.followRedirects", "false") {
		t.Error("redirects must be refused when a token is sent")
	}
	if !hasEnvPair(env, "credential.helper", "") {
		t.Error("credential helpers must be disabled")
	}
	for _, want := range []string{"GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1", "GIT_ALLOW_PROTOCOL=https", "LC_ALL=C"} {
		if !slices.Contains(env, want) {
			t.Errorf("env missing %s", want)
		}
	}
}

func TestGitEnvWithoutToken(t *testing.T) {
	t.Setenv("GIT_DIR", "/tmp/evil")
	t.Setenv("GIT_TRACE", "1")
	g := &gitSource{git: "git", home: t.TempDir(), url: "https://github.com/acme/app.git"}
	for _, kv := range g.env() {
		if strings.Contains(kv, "extraHeader") || strings.HasPrefix(kv, "GIT_DIR=") || strings.HasPrefix(kv, "GIT_TRACE=") {
			t.Errorf("unexpected env %q", kv)
		}
	}
	if !slices.Contains(g.env(), "GIT_ALLOW_PROTOCOL=https") {
		t.Error("http must not be allowed")
	}
	g.allowHTTP = true
	if !slices.Contains(g.env(), "GIT_ALLOW_PROTOCOL=https:http") {
		t.Error("loopback test mode must allow http")
	}
}

// hasEnvPair reports whether env sets git config key to value through
// GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n.
func hasEnvPair(env []string, key, value string) bool {
	for _, kv := range env {
		k, ok := strings.CutPrefix(kv, "GIT_CONFIG_KEY_")
		if !ok {
			continue
		}
		n, name, _ := strings.Cut(k, "=")
		if name == key && slices.Contains(env, "GIT_CONFIG_VALUE_"+n+"="+value) {
			return true
		}
	}
	return false
}

func TestClassifyGitError(t *testing.T) {
	url := "https://github.com/acme/app.git"
	cases := map[string]string{
		"fatal: Authentication failed for 'https://github.com/acme/app.git/'":                       "no access",
		"remote: Repository not found.\nfatal: repository 'x' not found":                            "no access",
		"fatal: could not read Username for 'https://github.com': terminal prompts disabled":        "no access",
		"fatal: unable to access 'x': Could not resolve host: github.invalid":                       "does not resolve",
		"fatal: unable to access 'x': Failed to connect to github.com port 443: Connection refused": "could not connect",
		"fatal: unable to access 'x': SSL certificate problem: self-signed certificate":             "TLS certificate",
		"fatal: remote error: upload-pack: not our ref " + strings.Repeat("a", 40):                  "",
		"fatal: couldn't find remote ref deadbeef":                                                  "",
	}
	for stderr, want := range cases {
		err := classifyGitError(url, strings.Repeat("a", 40), stderr)
		if want == "" {
			if err != nil {
				t.Errorf("%q: got %v, want fallback", stderr, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: got %v, want %q", stderr, err, want)
		}
	}
}

// -----------------------------------------------------------------------------
// Real git over smart HTTP
// -----------------------------------------------------------------------------

type unitGitServer struct {
	root string
	url  string

	mu      sync.Mutex
	headers []string
}

func newUnitGitServer(t *testing.T, requireToken bool) *unitGitServer {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	execPath, err := exec.Command("git", "--exec-path").Output()
	if err != nil {
		t.Skip("git --exec-path failed")
	}
	backendPath := filepath.Join(strings.TrimSpace(string(execPath)), "git-http-backend")
	if runtime.GOOS == "windows" {
		backendPath += ".exe"
	}
	if _, err := os.Stat(backendPath); err != nil {
		t.Skip("git-http-backend not available")
	}
	s := &unitGitServer{root: t.TempDir()}
	backend := &cgi.Handler{Path: backendPath, Env: []string{"GIT_PROJECT_ROOT=" + s.root, "GIT_HTTP_EXPORT_ALL=1"}}
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte(gitTokenUser+":"+testToken))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.headers = append(s.headers, r.Header.Get("Authorization"))
		s.mu.Unlock()
		if requireToken && r.Header.Get("Authorization") != want {
			w.Header().Set("WWW-Authenticate", `Basic realm="git"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		backend.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	s.url = srv.URL
	return s
}

// commit creates repo name with two commits and returns both SHAs.
func (s *unitGitServer) commit(t *testing.T, name string) (first, second string) {
	t.Helper()
	work := t.TempDir()
	git := func(args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = work
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git("init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(work, "v.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", "-A")
	git("commit", "-q", "-m", "one")
	first = git("rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(work, "v.txt"), []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("commit", "-q", "-am", "two")
	second = git("rev-parse", "HEAD")
	cmd := exec.Command("git", "clone", "-q", "--bare", work, filepath.Join(s.root, name+".git"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("clone --bare: %v\n%s", err, out)
	}
	return first, second
}

func TestGitFetchExactCommitWithToken(t *testing.T) {
	s := newUnitGitServer(t, true)
	first, _ := s.commit(t, "app")
	dir := filepath.Join(t.TempDir(), "src")
	var stderr strings.Builder
	g := &gitSource{git: "git", home: t.TempDir(), url: s.url + "/app.git", token: testToken, allowHTTP: true, stderr: &stderr}

	// An older commit, not a branch tip: the fetch must land on exactly it.
	if err := g.fetch(context.Background(), dir, first, "refs/heads/main"); err != nil {
		t.Fatalf("fetch: %v\n%s", err, stderr.String())
	}
	b, err := os.ReadFile(filepath.Join(dir, "v.txt"))
	if err != nil || string(b) != "one\n" {
		t.Fatalf("checked out content %q, %v", b, err)
	}
	if shallow, _ := os.ReadFile(filepath.Join(dir, ".git", "shallow")); !strings.Contains(string(shallow), first) {
		t.Errorf("fetch was not shallow")
	}
	cfg, err := os.ReadFile(filepath.Join(dir, ".git", "config"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(cfg), testToken) || strings.Contains(strings.ToLower(string(cfg)), "extraheader") {
		t.Errorf(".git/config holds credentials:\n%s", cfg)
	}
	if strings.Contains(stderr.String(), testToken) {
		t.Error("git output contains the token")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.headers) == 0 || s.headers[len(s.headers)-1] == "" {
		t.Error("server never received the Authorization header")
	}
}

func TestGitFetchWithoutAccess(t *testing.T) {
	s := newUnitGitServer(t, true)
	first, _ := s.commit(t, "private")
	g := &gitSource{git: "git", home: t.TempDir(), url: s.url + "/private.git", allowHTTP: true}
	err := g.fetch(context.Background(), filepath.Join(t.TempDir(), "src"), first, "")
	var ue *userError
	if !errors.As(err, &ue) || !strings.Contains(err.Error(), "no access") {
		t.Fatalf("err = %v", err)
	}
}

func TestGitFetchUnknownCommit(t *testing.T) {
	s := newUnitGitServer(t, false)
	s.commit(t, "app")
	g := &gitSource{git: "git", home: t.TempDir(), url: s.url + "/app.git", allowHTTP: true}
	missing := strings.Repeat("c", 40)
	err := g.fetch(context.Background(), filepath.Join(t.TempDir(), "src"), missing, "")
	if err == nil || !strings.Contains(err.Error(), "was not found") {
		t.Fatalf("err = %v", err)
	}
}

func TestGitFetchCancelled(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs a shell script as git")
	}
	fake := filepath.Join(t.TempDir(), "git")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nexec sleep 60\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	g := &gitSource{git: fake, home: t.TempDir(), url: "https://example.com/x.git"}
	cause := errors.New("stop")
	ctx, cancel := context.WithCancelCause(context.Background())
	time.AfterFunc(200*time.Millisecond, func() { cancel(cause) })
	start := time.Now()
	err := g.fetch(ctx, filepath.Join(t.TempDir(), "src"), strings.Repeat("a", 40), "")
	if !errors.Is(err, cause) {
		t.Fatalf("err = %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("git was not killed promptly (%s)", time.Since(start))
	}
}

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

// symlinkOrSkip creates a symlink, skipping the test where the OS refuses
// (Windows without developer mode).
func symlinkOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestResolvePaths(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "Dockerfile"), "FROM scratch\n")
	writeFile(t, filepath.Join(root, "apps", "web", "Dockerfile.prod"), "FROM scratch\n")
	writeFile(t, filepath.Join(root, "apps", "web", "docker", "Dockerfile"), "FROM scratch\n")
	if err := os.MkdirAll(filepath.Join(root, "dir-not-file"), 0o755); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name, ctx, dockerfile string
		builder               protocol.Builder
		wantErr               string
		wantName              string
	}{
		{"root default", ".", "", protocol.BuilderDockerfile, "", "Dockerfile"},
		{"nested", "apps/web", "Dockerfile.prod", protocol.BuilderDockerfile, "", "Dockerfile.prod"},
		{"nested subdir", "apps/web", "docker/Dockerfile", protocol.BuilderDockerfile, "", "Dockerfile"},
		{"missing dockerfile", "apps/web", "", protocol.BuilderDockerfile, `Dockerfile not found at "apps/web/Dockerfile"`, ""},
		{"missing context", "nope", "", protocol.BuilderDockerfile, "does not exist at this commit", ""},
		{"context is a file", "Dockerfile", "", protocol.BuilderRailpack, "is not a directory", ""},
		{"dockerfile is a dir", ".", "dir-not-file", protocol.BuilderDockerfile, "is not a file", ""},
		{"railpack root", ".", "", protocol.BuilderRailpack, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			job := validJob()
			job.Builder, job.ContextDir, job.DockerfilePath = tc.builder, tc.ctx, tc.dockerfile
			p, err := resolvePaths(root, &job)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if p.dockerfileName != tc.wantName {
				t.Errorf("dockerfile name = %q", p.dockerfileName)
			}
		})
	}
}

func TestResolvePathsRejectsSymlinkEscapes(t *testing.T) {
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "Dockerfile"), "FROM scratch\n")
	root := t.TempDir()
	symlinkOrSkip(t, outside, filepath.Join(root, "ctx"))
	symlinkOrSkip(t, filepath.Join(outside, "Dockerfile"), filepath.Join(root, "app", "Dockerfile"))
	symlinkOrSkip(t, "../..", filepath.Join(root, "app", "up"))

	cases := []struct{ ctx, dockerfile, want string }{
		{"ctx", "", "resolves outside the repository"},
		{"app", "", "resolves outside the repository"},
		{"app/up", "", "resolves outside the repository"},
		{".", "ctx/Dockerfile", "resolves outside the repository"},
	}
	for _, tc := range cases {
		job := validJob()
		job.ContextDir, job.DockerfilePath = tc.ctx, tc.dockerfile
		if _, err := resolvePaths(root, &job); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("ctx=%q dockerfile=%q: err = %v", tc.ctx, tc.dockerfile, err)
		}
	}
}

func TestRemoveEscapingSymlinks(t *testing.T) {
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "secret"), "host secret\n")
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "real", "file"), "ok\n")
	writeFile(t, filepath.Join(root, ".git", "HEAD"), "ref\n")

	symlinkOrSkip(t, filepath.Join(outside, "secret"), filepath.Join(root, "abs"))
	symlinkOrSkip(t, "../"+filepath.Base(outside), filepath.Join(root, "rel-out"))
	symlinkOrSkip(t, "real/file", filepath.Join(root, "inside"))
	symlinkOrSkip(t, "../real", filepath.Join(root, "d", "inside-dir"))
	symlinkOrSkip(t, "missing", filepath.Join(root, "dangling"))
	// d/parent resolves to the root; d/trick then climbs one above it,
	// although it looks inside when read lexically.
	symlinkOrSkip(t, "..", filepath.Join(root, "d", "parent"))
	symlinkOrSkip(t, "parent/..", filepath.Join(root, "d", "trick"))
	// Becomes dangling once abs is removed.
	symlinkOrSkip(t, "../abs", filepath.Join(root, "d", "via-abs"))
	symlinkOrSkip(t, filepath.Join(outside, "secret"), filepath.Join(root, ".git", "ignored"))

	removed, err := removeEscapingSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(removed)
	want := []string{"abs", "d/trick", "d/via-abs", "dangling", "rel-out"}
	if !slices.Equal(removed, want) {
		t.Fatalf("removed %q, want %q", removed, want)
	}
	for _, kept := range []string{"inside", "d/inside-dir", "d/parent"} {
		if _, err := os.Lstat(filepath.Join(root, kept)); err != nil {
			t.Errorf("%s was removed: %v", kept, err)
		}
	}
}

func TestWithin(t *testing.T) {
	root := filepath.FromSlash("/data/builds/x/src")
	for path, want := range map[string]bool{
		root:                                   true,
		filepath.Join(root, "a"):               true,
		filepath.Join(root, "..", "src2"):      false,
		filepath.FromSlash("/data/builds/x"):   false,
		filepath.Join(root, "..a"):             true,
		filepath.FromSlash("/data/builds/x/s"): false,
	} {
		if got := within(root, path); got != want {
			t.Errorf("within(%q, %q) = %v", root, path, got)
		}
	}
}

func TestTailBuffer(t *testing.T) {
	tb := &tailBuffer{max: 5}
	_, _ = tb.Write([]byte("abc"))
	_, _ = tb.Write([]byte("defgh"))
	if tb.String() != "defgh" {
		t.Fatalf("tail = %q", tb.String())
	}
}
