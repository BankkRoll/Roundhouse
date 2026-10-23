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

	"github.com/BankkRoll/Open-Rail/cli/internal/apitest"
	"github.com/BankkRoll/Open-Rail/cli/internal/exitcode"
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
		"PATH":                    "/usr/bin",
		"NODE_ENV":                "production",
		"DATABASE_URL":            "postgres://app:pg-secret-password@db.production.internal:5432/shop",
		"API_KEY":                 apitest.SecretValue,
		"REGION":                  "eu-west",
		"LISTEN":                  "0.0.0.0:8080",
		"PORT":                    "8080",
		"OPENRAIL_PUBLIC_DOMAIN":  "api-production-x7k2.apps.example.com",
		"OPENRAIL_PRIVATE_DOMAIN": "api.production.internal",
		"OPENRAIL_ENVIRONMENT":    "production",
		"OPENRAIL_SERVICE_NAME":   "API",
		"OPENRAIL_DEPLOYMENT_ID":  apitest.ActiveDeploy,
		"OPENRAIL_GIT_COMMIT_SHA": strings.Repeat("a", 40),
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("%s = %q, want %q", k, env[k], v)
		}
	}
	// The child's environment is the process's, then the resolved variables
	// in the API's (sorted) order.
	if h.execEnv[0] != "PATH=/usr/bin" || !slices.IsSortedFunc(h.execEnv[2:], strings.Compare) {
		t.Errorf("env order = %v", h.execEnv)
	}

	// One audited resolve call, no reveals and no client-side resolution.
	var resolves int
	for _, req := range h.fake.Requests() {
		switch req.Pattern {
		case "POST /v1/services/{serviceId}/variables/resolve":
			resolves++
			if req.Path != "/v1/services/svc_api/variables/resolve" || req.Query != "environment_id="+apitest.ProductionID || req.Body != "" {
				t.Errorf("resolve request = %+v", req)
			}
		case "POST /v1/services/{serviceId}/variables/reveal", "GET /v1/services/{serviceId}/variables", "GET /v1/projects/{projectId}/variables":
			t.Errorf("run fetched %s; the control plane resolves", req.Pattern)
		}
	}
	if resolves != 1 || len(h.fake.Reveals()) != 0 {
		t.Errorf("%d resolve calls, %d reveals", resolves, len(h.fake.Reveals()))
	}
	contains(t, r.stderr, "warning: injecting 12 variables from API (production) into `node`; resolved by the control plane (audited)")
	contains(t, r.stderr, "never written to disk")
	notContains(t, r.stdout+r.stderr, apitest.SecretValue)

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
	for _, dir := range []string{h.configDir, h.dir} {
		_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
			if data, err := os.ReadFile(path); err == nil && strings.Contains(string(data), "pg-secret-password") {
				t.Errorf("%s contains a secret", path)
			}
			return nil
		})
	}
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
	h.ok("", "run", "--service", "db", "--", "psql")
	env := envMap(h.execEnv)
	if env["POSTGRES_PASSWORD"] != "pg-secret-password" || env["PORT"] != "5432" || env["OPENRAIL_PRIVATE_DOMAIN"] != "db.production.internal" {
		t.Errorf("db env = %v", env)
	}
	if _, ok := env["OPENRAIL_DEPLOYMENT_ID"]; ok {
		t.Error("db has no live deployment, so no deployment built-ins")
	}
}

// oldControlPlane answers the resolve route as an API that predates it.
type oldControlPlane struct{}

func (oldControlPlane) RoundTrip(req *http.Request) (*http.Response, error) {
	if strings.HasSuffix(req.URL.Path, "/variables/resolve") {
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

func TestRunNeedsRevealScope(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.env[EnvToken] = h.fake.AddToken("ci", "workspace:read", "projects:read", "services:read", "variables:read")
	r := h.expect(exitcode.Forbidden, "", "run", "--", "env")
	contains(t, r.stderr, "lacks the variables:reveal scope")
	contains(t, r.stderr, "hint: the API token lacks a scope")
}
