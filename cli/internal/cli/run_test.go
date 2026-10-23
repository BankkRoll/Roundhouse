package cli

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

func envMap(env []string) map[string]string {
	m := map[string]string{}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		m[k] = v
	}
	return m
}

func TestRunInjectsResolvedVariables(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "run", "--", "node", "server.js", "--port", "3000")
	if !reflect.DeepEqual(h.execArgv, []string{"node", "server.js", "--port", "3000"}) {
		t.Errorf("argv = %v", h.execArgv)
	}
	env := envMap(h.execEnv)
	want := map[string]string{
		"PATH":                      "/usr/bin",
		"NODE_ENV":                  "production",
		"REGION":                    "eu-west",
		"LISTEN":                    "0.0.0.0:8080",
		"PORT":                      "8080",
		"ROUNDHOUSE_PUBLIC_DOMAIN":  "api-production-x7k2.apps.example.com",
		"ROUNDHOUSE_PRIVATE_DOMAIN": "api.production.internal",
		"ROUNDHOUSE_ENVIRONMENT":    "production",
		"ROUNDHOUSE_SERVICE_NAME":   "API",
		"ROUNDHOUSE_DEPLOYMENT_ID":  apitest.ActiveDeploy,
		"ROUNDHOUSE_GIT_COMMIT_SHA": strings.Repeat("a", 40),
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("%s = %q, want %q", k, env[k], v)
		}
	}
	// API_KEY is secret and DATABASE_URL embeds db's secret password: the
	// control plane names both but sends neither.
	for _, k := range []string{"API_KEY", "DATABASE_URL"} {
		if v, ok := env[k]; ok {
			t.Errorf("%s = %q was injected without an env file", k, v)
		}
	}
	// The child's environment is the process's, then the variables sorted.
	if h.execEnv[0] != "PATH=/usr/bin" || !slices.IsSortedFunc(h.execEnv[2:], strings.Compare) {
		t.Errorf("env order = %v", h.execEnv)
	}

	// One audited resolve call, no reveals and no client-side resolution.
	var resolves int
	for _, req := range h.fake.Requests() {
		switch req.Pattern {
		case "GET /v1/services/{serviceId}/variables/resolved":
			resolves++
			if req.Path != "/v1/services/svc_api/variables/resolved" || req.Query != "environment_id="+apitest.ProductionID || req.Body != "" {
				t.Errorf("resolve request = %+v", req)
			}
		case "POST /v1/services/{serviceId}/variables/reveal", "GET /v1/services/{serviceId}/variables", "GET /v1/projects/{projectId}/variables":
			t.Errorf("run fetched %s; the control plane resolves", req.Pattern)
		}
	}
	if resolves != 1 || len(h.fake.Reveals()) != 0 {
		t.Errorf("%d resolve calls, %d reveals", resolves, len(h.fake.Reveals()))
	}
	contains(t, r.stderr, "warning: .env does not set 2 secret variables, which the control plane never sends: API_KEY, DATABASE_URL")
	contains(t, r.stderr, "warning: injecting 10 variables from API (production) into `node`; resolved by the control plane (audited)")
	contains(t, r.stderr, "never written to disk")
	notContains(t, r.stdout+r.stderr, apitest.SecretValue)
	notContains(t, strings.Join(h.execEnv, " "), "pg-secret-password")

	// Nothing but the credentials file and the link is written.
	var files []string
	for _, dir := range []string{h.configDir, h.dir} {
		_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				files = append(files, filepath.Base(path))
			}
			return nil
		})
	}
	slices.Sort(files)
	if !reflect.DeepEqual(files, []string{"config.json", "credentials.json"}) {
		t.Errorf("files on disk: %v", files)
	}
}

