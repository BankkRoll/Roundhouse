//go:build integration

package builder

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"testing"
	"time"

	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
)

// imageConfig fetches the config blob of a pushed image from the test
// registry: what `docker history` and `docker inspect` show, including
// every history entry's created_by.
func imageConfig(t *testing.T, res protocol.BuildResult) string {
	t.Helper()
	repo := strings.TrimPrefix(res.Image.Repository, protocol.RegistryListen+"/")
	get := func(path, accept string) []byte {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, "http://"+itRegistryAddr+"/v2/"+repo+path, nil)
		if accept != "" {
			req.Header.Set("Accept", accept)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			t.Fatalf("GET %s: %d %s", path, resp.StatusCode, body)
		}
		return body
	}
	var m struct {
		MediaType string `json:"mediaType"`
		Config    struct {
			Digest string `json:"digest"`
		} `json:"config"`
		Manifests []struct {
			Digest   string `json:"digest"`
			Platform struct {
				OS string `json:"os"`
			} `json:"platform"`
		} `json:"manifests"`
	}
	if err := json.Unmarshal(get("/manifests/"+res.Image.Digest, manifestAccept), &m); err != nil {
		t.Fatal(err)
	}
	if len(m.Manifests) > 0 {
		for _, sub := range m.Manifests {
			if sub.Platform.OS != "unknown" {
				if err := json.Unmarshal(get("/manifests/"+sub.Digest, manifestAccept), &m); err != nil {
					t.Fatal(err)
				}
				break
			}
		}
	}
	if m.Config.Digest == "" {
		t.Fatalf("no image config in manifest %+v", m)
	}
	return string(get("/blobs/"+m.Config.Digest, ""))
}

// A build arg marked secret is usable during the build, but its value is in
// neither the image history, the image config nor the build logs, even
// though its name does not look secret; an unmarked arg is a plain build
// arg, recorded in the history as Docker records it.
func TestIntegrationSecretBuildArgsDockerfile(t *testing.T) {
	const secret = "marked-value-7f3a9c2e"
	g := newGitServer(t)
	// The Dockerfile checks the value by its hash: the value itself in the
	// Dockerfile would land in the history through the RUN line.
	sum := sha256.Sum256([]byte(secret))
	repoURL, sha := g.repo(t, "secret-args", map[string]string{
		"Dockerfile": "FROM busybox:1.37\nARG PUBLIC_ARG\n" +
			"RUN --mount=type=secret,id=BUILD_LICENSE,env=BUILD_LICENSE " +
			"test \"$(printf %s \"$BUILD_LICENSE\" | sha256sum | cut -d' ' -f1)\" = \"" + hex.EncodeToString(sum[:]) + "\" && " +
			"echo \"license seen: $BUILD_LICENSE public=$PUBLIC_ARG\"\n" +
			"RUN echo \"$PUBLIC_ARG\" > /public\nCMD [\"cat\", \"/public\"]\n",
	})
	job := testJob(protocol.BuilderDockerfile, repoURL, sha)
	job.BuildArgs = map[string]string{"BUILD_LICENSE": secret, "PUBLIC_ARG": "public-value"}
	job.SecretBuildArgs = []string{"BUILD_LICENSE"}

	res, logs := runBuild(t, newTestBuilder(t, nil), job)
	if !res.OK {
		t.Fatalf("build failed (was the secret readable?): %s\n%s", res.Error, logs)
	}
	if strings.Contains(logs, secret) {
		t.Fatalf("build logs contain the secret:\n%s", logs)
	}
	if !strings.Contains(logs, "license seen: "+redactedText+" public=public-value") {
		t.Errorf("the secret was not read and redacted:\n%s", logs)
	}
	cfg := imageConfig(t, res)
	if strings.Contains(cfg, secret) {
		t.Fatalf("the image config or history contains the secret:\n%s", cfg)
	}
	if !strings.Contains(cfg, "PUBLIC_ARG=public-value") {
		t.Fatalf("history does not record the plain build arg, so the check above proves nothing:\n%s", cfg)
	}

	// The same arg unmarked is a plain build arg: in the history.
	job.BuildID += "plain"
	job.SecretBuildArgs = nil
	g2, sha2 := g.repo(t, "plain-args", map[string]string{
		"Dockerfile": "FROM busybox:1.37\nARG BUILD_LICENSE\nRUN echo building\n",
	})
	job.Source.URL, job.Source.CommitSHA = g2, sha2
	res, logs = runBuild(t, newTestBuilder(t, nil), job)
	if !res.OK {
		t.Fatalf("plain build failed: %s\n%s", res.Error, logs)
	}
	if !strings.Contains(imageConfig(t, res), secret) {
		t.Fatal("an unmarked build arg should be in the history; the secret check is not testing anything")
	}
}

