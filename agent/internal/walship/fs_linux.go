//go:build linux

package walship

import (
	"io/fs"
	"os"
	"syscall"
)

func lchown(path string, uid, gid int) error { return os.Lchown(path, uid, gid) }

func ownerOf(info fs.FileInfo) (uid, gid int, ok bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, false
	}
	return int(st.Uid), int(st.Gid), true
}