func TestRunTakesSecretsFromEnvFile(t *testing.T) {
	h := newHarness(t)
	h.link()
	dotenv := "API_KEY=local-key\nDATABASE_URL=postgres://localhost/shop\nNODE_ENV=development\n"
	if err := os.WriteFile(filepath.Join(h.dir, ".env"), []byte(dotenv), 0o600); err != nil {
		t.Fatal(err)
	}
	r := h.ok("", "run", "--", "env")
	env := envMap(h.execEnv)
	// The file supplies only the keys the control plane leaves local.
	for k, v := range map[string]string{"API_KEY": "local-key", "DATABASE_URL": "postgres://localhost/shop", "NODE_ENV": "production"} {
		if env[k] != v {
			t.Errorf("%s = %q, want %q", k, env[k], v)
		}
	}
	notContains(t, r.stderr, "does not set")
	contains(t, r.stderr, "injecting 12 variables from API (production) (2 secrets from .env) into `env`")

	if err := os.WriteFile(filepath.Join(h.dir, "local.env"), []byte("API_KEY=other\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	r = h.ok("", "run", "--env-file", "local.env", "--", "env")
	if env := envMap(h.execEnv); env["API_KEY"] != "other" {
		t.Errorf("API_KEY = %q from --env-file", env["API_KEY"])
	}
	contains(t, r.stderr, "warning: local.env does not set 1 secret variable, which the control plane never sends: DATABASE_URL")

	h.execArgv = nil
	r = h.expect(exitcode.Usage, "", "run", "--env-file", "missing.env", "--", "env")
	contains(t, r.stderr, "missing.env")
	if h.execArgv != nil {
		t.Error("ran the command despite a missing --env-file")
	}
	if err := os.WriteFile(filepath.Join(h.dir, "bad.env"), []byte("not an assignment\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	h.expect(exitcode.Usage, "", "run", "--env-file", "bad.env", "--", "env")
}

func TestRunExitCode(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.execCode = 3
	r := h.run("", "run", "--", "false")
	if r.code != 3 {
		t.Errorf("exit %d, want the child's 3", r.code)
	}
	notContains(t, r.stderr, "error:")
	h.expect(exitcode.Usage, "", "run")
	// Flags after the command belong to the command.
	h.execCode = 0
	h.ok("", "run", "npm", "--version")
	if !reflect.DeepEqual(h.execArgv, []string{"npm", "--version"}) {
		t.Errorf("argv = %v", h.execArgv)
	}
}

func TestRunResolutionErrors(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.ok("", "vars", "set", "LOOP_A=${{LOOP_B}}", "LOOP_B=${{LOOP_A}}", "GHOST=${{ghost.X}}")
	r := h.expect(exitcode.Invalid, "", "run", "--", "env")
	h.golden("run-invalid-reference.txt", r.stderr)
	if h.execArgv != nil {
		t.Error("ran the command despite resolution errors")
	}

	r = h.expect(exitcode.Invalid, "", "run", "--json", "--", "env")
	contains(t, r.stderr, `"code": "invalid_reference"`)
	contains(t, r.stderr, `"field": "api.GHOST"`)
}

func TestRunOtherService(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "run", "--service", "db", "--", "psql")
	contains(t, r.stderr, "POSTGRES_PASSWORD, UNUSED_SECRET")
	env := envMap(h.execEnv)
	if env["PORT"] != "5432" || env["ROUNDHOUSE_PRIVATE_DOMAIN"] != "db.production.internal" {
		t.Errorf("db env = %v", env)
	}
	if _, ok := env["POSTGRES_PASSWORD"]; ok {
		t.Error("a secret was injected without an env file")
	}
	if _, ok := env["ROUNDHOUSE_DEPLOYMENT_ID"]; ok {
		t.Error("db has no live deployment, so no deployment built-ins")
	}
}

// oldControlPlane answers the resolve route as an API that predates it.
type oldControlPlane struct{}

func (oldControlPlane) RoundTrip(req *http.Request) (*http.Response, error) {
	if strings.HasSuffix(req.URL.Path, "/variables/resolved") {
		body := `{"error":{"code":"not_found","message":"No such endpoint"}}`
		return &http.Response{StatusCode: http.StatusNotFound, Header: http.Header{"Content-Type": {"application/json"}},
			Body: io.NopCloser(strings.NewReader(body)), Request: req}, nil
	}
	return http.DefaultTransport.RoundTrip(req)
}

func TestRunOnOlderControlPlane(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.transport = oldControlPlane{}
	r := h.expect(exitcode.Unavailable, "", "run", "--", "env")
	contains(t, r.stderr, "cannot resolve variables for `roundhouse run`")
	contains(t, r.stderr, "upgrade the control plane")
	if h.execArgv != nil {
		t.Error("ran the command without its variables")
	}
}

func TestRunNeedsReadPlainScope(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.env[EnvToken] = h.fake.AddToken("ci", "workspace:read", "projects:read", "services:read", "variables:read")
	r := h.expect(exitcode.Forbidden, "", "run", "--", "env")
	contains(t, r.stderr, "lacks the variables:read_plain scope")
	contains(t, r.stderr, "hint: the API token lacks a scope")
}
