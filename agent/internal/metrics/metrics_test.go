package metrics

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

const (
	systemdID  = "1111111111111111111111111111111111111111111111111111111111111111"
	cgroupfsID = "2222222222222222222222222222222222222222222222222222222222222222"
	// fixtureMemTotal is MemTotal in the fixtures' meminfo.
	fixtureMemTotal = 8_000_000 * 1024
)

// fixture copies testdata/<name> into a temporary directory, so a test can
// rewrite counters, and returns its proc and cgroup roots.
func fixture(t *testing.T, name string) (proc, cgroup string) {
	t.Helper()
	src := filepath.Join("testdata", name)
	dst := t.TempDir()
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dst, rel), data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dst, "proc"), filepath.Join(dst, "sys", "fs", "cgroup")
}

func write(t *testing.T, name, content string) {
	t.Helper()
	if err := os.WriteFile(name, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// clock is a settable time source.
type clock struct {
	mu  sync.Mutex
	now time.Time
}

func newClock() *clock { return &clock{now: time.Unix(1_761_100_000, 0)} }

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// fakeStats serves Docker stats per container ID.
type fakeStats struct {
	mu    sync.Mutex
	stats map[string]docker.Stats
	calls int
}

func (f *fakeStats) set(id string, s docker.Stats) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stats == nil {
		f.stats = map[string]docker.Stats{}
	}
	f.stats[id] = s
}

func (f *fakeStats) ContainerStats(_ context.Context, id string) (docker.Stats, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	s, ok := f.stats[id]
	if !ok {
		return docker.Stats{}, &docker.Error{Status: 404, Message: "no such container"}
	}
	return s, nil
}

func recordedStats(t *testing.T) docker.Stats {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "docker-stats.json"))
	if err != nil {
		t.Fatal(err)
	}
	var s docker.Stats
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func newTestCollector(proc, cgroup string, clk *clock, stats StatsSource) *Collector {
	opts := Options{ProcRoot: proc, CgroupRoot: cgroup, Now: clk.Now}
	if stats != nil {
		opts.Stats = stats
	}
	return New(opts)
}

func mustValidate(t *testing.T, m *protocol.Metrics) {
	t.Helper()
	if m == nil {
		t.Fatal("no frame")
	}
	if err := m.Validate(); err != nil {
		t.Fatalf("frame does not validate: %v (%+v)", err, m)
	}
}

