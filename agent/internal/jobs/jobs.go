// Package jobs runs job_run workloads (ADR 0010): cron runs and pre-deploy
// commands, one container per run, to completion. It works beside the
// runtime's reconciler, which never sees job containers.
//
// Responsibilities:
//   - admit each run as the runtime admits service workloads (its own
//     environment network, its own service's local images), open its sealed
//     environment, and answer what doesn't pass, or what would exceed
//     max_concurrent, with a failed status and nothing started;
//   - pull the image, create the container with the runtime's hardening and
//     labels the reconciler ignores, start it, and report pulling, running
//     and exactly one terminal status per run;
//   - ship its stdout and stderr as job logs frames, resuming after an
//     agent restart from the last line shipped;
//   - enforce timeout_s and job_cancel with SIGTERM, kill_grace_s, SIGKILL;
//   - persist runs in flight in jobs.json (never environment or secret
//     values) and, after an agent restart, re-attach to them under their
//     original deadline, report the ones that finished or vanished meanwhile,
//     and remove job containers no run claims;
//   - deliver statuses until the control plane has them, re-sending them on
//     every reconnect, and only then remove the run's container and secret
//     files.
package jobs

import (
	"cmp"
	"context"
	"io"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// Labels of job containers, beside the runtime's workload, kind, ownership
// and namespace labels. Job containers never carry roundhouse.managed, so the
// reconciler neither lists nor garbage-collects them.
const (
	LabelJob   = "roundhouse.job"
	LabelRunID = "roundhouse.run_id"
	// JobFilter selects job containers.
	JobFilter = LabelJob + "=true"
)

// ContainerPrefix starts every job container's name, followed by the run ID.
const ContainerPrefix = "roundhouse-job-"

// DefaultMaxConcurrent is how many runs a node runs at once unless
// [Options.MaxConcurrent] says otherwise.
const DefaultMaxConcurrent = 8

// DefaultSecretsDir holds job runs' mount_as_file values on Linux nodes. It
// must differ from the runtime's directory, which removes every
// subdirectory that belongs to none of its workloads.
const DefaultSecretsDir = "/run/roundhouse/job-secrets"

// Status messages the control plane may match on.
const (
	// MessageNodeBusy fails a run that would exceed max_concurrent.
	MessageNodeBusy = "node_busy"
	// MessageLost fails a run whose container vanished while the agent was
	// down.
	MessageLost = "container lost while the agent was down"
	// MessageInterrupted fails a run the agent was preparing when it
	// stopped: its container was never started.
	MessageInterrupted = "the agent restarted before the job started"
	// MessageRemoved fails a run whose container was removed while it ran.
	MessageRemoved = "the job's container was removed before it finished"
	// MessageOOM fails a run the kernel killed for exceeding its memory.
	MessageOOM = "out of memory"
)

const (
	defaultFlushInterval = time.Second
	defaultRetryInterval = 2 * time.Second
	// defaultLogWait bounds how long an exited run waits for its last log
	// lines before it reports its outcome anyway.
	defaultLogWait = 10 * time.Second
	sendTimeout    = 10 * time.Second
	// saveEvery throttles writes of jobs.json for log positions alone.
	saveEvery = 2 * time.Second
	// recentRuns bounds the finished runs remembered, so a repeated job_run
	// gets its status back instead of running again.
	recentRuns = 128
)

// Docker is the subset of the engine API jobs use; *docker.Client
// implements it.
type Docker interface {
	ListContainers(ctx context.Context, labels ...string) ([]docker.ContainerSummary, error)
	InspectContainer(ctx context.Context, id string) (docker.ContainerInfo, error)
	CreateContainer(ctx context.Context, name string, spec docker.ContainerCreate) (string, error)
	StartContainer(ctx context.Context, id string) error
	KillContainer(ctx context.Context, id, signal string) error
	WaitContainer(ctx context.Context, id, condition string) (int, error)
	RemoveContainer(ctx context.Context, id string) error
	InspectImage(ctx context.Context, ref string) (docker.Image, error)
	PullImage(ctx context.Context, ref string, auth *docker.AuthConfig) error
	ContainerLogs(ctx context.Context, id string, opts docker.LogsOptions) (io.ReadCloser, error)
}

// Options configures a [Runner].
type Options struct {
	Docker Docker
	// Send delivers a job_status. It returns an error when the frame was not
	// delivered (e.g. not connected); the status is then sent again.
	Send func(ctx context.Context, m *protocol.JobStatus) error
	// Logs delivers a logs frame (the log shipper's Submit); nil drops job
	// output.
	Logs func(ctx context.Context, l protocol.Logs) error
	// OpenEnv opens a run's sealed environment, filling w.Env and
	// w.SecretFiles ([protocol.OpenJobEnv] with the node's key and ID). Nil
	// runs jobs with the Env they carry, which only tests do.
	OpenEnv func(runID string, w *protocol.WorkloadSpec) error
	// Network makes sure the run's environment network exists and is
	// firewalled before its container joins it; nil assumes it does.
	Network func(ctx context.Context, w *protocol.WorkloadSpec) error
	// PrivateDNS returns the mesh's private DNS address for runs with
	// private_dns, "" when none is listening; pending means the mesh is
	// still coming up and the answer will change shortly. Nil means no
	// mesh.
	PrivateDNS func() (addr string, pending bool)
	// MeshRuns receives the running runs with a mesh IP whenever they
	// change (ADR 0005); nil means no mesh.
	MeshRuns func([]MeshRun)
	// Namespace labels job containers (roundhouse.namespace) and limits
	// orphan removal to them; the agent sets the node ID. Empty disables
	// orphan removal, since another agent's jobs would look like orphans.
	Namespace string
	// StatePath is jobs.json; empty keeps runs in memory only.
	StatePath string
	// SecretsDir holds each run's mount_as_file values in a subdirectory
	// named after its workload ID ([DefaultSecretsDir] on a Linux node).
	// Empty refuses runs with secret files.
	SecretsDir string
	// MaxConcurrent is how many runs may be in flight; zero means
	// [DefaultMaxConcurrent].
	MaxConcurrent int
	// Refusal, when set, fails every run with it as the message, e.g.
	// because the connection is plaintext.
	Refusal string
	// FlushInterval is the longest a log line waits before it is shipped;
	// zero means one second.
	FlushInterval time.Duration
	Logger        *slog.Logger

	// Test hooks. unit is what one second of timeout_s or kill_grace_s
	// lasts; retryInterval is how often undelivered statuses are retried;
	// logWait bounds the wait for an exited run's last log lines.
	unit, retryInterval, logWait time.Duration
}

// killReason is why the agent is stopping a run's container.
type killReason string

const (
	killTimeout killReason = "timeout"
	killCancel  killReason = "cancel"
)

// run is one job run the runner knows about, from job_run until its
// terminal status is delivered and its container removed. Fields are
// guarded by Runner.mu.
type run struct {
	id         string
	workloadID string
	timeoutS   int
	graceS     int
	// containerID is set once the container exists.
	containerID string
	// startedAt and deadline are unix ms, zero until the container started.
	startedAt int64
	deadline  int64
	// cancelReason is the job_cancel reason; cancelled says one arrived.
	cancelReason string
	cancelled    bool
	// cancelCh is closed by the first job_cancel.
	cancelCh chan struct{}
	// abort stops a run still being prepared (pull, create).
	abort context.CancelFunc
	// killing is set once SIGTERM was sent, and decides the outcome.
	killing killReason
	// status is the run's latest status; seq numbers it and sent is the
	// seq the control plane has. resend asks for it again (reconnect,
	// repeated job_run).
	status protocol.JobStatus
	seq    uint64
	sent   uint64
	resend bool
	// lastLogNS is the timestamp of the last log line shipped, unix nanos.
	lastLogNS int64
	// attached means a goroutine of this process works on the run.
	attached bool
	cleaning bool
	// meshIP is the workload's mesh IP, "" for none; network is its
	// environment network. Both are persisted, so a re-attached run
	// rejoins the mesh.
	meshIP, network string
	// mesh is the run's mesh IP and bridge IP while it runs on the mesh.
	mesh *MeshRun
}

func (rn *run) terminal() bool { return rn.status.State.Terminal() }

func (rn *run) dirty() bool { return rn.seq != rn.sent || rn.resend }

// Runner runs jobs. Create it with [New], feed it with [Runner.Start] and
// [Runner.Cancel], and run it with [Runner.Run]. Containers keep running when
// Run returns: the next agent process re-attaches to them.
type Runner struct {
	opts Options
	log  *slog.Logger
	d    Docker

	// ctx is cancelled when Run returns; every run goroutine derives from it.
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	kick   chan struct{}
	// saveMu orders writes of jobs.json, so an older snapshot never
	// overwrites a newer one.
	saveMu sync.Mutex
	// meshMu orders reports to [Options.MeshRuns].
	meshMu sync.Mutex

	mu   sync.Mutex
	runs map[string]*run
	// recent holds the terminal statuses of removed runs, oldest first;
	// again holds the ones a repeated job_run asked for.
	recent     []protocol.JobStatus
	again      []protocol.JobStatus
	stopped    bool
	stateDirty bool
	savedAt    time.Time
}

// New returns a runner holding the runs persisted at [Options.StatePath].
// Nothing is touched in Docker until [Runner.Run].
func New(opts Options) *Runner {
	opts.MaxConcurrent = cmp.Or(opts.MaxConcurrent, DefaultMaxConcurrent)
	opts.FlushInterval = cmp.Or(opts.FlushInterval, defaultFlushInterval)
	opts.unit = cmp.Or(opts.unit, time.Second)
	opts.retryInterval = cmp.Or(opts.retryInterval, defaultRetryInterval)
	opts.logWait = cmp.Or(opts.logWait, defaultLogWait)
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &Runner{
		opts: opts, log: log, d: opts.Docker, ctx: ctx, cancel: cancel,
		kick: make(chan struct{}, 1), runs: map[string]*run{},
	}
	r.load()
	return r
}

// Start takes a job_run without blocking. A run already known only has its
// status sent again; anything refused is answered with a failed status.
func (r *Runner) Start(m *protocol.JobRun) {
	w := m.Workload
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		return
	}
	if rn := r.runs[m.RunID]; rn != nil {
		rn.resend = true
		r.mu.Unlock()
		r.log.Info("job_run repeated; re-sending its status", "run_id", m.RunID, "state", rn.status.State)
		r.poke()
		return
	}
	if i := slices.IndexFunc(r.recent, func(s protocol.JobStatus) bool { return s.RunID == m.RunID }); i >= 0 {
		r.again = append(r.again, r.recent[i])
		r.mu.Unlock()
		r.log.Info("job_run repeated after it finished; re-sending its status", "run_id", m.RunID)
		r.poke()
		return
	}
	rn := &run{
		id: m.RunID, workloadID: w.ID, timeoutS: m.TimeoutS, graceS: m.KillGraceS, cancelCh: make(chan struct{}),
		meshIP: w.MeshIP, network: w.Network,
	}
	r.runs[rn.id] = rn
	reason := admit(m, r.opts.Refusal)
	if reason == "" && r.inFlightLocked() > r.opts.MaxConcurrent {
		reason = MessageNodeBusy
	}
	if reason != "" {
		r.setStatusLocked(rn, protocol.JobFailed, nil, reason, 0)
		r.mu.Unlock()
		r.log.Warn("refusing job run", "run_id", rn.id, "workload_id", rn.workloadID, "reason", reason)
		r.persist()
		r.poke()
		return
	}
	ctx, abort := context.WithCancel(r.ctx)
	rn.abort, rn.attached = abort, true
	r.setStatusLocked(rn, protocol.JobPulling, nil, "", 0)
	r.wg.Add(1)
	r.mu.Unlock()
	r.log.Info("starting job run", "run_id", rn.id, "workload_id", rn.workloadID, "image", w.Image,
		"timeout_s", m.TimeoutS, "kill_grace_s", m.KillGraceS)
	r.persist()
	r.poke()
	go func() {
		defer r.wg.Done()
		defer r.detach(rn)
		defer abort()
		r.execute(ctx, rn, &w)
	}()
}

