package certs

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestInstallerPreparesDefaultDir keeps install/ in step with [DefaultDir]:
// the installer creates it for Caddy's group, and the agent's unit lets the
// sandboxed agent write to it.
func TestInstallerPreparesDefaultDir(t *testing.T) {
	root := filepath.Join("..", "..", "..", "install")
	script, err := os.ReadFile(filepath.Join(root, "install.sh"))
	if err != nil {
		t.Skipf("install.sh not available: %v", err)
	}
	m := regexp.MustCompile(`(?m)^CERTS_DIR=(\S+)$`).FindSubmatch(script)
	if m == nil || string(m[1]) != DefaultDir {
		t.Errorf("install.sh CERTS_DIR = %q, want %s", m, DefaultDir)
	}
	if !strings.Contains(string(script), `install -d -m 2750 -o root -g `+DefaultGroup+` "$CERTS_DIR"`) {
		t.Errorf("install.sh does not create the directory root:%s 2750", DefaultGroup)
	}
	unit, err := os.ReadFile(filepath.Join(root, "roundhouse-agent.service"))
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`(?m)^ReadWritePaths=-` + regexp.QuoteMeta(DefaultDir) + `$`).Match(unit) {
		t.Errorf("roundhouse-agent.service does not make %s writable", DefaultDir)
	}
}
