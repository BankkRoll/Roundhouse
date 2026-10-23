//go:build integration

// Integration tests against a real Docker Engine. They start a registry and
// sys_buildkitd, serve repositories from a local git smart-HTTP server, and
// build real images. Run them with testdata/integration.sh, which runs this
// package inside a Linux container on the host network with the Docker
// socket mounted; see agent/README.md.

package builder

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

const (
	itRegistryImage = "registry:3.1.2@sha256:01cd312e67026f06f5d89c3e133a4a9adc7cb9eeb9b1194e0b2954dfd770efd2"
	itRegistryName  = "roundhouse-it-registry"
	itRegistryAddr  = "127.0.0.1:5055"
	itProxyPort     = 5056
	itToken         = "ghs_integrationTestToken0123456789abcdef"
)

var (
	itDocker *dockerAPI
	itLog    = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
)

func TestMain(m *testing.M) {
	d, err := newDockerAPI("")
	if err != nil {
		fmt.Fprintln(os.Stderr, "docker:", err)
		os.Exit(1)
	}
	itDocker = d
	ctx := context.Background()
	if err := startRegistry(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "registry:", err)
		os.Exit(1)
	}
	code := m.Run()
	if os.Getenv("ROUNDHOUSE_IT_KEEP") != "1" {
		_ = d.removeContainer(ctx, itRegistryName)
		_ = d.removeContainer(ctx, ContainerName)
		_ = d.do(ctx, http.MethodDelete, "/networks/"+NetworkName, nil, nil, nil)
	}
	os.Exit(code)
}

