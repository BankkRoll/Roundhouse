package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestCredentialsRoundTrip(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "roundhouse")
	path := CredentialsPath(dir)
	c, warning, err := LoadCredentials(path)
	if err != nil || warning != "" || len(c.Profiles) != 0 {
		t.Fatalf("missing file: %v %q %v", c, warning, err)
	}
	exp := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	c.Profiles["default"] = &Profile{URL: "https://cp.example.com", Session: &Session{CookieName: "n", Value: "v", ExpiresAt: &exp}}
	if err := c.Save(path); err != nil {
		t.Fatal(err)
	}
	got, warning, err := LoadCredentials(path)
	if err != nil || warning != "" {
		t.Fatalf("load: %v %q", err, warning)
	}
	if s := got.Profiles["default"].Session; s.Value != "v" || !s.ExpiresAt.Equal(exp) {
		t.Errorf("session = %+v", s)
	}
	if runtime.GOOS == "windows" {
		return
	}
	for p, want := range map[string]os.FileMode{path: 0o600, dir: 0o700} {
		fi, err := os.Stat(p)
		if err != nil || fi.Mode().Perm() != want {
			t.Errorf("%s mode = %v, want %#o (%v)", p, fi.Mode().Perm(), want, err)
		}
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("temp files left behind: %v", entries)
	}
}

func TestCredentialsPermissionWarning(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no Unix mode bits on Windows")
	}
	path := CredentialsPath(t.TempDir())
	if err := os.WriteFile(path, []byte(`{"profiles":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	_, warning, err := LoadCredentials(path)
	if err != nil || !strings.Contains(warning, "readable by other users") || !strings.Contains(warning, "0644") {
		t.Errorf("warning = %q, err = %v", warning, err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, warning, _ := LoadCredentials(path); warning != "" {
		t.Errorf("0600 warned: %q", warning)
	}
}

func TestCredentialsCorrupt(t *testing.T) {
	path := CredentialsPath(t.TempDir())
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := LoadCredentials(path); err == nil {
		t.Error("corrupt file loaded")
	}
}

func TestDir(t *testing.T) {
	d, err := Dir(func(k string) string {
		if k == "ROUNDHOUSE_CONFIG_DIR" {
			return "/custom"
		}
		return ""
	})
	if err != nil || d != "/custom" {
		t.Errorf("Dir = %q, %v", d, err)
	}
	if d, err := Dir(func(string) string { return "" }); err == nil && filepath.Base(d) != "roundhouse" {
		t.Errorf("default Dir = %q", d)
	}
}

func TestLinkFindAndRemove(t *testing.T) {
	root := t.TempDir()
	if l, _, err := FindLink(root); l != nil || err != nil {
		t.Fatalf("unlinked dir: %v %v", l, err)
	}
	if _, err := WriteLink(root, &Link{URL: "https://cp", ProjectID: "prj_1"}); err != nil {
		t.Fatal(err)
	}
	deep := filepath.Join(root, "a", "b")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	l, path, err := FindLink(deep)
	if err != nil || l.ProjectID != "prj_1" || path != filepath.Join(root, LinkDirName, LinkFileName) {
		t.Fatalf("FindLink = %+v %q %v", l, path, err)
	}
	if err := RemoveLink(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, LinkDirName)); !os.IsNotExist(err) {
		t.Error("empty .roundhouse left behind")
	}
}

func TestGitignore(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".gitignore")
	if ok, err := GitignoreHasEntry(path); ok || err != nil {
		t.Fatalf("missing file: %v %v", ok, err)
	}
	if err := os.WriteFile(path, []byte("dist\r\nnode_modules"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := AppendGitignore(path); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "dist\r\nnode_modules\r\n# Roundhouse link (project and service IDs)\r\n.roundhouse/\r\n" {
		t.Errorf(".gitignore = %q", data)
	}
	for _, line := range []string{".roundhouse", "/.roundhouse/", "  .roundhouse/  "} {
		if err := os.WriteFile(path, []byte("x\n"+line+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if ok, _ := GitignoreHasEntry(path); !ok {
			t.Errorf("%q not recognised", line)
		}
	}
	if GitignorePath(dir) != path {
		t.Errorf("GitignorePath outside git = %q", GitignorePath(dir))
	}
}
