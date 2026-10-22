// Package logship ships container output to the control plane as logs
// frames.
//
// Responsibilities:
//   - follow the stdout and stderr of every managed service container,
//     splitting the engine's multiplexed stream, and resume after a restart
//     (of the container or the agent) from the last timestamp shipped, so no
//     line is sent twice;
//   - batch lines per workload into frames of at most 500 lines and 64 KiB
//     of text, each line cut to 16 KiB, flushed at least every second;
//   - hand frames to the connection, or, while it is down, to a bounded
//     on-disk ring buffer that is replayed in order on reconnect.
//
// Nothing here blocks the reconciler: it only calls [Shipper.Sync], which
// records the container list and returns.
package logship

import (
	"bufio"
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/BankkRoll/Open-Rail/agent/internal/atomicfile"
	"github.com/BankkRoll/Open-Rail/agent/internal/docker"
	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
)

// Defaults applied when the corresponding [Options] field is zero.
const (
	DefaultSpoolBytes    = 16 << 20
	DefaultFlushInterval = time.Second
)

const (
	sendTimeout        = 10 * time.Second
	positionsFile      = "positions.json"
	positionsEvery     = 2 * time.Second
	maxFollowBackoff   = 30 * time.Second
	frameQueue         = 64
	lineQueue          = 4096
	maxEncodedFrame    = protocol.MaxAgentFrameBytes
	frameEnvelopeBytes = 512
)

// Target is a container whose output should be shipped.
type Target struct {
	ContainerID  string
	WorkloadID   string
	DeploymentID string
	Running      bool
	// StartedAt changes whenever the container is (re)started; a change
	// resumes following.
	StartedAt time.Time
}

// LogSource opens a container's log stream; *docker.Client implements it.
type LogSource interface {
	ContainerLogs(ctx context.Context, id string, opts docker.LogsOptions) (io.ReadCloser, error)
}

// Options configures a [Shipper].
type Options struct {
	Docker LogSource
	// Send delivers one frame. It must return an error when the frame was
	// not delivered (for example, not connected); the frame is then kept
	// on disk and retried.
	Send func(ctx context.Context, l *protocol.Logs) error
	// Dir holds the ring buffer and the per-container read positions.
	Dir string
	// SpoolBytes bounds the ring buffer.
	SpoolBytes int64
	// FlushInterval is the longest a line waits before its batch is sent.
	FlushInterval time.Duration
	Logger        *slog.Logger
}

// Shipper follows container logs and delivers them. Create it with [New] and
// start it with [Shipper.Run].
type Shipper struct {
	opts  Options
	log   *slog.Logger
	spool *spool

	lines  chan entry
	frames chan *protocol.Logs
	kick   chan struct{}

	stopped chan struct{}

	mu        sync.Mutex
	running   bool
	followers map[string]*follower
	positions map[string]int64 // container ID → unix nanos of the last line
	dirty     bool
	ctx       context.Context
	wg        sync.WaitGroup
}

type entry struct {
	source protocol.LogSource
	line   protocol.LogLine
}

type follower struct {
	target  Target
	cancel  context.CancelFunc // nil until started
	restart chan struct{}
}

// New opens the shipper's ring buffer and positions in opts.Dir.
func New(opts Options) (*Shipper, error) {
	opts.SpoolBytes = cmp.Or(opts.SpoolBytes, DefaultSpoolBytes)
	opts.FlushInterval = cmp.Or(opts.FlushInterval, DefaultFlushInterval)
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	sp, err := openSpool(filepath.Join(opts.Dir, "spool"), opts.SpoolBytes)
	if err != nil {
		return nil, fmt.Errorf("open log spool: %w", err)
	}
	s := &Shipper{
		opts:      opts,
		log:       log,
		spool:     sp,
		lines:     make(chan entry, lineQueue),
		frames:    make(chan *protocol.Logs, frameQueue),
		kick:      make(chan struct{}, 1),
		stopped:   make(chan struct{}),
		followers: map[string]*follower{},
		positions: map[string]int64{},
		ctx:       context.Background(),
	}
	if data, err := os.ReadFile(filepath.Join(opts.Dir, positionsFile)); err == nil {
		_ = json.Unmarshal(data, &s.positions)
	}
	return s, nil
}