// Railpack passes every build arg as a BuildKit secret; a marked one never
// reaches the image either.
func TestIntegrationSecretBuildArgsRailpack(t *testing.T) {
	if _, err := exec.LookPath("railpack"); err != nil {
		t.Skip("railpack not installed")
	}
	const secret = "railpack-marked-4d2b8e1f"
	g := newGitServer(t)
	repoURL, sha := g.repo(t, "node-secret", map[string]string{
		"package.json": `{"name":"openrail-it-secret","version":"1.0.0","private":true,` +
			`"scripts":{"build":"node -e \"console.log('license ' + process.env.BUILD_LICENSE)\"","start":"node index.js"},"engines":{"node":"22"}}`,
		"package-lock.json": `{"name":"openrail-it-secret","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"openrail-it-secret","version":"1.0.0","engines":{"node":"22"}}}}`,
		"index.js":          "console.log('up');\n",
	})
	job := testJob(protocol.BuilderRailpack, repoURL, sha)
	job.CacheKey = "svc_ITsecret"
	job.BuildArgs = map[string]string{"BUILD_LICENSE": secret}
	job.SecretBuildArgs = []string{"BUILD_LICENSE"}
	res, logs := runBuild(t, newTestBuilder(t, nil), job)
	if !res.OK {
		t.Fatalf("build failed: %s\n%s", res.Error, logs)
	}
	if strings.Contains(logs, secret) {
		t.Fatalf("build logs contain the secret:\n%s", logs)
	}
	if !strings.Contains(logs, "license "+redactedText) {
		t.Errorf("the build step did not see the secret:\n%s", logs)
	}
	if cfg := imageConfig(t, res); strings.Contains(cfg, secret) {
		t.Fatalf("the image config or history contains the secret:\n%s", cfg)
	}
}

// A cancelled build stops promptly, BuildKit drops its running step, and
// the builder is free for the next build at once.
func TestIntegrationCancelFreesBuilder(t *testing.T) {
	g := newGitServer(t)
	repoURL, sha := g.repo(t, "cancel-free", map[string]string{
		"Dockerfile": "FROM busybox:1.37\nRUN echo slow-step-started && sleep 600\n",
	})
	b := newTestBuilder(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &collector{t: t}
	started := make(chan struct{})
	go func() {
		for !strings.Contains(c.text(), "slow-step-started") {
			time.Sleep(100 * time.Millisecond)
		}
		close(started)
	}()
	done := make(chan protocol.BuildResult, 1)
	job := testJob(protocol.BuilderDockerfile, repoURL, sha)
	go func() { done <- b.Run(ctx, job, c.emit) }()

	select {
	case <-started:
	case res := <-done:
		t.Fatalf("build ended before its slow step: %+v\n%s", res, c.text())
	case <-time.After(5 * time.Minute):
		t.Fatalf("the slow step never started:\n%s", c.text())
	}
	cancelled := time.Now()
	cancel()
	var res protocol.BuildResult
	select {
	case res = <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("the build did not stop within 30 s of its cancel")
	}
	stopped := time.Since(cancelled)
	if res.OK || res.Error != "Build was cancelled." {
		t.Fatalf("result = %+v", res)
	}
	t.Logf("cancelled build stopped in %v", stopped.Round(time.Millisecond))
	if stopped > 20*time.Second {
		t.Errorf("stopping took %v", stopped)
	}

	// BuildKit no longer runs the step: nothing under sys_buildkitd sleeps.
	if ps := buildkitProcesses(t); strings.Contains(ps, "sleep 600") {
		t.Errorf("the cancelled step still runs in BuildKit:\n%s", ps)
	}

	next, nextSHA := g.repo(t, "after-cancel", map[string]string{"Dockerfile": "FROM busybox:1.37\nRUN echo next-build\n"})
	job2 := testJob(protocol.BuilderDockerfile, next, nextSHA)
	job2.BuildID += "next"
	res2, logs := runBuild(t, b, job2)
	if !res2.OK {
		t.Fatalf("the build after a cancel failed: %s\n%s", res2.Error, logs)
	}
}

// buildkitProcesses lists the command lines of every process in
// sys_buildkitd, build steps included: they run in nested namespaces whose
// processes the daemon's own namespace sees.
func buildkitProcesses(t *testing.T) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	conn, err := itDocker.execStdio(ctx, ContainerName, []string{"ps", "-o", "args"}, io.Discard)
	if err != nil {
		t.Fatalf("exec ps in %s: %v", ContainerName, err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	out, _ := io.ReadAll(conn)
	if !strings.Contains(string(out), "buildkitd") {
		t.Fatalf("ps in %s did not list buildkitd:\n%s", ContainerName, out)
	}
	return string(out)
}
