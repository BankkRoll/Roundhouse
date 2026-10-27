// Package runtime converges the node's Docker containers to the control
// plane's desired state.
//
// Responsibilities:
//   - diff the desired workloads (plus the agent's own system workloads)
//     against this node's containers (roundhouse.managed=true and
//     roundhouse.namespace=<node ID>), every 5 s and immediately on a new
//     generation or a container event; containers of other nodes sharing
//     the engine are never touched, and Phase 1 containers without a
//     namespace are adopted once when their workload is desired;
//   - create what is missing, recreate what changed (by spec hash) and
//     remove what is no longer wanted, in zero-downtime order: the new
//     container becomes healthy, routes switch to it, the old one drains for
//     drain_s, then it is removed;
//   - run health probes and the restart policy itself, with crash-loop
//     backoff, so every crash is seen and reported;
//   - open each workload's sealed environment for its frame's generation,
//     and refuse (leave pending, with the reason) workloads whose box
//     doesn't open or that name a network or local image outside their own
//     project, environment and service;
//   - bind each workload's volumes, never letting two containers mount one
//     volume, with stop_first rollouts, exec health probes and holds that
//     keep a workload stopped for a backup or restore (ADR 0004); refuse
//     published ports until the TCP proxy's allowlist is enforced;
//   - keep one bridge network per environment, remove the ones no longer
//     used, serve no route that two projects claim, report workload_status
//     on every state change, and garbage-collect unused images under disk
//     pressure.
//
// Nothing secret is written to disk: environment values live only in the
// engine's container config and in memory, and mount_as_file values on the
// host's /run tmpfs while a container mounts them.
package runtime

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/ingress"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// Docker is the subset of the engine API the runtime uses; *docker.Client
// implements it.
type Docker interface {
	ListContainers(ctx context.Context, labels ...string) ([]docker.ContainerSummary, error)
	InspectContainer(ctx context.Context, id string) (docker.ContainerInfo, error)
	CreateContainer(ctx context.Context, name string, spec docker.ContainerCreate) (string, error)
	StartContainer(ctx context.Context, id string) error
	StopContainer(ctx context.Context, id string, timeout time.Duration) error
	RemoveContainer(ctx context.Context, id string) error
	InspectImage(ctx context.Context, ref string) (docker.Image, error)
	PullImage(ctx context.Context, ref string, auth *docker.AuthConfig) error
	ListImages(ctx context.Context) ([]docker.ImageSummary, error)
	RemoveImage(ctx context.Context, id string) error
	InspectNetwork(ctx context.Context, nameOrID string) (docker.Network, error)
	CreateNetwork(ctx context.Context, spec docker.NetworkCreate) (string, error)
	ListNetworks(ctx context.Context, labels ...string) ([]docker.Network, error)
	RemoveNetwork(ctx context.Context, nameOrID string) error
	Events(ctx context.Context, filters map[string][]string, fn func(docker.Event)) error
	Info(ctx context.Context) (docker.Info, error)
}

// Ingress receives the routes of the workloads that should serve traffic;
// *ingress.Manager implements it.
type Ingress interface {
	Apply(ctx context.Context, c ingress.Config) error
}

// Container describes a managed container for log shipping.
type Container struct {
	ID         string
	WorkloadID string
	// DeploymentID is empty for system workloads.
	DeploymentID string
	Running      bool
	// StartedAt changes every time the container is (re)started.
	StartedAt time.Time
	// PID is the container's init process on the host, 0 when not running.
	PID int
	// Restarts counts the runtime's restarts of this container.
	Restarts int
}

// Default intervals.
const (
	DefaultInterval   = 5 * time.Second
	DefaultGCInterval = 5 * time.Minute
)

// Options configures a [Runtime].
type Options struct {
	Docker Docker
	// Ingress is optional; nil leaves routing to someone else.
	Ingress Ingress
	// DataDir holds the registry's filesystem storage.
	DataDir string
	Logger  *slog.Logger
	// Report receives every workload status change. It is called from a
	// dedicated goroutine, never from the reconciler, and may block.
	Report func(ctx context.Context, r protocol.WorkloadStatusReport)
	// Containers receives the managed containers after every pass. It must
	// not block.
	Containers func([]Container)

	// Interval is the period of the reconcile loop.
	Interval time.Duration
	// RestartBackoff and MaxRestartBackoff bound crash-loop backoff;
	// BackoffResetAfter is how long a container must stay up for its
	// backoff streak to reset.
	RestartBackoff, MaxRestartBackoff, BackoffResetAfter time.Duration
	// Prober runs health probes; nil uses [DefaultProber].
	Prober Prober
	// GC configures image garbage collection; see [GCOptions].
	GC GCOptions
	// MinDrain is the shortest time a replaced container keeps serving after
	// routes stop naming it, whatever its drain_s: how long the ingress may
	// take to stop sending it requests ([ingress.SwitchDelay]).
	MinDrain time.Duration
	// Namespace, when set, restricts the runtime to containers labelled
	// roundhouse.namespace=<Namespace> and labels the containers and networks
	// it creates so. The agent sets it to the node ID, so two nodes sharing
	// a Docker engine never manage or remove each other's containers;
	// integration tests use a random one to stay clear of everything else.
	Namespace string
	// AdoptUnlabelled makes the runtime also manage containers labelled
	// roundhouse.managed=true without any namespace, as Phase 1 agents created
	// them, but only once their workload ID is in the desired state. An
	// adopted container stays managed (it is recorded in DataDir) until it is
	// removed, so it is still drained and removed after its workload is
	// dropped. Requires Namespace.
	AdoptUnlabelled bool
	// OpenEnv opens a service workload's sealed environment for the
	// generation of the desired state carrying it, filling Env and
	// SecretFiles ([protocol.OpenWorkloadEnv] with the node's key). A
	// workload whose environment doesn't open stays pending with the reason
	// as its status message. Nil runs workloads with the Env they carry,
	// which only tests do: Env never comes off the wire.
	OpenEnv func(generation int64, w *protocol.WorkloadSpec) error
	// SecretsDir holds each workload's mount_as_file values in a
	// subdirectory named after the workload ([DefaultSecretsDir] on a node),
	// bind-mounted read-only at [SecretsMountPath]. Runtimes sharing a host
	// need distinct directories, since each removes the subdirectories of
	// workloads it doesn't run. Empty refuses workloads with secret files.
	SecretsDir string
	// SystemLog, when set, receives lines the agent writes into a
	// workload's runtime logs, such as a route conflict. It is called with
	// the runtime's lock held and must not block.
	SystemLog func(workloadID, deploymentID, text string)
	// OnNetwork, when set, is called with every network the runtime is
	// about to attach containers to, once per process, before the first
	// container joins it: the agent installs its firewall rules for the
	// network's bridge there.
	OnNetwork func(ctx context.Context, n docker.Network)
	// Volumes resolves workload mounts (ADR 0004); nil refuses workloads
	// that mount volumes.
	Volumes VolumeSource
	// Exec runs exec health probes; nil refuses workloads that use them.
	Exec ExecRunner
}

