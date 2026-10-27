package apitest

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
)

// ShellWorkloadID is the seeded API replica a shell opens in.
const ShellWorkloadID = "wl_0001"

// shellState holds shell targets, refusals and the sessions opened.
type shellState struct {
	targets  map[string]*api.ShellTargets
	refusal  int
	sessions []*ShellSession
	// handler, when set, runs each accepted session instead of the default.
	handler func(*ShellSession)
}

// ShellResize is one resize message a session received.
type ShellResize struct {
	Cols, Rows int
}

// ShellSession is one shell socket the fake accepted. The default handler
// sends `opened`, echoes input as output, answers each resize with a
// "resized COLSxROWS\r\n" line, and ends with `exit` on Ctrl-D (code
// [ShellSession.ExitCode]) or on a close message (no code, reason closed).
type ShellSession struct {
	// Query is the socket URL's query: cols, rows, term and cmd.
	Query url.Values
	// Header is the upgrade request's headers.
	Header http.Header
	// ExitCode is what the default handler reports on Ctrl-D.
	ExitCode int
	// Recorded is what `opened` says about recording.
	Recorded bool

	conn *websocket.Conn

	mu      sync.Mutex
	input   bytes.Buffer
	resizes []ShellResize
	closed  bool
}

// Input returns the stdin bytes received so far.
func (s *ShellSession) Input() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.input.Bytes())
}

// Resizes returns the resize messages received so far.
func (s *ShellSession) Resizes() []ShellResize {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.resizes)
}

// CloseRequested reports whether the client sent `{"type":"close"}`.
func (s *ShellSession) CloseRequested() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// Opened sends the `opened` message for the seeded replica.
func (s *ShellSession) Opened() {
	s.SendJSON(map[string]any{"type": "opened", "session_id": "shl_0001", "node_id": NodeID, "node_name": "edge-1",
		"user": "root", "replica": 0, "idle_timeout_s": 900, "max_duration_s": 28800, "recorded": s.Recorded})
}

// Output sends terminal output.
func (s *ShellSession) Output(p []byte) {
	_ = s.conn.Write(context.Background(), websocket.MessageBinary, p)
}

// SendJSON sends a control message.
func (s *ShellSession) SendJSON(v any) {
	data, _ := json.Marshal(v)
	_ = s.conn.Write(context.Background(), websocket.MessageText, data)
}

// Exit sends `exit` and closes the socket normally. A nil code is sent as null.
func (s *ShellSession) Exit(code *int, reason string) {
	s.SendJSON(map[string]any{"type": "exit", "code": code, "reason": reason})
	_ = s.conn.Close(websocket.StatusNormalClosure, "")
}

// Next reads the next client frame: input bytes (recorded), or a control
// message, recorded and returned. ok is false once the socket closed.
func (s *ShellSession) Next() (input []byte, control map[string]any, ok bool) {
	typ, data, err := s.conn.Read(context.Background())
	if err != nil {
		return nil, nil, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if typ == websocket.MessageBinary {
		s.input.Write(data)
		return data, nil, true
	}
	if json.Unmarshal(data, &control) != nil {
		return nil, nil, false
	}
	switch control["type"] {
	case "resize":
		cols, _ := control["cols"].(float64)
		rows, _ := control["rows"].(float64)
		s.resizes = append(s.resizes, ShellResize{Cols: int(cols), Rows: int(rows)})
	case "close":
		s.closed = true
	}
	return nil, control, true
}

// Serve runs the default handler described on [ShellSession].
func (s *ShellSession) Serve() {
	s.Opened()
	if cmd := s.Query["cmd"]; len(cmd) > 0 {
		argv, _ := json.Marshal(cmd)
		s.Output(append([]byte("argv "), append(argv, '\n')...))
	}
	for {
		in, control, ok := s.Next()
		if !ok {
			return
		}
		switch {
		case in != nil:
			if i := bytes.IndexByte(in, 0x04); i >= 0 {
				s.Output(in[:i])
				code := s.ExitCode
				s.Exit(&code, "exited")
				return
			}
			s.Output(in)
		case control["type"] == "resize":
			r := s.Resizes()
			last := r[len(r)-1]
			s.Output([]byte("resized " + itoa(last.Cols) + "x" + itoa(last.Rows) + "\r\n"))
		case control["type"] == "close":
			s.Exit(nil, "closed")
			return
		}
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func (f *Fake) shellRoutes(handlers map[api.Route]guarded) {
	f.shell = &shellState{targets: map[string]*api.ShellTargets{}}
	f.shell.targets[APIServiceID+"/"+ProductionID] = &api.ShellTargets{
		Targets: []api.ShellTarget{{WorkloadID: ShellWorkloadID, DeploymentID: ActiveDeploy, Replica: 0, NodeID: NodeID,
			NodeName: "edge-1", State: "healthy", ShellSupported: true}},
		Gate: api.ShellGate{Allowed: true},
	}
	handlers[api.RouteShellTargets] = guarded{"services:read", f.shellTargets}
	handlers[api.RouteServiceCloudflare] = guarded{"services:read", f.serviceCloudflare}
}

// SetShellTargets replaces what shell-targets returns for a service in an
// environment.
func (f *Fake) SetShellTargets(serviceID, environmentID string, t api.ShellTargets) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.shell.targets[serviceID+"/"+environmentID] = &t
}

// RefuseShells makes the shell socket close with code right after the
// upgrade; 0 accepts again.
func (f *Fake) RefuseShells(code int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.shell.refusal = code
}

// HandleShells runs h for each accepted shell session instead of the
// default echo handler; h returning closes the socket.
func (f *Fake) HandleShells(h func(*ShellSession)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.shell.handler = h
}

// ShellSessions returns the shell sessions accepted so far.
func (f *Fake) ShellSessions() []*ShellSession {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.shell.sessions)
}

func (f *Fake) shellTargets(w http.ResponseWriter, r *http.Request) {
	if _, s := f.service(w, r.PathValue("serviceId")); s == nil {
		return
	}
	t, ok := f.shell.targets[r.PathValue("serviceId")+"/"+r.URL.Query().Get("environment_id")]
	if !ok {
		t = &api.ShellTargets{Targets: []api.ShellTarget{}, Gate: api.ShellGate{Allowed: true}}
	}
	writeJSON(w, http.StatusOK, t)
}

// shellSocket mirrors the shell relay's checks: the realtime socket's
// Origin rule, then authentication and `shell:open`, answered with close
// codes after the upgrade.
func (f *Fake) shellSocket(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		apiError(w, http.StatusUpgradeRequired, "upgrade_required", "Expected a WebSocket upgrade")
		return
	}
	bearer := strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !bearer && r.Header.Get("Origin") != f.URL {
		apiError(w, http.StatusForbidden, "forbidden", "Cross-origin WebSocket rejected")
		return
	}
	f.mu.Lock()
	who, authed := f.authenticate(r)
	var refuse websocket.StatusCode
	switch {
	case !authed:
		refuse = api.CloseUnauthorized
	case r.PathValue("workloadId") != ShellWorkloadID:
		refuse = api.CloseNotFound
	case !who.can("shell:open"):
		refuse = api.CloseForbidden
	case f.shell.refusal != 0:
		refuse = websocket.StatusCode(f.shell.refusal)
	}
	handler := f.shell.handler
	f.mu.Unlock()
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	if refuse != 0 {
		_ = conn.Close(refuse, "refused")
		return
	}
	s := &ShellSession{Query: r.URL.Query(), Header: r.Header.Clone(), conn: conn}
	f.mu.Lock()
	f.shell.sessions = append(f.shell.sessions, s)
	f.mu.Unlock()
	if handler != nil {
		handler(s)
		// NOTE: give the client a moment to read what the handler wrote
		// before CloseNow tears the connection down.
		time.Sleep(50 * time.Millisecond)
		return
	}
	s.Serve()
}