// detach records that no goroutine works on rn any more, which lets a
// delivered terminal run be cleaned up.
func (r *Runner) detach(rn *run) {
	r.mu.Lock()
	rn.attached = false
	r.mu.Unlock()
	r.poke()
}

// Cancel stops a run: one being prepared is abandoned, a running container
// gets SIGTERM, kill_grace_s, then SIGKILL, and the run is reported
// cancelled. A cancel for an unknown or finished run is ignored.
func (r *Runner) Cancel(m *protocol.JobCancel) {
	r.mu.Lock()
	rn := r.runs[m.RunID]
	if rn == nil || rn.terminal() || rn.cancelled {
		r.mu.Unlock()
		r.log.Debug("ignoring job_cancel", "run_id", m.RunID)
		return
	}
	rn.cancelled, rn.cancelReason = true, m.Reason
	close(rn.cancelCh)
	if rn.containerID == "" && rn.abort != nil {
		rn.abort()
	}
	r.mu.Unlock()
	r.log.Info("cancelling job run", "run_id", m.RunID, "reason", m.Reason)
	r.persist()
}

// Connected re-sends the current status of every run the control plane may
// have missed: those in flight and terminal ones not yet delivered.
func (r *Runner) Connected() {
	r.mu.Lock()
	for _, rn := range r.runs {
		rn.resend = true
	}
	r.mu.Unlock()
	r.poke()
}

