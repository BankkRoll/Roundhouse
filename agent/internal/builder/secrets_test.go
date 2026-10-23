package builder

import (
	"errors"
	"strings"
	"testing"

	"github.com/BankkRoll/Roundhouse/agent/internal/sealtest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

func sealedBuilder() *builder {
	return &builder{opts: Options{EncryptionKey: sealtest.Key(), NodeID: "node_1"}}
}

func TestOpenSecrets(t *testing.T) {
	cases := []struct {
		name string
		job  func(t *testing.T) protocol.BuildJob
		b    *builder
		want map[string]string
		err  string
	}{
		{"no box", func(*testing.T) protocol.BuildJob { return validJob() }, sealedBuilder(), map[string]string{}, ""},
		{"opens", func(t *testing.T) protocol.BuildJob {
			j := validJob()
			sealtest.SealBuildSecrets(t, sealtest.Key().PublicKey(), "node_1", &j, map[string]string{"NPM_TOKEN": "npm_abcdef"})
			return j
		}, sealedBuilder(), map[string]string{"NPM_TOKEN": "npm_abcdef"}, ""},
		{"wrong key", func(t *testing.T) protocol.BuildJob {
			j := validJob()
			sealtest.SealBuildSecrets(t, sealtest.OtherKey(t).PublicKey(), "node_1", &j, map[string]string{"A": "b"})
			return j
		}, sealedBuilder(), nil, "re-join the node"},
		{"other node", func(t *testing.T) protocol.BuildJob {
			j := validJob()
			sealtest.SealBuildSecrets(t, sealtest.Key().PublicKey(), "node_2", &j, map[string]string{"A": "b"})
			return j
		}, sealedBuilder(), nil, "cannot open the build's secrets"},
		{"other build", func(t *testing.T) protocol.BuildJob {
			j := validJob()
			sealtest.SealBuildSecrets(t, sealtest.Key().PublicKey(), "node_1", &j, map[string]string{"A": "b"})
			j.BuildID = "bld_other"
			return j
		}, sealedBuilder(), nil, "cannot open the build's secrets"},
		{"no key on this node", func(t *testing.T) protocol.BuildJob {
			j := validJob()
			sealtest.SealBuildSecrets(t, sealtest.Key().PublicKey(), "node_1", &j, map[string]string{"A": "b"})
			return j
		}, &builder{}, nil, "no encryption key"},
		{"also a secret build arg", func(t *testing.T) protocol.BuildJob {
			j := validJob()
			j.BuildArgs["LICENSE"] = "x"
			j.SecretBuildArgs = []string{"LICENSE"}
			sealtest.SealBuildSecrets(t, sealtest.Key().PublicKey(), "node_1", &j, map[string]string{"LICENSE": "y"})
			return j
		}, sealedBuilder(), nil, "both a secret build arg and a build secret"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			j := tc.job(t)
			got, err := tc.b.openSecrets(&j)
			if tc.err != "" {
				if err == nil || !strings.Contains(err.Error(), tc.err) {
					t.Fatalf("err = %v, want %q", err, tc.err)
				}
				var ue *userError
				if !errors.As(err, &ue) {
					t.Fatalf("%v is not shown to the user", err)
				}
				return
			}
			if err != nil || len(got) != len(tc.want) || got["NPM_TOKEN"] != tc.want["NPM_TOKEN"] {
				t.Fatalf("got %v, %v; want %v", got, err, tc.want)
			}
		})
	}
}

// Sealed secrets reach BuildKit as secrets with their key as the id, and
// never as build args, for both builders.
func TestSealedSecretsAreBuildKitSecrets(t *testing.T) {
	job := validJob()
	job.BuildArgs = map[string]string{"NODE_ENV": "production", "LICENSE": "lic-value"}
	job.SecretBuildArgs = []string{"LICENSE"}
	sealed := map[string]string{"NPM_TOKEN": "npm-secret-value"}
	paths := buildPaths{context: "/w/src", dockerfileDir: "/w/src", dockerfileName: "Dockerfile"}

	df := dockerfileSolve(&job, paths, sealed)
	if string(df.secrets["NPM_TOKEN"]) != "npm-secret-value" || string(df.secrets["LICENSE"]) != "lic-value" {
		t.Fatalf("dockerfile secrets %q", df.secrets)
	}
	if _, ok := df.secrets["NODE_ENV"]; ok {
		t.Fatal("plain build arg passed as a secret to the Dockerfile frontend")
	}
	rp := railpackSolve(&job, paths, "/w/plan", RailpackFrontendImage, sealed)
	if string(rp.secrets["NPM_TOKEN"]) != "npm-secret-value" || string(rp.secrets["NODE_ENV"]) != "production" {
		t.Fatalf("railpack secrets %q", rp.secrets)
	}
	for _, spec := range []solveSpec{df, rp} {
		for k, v := range spec.attrs {
			if strings.Contains(v, "npm-secret-value") || strings.Contains(v, "lic-value") || strings.Contains(k, "NPM_TOKEN") {
				t.Fatalf("secret in frontend attr %s=%s", k, v)
			}
		}
	}
	if a := railpackSolve(&job, paths, "/w/plan", RailpackFrontendImage, map[string]string{"NPM_TOKEN": "other"}); a.attrs["build-arg:secrets-hash"] == rp.attrs["build-arg:secrets-hash"] {
		t.Fatal("a changed sealed secret must invalidate Railpack's secret layers")
	}
	if got := secretNames(&job, sealed); strings.Join(got, ",") != "LICENSE,NPM_TOKEN" {
		t.Fatalf("secret names %v", got)
	}
}

func TestJobSecretsAreRedacted(t *testing.T) {
	job := validJob()
	job.BuildArgs = map[string]string{"NODE_ENV": "production", "LICENSE": "lic-value-123"}
	job.SecretBuildArgs = []string{"LICENSE"}
	r := newRedactor("", jobSecrets(&job, map[string]string{"NPM_TOKEN": "npm-secret-value"}))
	got := r.redact("NODE_ENV=production LICENSE=lic-value-123 NPM_TOKEN=npm-secret-value")
	if want := "NODE_ENV=production LICENSE=" + redactedText + " NPM_TOKEN=" + redactedText; got != want {
		t.Fatalf("redact = %q, want %q", got, want)
	}
}
