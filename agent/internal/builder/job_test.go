package builder

import (
	"errors"
	"strings"
	"testing"
	"time"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

func validJob() protocol.BuildJob {
	return protocol.BuildJob{
		Type:            protocol.TypeBuildJob,
		BuildID:         "bld_01J8Z",
		DeploymentID:    "dep_01J8Z",
		ProjectID:       "prj_A",
		ServiceID:       "svc_B",
		Source:          protocol.GitBuildSource{Type: "git", URL: "https://github.com/acme/app.git", CommitSHA: strings.Repeat("a", 40)},
		Builder:         protocol.BuilderDockerfile,
		ContextDir:      ".",
		BuildArgs:       map[string]string{"NODE_ENV": "production"},
		ImageRepository: protocol.LocalImageRepository("prj_A", "svc_B"),
		CacheKey:        protocol.BuildCacheKey("prj_A", "svc_B"),
		TimeoutS:        600,
	}
}

func TestValidateJob(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*protocol.BuildJob)
		want   string
	}{
		{"valid", func(*protocol.BuildJob) {}, ""},
		{"valid railpack", func(j *protocol.BuildJob) { j.Builder = protocol.BuilderRailpack }, ""},
		{"valid nested paths", func(j *protocol.BuildJob) { j.ContextDir = "apps/web"; j.DockerfilePath = "docker/Dockerfile.prod" }, ""},
		{"bad build id", func(j *protocol.BuildJob) { j.BuildID = "../x" }, "invalid build id"},
		{"short sha", func(j *protocol.BuildJob) { j.Source.CommitSHA = "abc123" }, "invalid commit SHA"},
		{"ref as sha", func(j *protocol.BuildJob) { j.Source.CommitSHA = "main" }, "invalid commit SHA"},
		{"context dotdot", func(j *protocol.BuildJob) { j.ContextDir = "../other" }, "context directory"},
		{"context nested dotdot", func(j *protocol.BuildJob) { j.ContextDir = "a/../../b" }, "context directory"},
		{"context absolute", func(j *protocol.BuildJob) { j.ContextDir = "/etc" }, "context directory"},
		{"context backslash", func(j *protocol.BuildJob) { j.ContextDir = `..\..\etc` }, "context directory"},
		{"context empty", func(j *protocol.BuildJob) { j.ContextDir = "" }, "context directory"},
		{"dockerfile dotdot", func(j *protocol.BuildJob) { j.DockerfilePath = "../Dockerfile" }, "dockerfile path"},
		{"dockerfile absolute", func(j *protocol.BuildJob) { j.DockerfilePath = "/etc/passwd" }, "dockerfile path"},
		{"dockerfile with railpack", func(j *protocol.BuildJob) { j.Builder = protocol.BuilderRailpack; j.DockerfilePath = "Dockerfile" }, "only allowed with the Dockerfile builder"},
		{"unknown builder", func(j *protocol.BuildJob) { j.Builder = "nixpacks" }, "unknown builder"},
		{"bad build arg", func(j *protocol.BuildJob) { j.BuildArgs = map[string]string{"A-B": "x"} }, "invalid build argument"},
		{"huge build arg", func(j *protocol.BuildJob) {
			j.BuildArgs = map[string]string{"A": strings.Repeat("x", protocol.MaxBuildArgValueBytes+1)}
		}, "invalid build argument"},
		{"foreign registry", func(j *protocol.BuildJob) { j.ImageRepository = "docker.io/acme/app" }, "not in the local registry"},
		{"registry path escape", func(j *protocol.BuildJob) { j.ImageRepository = "127.0.0.1:5000/../x" }, "not in the local registry"},
		{"uppercase repository", func(j *protocol.BuildJob) { j.ImageRepository = "127.0.0.1:5000/Prj/Svc" }, "not in the local registry"},
		{"bad cache key", func(j *protocol.BuildJob) { j.CacheKey = "a b" }, "invalid cache key"},
		{"no timeout", func(j *protocol.BuildJob) { j.TimeoutS = 0 }, "timeout_s"},
		{"other service's repository", func(j *protocol.BuildJob) {
			j.ImageRepository = protocol.LocalImageRepository("prj_A", "svc_other")
		}, "not the service's repository"},
		{"other project's repository", func(j *protocol.BuildJob) {
			j.ImageRepository = protocol.LocalImageRepository("prj_other", "svc_B")
		}, "not the service's repository"},
		{"other project's cache", func(j *protocol.BuildJob) { j.CacheKey = protocol.BuildCacheKey("prj_other", "svc_B") }, "invalid cache key"},
		{"service-only cache key", func(j *protocol.BuildJob) { j.CacheKey = "svc_B" }, "invalid cache key"},
		{"valid preview", func(j *protocol.BuildJob) {
			j.Isolation = protocol.BuildIsolationPreview
			j.CacheKey = protocol.BuildCacheKeyFor("prj_A", "svc_B", protocol.BuildIsolationPreview)
		}, ""},
		{"preview on the shared cache", func(j *protocol.BuildJob) { j.Isolation = protocol.BuildIsolationPreview }, "invalid cache key"},
		{"shared build on the preview cache", func(j *protocol.BuildJob) {
			j.CacheKey = protocol.BuildCacheKeyFor("prj_A", "svc_B", protocol.BuildIsolationPreview)
		}, "invalid cache key"},
		{"unknown isolation", func(j *protocol.BuildJob) { j.Isolation = "fork" }, "unknown build isolation"},
		{"missing project", func(j *protocol.BuildJob) { j.ProjectID = "" }, "invalid project or service id"},
		{"bad service", func(j *protocol.BuildJob) { j.ServiceID = "../svc" }, "invalid project or service id"},
		{"safe ref", func(j *protocol.BuildJob) { j.Source.Ref = "refs/heads/main" }, ""},
		{"option ref", func(j *protocol.BuildJob) { j.Source.Ref = "--upload-pack=evil" }, "invalid git ref"},
		{"dotdot ref", func(j *protocol.BuildJob) { j.Source.Ref = "a/../b" }, "invalid git ref"},
		{"space ref", func(j *protocol.BuildJob) { j.Source.Ref = "main branch" }, "invalid git ref"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			j := validJob()
			tc.mutate(&j)
			err := validateJob(&j, false)
			if tc.want == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			var ue *userError
			if err == nil || !errors.As(err, &ue) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want user error containing %q", err, tc.want)
			}
		})
	}
}