// Runtime is the reconciler. Create it with [New], feed it desired states
// with [Runtime.Apply] and run it with [Runtime.Run].
type Runtime struct {
	opts Options
	log  *slog.Logger
	d    Docker

	wake     chan struct{}
	statuses *statusBoard

	// ctx is Run's context; async operations and probes derive from it.
	ctx context.Context
	wg  sync.WaitGroup

	mu      sync.Mutex
	desired *protocol.DesiredState
	// blocked holds, by workload ID, why a workload of desired may not
	// start: its environment did not open, or [admit] refused it.
	blocked map[string]string
	// conflictsLogged holds the route conflicts already logged, so each is
	// logged once rather than on every pass.
	conflictsLogged map[routeKey]bool
	instances       map[string]*instance  // by container ID
	workloads       map[string]*workState // by workload ID
	networks        map[string]bool       // known to exist
	lastErr         string                // last engine error logged, to avoid repeats
	// listSeq numbers container listings; passSeq is the one the current
	// pass works from. An operation that finished at or after the listing a
	// pass uses may not be reflected in it, which the pass must not mistake
	// for "missing" or "still stopped".
	listSeq, passSeq uint64
	// started is when this runtime was created; containers already running
	// before it were started by an earlier agent process.
	started time.Time
	// adopted holds the IDs of unlabelled containers adopted under
	// [Options.AdoptUnlabelled].
	adopted map[string]bool
	// networksCheckedAt is when unused networks were last looked for.
	networksCheckedAt time.Time
	// holds keep workloads and volumes stopped for backups and restores.
	holds map[*hold]bool
	// heldStops are the IDs of containers a hold stopped ([heldStopsFile]).
	heldStops map[string]bool
}

// instance is one managed container.
type instance struct {
	id   string
	name string
	meta meta

	// From the engine.
	status     string
	running    bool
	exitCode   int
	oomKilled  bool
	errMsg     string
	startedAt  time.Time
	finishedAt time.Time
	ips        map[string]string
	created    time.Time
	pid        int

	// Agent-managed.
	health      health
	healthMsg   string
	probeFor    time.Time // startedAt the running probe belongs to
	probeCancel context.CancelFunc
	restarts    int
	streak      int
	nextRestart time.Time
	backoff     time.Duration // delay chosen for nextRestart
	busy        bool          // an operation (start, stop, remove) is in flight
	drainAt     time.Time     // when routes stopped pointing at it
	// adopted marks a container that was already running when this agent
	// process started. Caddy still routes to it from before the restart, so
	// it keeps its routes until its first probe decides its health instead
	// of dropping out of the config for a probe interval.
	adopted bool
	// heldStop marks a container a hold stopped, started again on release.
	heldStop   bool
	doneSeq    uint64 // listSeq when the last operation finished
	inspectSeq uint64 // listSeq of the pass that last inspected it
}

// workState tracks a desired workload that has no container yet.
type workState struct {
	busy bool
	// volumes are the volumes a create in flight mounts.
	volumes  []string
	phase    protocol.WorkloadState
	message  string
	failures int
	retryAt  time.Time
	retryIn  time.Duration
	doneSeq  uint64
}

// New returns a runtime. It does nothing until [Runtime.Run].
func New(opts Options) *Runtime {
	opts.Interval = cmp.Or(opts.Interval, DefaultInterval)
	opts.RestartBackoff = cmp.Or(opts.RestartBackoff, DefaultRestartBackoff)
	opts.MaxRestartBackoff = max(cmp.Or(opts.MaxRestartBackoff, DefaultMaxRestartBackoff), opts.RestartBackoff)
	opts.BackoffResetAfter = cmp.Or(opts.BackoffResetAfter, DefaultBackoffResetAfter)
	if opts.Prober == nil {
		opts.Prober = DefaultProber
	}
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	r := &Runtime{
		opts:      opts,
		log:       log,
		d:         opts.Docker,
		wake:      make(chan struct{}, 1),
		statuses:  newStatusBoard(),
		ctx:       context.Background(),
		instances: map[string]*instance{},
		workloads: map[string]*workState{},
		networks:  map[string]bool{},
		started:   time.Now(),
		adopted:   map[string]bool{},
	}
	if opts.AdoptUnlabelled {
		r.adopted = loadAdopted(r.adoptedPath(), log)
	}
	r.heldStops = loadAdopted(r.heldStopsPath(), log)
	return r
}

// Apply hands the runtime a verified desired state, which it then owns. A
// state whose generation is not newer than the current one is ignored, and
// Apply reports whether ds was accepted. Each workload's sealed environment
// is opened here, for ds's generation; a workload that is refused or whose
// environment doesn't open is kept, pending with the reason, so its
// existing containers are left alone.
func (r *Runtime) Apply(ds *protocol.DesiredState) bool {
	r.mu.Lock()
	stale := r.desired != nil && ds.Generation <= r.desired.Generation
	r.mu.Unlock()
	if stale {
		return false
	}
	volumes := make(map[string]*protocol.VolumeSpec, len(ds.Volumes))
	for i := range ds.Volumes {
		volumes[ds.Volumes[i].ID] = &ds.Volumes[i]
	}
	blocked := map[string]string{}
	for i := range ds.Workloads {
		w := &ds.Workloads[i]
		reason := admit(w)
		if reason == "" {
			reason = r.admitData(w, volumes)
		}
		if reason == "" && r.opts.OpenEnv != nil {
			if err := r.opts.OpenEnv(ds.Generation, w); err != nil {
				reason = EnvFailure(err)
			}
		}
		if reason != "" {
			w.Env, w.SecretFiles = nil, nil
			blocked[w.ID] = reason
			r.log.Error("not starting workload", "workload_id", w.ID, "generation", ds.Generation, "reason", reason)
		}
	}
	r.mu.Lock()
	if r.desired != nil && ds.Generation <= r.desired.Generation {
		r.mu.Unlock()
		return false
	}
	r.desired, r.blocked = ds, blocked
	r.mu.Unlock()
	r.poke()
	return true
}

