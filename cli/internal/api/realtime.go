package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"

	"github.com/coder/websocket"

	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// maxRealtimeFrame bounds one server frame. The project room coalesces log
// batches, each at most 64 KiB of line text, so a few MiB is ample.
const maxRealtimeFrame = 4 << 20

// Close codes the realtime socket ends with, from REALTIME_CLOSE_CODES in
// packages/shared/src/realtime.ts.
const (
	// CloseUnauthorized: the session or token is missing, invalid or expired.
	CloseUnauthorized = 4401
	// CloseForbidden: the caller lost access to the project.
	CloseForbidden = 4403
	// CloseNotFound: the project does not exist.
	CloseNotFound = 4404
	// ClosePolicy: the client sent a malformed or unsupported frame.
	ClosePolicy = int(websocket.StatusPolicyViolation)
	// CloseTooBig: the client sent a frame over the size limit.
	CloseTooBig = int(websocket.StatusMessageTooBig)
)

// RealtimeClosedError is a realtime socket closed by the control plane with
// a close frame.
type RealtimeClosedError struct {
	Code   int
	Reason string
}

// Error names the close code and the server's reason.
func (e *RealtimeClosedError) Error() string {
	var what string
	switch e.Code {
	case CloseUnauthorized:
		what = "not signed in, or the session or token expired"
	case CloseForbidden:
		what = "access to the project was lost"
	case CloseNotFound:
		what = "project not found"
	case ClosePolicy, CloseTooBig:
		what = "protocol error"
	default:
		what = "closed"
	}
	if e.Reason != "" {
		return fmt.Sprintf("realtime socket closed (%d, %s): %s", e.Code, what, e.Reason)
	}
	return fmt.Sprintf("realtime socket closed (%d, %s)", e.Code, what)
}

// Retryable mirrors shouldReconnect in packages/shared/src/realtime.ts:
// false for the codes that would keep failing on every reconnect.
func (e *RealtimeClosedError) Retryable() bool {
	switch e.Code {
	case CloseUnauthorized, CloseForbidden, CloseNotFound, ClosePolicy, CloseTooBig:
		return false
	}
	return true
}

// ExitCode maps the close code to the exit code of the matching HTTP status.
func (e *RealtimeClosedError) ExitCode() int {
	switch e.Code {
	case CloseUnauthorized:
		return exitcode.Unauthenticated
	case CloseForbidden:
		return exitcode.Forbidden
	case CloseNotFound:
		return exitcode.NotFound
	case ClosePolicy, CloseTooBig:
		return exitcode.Error
	}
	return exitcode.Network
}

// RealtimeTopic is a log stream to subscribe to. Exactly one ID is set.
type RealtimeTopic struct {
	DeploymentID string
	BuildID      string
}

func (t RealtimeTopic) wire() map[string]string {
	if t.BuildID != "" {
		return map[string]string{"kind": "build_logs", "build_id": t.BuildID}
	}
	return map[string]string{"kind": "deployment_logs", "deployment_id": t.DeploymentID}
}

// RealtimeLogSource says which replica or build produced streamed lines.
type RealtimeLogSource struct {
	// Type is "runtime" or "build".
	Type         string `json:"type"`
	ServiceID    string `json:"service_id"`
	DeploymentID string `json:"deployment_id,omitempty"`
	WorkloadID   string `json:"workload_id,omitempty"`
	BuildID      string `json:"build_id,omitempty"`
}

// RealtimeMessage is one server → client message. Type selects which of the
// other fields is set: "deployment.updated" (Deployment), "deployment.event"
// (Event), "log.lines" (Source, Lines), "service.updated" (Service) or
// "presence".
type RealtimeMessage struct {
	Type       string             `json:"type"`
	Deployment *Deployment        `json:"deployment,omitempty"`
	Event      *DeploymentEvent   `json:"event,omitempty"`
	Source     *RealtimeLogSource `json:"source,omitempty"`
	Lines      []LogEntry         `json:"lines,omitempty"`
	Service    *Service           `json:"service,omitempty"`
}

// Realtime is an open project realtime socket.
type Realtime struct {
	conn *websocket.Conn
}

// DialRealtime opens the realtime socket of a project as a CLI client,
// which the project room leaves out of presence.
//
// The control plane accepts the upgrade even when the caller may not open
// the socket, then closes it at once with 4401, 4403 or 4404; that surfaces
// from [Realtime.Read] as a [*RealtimeClosedError]. An older control plane
// refuses the upgrade over HTTP instead, returned here as an [*Error].
//
// SECURITY: browsers do not apply CORS to WebSocket upgrades, so the API
// accepts a cookie-authenticated upgrade only with an Origin equal to its
// own (apps/api/src/routes/realtime.ts). The CLI sends exactly that origin
// alongside the credential; a bearer token does not need it.
func (c *Client) DialRealtime(ctx context.Context, projectID string) (*Realtime, error) {
	u := c.endpoint(RouteRealtime.expand(projectID))
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.RawQuery = url.Values{"client": {"cli"}}.Encode()
	h := http.Header{}
	h.Set("Origin", c.Origin())
	if c.userAgent != "" {
		h.Set("User-Agent", c.userAgent)
	}
	if c.cred != nil {
		c.cred.Apply(h)
	}
	conn, res, err := websocket.Dial(ctx, u.String(), &websocket.DialOptions{HTTPClient: c.stream, HTTPHeader: h})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if res != nil && res.StatusCode != http.StatusSwitchingProtocols {
			body, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
			res.Body.Close()
			return nil, parseError(res.StatusCode, body)
		}
		return nil, &NetworkError{URL: c.Origin(), Err: err}
	}
	conn.SetReadLimit(maxRealtimeFrame)
	return &Realtime{conn: conn}, nil
}

// Subscribe starts receiving log lines for a topic.
func (r *Realtime) Subscribe(ctx context.Context, t RealtimeTopic) error {
	return r.send(ctx, map[string]any{"type": "subscribe", "topic": t.wire()})
}

func (r *Realtime) send(ctx context.Context, msg any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return r.conn.Write(ctx, websocket.MessageText, data)
}

// Read blocks until the next message. Unknown message types are returned
// as-is so callers can skip them. A close frame from the server is returned
// as a [*RealtimeClosedError].
func (r *Realtime) Read(ctx context.Context) (*RealtimeMessage, error) {
	typ, data, err := r.conn.Read(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var ce websocket.CloseError
		if errors.As(err, &ce) {
			return nil, &RealtimeClosedError{Code: int(ce.Code), Reason: ce.Reason}
		}
		return nil, err
	}
	if typ != websocket.MessageText {
		return nil, errors.New("realtime socket sent a binary frame")
	}
	var msg RealtimeMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, fmt.Errorf("realtime socket sent invalid JSON: %w", err)
	}
	return &msg, nil
}

// Close closes the socket normally.
func (r *Realtime) Close() error {
	return r.conn.Close(websocket.StatusNormalClosure, "")
}
