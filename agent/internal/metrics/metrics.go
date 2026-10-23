// Package metrics samples every managed container's resource use and sends
// it to the control plane as [protocol.Metrics] frames (ADR 0008).
//
// Responsibilities:
//   - sample on the interval the control plane's welcome asks for, and not
//     at all when it asks for none, never more than one frame per second;
//   - read cgroup v2 files directly (cheap: no Docker stats stream per
//     container), and fall back to Docker's one-shot stats on cgroup v1
//     hosts or when a container's cgroup cannot be read;
//   - turn cumulative counters into per-interval deltas, with bounded
//     per-container state that is pruned when containers disappear.
//
// SECURITY: frames carry numbers and workload IDs only, never names,
// labels, environment, command lines or paths.
package metrics

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// Bounds on the sampling interval, from the protocol.
const (
	MinInterval = protocol.MinMetricsIntervalMS * time.Millisecond
	MaxInterval = protocol.MaxMetricsIntervalMS * time.Millisecond
)

// MinFrameGap is the shortest time between two frames the protocol allows.
const MinFrameGap = time.Second

// Default filesystem roots, overridable in [Options] for tests and for an
// agent that runs in a container with the host's trees mounted elsewhere.
const (
	DefaultProcRoot   = "/proc"
	DefaultCgroupRoot = "/sys/fs/cgroup"
)

const (
	sendTimeout  = 10 * time.Second
	statsTimeout = 5 * time.Second
	// staleAfter is how many intervals may pass between two passes before
	// the older one is too old to delta against: a frame's counters must
	// cover its interval, not a gap in sampling.
	staleAfter = 2
)

// Target is one managed container the collector samples.
type Target struct {
	// ID is the full Docker container ID.
	ID         string
	WorkloadID string
	// PID is the container's init process on the host, 0 when unknown.
	PID     int
	Running bool
	// StartedAt changes every time the container is (re)started.
	StartedAt time.Time
	// Restarts is the runtime's cumulative restart count for the container.
	Restarts int
}

// StatsSource returns Docker's one-shot stats for a container; it is
// satisfied by [docker.Client].
type StatsSource interface {
	ContainerStats(ctx context.Context, id string) (docker.Stats, error)
}

// Options configures a [Collector].
type Options struct {
	// Send delivers one frame. A frame that cannot be sent is dropped, never
	// buffered; Send should return nil for "not connected".
	Send func(ctx context.Context, m *protocol.Metrics) error
	// Stats is the Docker fallback; nil samples cgroup v2 only.
	Stats StatsSource
	// ProcRoot and CgroupRoot default to [DefaultProcRoot] and
	// [DefaultCgroupRoot].
	ProcRoot   string
	CgroupRoot string
	// MemTotal returns the node's total memory, the limit of a container
	// without one; nil reads MemTotal from ProcRoot/meminfo.
	MemTotal func() int64
	Logger   *slog.Logger
	// Now defaults to [time.Now].
	Now func() time.Time
}

// Collector samples containers and sends metrics frames. Create it with
// [New], feed it containers with [Collector.Sync] and intervals with
// [Collector.SetInterval], and call [Collector.Run].
type Collector struct {
	opts Options
	log  *slog.Logger
	fs   cgroupFS

	mu       sync.Mutex
	targets  []Target
	interval time.Duration
	changed  chan struct{}

	// Owned by the Run goroutine.
	prev      map[string]prevState
	lastPass  time.Time
	lastSent  time.Time
	capWarned bool
	fellBack  bool
}

// prevState is a container's previous reading, for deltas.
type prevState struct {
	at        time.Time
	pid       int
	startedAt time.Time
	source    protocol.MetricsSource
	counters  counters
	restarts  int
}

// counters are a container's cumulative counters.
type counters struct {
	cpuUsec, netRx, netTx, diskRead, diskWrite uint64
}

// reading is one container's raw sample.
type reading struct {
	source   protocol.MetricsSource
	counters counters
	mem      int64
	memLimit int64
	pids     int64
}

