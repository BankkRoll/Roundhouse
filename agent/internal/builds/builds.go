// Package builds runs build jobs on a builder node, one at a time.
//
// Responsibilities:
//   - run each accepted job through the [builder.Builder] with a hard
//     deadline, streaming its output as logs frames;
//   - answer every job with exactly one build_result: a job that arrives
//     while another runs, or on a node that is not a builder, fails at once;
//     a job re-sent after its result was produced gets the same result again;
//   - cancel a build on build_cancel: the builder stops at once and the job
//     is answered with a failed result marked cancelled; a job arriving
//     while a cancelled build winds down waits for it instead of failing, so
//     a redeploy right after a cancel builds at once;
//   - deliver results reliably, retrying while the connection is down, and
//     cancel the running build on shutdown.
package builds

import (
	"context"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/BankkRoll/Roundhouse/agent/internal/builder"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
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
	// earlyCancels bounds the cancels remembered for builds not seen yet.
	earlyCancels = 64
)

// cancelledMessage is the error of a result for a cancelled build.
const cancelledMessage = "Build was cancelled."

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
	// cancelling is set when the running build was cancelled and is winding
	// down; next is the job that runs as soon as it has.
	cancelling bool
	next       *protocol.BuildJob
	// cancelled holds IDs cancelled before their job arrived, oldest first.
	cancelled []string
	pending   []*protocol.BuildResult
	recent    []*protocol.BuildResult
	stopped   bool
	wg        sync.WaitGroup
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
// result when the node is not a builder or already building, unless the
// running build was cancelled: then the job runs as soon as it has stopped.
func (d *Dispatcher) Start(job *protocol.BuildJob) {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch {
	case d.stopped:
		return
	case job.BuildID == d.running || (d.next != nil && job.BuildID == d.next.BuildID):
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
	if i := slices.Index(d.cancelled, job.BuildID); i >= 0 {
		d.cancelled = slices.Delete(d.cancelled, i, i+1)
		d.log.Info("build job arrived after its cancel; not running it", "build_id", job.BuildID)
		d.finishLocked(d.cancelledResult(job.BuildID, 0))
		return
	}
	switch {
	case d.opts.Builder == nil:
		d.finishLocked(d.failed(job.BuildID, "this node is not a builder", 0))
	case d.running != "" && d.cancelling && d.next == nil:
		d.log.Info("build job waits for the cancelled build to stop", "build_id", job.BuildID, "cancelled", d.running)
		d.next = job
	case d.running != "":
		d.finishLocked(d.failed(job.BuildID, "another build ("+d.running+") is running on this node; retry later", 0))
	default:
		d.dispatchLocked(job)
	}
}

// dispatchLocked hands job to the run loop, or fails it if the node is not
// ready. Caller holds d.mu and the dispatcher is idle.
func (d *Dispatcher) dispatchLocked(job *protocol.BuildJob) {
	if d.opts.Ready != nil {
		if err := d.opts.Ready(); err != nil {
			d.finishLocked(d.failed(job.BuildID, err.Error(), 0))
			return
		}
	}
	d.running = job.BuildID
	d.jobs <- job
}

// Cancel stops a build. A running build is cancelled at once and its result
// says so; a job not seen yet is answered as cancelled when it arrives; a
// finished build is left alone.
func (d *Dispatcher) Cancel(buildID string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch {
	case d.stopped:
	case buildID == d.running:
		if !d.cancelling {
			d.log.Info("cancelling build", "build_id", buildID)
			d.cancelling = true
			if d.cancel != nil {
				d.cancel()
			}
		}
	case d.next != nil && buildID == d.next.BuildID:
		d.log.Info("cancelling queued build", "build_id", buildID)
		d.next = nil
		d.finishLocked(d.cancelledResult(buildID, 0))
	case slices.ContainsFunc(d.recent, func(r *protocol.BuildResult) bool { return r.BuildID == buildID }):
		d.log.Debug("ignoring cancel for a finished build", "build_id", buildID)
	case !slices.Contains(d.cancelled, buildID):
		d.cancelled = append(d.cancelled, buildID)
		if len(d.cancelled) > earlyCancels {
			d.cancelled = d.cancelled[len(d.cancelled)-earlyCancels:]
		}
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
	// NOTE: a cancel that raced the hand-off from Start to here set
	// cancelling but found no cancel func to call yet.
	if d.cancelling {
		cancel()
	}
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
				// NOTE: submitted under the dispatcher's context, not the
				// build's: the lines explaining a cancel or a timeout come
				// after the build's context ended and must not be dropped.
				if err := d.opts.Logs(ctx, l); err != nil && ctx.Err() == nil {
					d.log.Debug("drop build log frame", "build_id", job.BuildID, "err", err)
				}
			}
		}
		res := d.opts.Builder.Run(bctx, *job, emit)
		elapsed := d.opts.Now().Sub(started)
		r := d.normalize(job.BuildID, res, elapsed)
		d.mu.Lock()
		cancelled := d.cancelling
		d.mu.Unlock()
		switch {
		case cancelled && !r.OK:
			r = d.cancelledResult(job.BuildID, elapsed)
		case bctx.Err() != nil && ctx.Err() == nil && r.OK && !cancelled:
			r = d.failed(job.BuildID, "build exceeded its deadline", elapsed)
		}
		d.log.Info("build finished", "build_id", job.BuildID, "ok", r.OK, "cancelled", r.Cancelled,
			"error", r.Error, "duration", elapsed.Round(time.Millisecond))
		d.mu.Lock()
		d.running, d.cancel, d.cancelling = "", nil, false
		if ctx.Err() == nil {
			d.finishLocked(r)
			if next := d.next; next != nil {
				d.next = nil
				d.dispatchLocked(next)
			}
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

// cancelledResult answers a cancelled build.
func (d *Dispatcher) cancelledResult(buildID string, elapsed time.Duration) *protocol.BuildResult {
	r := d.failed(buildID, cancelledMessage, elapsed)
	r.Cancelled = true
	return r
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
