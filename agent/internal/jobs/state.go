package jobs

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/atomicfile"
	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/runtime"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// stateFile is the content of jobs.json. It holds IDs, times and statuses
// only: environment and secret values never reach the disk here.
type stateFile struct {
	Runs []savedRun `json:"runs"`
	// Recent are the terminal statuses of runs already removed.
	Recent []protocol.JobStatus `json:"recent,omitempty"`
}

// savedRun is one run in flight, or finished but not yet delivered and
// removed.
type savedRun struct {
	RunID       string `json:"run_id"`
	WorkloadID  string `json:"workload_id"`
	ContainerID string `json:"container_id,omitempty"`
	TimeoutS    int    `json:"timeout_s"`
	KillGraceS  int    `json:"kill_grace_s"`
	// StartedAt and Deadline are unix ms.
	StartedAt    int64      `json:"started_at,omitempty"`
	Deadline     int64      `json:"deadline,omitempty"`
	Cancelled    bool       `json:"cancelled,omitempty"`
	CancelReason string     `json:"cancel_reason,omitempty"`
	Killing      killReason `json:"killing,omitempty"`
	// Status is the latest status; Pending means it was not delivered.
	Status  protocol.JobStatus `json:"status"`
	Pending bool               `json:"pending,omitempty"`
	// LastLogNS is the timestamp of the last log line shipped, unix nanos.
	LastLogNS int64 `json:"last_log_ns,omitempty"`
}

// load reads the persisted runs. A missing file means none; a corrupt one
// is logged and ignored, and its containers are then removed as orphans.
func (r *Runner) load() {
	if r.opts.StatePath == "" {
		return
	}
	data, err := os.ReadFile(r.opts.StatePath)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			r.log.Warn("read job state", "path", r.opts.StatePath, "err", err)
		}
		return
	}
	var sf stateFile
	if err := json.Unmarshal(data, &sf); err != nil {
		r.log.Warn("job state file is corrupt; ignoring it", "path", r.opts.StatePath, "err", err)
		return
	}
	for _, s := range sf.Runs {
		if !plainID(s.RunID) || !plainID(s.WorkloadID) || r.runs[s.RunID] != nil {
			continue
		}
		rn := &run{
			id: s.RunID, workloadID: s.WorkloadID, timeoutS: s.TimeoutS, graceS: s.KillGraceS,
			containerID: s.ContainerID, startedAt: s.StartedAt, deadline: s.Deadline,
			cancelled: s.Cancelled, cancelReason: s.CancelReason, killing: s.Killing,
			status: s.Status, seq: 1, sent: 1, lastLogNS: s.LastLogNS, cancelCh: make(chan struct{}),
		}
		if s.Pending {
			rn.sent = 0
		}
		if rn.cancelled {
			close(rn.cancelCh)
		}
		r.runs[rn.id] = rn
	}
	r.recent = sf.Recent
}

// persist writes jobs.json now.
func (r *Runner) persist() {
	r.saveMu.Lock()
	defer r.saveMu.Unlock()
	r.mu.Lock()
	sf := stateFile{Runs: make([]savedRun, 0, len(r.runs)), Recent: slices.Clone(r.recent)}
	for _, rn := range r.runs {
		sf.Runs = append(sf.Runs, savedRun{
			RunID: rn.id, WorkloadID: rn.workloadID, ContainerID: rn.containerID,
			TimeoutS: rn.timeoutS, KillGraceS: rn.graceS, StartedAt: rn.startedAt, Deadline: rn.deadline,
			Cancelled: rn.cancelled, CancelReason: rn.cancelReason, Killing: rn.killing,
			Status: rn.status, Pending: rn.seq != rn.sent, LastLogNS: rn.lastLogNS,
		})
	}
	r.stateDirty = false
	r.savedAt = time.Now()
	r.mu.Unlock()
	if r.opts.StatePath == "" {
		return
	}
	slices.SortFunc(sf.Runs, func(a, b savedRun) int { return cmp.Compare(a.RunID, b.RunID) })
	data, err := json.Marshal(sf)
	if err == nil {
		err = atomicfile.Write(r.opts.StatePath, data, 0o600)
	}
	if err != nil {
		r.log.Warn("persist job state", "path", r.opts.StatePath, "err", err)
	}
}

// saveIfDue persists log positions at most every [saveEvery].
func (r *Runner) saveIfDue() {
	r.mu.Lock()
	due := r.stateDirty && time.Since(r.savedAt) >= saveEvery
	r.mu.Unlock()
	if due {
		r.persist()
	}
}