// Run re-attaches to the runs persisted by an earlier process, removes
// orphaned job containers, then delivers statuses until ctx ends. It then
// stops following every run, leaving containers running, and saves the
// runs' state.
func (r *Runner) Run(ctx context.Context) error {
	r.recover(ctx)
	t := time.NewTicker(r.opts.retryInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			r.mu.Lock()
			r.stopped = true
			r.mu.Unlock()
			r.cancel()
			r.wg.Wait()
			r.persist()
			return nil
		case <-r.kick:
		case <-t.C:
		}
		r.deliver(ctx)
		r.saveIfDue()
	}
}

func (r *Runner) poke() {
	select {
	case r.kick <- struct{}{}:
	default:
	}
}

// goTask runs fn on a goroutine Run waits for.
func (r *Runner) goTask(fn func()) {
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		fn()
	}()
}

// inFlightLocked counts runs not yet terminal. Caller holds r.mu.
func (r *Runner) inFlightLocked() int {
	n := 0
	for _, rn := range r.runs {
		if !rn.terminal() {
			n++
		}
	}
	return n
}

// setStatusLocked makes st the run's latest status. finishedAt (unix ms)
// applies to terminal states; zero means now. Caller holds r.mu.
func (r *Runner) setStatusLocked(rn *run, st protocol.JobState, exitCode *int, message string, finishedAt int64) {
	s := protocol.JobStatus{
		Type: protocol.TypeJobStatus, RunID: rn.id, WorkloadID: rn.workloadID,
		State: st, ExitCode: exitCode, Message: clip(message),
	}
	if rn.startedAt > 0 {
		started := rn.startedAt
		s.StartedAt = &started
	}
	if st.Terminal() {
		if finishedAt <= 0 {
			finishedAt = time.Now().UnixMilli()
		}
		finishedAt = max(finishedAt, rn.startedAt)
		s.FinishedAt = &finishedAt
	}
	rn.status = s
	rn.seq++
}

