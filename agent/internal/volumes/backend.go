package volumes

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
)

// backend provides one quota mode's filesystem operations. dir is the
// volume's mount directory, <root>/mnt/<id>.
type backend interface {
	// create makes the volume's filesystem and mounts it at dir. It is
	// called again after a failed attempt and must start over cleanly.
	create(ctx context.Context, id, dir string, sizeMB int) error
	// mount mounts an existing volume at dir unless it already is.
	mount(ctx context.Context, id, dir string) error
	// grow raises the volume's quota online.
	grow(ctx context.Context, id, dir string, sizeMB int) error
	// remove unmounts the volume and deletes what backs it, but not dir.
	remove(ctx context.Context, id, dir string) error
	// usage returns the volume's capacity and used bytes.
	usage(id, dir string, sizeMB int) (size, used int64, err error)
}

// noneBackend keeps a volume as a plain directory under the root, with no
// quota enforcement; usage is still measured.
type noneBackend struct{}

func (noneBackend) create(_ context.Context, _, dir string, _ int) error {
	return os.MkdirAll(dir, 0o700)
}

func (noneBackend) mount(_ context.Context, _, dir string) error {
	_, err := os.Stat(dir)
	return err
}

func (noneBackend) grow(context.Context, string, string, int) error { return nil }

func (noneBackend) remove(context.Context, string, string) error { return nil }

func (noneBackend) usage(_, dir string, sizeMB int) (int64, int64, error) {
	used, err := diskUsage(dir)
	return int64(sizeMB) << 20, used, err
}

// diskUsage sums the allocated size of every file under dir, without
// following symlinks and counting hard links once.
func diskUsage(dir string) (int64, error) {
	var total int64
	seen := map[fileID]bool{}
	err := filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			// A file removed mid-walk is not an error worth failing over.
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if id, ok := fileIdentity(info); ok {
			if seen[id] {
				return nil
			}
			seen[id] = true
		}
		total += allocated(info)
		return nil
	})
	return total, err
}
