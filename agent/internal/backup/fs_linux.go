//go:build linux

package backup

import (
	"errors"
	"io/fs"
	"os"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

type fileID struct{ dev, ino uint64 }

func fileIdentity(info fs.FileInfo) (fileID, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fileID{}, false
	}
	return fileID{uint64(st.Dev), st.Ino}, true
}

func linkCount(info fs.FileInfo) uint64 {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Nlink)
	}
	return 1
}

func lchown(path string, uid, gid int) error { return os.Lchown(path, uid, gid) }

// ownerOf returns the uid and gid that own a file.
func ownerOf(info fs.FileInfo) (uid, gid int, ok bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, false
	}
	return int(st.Uid), int(st.Gid), true
}

// listXattrs reads every extended attribute of path, without following a
// symlink. A filesystem without xattr support has none.
func listXattrs(path string) (map[string]string, error) {
	size, err := unix.Llistxattr(path, nil)
	if err != nil {
		if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EOPNOTSUPP) {
			return nil, nil
		}
		return nil, err
	}
	if size == 0 {
		return nil, nil
	}
	buf := make([]byte, size)
	size, err = unix.Llistxattr(path, buf)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, name := range strings.Split(strings.TrimRight(string(buf[:size]), "\x00"), "\x00") {
		if name == "" {
			continue
		}
		n, err := unix.Lgetxattr(path, name, nil)
		if errors.Is(err, unix.ENODATA) {
			continue
		}
		if err != nil {
			return nil, err
		}
		val := make([]byte, n)
		if n, err = unix.Lgetxattr(path, name, val); err != nil {
			return nil, err
		}
		out[name] = string(val[:n])
	}
	return out, nil
}

// setXattr sets one attribute. A target filesystem without xattr support
// drops it, as tar does.
func setXattr(path, name, value string) error {
	err := unix.Lsetxattr(path, name, []byte(value), 0)
	if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EOPNOTSUPP) {
		return nil
	}
	return err
}
