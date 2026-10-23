// Package atomicfile writes files so that readers, including the agent after
// a crash or power loss, see either the old contents or the new ones, never a
// truncated mix.
package atomicfile

import (
	"os"
	"path/filepath"
)

// Write replaces path with data via a synced temp file and rename, creating
// parent directories with mode 0700 if needed.
//
// The parent directory is synced after the rename so the new directory entry
// itself survives a crash.
//
// NOTE: perm is applied to the temp file before any data is written, so a
// secret is never briefly world-readable. On Windows perm is mostly ignored.
func Write(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)

	if err := f.Chmod(perm); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := rename(tmp, path); err != nil {
		return err
	}
	return syncDir(dir)
}