// Run batches and delivers lines until ctx ends, then stops every follower,
// moves undelivered frames to disk and saves read positions.
func (s *Shipper) Run(ctx context.Context) error {
	s.mu.Lock()
	s.ctx = ctx
	s.running = true
	for _, f := range s.followers {
		s.startFollower(f)
	}
	s.mu.Unlock()

	batchDone := make(chan struct{})
	go func() {
		defer close(batchDone)
		s.batch(ctx)
	}()
	s.deliver(ctx, batchDone)

	s.mu.Lock()
	s.running = false
	for _, f := range s.followers {
		if f.cancel != nil {
			f.cancel()
			f.cancel = nil
		}
	}
	s.mu.Unlock()
	s.wg.Wait()
	close(s.stopped)
	s.savePositions()
	return nil
}

// Connected tells the shipper the connection is up, so buffered frames are
// replayed at once rather than on the next retry tick.
func (s *Shipper) Connected() {
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

// Sync sets the containers to follow. Containers without a deployment
// (system workloads) are skipped: runtime logs frames require one. It never
// blocks on I/O.
func (s *Shipper) Sync(targets []Target) {
	s.mu.Lock()
	defer s.mu.Unlock()
	want := map[string]Target{}
	for _, t := range targets {
		if t.DeploymentID != "" {
			want[t.ContainerID] = t
		}
	}
	for id, f := range s.followers {
		if _, ok := want[id]; !ok {
			if f.cancel != nil {
				f.cancel()
			}
			delete(s.followers, id)
		}
	}
	for id, t := range want {
		f, ok := s.followers[id]
		if !ok {
			f = &follower{target: t, restart: make(chan struct{}, 1)}
			s.followers[id] = f
			if s.running {
				s.startFollower(f)
			}
			continue
		}
		if !t.StartedAt.Equal(f.target.StartedAt) || (t.Running && !f.target.Running) {
			select {
			case f.restart <- struct{}{}:
			default:
			}
		}
		f.target = t
	}
	for id := range s.positions {
		if _, ok := want[id]; !ok {
			delete(s.positions, id)
			s.dirty = true
		}
	}
}

// startFollower launches f's goroutine. Caller holds s.mu.
func (s *Shipper) startFollower(f *follower) {
	ctx, cancel := context.WithCancel(s.ctx)
	f.cancel = cancel
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.follow(ctx, f)
	}()
}

// Submit queues a ready-made frame, such as build output. Frames over the
// protocol limits are split; invalid lines are cut to size.
func (s *Shipper) Submit(ctx context.Context, l protocol.Logs) error {
	for _, fr := range splitFrame(l) {
		select {
		case s.frames <- fr:
		case <-ctx.Done():
			return ctx.Err()
		case <-s.stopped:
			return errors.New("log shipper stopped")
		}
	}
	return nil
}

// -----------------------------------------------------------------------------
// Following
// -----------------------------------------------------------------------------

func (s *Shipper) follow(ctx context.Context, f *follower) {
	s.mu.Lock()
	id := f.target.ContainerID
	source := protocol.LogSource{Type: protocol.LogSourceRuntime, WorkloadID: f.target.WorkloadID, DeploymentID: f.target.DeploymentID}
	last := s.positions[id]
	s.mu.Unlock()

	delay := time.Second
	for {
		start := time.Now()
		var err error
		last, err = s.followOnce(ctx, id, source, last)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			s.log.Debug("log stream ended", "container", id[:min(12, len(id))], "err", err)
		}
		if time.Since(start) > time.Minute {
			delay = time.Second
		}
		s.mu.Lock()
		running := f.target.Running
		s.mu.Unlock()
		// A stopped container's stream ends at once; wait for it to start
		// again rather than spinning. A running one ending means the stream
		// broke, so retry with backoff.
		var retry <-chan time.Time
		var t *time.Timer
		if running {
			t = time.NewTimer(delay)
			retry = t.C
			delay = min(delay*2, maxFollowBackoff)
		}
		select {
		case <-ctx.Done():
		case <-f.restart:
		case <-retry:
		}
		if t != nil {
			t.Stop()
		}
		if ctx.Err() != nil {
			return
		}
	}
}

