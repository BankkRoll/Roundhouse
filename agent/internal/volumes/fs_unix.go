//go:build unix

package volumes

import (
	"io/fs"
	"os"
	"syscall"
)

type fileID struct{ dev, ino uint64 }

// fileIdentity identifies a multiply-linked file, so it is counted once.
func fileIdentity(info fs.FileInfo) (fileID, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || st.Nlink < 2 || info.IsDir() {
		return fileID{}, false
	}
	return fileID{uint64(st.Dev), uint64(st.Ino)}, true
}

// allocated is the space a file takes on disk, which for sparse files is
// less than its size.
func allocated(info fs.FileInfo) int64 {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return int64(st.Blocks) * 512
	}
	return info.Size()
}

func chown(path string, uid, gid int) error { return os.Lchown(path, uid, gid) }
