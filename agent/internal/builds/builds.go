// Package builds runs build jobs on a builder node, one at a time.
//
// Responsibilities:
//   - run each accepted job through the [builder.Builder] with a hard
//     deadline, streaming its output as logs frames;
//   - answer every job with exactly one build_result: a job that arrives
//     while another runs, or on a node that is not a builder, fails at once;
//     a job re-sent after its result was produced gets the same result again;
//   - deliver results reliably, retrying while the connection is down, and
//     cancel the running build on shutdown.
package builds

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/BankkRoll/Open-Rail/agent/internal/builder"
	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
)

// deadlineGrace is added to a job's timeout_s before the dispatcher cancels
// it itself, so the builder's own timeout normally fires first and reports a
// precise error.
const deadlineGrace = 30 * time.Second

const (
	retryEvery    = 2 * time.Second
	sendTimeout   = 10 * time.Second
	maxPending    = 64
	recentResults = 32
)

// Options configures a [Dispatcher].
type Options struct {
	// Builder runs jobs; nil means this node is not a builder and every job
	// is refused.
	Builder builder.Builder
	// Send delivers a build_result; it returns an error if the frame was not
	// delivered, and the result is retried.
	Send func(ctx context.Context, r *protocol.BuildResult) error
	// Ready, when set, is checked before each build; an error fails the job
	// at once with its message (e.g. the local registry is not up yet).
	Ready func() error
	// Logs delivers a build's output frames.
	Logs   func(ctx context.Context, l protocol.Logs) error
	Logger *slog.Logger
	// Now is the clock; nil uses time.Now.
	Now func() time.Time
}

// Dispatcher accepts build jobs from the connection and runs them. Create it
// with [New] and run it with [Dispatcher.Run].
type Dispatcher struct {
	opts Options
	log  *slog.Logger
	kick chan struct{}
	jobs chan *protocol.BuildJob

	mu      sync.Mutex
	running string // build ID of the running job, "" if idle
	cancel  context.CancelFunc
	pending []*protocol.BuildResult
	recent  []*protocol.BuildResult
	stopped bool
	wg      sync.WaitGroup
}

// New returns a dispatcher.
func New(opts Options) *Dispatcher {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Dispatcher{opts: opts, log: log, kick: make(chan struct{}, 1), jobs: make(chan *protocol.BuildJob, 1)}
}

// Start accepts a job without blocking. Jobs are answered with a failed
// result when the node is not a builder or already building.
func (d *Dispatcher) Start(job *protocol.BuildJob) {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch {
	case d.stopped:
		return
	case job.BuildID == d.running:
		d.log.Info("ignoring duplicate build job; it is already running", "build_id", job.BuildID)
		return
	}
	for _, r := range d.recent {
		if r.BuildID == job.BuildID {
			d.log.Info("build job re-sent after it finished; re-sending its result", "build_id", job.BuildID)
			d.queueLocked(r)
			return
		}
	}
	switch {
	case d.opts.Builder == nil:
		d.finishLocked(d.failed(job.BuildID, "this node is not a builder", 0))
	case d.running != "":
		d.finishLocked(d.failed(job.BuildID, "another build ("+d.running+") is running on this node; retry later", 0))
	default:
		if d.opts.Ready != nil {
			if err := d.opts.Ready(); err != nil {
				d.finishLocked(d.failed(job.BuildID, err.Error(), 0))
				return
			}
		}
		d.running = job.BuildID
		d.jobs <- job
	}
}

// Connected retries undelivered results at once.
func (d *Dispatcher) Connected() {
	select {
	case d.kick <- struct{}{}:
	default:
	}
}

// Run executes jobs and delivers results until ctx ends; then it cancels a
// running build and waits for it to return.
func (d *Dispatcher) Run(ctx context.Context) error {
	t := time.NewTicker(retryEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			d.mu.Lock()
			d.stopped = true
			if d.cancel != nil {
				d.cancel()
			}
			d.mu.Unlock()
			d.wg.Wait()
			return nil
		case job := <-d.jobs:
			d.run(ctx, job)
		case <-d.kick:
			d.deliver(ctx)
		case <-t.C:
			d.deliver(ctx)
		}
	}
}