// followOnce streams logs written after last (unix nanos) until the stream
// ends, and returns the new last timestamp.
func (s *Shipper) followOnce(ctx context.Context, id string, source protocol.LogSource, last int64) (int64, error) {
	opts := docker.LogsOptions{Follow: true, Timestamps: true}
	if last > 0 {
		opts.Since = time.Unix(0, last)
	}
	since := last
	rc, err := s.opts.Docker.ContainerLogs(ctx, id, opts)
	if err != nil {
		return last, err
	}
	defer rc.Close()
	d := docker.NewDemuxer(bufio.NewReaderSize(rc, 64<<10))
	for {
		st, payload, err := d.Next()
		if err != nil {
			if errors.Is(err, io.EOF) {
				err = nil
			}
			return last, err
		}
		stream := protocol.StreamStdout
		switch st {
		case docker.Stderr:
			stream = protocol.StreamStderr
		case docker.Systemerr:
			stream = protocol.StreamSystem
		}
		for _, raw := range bytes.Split(bytes.TrimSuffix(payload, []byte("\n")), []byte("\n")) {
			ts, text := splitTimestamp(raw)
			// NOTE: since is inclusive, so the last line shipped comes back
			// on resume; anything at or before it was shipped already. Only
			// the cursor from before this stream counts: the engine stamps
			// stdout and stderr separately, so within one stream timestamps
			// are not strictly ordered.
			if ts.UnixNano() <= since {
				continue
			}
			last = max(last, ts.UnixNano())
			line := protocol.LogLine{TS: ts.UnixMilli(), Stream: stream, Text: protocol.TruncateLogLine(string(text))}
			select {
			case s.lines <- entry{source: source, line: line}:
			case <-ctx.Done():
				return last, nil
			}
			s.mu.Lock()
			s.positions[id] = last
			s.dirty = true
			s.mu.Unlock()
		}
	}
}

// splitTimestamp separates the RFC 3339 timestamp the engine prefixes to
// each line. A line without one is stamped now.
func splitTimestamp(raw []byte) (time.Time, []byte) {
	if i := bytes.IndexByte(raw, ' '); i > 0 {
		if ts, err := time.Parse(time.RFC3339Nano, string(raw[:i])); err == nil {
			return ts, raw[i+1:]
		}
	}
	return time.Now(), raw
}

// -----------------------------------------------------------------------------
// Batching
// -----------------------------------------------------------------------------

type pending struct {
	source protocol.LogSource
	lines  []protocol.LogLine
	bytes  int
}

// batch groups lines per source into frames and flushes them when full or
// every FlushInterval.
func (s *Shipper) batch(ctx context.Context) {
	batches := map[protocol.LogSource]*pending{}
	tick := time.NewTicker(s.opts.FlushInterval)
	defer tick.Stop()
	persist := time.NewTicker(positionsEvery)
	defer persist.Stop()
	flush := func(p *pending) {
		if len(p.lines) == 0 {
			return
		}
		fr := &protocol.Logs{Type: protocol.TypeLogs, Source: p.source, Lines: p.lines}
		p.lines, p.bytes = nil, 0
		// NOTE: deliver keeps reading until batch returns, so this cannot
		// block forever, even during shutdown.
		s.frames <- fr
	}
	defer func() {
		for _, p := range batches {
			flush(p)
		}
	}()
	for {
		select {
		case <-ctx.Done():
			// Drain what followers already queued, without waiting.
			for {
				select {
				case e := <-s.lines:
					s.add(batches, e, flush)
				default:
					return
				}
			}
		case e := <-s.lines:
			s.add(batches, e, flush)
		case <-tick.C:
			for k, p := range batches {
				flush(p)
				delete(batches, k)
			}
		case <-persist.C:
			s.savePositions()
		}
	}
}

