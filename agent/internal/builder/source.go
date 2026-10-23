package builder

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// gitTokenUser is the HTTP Basic user name for a GitHub App installation
// token; GitHub ignores it, other forges accept it.
const gitTokenUser = "x-access-token"

// gitKillGrace is how long git gets after cancellation before it is killed.
const gitKillGrace = 5 * time.Second

// gitSource fetches one commit of a repository with the system git binary.
//
// The system binary is used rather than a Go implementation because it is
// the reference implementation of the smart HTTP protocol (shallow fetch by
// SHA, protocol v2, partial-clone negotiation), receives distribution
// security updates independently of agent releases, and keeps a large
// dependency tree out of a root-privileged daemon.
type gitSource struct {
	git string
	// home is an empty directory used as HOME, so no user or system git
	// configuration, credential helper or hook applies.
	home string
	url  string
	// token, when set, is sent as an HTTP Authorization header through
	// GIT_CONFIG_* environment variables: never argv, never .git/config.
	token string
	// allowHTTP permits plain http, used only for loopback test servers.
	allowHTTP bool
	stdout    io.Writer
	stderr    io.Writer
}

// gitConfig returns the configuration every git invocation runs with, as
// key/value pairs passed through GIT_CONFIG_COUNT. Keeping it in the
// environment means the values never appear in argv or on disk.
func (g *gitSource) gitConfig() [][2]string {
	cfg := [][2]string{
		// An empty value resets the helper list: no stored credentials are
		// consulted and nothing is written back.
		{"credential.helper", ""},
		{"core.hooksPath", os.DevNull},
		{"core.fsmonitor", "false"},
		{"core.symlinks", "true"},
		{"core.autocrlf", "false"},
		{"advice.detachedHead", "false"},
		{"fetch.recurseSubmodules", "false"},
		{"submodule.recurse", "false"},
		{"protocol.version", "2"},
		{"protocol.allow", "never"},
		{"protocol.https.allow", "always"},
		{"init.defaultBranch", "main"},
	}
	if g.allowHTTP {
		cfg = append(cfg, [2]string{"protocol.http.allow", "always"})
	}
	if g.token != "" {
		// SECURITY: a redirect could carry the header to another host, so
		// redirects are refused outright and the header is scoped to the
		// repository's origin.
		cfg = append(cfg,
			[2]string{"http.followRedirects", "false"},
			[2]string{"http." + originPrefix(g.url) + ".extraHeader", "Authorization: Basic " +
				base64.StdEncoding.EncodeToString([]byte(gitTokenUser+":"+g.token))},
		)
	}
	return cfg
}

// originPrefix returns scheme://host/ of a repository URL, the most specific
// prefix git's http.<url>.* matching applies to every request of a fetch.
func originPrefix(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	return u.Scheme + "://" + u.Host + "/"
}

