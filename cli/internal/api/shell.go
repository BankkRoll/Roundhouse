package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"

	"github.com/coder/websocket"

	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// Web shell routes (ADR 0012 "Web shell").
var (
	RouteShellTargets = Route{http.MethodGet, "/v1/services/{serviceId}/shell-targets"}
	// RouteShell is a WebSocket; see [Client.DialShell].
	RouteShell = Route{http.MethodGet, "/v1/workloads/{workloadId}/shell"}
)

// Close codes of the shell socket, from SHELL_CLOSE_CODES in
// packages/shared/src/shell.ts. 4401, 4403, 4404, 1008 and 1009 are the
// realtime socket's ([CloseUnauthorized] and the rest).
const (
	// ShellCloseNormal: the session ended after an `exit` message.
	ShellCloseNormal = int(websocket.StatusNormalClosure)
	// ShellCloseBusy: the node runs its maximum number of sessions.
	ShellCloseBusy = 4409
	// ShellCloseAgentOutdated: the node's agent predates the shell protocol.
	ShellCloseAgentOutdated = 4426
	// ShellCloseReauthRequired: the session must re-authenticate first.
	ShellCloseReauthRequired = 4428
	// ShellCloseTwoFactorRequired: two-factor authentication must be on.
	ShellCloseTwoFactorRequired = 4430
	// ShellCloseProtectedEnvironment: an API token in a protected environment.
	ShellCloseProtectedEnvironment = 4431
	// ShellCloseNodeUnavailable: the node's agent is not connected.
	ShellCloseNodeUnavailable = 4503
)

// Shell gate denials, from SHELL_DENIALS in packages/shared/src/shell.ts.
const (
	ShellDenialOAuthToken           = "oauth_token"
	ShellDenialForbidden            = "forbidden"
	ShellDenialTwoFactorRequired    = "two_factor_required"
	ShellDenialReauthRequired       = "reauth_required"
	ShellDenialProtectedEnvironment = "protected_environment"
)

// MaxShellInputFrame is the most stdin the CLI puts in one frame; the relay
// batches input the same way (SHELL_MAX_CLIENT_FRAME_BYTES allows more).
const MaxShellInputFrame = 16 << 10

// maxShellFrame bounds one server frame. Agent output frames are at most
// 32 KiB; the relay may coalesce a few.
const maxShellFrame = 1 << 20

// ShellTarget is one replica a shell can open in.
type ShellTarget struct {
	WorkloadID   string `json:"workload_id"`
	DeploymentID string `json:"deployment_id"`
	Replica      int    `json:"replica"`
	NodeID       string `json:"node_id"`
	NodeName     string `json:"node_name"`
	// State is the workload's last reported state, e.g. "healthy".
	State string `json:"state"`
	// ShellSupported is false when the node's agent predates the shell.
	ShellSupported bool `json:"shell_supported"`
}

// ShellGate says whether the caller may open a shell in the environment.
type ShellGate struct {
	Allowed bool `json:"allowed"`
	// Reason is one of the ShellDenial constants when Allowed is false.
	Reason *string `json:"reason"`
}

// ShellTargets is the response of GET /v1/services/{serviceId}/shell-targets.
type ShellTargets struct {
	Targets []ShellTarget `json:"targets"`
	Gate    ShellGate     `json:"gate"`
}

// ShellTargets lists the replicas of a service a shell can open in, and
// whether the caller may open one.
func (c *Client) ShellTargets(ctx context.Context, serviceID, environmentID string) (*ShellTargets, error) {
	return fetch[ShellTargets](ctx, c, RouteShellTargets, envQuery(environmentID), nil, serviceID)
}

// ShellOptions configures [Client.DialShell].
type ShellOptions struct {
	// Cols and Rows are the terminal size; 0 leaves them to the server.
	Cols, Rows int
	// Term is the TERM the process gets; empty leaves it to the server.
	Term string
	// Command is the argv to run, passed verbatim; empty runs a login shell.
	Command []string
}

// ShellMessage is a JSON control message from the relay. Type selects the
// fields: "opened" (SessionID through Recorded) or "exit" (Code,
// Reason, Message).
type ShellMessage struct {
	Type         string  `json:"type"`
	SessionID    string  `json:"session_id,omitempty"`
	NodeID       string  `json:"node_id,omitempty"`
	NodeName     string  `json:"node_name,omitempty"`
	User         string  `json:"user,omitempty"`
	Replica      int     `json:"replica,omitempty"`
	IdleTimeoutS int     `json:"idle_timeout_s,omitempty"`
	MaxDurationS int     `json:"max_duration_s,omitempty"`
	Recorded     bool    `json:"recorded,omitempty"`
	Code         *int    `json:"code,omitempty"`
	Reason       string  `json:"reason,omitempty"`
	Message      *string `json:"message,omitempty"`
}

// ShellFrame is one frame from the relay: terminal output, or a control
// message.
type ShellFrame struct {
	Output  []byte
	Message *ShellMessage
}

// Shell is an open shell socket. Writes may happen concurrently with a
// [Shell.Read] loop.
type Shell struct {
	conn *websocket.Conn
}

