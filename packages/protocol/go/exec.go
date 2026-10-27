package protocol

import (
	"crypto/ecdh"
	"encoding/base64"
	"errors"
	"fmt"
	"slices"
	"strings"
)

// Web shell limits (ADR 0012, ADR 0014 §15), mirroring limits.ts.
const (
	// MaxExecArgs is the most argv entries in [ExecOpen].Command.
	MaxExecArgs = 32
	// MaxExecCommandBytes bounds every [ExecOpen].Command entry combined.
	MaxExecCommandBytes = 4096
	// MaxExecEnvVars is the most variables [ExecOpen].Env sets.
	MaxExecEnvVars = 8
	// MaxExecEnvValueBytes is the longest [ExecOpen].Env value.
	MaxExecEnvValueBytes = 256
	// MaxExecInputBytes is the most raw bytes one [ExecInput] carries.
	MaxExecInputBytes = 16 * 1024
	// MaxExecOutputBytes is the most raw bytes one [ExecOutput] carries.
	MaxExecOutputBytes = 32 * 1024
	// MaxExecCols is the widest terminal.
	MaxExecCols = 1000
	// MaxExecRows is the tallest terminal.
	MaxExecRows = 500
	// MinExecIdleTimeoutS is the shortest idle timeout a session may ask for.
	MinExecIdleTimeoutS = 10
	// MaxExecIdleTimeoutS is the longest idle timeout a session may ask for.
	MaxExecIdleTimeoutS = 28_800
	// MinExecMaxDurationS is the shortest total duration a session may ask for.
	MinExecMaxDurationS = 60
	// MaxExecMaxDurationS is the longest total duration (8 hours).
	MaxExecMaxDurationS = 28_800
	// MaxExecSessionsPerNode is the most sessions one node runs at once.
	MaxExecSessionsPerNode = 4
	// MaxExecOutputFramesPerSecond is the most [ExecOutput] frames one
	// session sends per second.
	MaxExecOutputFramesPerSecond = 64
)

// ExecProtocolVersion gates the web shell frames (ADR 0012). Mirrors
// EXEC_PROTOCOL_VERSION.
const ExecProtocolVersion = 7

// Web shell frame types.
const (
	TypeExecOpen   = "exec_open"
	TypeExecInput  = "exec_input"
	TypeExecResize = "exec_resize"
	TypeExecClose  = "exec_close"
	TypeExecOpened = "exec_opened"
	TypeExecOutput = "exec_output"
	TypeExecExit   = "exec_exit"
)

// DefaultExecCommand is what a session runs when the caller names nothing:
// a login bash when the image has one, else a login sh. Mirrors
// DEFAULT_EXEC_COMMAND; it is a constant, so no caller text ever reaches a
// shell's parser.
var DefaultExecCommand = []string{"/bin/sh", "-c", "command -v bash >/dev/null && exec bash -l || exec sh -l"}

// ExecEnvKeys are the only variables [ExecOpen].Env may set: terminal
// settings, never anything that changes how programs load. Mirrors
// EXEC_ENV_KEYS.
var ExecEnvKeys = []string{"TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE"}

// ValidExecCommand reports whether argv is within the exec limits: 1 to
// [MaxExecArgs] entries, a non-empty program, no NUL bytes, at most
// [MaxExecCommandBytes] in total. Mirrors isValidExecCommand.
func ValidExecCommand(argv []string) bool {
	if len(argv) < 1 || len(argv) > MaxExecArgs || argv[0] == "" {
		return false
	}
	total := 0
	for _, a := range argv {
		if strings.IndexByte(a, 0) >= 0 {
			return false
		}
		total += len(a)
	}
	return total <= MaxExecCommandBytes
}

func validTerminal(cols, rows int) bool {
	return cols >= 1 && cols <= MaxExecCols && rows >= 1 && rows <= MaxExecRows
}

// ExecOpen starts one interactive process in a workload's container. There
// is no user field: the process always runs as the container's configured
// user (ADR 0014 §15). Type must be [TypeExecOpen].
type ExecOpen struct {
	Type string `json:"type"`
	ControlHeader
	SessionID  string            `json:"session_id"`
	WorkloadID string            `json:"workload_id"`
	Command    []string          `json:"command"`
	TTY        bool              `json:"tty"`
	Cols       int               `json:"cols"`
	Rows       int               `json:"rows"`
	Env        map[string]string `json:"env"`
	// IdleTimeoutS closes the session after this long without input.
	IdleTimeoutS int `json:"idle_timeout_s"`
	// MaxDurationS closes the session this long after it opened.
	MaxDurationS int `json:"max_duration_s"`
}