// env builds git's environment from scratch so nothing from the agent's own
// environment (GIT_DIR, GIT_TRACE, proxies set for other purposes, ...) leaks
// in.
func (g *gitSource) env() []string {
	allowed := "https"
	if g.allowHTTP {
		allowed = "https:http"
	}
	env := []string{
		"HOME=" + g.home,
		"XDG_CONFIG_HOME=" + g.home,
		"LC_ALL=C",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=" + os.DevNull,
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=",
		"SSH_ASKPASS=",
		"GCM_INTERACTIVE=never",
		"GIT_LFS_SKIP_SMUDGE=1",
		"GIT_ALLOW_PROTOCOL=" + allowed,
	}
	for _, k := range []string{"PATH", "SYSTEMROOT", "TMPDIR", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"} {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	cfg := g.gitConfig()
	env = append(env, "GIT_CONFIG_COUNT="+strconv.Itoa(len(cfg)))
	for i, kv := range cfg {
		n := strconv.Itoa(i)
		env = append(env, "GIT_CONFIG_KEY_"+n+"="+kv[0], "GIT_CONFIG_VALUE_"+n+"="+kv[1])
	}
	return env
}

// command returns the exec.Cmd for `git <args...>` in dir. Its stderr is
// captured (bounded) for error messages and also copied to g.stderr.
func (g *gitSource) command(ctx context.Context, dir string, args ...string) (*exec.Cmd, *tailBuffer) {
	cmd := exec.CommandContext(ctx, g.git, args...)
	cmd.Dir = dir
	cmd.Env = g.env()
	cmd.Stdin = nil
	tail := &tailBuffer{max: 8 << 10}
	cmd.Stdout = orDiscard(g.stdout)
	cmd.Stderr = io.MultiWriter(tail, orDiscard(g.stderr))
	configureKill(cmd, gitKillGrace)
	return cmd, tail
}

func (g *gitSource) run(ctx context.Context, dir string, args ...string) (string, error) {
	cmd, tail := g.command(ctx, dir, args...)
	err := cmd.Run()
	if err != nil && ctx.Err() != nil {
		return tail.String(), context.Cause(ctx)
	}
	return tail.String(), err
}

// fetchArgs are the arguments of the shallow fetch of one commit.
func fetchArgs(repoURL, sha string) []string {
	return []string{"fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", repoURL, sha}
}

// fallbackFetchArgs fetch ref, or every branch, for servers that refuse to
// serve an unadvertised commit by SHA.
func fallbackFetchArgs(repoURL, ref string) []string {
	args := []string{"fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", repoURL}
	if ref != "" {
		return append(args, ref)
	}
	return append(args, "+refs/heads/*:refs/remotes/origin/*")
}

// fetch checks out commit sha of the repository into dir, which must not
// exist yet.
func (g *gitSource) fetch(ctx context.Context, dir, sha, ref string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if out, err := g.run(ctx, dir, "init", "--quiet"); err != nil {
		return fmt.Errorf("git init: %w: %s", err, lastLine(out))
	}
	out, err := g.run(ctx, dir, fetchArgs(g.url, sha)...)
	if err != nil {
		if ctx.Err() != nil {
			return err
		}
		if ue := classifyGitError(g.url, sha, out); ue != nil {
			return ue
		}
		fmt.Fprintf(orDiscard(g.stderr), "Shallow fetch of %s was refused; fetching history instead\n", sha)
		out, err = g.run(ctx, dir, fallbackFetchArgs(g.url, ref)...)
		if err != nil {
			if ctx.Err() != nil {
				return err
			}
			if ue := classifyGitError(g.url, sha, out); ue != nil {
				return ue
			}
			return userErrorf("could not fetch %s: %s", g.url, lastLine(out))
		}
		if _, err := g.run(ctx, dir, "cat-file", "-e", sha+"^{commit}"); err != nil {
			if ctx.Err() != nil {
				return err
			}
			return userErrorf("commit %s was not found in %s", sha, g.url)
		}
	}
	if out, err := g.run(ctx, dir, "checkout", "--quiet", "--detach", sha); err != nil {
		if ctx.Err() != nil {
			return err
		}
		return userErrorf("could not check out commit %s: %s", sha, lastLine(out))
	}
	head, err := g.output(ctx, dir, "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	if head != sha {
		return fmt.Errorf("checked out %s, want %s", head, sha)
	}
	return nil
}

func (g *gitSource) output(ctx context.Context, dir string, args ...string) (string, error) {
	cmd, tail := g.command(ctx, dir, args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", context.Cause(ctx)
		}
		return "", fmt.Errorf("git %s: %w: %s", args[0], err, lastLine(tail.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

// classifyGitError turns git's stderr into a message for the user when the
// failure is one a retry with more history cannot fix.
func classifyGitError(repoURL, sha, stderr string) error {
	s := strings.ToLower(stderr)
	switch {
	case containsAny(s, "authentication failed", "could not read username", "terminal prompts disabled",
		"repository not found", "error: 403", "error: 401", "returned error: 401", "returned error: 403",
		"returned error: 404", "access denied", "not found"):
		if strings.Contains(s, "not our ref") || strings.Contains(s, "remote ref") {
			return nil
		}
		return userErrorf("could not access %s: the repository does not exist or the builder has no access to it", repoURL)
	case containsAny(s, "could not resolve host", "couldn't resolve host"):
		return userErrorf("could not reach %s: the host name does not resolve", repoURL)
	case containsAny(s, "failed to connect", "connection refused", "connection timed out", "operation timed out"):
		return userErrorf("could not connect to %s", repoURL)
	case containsAny(s, "ssl certificate", "certificate verify", "server certificate"):
		return userErrorf("could not verify the TLS certificate of %s", repoURL)
	case containsAny(s, "redirect"):
		return userErrorf("%s redirected elsewhere; use the repository's canonical URL", repoURL)
	}
	return nil
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

// buildPaths are the resolved, real locations a build reads from.
type buildPaths struct {
	// context is the build context directory.
	context string
	// dockerfileDir and dockerfileName locate the Dockerfile; empty for
	// Railpack builds.
	dockerfileDir  string
	dockerfileName string
}

// within reports whether path is root or below it. Both must be clean and
// absolute.
func within(root, path string) bool {
	if path == root {
		return true
	}
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// resolveInRepo resolves rel against root, following symlinks, and fails if
// the result leaves root. root must already be a real path.
func resolveInRepo(root, rel string) (string, error) {
	if !protocol.IsSafeRelativePath(rel) {
		return "", errUnsafePath
	}
	real, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		return "", err
	}
	if !within(root, real) {
		return "", errUnsafePath
	}
	return real, nil
}

// resolvePaths locates the build context and, for Dockerfile builds, the
// Dockerfile inside the checkout at root.
func resolvePaths(root string, job *protocol.BuildJob) (buildPaths, error) {
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		return buildPaths{}, err
	}
	var p buildPaths
	ctxDir, err := resolveInRepo(root, job.ContextDir)
	switch {
	case errors.Is(err, errUnsafePath):
		return p, userErrorf("context directory %s resolves outside the repository", describePath(job.ContextDir))
	case errors.Is(err, fs.ErrNotExist):
		return p, userErrorf("context directory %s does not exist at this commit", describePath(job.ContextDir))
	case err != nil:
		return p, err
	}
	if fi, err := os.Stat(ctxDir); err != nil || !fi.IsDir() {
		return p, userErrorf("context directory %s is not a directory", describePath(job.ContextDir))
	}
	p.context = ctxDir
	if job.Builder != protocol.BuilderDockerfile {
		return p, nil
	}

	rel := job.DockerfilePath
	if rel == "" {
		rel = "Dockerfile"
	}
	shown := strings.TrimPrefix(filepath.ToSlash(filepath.Join(job.ContextDir, rel)), "./")
	full := rel
	if job.ContextDir != "." {
		full = job.ContextDir + "/" + rel
	}
	df, err := resolveInRepo(root, full)
	switch {
	case errors.Is(err, errUnsafePath):
		return p, userErrorf("Dockerfile path %q resolves outside the repository", shown)
	case errors.Is(err, fs.ErrNotExist):
		return p, userErrorf("Dockerfile not found at %q in the repository", shown)
	case err != nil:
		return p, err
	}
	if fi, err := os.Stat(df); err != nil || !fi.Mode().IsRegular() {
		return p, userErrorf("Dockerfile path %q is not a file", shown)
	}
	p.dockerfileDir, p.dockerfileName = filepath.Dir(df), filepath.Base(df)
	return p, nil
}

// removeEscapingSymlinks deletes every symlink under root (outside .git)
// that is dangling or resolves outside root, and returns the repository
// paths it removed. Tools that read the checkout on the host (Railpack's
// planner) would otherwise follow them to host files.
//
// Removing one link can leave another dangling, so passes repeat until one
// removes nothing.
func removeEscapingSymlinks(root string) ([]string, error) {
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	var removed []string
	for pass := 0; pass < 8; pass++ {
		n := 0
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() && d.Name() == ".git" && filepath.Dir(path) == root {
				return filepath.SkipDir
			}
			if d.Type()&fs.ModeSymlink == 0 {
				return nil
			}
			real, err := filepath.EvalSymlinks(path)
			if err == nil && within(root, real) {
				return nil
			}
			if err := os.Remove(path); err != nil {
				return err
			}
			rel, _ := filepath.Rel(root, path)
			removed = append(removed, filepath.ToSlash(rel))
			n++
			return nil
		})
		if err != nil {
			return removed, err
		}
		if n == 0 {
			return removed, nil
		}
	}
	return removed, errors.New("symlink cleanup did not converge")
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// tailBuffer keeps the last max bytes written to it.
type tailBuffer struct {
	mu  sync.Mutex
	max int
	buf []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = append([]byte(nil), t.buf[len(t.buf)-t.max:]...)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

func orDiscard(w io.Writer) io.Writer {
	if w == nil {
		return io.Discard
	}
	return w
}

// removeAll deletes a build directory. Git marks its objects read-only,
// which Windows refuses to delete, so permissions are reset first there.
func removeAll(dir string) error {
	err := os.RemoveAll(dir)
	if err == nil {
		return nil
	}
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err == nil && d.Type()&fs.ModeSymlink == 0 {
			_ = os.Chmod(path, 0o700)
		}
		return nil
	})
	return os.RemoveAll(dir)
}