// recover removes orphaned job containers and secret files, then
// re-attaches to every persisted run that was not finished.
func (r *Runner) recover(ctx context.Context) {
	r.removeOrphans(ctx)
	r.mu.Lock()
	var todo []*run
	for _, rn := range r.runs {
		if !rn.attached && !rn.terminal() {
			rn.attached = true
			todo = append(todo, rn)
		}
	}
	r.mu.Unlock()
	for _, rn := range todo {
		r.goTask(func() {
			defer r.detach(rn)
			r.reattach(rn)
		})
	}
}

// reattach takes over a run an earlier agent process started: it supervises
// the container if it still runs (its original deadline still applies),
// reports its outcome if it exited meanwhile, and fails the run if the
// container never started or is gone.
func (r *Runner) reattach(rn *run) {
	r.mu.Lock()
	ref := rn.containerID
	r.mu.Unlock()
	if ref == "" {
		ref = ContainerPrefix + rn.id
	}
	var info docker.ContainerInfo
	delay := time.Second
	for {
		var err error
		info, err = r.d.InspectContainer(r.ctx, ref)
		if err == nil {
			break
		}
		if docker.IsNotFound(err) {
			r.mu.Lock()
			created := rn.containerID != ""
			r.mu.Unlock()
			msg := MessageInterrupted
			if created {
				msg = MessageLost
			}
			r.log.Warn("job run's container is gone", "run_id", rn.id, "message", msg)
			r.finish(rn, protocol.JobFailed, nil, msg, 0)
			return
		}
		r.log.Warn("inspect job container; retrying", "run_id", rn.id, "err", err)
		if !sleep(r.ctx, delay) {
			return
		}
		delay = min(delay*2, 30*time.Second)
	}

	r.mu.Lock()
	rn.containerID = info.ID
	if info.State.StartedAt.IsZero() || info.State.Status == "created" {
		r.mu.Unlock()
		r.log.Warn("job run was never started", "run_id", rn.id)
		r.finish(rn, protocol.JobFailed, nil, MessageInterrupted, 0)
		return
	}
	if rn.startedAt == 0 {
		rn.startedAt = info.State.StartedAt.UnixMilli()
		rn.deadline = info.State.StartedAt.Add(time.Duration(rn.timeoutS) * r.opts.unit).UnixMilli()
	}
	if rn.status.State != protocol.JobRunning {
		r.setStatusLocked(rn, protocol.JobRunning, nil, "", 0)
	}
	r.mu.Unlock()
	r.persist()
	r.poke()
	if info.State.Running {
		r.systemLog(rn, "agent restarted: re-attached to the running job")
	}
	r.log.Info("re-attached to job run", "run_id", rn.id, "container", short(info.ID), "running", info.State.Running)
	r.supervise(rn, info.State.Running)
}

// removeOrphans removes this namespace's job containers that no run
// claims, and secret directories of workloads no run has.
func (r *Runner) removeOrphans(ctx context.Context) {
	r.mu.Lock()
	runs, workloads := map[string]bool{}, map[string]bool{}
	for _, rn := range r.runs {
		runs[rn.id] = true
		workloads[rn.workloadID] = true
	}
	r.mu.Unlock()

	// SECURITY: without a namespace, another agent's job containers on a
	// shared engine would look like orphans.
	if r.opts.Namespace != "" {
		list, err := r.d.ListContainers(ctx, JobFilter, runtime.LabelNamespace+"="+r.opts.Namespace)
		if err != nil {
			r.log.Warn("list job containers", "err", err)
		}
		for _, c := range list {
			if runs[c.Labels[LabelRunID]] {
				continue
			}
			if err := r.d.RemoveContainer(ctx, c.ID); err != nil {
				r.log.Warn("remove orphaned job container", "container", short(c.ID), "err", err)
				continue
			}
			r.log.Info("removed orphaned job container", "container", short(c.ID), "run_id", c.Labels[LabelRunID])
		}
	}

	if r.opts.SecretsDir == "" {
		return
	}
	entries, err := os.ReadDir(r.opts.SecretsDir)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			r.log.Warn("list job secret directories", "err", err)
		}
		return
	}
	for _, e := range entries {
		if !e.IsDir() || workloads[e.Name()] {
			continue
		}
		if err := os.RemoveAll(filepath.Join(r.opts.SecretsDir, e.Name())); err != nil {
			r.log.Warn("remove orphaned job secret files", "workload_id", e.Name(), "err", err)
		}
	}
}