// ShellClosedError is a shell socket closed by the control plane with a
// close code other than 1000.
type ShellClosedError struct {
	Code   int
	Reason string
}

// Error names the close code and the server's reason.
func (e *ShellClosedError) Error() string {
	var what string
	switch e.Code {
	case CloseUnauthorized:
		what = "not signed in, or the session or token expired"
	case CloseForbidden:
		what = "not allowed to open a shell here, or access was revoked"
	case CloseNotFound:
		what = "the replica is not running or does not exist"
	case ShellCloseBusy:
		what = "the server runs its maximum number of shell sessions"
	case ShellCloseAgentOutdated:
		what = "the server's agent is too old for shells"
	case ShellCloseReauthRequired:
		what = "a recent sign-in is required"
	case ShellCloseTwoFactorRequired:
		what = "two-factor authentication is required"
	case ShellCloseProtectedEnvironment:
		what = "API tokens can't open shells in a protected environment"
	case ShellCloseNodeUnavailable:
		what = "the server's agent is not connected"
	case ClosePolicy, CloseTooBig:
		what = "protocol error"
	default:
		what = "closed"
	}
	if e.Reason != "" && e.Reason != what {
		return fmt.Sprintf("shell closed (%d, %s): %s", e.Code, what, e.Reason)
	}
	return fmt.Sprintf("shell closed (%d, %s)", e.Code, what)
}

// ExitCode maps the close code to the exit code of the matching condition.
func (e *ShellClosedError) ExitCode() int {
	switch e.Code {
	case CloseUnauthorized, ShellCloseReauthRequired:
		return exitcode.Unauthenticated
	case CloseForbidden, ShellCloseTwoFactorRequired, ShellCloseProtectedEnvironment:
		return exitcode.Forbidden
	case CloseNotFound:
		return exitcode.NotFound
	case ShellCloseBusy:
		return exitcode.Conflict
	case ShellCloseAgentOutdated:
		return exitcode.Unavailable
	case ClosePolicy, CloseTooBig:
		return exitcode.Error
	}
	return exitcode.Network
}

// DialShell opens a shell in a workload. Refusals arrive after the upgrade
// as close codes, surfacing from [Shell.Read] as a [*ShellClosedError].
//
// SECURITY: the session cookie is sent with the control plane's own Origin,
// which the API requires of cookie-authenticated upgrades; a bearer token
// is sent without one.
func (c *Client) DialShell(ctx context.Context, workloadID string, o ShellOptions) (*Shell, error) {
	q := url.Values{}
	if o.Cols > 0 && o.Rows > 0 {
		q.Set("cols", strconv.Itoa(o.Cols))
		q.Set("rows", strconv.Itoa(o.Rows))
	}
	if o.Term != "" {
		q.Set("term", o.Term)
	}
	if len(o.Command) > 0 {
		q["cmd"] = append([]string(nil), o.Command...)
	}
	conn, err := c.dialSocket(ctx, RouteShell.expand(workloadID), q, false)
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(maxShellFrame)
	return &Shell{conn: conn}, nil
}

// Read blocks until the next frame. A normal close returns
// [ErrShellEnded]; any other close is a [*ShellClosedError].
func (s *Shell) Read(ctx context.Context) (ShellFrame, error) {
	typ, data, err := s.conn.Read(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return ShellFrame{}, ctx.Err()
		}
		var ce websocket.CloseError
		if errors.As(err, &ce) {
			if int(ce.Code) == ShellCloseNormal {
				return ShellFrame{}, ErrShellEnded
			}
			return ShellFrame{}, &ShellClosedError{Code: int(ce.Code), Reason: ce.Reason}
		}
		return ShellFrame{}, &NetworkError{URL: "the shell socket", Err: err}
	}
	if typ == websocket.MessageBinary {
		return ShellFrame{Output: data}, nil
	}
	var msg ShellMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return ShellFrame{}, fmt.Errorf("shell socket sent invalid JSON: %w", err)
	}
	return ShellFrame{Message: &msg}, nil
}

// ErrShellEnded is returned by [Shell.Read] once the relay closed the
// socket normally.
var ErrShellEnded = errors.New("shell ended")

// Input sends stdin bytes as one binary frame.
func (s *Shell) Input(ctx context.Context, p []byte) error {
	return s.conn.Write(ctx, websocket.MessageBinary, p)
}

// Resize tells the process the terminal's new size.
func (s *Shell) Resize(ctx context.Context, cols, rows int) error {
	return s.send(ctx, map[string]any{"type": "resize", "cols": cols, "rows": rows})
}

// End asks the relay to end the session; it answers with an `exit` message.
func (s *Shell) End(ctx context.Context) error {
	return s.send(ctx, map[string]string{"type": "close"})
}

func (s *Shell) send(ctx context.Context, msg any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return s.conn.Write(ctx, websocket.MessageText, data)
}

// Close closes the socket normally.
func (s *Shell) Close() error {
	return s.conn.Close(websocket.StatusNormalClosure, "")
}

// CloseNow closes the socket without waiting for the relay.
func (s *Shell) CloseNow() error {
	return s.conn.CloseNow()
}