// HasDesiredState reports whether a desired state has been applied since
// the process started. Until then the runtime only observes: it never
// removes a container on the strength of an empty state.
func (r *Runtime) HasDesiredState() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.desired != nil
}

// Statuses returns the latest status of every workload the runtime knows,
// ordered by workload ID, for hello.
func (r *Runtime) Statuses() []protocol.WorkloadStatusReport {
	return r.statuses.all()
}

// RegistryAddr returns the local registry's address and whether the
// registry is running and healthy.
func (r *Runtime) RegistryAddr() (string, bool) {
	st, ok := r.statuses.get(RegistryWorkloadID)
	return protocol.RegistryListen, ok && st.State == protocol.StateHealthy
}

func (r *Runtime) poke() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// Run reconciles until ctx ends. Containers keep running when it returns:
// an agent restart must not take workloads down.
func (r *Runtime) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	r.ctx = ctx

	r.goTask(func() { r.statuses.run(ctx, r.opts.Report) })
	r.goTask(func() { r.watchEvents(ctx) })
	r.goTask(func() { r.gcLoop(ctx) })

	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			cancel()
			r.wg.Wait()
			return nil
		case <-r.wake:
		case <-timer.C:
		}
		next := r.reconcile(ctx)
		timer.Reset(next)
	}
}

func (r *Runtime) goTask(fn func()) {
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		fn()
	}()
}

// selector returns the label filters that pick the runtime's containers.
func (r *Runtime) selector() []string {
	if r.opts.Namespace != "" {
		return []string{ManagedFilter, LabelNamespace + "=" + r.opts.Namespace}
	}
	return []string{ManagedFilter}
}

// adopting reports whether unlabelled containers may be adopted.
func (r *Runtime) adopting() bool {
	return r.opts.AdoptUnlabelled && r.opts.Namespace != ""
}

// watchEvents wakes the reconciler on container lifecycle events, so crashes
// and exits are handled in well under the loop interval.
func (r *Runtime) watchEvents(ctx context.Context) {
	labels := r.selector()
	if r.adopting() {
		labels = []string{ManagedFilter}
	}
	filters := map[string][]string{"type": {"container"}, "label": labels}
	delay := time.Second
	for ctx.Err() == nil {
		start := time.Now()
		err := r.d.Events(ctx, filters, func(ev docker.Event) {
			switch ev.Action {
			case "start", "die", "oom", "destroy", "kill":
				r.poke()
			}
		})
		if ctx.Err() != nil {
			return
		}
		if time.Since(start) > time.Minute {
			delay = time.Second
		}
		r.log.Debug("docker event stream ended; reconnecting", "err", err, "retry_in", delay)
		if !sleep(ctx, delay) {
			return
		}
		delay = min(delay*2, 30*time.Second)
		r.poke()
	}
}

// sleep waits d or until ctx ends, reporting whether it waited fully.
func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// engineError logs an engine failure once until it changes or clears.
func (r *Runtime) engineError(what string, err error) {
	msg := what + ": " + err.Error()
	r.mu.Lock()
	repeat := r.lastErr == msg
	r.lastErr = msg
	r.mu.Unlock()
	if !repeat {
		r.log.Error("docker engine unavailable", "op", what, "err", err)
	}
}

// -----------------------------------------------------------------------------
// Reconcile pass
// -----------------------------------------------------------------------------

// reconcile runs one pass and returns how long to wait before the next one.
func (r *Runtime) reconcile(ctx context.Context) time.Duration {
	next := r.opts.Interval
	r.mu.Lock()
	r.listSeq++
	seq := r.listSeq
	r.mu.Unlock()
	list, err := r.listOwn(ctx)
	if err != nil {
		if ctx.Err() == nil {
			r.engineError("list containers", err)
		}
		return next
	}
	r.refresh(ctx, list, seq)
	r.mu.Lock()
	r.passSeq = seq
	r.lastErr = ""
	ds := r.desired
	r.mu.Unlock()

	if ds == nil {
		r.publish(nil)
		return next
	}
	specs := r.wantSpecs(ds)
	r.ensureNetworks(ctx, specs)
	r.collectNetworks(ctx, specs)

	now := time.Now()
	r.mu.Lock()
	assignLabelAliases(specs)
	conflicts := r.markRouteConflicts(specs)
	wanted := make(map[string]*wantSpec, len(specs))
	for _, s := range specs {
		wanted[s.ID] = s
	}
	for _, s := range specs {
		if d := r.reconcileWorkload(s, wanted, now); d > 0 {
			next = min(next, d)
		}
	}
	toDrain, d := r.reconcileObsolete(specs, now)
	if d > 0 {
		next = min(next, d)
	}
	cfg := r.ingressConfig(ds, specs, conflicts)
	r.collectSecretDirs(specs)
	r.mu.Unlock()

	// Zero-downtime order: routes leave the old containers before their
	// drain clock starts.
	if r.opts.Ingress != nil {
		if err := r.opts.Ingress.Apply(ctx, cfg); err != nil && ctx.Err() == nil {
			r.log.Debug("ingress update failed; retrying in the background", "err", err)
		}
	}
	if len(toDrain) > 0 {
		r.mu.Lock()
		drainStart := time.Now()
		for _, inst := range toDrain {
			inst.drainAt = drainStart
			drain := r.drainFor(inst, specs)
			next = min(next, drain)
			r.log.Info("draining replaced container", "workload_id", inst.meta.workloadID,
				"container", short(inst.id), "drain", drain)
		}
		r.mu.Unlock()
	}
	r.publish(specs)
	return max(next, 10*time.Millisecond)
}

// wantSpecs lists every workload the node should run.
func (r *Runtime) wantSpecs(ds *protocol.DesiredState) []*wantSpec {
	specs := make([]*wantSpec, 0, len(ds.Workloads)+1)
	for i := range ds.Workloads {
		specs = append(specs, &wantSpec{
			WorkloadSpec: ds.Workloads[i], generation: ds.Generation, blocked: r.blocked[ds.Workloads[i].ID],
			stopFirst: ds.Workloads[i].Rollout == protocol.RolloutStopFirst || len(ds.Workloads[i].Mounts) > 0,
		})
	}
	if ds.Registry != nil {
		specs = append(specs, registrySpec(ds.Registry, r.opts.DataDir, ds.Generation))
	}
	return specs
}

