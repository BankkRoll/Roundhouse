//go:build !windows

package certs

import (
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"os/user"
	"strconv"
	"syscall"
)

// prepareDir creates dir if needed and checks that Caddy, running as group,
// can read the files written in it: the directory must belong to that group
// and carry the setgid bit, so every file created in it is group-owned too
// without the agent needing CAP_CHOWN, which its unit does not grant.
//
// Without the group (Caddy runs as root, or a development machine) the
// directory is owner-only. A directory that is set up wrongly is reported,
// not fatal: certificates still verify and are stored, and fixing the
// ownership makes them load.
func prepareDir(dir, group string, log *slog.Logger) error {
	gid := -1
	if g, err := user.LookupGroup(group); err == nil {
		if n, err := strconv.Atoi(g.Gid); err == nil {
			gid = n
		}
	}
	want := fs.FileMode(0o700)
	if gid >= 0 {
		want = 0o750 | fs.ModeSetgid
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	fi, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return errors.New("not a directory")
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if gid >= 0 && ok && int(st.Gid) != gid {
		// NOTE: this needs CAP_CHOWN, which install.sh does not give the
		// agent; it creates the directory with the right group instead.
		if err := os.Chown(dir, -1, gid); err != nil {
			log.Error("Caddy cannot read certificates: the directory is not group "+group+
				"; run: chown root:"+group+" "+dir+" && chmod 2750 "+dir, "dir", dir, "err", err)
			return nil
		}
	}
	if fi.Mode()&(fs.ModePerm|fs.ModeSetgid) != want {
		if err := os.Chmod(dir, want); err != nil {
			log.Error("set certificates directory mode", "dir", dir, "mode", want.String(), "err", err)
		}
	}
	return nil
}
