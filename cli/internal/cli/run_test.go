package cli

import (
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
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("%s = %q, want %q", k, env[k], v)
		}
	}
	// Only what the service needs is revealed: never db's unused secret.
	var revealed []string
	for _, keys := range h.fake.Reveals() {
		revealed = append(revealed, keys...)
	}
	slices.Sort(revealed)
	if !reflect.DeepEqual(revealed, []string{"API_KEY", "POSTGRES_PASSWORD"}) {
		t.Errorf("revealed %v", revealed)
	}
	contains(t, r.stderr, "warning: injecting 10 variables from API (production) into `node`; 2 secrets were revealed (audited)")
	contains(t, r.stderr, "never written to disk")
	notContains(t, r.stdout+r.stderr, apitest.SecretValue)

	// Nothing but the credentials file is written.
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
	contains(t, r.stderr, "cannot resolve the variables of API")
	contains(t, r.stderr, "loop")
	contains(t, r.stderr, `No service "ghost"`)
	if h.execArgv != nil {
		t.Error("ran the command despite resolution errors")
	}
}

func TestRunOtherService(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.ok("", "run", "--service", "db", "--", "psql")
	env := envMap(h.execEnv)
	if env["POSTGRES_PASSWORD"] != "pg-secret-password" || env["PORT"] != "5432" || env["OPENRAIL_PRIVATE_DOMAIN"] != "db.production.internal" {
		t.Errorf("db env = %v", env)
	}
}
