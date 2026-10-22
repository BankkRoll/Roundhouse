package builder

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func TestPrepareArgsKeepValuesOutOfArgv(t *testing.T) {
	args := prepareArgs("/src", "/w/plan/railpack-plan.json", "/w/info.json", map[string]string{
		"B_SECRET": "value-b", "A_TOKEN": "value-a",
	})
	want := []string{"prepare", "/src", "--plan-out", "/w/plan/railpack-plan.json", "--info-out", "/w/info.json",
		"--env", "A_TOKEN", "--env", "B_SECRET"}
	if !slices.Equal(args, want) {
		t.Fatalf("args = %q", args)
	}
	env := prepareEnv("/w/home", map[string]string{"A_TOKEN": "value-a"})
	if !slices.Contains(env, "A_TOKEN=value-a") || !slices.Contains(env, "HOME=/w/home") {
		t.Fatalf("env = %q", env)
	}
}

func TestCheckRailpackArgs(t *testing.T) {
	if err := checkRailpackArgs(map[string]string{"PATH": "/evil"}); err == nil {
		t.Error("PATH accepted")
	}
	if err := checkRailpackArgs(map[string]string{"NODE_ENV": "production"}); err != nil {
		t.Error(err)
	}
}

func TestRailpackFailure(t *testing.T) {
	dir := t.TempDir()
	write := func(s string) string {
		p := filepath.Join(dir, "info.json")
		if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	cases := []struct{ info, want string }{
		{`{"success":false,"logs":[{"level":"error","msg":"Railpack could not determine how to build the app.\n\nThe following languages are supported:"}]}`,
			"Railpack could not detect a language or framework in the repository root"},
		{`{"success":false,"detectedProviders":["node"],"logs":[{"level":"warn","msg":"meh"},{"level":"error","msg":"No start command was found.\nmore"}]}`,
			"Railpack could not plan the build: No start command was found."},
		{`{"success":false,"detectedProviders":["node"]}`, "exit status 1"},
		{`not json`, "Railpack could not prepare the build (exit status 1)"},
	}
	for _, tc := range cases {
		err := railpackFailure(write(tc.info), "the repository root", 1)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("info %s: err = %v, want %q", tc.info, err, tc.want)
		}
	}
	if err := railpackFailure(filepath.Join(dir, "missing.json"), "x", railpackExitTransient); err == nil ||
		!strings.Contains(err.Error(), "temporary error") {
		t.Errorf("transient: %v", err)
	}
}

func TestRailpackPrepareRetriesTransientFailures(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs a shell script as railpack")
	}
	dir := t.TempDir()
	counter := filepath.Join(dir, "count")
	script := `#!/bin/sh
n=$(cat "` + counter + `" 2>/dev/null || echo 0)
n=$((n + 1)); echo "$n" > "` + counter + `"
[ "$n" -lt 2 ] && { echo "network blip" >&2; exit 75; }
[ "$MY_SECRET" = "s3cret" ] || { echo "secret not in env" >&2; exit 1; }
case "$*" in *s3cret*) echo "secret in argv" >&2; exit 1 ;; esac
while [ $# -gt 0 ]; do [ "$1" = --plan-out ] && echo '{}' > "$2"; shift; done
`
	bin := filepath.Join(dir, "railpack")
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	var stderr strings.Builder
	r := &railpackPlanner{bin: bin, home: filepath.Join(dir, "home"), stderr: &stderr}
	err := r.prepare(context.Background(), dir, filepath.Join(dir, "work", "plan"), "x", map[string]string{"MY_SECRET": "s3cret"})
	if err != nil {
		t.Fatalf("prepare: %v\n%s", err, stderr.String())
	}
	if b, _ := os.ReadFile(counter); strings.TrimSpace(string(b)) != "2" {
		t.Errorf("attempts = %s", b)
	}
	if !strings.Contains(stderr.String(), "retrying") {
		t.Error("retry not reported")
	}
}