// -----------------------------------------------------------------------------
// Cloudflare
// -----------------------------------------------------------------------------

// SetCloudflare sets what GET /v1/services/{id}/cloudflare returns for a
// service in an environment. Its Eligibility also decides whether a switch
// to cloudflare is a 422 provider_ineligible.
func (f *Fake) SetCloudflare(serviceID, environmentID string, st api.CloudflareStatus) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.cf == nil {
		f.cf = map[string]*api.CloudflareStatus{}
	}
	f.cf[serviceID+"/"+environmentID] = &st
}

// cloudflareStatus is the stored status, or a configured, eligible service
// on nodes. The provider follows the saved config.
func (f *Fake) cloudflareStatus(serviceID, environmentID string) api.CloudflareStatus {
	st := api.CloudflareStatus{Provider: api.ProviderNodes, Configured: true, Eligibility: []api.EligibilityFailure{}, Deployments: []api.CloudflareDeployment{}}
	if s, ok := f.cf[serviceID+"/"+environmentID]; ok {
		st = *s
	}
	if c, ok := f.configs[serviceID+"/"+environmentID]; ok {
		var p api.PlacementConfig
		if json.Unmarshal(c.Placement, &p) == nil && p.Provider != "" {
			st.Provider = p.Provider
		}
	}
	return st
}

func (f *Fake) serviceCloudflare(w http.ResponseWriter, r *http.Request) {
	if _, s := f.service(w, r.PathValue("serviceId")); s == nil {
		return
	}
	writeJSON(w, http.StatusOK, f.cloudflareStatus(r.PathValue("serviceId"), r.URL.Query().Get("environment_id")))
}

// mergePlacement applies a placement patch like the API: provider is
// checked for eligibility, `cloudflare` replaces the stored part whole.
// It writes the error and returns nil when the patch is refused.
func (f *Fake) mergePlacement(w http.ResponseWriter, serviceID, environmentID string, latest json.RawMessage, p *api.PlacementPatch) json.RawMessage {
	var placement map[string]any
	if json.Unmarshal(latest, &placement) != nil || placement == nil {
		placement = map[string]any{"node_selector": map[string]any{}}
	}
	if p.Provider != "" && !slices.Contains(api.ServiceProviders, p.Provider) {
		apiError(w, http.StatusBadRequest, "invalid_request", "placement.provider: Invalid enum value")
		return nil
	}
	if p.Provider == api.ProviderCloudflare {
		if st := f.cloudflareStatus(serviceID, environmentID); len(st.Eligibility) > 0 {
			details := make([]api.ErrorDetail, len(st.Eligibility))
			for i, e := range st.Eligibility {
				details[i] = api.ErrorDetail{Field: "placement.provider", Code: e.Rule, Message: e.Message}
			}
			apiError(w, http.StatusUnprocessableEntity, "provider_ineligible", "This service can't run on Cloudflare Containers", details...)
			return nil
		}
	}
	if p.Provider != "" {
		placement["provider"] = p.Provider
	}
	if p.Cloudflare != nil {
		placement["cloudflare"] = p.Cloudflare
	}
	out, _ := json.Marshal(placement)
	return out
}
