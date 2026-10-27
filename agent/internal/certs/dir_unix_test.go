//go:build !windows

package certs

import (
	"io/fs"
	"log/slog"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
)

// ownGroup returns the name of the test process's group.
func ownGroup(t *testing.T) string {
	t.Helper()
	g, err := user.LookupGroupId(strconv.Itoa(os.Getgid()))
	if err != nil {
		t.Skipf("no name for gid %d: %v", os.Getgid(), err)
	}
	return g.Name
}

// recordChmod replaces chmod for the test and returns the modes it was
// called with; it fails like the agent unit's RestrictSUIDSGID does.
func recordChmod(t *testing.T) *[]fs.FileMode {
	t.Helper()
	var calls []fs.FileMode
	chmod = func(_ string, m fs.FileMode) error {
		calls = append(calls, m)
		return syscall.EPERM
	}
	t.Cleanup(func() { chmod = os.Chmod })
	return &calls
}

// TestPrepareDirLeavesAnInstalledDirAlone: the directory install.sh creates
// (the group, 2750) needs no chmod, which the agent's sandbox would refuse
// because it sets the setgid bit.
func TestPrepareDirLeavesAnInstalledDirAlone(t *testing.T) {
	group := ownGroup(t)
	dir := filepath.Join(t.TempDir(), "certs")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o750|fs.ModeSetgid); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(dir); fi.Mode()&fs.ModeSetgid == 0 {
		t.Skip("the file system does not keep the setgid bit")
	}
	calls := recordChmod(t)
	if err := prepareDir(dir, group, slog.New(slog.DiscardHandler)); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 0 {
		t.Fatalf("chmod called with %v on a directory set up by install.sh", *calls)
	}
}

// TestPrepareDirReportsAModeItCannotFix: a refused chmod is logged, not
// fatal.
func TestPrepareDirReportsAModeItCannotFix(t *testing.T) {
	group := ownGroup(t)
	dir := filepath.Join(t.TempDir(), "certs")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	calls := recordChmod(t)
	if err := prepareDir(dir, group, slog.New(slog.DiscardHandler)); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0] != 0o750|fs.ModeSetgid {
		t.Fatalf("chmod calls = %v, want one with 2750", *calls)
	}
	if got := octal(0o750 | fs.ModeSetgid); got != "2750" {
		t.Fatalf("octal = %q", got)
	}
}

// TestPrepareDirWithoutTheGroup keeps the directory owner-only.
func TestPrepareDirWithoutTheGroup(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "certs")
	if err := prepareDir(dir, "roundhouse-no-such-group", slog.New(slog.DiscardHandler)); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode()&(fs.ModePerm|fs.ModeSetgid) != 0o700 {
		t.Fatalf("mode %v", fi.Mode())
	}
}
