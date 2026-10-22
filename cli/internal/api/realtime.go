package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/coder/websocket"
)

// maxRealtimeFrame bounds one server frame. The project room coalesces log
// batches, each at most 64 KiB of line text, so a few MiB is ample.
const maxRealtimeFrame = 4 << 20

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

// DialRealtime opens the realtime socket of a project.
//
// SECURITY: browsers do not apply CORS to WebSocket upgrades, so the API
// accepts the upgrade only with an Origin equal to its own
// (apps/api/src/routes/realtime.ts). The CLI sends exactly that origin,
// alongside the session credential.
func (c *Client) DialRealtime(ctx context.Context, projectID string) (*Realtime, error) {
	u := c.endpoint(RouteRealtime.expand(projectID))
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
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
// as-is so callers can skip them.
func (r *Realtime) Read(ctx context.Context) (*RealtimeMessage, error) {
	typ, data, err := r.conn.Read(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var ce websocket.CloseError
		if errors.As(err, &ce) {
			return nil, fmt.Errorf("realtime socket closed: %d %s", ce.Code, ce.Reason)
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
