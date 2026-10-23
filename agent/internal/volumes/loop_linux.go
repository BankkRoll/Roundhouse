package volumes

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// loopBackend backs each volume with a sparse ext4 image under
// <root>/images, attached to a loop device and mounted noatime, nodev,
// nosuid. The image's size is the quota; it grows online.
type loopBackend struct {
	images    string
	mkfs      string
	resize2fs string
}

// newLoopBackend returns the loop backend when the host can provide it:
// root, /dev/loop-control (Linux 3.1+), mkfs.ext4 and resize2fs.
func newLoopBackend(images string) (backend, error) {
	if os.Geteuid() != 0 {
		return nil, errors.New("loop volumes need the agent to run as root")
	}
	if _, err := os.Stat("/dev/loop-control"); err != nil {
		return nil, fmt.Errorf("loop volumes need /dev/loop-control: %w", err)
	}
	mkfs, err := exec.LookPath("mkfs.ext4")
	if err != nil {
		return nil, errors.New("loop volumes need mkfs.ext4 (e2fsprogs)")
	}
	resize, err := exec.LookPath("resize2fs")
	if err != nil {
		return nil, errors.New("loop volumes need resize2fs (e2fsprogs)")
	}
	return &loopBackend{images: images, mkfs: mkfs, resize2fs: resize}, nil
}

func (l *loopBackend) image(id string) string { return filepath.Join(l.images, id+".img") }

func (l *loopBackend) create(ctx context.Context, id, dir string, sizeMB int) error {
	if err := os.MkdirAll(l.images, 0o700); err != nil {
		return err
	}
	img := l.image(id)
	if src, ok, err := mountSource(dir); err != nil {
		return err
	} else if ok {
		// An earlier attempt got as far as mounting. Nothing has used the
		// volume yet (it was never recorded as created), so start over.
		if err := unix.Unmount(dir, 0); err != nil {
			return fmt.Errorf("unmount %s (%s): %w", dir, src, err)
		}
	}
	if err := os.Remove(img); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	f, err := os.OpenFile(img, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	err = f.Truncate(int64(sizeMB) << 20)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = run(ctx, l.mkfs, "-q", "-F", "-m", "0", "-L", label(id), img)
	}
	if err == nil {
		err = l.mount(ctx, id, dir)
	}
	if err != nil {
		_ = os.Remove(img)
		return err
	}
	return nil
}

// label is an ext4 volume label (at most 16 bytes) recognisable on the host.
func label(id string) string {
	l := "rh-" + strings.TrimPrefix(id, "vol_")
	if len(l) > 16 {
		l = l[:16]
	}
	return l
}

func (l *loopBackend) mount(_ context.Context, id, dir string) error {
	if _, ok, err := mountSource(dir); err != nil || ok {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	dev, f, err := attach(l.image(id))
	if err != nil {
		return err
	}
	// NOTE: the device is set to autoclear, so closing our handle after a
	// failed mount detaches it, and unmounting detaches it later.
	defer f.Close()
	if err := unix.Mount(dev, dir, "ext4", unix.MS_NOATIME|unix.MS_NODEV|unix.MS_NOSUID, ""); err != nil {
		return fmt.Errorf("mount %s on %s: %w", dev, dir, err)
	}
	return nil
}

// attach binds img to a free loop device with autoclear set and returns
// the device and an open handle on it.
func attach(img string) (string, *os.File, error) {
	ctl, err := os.OpenFile("/dev/loop-control", os.O_RDWR, 0)
	if err != nil {
		return "", nil, err
	}
	defer ctl.Close()
	for range 16 {
		n, err := unix.IoctlRetInt(int(ctl.Fd()), unix.LOOP_CTL_GET_FREE)
		if err != nil {
			return "", nil, fmt.Errorf("find a free loop device: %w", err)
		}
		dev := "/dev/loop" + strconv.Itoa(n)
		lf, err := os.OpenFile(dev, os.O_RDWR, 0)
		if err != nil {
			return "", nil, err
		}
		imgf, err := os.OpenFile(img, os.O_RDWR, 0)
		if err != nil {
			lf.Close()
			return "", nil, err
		}
		err = unix.IoctlSetInt(int(lf.Fd()), unix.LOOP_SET_FD, int(imgf.Fd()))
		imgf.Close()
		if errors.Is(err, unix.EBUSY) {
			// Another process took the device between GET_FREE and SET_FD.
			lf.Close()
			continue
		}
		if err != nil {
			lf.Close()
			return "", nil, fmt.Errorf("attach %s to %s: %w", img, dev, err)
		}
		info := unix.LoopInfo64{Flags: unix.LO_FLAGS_AUTOCLEAR}
		copy(info.File_name[:], img)
		if err := unix.IoctlLoopSetStatus64(int(lf.Fd()), &info); err != nil {
			_ = unix.IoctlSetInt(int(lf.Fd()), unix.LOOP_CLR_FD, 0)
			lf.Close()
			return "", nil, fmt.Errorf("configure %s: %w", dev, err)
		}
		return dev, lf, nil
	}
	return "", nil, errors.New("no free loop device")
}

func (l *loopBackend) grow(ctx context.Context, id, dir string, sizeMB int) error {
	dev, ok, err := mountSource(dir)
	if err != nil {
		return err
	}
	if !ok || !strings.HasPrefix(dev, "/dev/loop") {
		return fmt.Errorf("%s is not mounted from a loop device", dir)
	}
	img := l.image(id)
	st, err := os.Stat(img)
	if err != nil {
		return err
	}
	if want := int64(sizeMB) << 20; want > st.Size() {
		if err := os.Truncate(img, want); err != nil {
			return err
		}
	}
	f, err := os.OpenFile(dev, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	err = unix.IoctlSetInt(int(f.Fd()), unix.LOOP_SET_CAPACITY, 0)
	f.Close()
	if err != nil {
		return fmt.Errorf("refresh %s capacity: %w", dev, err)
	}
	return run(ctx, l.resize2fs, dev)
}

func (l *loopBackend) remove(_ context.Context, id, dir string) error {
	if _, ok, err := mountSource(dir); err != nil {
		return err
	} else if ok {
		if err := unix.Unmount(dir, 0); err != nil {
			return fmt.Errorf("unmount %s: %w", dir, err)
		}
	}
	if err := os.Remove(l.image(id)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func (l *loopBackend) usage(_, dir string, _ int) (int64, int64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return 0, 0, err
	}
	bs := st.Bsize
	return int64(st.Blocks) * bs, int64(st.Blocks-st.Bfree) * bs, nil
}

// mountSource reports what is mounted at dir, from /proc/self/mountinfo.
func mountSource(dir string) (string, bool, error) {
	data, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return "", false, err
	}
	src, ok := parseMountinfo(data, dir)
	return src, ok, nil
}

// parseMountinfo finds the last mount at dir and returns its source.
func parseMountinfo(data []byte, dir string) (string, bool) {
	var src string
	found := false
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		pre, post, ok := strings.Cut(sc.Text(), " - ")
		if !ok {
			continue
		}
		f := strings.Fields(pre)
		g := strings.Fields(post)
		if len(f) < 5 || len(g) < 2 || unescapeMountinfo(f[4]) != dir {
			continue
		}
		src, found = unescapeMountinfo(g[1]), true
	}
	return src, found
}

// unescapeMountinfo decodes the octal escapes (\040 for a space) mountinfo
// uses in paths.
func unescapeMountinfo(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// run runs a host tool and folds its output into the error.
func run(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %w: %s", filepath.Base(name), err, strings.TrimSpace(truncate(string(out), 1024)))
	}
	return nil
}