// refresh syncs the instance table with the engine's container list,
// inspecting only containers that are new or whose state changed.
func (r *Runtime) refresh(ctx context.Context, list []docker.ContainerSummary, seq uint64) {
	seen := make(map[string]bool, len(list))
	var stale []docker.ContainerSummary
	r.mu.Lock()
	for _, c := range list {
		seen[c.ID] = true
		inst, ok := r.instances[c.ID]
		if !ok || inst.status != c.State || (c.State == "running" && !inst.running) || !inst.settled() {
			stale = append(stale, c)
		}
	}
	for id, inst := range r.instances {
		if !seen[id] {
			r.forget(inst)
		}
	}
	r.mu.Unlock()

	for _, c := range stale {
		info, err := r.d.InspectContainer(ctx, c.ID)
		if err != nil {
			if !docker.IsNotFound(err) && ctx.Err() == nil {
				r.log.Warn("inspect container", "container", short(c.ID), "err", err)
			}
			continue
		}
		r.mu.Lock()
		inst, ok := r.instances[c.ID]
		if !ok {
			inst = &instance{id: c.ID, meta: parseMeta(info.Config.Labels)}
			r.instances[c.ID] = inst
		}
		inst.observe(info)
		if !ok {
			inst.adopted = inst.running && inst.startedAt.Before(r.started)
			inst.heldStop = r.heldStops[c.ID]
		}
		inst.inspectSeq = seq
		if !inst.running {
			r.stopProbe(inst)
		}
		r.mu.Unlock()
	}
}

// observe copies the engine's view of a container into inst.
func (inst *instance) observe(info docker.ContainerInfo) {
	inst.name = strings.TrimPrefix(info.Name, "/")
	inst.created = info.Created
	inst.status = info.State.Status
	inst.pid = info.State.Pid
	inst.running = info.State.Running && !info.State.Restarting
	inst.exitCode = info.State.ExitCode
	inst.oomKilled = info.State.OOMKilled
	inst.errMsg = info.State.Error
	inst.finishedAt = info.State.FinishedAt
	if !info.State.StartedAt.Equal(inst.startedAt) {
		inst.startedAt = info.State.StartedAt
		inst.health = healthUnknown
		inst.healthMsg = ""
		inst.adopted = false
	}
	inst.ips = map[string]string{}
	for name, ep := range info.NetworkSettings.Networks {
		inst.ips[name] = ep.IPAddress
	}
}

// settled reports whether the latest inspect is known to postdate the last
// operation on the container, i.e. whether its observed state can be trusted.
func (inst *instance) settled() bool {
	return inst.doneSeq < inst.inspectSeq
}

// forget drops a container that no longer exists. Caller holds r.mu.
func (r *Runtime) forget(inst *instance) {
	r.stopProbe(inst)
	r.setHeldStop(inst.id, false)
	delete(r.instances, inst.id)
}

// current returns the container running s's exact spec, preferring the
// newest if there are several.
func (r *Runtime) current(s *wantSpec) *instance {
	var best *instance
	for _, inst := range r.instances {
		if inst.meta.workloadID == s.ID && inst.meta.specHash == s.SpecHash &&
			(best == nil || inst.created.After(best.created)) {
			best = inst
		}
	}
	return best
}

// reconcileWorkload converges one desired workload and returns when it next
// needs attention (0 for no particular time). Caller holds r.mu.
func (r *Runtime) reconcileWorkload(s *wantSpec, wanted map[string]*wantSpec, now time.Time) time.Duration {
	ws := r.workloads[s.ID]
	if ws == nil {
		ws = &workState{phase: protocol.StatePending}
		r.workloads[s.ID] = ws
	}
	if ws.busy {
		return 0
	}
	cur := r.current(s)
	if cur == nil && ws.doneSeq >= r.passSeq {
		return 0
	}
	if cur == nil {
		if s.blocked != "" {
			ws.phase, ws.message = protocol.StatePending, s.blocked
			return 0
		}
		if why := r.heldReason(s.ID, mountedVolumes(&s.WorkloadSpec)); why != "" {
			ws.phase, ws.message = protocol.StatePending, why
			return 0
		}
		if s.exclusive && r.hasObsolete(s) {
			return 0
		}
		if why := r.predecessorWait(s, wanted); why != "" {
			ws.phase, ws.message = protocol.StatePending, why
			return 0
		}
		if now.Before(ws.retryAt) {
			return ws.retryAt.Sub(now)
		}
		ws.busy = true
		ws.volumes = mountedVolumes(&s.WorkloadSpec)
		r.goTask(func() { r.create(s) })
		return 0
	}
	ws.phase, ws.message, ws.failures = "", "", 0
	if cur.busy || !cur.settled() {
		return 0
	}
	if r.heldReason(s.ID, cur.meta.volumes) != "" {
		if cur.running {
			r.stopAsync(cur)
		}
		return 0
	}
	if cur.heldStop {
		cur.heldStop = false
		r.setHeldStop(cur.id, false)
		if !cur.running {
			r.startAsync(cur, false)
			return 0
		}
	}

	if cur.running {
		cur.nextRestart = time.Time{}
		if now.Sub(cur.startedAt) >= r.opts.BackoffResetAfter {
			cur.streak = 0
		}
		if !needsProbe(s) {
			cur.health = healthHealthy
		} else if !cur.probeFor.Equal(cur.startedAt) {
			r.startProbe(cur, s)
		}
		return 0
	}

	// Stopped, or created but never started (e.g. the agent died between
	// create and start, or the start itself failed).
	if cur.status == "created" && cur.errMsg == "" && cur.restarts == 0 && cur.startedAt.IsZero() {
		r.startAsync(cur, false)
		return 0
	}
	if !shouldRestart(s.Restart, cur.restarts, cur.exitCode, cur.oomKilled) {
		cur.nextRestart = time.Time{}
		return 0
	}
	if cur.nextRestart.IsZero() {
		stopped := cur.finishedAt
		if stopped.IsZero() || stopped.After(now) {
			stopped = now
		}
		cur.backoff = backoffDelay(r.opts.RestartBackoff, r.opts.MaxRestartBackoff, cur.streak)
		cur.nextRestart = stopped.Add(cur.backoff)
	}
	if now.Before(cur.nextRestart) {
		return cur.nextRestart.Sub(now)
	}
	r.startAsync(cur, true)
	return 0
}