// New returns a collector that does nothing until it is given an interval.
func New(opts Options) *Collector {
	if opts.ProcRoot == "" {
		opts.ProcRoot = DefaultProcRoot
	}
	if opts.CgroupRoot == "" {
		opts.CgroupRoot = DefaultCgroupRoot
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	c := &Collector{
		opts:    opts,
		log:     log,
		fs:      cgroupFS{proc: opts.ProcRoot, root: opts.CgroupRoot},
		changed: make(chan struct{}, 1),
		prev:    map[string]prevState{},
	}
	if c.opts.MemTotal == nil {
		var once sync.Once
		var total int64
		c.opts.MemTotal = func() int64 {
			once.Do(func() { total = c.fs.memTotal() })
			return total
		}
	}
	return c
}

// Sync replaces the set of containers to sample. It never blocks on a pass.
func (c *Collector) Sync(targets []Target) {
	c.mu.Lock()
	c.targets = slices.Clone(targets)
	c.mu.Unlock()
}

// SetInterval sets the sampling interval, clamped to [MinInterval,
// MaxInterval]; d ≤ 0 stops sampling.
func (c *Collector) SetInterval(d time.Duration) {
	d = ClampInterval(d)
	c.mu.Lock()
	c.interval = d
	c.mu.Unlock()
	select {
	case c.changed <- struct{}{}:
	default:
	}
}

// ClampInterval returns d within [MinInterval, MaxInterval], or 0 for
// d ≤ 0 (no sampling).
func ClampInterval(d time.Duration) time.Duration {
	if d <= 0 {
		return 0
	}
	return min(max(d, MinInterval), MaxInterval)
}

// Run samples until ctx ends.
//
// When sampling starts (or restarts after being stopped), Run takes a
// baseline pass at once and sends nothing, so the first frame, one
// interval later, already carries real deltas.
func (c *Collector) Run(ctx context.Context) error {
	var interval time.Duration
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	defer timer.Stop()
	var tick <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-c.changed:
			c.mu.Lock()
			d := c.interval
			c.mu.Unlock()
			if d == interval {
				continue
			}
			wasOff := interval == 0
			interval = d
			timer.Stop()
			if d == 0 {
				tick = nil
				c.log.Info("metrics sampling stopped")
				continue
			}
			if wasOff {
				c.log.Info("metrics sampling started", "interval", d)
				c.collect(ctx, d)
			}
			timer.Reset(d)
			tick = timer.C
		case <-tick:
			c.tick(ctx, interval)
			timer.Reset(interval)
		}
	}
}

// tick takes one pass and sends its frame.
func (c *Collector) tick(ctx context.Context, interval time.Duration) {
	if !c.lastSent.IsZero() && c.opts.Now().Sub(c.lastSent) < MinFrameGap {
		return
	}
	m := c.collect(ctx, interval)
	if m == nil {
		return
	}
	c.lastSent = c.opts.Now()
	sendCtx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	if err := c.opts.Send(sendCtx, m); err != nil && ctx.Err() == nil {
		c.log.Warn("send metrics", "samples", len(m.Samples), "err", err)
	}
}

// collect samples every target and returns the frame, or nil when there is
// nothing to send. interval is the nominal interval, used to decide whether
// the previous pass is recent enough to delta against.
func (c *Collector) collect(ctx context.Context, interval time.Duration) *protocol.Metrics {
	targets := c.pick()
	start := c.opts.Now()
	if !c.lastPass.IsZero() && start.Sub(c.lastPass) > staleAfter*interval {
		clear(c.prev)
	}
	elapsed := interval
	if !c.lastPass.IsZero() {
		elapsed = start.Sub(c.lastPass)
	}
	c.lastPass = start

	cgroupV2 := c.fs.v2()
	m := &protocol.Metrics{
		Type:       protocol.TypeMetrics,
		TS:         start.UnixMilli(),
		IntervalMS: min(max(elapsed.Milliseconds(), protocol.MinMetricsIntervalMS), protocol.MaxMetricsIntervalMS),
		Source:     protocol.MetricsCgroupV2,
	}
	live := make(map[string]bool, len(targets))
	for _, t := range targets {
		r, err := c.read(ctx, t, cgroupV2)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			c.log.Debug("sample container", "workload_id", t.WorkloadID, "err", err)
			continue
		}
		live[t.ID] = true
		// NOTE: a frame has one source. A pass that needed Docker for any
		// container is labelled docker_stats, the approximate one, rather
		// than split into two frames: that keeps one frame per pass under
		// the once-per-second limit, and the label only ever understates
		// precision.
		if r.source == protocol.MetricsDockerStats {
			m.Source = protocol.MetricsDockerStats
		}
		m.Samples = append(m.Samples, c.delta(t, r, c.opts.Now()))
	}
	for id := range c.prev {
		if !live[id] {
			delete(c.prev, id)
		}
	}
	if len(m.Samples) == 0 {
		return nil
	}
	fitFrame(m)
	return m
}