func (*ExecOpen) controlMessage() {}

// Validate implements [Validator].
func (m *ExecOpen) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if !idRE.MatchString(m.SessionID) || !idRE.MatchString(m.WorkloadID) {
		return errors.New("session_id or workload_id: invalid")
	}
	if !ValidExecCommand(m.Command) {
		return fmt.Errorf("command: must be 1 to %d arguments of at most %d bytes in total, without NUL", MaxExecArgs, MaxExecCommandBytes)
	}
	if !m.TTY {
		return errors.New("tty: must be true")
	}
	if !validTerminal(m.Cols, m.Rows) {
		return errors.New("cols or rows: out of range")
	}
	if m.Env == nil {
		return errors.New("env: required")
	}
	if len(m.Env) > MaxExecEnvVars {
		return fmt.Errorf("env: at most %d variables", MaxExecEnvVars)
	}
	for k, v := range m.Env {
		if !slices.Contains(ExecEnvKeys, k) {
			return fmt.Errorf("env: %q is not a terminal setting", k)
		}
		if len(v) > MaxExecEnvValueBytes {
			return fmt.Errorf("env %s: longer than %d bytes", k, MaxExecEnvValueBytes)
		}
	}
	if m.IdleTimeoutS < MinExecIdleTimeoutS || m.IdleTimeoutS > MaxExecIdleTimeoutS ||
		m.MaxDurationS < MinExecMaxDurationS || m.MaxDurationS > MaxExecMaxDurationS {
		return errors.New("idle_timeout_s or max_duration_s: out of range")
	}
	return validateShortLived(m)
}

// ExecInput is one batch of terminal input, sealed to the node. Batches
// apply in Seq order. Type must be [TypeExecInput].
type ExecInput struct {
	Type string `json:"type"`
	ControlHeader
	SessionID string `json:"session_id"`
	Seq       int64  `json:"seq"`
	// DataSealed opens with [OpenExecInput].
	DataSealed SealedBox `json:"data_sealed"`
}

func (*ExecInput) controlMessage() {}

// Validate implements [Validator].
func (m *ExecInput) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if !idRE.MatchString(m.SessionID) || m.Seq < 0 {
		return errors.New("session_id or seq: invalid")
	}
	if err := m.DataSealed.validate(); err != nil {
		return fmt.Errorf("data_sealed: %w", err)
	}
	return validateShortLived(m)
}