// hasObsolete reports whether a container of s's workload with another spec
// still exists. Caller holds r.mu.
func (r *Runtime) hasObsolete(s *wantSpec) bool {
	for _, inst := range r.instances {
		if inst.meta.workloadID == s.ID && inst.meta.specHash != s.SpecHash {
			return true
		}
	}
	return false
}

// reconcileObsolete handles containers that match no desired spec: it picks
// those ready to drain (returned; their routes are already excluded) and
// removes those whose drain has finished. Caller holds r.mu.
func (r *Runtime) reconcileObsolete(specs []*wantSpec, now time.Time) ([]*instance, time.Duration) {
	wanted := map[string]*wantSpec{}
	for _, s := range specs {
		wanted[s.ID] = s
	}
	var toDrain []*instance
	var next time.Duration
	for _, inst := range r.sortedInstances() {
		if inst.busy || !inst.settled() {
			continue
		}
		s := wanted[inst.meta.workloadID]
		if s != nil && s.SpecHash == inst.meta.specHash {
			if r.current(s) != inst {
				r.removeAsync(inst, "duplicate")
			}
			continue
		}
		if inst.running && r.heldReason(inst.meta.workloadID, inst.meta.volumes) != "" {
			r.removeAsync(inst, "held for a backup or restore")
			continue
		}
		switch {
		case !inst.running, s != nil && (s.exclusive || s.stopFirst):
			r.removeAsync(inst, "replaced")
		case !inst.drainAt.IsZero():
			end := inst.drainAt.Add(r.drainFor(inst, specs))
			if now.Before(end) {
				next = minPositive(next, end.Sub(now))
				continue
			}
			r.removeAsync(inst, "drained")
		case r.replacementReady(inst, specs):
			toDrain = append(toDrain, inst)
		}
	}
	return toDrain, next
}

// drainFor is how long a replaced container drains: its drain_s, but never
// less than [Options.MinDrain].
func (r *Runtime) drainFor(inst *instance, specs []*wantSpec) time.Duration {
	return max(time.Duration(r.drainSeconds(inst, specs))*time.Second, r.opts.MinDrain)
}

// drainSeconds prefers the desired spec's drain_s, which can change without
// a recreate, over the value the container was created with.
func (r *Runtime) drainSeconds(inst *instance, specs []*wantSpec) int {
	for _, s := range specs {
		if s.ID == inst.meta.workloadID {
			return s.DrainS
		}
	}
	return inst.meta.drainS
}

// replacementReady reports whether an obsolete container may stop serving:
// its own workload's new container is healthy, or, for a workload no longer
// desired, every desired replica of the same service on this node is
// healthy (or the service has none here). Caller holds r.mu.
func (r *Runtime) replacementReady(inst *instance, specs []*wantSpec) bool {
	healthy := func(s *wantSpec) bool {
		cur := r.current(s)
		return cur != nil && cur.running && cur.health == healthHealthy
	}
	for _, s := range specs {
		if s.ID == inst.meta.workloadID {
			return healthy(s)
		}
	}
	if inst.meta.serviceID == "" {
		return true
	}
	for _, s := range specs {
		if s.ServiceID != nil && *s.ServiceID == inst.meta.serviceID &&
			s.EnvironmentID != nil && *s.EnvironmentID == inst.meta.environmentID && !healthy(s) {
			return false
		}
	}
	return true
}

// sortedInstances returns instances oldest first, for stable decisions.
// Caller holds r.mu.
func (r *Runtime) sortedInstances() []*instance {
	out := make([]*instance, 0, len(r.instances))
	for _, inst := range r.instances {
		out = append(out, inst)
	}
	slices.SortFunc(out, func(a, b *instance) int {
		if c := a.created.Compare(b.created); c != 0 {
			return c
		}
		return strings.Compare(a.id, b.id)
	})
	return out
}

func minPositive(a, b time.Duration) time.Duration {
	if a <= 0 {
		return b
	}
	return min(a, b)
}