func (s *Shipper) add(batches map[protocol.LogSource]*pending, e entry, flush func(*pending)) {
	p := batches[e.source]
	if p == nil {
		p = &pending{source: e.source}
		batches[e.source] = p
	}
	if len(p.lines) >= protocol.MaxLogLinesPerFrame || p.bytes+len(e.line.Text) > protocol.MaxLogFrameTextBytes {
		flush(p)
	}
	p.lines = append(p.lines, e.line)
	p.bytes += len(e.line.Text)
}

// splitFrame cuts l into frames within the protocol limits: line count,
// text bytes, and encoded size (control characters expand up to six-fold
// when JSON-escaped).
func splitFrame(l protocol.Logs) []*protocol.Logs {
	var out []*protocol.Logs
	cur := &protocol.Logs{Type: protocol.TypeLogs, Source: l.Source}
	text, encoded := 0, frameEnvelopeBytes
	for _, line := range l.Lines {
		line.Text = protocol.TruncateLogLine(line.Text)
		enc := encodedSize(line.Text) + 64
		if len(cur.Lines) > 0 && (len(cur.Lines) >= protocol.MaxLogLinesPerFrame ||
			text+len(line.Text) > protocol.MaxLogFrameTextBytes || encoded+enc > maxEncodedFrame) {
			out = append(out, cur)
			cur = &protocol.Logs{Type: protocol.TypeLogs, Source: l.Source}
			text, encoded = 0, frameEnvelopeBytes
		}
		cur.Lines = append(cur.Lines, line)
		text += len(line.Text)
		encoded += enc
	}
	if len(cur.Lines) > 0 {
		out = append(out, cur)
	}
	return out
}

func encodedSize(s string) int {
	data, _ := json.Marshal(s)
	return len(data)
}

// -----------------------------------------------------------------------------
// Delivery
// -----------------------------------------------------------------------------

// deliver sends frames in order until batchDone closes, then moves what is
// left to disk. While the ring buffer holds anything, new frames go behind
// it, so replay never reorders lines.
func (s *Shipper) deliver(ctx context.Context, batchDone <-chan struct{}) {
	retry := time.NewTicker(time.Second)
	defer retry.Stop()
	for {
		select {
		case <-batchDone:
			for {
				select {
				case fr := <-s.frames:
					s.store(fr)
				default:
					return
				}
			}
		case fr := <-s.frames:
			if s.spool.empty() && ctx.Err() == nil && s.send(ctx, fr) == nil {
				continue
			}
			s.store(fr)
		case <-s.kick:
			s.drain(ctx)
		case <-retry.C:
			s.drain(ctx)
		}
	}
}

func (s *Shipper) send(ctx context.Context, fr *protocol.Logs) error {
	ctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	return s.opts.Send(ctx, fr)
}

func (s *Shipper) store(fr *protocol.Logs) {
	data, err := json.Marshal(fr)
	if err != nil {
		return
	}
	dropped, err := s.spool.append(data)
	if err != nil {
		s.log.Error("log buffer write failed; dropping frame", "err", err, "lines", len(fr.Lines))
		return
	}
	if dropped > 0 {
		s.log.Warn("log buffer full; dropped the oldest buffered logs", "dropped_bytes", dropped)
	}
}

// drain replays buffered frames until one fails to send.
func (s *Shipper) drain(ctx context.Context) {
	for ctx.Err() == nil {
		rec, err := s.spool.peek()
		if err != nil {
			s.log.Error("log buffer read failed", "err", err)
			return
		}
		if rec == nil {
			return
		}
		var fr protocol.Logs
		if err := json.Unmarshal(rec, &fr); err != nil || fr.Validate() != nil {
			_ = s.spool.pop(rec)
			continue
		}
		if s.send(ctx, &fr) != nil {
			return
		}
		if err := s.spool.pop(rec); err != nil {
			s.log.Warn("persist log buffer position", "err", err)
		}
	}
}

func (s *Shipper) savePositions() {
	s.mu.Lock()
	if !s.dirty {
		s.mu.Unlock()
		return
	}
	data, err := json.Marshal(maps.Clone(s.positions))
	s.dirty = false
	s.mu.Unlock()
	if err == nil {
		err = atomicfile.Write(filepath.Join(s.opts.Dir, positionsFile), data, 0o600)
	}
	if err != nil {
		s.log.Warn("persist log positions", "err", err)
	}
}
