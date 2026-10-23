package builder

import (
	"errors"
	"strings"
	"testing"
)

func TestIsReservedEnvName(t *testing.T) {
	for _, tc := range []struct {
		name     string
		reserved bool
	}{
		{"PATH", true},
		{"path", true},
		{"HOME", true},
		{"LD_PRELOAD", true},
		{"LD_LIBRARY_PATH", true},
		{"DYLD_INSERT_LIBRARIES", true},
		{"GIT_SSH_COMMAND", true},
		{"GIT_CONFIG_GLOBAL", true},
		{"SSL_CERT_FILE", true},
		{"HTTPS_PROXY", true},
		{"https_proxy", true},
		{"ALL_PROXY", true},
		{"BASH_ENV", true},
		{"XDG_CONFIG_HOME", true},
		{"MISE_DATA_DIR", true},
		{"GODEBUG", true},
		{"NODE_ENV", false},
		{"RAILPACK_BUILD_CMD", false},
		{"NPM_TOKEN", false},
		{"PATHFINDER_URL", false},
		{"GITHUB_TOKEN", false},
		{"HOMEPAGE_URL", false},
	} {
		if got := isReservedEnvName(tc.name); got != tc.reserved {
			t.Errorf("isReservedEnvName(%q) = %v, want %v", tc.name, got, tc.reserved)
		}
	}
}

func TestCheckPrepareEnvNamesRefusesReserved(t *testing.T) {
	if err := checkPrepareEnvNames(map[string]string{"NODE_ENV": "production", "NPM_TOKEN": "x"}); err != nil {
		t.Fatalf("ordinary names refused: %v", err)
	}
	err := checkPrepareEnvNames(map[string]string{"PATH": "/evil", "LD_PRELOAD": "./x.so", "OK": "1"})
	var ue *userError
	if !errors.As(err, &ue) {
		t.Fatalf("err = %v, want a user error", err)
	}
	if msg := err.Error(); !strings.Contains(msg, "LD_PRELOAD, PATH") || strings.Contains(msg, "OK") {
		t.Fatalf("message = %q", msg)
	}
}

func TestHostEnvPassesOperatorProxy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://proxy.internal:3128")
	t.Setenv("GIT_SSH_COMMAND", "evil")
	env := strings.Join(hostEnv(), "\n")
	if !strings.Contains(env, "HTTPS_PROXY=http://proxy.internal:3128") {
		t.Fatalf("proxy not inherited: %q", env)
	}
	if strings.Contains(env, "GIT_SSH_COMMAND") {
		t.Fatalf("GIT_SSH_COMMAND leaked: %q", env)
	}
}