func TestLocateCgroup(t *testing.T) {
	sdProc, sdRoot := fixture(t, "cgroup-systemd")
	fsProc, fsRoot := fixture(t, "cgroup-cgroupfs")
	systemdDir := filepath.Join(sdRoot, "system.slice", "docker-"+systemdID+".scope")
	cgroupfsDir := filepath.Join(fsRoot, "docker", cgroupfsID)
	for _, tc := range []struct {
		name       string
		proc, root string
		pid        int
		id         string
		want       string
	}{
		{"systemd driver", sdProc, sdRoot, 1234, systemdID, systemdDir},
		{"agent in its own cgroup namespace", sdProc, sdRoot, 3456, systemdID, systemdDir},
		{"cgroupfs driver", fsProc, fsRoot, 1234, cgroupfsID, cgroupfsDir},
		{"process in a child cgroup", fsProc, fsRoot, 2345, cgroupfsID, cgroupfsDir},
		{"reused PID", fsProc, fsRoot, 4567, cgroupfsID, ""},
		{"other container's PID", sdProc, sdRoot, 1234, cgroupfsID, ""},
		{"missing PID", fsProc, fsRoot, 9999, cgroupfsID, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := cgroupFS{proc: tc.proc, root: tc.root}.locate(tc.pid, tc.id)
			if tc.want == "" {
				if err == nil {
					t.Fatalf("locate = %q, want an error", got)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("locate = %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}

func TestReadCgroup(t *testing.T) {
	memTotal := func() int64 { return fixtureMemTotal }
	t.Run("systemd", func(t *testing.T) {
		proc, root := fixture(t, "cgroup-systemd")
		r, err := cgroupFS{proc: proc, root: root}.read(1234, systemdID, memTotal)
		if err != nil {
			t.Fatal(err)
		}
		want := reading{
			source: protocol.MetricsCgroupV2,
			// lo is excluded; eth0 and eth1 are summed; io.stat devices are
			// summed.
			counters: counters{cpuUsec: 1_000_000, netRx: 6000, netTx: 2500, diskRead: 5096, diskWrite: 10192},
			mem:      104857600 - 20971520,
			memLimit: 536870912,
			pids:     3,
		}
		if r != want {
			t.Fatalf("reading = %+v, want %+v", r, want)
		}
	})
	t.Run("unlimited memory is the node total", func(t *testing.T) {
		proc, root := fixture(t, "cgroup-cgroupfs")
		r, err := cgroupFS{proc: proc, root: root}.read(1234, cgroupfsID, memTotal)
		if err != nil || r.memLimit != fixtureMemTotal {
			t.Fatalf("limit = %d, %v; want %d", r.memLimit, err, fixtureMemTotal)
		}
	})
	t.Run("working set never goes negative", func(t *testing.T) {
		proc, root := fixture(t, "cgroup-cgroupfs")
		dir := filepath.Join(root, "docker", cgroupfsID)
		write(t, filepath.Join(dir, "memory.stat"), "inactive_file 999999999999\n")
		os.Remove(filepath.Join(dir, "io.stat"))
		os.Remove(filepath.Join(dir, "pids.current"))
		r, err := cgroupFS{proc: proc, root: root}.read(1234, cgroupfsID, memTotal)
		if err != nil || r.mem != 0 || r.pids != 0 || r.counters.diskRead != 0 {
			t.Fatalf("reading = %+v, %v", r, err)
		}
	})
	t.Run("v1 host", func(t *testing.T) {
		proc, root := fixture(t, "cgroup-v1")
		f := cgroupFS{proc: proc, root: root}
		if f.v2() {
			t.Fatal("v1 fixture detected as cgroup v2")
		}
		if _, err := f.read(1234, cgroupfsID, memTotal); err == nil {
			t.Fatal("read a v1 cgroup as v2")
		}
	})
	t.Run("meminfo", func(t *testing.T) {
		proc, _ := fixture(t, "cgroup-v1")
		if got := (cgroupFS{proc: proc}).memTotal(); got != fixtureMemTotal {
			t.Fatalf("memTotal = %d", got)
		}
	})
}

func TestDeltas(t *testing.T) {
	proc, root := fixture(t, "cgroup-systemd")
	dir := filepath.Join(root, "system.slice", "docker-"+systemdID+".scope")
	clk := newClock()
	c := newTestCollector(proc, root, clk, nil)
	started := clk.Now().Add(-time.Minute)
	c.Sync([]Target{{ID: systemdID, WorkloadID: "wl_a", PID: 1234, Running: true, StartedAt: started}})

	first := c.collect(context.Background(), 15*time.Second)
	mustValidate(t, first)
	s := first.Samples[0]
	if s.CPUMillis != 0 || s.NetRxBytes != 0 || s.NetTxBytes != 0 || s.DiskReadBytes != 0 || s.DiskWriteBytes != 0 || s.Restarts != 0 {
		t.Fatalf("first sample carries deltas: %+v", s)
	}
	if s.MemBytes != 83886080 || s.MemLimitBytes != 536870912 || s.PIDs != 3 || first.Source != protocol.MetricsCgroupV2 {
		t.Fatalf("first sample gauges: %+v", first)
	}
	if first.IntervalMS != 15000 {
		t.Fatalf("first interval_ms = %d, want the nominal 15000", first.IntervalMS)
	}

	// Half a core for 15 s, 3000/1000 bytes more network, 100/200 more disk.
	write(t, filepath.Join(dir, "cpu.stat"), "usage_usec 8500000\n")
	write(t, filepath.Join(dir, "io.stat"), "8:0 rbytes=4196 wbytes=8392\n8:16 rbytes=1000 wbytes=2000\n")
	write(t, filepath.Join(proc, "1234", "net", "dev"),
		"  lo: 9 0 0 0 0 0 0 0 9 0 0 0 0 0 0 0\neth0: 9000 0 0 0 0 0 0 0 3000 0 0 0 0 0 0 0\n")
	clk.advance(15 * time.Second)
	second := c.collect(context.Background(), 15*time.Second)
	mustValidate(t, second)
	s = second.Samples[0]
	want := protocol.ContainerSample{
		WorkloadID: "wl_a", CPUMillis: 500, MemBytes: 83886080, MemLimitBytes: 536870912,
		NetRxBytes: 3000, NetTxBytes: 500, DiskReadBytes: 100, DiskWriteBytes: 200, PIDs: 3,
	}
	if s != want {
		t.Fatalf("second sample = %+v\nwant %+v", s, want)
	}

	t.Run("a counter that goes backwards deltas to 0", func(t *testing.T) {
		write(t, filepath.Join(dir, "cpu.stat"), "usage_usec 10\n")
		clk.advance(15 * time.Second)
		m := c.collect(context.Background(), 15*time.Second)
		mustValidate(t, m)
		if s := m.Samples[0]; s.CPUMillis != 0 || s.NetRxBytes != 0 || s.DiskReadBytes != 0 {
			t.Fatalf("after reset: %+v", s)
		}
		write(t, filepath.Join(dir, "cpu.stat"), "usage_usec 1500010\n")
		clk.advance(15 * time.Second)
		if s := c.collect(context.Background(), 15*time.Second).Samples[0]; s.CPUMillis != 100 {
			t.Fatalf("cpu after reset = %d, want 100", s.CPUMillis)
		}
	})

	t.Run("a restart zeroes counters but counts the restart", func(t *testing.T) {
		write(t, filepath.Join(dir, "cpu.stat"), "usage_usec 99000000\n")
		c.Sync([]Target{{ID: systemdID, WorkloadID: "wl_a", PID: 3456, Running: true, StartedAt: clk.Now(), Restarts: 1}})
		clk.advance(15 * time.Second)
		m := c.collect(context.Background(), 15*time.Second)
		mustValidate(t, m)
		if s := m.Samples[0]; s.CPUMillis != 0 || s.NetRxBytes != 0 || s.Restarts != 1 {
			t.Fatalf("after restart: %+v", s)
		}
		clk.advance(15 * time.Second)
		if s := c.collect(context.Background(), 15*time.Second).Samples[0]; s.Restarts != 0 {
			t.Fatalf("restart counted twice: %+v", s)
		}
	})

	t.Run("a runtime counter that goes backwards is not a restart", func(t *testing.T) {
		c.Sync([]Target{{ID: systemdID, WorkloadID: "wl_a", PID: 3456, Running: true, StartedAt: clk.Now().Add(-30 * time.Second)}})
		clk.advance(15 * time.Second)
		if s := c.collect(context.Background(), 15*time.Second).Samples[0]; s.Restarts != 0 {
			t.Fatalf("restarts = %d", s.Restarts)
		}
	})

	t.Run("a gap in sampling starts a new baseline", func(t *testing.T) {
		write(t, filepath.Join(dir, "cpu.stat"), "usage_usec 199000000\n")
		clk.advance(time.Hour)
		m := c.collect(context.Background(), 15*time.Second)
		mustValidate(t, m)
		if m.Samples[0].CPUMillis != 0 {
			t.Fatalf("delta across a gap: %+v", m.Samples[0])
		}
		if m.IntervalMS != protocol.MaxMetricsIntervalMS {
			t.Fatalf("interval_ms = %d, want clamped to %d", m.IntervalMS, protocol.MaxMetricsIntervalMS)
		}
	})

	t.Run("state of a removed container is pruned", func(t *testing.T) {
		c.Sync(nil)
		if m := c.collect(context.Background(), 15*time.Second); m != nil {
			t.Fatalf("frame without containers: %+v", m)
		}
		if len(c.prev) != 0 {
			t.Fatalf("prev = %v", c.prev)
		}
	})
}

func TestDockerStatsFallback(t *testing.T) {
	proc, root := fixture(t, "cgroup-v1")
	clk := newClock()
	stats := &fakeStats{}
	rec := recordedStats(t)
	stats.set(cgroupfsID, rec)
	c := newTestCollector(proc, root, clk, stats)
	c.Sync([]Target{{ID: cgroupfsID, WorkloadID: "wl_b", PID: 1234, Running: true}})

	m := c.collect(context.Background(), 15*time.Second)
	mustValidate(t, m)
	want := protocol.ContainerSample{WorkloadID: "wl_b", MemBytes: 7561216 - 5246976, MemLimitBytes: 268435456, PIDs: 1}
	if m.Source != protocol.MetricsDockerStats || m.Samples[0] != want {
		t.Fatalf("frame = %+v\nwant sample %+v", m, want)
	}

	rec.CPUStats.Usage.TotalUsage += 3_000_000_000 // 3 s of CPU
	rec.Networks["eth0"] = docker.Net{RxBytes: 3530, TxBytes: 1788}
	rec.BlkioStat.IOServiceBytesRecursive[1].Value += 4096
	stats.set(cgroupfsID, rec)
	clk.advance(15 * time.Second)
	m = c.collect(context.Background(), 15*time.Second)
	mustValidate(t, m)
	if s := m.Samples[0]; s.CPUMillis != 200 || s.NetRxBytes != 1000 || s.NetTxBytes != 1000 || s.DiskWriteBytes != 4096 || s.DiskReadBytes != 0 {
		t.Fatalf("second sample = %+v", s)
	}
}

func TestDockerStatsV1(t *testing.T) {
	var s docker.Stats
	err := json.Unmarshal([]byte(`{"cpu_stats":{"cpu_usage":{"total_usage":2000000}},
		"memory_stats":{"usage":1000,"limit":0,"stats":{"total_inactive_file":400,"inactive_file":10}},
		"pids_stats":{"current":4},
		"networks":{"eth0":{"rx_bytes":5,"tx_bytes":6},"eth1":{"rx_bytes":1,"tx_bytes":1}},
		"blkio_stats":{"io_service_bytes_recursive":[
			{"major":8,"minor":0,"op":"Read","value":100},{"major":8,"minor":0,"op":"Write","value":200},
			{"major":8,"minor":0,"op":"Sync","value":300},{"major":8,"minor":0,"op":"Total","value":300},
			{"major":8,"minor":16,"op":"Read","value":1}]}}`), &s)
	if err != nil {
		t.Fatal(err)
	}
	r := fromDockerStats(s, func() int64 { return 42 })
	want := reading{
		source:   protocol.MetricsDockerStats,
		counters: counters{cpuUsec: 2000, netRx: 6, netTx: 7, diskRead: 101, diskWrite: 200},
		mem:      600, memLimit: 42, pids: 4,
	}
	if r != want {
		t.Fatalf("reading = %+v\nwant %+v", r, want)
	}
}

func TestMixedSourcesLabelDockerStats(t *testing.T) {
	proc, root := fixture(t, "cgroup-systemd")
	stats := &fakeStats{}
	stats.set("3333333333333333333333333333333333333333333333333333333333333333", recordedStats(t))
	c := newTestCollector(proc, root, newClock(), stats)
	c.Sync([]Target{
		{ID: systemdID, WorkloadID: "wl_a", PID: 1234, Running: true},
		// No PID: its cgroup cannot be found, so it comes from Docker.
		{ID: "3333333333333333333333333333333333333333333333333333333333333333", WorkloadID: "wl_c", Running: true},
	})
	m := c.collect(context.Background(), 15*time.Second)
	mustValidate(t, m)
	if m.Source != protocol.MetricsDockerStats || len(m.Samples) != 2 {
		t.Fatalf("frame = %+v", m)
	}
	if stats.calls != 1 {
		t.Fatalf("docker stats calls = %d, want 1 (only the container without a cgroup)", stats.calls)
	}
}

func TestUnreadableContainerIsSkipped(t *testing.T) {
	proc, root := fixture(t, "cgroup-systemd")
	c := newTestCollector(proc, root, newClock(), nil)
	c.Sync([]Target{
		{ID: systemdID, WorkloadID: "wl_a", PID: 1234, Running: true},
		{ID: cgroupfsID, WorkloadID: "wl_b", PID: 9999, Running: true},
		{ID: "4444444444444444444444444444444444444444444444444444444444444444", WorkloadID: "wl_c", Running: false},
	})
	m := c.collect(context.Background(), 15*time.Second)
	mustValidate(t, m)
	if len(m.Samples) != 1 || m.Samples[0].WorkloadID != "wl_a" {
		t.Fatalf("samples = %+v", m.Samples)
	}
}

func TestOneSamplePerWorkload(t *testing.T) {
	proc, root := fixture(t, "cgroup-v1")
	clk := newClock()
	stats := &fakeStats{}
	old, cur := strings.Repeat("a", 64), strings.Repeat("b", 64)
	rec := recordedStats(t)
	stats.set(old, rec)
	rec.PIDs.Current = 9
	stats.set(cur, rec)
	c := newTestCollector(proc, root, clk, stats)
	c.Sync([]Target{
		{ID: old, WorkloadID: "wl_a", Running: true, StartedAt: clk.Now().Add(-time.Hour)},
		{ID: cur, WorkloadID: "wl_a", Running: true, StartedAt: clk.Now()},
	})
	m := c.collect(context.Background(), 15*time.Second)
	mustValidate(t, m)
	if len(m.Samples) != 1 || m.Samples[0].PIDs != 9 {
		t.Fatalf("samples = %+v, want only the newest container", m.Samples)
	}
}

func TestCapAtMaxSamples(t *testing.T) {
	proc, root := fixture(t, "cgroup-v1")
	stats := &fakeStats{}
	rec := recordedStats(t)
	var targets []Target
	for i := range 200 {
		id := fmt.Sprintf("%064x", i)
		stats.set(id, rec)
		targets = append(targets, Target{ID: id, WorkloadID: fmt.Sprintf("wl_%03d", 199-i), Running: true})
	}
	var logs bytes.Buffer
	c := New(Options{ProcRoot: proc, CgroupRoot: root, Stats: stats, Now: newClock().Now,
		Logger: slog.New(slog.NewTextHandler(&logs, nil))})
	c.Sync(targets)
	for range 2 {
		m := c.collect(context.Background(), 15*time.Second)
		mustValidate(t, m)
		if len(m.Samples) != protocol.MaxMetricSamples || m.Samples[0].WorkloadID != "wl_000" ||
			m.Samples[len(m.Samples)-1].WorkloadID != "wl_159" {
			t.Fatalf("%d samples, first %s, last %s", len(m.Samples), m.Samples[0].WorkloadID, m.Samples[len(m.Samples)-1].WorkloadID)
		}
		data, _ := json.Marshal(m)
		if len(data) > protocol.MaxAgentFrameBytes {
			t.Fatalf("frame is %d bytes", len(data))
		}
	}
	if n := strings.Count(logs.String(), "more containers than one metrics frame carries"); n != 1 {
		t.Fatalf("cap logged %d times, want once", n)
	}
}

func TestFrameCarriesOnlyNumbersAndWorkloadIDs(t *testing.T) {
	proc, root := fixture(t, "cgroup-systemd")
	c := newTestCollector(proc, root, newClock(), nil)
	c.Sync([]Target{{ID: systemdID, WorkloadID: "wl_a", PID: 1234, Running: true}})
	data, err := json.Marshal(c.collect(context.Background(), 15*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte(systemdID[:12])) || bytes.Contains(data, []byte("/")) {
		t.Fatalf("frame leaks an ID or path: %s", data)
	}
	var m map[string]any
	_ = json.Unmarshal(data, &m)
	sample := m["samples"].([]any)[0].(map[string]any)
	for k, v := range sample {
		if _, isNum := v.(float64); !isNum && k != "workload_id" {
			t.Errorf("sample field %s = %v is not a number", k, v)
		}
	}
}

func TestClampInterval(t *testing.T) {
	for _, tc := range []struct{ in, want time.Duration }{
		{0, 0}, {-time.Second, 0}, {time.Millisecond, time.Second},
		{15 * time.Second, 15 * time.Second}, {time.Hour, 5 * time.Minute},
	} {
		if got := ClampInterval(tc.in); got != tc.want {
			t.Errorf("ClampInterval(%v) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestTickRateLimit(t *testing.T) {
	proc, root := fixture(t, "cgroup-systemd")
	clk := newClock()
	var sent int
	c := New(Options{ProcRoot: proc, CgroupRoot: root, Now: clk.Now,
		Send: func(context.Context, *protocol.Metrics) error { sent++; return nil }})
	c.Sync([]Target{{ID: systemdID, WorkloadID: "wl_a", PID: 1234, Running: true}})
	c.tick(context.Background(), time.Second)
	clk.advance(999 * time.Millisecond)
	c.tick(context.Background(), time.Second)
	if sent != 1 {
		t.Fatalf("sent %d frames within a second, want 1", sent)
	}
	clk.advance(time.Millisecond)
	c.tick(context.Background(), time.Second)
	if sent != 2 {
		t.Fatalf("sent %d frames, want 2", sent)
	}
}

func TestSendErrorDropsFrame(t *testing.T) {
	proc, root := fixture(t, "cgroup-systemd")
	clk := newClock()
	var calls int
	c := New(Options{ProcRoot: proc, CgroupRoot: root, Now: clk.Now,
		Send: func(context.Context, *protocol.Metrics) error { calls++; return errors.New("boom") }})
	c.Sync([]Target{{ID: systemdID, WorkloadID: "wl_a", PID: 1234, Running: true}})
	c.tick(context.Background(), time.Second)
	clk.advance(time.Second)
	c.tick(context.Background(), time.Second)
	if calls != 2 {
		t.Fatalf("send calls = %d, want 2 (one per tick, no retries or buffering)", calls)
	}
}

func TestRunFollowsInterval(t *testing.T) {
	proc, root := fixture(t, "cgroup-systemd")
	frames := make(chan *protocol.Metrics, 16)
	c := New(Options{ProcRoot: proc, CgroupRoot: root,
		Send: func(_ context.Context, m *protocol.Metrics) error { frames <- m; return nil }})
	c.Sync([]Target{{ID: systemdID, WorkloadID: "wl_a", PID: 1234, Running: true}})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Run(ctx) }()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()

	select {
	case m := <-frames:
		t.Fatalf("frame without an interval: %+v", m)
	case <-time.After(300 * time.Millisecond):
	}

	// Below the minimum: clamped to one second.
	start := time.Now()
	c.SetInterval(time.Millisecond)
	var got []*protocol.Metrics
	for len(got) < 2 {
		select {
		case m := <-frames:
			mustValidate(t, m)
			got = append(got, m)
		case <-time.After(5 * time.Second):
			t.Fatal("no frame")
		}
	}
	if el := time.Since(start); el < 2*time.Second-50*time.Millisecond {
		t.Fatalf("two frames after %v, want one per second at most", el)
	}
	if gap := got[1].TS - got[0].TS; gap < 1000 {
		t.Fatalf("frames %d ms apart", gap)
	}
	for _, m := range got {
		if m.IntervalMS < 1000 || m.IntervalMS > 1500 {
			t.Fatalf("interval_ms = %d, want about 1000", m.IntervalMS)
		}
	}

	c.SetInterval(0)
	// A frame already being sent may still land; nothing after it.
	time.Sleep(100 * time.Millisecond)
	for len(frames) > 0 {
		<-frames
	}
	select {
	case m := <-frames:
		t.Fatalf("frame after sampling stopped: %+v", m)
	case <-time.After(1500 * time.Millisecond):
	}
}
