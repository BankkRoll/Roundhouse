package shell

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/jobs"
	"github.com/BankkRoll/Roundhouse/agent/internal/runtime"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// session is one interactive process, from exec_open until its exec_exit.
type session struct {
	m          *Manager
	id         string
	workloadID string
	command    []string
	env        []string
	idle       time.Duration
	maxDur     time.Duration

	mu     sync.Mutex
	inputs []*protocol.ExecInput
	// rows and cols are the latest size asked for.
	rows, cols int
	end        *exitInfo

	inputSig  chan struct{}
	resizeSig chan struct{}
	// endSig is closed by the first [session.requestEnd].
	endSig chan struct{}
	// activity receives a value each time input is applied.
	activity chan struct{}
}

func newSession(m *Manager, f *protocol.ExecOpen) *session {
	keys := make([]string, 0, len(f.Env))
	for k := range f.Env {
		// SECURITY: only terminal settings reach the process environment,
		// whatever a frame that slipped past validation carries.
		if slices.Contains(protocol.ExecEnvKeys, k) {
			keys = append(keys, k)
		}
	}
	slices.Sort(keys)
	env := make([]string, len(keys))
	for i, k := range keys {
		env[i] = k + "=" + f.Env[k]
	}
	return &session{
		m: m, id: f.SessionID, workloadID: f.WorkloadID,
		command: slices.Clone(f.Command), env: env,
		idle:   time.Duration(f.IdleTimeoutS) * m.opts.unit,
		maxDur: time.Duration(f.MaxDurationS) * m.opts.unit,
		rows:   f.Rows, cols: f.Cols,
		inputSig:  make(chan struct{}, 1),
		resizeSig: make(chan struct{}, 1),
		endSig:    make(chan struct{}),
		activity:  make(chan struct{}, 1),
	}
}

func signal(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

func (s *session) queueInput(f *protocol.ExecInput) {
	s.mu.Lock()
	full := len(s.inputs) >= maxQueuedInputs
	if !full {
		s.inputs = append(s.inputs, f)
	}
	s.mu.Unlock()
	if full {
		s.requestEnd(exitInfo{reason: protocol.ExecExitError, message: "input backlog: the process is not reading its input"})
		return
	}
	signal(s.inputSig)
}

func (s *session) resize(rows, cols int) {
	s.mu.Lock()
	s.rows, s.cols = rows, cols
	s.mu.Unlock()
	signal(s.resizeSig)
}

func (s *session) size() (rows, cols int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rows, s.cols
}

// requestEnd ends the session; the first request decides the exit reason.
func (s *session) requestEnd(e exitInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.end != nil {
		return
	}
	s.end = &e
	close(s.endSig)
}

func (s *session) ending() exitInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return *s.end
}

// run serves the session and sends its one exec_exit.
func (s *session) run() {
	start := time.Now()
	e := s.serve(s.m.ctx)
	s.m.sendExit(s.id, e)
	s.m.remove(s)
	attrs := []any{"session_id", s.id, "workload_id", s.workloadID, "reason", e.reason,
		"duration", time.Since(start).Round(time.Millisecond)}
	if e.code != nil {
		attrs = append(attrs, "exit_code", *e.code)
	}
	if e.message != "" {
		attrs = append(attrs, "message", e.message)
	}
	s.m.log.Info("shell session ended", attrs...)
}

func errExit(format string, args ...any) exitInfo {
	return exitInfo{reason: protocol.ExecExitError, message: fmt.Sprintf(format, args...)}
}