// startRegistry runs registry:3 on the engine's host network, listening on
// itRegistryAddr, as the registry system workload does on a builder node.
func startRegistry(ctx context.Context) error {
	_ = itDocker.removeContainer(ctx, itRegistryName)
	if ok, _ := itDocker.imageExists(ctx, itRegistryImage); !ok {
		if err := itDocker.pullImage(ctx, itRegistryImage); err != nil {
			return err
		}
	}
	id, err := itDocker.createContainer(ctx, itRegistryName, map[string]any{
		"Image": itRegistryImage,
		"Env":   []string{"REGISTRY_HTTP_ADDR=" + itRegistryAddr, "OTEL_TRACES_EXPORTER=none"},
		"HostConfig": map[string]any{
			"NetworkMode": "host",
		},
	})
	if err != nil {
		return err
	}
	if err := itDocker.startContainer(ctx, id); err != nil {
		return err
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get("http://" + itRegistryAddr + "/v2/")
		if err == nil {
			resp.Body.Close()
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("registry did not start on %s", itRegistryAddr)
}

// -----------------------------------------------------------------------------
// Git server
// -----------------------------------------------------------------------------

// gitServer serves bare repositories over git's smart HTTP protocol through
// git http-backend. Repositories whose name starts with "private-" require
// itToken as GitHub-style Basic credentials.
type gitServer struct {
	root string
	srv  *httptest.Server

	mu         sync.Mutex
	authHeader []string
}

func newGitServer(t *testing.T) *gitServer {
	t.Helper()
	execPath, err := exec.Command("git", "--exec-path").Output()
	if err != nil {
		t.Fatalf("git --exec-path: %v", err)
	}
	g := &gitServer{root: t.TempDir()}
	backend := &cgi.Handler{
		Path: filepath.Join(strings.TrimSpace(string(execPath)), "git-http-backend"),
		Env:  []string{"GIT_PROJECT_ROOT=" + g.root, "GIT_HTTP_EXPORT_ALL=1"},
	}
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte(gitTokenUser+":"+itToken))
	g.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		g.authHeader = append(g.authHeader, r.Header.Get("Authorization"))
		g.mu.Unlock()
		if strings.HasPrefix(r.URL.Path, "/private-") && r.Header.Get("Authorization") != want {
			w.Header().Set("WWW-Authenticate", `Basic realm="git"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		backend.ServeHTTP(w, r)
	}))
	t.Cleanup(g.srv.Close)
	return g
}

// repo creates a bare repository with one commit holding files, and returns
// its URL and commit SHA. A value starting with "symlink:" creates a
// symlink to the rest.
func (g *gitServer) repo(t *testing.T, name string, files map[string]string) (string, string) {
	t.Helper()
	work := t.TempDir()
	run := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run(work, "init", "-q", "-b", "main")
	for name, content := range files {
		p := filepath.Join(work, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if target, ok := strings.CutPrefix(content, "symlink:"); ok {
			if err := os.Symlink(target, p); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run(work, "add", "-A")
	run(work, "commit", "-q", "-m", "init")
	sha := run(work, "rev-parse", "HEAD")
	run(g.root, "clone", "-q", "--bare", work, name+".git")
	run(filepath.Join(g.root, name+".git"), "config", "http.receivepack", "false")
	return g.srv.URL + "/" + name + ".git", sha
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

func newTestBuilder(t *testing.T, mutate func(*Options)) Builder {
	t.Helper()
	opts := Options{
		Logger:            itLog,
		DataDir:           t.TempDir(),
		RegistryAddr:      itRegistryAddr,
		RegistryProxyPort: itProxyPort,
		AllowLoopbackHTTP: true,
		MinFreeBytes:      1 << 30,
		CacheMaxBytes:     10 << 30,
	}
	if mutate != nil {
		mutate(&opts)
	}
	b, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

var buildSeq struct {
	sync.Mutex
	n int
}

func testJob(builder protocol.Builder, repoURL, sha string) protocol.BuildJob {
	buildSeq.Lock()
	buildSeq.n++
	n := buildSeq.n
	buildSeq.Unlock()
	return protocol.BuildJob{
		Type:            protocol.TypeBuildJob,
		BuildID:         fmt.Sprintf("bld_it%d%d", time.Now().Unix(), n),
		DeploymentID:    "dep_it",
		Source:          protocol.GitBuildSource{Type: "git", URL: repoURL, CommitSHA: sha},
		Builder:         builder,
		ContextDir:      ".",
		BuildArgs:       map[string]string{},
		ImageRepository: protocol.LocalImageRepository("prj_IT", "svc_IT"),
		CacheKey:        "svc_IT",
		TimeoutS:        900,
	}
}

// collector records every logs frame and checks each against the protocol.
type collector struct {
	t      *testing.T
	mu     sync.Mutex
	frames []protocol.Logs
}

func (c *collector) emit(l protocol.Logs) {
	if err := l.Validate(); err != nil {
		c.t.Errorf("invalid logs frame: %v", err)
	}
	c.mu.Lock()
	c.frames = append(c.frames, l)
	c.mu.Unlock()
}

func (c *collector) text() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var sb strings.Builder
	for _, f := range c.frames {
		for _, l := range f.Lines {
			sb.WriteString(l.Text)
			sb.WriteByte('\n')
		}
	}
	return sb.String()
}

func runBuild(t *testing.T, b Builder, job protocol.BuildJob) (protocol.BuildResult, string) {
	t.Helper()
	c := &collector{t: t}
	res := b.Run(context.Background(), job, c.emit)
	logs := c.text()
	if err := res.Validate(); err != nil {
		t.Errorf("invalid build result %+v: %v", res, err)
	}
	if testing.Verbose() {
		t.Logf("build %s output:\n%s", job.BuildID, logs)
	}
	return res, logs
}

// pullAndRun pulls the image by digest through the engine, proving the
// registry serves it, then runs it on the host network with env and returns
// the container ID.
func pullAndRun(t *testing.T, ref string, env []string) string {
	t.Helper()
	ctx := context.Background()
	if err := itDocker.pullImage(ctx, ref); err != nil {
		t.Fatalf("pull %s: %v", ref, err)
	}
	id, err := itDocker.createContainer(ctx, "roundhouse-it-app-"+fmt.Sprint(time.Now().UnixNano()), map[string]any{
		"Image":      ref,
		"Env":        env,
		"HostConfig": map[string]any{"NetworkMode": "host"},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = itDocker.removeContainer(context.Background(), id) })
	if err := itDocker.startContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	return id
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func pulledRef(res protocol.BuildResult) string {
	path := strings.TrimPrefix(res.Image.Repository, protocol.RegistryListen+"/")
	return itRegistryAddr + "/" + path + "@" + res.Image.Digest
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

func TestIntegrationDockerfilePrivateRepo(t *testing.T) {
	g := newGitServer(t)
	repoURL, sha := g.repo(t, "private-app", map[string]string{
		"Dockerfile": "FROM busybox:1.37\nARG GREETING\nARG API_TOKEN\n" +
			"RUN echo \"greeting=$GREETING token=$API_TOKEN\"\n" +
			"RUN echo \"$GREETING\" > /greeting\nCMD [\"cat\", \"/greeting\"]\n",
	})
	job := testJob(protocol.BuilderDockerfile, repoURL, sha)
	job.Source.Token = itToken
	job.BuildArgs = map[string]string{"GREETING": "hello-roundhouse", "API_TOKEN": "s3cr3t-build-arg-value"}

	b := newTestBuilder(t, nil)
	res, logs := runBuild(t, b, job)
	if !res.OK {
		t.Fatalf("build failed: %s\n%s", res.Error, logs)
	}
	if res.Image.Repository != job.ImageRepository {
		t.Errorf("repository = %q", res.Image.Repository)
	}
	if !strings.Contains(logs, "greeting=hello-roundhouse") {
		t.Errorf("build output missing from logs:\n%s", logs)
	}
	for _, secret := range []string{itToken, "s3cr3t-build-arg-value", base64.StdEncoding.EncodeToString([]byte(gitTokenUser + ":" + itToken))} {
		if strings.Contains(logs, secret) {
			t.Errorf("logs leak secret %q", secret)
		}
	}
	if !strings.Contains(logs, "token="+redactedText) {
		t.Errorf("secret build arg not redacted in logs")
	}

	got, err := manifestDigest(context.Background(), http.DefaultClient, itRegistryAddr, "prj_it/svc_it", job.BuildID)
	if err != nil || got != res.Image.Digest {
		t.Fatalf("registry digest = %q, %v; result digest %q", got, err, res.Image.Digest)
	}
	id := pullAndRun(t, pulledRef(res), nil)
	waitExit(t, id)
	if out := itDocker.containerLogs(context.Background(), id, 10); !strings.Contains(out, "hello-roundhouse") {
		t.Errorf("container output %q", out)
	}

	// The same commit again is served from cache and yields the same image.
	job2 := job
	job2.BuildID += "b"
	res2, logs2 := runBuild(t, b, job2)
	if !res2.OK || res2.Image.Digest != res.Image.Digest {
		t.Errorf("rebuild: ok=%v digest=%s want %s: %s", res2.OK, res2.Image.Digest, res.Image.Digest, res2.Error)
	}
	if !strings.Contains(logs2, "CACHED") {
		t.Errorf("rebuild did not use the cache:\n%s", logs2)
	}
}

func TestIntegrationPrivateRepoWithoutToken(t *testing.T) {
	g := newGitServer(t)
	repoURL, sha := g.repo(t, "private-denied", map[string]string{"Dockerfile": "FROM busybox:1.37\n"})
	res, _ := runBuild(t, newTestBuilder(t, nil), testJob(protocol.BuilderDockerfile, repoURL, sha))
	if res.OK || !strings.Contains(res.Error, "does not exist or the builder has no access") {
		t.Fatalf("result = %+v", res)
	}
}

func TestIntegrationRailpackNode(t *testing.T) {
	if _, err := exec.LookPath("railpack"); err != nil {
		t.Skip("railpack not installed")
	}
	g := newGitServer(t)
	repoURL, sha := g.repo(t, "node-app", map[string]string{
		"package.json":      `{"name":"roundhouse-it","version":"1.0.0","private":true,"scripts":{"start":"node index.js"},"engines":{"node":"22"}}`,
		"package-lock.json": `{"name":"roundhouse-it","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"roundhouse-it","version":"1.0.0","engines":{"node":"22"}}}}`,
		"index.js": "const http = require('http');\n" +
			"const port = process.env.PORT || 3000;\n" +
			"http.createServer((req, res) => res.end('hello from railpack ' + process.env.GREETING)).listen(port, '127.0.0.1');\n",
	})
	job := testJob(protocol.BuilderRailpack, repoURL, sha)
	job.CacheKey = "svc_ITnode"
	job.BuildArgs = map[string]string{"NPM_CONFIG_LOGLEVEL": "warn"}
	res, logs := runBuild(t, newTestBuilder(t, nil), job)
	if !res.OK {
		t.Fatalf("build failed: %s\n%s", res.Error, logs)
	}

	port := freePort(t)
	pullAndRun(t, pulledRef(res), []string{fmt.Sprintf("PORT=%d", port), "GREETING=world"})
	var body string
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", port))
		if err == nil {
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			body = string(b)
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if body != "hello from railpack world" {
		t.Fatalf("app answered %q", body)
	}
}

func TestIntegrationRailpackUndetectable(t *testing.T) {
	if _, err := exec.LookPath("railpack"); err != nil {
		t.Skip("railpack not installed")
	}
	g := newGitServer(t)
	repoURL, sha := g.repo(t, "nothing", map[string]string{"notes.txt": "nothing to build\n"})
	res, logs := runBuild(t, newTestBuilder(t, nil), testJob(protocol.BuilderRailpack, repoURL, sha))
	if res.OK || !strings.Contains(res.Error, "Railpack could not detect a language or framework") {
		t.Fatalf("result = %+v\n%s", res, logs)
	}
}

func TestIntegrationFailingBuild(t *testing.T) {
	g := newGitServer(t)
	repoURL, sha := g.repo(t, "failing", map[string]string{
		"Dockerfile": "FROM busybox:1.37\nRUN echo about to fail && exit 3\n",
	})
	res, logs := runBuild(t, newTestBuilder(t, nil), testJob(protocol.BuilderDockerfile, repoURL, sha))
	if res.OK {
		t.Fatal("build succeeded")
	}
	if !strings.Contains(res.Error, "exit code: 3") || !strings.Contains(res.Error, "Build step") {
		t.Errorf("error = %q", res.Error)
	}
	if !strings.Contains(logs, "about to fail") {
		t.Errorf("step output missing:\n%s", logs)
	}
}

func TestIntegrationMissingDockerfile(t *testing.T) {
	g := newGitServer(t)
	repoURL, sha := g.repo(t, "nodockerfile", map[string]string{"app/main.go": "package main\n"})
	job := testJob(protocol.BuilderDockerfile, repoURL, sha)
	job.ContextDir = "app"
	res, _ := runBuild(t, newTestBuilder(t, nil), job)
	if res.OK || res.Error != `Dockerfile not found at "app/Dockerfile" in the repository` {
		t.Fatalf("error = %q", res.Error)
	}
}

func TestIntegrationTimeout(t *testing.T) {
	g := newGitServer(t)
	repoURL, sha := g.repo(t, "slow", map[string]string{
		"Dockerfile": "FROM busybox:1.37\nRUN echo sleeping && sleep 600\n",
	})
	b := newTestBuilder(t, func(o *Options) { o.Timeout = 25 * time.Second })
	start := time.Now()
	res, _ := runBuild(t, b, testJob(protocol.BuilderDockerfile, repoURL, sha))
	elapsed := time.Since(start)
	if res.OK || !strings.Contains(res.Error, "timed out after 25s") {
		t.Fatalf("result = %+v", res)
	}
	if elapsed > 25*time.Second+solveKillGrace+10*time.Second {
		t.Errorf("Run returned after %s", elapsed)
	}

	// The daemon is usable straight away for the next build.
	repoURL2, sha2 := g.repo(t, "quick", map[string]string{"Dockerfile": "FROM busybox:1.37\nRUN echo quick\n"})
	if res, logs := runBuild(t, b, testJob(protocol.BuilderDockerfile, repoURL2, sha2)); !res.OK {
		t.Fatalf("build after timeout failed: %s\n%s", res.Error, logs)
	}
}

func TestIntegrationPathEscape(t *testing.T) {
	g := newGitServer(t)
	repoURL, sha := g.repo(t, "escape", map[string]string{
		"Dockerfile":         "FROM busybox:1.37\nCOPY . /ctx\nRUN ls -la /ctx && test ! -e /ctx/hostfile\n",
		"hostfile":           "symlink:/etc/passwd",
		"outside":            "symlink:/etc",
		"evil.Dockerfile":    "symlink:/etc/hostname",
		"nested/up":          "symlink:../../..",
		"inside/Dockerfile":  "FROM busybox:1.37\n",
		"inside-link":        "symlink:inside",
		"inside/escape-link": "symlink:../outside",
	})
	b := newTestBuilder(t, nil)

	cases := []struct {
		name       string
		contextDir string
		dockerfile string
		want       string
	}{
		{"symlinked context to /etc", "outside", "", "does not exist at this commit"},
		{"dotdot context", "../src", "", "must be a relative path inside the repository"},
		{"dockerfile symlink to host file", ".", "evil.Dockerfile", `Dockerfile not found at "evil.Dockerfile"`},
		{"dockerfile path with dotdot", ".", "../Dockerfile", "must be a relative path inside the repository"},
		{"context via nested escape", "nested/up", "", "does not exist at this commit"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			job := testJob(protocol.BuilderDockerfile, repoURL, sha)
			job.ContextDir = tc.contextDir
			job.DockerfilePath = tc.dockerfile
			res, logs := runBuild(t, b, job)
			if res.OK || !strings.Contains(res.Error, tc.want) {
				t.Fatalf("error = %q, want %q\n%s", res.Error, tc.want, logs)
			}
		})
	}

	t.Run("escaping symlinks are dropped and the build succeeds", func(t *testing.T) {
		res, logs := runBuild(t, b, testJob(protocol.BuilderDockerfile, repoURL, sha))
		if !res.OK {
			t.Fatalf("build failed: %s\n%s", res.Error, logs)
		}
		for _, want := range []string{"Ignoring symlink hostfile", "Ignoring symlink outside"} {
			if !strings.Contains(logs, want) {
				t.Errorf("logs missing %q", want)
			}
		}
		if strings.Contains(logs, "root:x:0:0") {
			t.Error("host file content reached the build")
		}
	})
	t.Run("symlinked context inside the repository works", func(t *testing.T) {
		job := testJob(protocol.BuilderDockerfile, repoURL, sha)
		job.ContextDir = "inside-link"
		if res, logs := runBuild(t, b, job); !res.OK {
			t.Fatalf("build failed: %s\n%s", res.Error, logs)
		}
	})
}

func TestIntegrationBuildNetworkIsolation(t *testing.T) {
	g := newGitServer(t)
	// RUN steps get BuildKit's own /etc/hosts, so they address the proxy by
	// the gateway IP.
	gateway, err := (&daemon{docker: itDocker}).ensureNetwork(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	proxy := fmt.Sprintf("http://%s:%d", gateway, itProxyPort)
	_, registryPort, _ := net.SplitHostPort(itRegistryAddr)
	repoURL, sha := g.repo(t, "isolation", map[string]string{
		"Dockerfile": "FROM busybox:1.37\n" +
			// The registry proxy is reachable, but useless without the
			// session's credentials.
			"RUN wget -q -O- " + proxy + "/v2/prj_it/svc_it/tags/list > /out 2>&1; cat /out; grep -q 401 /out\n" +
			// Host loopback services are reachable neither directly nor via
			// the host's address on the build network.
			"RUN ! wget -q -T 3 -O- http://" + itRegistryAddr + "/v2/ && " +
			"! wget -q -T 3 -O- http://" + gateway + ":" + registryPort + "/v2/ && echo loopback-unreachable\n",
	})
	res, logs := runBuild(t, newTestBuilder(t, nil), testJob(protocol.BuilderDockerfile, repoURL, sha))
	if !res.OK {
		t.Fatalf("isolation checks failed: %s\n%s", res.Error, logs)
	}
	if !strings.Contains(logs, "loopback-unreachable") {
		t.Errorf("logs:\n%s", logs)
	}
}

func TestIntegrationCancel(t *testing.T) {
	g := newGitServer(t)
	repoURL, sha := g.repo(t, "cancel", map[string]string{"Dockerfile": "FROM busybox:1.37\nRUN sleep 600\n"})
	b := newTestBuilder(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(15*time.Second, cancel)
	c := &collector{t: t}
	res := b.Run(ctx, testJob(protocol.BuilderDockerfile, repoURL, sha), c.emit)
	if res.OK || res.Error != "Build was cancelled." {
		t.Fatalf("result = %+v", res)
	}
}

func waitExit(t *testing.T, id string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		info, err := itDocker.inspectContainer(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if !info.State.Running {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("container %s did not exit", id)
}
