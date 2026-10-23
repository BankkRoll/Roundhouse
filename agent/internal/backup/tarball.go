package backup

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// xattrPrefix is how PAX records carry extended attributes (GNU tar and
// Go's archive/tar both read it).
const xattrPrefix = "SCHILY.xattr."

// writeTar walks root and writes its tree to w: directories, regular files,
// symlinks and hard links with their owners, modes, times and extended
// attributes. Sockets, FIFOs and devices are skipped and reported through
// skipped. Entry names are relative to root, parents first.
func writeTar(w io.Writer, root string, skipped func(name string)) error {
	tw := tar.NewWriter(w)
	links := map[fileID]string{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		var target string
		switch mode := info.Mode(); {
		case mode.IsDir(), mode.IsRegular():
		case mode&fs.ModeSymlink != 0:
			if target, err = os.Readlink(p); err != nil {
				return err
			}
		default:
			if skipped != nil {
				skipped(name)
			}
			return nil
		}
		hdr, err := tar.FileInfoHeader(info, target)
		if err != nil {
			return err
		}
		hdr.Name = name
		if info.IsDir() {
			hdr.Name += "/"
		}
		if name == "." {
			if !info.IsDir() {
				return fmt.Errorf("%s is not a directory", root)
			}
			hdr.Name = "./"
		}
		hdr.Uname, hdr.Gname = "", ""
		hdr.Format = tar.FormatPAX
		hdr.ModTime = info.ModTime().Truncate(time.Microsecond)
		hdr.AccessTime, hdr.ChangeTime = time.Time{}, time.Time{}
		if info.Mode().IsRegular() {
			if id, ok := fileIdentity(info); ok && linkCount(info) > 1 {
				if first, seen := links[id]; seen {
					hdr.Typeflag, hdr.Linkname, hdr.Size = tar.TypeLink, first, 0
				} else {
					links[id] = name
				}
			}
		}
		xattrs, err := listXattrs(p)
		if err != nil {
			return fmt.Errorf("%s: extended attributes: %w", name, err)
		}
		for k, v := range xattrs {
			if hdr.PAXRecords == nil {
				hdr.PAXRecords = map[string]string{}
			}
			hdr.PAXRecords[xattrPrefix+k] = v
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if hdr.Typeflag == tar.TypeReg {
			f, err := os.Open(p)
			if err != nil {
				return err
			}
			n, err := io.Copy(tw, io.LimitReader(f, hdr.Size))
			f.Close()
			if err != nil {
				return err
			}
			if n != hdr.Size {
				return fmt.Errorf("%s: changed size while being read", name)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	return tw.Close()
}

// extractTar unpacks a tar written by [writeTar] into dir, which must be
// empty. It returns the bytes of file content written.
//
// SECURITY: the archive comes out of object storage. Every name must be a
// clean relative path, and every entry's parent a directory this extraction
// created itself, so no entry can be written through a symlink or outside
// dir. Hard links may only name regular files extracted before them.
func extractTar(r io.Reader, dir string) (int64, error) {
	tr := tar.NewReader(r)
	dirs := map[string]bool{".": true}
	files := map[string]bool{}
	type dirTimes struct {
		path  string
		mtime time.Time
	}
	var fixups []dirTimes
	var total int64
	first := true
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return total, err
		}
		name := strings.TrimSuffix(hdr.Name, "/")
		root := first && name == "." && hdr.Typeflag == tar.TypeDir
		first = false
		if !root && (name == "" || name == "." || path.IsAbs(name) || path.Clean(name) != name || name == ".." ||
			strings.HasPrefix(name, "../") || strings.ContainsRune(name, 0) || strings.Contains(name, `\`)) {
			return total, fmt.Errorf("unsafe entry name %q", hdr.Name)
		}
		if !dirs[path.Dir(name)] {
			return total, fmt.Errorf("entry %q: parent is not a directory of this archive", name)
		}
		if !root && (dirs[name] || files[name]) {
			return total, fmt.Errorf("entry %q: duplicate", name)
		}
		target := filepath.Join(dir, filepath.FromSlash(name))
		mode := fs.FileMode(hdr.Mode).Perm()
		if hdr.Mode&0o4000 != 0 {
			mode |= fs.ModeSetuid
		}
		if hdr.Mode&0o2000 != 0 {
			mode |= fs.ModeSetgid
		}
		if hdr.Mode&0o1000 != 0 {
			mode |= fs.ModeSticky
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if root {
				fixups = append(fixups, dirTimes{target, hdr.ModTime})
				break
			}
			if err := os.Mkdir(target, 0o700); err != nil {
				return total, err
			}
			dirs[name] = true
			fixups = append(fixups, dirTimes{target, hdr.ModTime})
		case tar.TypeReg:
			f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err != nil {
				return total, err
			}
			n, err := io.Copy(f, tr)
			if cerr := f.Close(); err == nil {
				err = cerr
			}
			total += n
			if err != nil {
				return total, err
			}
			files[name] = true
		case tar.TypeSymlink:
			if hdr.Linkname == "" || strings.ContainsRune(hdr.Linkname, 0) {
				return total, fmt.Errorf("entry %q: invalid symlink", name)
			}
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				return total, err
			}
			// A symlink is never a parent: it is in neither set.
			if err := lchown(target, hdr.Uid, hdr.Gid); err != nil {
				return total, err
			}
			continue
		case tar.TypeLink:
			if !files[hdr.Linkname] {
				return total, fmt.Errorf("entry %q: hard link to %q, which is not an earlier file", name, hdr.Linkname)
			}
			if err := os.Link(filepath.Join(dir, filepath.FromSlash(hdr.Linkname)), target); err != nil {
				return total, err
			}
			files[name] = true
			continue
		default:
			return total, fmt.Errorf("entry %q: unsupported type %q", name, hdr.Typeflag)
		}
		if err := lchown(target, hdr.Uid, hdr.Gid); err != nil {
			return total, err
		}
		for k, v := range hdr.PAXRecords {
			if attr, ok := strings.CutPrefix(k, xattrPrefix); ok {
				if err := setXattr(target, attr, v); err != nil {
					return total, fmt.Errorf("%s: extended attribute %s: %w", name, attr, err)
				}
			}
		}
		// NOTE: chmod after chown, which clears setuid and setgid bits.
		if err := os.Chmod(target, mode); err != nil {
			return total, err
		}
		if hdr.Typeflag == tar.TypeReg {
			if err := os.Chtimes(target, hdr.ModTime, hdr.ModTime); err != nil {
				return total, err
			}
		}
	}
	// Directory times last: creating their entries changed them.
	for i := len(fixups) - 1; i >= 0; i-- {
		if err := os.Chtimes(fixups[i].path, fixups[i].mtime, fixups[i].mtime); err != nil {
			return total, err
		}
	}
	return total, nil
}