func short(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

// -----------------------------------------------------------------------------
// Routing
// -----------------------------------------------------------------------------

// ingressConfig picks, for every route, the containers that should serve
// it: healthy containers of the desired spec; failing that, the replaced
// containers still running and not yet draining (they keep serving until
// their replacement is healthy); failing that, desired containers whose
// probe is failing, since a degraded answer beats none. Every desired route
// is listed with its port even while nothing serves it, so the ingress
// keeps the route (and Caddy's config) stable. Caller holds r.mu.
func (r *Runtime) ingressConfig(ds *protocol.DesiredState, specs []*wantSpec, conflicts map[routeKey]bool) ingress.Config {
	type key = routeKey
	healthy := map[key][]string{}
	old := map[key][]string{}
	degraded := map[key][]string{}
	ports := map[key][]int{}
	hsts := map[key]*protocol.RouteHSTS{}
	var keys []key
	var hosts []string
	seen := map[key]bool{}
	note := func(k key) {
		if !seen[k] {
			seen[k] = true
			keys = append(keys, k)
		}
	}
	add := func(m map[key][]string, k key, upstream string) {
		note(k)
		m[k] = append(m[k], upstream)
	}
	upstream := func(inst *instance, network string, port int) (string, bool) {
		ip := inst.ips[network]
		return fmt.Sprintf("%s:%d", ip, port), ip != ""
	}

	wanted := map[string]*wantSpec{}
	for _, s := range specs {
		wanted[s.ID] = s
		for _, rt := range s.Routes {
			if conflicts[keyOf(rt.Hostname, rt.PathPrefix)] {
				continue
			}
			hosts = append(hosts, rt.Hostname)
			k := key{rt.Hostname, rt.PathPrefix}
			note(k)
			ports[k] = append(ports[k], rt.ContainerPort)
			if rt.HSTS != nil {
				hsts[k] = rt.HSTS
			}
		}
		cur := r.current(s)
		if cur == nil || !cur.running || cur.busy {
			continue
		}
		for _, rt := range s.Routes {
			k := key{rt.Hostname, rt.PathPrefix}
			u, ok := upstream(cur, s.Network, rt.ContainerPort)
			switch {
			case !ok:
			case cur.health == healthHealthy, cur.health == healthUnknown && cur.adopted:
				add(healthy, k, u)
			case cur.health == healthUnhealthy:
				add(degraded, k, u)
			}
		}
	}
	for _, inst := range r.instances {
		if !inst.running || inst.busy || !inst.drainAt.IsZero() {
			continue
		}
		s := wanted[inst.meta.workloadID]
		if s != nil && s.SpecHash == inst.meta.specHash {
			continue
		}
		routes, network := inst.meta.routes, inst.meta.network
		if s != nil {
			routes = s.Routes
		}
		for _, rt := range routes {
			if u, ok := upstream(inst, network, rt.ContainerPort); ok {
				add(old, key{rt.Hostname, rt.PathPrefix}, u)
			}
		}
	}

	cfg := ingress.Config{TLSMode: ds.TLSMode, AllowedHosts: hosts}
	if in := ds.Ingress; in != nil {
		cfg.ManagedHosts, cfg.ChallengeUpstream = in.ManagedHosts, in.ACMEChallengeUpstream
	}
	for _, k := range keys {
		if conflicts[keyOf(k.host, k.prefix)] {
			continue
		}
		ups := healthy[k]
		if len(ups) == 0 {
			ups = old[k]
		}
		if len(ups) == 0 {
			ups = degraded[k]
		}
		cfg.Routes = append(cfg.Routes, ingress.Route{Host: k.host, PathPrefix: k.prefix, Upstreams: ups, Ports: ports[k], HSTS: hsts[k]})
	}
	return cfg
}

// -----------------------------------------------------------------------------
// Operations
// -----------------------------------------------------------------------------

// create pulls, creates and starts a container for s. It runs on its own
// goroutine so a slow pull never stalls the reconciler.
func (r *Runtime) create(s *wantSpec) {
	ctx := r.ctx
	err := r.createContainer(ctx, s)
	r.mu.Lock()
	ws := r.workloads[s.ID]
	if ws != nil {
		ws.busy = false
		ws.volumes = nil
		ws.doneSeq = r.listSeq
		if err != nil && ctx.Err() == nil {
			ws.failures++
			ws.phase = protocol.StateCrashed
			ws.message = err.Error()
			ws.retryIn = backoffDelay(r.opts.RestartBackoff, r.opts.MaxRestartBackoff, ws.failures-1)
			ws.retryAt = time.Now().Add(ws.retryIn)
		}
	}
	r.mu.Unlock()
	if err != nil && ctx.Err() == nil {
		r.log.Warn("start workload failed", "workload_id", s.ID, "image", s.Image, "err", err)
	}
	r.poke()
}

func (r *Runtime) setPhase(s *wantSpec, phase protocol.WorkloadState) {
	r.mu.Lock()
	if ws := r.workloads[s.ID]; ws != nil {
		ws.phase, ws.message = phase, ""
	}
	r.mu.Unlock()
	r.publishOne(s)
}

func (r *Runtime) createContainer(ctx context.Context, s *wantSpec) error {
	r.setPhase(s, protocol.StatePulling)
	if err := r.ensureImage(ctx, s); err != nil {
		return err
	}
	if err := r.resolveMounts(ctx, s); err != nil {
		return err
	}
	r.setPhase(s, protocol.StateStarting)
	secrets, err := r.writeSecretFiles(s)
	if err != nil {
		return fmt.Errorf("secret files: %w", err)
	}
	name := containerName(s)
	id, err := r.d.CreateContainer(ctx, name, r.containerCreate(s, secrets))
	if docker.IsConflict(err) {
		// The name embeds the spec hash, so the existing container runs this
		// very spec: adopt it if it runs, replace it if an interrupted
		// create left it behind.
		if info, inspectErr := r.d.InspectContainer(ctx, name); inspectErr == nil && info.State.Running {
			return nil
		}
		if rmErr := r.d.RemoveContainer(ctx, name); rmErr != nil {
			return fmt.Errorf("create container: %w", err)
		}
		id, err = r.d.CreateContainer(ctx, name, r.containerCreate(s, secrets))
	}
	if err != nil {
		if docker.IsNotFound(err) {
			r.mu.Lock()
			delete(r.networks, s.Network)
			r.mu.Unlock()
		}
		return fmt.Errorf("create container: %w", err)
	}
	r.log.Info("created container", "workload_id", s.ID, "container", short(id), "image", s.Image)
	if err := r.d.StartContainer(ctx, id); err != nil {
		// The container stays, stopped; the next pass treats it as a crash
		// and applies the restart policy with backoff.
		r.log.Warn("start container failed", "workload_id", s.ID, "container", short(id), "err", err)
	}
	return nil
}

func (r *Runtime) ensureImage(ctx context.Context, s *wantSpec) error {
	return EnsureImage(ctx, r.d, &s.WorkloadSpec, r.log)
}

// ImagePuller is the part of the engine API [EnsureImage] uses.
type ImagePuller interface {
	InspectImage(ctx context.Context, ref string) (docker.Image, error)
	PullImage(ctx context.Context, ref string, auth *docker.AuthConfig) error
}

// EnsureImage makes w.Image available locally. A digest reference that is
// already present is never re-pulled; a tag is pulled so a moved tag is
// picked up, falling back to the local copy if the registry is unreachable.
// registry_auth is only ever sent to the registry the image names.
//
// SECURITY: a workload with registry_auth is always pulled, never run from
// the local cache, so the registry checks its credentials every time: a
// private image cached for one project must not start for another project
// that names it without access (ADR 0014 H2).
func EnsureImage(ctx context.Context, d ImagePuller, w *protocol.WorkloadSpec, log *slog.Logger) error {
	ref := docker.ParseReference(w.Image)
	private := w.RegistryAuth != nil
	_, inspectErr := d.InspectImage(ctx, w.Image)
	if inspectErr == nil && ref.Digest != "" && !private {
		return nil
	}
	auth, ok := pullAuth(w)
	if !ok {
		log.Warn("registry_auth does not match the image's registry; pulling anonymously",
			"workload_id", w.ID, "image_registry", ref.Domain, "auth_server", w.RegistryAuth.Server)
	}
	err := d.PullImage(ctx, w.Image, auth)
	if err == nil {
		return nil
	}
	if inspectErr == nil && !private {
		log.Warn("pull failed; using the local copy", "workload_id", w.ID, "image", w.Image, "err", err)
		return nil
	}
	return fmt.Errorf("pull %s: %w", w.Image, err)
}

// startAsync (re)starts a stopped container. Caller holds r.mu.
func (r *Runtime) startAsync(inst *instance, restart bool) {
	inst.busy = true
	if restart {
		inst.restarts++
		inst.streak++
		inst.nextRestart = time.Time{}
		r.log.Info("restarting container", "workload_id", inst.meta.workloadID, "container", short(inst.id),
			"exit_code", inst.exitCode, "restarts", inst.restarts)
	}
	r.goTask(func() {
		err := r.d.StartContainer(r.ctx, inst.id)
		r.mu.Lock()
		inst.busy = false
		inst.doneSeq = r.listSeq
		if err != nil {
			// Force a fresh inspect so the failure shows up as a stopped
			// container with an error, which backs off like a crash.
			inst.status = ""
			inst.errMsg = err.Error()
		}
		r.mu.Unlock()
		if err != nil && r.ctx.Err() == nil {
			r.log.Warn("start container failed", "workload_id", inst.meta.workloadID, "container", short(inst.id), "err", err)
		}
		r.poke()
	})
}

// removeAsync stops and removes a container. Caller holds r.mu.
func (r *Runtime) removeAsync(inst *instance, why string) {
	inst.busy = true
	r.stopProbe(inst)
	r.goTask(func() {
		ctx := r.ctx
		var err error
		if inst.running {
			err = r.d.StopContainer(ctx, inst.id, inst.meta.stopGrace())
		}
		if err == nil || docker.IsNotFound(err) {
			err = r.d.RemoveContainer(ctx, inst.id)
		}
		r.mu.Lock()
		inst.busy = false
		inst.doneSeq = r.listSeq
		if err == nil {
			r.forget(inst)
		}
		r.mu.Unlock()
		if err != nil {
			if ctx.Err() == nil {
				r.log.Warn("remove container failed", "workload_id", inst.meta.workloadID, "container", short(inst.id), "err", err)
			}
		} else {
			r.log.Info("removed container", "workload_id", inst.meta.workloadID, "container", short(inst.id), "reason", why)
		}
		r.poke()
	})
}

// startProbe begins probing a running container. Caller holds r.mu.
func (r *Runtime) startProbe(inst *instance, s *wantSpec) {
	r.stopProbe(inst)
	ctx, cancel := context.WithCancel(r.ctx)
	inst.probeCancel = cancel
	inst.probeFor = inst.startedAt
	hc := *s.Healthcheck
	ip := inst.ips[s.Network]
	id := inst.id
	tracker := newHealthTracker(hc, inst.startedAt)
	r.goTask(func() {
		wait := tracker.firstDelay() - time.Since(tracker.started)
		for {
			if !sleep(ctx, max(wait, 0)) {
				return
			}
			pctx, pcancel := context.WithTimeout(ctx, tracker.timeout())
			var err error
			if hc.Type == protocol.HealthcheckExec {
				err = r.execProbe(pctx, id, hc.Command)
			} else {
				err = r.opts.Prober(pctx, hc, ip)
			}
			pcancel()
			if ctx.Err() != nil {
				return
			}
			changed := tracker.observe(err, time.Now())
			r.mu.Lock()
			if inst.probeFor.Equal(tracker.started) {
				inst.health = tracker.state
				inst.healthMsg = tracker.lastErr
			}
			r.mu.Unlock()
			if changed || err != nil {
				r.poke()
			}
			wait = tracker.interval()
		}
	})
}

// stopProbe cancels a container's probe. Caller holds r.mu.
func (r *Runtime) stopProbe(inst *instance) {
	if inst.probeCancel != nil {
		inst.probeCancel()
		inst.probeCancel = nil
	}
	inst.probeFor = time.Time{}
}

// ensureNetworks creates missing bridge networks for the desired specs.
func (r *Runtime) ensureNetworks(ctx context.Context, specs []*wantSpec) {
	for _, s := range specs {
		r.mu.Lock()
		known := r.networks[s.Network]
		r.mu.Unlock()
		if known || s.blocked != "" {
			continue
		}
		if err := r.ensureNetwork(ctx, s); err != nil {
			if ctx.Err() == nil {
				r.log.Warn("ensure network", "network", s.Network, "err", err)
			}
			continue
		}
		r.mu.Lock()
		r.networks[s.Network] = true
		r.mu.Unlock()
	}
}

// EnsureNetwork makes sure w's environment network exists, labelled and
// bridged as the runtime creates it, and has been handed to
// [Options.OnNetwork], before a container outside the reconciler (a job)
// joins it. A network the runtime believes exists is checked again, since
// its garbage collection may have removed it after the last job left.
// w must already be admitted: its network is created as given.
func (r *Runtime) EnsureNetwork(ctx context.Context, w *protocol.WorkloadSpec) error {
	r.mu.Lock()
	known := r.networks[w.Network]
	r.mu.Unlock()
	if known {
		_, err := r.d.InspectNetwork(ctx, w.Network)
		if err == nil || !docker.IsNotFound(err) {
			return err
		}
	}
	if err := r.ensureNetwork(ctx, &wantSpec{WorkloadSpec: *w}); err != nil {
		return err
	}
	r.mu.Lock()
	r.networks[w.Network] = true
	r.mu.Unlock()
	return nil
}

// ensureNetwork creates s's network if it is missing, then hands it to
// [Options.OnNetwork] before any container joins it.
func (r *Runtime) ensureNetwork(ctx context.Context, s *wantSpec) error {
	n, err := r.d.InspectNetwork(ctx, s.Network)
	if err != nil && !docker.IsNotFound(err) {
		return err
	}
	if err != nil {
		if err := r.createNetwork(ctx, s); err != nil {
			return err
		}
		if n, err = r.d.InspectNetwork(ctx, s.Network); err != nil {
			return err
		}
	}
	if r.opts.OnNetwork != nil {
		r.opts.OnNetwork(ctx, n)
	}
	return nil
}

func (r *Runtime) createNetwork(ctx context.Context, s *wantSpec) error {
	labels := map[string]string{LabelManaged: "true"}
	if s.ProjectID != nil {
		labels[LabelProjectID] = *s.ProjectID
	}
	if s.EnvironmentID != nil {
		labels[LabelEnvironmentID] = *s.EnvironmentID
	}
	if r.opts.Namespace != "" {
		labels[LabelNamespace] = r.opts.Namespace
	}
	_, err := r.d.CreateNetwork(ctx, docker.NetworkCreate{
		Name: s.Network, Driver: "bridge", Labels: labels,
		Options: map[string]string{docker.BridgeNameOption: BridgeInterface(s.Network)},
	})
	if docker.IsConflict(err) {
		return nil
	}
	if err == nil {
		r.log.Info("created network", "network", s.Network)
	}
	return err
}

// BridgeInterface returns the host interface name the runtime gives a
// network it creates: "rh-" and 12 hex characters of the name's SHA-256,
// within Linux's 15-character limit and recognisable on the host.
func BridgeInterface(network string) string {
	sum := sha256.Sum256([]byte(network))
	return "rh-" + hex.EncodeToString(sum[:6])
}

// -----------------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------------

// publish recomputes every workload's status, sends what changed, and hands
// the container list to the log shipper.
func (r *Runtime) publish(specs []*wantSpec) {
	r.mu.Lock()
	reports := map[string]protocol.WorkloadStatusReport{}
	wanted := map[string]bool{}
	for _, s := range specs {
		reports[s.ID] = r.statusOf(s)
		wanted[s.ID] = true
	}
	// Containers of workloads no longer desired keep reporting until they
	// are gone, then report removed once. Of several, the newest speaks.
	for _, inst := range r.sortedInstances() {
		if _, desired := wanted[inst.meta.workloadID]; !desired {
			reports[inst.meta.workloadID] = r.statusOfInstance(inst)
		}
	}
	if specs != nil {
		for id := range r.workloads {
			if _, ok := reports[id]; !ok {
				delete(r.workloads, id)
			}
		}
	}
	var containers []Container
	for _, inst := range r.instances {
		containers = append(containers, Container{
			ID: inst.id, WorkloadID: inst.meta.workloadID, DeploymentID: inst.meta.deploymentID,
			Running: inst.running, StartedAt: inst.startedAt,
			PID: inst.pid, Restarts: inst.restarts,
		})
	}
	r.mu.Unlock()

	if specs != nil || len(reports) > 0 {
		r.statuses.sync(reports, specs != nil)
	}
	if r.opts.Containers != nil {
		slices.SortFunc(containers, func(a, b Container) int { return strings.Compare(a.ID, b.ID) })
		r.opts.Containers(containers)
	}
}

// publishOne recomputes and sends one workload's status.
func (r *Runtime) publishOne(s *wantSpec) {
	r.mu.Lock()
	rep := r.statusOf(s)
	r.mu.Unlock()
	r.statuses.set(rep)
}

// statusOf derives a desired workload's status. Caller holds r.mu.
func (r *Runtime) statusOf(s *wantSpec) protocol.WorkloadStatusReport {
	rep := protocol.WorkloadStatusReport{WorkloadID: s.ID, DeploymentID: s.DeploymentID, State: protocol.StatePending}
	cur := r.current(s)
	if cur == nil {
		if ws := r.workloads[s.ID]; ws != nil && ws.phase != "" {
			rep.State, rep.Message = ws.phase, ws.message
			if ws.phase == protocol.StateCrashed && !ws.retryAt.IsZero() {
				rep.Message = fmt.Sprintf("%s (retrying after %s back-off)", ws.message, ws.retryIn)
			}
		}
		return rep
	}
	rep.ContainerID = cur.id
	rep.Restarts = cur.restarts
	if why := r.heldReason(s.ID, cur.meta.volumes); why != "" && !cur.running {
		rep.State, rep.Message = protocol.StatePending, why
		return rep
	}
	switch {
	case cur.running && cur.health == healthHealthy:
		rep.State = protocol.StateHealthy
	case cur.running && cur.health == healthUnhealthy:
		rep.State, rep.Message = protocol.StateUnhealthy, cur.healthMsg
	case cur.running:
		rep.State, rep.Message = protocol.StateRunning, cur.healthMsg
	case cur.status == "created" && cur.startedAt.IsZero() && cur.errMsg == "":
		rep.State = protocol.StateStarting
	default:
		code := cur.exitCode
		rep.ExitCode = &code
		rep.State = stoppedState(cur.exitCode, cur.oomKilled)
		rep.Message = stopReason(cur)
		// NOTE: startAsync counts a restart before the engine runs it, so
		// while a start is in flight or not yet re-inspected, the exit seen
		// is the previous run's: judging the policy on it would report
		// giving up while the last allowed restart is still under way.
		inFlight := cur.busy || !cur.settled()
		if !cur.nextRestart.IsZero() {
			rep.Message = strings.TrimPrefix(rep.Message+"; restarting after "+cur.backoff.String()+" back-off", "; ")
		} else if inFlight || shouldRestart(s.Restart, cur.restarts, cur.exitCode, cur.oomKilled) {
			rep.Message = strings.TrimPrefix(rep.Message+"; restarting", "; ")
		} else if s.Restart.Policy == protocol.RestartOnFailure && rep.State == protocol.StateCrashed {
			rep.Message = strings.TrimPrefix(fmt.Sprintf("%s; gave up after %d restarts", rep.Message, cur.restarts), "; ")
		}
	}
	if s.note != "" {
		rep.Message = appendNote(rep.Message, s.note)
	}
	return rep
}

// statusOfInstance reports a container whose workload is no longer desired,
// or any container before the first desired state. Caller holds r.mu.
func (r *Runtime) statusOfInstance(inst *instance) protocol.WorkloadStatusReport {
	rep := protocol.WorkloadStatusReport{WorkloadID: inst.meta.workloadID, ContainerID: inst.id, Restarts: inst.restarts}
	if inst.meta.deploymentID != "" {
		id := inst.meta.deploymentID
		rep.DeploymentID = &id
	}
	switch {
	case inst.running && inst.health == healthHealthy:
		rep.State = protocol.StateHealthy
	case inst.running && inst.health == healthUnhealthy:
		rep.State = protocol.StateUnhealthy
	case inst.running:
		rep.State = protocol.StateRunning
	default:
		code := inst.exitCode
		rep.ExitCode = &code
		rep.State = stoppedState(inst.exitCode, inst.oomKilled)
		rep.Message = stopReason(inst)
	}
	return rep
}

func stopReason(inst *instance) string {
	switch {
	case inst.oomKilled:
		return "out of memory"
	case inst.errMsg != "":
		return inst.errMsg
	case inst.exitCode != 0:
		return fmt.Sprintf("exited with code %d", inst.exitCode)
	}
	return ""
}

// containerCreate is [containerCreate] plus the runtime's namespace label and,
// when secretsBind is set, the bind mount of the workload's secret files.
func (r *Runtime) containerCreate(s *wantSpec, secretsBind string) docker.ContainerCreate {
	cc := containerCreate(s)
	if secretsBind != "" {
		cc.HostConfig.Binds = append(slices.Clip(cc.HostConfig.Binds), secretsBind)
	}
	if r.opts.Namespace != "" {
		cc.Labels[LabelNamespace] = r.opts.Namespace
	}
	return cc
}
