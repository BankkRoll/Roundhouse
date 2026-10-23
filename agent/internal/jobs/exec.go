package jobs

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/runtime"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// errCancelled stops preparing a run that job_cancel abandoned.
var errCancelled = errors.New("cancelled")

// execute prepares and starts a fresh run, then supervises it to the end.
// ctx is aborted by a job_cancel that arrives before the container exists.
func (r *Runner) execute(ctx context.Context, rn *run, w *protocol.WorkloadSpec) {
	if r.opts.OpenEnv != nil {
		if err := r.opts.OpenEnv(rn.id, w); err != nil {
			r.finish(rn, protocol.JobFailed, nil, runtime.EnvFailure(err), 0)
			return
		}
	}
	err := runtime.EnsureImage(ctx, r.d, w, r.log)
	if r.interrupted(rn) {
		return
	}
	if err != nil {
		r.systemLog(rn, "pull failed: "+err.Error())
		r.finish(rn, protocol.JobFailed, nil, err.Error(), 0)
		return
	}
	if r.opts.Network != nil {
		err := r.opts.Network(ctx, w)
		if r.interrupted(rn) {
			return
		}
		if err != nil {
			r.finish(rn, protocol.JobFailed, nil, fmt.Sprintf("network %s: %v", w.Network, err), 0)
			return
		}
	}
	bind, err := runtime.WriteSecretFiles(r.opts.SecretsDir, w.ID, w.SecretFiles)
	if err != nil {
		r.finish(rn, protocol.JobFailed, nil, "secret files: "+err.Error(), 0)
		return
	}
	id, err := r.createAndStart(ctx, rn, w, containerCreate(w, rn.id, r.opts.Namespace, bind))
	if err != nil {
		if !r.interrupted(rn) {
			r.finish(rn, protocol.JobFailed, nil, err.Error(), 0)
		}
		return
	}

	started := time.Now()
	if info, err := r.d.InspectContainer(r.ctx, id); err == nil && !info.State.StartedAt.IsZero() {
		started = info.State.StartedAt
	}
	r.mu.Lock()
	rn.startedAt = started.UnixMilli()
	rn.deadline = started.Add(time.Duration(rn.timeoutS) * r.opts.unit).UnixMilli()
	r.setStatusLocked(rn, protocol.JobRunning, nil, "", 0)
	r.mu.Unlock()
	r.log.Info("job running", "run_id", rn.id, "container", short(id))
	r.persist()
	r.poke()
	r.supervise(rn, true)
}

// interrupted reports whether preparing rn must stop: the agent is shutting
// down (the run stays persisted and the next process reports it), or a
// job_cancel abandoned it, which this reports.
func (r *Runner) interrupted(rn *run) bool {
	if r.ctx.Err() != nil {
		return true
	}
	r.mu.Lock()
	cancelled, reason := rn.cancelled, rn.cancelReason
	r.mu.Unlock()
	if !cancelled {
		return false
	}
	msg := cancelMessage(reason)
	r.systemLog(rn, msg+" (before the job started)")
	r.finish(rn, protocol.JobCancelled, nil, msg, 0)
	return true
}

// createAndStart creates and starts rn's container. A network the runtime's
// garbage collection removed between [Options.Network] and the create (or
// the start) is ensured again and the whole step retried once.
func (r *Runner) createAndStart(ctx context.Context, rn *run, w *protocol.WorkloadSpec, cc docker.ContainerCreate) (string, error) {
	name := ContainerPrefix + rn.id
	for attempt := 0; ; attempt++ {
		id, err := r.d.CreateContainer(ctx, name, cc)
		if docker.IsConflict(err) {
			// Left by an attempt this process can't account for, such as a
			// create interrupted by a restart.
			if rmErr := r.d.RemoveContainer(ctx, name); rmErr == nil {
				id, err = r.d.CreateContainer(ctx, name, cc)
			}
		}
		if err == nil {
			r.mu.Lock()
			rn.containerID = id
			cancelled := rn.cancelled
			r.mu.Unlock()
			r.persist()
			if cancelled {
				return "", errCancelled
			}
			if err = r.d.StartContainer(ctx, id); err == nil {
				return id, nil
			}
			err = fmt.Errorf("start container: %w", err)
		} else {
			err = fmt.Errorf("create container: %w", err)
		}
		if attempt > 0 || !docker.IsNotFound(err) || r.opts.Network == nil || ctx.Err() != nil {
			return "", err
		}
		r.log.Info("job network vanished; ensuring it again", "run_id", rn.id, "network", w.Network, "err", err)
		if id != "" {
			_ = r.d.RemoveContainer(ctx, id)
			r.mu.Lock()
			rn.containerID = ""
			r.mu.Unlock()
		}
		if nerr := r.opts.Network(ctx, w); nerr != nil {
			return "", err
		}
	}
}