// -----------------------------------------------------------------------------
// Delivery
// -----------------------------------------------------------------------------

// deliver sends every status the control plane doesn't have yet, stopping
// at the first failure, and removes the runs whose terminal status it has.
func (r *Runner) deliver(ctx context.Context) {
	type item struct {
		rn  *run
		st  protocol.JobStatus
		seq uint64
	}
	r.mu.Lock()
	var items []item
	for _, rn := range r.runs {
		if rn.dirty() {
			items = append(items, item{rn, rn.status, rn.seq})
		}
	}
	again := r.again
	r.again = nil
	r.mu.Unlock()
	slices.SortFunc(items, func(a, b item) int { return cmp.Compare(a.rn.id, b.rn.id) })

	for i := range again {
		if err := r.send(ctx, &again[i]); err != nil {
			r.mu.Lock()
			r.again = append(again[i:], r.again...)
			r.mu.Unlock()
			return
		}
	}
	for _, it := range items {
		if err := r.send(ctx, &it.st); err != nil {
			r.log.Debug("job status not delivered; retrying", "run_id", it.rn.id, "state", it.st.State, "err", err)
			break
		}
		r.mu.Lock()
		if it.rn.seq == it.seq {
			it.rn.sent, it.rn.resend = it.seq, false
		}
		r.mu.Unlock()
	}

	r.mu.Lock()
	var done []*run
	for _, rn := range r.runs {
		if rn.terminal() && !rn.dirty() && !rn.cleaning && !rn.attached {
			rn.cleaning = true
			done = append(done, rn)
		}
	}
	r.mu.Unlock()
	if len(items) > 0 {
		r.persist()
	}
	for _, rn := range done {
		r.goTask(func() { r.cleanup(rn) })
	}
}

func (r *Runner) send(ctx context.Context, st *protocol.JobStatus) error {
	ctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	return r.opts.Send(ctx, st)
}

// clip cuts a status message to the protocol's limit on a UTF-8 boundary.
func clip(s string) string {
	if len(s) <= protocol.MaxMessageBytes {
		return s
	}
	cut := protocol.MaxMessageBytes
	for cut > 0 && s[cut]&0xC0 == 0x80 {
		cut--
	}
	return s[:cut]
}