// target finds and re-checks the container to exec into and returns its ID
// and configured user.
//
// SECURITY: the runtime's view is checked against the engine's right before
// the exec, so a stale or confused lookup can never reach a container of
// another node, another workload, the system or a job, nor a privileged one
// (ADR 0014 §15).
func (s *session) target(ctx context.Context) (id, user string, err error) {
	if !protocol.ValidExecCommand(s.command) {
		return "", "", errors.New("invalid command")
	}
	if s.m.opts.Namespace == "" || s.m.opts.Workloads == nil {
		return "", "", errors.New("this node does not run shell sessions")
	}
	if strings.HasPrefix(s.workloadID, runtime.SystemWorkloadPrefix) {
		return "", "", fmt.Errorf("workload %s is a system workload", s.workloadID)
	}
	id, err = s.m.opts.Workloads.ShellContainer(s.workloadID)
	if err != nil {
		return "", "", err
	}
	ictx, cancel := context.WithTimeout(ctx, dockerTimeout)
	defer cancel()
	info, err := s.m.opts.Docker.InspectContainer(ictx, id)
	if err != nil {
		if docker.IsNotFound(err) {
			return "", "", fmt.Errorf("workload %s has no container", s.workloadID)
		}
		return "", "", fmt.Errorf("inspect container: %w", err)
	}
	l := info.Config.Labels
	switch {
	case l[runtime.LabelNamespace] != s.m.opts.Namespace:
		return "", "", errors.New("the container belongs to another node")
	case l[runtime.LabelManaged] != "true" || l[runtime.LabelWorkloadID] != s.workloadID:
		return "", "", fmt.Errorf("the container is not workload %s's", s.workloadID)
	case l[runtime.LabelKind] != string(protocol.WorkloadService) || l[jobs.LabelJob] != "":
		return "", "", fmt.Errorf("workload %s is not a service workload", s.workloadID)
	case info.HostConfig.Privileged:
		return "", "", errors.New("the container is privileged")
	case !info.State.Running || info.State.Restarting || info.State.Status != "running":
		return "", "", fmt.Errorf("workload %s is not running", s.workloadID)
	}
	user = info.Config.User
	if user == "" {
		user = "root"
	}
	return info.ID, user, nil
}

// serve opens the process, relays it until the session ends and stops it.
func (s *session) serve(ctx context.Context) exitInfo {
	containerID, user, err := s.target(ctx)
	if err != nil {
		s.m.log.Warn("refused shell session", "session_id", s.id, "workload_id", s.workloadID, "reason", err)
		return errExit("%v", err)
	}
	select {
	case <-s.endSig:
		return s.ending()
	case <-ctx.Done():
		return errExit("%s", MessageShutdown)
	default:
	}
	cctx, cancel := context.WithTimeout(ctx, dockerTimeout)
	// SECURITY: no User, Privileged or capabilities: the process runs as the
	// container's configured user, and Cmd is the frame's argv verbatim.
	execID, err := s.m.opts.Docker.CreateExec(cctx, containerID, docker.ExecConfig{
		Cmd: s.command, Env: s.env, Tty: true,
		AttachStdin: true, AttachStdout: true, AttachStderr: true,
	})
	cancel()
	if err != nil {
		return errExit("create exec: %v", err)
	}
	// NOTE: the stream outlives ctx on purpose: at shutdown the process is
	// signalled first, then the stream closed.
	stream, err := s.m.opts.Docker.StartExecTTY(context.WithoutCancel(ctx), execID)
	if err != nil {
		s.stop(ctx, containerID, execID)
		return errExit("start exec: %v", err)
	}
	s.applySize(ctx, execID, true)
	s.m.send(&protocol.ExecOpened{Type: protocol.TypeExecOpened, SessionID: s.id, User: user}, s.id)
	s.m.log.Info("shell session opened", "session_id", s.id, "workload_id", s.workloadID, "user", user)

	outDone := make(chan struct{})
	go s.pumpOutput(stream, outDone)
	stopInput := make(chan struct{})
	inDone := make(chan struct{})
	go s.pumpInput(stream, stopInput, inDone)

	idle := time.NewTimer(s.idle)
	defer idle.Stop()
	deadline := time.NewTimer(s.maxDur)
	defer deadline.Stop()
	var e exitInfo
	exited := false
loop:
	for {
		select {
		case <-ctx.Done():
			e = errExit("%s", MessageShutdown)
			break loop
		case <-s.endSig:
			e = s.ending()
			break loop
		case <-idle.C:
			e = exitInfo{reason: protocol.ExecExitIdleTimeout}
			break loop
		case <-deadline.C:
			e = exitInfo{reason: protocol.ExecExitMaxDuration}
			break loop
		case <-outDone:
			exited = true
			break loop
		case <-s.activity:
			idle.Reset(s.idle)
		case <-s.resizeSig:
			s.applySize(ctx, execID, false)
		}
	}
	// Later end requests (a close racing the exit) must not block anyone.
	s.requestEnd(e)
	close(stopInput)
	if exited {
		e = s.exitCode(ctx, containerID, execID)
	} else {
		s.stop(ctx, containerID, execID)
	}
	stream.Close()
	<-outDone
	<-inDone
	return e
}

