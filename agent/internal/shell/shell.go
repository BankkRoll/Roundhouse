// Package shell runs the web shell's interactive sessions on the agent (ADR
// 0012 "Web shell", bound by ADR 0014 §15, wire contract ADR 0016).
//
// Responsibilities:
//   - admit exec_open only into this node's own service workload containers:
//     a desired, running, unheld service workload whose container carries
//     this node's namespace and the frame's workload ID, re-checked against
//     the engine right before the exec, never a system, job or privileged
//     container;
//   - run the frame's argv verbatim with a TTY as the container's configured
//     user, and report that user in exec_opened;
//   - open each sealed exec_input batch with the node's key and apply them in
//     seq order: duplicates are dropped, a gap ends the session;
//   - coalesce terminal output into exec_output frames every 20 ms, at most
//     32 KiB and 64 frames per second each, without dropping bytes while the
//     connection lasts;
//   - enforce idle_timeout_s and max_duration_s, at most
//     [protocol.MaxExecSessionsPerNode] sessions, and one session ID once;
//   - end a session on exec_close, timeout, process exit, a lost control
//     connection or agent shutdown: SIGHUP, SIGKILL 5 s later, and exactly
//     one exec_exit.
//
// SECURITY: terminal input and output are never logged, at any level, nor
// put into an error; logs carry session and workload IDs, reasons and
// durations only.
//
// [Manager] implements conn.ExecHandler.
package shell

