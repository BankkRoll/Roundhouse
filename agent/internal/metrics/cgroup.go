package metrics

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

var (
	errNoCgroupV2 = errors.New("not a cgroup v2 host")
	errNoPID      = errors.New("container PID unknown")
)

// cgroupFS reads container counters from a proc tree and a cgroup v2 mount.
type cgroupFS struct {
	proc string
	root string
}

// v2 reports whether root is a cgroup v2 (unified) mount.
func (f cgroupFS) v2() bool {
	_, err := os.Stat(filepath.Join(f.root, "cgroup.controllers"))
	return err == nil
}

// read samples the container whose init process is pid and whose full ID
// is id.
func (f cgroupFS) read(pid int, id string, memTotal func() int64) (reading, error) {
	if pid <= 0 {
		return reading{}, errNoPID
	}
	dir, err := f.locate(pid, id)
	if err != nil {
		return reading{}, err
	}
	r := reading{source: protocol.MetricsCgroupV2}
	cpu, err := readKeyed(filepath.Join(dir, "cpu.stat"))
	if err != nil {
		return reading{}, err
	}
	usec, ok := cpu["usage_usec"]
	if !ok {
		return reading{}, fmt.Errorf("%s: no usage_usec", filepath.Join(dir, "cpu.stat"))
	}
	r.counters.cpuUsec = usec
	current, err := readUint(filepath.Join(dir, "memory.current"))
	if err != nil {
		return reading{}, err
	}
	// NOTE: inactive_file is page cache the kernel reclaims first; the
	// working set without it is what an OOM kill is decided on, and what
	// `docker stats` shows.
	var inactive uint64
	if ms, err := readKeyed(filepath.Join(dir, "memory.stat")); err == nil {
		inactive = ms["inactive_file"]
	}
	r.mem = int64(sub(current, inactive))
	r.memLimit = memTotal()
	if raw, err := os.ReadFile(filepath.Join(dir, "memory.max")); err == nil {
		if v, err := strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 63); err == nil {
			r.memLimit = int64(v)
		}
	}
	// io.stat and pids.current are absent when their controllers are not
	// enabled for the container; that reads as zero, not as a failure.
	r.counters.diskRead, r.counters.diskWrite = readIOStat(filepath.Join(dir, "io.stat"))
	if v, err := readUint(filepath.Join(dir, "pids.current")); err == nil {
		r.pids = int64(min(v, 1<<63-1))
	}
	r.counters.netRx, r.counters.netTx = readNetDev(filepath.Join(f.proc, strconv.Itoa(pid), "net", "dev"))
	return r, nil
}

// locate finds the cgroup directory of the container with ID id from its
// init process's /proc/<pid>/cgroup.
//
// It handles the systemd driver (…/docker-<id>.scope) and cgroupfs
// (/docker/<id>), a container that moved its processes into a child
// cgroup, and an agent that runs in its own cgroup namespace, where other
// containers' paths start with "/..": then the path is looked up by the
// container ID under the driver layouts instead.
//
// SECURITY: the path must name the container's ID, so a PID reused by
// another process after the container died is never attributed to it.
func (f cgroupFS) locate(pid int, id string) (string, error) {
	file := filepath.Join(f.proc, strconv.Itoa(pid), "cgroup")
	data, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	var rel string
	for line := range strings.Lines(string(data)) {
		if p, ok := strings.CutPrefix(strings.TrimRight(line, "\n"), "0::"); ok {
			rel = p
			break
		}
	}
	if rel == "" {
		return "", fmt.Errorf("%s: no cgroup v2 entry", file)
	}
	// NOTE: Clean drops a leading "/..", so the path can never leave root;
	// in a foreign namespace the remainder is wrong but still names the ID,
	// and the driver layouts below find the real directory.
	rel = path.Clean("/" + rel)
	for rel != "/" && !strings.Contains(path.Base(rel), id) {
		rel = path.Dir(rel)
	}
	if rel == "/" {
		return "", fmt.Errorf("%s: cgroup does not belong to container %.12s", file, id)
	}
	for _, c := range []string{rel, "/system.slice/docker-" + id + ".scope", "/docker/" + id} {
		dir := filepath.Join(f.root, filepath.FromSlash(c))
		if _, err := os.Stat(filepath.Join(dir, "cpu.stat")); err == nil {
			return dir, nil
		}
	}
	return "", fmt.Errorf("cgroup of container %.12s not found under %s", id, f.root)
}

// memTotal returns MemTotal from the proc tree's meminfo in bytes, 0 when
// unreadable.
func (f cgroupFS) memTotal() int64 {
	data, err := os.ReadFile(filepath.Join(f.proc, "meminfo"))
	if err != nil {
		return 0
	}
	for line := range strings.Lines(string(data)) {
		if rest, ok := strings.CutPrefix(line, "MemTotal:"); ok {
			fields := strings.Fields(rest)
			if len(fields) == 0 {
				return 0
			}
			kb, err := strconv.ParseInt(fields[0], 10, 64)
			if err != nil || kb < 0 || kb > (1<<63-1)/1024 {
				return 0
			}
			return kb * 1024
		}
	}
	return 0
}

// readUint reads a file holding one unsigned integer.
func readUint(name string) (uint64, error) {
	data, err := os.ReadFile(name)
	if err != nil {
		return 0, err
	}
	return strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
}

// readKeyed reads a flat keyed file ("key value" per line), such as
// cpu.stat or memory.stat.
func readKeyed(name string) (map[string]uint64, error) {
	data, err := os.ReadFile(name)
	if err != nil {
		return nil, err
	}
	out := map[string]uint64{}
	for line := range strings.Lines(string(data)) {
		k, v, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok {
			continue
		}
		if n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64); err == nil {
			out[k] = n
		}
	}
	return out, nil
}

// readIOStat sums rbytes and wbytes over every device in an io.stat file.
func readIOStat(name string) (read, write uint64) {
	data, err := os.ReadFile(name)
	if err != nil {
		return 0, 0
	}
	for line := range strings.Lines(string(data)) {
		fields := strings.Fields(line)
		for _, kv := range fields[min(1, len(fields)):] {
			k, v, ok := strings.Cut(kv, "=")
			if !ok {
				continue
			}
			n, err := strconv.ParseUint(v, 10, 64)
			if err != nil {
				continue
			}
			switch k {
			case "rbytes":
				read += n
			case "wbytes":
				write += n
			}
		}
	}
	return read, write
}

// readNetDev sums received and transmitted bytes over every interface but
// lo in a /proc/<pid>/net/dev file; 0 when unreadable.
func readNetDev(name string) (rx, tx uint64) {
	data, err := os.ReadFile(name)
	if err != nil {
		return 0, 0
	}
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		iface, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		iface = strings.TrimSpace(iface)
		if iface == "lo" {
			continue
		}
		// Receive columns come first: bytes, packets, errs, drop, fifo,
		// frame, compressed, multicast; then transmit, bytes first.
		fields := strings.Fields(rest)
		if len(fields) < 16 {
			continue
		}
		r, err1 := strconv.ParseUint(fields[0], 10, 64)
		t, err2 := strconv.ParseUint(fields[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		rx += r
		tx += t
	}
	return rx, tx
}