// ExecResize resizes a session's terminal. Type must be [TypeExecResize].
type ExecResize struct {
	Type string `json:"type"`
	ControlHeader
	SessionID string `json:"session_id"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
}

func (*ExecResize) controlMessage() {}

// Validate implements [Validator].
func (m *ExecResize) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if !idRE.MatchString(m.SessionID) || !validTerminal(m.Cols, m.Rows) {
		return errors.New("session_id, cols or rows: invalid")
	}
	return validateShortLived(m)
}

// ExecCloseReason says why the control plane ends a session.
type ExecCloseReason string

// Close reasons, mirroring EXEC_CLOSE_REASONS.
const (
	ExecCloseUser        ExecCloseReason = "user"
	ExecCloseIdle        ExecCloseReason = "idle"
	ExecCloseRevoked     ExecCloseReason = "revoked"
	ExecCloseShutdown    ExecCloseReason = "shutdown"
	ExecCloseMaxDuration ExecCloseReason = "max_duration"
)

// ExecClose ends a session; the agent answers with an [ExecExit] of reason
// [ExecExitClosed]. Type must be [TypeExecClose].
type ExecClose struct {
	Type string `json:"type"`
	ControlHeader
	SessionID string          `json:"session_id"`
	Reason    ExecCloseReason `json:"reason"`
}

func (*ExecClose) controlMessage() {}

// Validate implements [Validator].
func (m *ExecClose) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if !idRE.MatchString(m.SessionID) {
		return errors.New("session_id: invalid")
	}
	switch m.Reason {
	case ExecCloseUser, ExecCloseIdle, ExecCloseRevoked, ExecCloseShutdown, ExecCloseMaxDuration:
	default:
		return fmt.Errorf("reason: invalid %q", m.Reason)
	}
	return validateShortLived(m)
}

// ExecOpened says the process started. Type must be [TypeExecOpened].
type ExecOpened struct {
	Type      string `json:"type"`
	SessionID string `json:"session_id"`
	// User is the user the process runs as: the container's configured
	// user, "root" when the image sets none.
	User string `json:"user"`
}

func (*ExecOpened) agentMessage() {}

// Validate implements [Validator].
func (m *ExecOpened) Validate() error {
	if !idRE.MatchString(m.SessionID) || m.User == "" || len(m.User) > 256 {
		return errors.New("session_id or user: invalid")
	}
	return nil
}

// ExecOutput carries terminal output, coalesced every 20 ms; Seq rises by
// one per frame from 0. Type must be [TypeExecOutput].
type ExecOutput struct {
	Type      string `json:"type"`
	SessionID string `json:"session_id"`
	Seq       int64  `json:"seq"`
	// Data is standard base64 of at most [MaxExecOutputBytes] bytes.
	Data string `json:"data"`
}

func (*ExecOutput) agentMessage() {}

// Validate implements [Validator].
func (m *ExecOutput) Validate() error {
	if !idRE.MatchString(m.SessionID) || m.Seq < 0 {
		return errors.New("session_id or seq: invalid")
	}
	if !validBase64(m.Data, MaxExecOutputBytes) {
		return fmt.Errorf("data: expected base64 of 1 to %d bytes", MaxExecOutputBytes)
	}
	return nil
}

// ExecExitReason says why a session ended on the agent.
type ExecExitReason string

// Exit reasons, mirroring EXEC_EXIT_REASONS.
const (
	ExecExitExited      ExecExitReason = "exited"
	ExecExitClosed      ExecExitReason = "closed"
	ExecExitIdleTimeout ExecExitReason = "idle_timeout"
	ExecExitMaxDuration ExecExitReason = "max_duration"
	ExecExitError       ExecExitReason = "error"
)

// ExecExit says a session ended; sent once per session. Type must be
// [TypeExecExit].
type ExecExit struct {
	Type      string `json:"type"`
	SessionID string `json:"session_id"`
	// ExitCode is the process's exit code when it exited and is known.
	ExitCode *int           `json:"exit_code"`
	Reason   ExecExitReason `json:"reason"`
	Message  string         `json:"message,omitempty"`
}

func (*ExecExit) agentMessage() {}

// Validate implements [Validator].
func (m *ExecExit) Validate() error {
	if !idRE.MatchString(m.SessionID) {
		return errors.New("session_id: invalid")
	}
	switch m.Reason {
	case ExecExitExited, ExecExitClosed, ExecExitIdleTimeout, ExecExitMaxDuration, ExecExitError:
	default:
		return fmt.Errorf("reason: invalid %q", m.Reason)
	}
	if m.ExitCode != nil && (*m.ExitCode < -1 || *m.ExitCode > 255) {
		return errors.New("exit_code: out of range")
	}
	if m.Reason == ExecExitExited && m.ExitCode == nil {
		return errors.New("exit_code: an exited session has an exit code")
	}
	if len(m.Message) > MaxMessageBytes {
		return errors.New("message: too long")
	}
	return nil
}

// ExecInputAAD binds a sealed input batch to its node, session and position.
func ExecInputAAD(nodeID, sessionID string, seq int64) string {
	return fmt.Sprintf("%s:%s:%s:%d", BoxInfo(BoxPurposeExecInput), nodeID, sessionID, seq)
}

// SealedExecInput is the plaintext of [ExecInput].DataSealed.
type SealedExecInput struct {
	Data string `json:"data"`
}

// OpenExecInput opens an input batch and returns its raw bytes.
func OpenExecInput(priv *ecdh.PrivateKey, nodeID string, m *ExecInput) ([]byte, error) {
	var s SealedExecInput
	if err := openStrict(priv, &m.DataSealed, BoxPurposeExecInput, ExecInputAAD(nodeID, m.SessionID, m.Seq), &s); err != nil {
		return nil, fmt.Errorf("exec input %s/%d: %w", m.SessionID, m.Seq, err)
	}
	if !validBase64(s.Data, MaxExecInputBytes) {
		return nil, fmt.Errorf("exec input %s/%d: invalid data", m.SessionID, m.Seq)
	}
	return base64.StdEncoding.DecodeString(s.Data)
}

// validBase64 reports whether s is standard padded base64 of 1 to max bytes.
func validBase64(s string, max int) bool {
	if s == "" || len(s)%4 != 0 || len(s) > (max+2)/3*4 || !base64RE.MatchString(s) {
		return false
	}
	n, err := base64.StdEncoding.DecodeString(s)
	return err == nil && len(n) <= max
}