// pick returns the running containers to sample this pass: one per
// workload (the newest start), sorted by workload ID, at most
// [protocol.MaxMetricSamples].
func (c *Collector) pick() []Target {
	c.mu.Lock()
	all := slices.Clone(c.targets)
	c.mu.Unlock()

	byWorkload := map[string]Target{}
	for _, t := range all {
		if !t.Running || t.ID == "" || t.WorkloadID == "" {
			continue
		}
		// NOTE: during a rollout two containers can share a workload ID, and
		// a frame may name each workload once; the newest is the one that
		// serves.
		if cur, ok := byWorkload[t.WorkloadID]; ok &&
			(cur.StartedAt.After(t.StartedAt) || (cur.StartedAt.Equal(t.StartedAt) && cur.ID > t.ID)) {
			continue
		}
		byWorkload[t.WorkloadID] = t
	}
	out := make([]Target, 0, len(byWorkload))
	for _, t := range byWorkload {
		out = append(out, t)
	}
	slices.SortFunc(out, func(a, b Target) int { return strings.Compare(a.WorkloadID, b.WorkloadID) })
	if len(out) > protocol.MaxMetricSamples {
		if !c.capWarned {
			c.log.Warn("more containers than one metrics frame carries; sampling the first by workload ID",
				"containers", len(out), "max", protocol.MaxMetricSamples)
			c.capWarned = true
		}
		out = out[:protocol.MaxMetricSamples]
	} else {
		c.capWarned = false
	}
	return out
}

// read samples one container from its cgroup, or from Docker when cgroup
// v2 is unavailable or the cgroup cannot be read.
func (c *Collector) read(ctx context.Context, t Target, cgroupV2 bool) (reading, error) {
	var cgErr error
	if cgroupV2 {
		r, err := c.fs.read(t.PID, t.ID, c.opts.MemTotal)
		if err == nil {
			return r, nil
		}
		cgErr = err
	} else {
		cgErr = errNoCgroupV2
	}
	if c.opts.Stats == nil {
		return reading{}, cgErr
	}
	if !c.fellBack {
		c.log.Info("reading container metrics from Docker stats", "reason", cgErr)
		c.fellBack = true
	}
	ctx, cancel := context.WithTimeout(ctx, statsTimeout)
	defer cancel()
	s, err := c.opts.Stats.ContainerStats(ctx, t.ID)
	if err != nil {
		return reading{}, errors.Join(cgErr, err)
	}
	return fromDockerStats(s, c.opts.MemTotal), nil
}

// delta turns a reading into a sample against the container's previous
// reading, and records it as the new previous one.
//
// Counters delta to 0 on the first reading of a container, after it
// restarts (its PID or start time changed) or changes source, and
// individually when one goes backwards. Restarts delta separately: a
// restart always changes the PID, and it must still be counted.
func (c *Collector) delta(t Target, r reading, now time.Time) protocol.ContainerSample {
	s := protocol.ContainerSample{
		WorkloadID:    t.WorkloadID,
		MemBytes:      max(r.mem, 0),
		MemLimitBytes: max(r.memLimit, 0),
		PIDs:          max(r.pids, 0),
	}
	p, ok := c.prev[t.ID]
	if ok && t.Restarts >= p.restarts {
		s.Restarts = int64(t.Restarts - p.restarts)
	}
	fresh := !ok || p.pid != t.PID || !p.startedAt.Equal(t.StartedAt) || p.source != r.source
	if dt := now.Sub(p.at); !fresh && dt > 0 {
		cur, old := r.counters, p.counters
		s.CPUMillis = int64(float64(sub(cur.cpuUsec, old.cpuUsec)) * 1000 / float64(dt.Microseconds()))
		s.NetRxBytes = int64(sub(cur.netRx, old.netRx))
		s.NetTxBytes = int64(sub(cur.netTx, old.netTx))
		s.DiskReadBytes = int64(sub(cur.diskRead, old.diskRead))
		s.DiskWriteBytes = int64(sub(cur.diskWrite, old.diskWrite))
	}
	c.prev[t.ID] = prevState{
		at: now, pid: t.PID, startedAt: t.StartedAt, source: r.source,
		counters: r.counters, restarts: t.Restarts,
	}
	return s
}

// sub returns cur − old, or 0 when the counter went backwards (a reset).
// The result is capped so it converts to a non-negative int64.
func sub(cur, old uint64) uint64 {
	if cur < old {
		return 0
	}
	return min(cur-old, 1<<63-1)
}

// fitFrame drops samples from the end until the frame fits
// [protocol.MaxAgentFrameBytes]. 160 samples are far below it; this only
// guards the invariant.
func fitFrame(m *protocol.Metrics) {
	for len(m.Samples) > 1 {
		data, err := json.Marshal(m)
		if err == nil && len(data) <= protocol.MaxAgentFrameBytes {
			return
		}
		m.Samples = m.Samples[:len(m.Samples)-1]
	}
}