// applySize sends the latest terminal size to the engine. Right after the
// start the process may not have its terminal yet, so the first resize is
// retried briefly.
func (s *session) applySize(ctx context.Context, execID string, first bool) {
	rows, cols := s.size()
	tries := 1
	if first {
		tries = 10
	}
	var err error
	for i := range tries {
		rctx, cancel := context.WithTimeout(ctx, dockerTimeout)
		err = s.m.opts.Docker.ResizeExec(rctx, execID, rows, cols)
		cancel()
		if err == nil || ctx.Err() != nil {
			break
		}
		if i < tries-1 && !sleep(ctx, 20*time.Millisecond) {
			break
		}
	}
	if err != nil && ctx.Err() == nil {
		s.m.log.Warn("resize shell terminal", "session_id", s.id, "err", err)
	}
}

// pumpInput writes queued input batches to the process in seq order until
// stop is closed or the stream fails.
func (s *session) pumpInput(w io.Writer, stop <-chan struct{}, done chan<- struct{}) {
	defer close(done)
	var next int64
	for {
		select {
		case <-stop:
			return
		case <-s.inputSig:
		}
		s.mu.Lock()
		batch := s.inputs
		s.inputs = nil
		s.mu.Unlock()
		for _, f := range batch {
			if f.Seq < next {
				continue
			}
			if f.Seq > next {
				s.requestEnd(errExit("%s", MessageOutOfOrder))
				return
			}
			data, err := protocol.OpenExecInput(s.m.opts.Key, s.m.opts.NodeID, f)
			if err != nil {
				// SECURITY: the error names the session and seq, never data.
				s.m.log.Warn("open shell input", "session_id", s.id, "seq", f.Seq, "err", err)
				s.requestEnd(errExit("input could not be opened"))
				return
			}
			next++
			if _, err := w.Write(data); err != nil {
				return
			}
			signal(s.activity)
		}
	}
}

// exitCode waits for a process whose terminal closed to finish, and returns
// its exit.
func (s *session) exitCode(ctx context.Context, containerID, execID string) exitInfo {
	ictx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.m.opts.exitSettle+dockerTimeout)
	defer cancel()
	settle := time.Now().Add(s.m.opts.exitSettle)
	for {
		info, err := s.m.opts.Docker.InspectExec(ictx, execID)
		if err != nil {
			return errExit("inspect exec: %v", err)
		}
		if !info.Running {
			// NOTE: exec_exit carries -1..255; the engine reports a status
			// outside it only for a process it could not start.
			code := min(max(info.ExitCode, -1), 255)
			return exitInfo{reason: protocol.ExecExitExited, code: &code}
		}
		if time.Now().After(settle) {
			s.stop(ctx, containerID, execID)
			return errExit("the terminal closed but the process kept running")
		}
		if !sleep(ictx, 20*time.Millisecond) {
			return errExit("inspect exec: %v", ictx.Err())
		}
	}
}

// stop ends a process that may still run: SIGHUP, then SIGKILL after the
// kill grace.
//
// NOTE: signals reach the process only where the agent shares the host's
// PID namespace ([docker.Client.SignalExec]), as the systemd install does.
// Elsewhere only the stream is closed, which does not end the process: the
// engine keeps a TTY exec's terminal open after its client goes.
func (s *session) stop(ctx context.Context, containerID, execID string) {
	sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.m.opts.killGrace+dockerTimeout)
	defer cancel()
	d := s.m.opts.Docker
	sent, err := d.SignalExec(sctx, containerID, execID, syscall.SIGHUP)
	if err != nil {
		s.m.log.Warn("hang up shell process", "session_id", s.id, "err", err)
	}
	if !sent {
		// NOTE: the engine never closes a TTY exec's stdin when its client
		// goes, so a process the agent cannot signal outlives the session.
		if err == nil {
			if info, ierr := d.InspectExec(sctx, execID); ierr == nil && info.Running {
				s.m.log.Warn("shell process could not be signalled and runs on until it exits; run the agent in the host's PID namespace",
					"session_id", s.id, "workload_id", s.workloadID)
			}
		}
		return
	}
	grace := time.Now().Add(s.m.opts.killGrace)
	for time.Now().Before(grace) {
		info, err := d.InspectExec(sctx, execID)
		if err == nil && !info.Running {
			return
		}
		if !sleep(sctx, 50*time.Millisecond) {
			break
		}
	}
	if _, err := d.SignalExec(sctx, containerID, execID, syscall.SIGKILL); err != nil {
		s.m.log.Warn("kill shell process", "session_id", s.id, "err", err)
	}
}

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