// exitResult is how a run's container ended.
type exitResult struct {
	code int
	// gone means the container no longer exists.
	gone bool
}

// supervise follows a started container's logs, enforces its deadline and
// job_cancel, and reports its outcome once it exits. It returns early, the
// container still running, when the runner stops. running is false for a
// container found already exited after a restart: its exit code decides,
// unless the agent had begun stopping it.
func (r *Runner) supervise(rn *run, running bool) {
	r.mu.Lock()
	id, deadline, grace := rn.containerID, rn.deadline, time.Duration(rn.graceS)*r.opts.unit
	resume := rn.killing
	r.mu.Unlock()
	cancelC := (<-chan struct{})(rn.cancelCh)
	if !running {
		deadline, cancelC, resume = 0, nil, ""
	}

	exited := make(chan struct{})
	logCtx, stopLogs := context.WithCancel(r.ctx)
	defer stopLogs()
	logsDone := make(chan bool, 1)
	r.goTask(func() { logsDone <- r.follow(logCtx, rn, id, exited) })
	waited := make(chan exitResult, 1)
	r.goTask(func() { waited <- r.waitExit(id) })

	var deadlineC <-chan time.Time
	if deadline > 0 {
		t := time.NewTimer(time.Until(time.UnixMilli(deadline)))
		defer t.Stop()
		deadlineC = t.C
	}
	var graceC <-chan time.Time
	kill := func(why killReason) {
		r.mu.Lock()
		if rn.killing != "" && rn.killing != resume {
			r.mu.Unlock()
			return
		}
		rn.killing = why
		timeout, reason := rn.timeoutS, rn.cancelReason
		r.mu.Unlock()
		resume = ""
		r.persist()
		if why == killTimeout {
			r.systemLog(rn, fmt.Sprintf("timed out after %ds: sending SIGTERM", timeout))
		} else {
			r.systemLog(rn, cancelMessage(reason)+": sending SIGTERM")
		}
		r.log.Info("stopping job", "run_id", rn.id, "reason", why)
		if err := r.d.KillContainer(r.ctx, id, "SIGTERM"); err != nil {
			r.log.Debug("send SIGTERM", "run_id", rn.id, "err", err)
		}
		t := time.NewTimer(grace)
		graceC = t.C
	}
	if resume != "" {
		kill(resume)
	}

	var res exitResult
wait:
	for {
		select {
		case <-r.ctx.Done():
			return
		case res = <-waited:
			break wait
		case <-deadlineC:
			deadlineC = nil
			kill(killTimeout)
		case <-cancelC:
			cancelC = nil
			kill(killCancel)
		case <-graceC:
			graceC = nil
			r.systemLog(rn, fmt.Sprintf("killed after %ds grace", rn.graceS))
			if err := r.d.KillContainer(r.ctx, id, "SIGKILL"); err != nil {
				r.log.Debug("send SIGKILL", "run_id", rn.id, "err", err)
			}
		}
	}
	close(exited)

	code, oom, finishedAt := res.code, false, int64(0)
	if !res.gone {
		if info, err := r.d.InspectContainer(r.ctx, id); err == nil {
			code, oom = info.State.ExitCode, info.State.OOMKilled
			if !info.State.FinishedAt.IsZero() {
				finishedAt = info.State.FinishedAt.UnixMilli()
			}
		}
	} else {
		stopLogs()
	}
	timer := time.NewTimer(r.opts.logWait)
	select {
	case <-logsDone:
	case <-timer.C:
		r.log.Warn("job logs did not finish; reporting the outcome anyway", "run_id", rn.id)
		stopLogs()
		<-logsDone
	case <-r.ctx.Done():
	}
	timer.Stop()
	if r.ctx.Err() != nil {
		return
	}
	code = min(max(code, -1), 255)

	r.mu.Lock()
	killing, reason, timeout := rn.killing, rn.cancelReason, rn.timeoutS
	r.mu.Unlock()
	switch {
	case res.gone:
		r.finish(rn, protocol.JobFailed, nil, MessageRemoved, 0)
	case killing == killTimeout:
		r.finish(rn, protocol.JobTimedOut, &code, fmt.Sprintf("timed out after %ds", timeout), finishedAt)
	case killing == killCancel:
		r.finish(rn, protocol.JobCancelled, &code, cancelMessage(reason), finishedAt)
	case code == 0:
		r.finish(rn, protocol.JobSucceeded, &code, "", finishedAt)
	case oom:
		r.finish(rn, protocol.JobFailed, &code, MessageOOM, finishedAt)
	default:
		r.finish(rn, protocol.JobFailed, &code, fmt.Sprintf("exited with code %d", code), finishedAt)
	}
}