import (
	"cmp"
	"context"
	"crypto/ecdh"
	"errors"
	"log/slog"
	"sync"
	"syscall"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/conn"
	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// Exit messages the control plane may show.
const (
	// MessageBusy refuses a session beyond [protocol.MaxExecSessionsPerNode].
	MessageBusy = "the node is busy: it already runs the most shell sessions it allows"
	// MessageDuplicate refuses an exec_open whose session ID is in use or
	// was used.
	MessageDuplicate = "the session ID is already in use"
	// MessageDisconnected ends sessions when the control connection drops.
	MessageDisconnected = "the control connection ended"
	// MessageShutdown ends sessions when the agent stops.
	MessageShutdown = "the agent is shutting down"
	// MessageOutOfOrder ends a session whose input skipped a seq.
	MessageOutOfOrder = "input out of order"
)

const (
	// killGrace is how long a process has between SIGHUP and SIGKILL.
	killGrace = 5 * time.Second
	// flushInterval is how often output is coalesced into a frame.
	flushInterval = 20 * time.Millisecond
	// exitSettle bounds how long a process may keep reporting Running after
	// its terminal output ended.
	exitSettle = 10 * time.Second
	// sendTimeout bounds one frame's send.
	sendTimeout = 10 * time.Second
	// dockerTimeout bounds one engine call made while a session opens or
	// ends.
	dockerTimeout = 30 * time.Second
	// maxQueuedInputs bounds the input batches waiting to be written; the
	// relay sends one per 20 ms, so a backlog this deep means the process
	// stopped reading.
	maxQueuedInputs = 256
	// maxPendingOutput bounds the output held back by the frame budget;
	// beyond it the terminal is not read, which stalls the process rather
	// than dropping its output.
	maxPendingOutput = 1 << 20
	// recentIDs bounds the ended session IDs remembered, so a session ID is
	// never opened twice.
	recentIDs = 256
)

// Docker is the subset of the engine API sessions use; *docker.Client
// implements it.
type Docker interface {
	InspectContainer(ctx context.Context, id string) (docker.ContainerInfo, error)
	CreateExec(ctx context.Context, containerID string, cfg docker.ExecConfig) (string, error)
	StartExecTTY(ctx context.Context, execID string) (*docker.ExecStream, error)
	ResizeExec(ctx context.Context, execID string, rows, cols int) error
	InspectExec(ctx context.Context, id string) (docker.ExecInfo, error)
	SignalExec(ctx context.Context, containerID, execID string, sig syscall.Signal) (bool, error)
}

// Workloads finds shell targets; *runtime.Runtime implements it.
type Workloads interface {
	// ShellContainer returns the container a shell may exec into for the
	// workload, or why there is none.
	ShellContainer(workloadID string) (string, error)
}

// Options configures a [Manager].
type Options struct {
	Docker    Docker
	Workloads Workloads
	// NodeID binds sealed input to this node.
	NodeID string
	// Key is the node's X25519 key, which opens sealed input.
	Key *ecdh.PrivateKey
	// Namespace is the roundhouse.namespace label of this node's containers
	// (the node ID). Empty refuses every session.
	Namespace string
	// Refusal, when set, refuses every session with this message
	// ([conn.PlaintextRefusal]).
	//
	// SECURITY: terminal output is not sealed, so a shell over plaintext
	// ws:// would put whatever it prints on the wire in the clear.
	Refusal string
	// Send delivers an agent frame; it fails when the connection is down.
	Send   func(ctx context.Context, m protocol.AgentMessage) error
	Logger *slog.Logger

	// Test hooks. unit is what one second of idle_timeout_s and
	// max_duration_s lasts; killGrace, flushInterval and exitSettle replace
	// the constants of the same name.
	unit, killGrace, flushInterval, exitSettle time.Duration
}

// Manager runs the node's web shell sessions. Create it with [New], feed it
// the exec frames through its conn.ExecHandler methods, and run it with
// [Manager.Run]; every session ends before Run returns.
type Manager struct {
	opts Options
	log  *slog.Logger
	// ctx ends when Run's context does, ending every session.
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu       sync.Mutex
	sessions map[string]*session
	// ended remembers recent session IDs, oldest first.
	ended   []string
	endedOf map[string]bool
	closed  bool
}

// New returns a manager. Sessions may open before [Manager.Run] is called.
func New(opts Options) *Manager {
	opts.unit = cmp.Or(opts.unit, time.Second)
	opts.killGrace = cmp.Or(opts.killGrace, killGrace)
	opts.flushInterval = cmp.Or(opts.flushInterval, flushInterval)
	opts.exitSettle = cmp.Or(opts.exitSettle, exitSettle)
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{
		opts: opts, log: log, ctx: ctx, cancel: cancel,
		sessions: map[string]*session{}, endedOf: map[string]bool{},
	}
}

// Run waits for ctx to end, then ends every session and returns once each
// has sent its exec_exit (or failed to).
func (m *Manager) Run(ctx context.Context) error {
	<-ctx.Done()
	m.mu.Lock()
	m.closed = true
	m.mu.Unlock()
	m.cancel()
	m.wg.Wait()
	return nil
}

// OpenExec starts a session, or answers exec_exit when it is refused.
func (m *Manager) OpenExec(f *protocol.ExecOpen) {
	m.mu.Lock()
	var refusal string
	switch {
	case m.closed:
		refusal = MessageShutdown
	case m.opts.Refusal != "":
		refusal = m.opts.Refusal
	case m.sessions[f.SessionID] != nil || m.endedOf[f.SessionID]:
		refusal = MessageDuplicate
	case len(m.sessions) >= protocol.MaxExecSessionsPerNode:
		refusal = MessageBusy
	}
	if refusal != "" {
		closed := m.closed
		if !closed {
			m.wg.Add(1)
		}
		m.mu.Unlock()
		m.log.Warn("refused shell session", "session_id", f.SessionID, "workload_id", f.WorkloadID, "reason", refusal)
		go func() {
			if !closed {
				defer m.wg.Done()
			}
			m.sendExit(f.SessionID, exitInfo{reason: protocol.ExecExitError, message: refusal})
		}()
		return
	}
	s := newSession(m, f)
	m.sessions[f.SessionID] = s
	// NOTE: the WaitGroup is added to under mu, so Run, which sets closed
	// under mu before it waits, never races an Add.
	m.wg.Go(s.run)
	m.mu.Unlock()
}

// ExecInput queues an input batch for its session; batches for unknown
// sessions are dropped.
func (m *Manager) ExecInput(f *protocol.ExecInput) {
	if s := m.session(f.SessionID); s != nil {
		s.queueInput(f)
	}
}

// ResizeExec resizes a session's terminal.
func (m *Manager) ResizeExec(f *protocol.ExecResize) {
	if s := m.session(f.SessionID); s != nil {
		s.resize(f.Rows, f.Cols)
	}
}

// CloseExec ends a session with reason closed.
func (m *Manager) CloseExec(f *protocol.ExecClose) {
	if s := m.session(f.SessionID); s != nil {
		s.requestEnd(exitInfo{reason: protocol.ExecExitClosed})
	}
}

// Disconnected ends every session: none can outlive the only connection
// that relays it.
func (m *Manager) Disconnected() {
	m.mu.Lock()
	all := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.mu.Unlock()
	for _, s := range all {
		s.requestEnd(exitInfo{reason: protocol.ExecExitError, message: MessageDisconnected})
	}
}

func (m *Manager) session(id string) *session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

// remove forgets an ended session and remembers its ID.
func (m *Manager) remove(s *session) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, s.id)
	m.ended = append(m.ended, s.id)
	m.endedOf[s.id] = true
	if len(m.ended) > recentIDs {
		delete(m.endedOf, m.ended[0])
		m.ended = m.ended[1:]
	}
}

// exitInfo is how a session ended.
type exitInfo struct {
	reason  protocol.ExecExitReason
	code    *int
	message string
}

func (m *Manager) sendExit(sessionID string, e exitInfo) {
	m.send(&protocol.ExecExit{
		Type: protocol.TypeExecExit, SessionID: sessionID,
		ExitCode: e.code, Reason: e.reason, Message: truncate(e.message, protocol.MaxMessageBytes),
	}, sessionID)
}

// send delivers a frame. A frame that cannot be delivered is dropped: the
// relay that would take it is gone, and its sessions end with it.
func (m *Manager) send(msg protocol.AgentMessage, sessionID string) bool {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(m.ctx), sendTimeout)
	defer cancel()
	err := m.opts.Send(ctx, msg)
	if err != nil && !errors.Is(err, conn.ErrNotConnected) {
		m.log.Warn("send shell frame", "session_id", sessionID, "err", err)
	}
	return err == nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