func (d *Dispatcher) run(ctx context.Context, job *protocol.BuildJob) {
	limit := time.Duration(job.TimeoutS)*time.Second + deadlineGrace
	bctx, cancel := context.WithTimeout(ctx, limit)
	d.mu.Lock()
	d.cancel = cancel
	d.mu.Unlock()
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		defer cancel()
		started := d.opts.Now()
		d.log.Info("build started", "build_id", job.BuildID, "deployment_id", job.DeploymentID, "builder", job.Builder)
		emit := func(l protocol.Logs) {
			if l.Source.Type == "" {
				l.Source = protocol.LogSource{Type: protocol.LogSourceBuild, BuildID: job.BuildID}
			}
			if l.Type == "" {
				l.Type = protocol.TypeLogs
			}
			if d.opts.Logs != nil {
				if err := d.opts.Logs(bctx, l); err != nil && bctx.Err() == nil {
					d.log.Debug("drop build log frame", "build_id", job.BuildID, "err", err)
				}
			}
		}
		res := d.opts.Builder.Run(bctx, *job, emit)
		elapsed := d.opts.Now().Sub(started)
		r := d.normalize(job.BuildID, res, elapsed)
		if bctx.Err() != nil && ctx.Err() == nil && r.OK {
			r = d.failed(job.BuildID, "build exceeded its deadline", elapsed)
		}
		d.log.Info("build finished", "build_id", job.BuildID, "ok", r.OK, "error", r.Error, "duration", elapsed.Round(time.Millisecond))
		d.mu.Lock()
		d.running, d.cancel = "", nil
		if ctx.Err() == nil {
			d.finishLocked(r)
		}
		d.mu.Unlock()
		d.Connected()
	}()
}

// normalize makes res a valid result for buildID, turning anything invalid
// into a failure that says so.
func (d *Dispatcher) normalize(buildID string, res protocol.BuildResult, elapsed time.Duration) *protocol.BuildResult {
	res.Type = protocol.TypeBuildResult
	res.BuildID = buildID
	res.DurationMS = max(res.DurationMS, 0)
	if res.DurationMS == 0 {
		res.DurationMS = elapsed.Milliseconds()
	}
	if !res.OK && res.Error == "" {
		res.Error = "build failed"
	}
	res.Error = truncate(res.Error, protocol.MaxMessageBytes)
	if err := res.Validate(); err != nil {
		return d.failed(buildID, "builder returned an invalid result: "+err.Error(), elapsed)
	}
	return &res
}

func (d *Dispatcher) failed(buildID, msg string, elapsed time.Duration) *protocol.BuildResult {
	return &protocol.BuildResult{
		Type: protocol.TypeBuildResult, BuildID: buildID, Error: truncate(msg, protocol.MaxMessageBytes),
		DurationMS: elapsed.Milliseconds(),
	}
}

// finishLocked records a final result and queues it. Caller holds d.mu.
func (d *Dispatcher) finishLocked(r *protocol.BuildResult) {
	d.recent = append(d.recent, r)
	if len(d.recent) > recentResults {
		d.recent = d.recent[len(d.recent)-recentResults:]
	}
	d.queueLocked(r)
}

// queueLocked queues r for delivery. Caller holds d.mu.
func (d *Dispatcher) queueLocked(r *protocol.BuildResult) {
	d.pending = append(d.pending, r)
	if len(d.pending) > maxPending {
		d.log.Warn("too many undelivered build results; dropping the oldest", "build_id", d.pending[0].BuildID)
		d.pending = d.pending[1:]
	}
	select {
	case d.kick <- struct{}{}:
	default:
	}
}

// deliver sends pending results in order until one fails.
func (d *Dispatcher) deliver(ctx context.Context) {
	for ctx.Err() == nil {
		d.mu.Lock()
		if len(d.pending) == 0 {
			d.mu.Unlock()
			return
		}
		r := d.pending[0]
		d.mu.Unlock()
		sctx, cancel := context.WithTimeout(ctx, sendTimeout)
		err := d.opts.Send(sctx, r)
		cancel()
		if err != nil {
			return
		}
		d.mu.Lock()
		if len(d.pending) > 0 && d.pending[0] == r {
			d.pending = d.pending[1:]
		}
		d.mu.Unlock()
	}
}

func truncate(s string, n int) string {
	s = strings.ToValidUTF8(s, "�")
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