// waitExit waits until container id is not running, retrying engine errors
// until the runner stops.
func (r *Runner) waitExit(id string) exitResult {
	delay := 500 * time.Millisecond
	for {
		code, err := r.d.WaitContainer(r.ctx, id, "not-running")
		switch {
		case err == nil:
			return exitResult{code: code}
		case docker.IsNotFound(err):
			return exitResult{gone: true}
		case r.ctx.Err() != nil:
			return exitResult{}
		}
		r.log.Debug("wait for job container", "container", short(id), "err", err)
		if !sleep(r.ctx, delay) {
			return exitResult{}
		}
		delay = min(delay*2, 30*time.Second)
	}
}

// finish records rn's terminal status for delivery, once.
func (r *Runner) finish(rn *run, st protocol.JobState, exitCode *int, message string, finishedAt int64) {
	r.mu.Lock()
	if rn.terminal() {
		r.mu.Unlock()
		return
	}
	r.setStatusLocked(rn, st, exitCode, message, finishedAt)
	r.mu.Unlock()
	r.log.Info("job finished", "run_id", rn.id, "state", st, "message", message)
	r.persist()
	r.poke()
}

// cleanup removes a delivered run's container and secret files, then
// forgets it, remembering its status in case its job_run comes again.
func (r *Runner) cleanup(rn *run) {
	r.mu.Lock()
	id, workload := rn.containerID, rn.workloadID
	r.mu.Unlock()
	if id == "" {
		// A create that a job_cancel aborted may still have made the
		// container; removing a missing one is no error.
		id = ContainerPrefix + rn.id
	}
	if err := r.d.RemoveContainer(r.ctx, id); err != nil {
		r.log.Warn("remove job container; retrying", "run_id", rn.id, "container", short(id), "err", err)
		r.mu.Lock()
		rn.cleaning = false
		r.mu.Unlock()
		return
	}
	if r.opts.SecretsDir != "" && workload != "" {
		if err := os.RemoveAll(filepath.Join(r.opts.SecretsDir, workload)); err != nil {
			r.log.Warn("remove job secret files", "run_id", rn.id, "err", err)
		}
	}
	r.mu.Lock()
	delete(r.runs, rn.id)
	r.recent = append(r.recent, rn.status)
	if len(r.recent) > recentRuns {
		r.recent = r.recent[len(r.recent)-recentRuns:]
	}
	r.mu.Unlock()
	r.persist()
}

// systemLog ships an agent-written line into the run's logs.
func (r *Runner) systemLog(rn *run, text string) {
	if r.opts.Logs == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), sendTimeout)
	defer cancel()
	l := protocol.Logs{
		Type:   protocol.TypeLogs,
		Source: logSource(rn),
		Lines:  []protocol.LogLine{{TS: time.Now().UnixMilli(), Stream: protocol.StreamSystem, Text: protocol.TruncateLogLine(text)}},
	}
	if err := r.opts.Logs(ctx, l); err != nil {
		r.log.Debug("ship job system log line", "run_id", rn.id, "err", err)
	}
}

func logSource(rn *run) protocol.LogSource {
	return protocol.LogSource{Type: protocol.LogSourceJob, RunID: rn.id, WorkloadID: rn.workloadID}
}

func cancelMessage(reason string) string {
	if reason == "" {
		return "cancelled"
	}
	return "cancelled: " + reason
}

func short(id string) string { return id[:min(12, len(id))] }

// sleep waits for d or until ctx ends, and reports whether d passed.
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