func TestValidateGitURL(t *testing.T) {
	cases := []struct {
		url      string
		loopback bool
		ok       bool
	}{
		{"https://github.com/acme/app.git", false, true},
		{"https://gitlab.example.com:8443/group/sub/app", false, true},
		{"http://github.com/acme/app.git", false, false},
		{"http://github.com/acme/app.git", true, false},
		{"http://127.0.0.1:8080/app.git", false, false},
		{"http://127.0.0.1:8080/app.git", true, true},
		{"http://[::1]:8080/app.git", true, true},
		{"http://localhost/app.git", true, true},
		{"https://user:pass@github.com/acme/app.git", false, false},
		{"https://x-access-token@github.com/acme/app.git", false, false},
		{"git@github.com:acme/app.git", false, false},
		{"ssh://git@github.com/acme/app.git", false, false},
		{"file:///etc", false, false},
		{"ext::sh -c touch% /tmp/pwned", false, false},
		{"https://github.com/acme/app.git?x=1", false, false},
		{"https://github.com/acme/app.git#frag", false, false},
		{"https:///nohost", false, false},
		{"https://" + strings.Repeat("a", 2100) + ".com/x", false, false},
	}
	for _, tc := range cases {
		err := validateGitURL(tc.url, tc.loopback)
		if (err == nil) != tc.ok {
			t.Errorf("validateGitURL(%q, %v) = %v, want ok=%v", tc.url, tc.loopback, err, tc.ok)
		}
	}
}

func TestRepositoryPaths(t *testing.T) {
	p, err := repositoryPath(protocol.LocalImageRepository("prj_ABC", "svc_DEF"))
	if err != nil || p != "prj_abc/svc_def" {
		t.Fatalf("repositoryPath = %q, %v", p, err)
	}
	for _, key := range []string{"svc_B", "UPPER.case-key_1", strings.Repeat("z", 128)} {
		c := cacheRepositoryPath(key)
		if !repoPathRE.MatchString(c) {
			t.Errorf("cache path %q for key %q is not a valid repository path", c, key)
		}
	}
	if cacheRepositoryPath("a") == cacheRepositoryPath("b") {
		t.Error("distinct keys share a cache repository")
	}
}

func TestBuildTimeout(t *testing.T) {
	j := validJob()
	j.TimeoutS = 600
	if got := buildTimeout(&j, time.Hour); got != 10*time.Minute {
		t.Errorf("job timeout under the cap: %s", got)
	}
	if got := buildTimeout(&j, time.Minute); got != time.Minute {
		t.Errorf("cap under the job timeout: %s", got)
	}
}
