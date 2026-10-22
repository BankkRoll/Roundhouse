package builder

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// shellVars returns the NAME=value assignments at the start of lines in a
// shell script, with surrounding double quotes removed.
func shellVars(t *testing.T, path string) map[string]string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("%s not available: %v", path, err)
	}
	vars := map[string]string{}
	re := regexp.MustCompile(`(?m)^([A-Z][A-Z0-9_]*)="?([^"\n]*)"?$`)
	for _, m := range re.FindAllStringSubmatch(string(b), -1) {
		vars[m[1]] = m[2]
	}
	return vars
}

// TestInstallScriptPins keeps the installer's builder pins in step with the
// agent: the node pre-pulls exactly the images the builder runs, and
// installs the Railpack CLI matching the frontend that consumes its plans.
func TestInstallScriptPins(t *testing.T) {
	install := shellVars(t, filepath.Join("..", "..", "..", "install", "install.sh"))
	it := shellVars(t, filepath.Join("testdata", "integration.sh"))

	checks := []struct{ name, got, want string }{
		{"BUILDKIT_IMAGE", install["BUILDKIT_IMAGE"], BuildKitImage},
		{"RAILPACK_VERSION", install["RAILPACK_VERSION"], RailpackVersion},
		{"integration RAILPACK_VERSION", it["RAILPACK_VERSION"], RailpackVersion},
		{"integration RAILPACK_SHA256_AMD64", it["RAILPACK_SHA256_AMD64"], install["RAILPACK_SHA256_AMD64"]},
		{"integration RAILPACK_SHA256_ARM64", it["RAILPACK_SHA256_ARM64"], install["RAILPACK_SHA256_ARM64"]},
		{"BUILD_BRIDGE", install["BUILD_BRIDGE"], BridgeInterface},
		{"REGISTRY_PROXY_PORT", install["REGISTRY_PROXY_PORT"], strconv.Itoa(DefaultRegistryProxyPort)},
	}
	for _, c := range checks {
		if c.got == "" || c.got != c.want {
			t.Errorf("%s = %q, want %q", c.name, c.got, c.want)
		}
	}
	if !strings.Contains(RailpackFrontendImage, ":v"+RailpackVersion+"@sha256:") {
		t.Errorf("frontend %s is not Railpack %s", RailpackFrontendImage, RailpackVersion)
	}
	for _, ref := range []string{install["BUILDKIT_IMAGE"], install["REGISTRY_IMAGE"], RailpackFrontendImage} {
		if !regexp.MustCompile(`:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$`).MatchString(ref) {
			t.Errorf("%q is not pinned by tag and digest", ref)
		}
	}
	for _, k := range []string{"RAILPACK_SHA256_AMD64", "RAILPACK_SHA256_ARM64"} {
		if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(install[k]) {
			t.Errorf("%s = %q is not a sha256", k, install[k])
		}
	}
}
