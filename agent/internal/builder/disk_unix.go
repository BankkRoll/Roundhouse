//go:build !windows

package builder

import "golang.org/x/sys/unix"

// freeBytes returns the space available to unprivileged users on the
// filesystem holding path.
func freeBytes(path string) (uint64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return 0, err
	}
	return st.Bavail * uint64(st.Bsize), nil
}
