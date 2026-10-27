// Package conn maintains the agent's WebSocket session with the control plane.
//
// Responsibilities:
//   - dial the connect URL with the node's bearer credential and reconnect
//     forever with capped, jittered exponential backoff;
//   - send hello on every connection, then heartbeats on the interval the
//     control plane's welcome sets, from a single writer goroutine;
//   - verify every inbound signed envelope against the trusted control-plane
//     keys ([KeyStore]), follow signing-key rollovers announced in welcome
//     and key_announce, act on welcome, and dispatch desired_state (in
//     generation order), build_job and build_cancel to a [Handler], the
//     volume, backup, restore, copy and query frames to a [DataHandler],
//     job_run and job_cancel to a [JobHandler], and cert_sync to a
//     [CertHandler];
//   - infer the control plane's protocol version from what it sends
//     ([Client.PeerProtocolVersion]), so frames it can't parse are never sent;
//   - carry workload_status, logs, build_result and job_status frames from
//     the rest of the agent through that same writer ([Client.Send]),
//     within the protocol's frame size limit.
package conn

import (
	"cmp"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/clock"
	"github.com/BankkRoll/Roundhouse/agent/internal/state"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
	"github.com/coder/websocket"
)

// Defaults applied when the corresponding [Client] field is zero.
const (
	DefaultHeartbeatInterval = 10 * time.Second
	DefaultMinBackoff        = time.Second
	DefaultMaxBackoff        = time.Minute
)

// Bounds applied to the heartbeat interval a welcome may set. A hostile or
// buggy value must neither stop heartbeats nor overflow the ticker.
const (
	MinHeartbeatInterval = time.Second
	MaxHeartbeatInterval = 10 * time.Minute
)

// ExpiryGrace is how long past its exp a control frame is still accepted,
// absorbing residual clock error after skew correction.
const ExpiryGrace = 60 * time.Second

const (
	dialTimeout  = 15 * time.Second
	writeTimeout = 10 * time.Second
	// maxFrameBytes bounds memory per inbound frame. Desired state for a
	// single node is far smaller than this.
	maxFrameBytes = 4 << 20
	// healthySession is how long a connection must last before the
	// reconnect backoff resets, so a control plane that accepts and then
	// immediately drops connections cannot cause a tight reconnect loop.
	healthySession = 30 * time.Second
	// maxClockOffset bounds skew correction. A larger apparent offset means
	// a broken clock or a misbehaving server, and trusting it would revive
	// long-expired frames.
	maxClockOffset = 24 * time.Hour
)

var errUnauthorized = errors.New("control plane rejected credential")

// closeAgentOutdated is the close code the control plane answers a hello
// below its MIN_PROTOCOL_VERSION with (ADR 0013). Retrying cannot help; only
// an upgrade can.
const closeAgentOutdated websocket.StatusCode = 4002

// isAgentOutdated reports whether err is the control plane refusing this
// agent's protocol version.
func isAgentOutdated(err error) bool { return websocket.CloseStatus(err) == closeAgentOutdated }

// ErrNotConnected is returned by [Client.Send] when no session is up. Callers
// either drop the frame (statuses: hello resynchronises them) or keep it for
// later (logs, build results).
var ErrNotConnected = errors.New("not connected to the control plane")

// ErrFrameTooLarge is returned by [Client.Send] for a frame over
// [protocol.MaxAgentFrameBytes], which the control plane would reject.
var ErrFrameTooLarge = errors.New("agent frame exceeds the protocol size limit")

// Handler receives verified control messages. Its methods are called from
// the connection's read loop and must return quickly.
type Handler interface {
	// HasDesiredState reports whether a desired state is loaded in memory.
	// Until one is, a desired state whose generation equals the persisted
	// observed generation is applied rather than ignored: desired states
	// carry secrets and are never persisted, so after a restart the agent
	// needs the control plane to send the current one again.
	HasDesiredState() bool
	// ApplyDesiredState takes a desired state newer than any applied and
	// reports whether it accepted it.
	ApplyDesiredState(m *protocol.DesiredState) bool
	// StartBuild takes a build job.
	StartBuild(m *protocol.BuildJob)
	// CancelBuild stops the build a build_cancel names.
	CancelBuild(m *protocol.BuildCancel)
}

// DataHandler receives the Phase 2 data-plane frames (ADR 0004, ADR 0015):
// volume deletes, backups, restores, volume copies and data-browser
// queries. Every one but volume_delete is credential-bearing, and reaches it
// only after [protocol.VerifyEnvelope] has checked its 60 s lifetime. Its
// methods are called from the connection's read loop and must return
// quickly.
type DataHandler interface {
	DeleteVolume(m *protocol.VolumeDelete)
	StartBackup(m *protocol.BackupJob)
	AddBackupParts(m *protocol.BackupParts)
	StartRestore(m *protocol.RestoreJob)
	StartCopyOut(m *protocol.VolumeCopyOut)
	StartCopyIn(m *protocol.VolumeCopyIn)
	RunQuery(m *protocol.DBQuery)
}

// CertHandler receives cert_sync frames (ADR 0009), which carry sealed
// private keys and reach it only after [protocol.VerifyEnvelope] has checked
// their 60 s lifetime. SyncCerts is called from the connection's read loop
// and must return quickly.
type CertHandler interface {
	SyncCerts(m *protocol.CertSync)
}

// JobHandler receives job_run and job_cancel (ADR 0010). job_run is
// credential-bearing, and reaches it only after [protocol.VerifyEnvelope]
// has checked its 60 s lifetime. Its methods are called from the
// connection's read loop and must return quickly.
type JobHandler interface {
	RunJob(m *protocol.JobRun)
	CancelJob(m *protocol.JobCancel)
}

// ExecHandler receives the web shell frames (ADR 0012). Every one reaches it
// only after [protocol.VerifyEnvelope] has checked its 60 s lifetime. Its
// methods are called from the connection's read loop and must return
// quickly.
type ExecHandler interface {
	OpenExec(m *protocol.ExecOpen)
	ExecInput(m *protocol.ExecInput)
	ResizeExec(m *protocol.ExecResize)
	CloseExec(m *protocol.ExecClose)
	// Disconnected is called when the control connection ends: a session
	// can't outlive the only channel that relays it.
	Disconnected()
}

// ImagePushHandler receives image_push (ADR 0011), which is
// credential-bearing and reaches it only after [protocol.VerifyEnvelope]
// has checked its 60 s lifetime. PushImage is called from the connection's
// read loop and must return quickly.
type ImagePushHandler interface {
	PushImage(m *protocol.ImagePush)
}

// Client is a long-lived connection to the control plane. Configure the
// exported fields, then call [Client.Run].
type Client struct {
	// ConnectURL is the ws:// or wss:// URL to dial.
	ConnectURL string
	// Credential is sent as a bearer token on the WebSocket handshake.
	Credential string
	// NodeID is this node's ID; payloads addressed elsewhere are dropped.
	NodeID string
	// ControlKey is the control-plane signing key the node joined with.
	ControlKey ed25519.PublicKey
	// ControlKeyID is the kid of ControlKey, empty until the first verified
	// welcome pins it. Envelopes under any other kid are dropped unless
	// Keys trusts it.
	ControlKeyID string
	// Keys holds the trusted signing keys and follows rollovers. Nil starts
	// an in-memory store from ControlKey and ControlKeyID.
	Keys *KeyStore
	// OnControlKeyID is called once, when the first welcome pins the join
	// key's kid, to record it in the config; nil skips that.
	OnControlKeyID func(kid string) error
	// Hello builds the hello frame for each new connection; the client
	// passes the observed generation.
	Hello func(ctx context.Context, observedGeneration int64) protocol.Hello
	// Usage samples node usage for each heartbeat.
	Usage func(ctx context.Context) protocol.NodeUsage
	// State persists the observed generation across restarts; nil keeps it
	// in memory only.
	State *state.Store
	// Handler receives desired states and build jobs; nil only records the
	// observed generation.
	Handler Handler
	// Data receives the data-plane frames; nil drops them.
	Data DataHandler
	// Certs receives cert_sync frames; nil drops them.
	Certs CertHandler
	// Jobs receives job_run and job_cancel; nil drops them.
	Jobs JobHandler
	// Exec receives the web shell frames; nil drops them.
	Exec ExecHandler
	// Images receives image_push; nil drops it.
	Images ImagePushHandler
	// OnPeerProtocol is called with the control plane's protocol version
	// each time [Client.PeerProtocolVersion] rises. It must not block.
	OnPeerProtocol func(version int)
	// OnConnect is called after hello is sent on each new connection, when
	// [Client.Send] starts to succeed. It must not block.
	OnConnect func()
	// MetricsInterval is called with the metrics sampling interval each
	// welcome asks for, clamped to the protocol's bounds, or 0 when it asks
	// for none; and with 0 when the connection ends, so no frame goes to a
	// control plane that has not asked for one. It must not block.
	MetricsInterval func(d time.Duration)
	// Logger receives connection and message logs; nil discards them.
	Logger *slog.Logger

	// HeartbeatInterval is used until a welcome overrides it.
	HeartbeatInterval time.Duration
	// MinBackoff and MaxBackoff bound reconnect delays.
	MinBackoff, MaxBackoff time.Duration
	// HTTPClient is used for the WebSocket handshake; nil uses a default
	// client. Redirects are never followed either way.
	HTTPClient *http.Client

	observed atomic.Int64
	seq      atomic.Int64
	// clockOffset is how far the control plane's clock is ahead of ours, in
	// nanoseconds, as of the latest handshake.
	clockOffset atomic.Int64
	// peer is the lowest protocol version the control plane has shown it
	// speaks on the current connection; 0 while disconnected.
	peer atomic.Int64
	// cur is the session whose writer accepts [Client.Send] frames, nil
	// while disconnected.
	cur atomic.Pointer[session]
	// replay drops a verified frame whose ID was already applied; it spans
	// reconnects, since a replay may arrive on a later connection.
	replay replayGuard
}

// ObservedGeneration returns the newest desired_state generation applied.
func (c *Client) ObservedGeneration() int64 {
	return c.observed.Load()
}

// Run connects and stays connected until ctx is cancelled, then closes the
// socket gracefully and returns nil. Errors are returned only for problems
// that retrying cannot fix, such as unreadable persisted state.
func (c *Client) Run(ctx context.Context) error {
	if c.Logger == nil {
		c.Logger = slog.New(slog.DiscardHandler)
	}
	if c.Keys == nil {
		c.Keys = NewKeyStore(c.ControlKey, c.ControlKeyID)
	}
	if c.State != nil {
		st, err := c.State.Load()
		if err != nil {
			return fmt.Errorf("load state: %w", err)
		}
		c.observed.Store(st.ObservedGeneration)
	}

	b := NewBackoff(cmp.Or(c.MinBackoff, DefaultMinBackoff), cmp.Or(c.MaxBackoff, DefaultMaxBackoff))
	for {
		start := time.Now()
		connected, err := c.session(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if shouldResetBackoff(connected, time.Since(start)) {
			b.Reset()
		}
		delay := retryDelay(b, err)
		if errors.Is(err, errUnauthorized) {
			c.Logger.Error("control plane rejected this node's credential; the node may have been removed. Re-join with `roundhouse-agent join --force`",
				"err", err, "retry_in", delay)
		} else if isAgentOutdated(err) {
			c.Logger.Error("control plane no longer supports this agent's protocol version; upgrade with `install.sh --upgrade`",
				"protocol_version", protocol.ProtocolVersion, "retry_in", delay)
		} else {
			c.Logger.Warn("disconnected from control plane", "err", err, "retry_in", delay)
		}

		t := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			t.Stop()
			return nil
		case <-t.C:
		}
	}
}

// shouldResetBackoff reports whether a finished session was healthy enough
// for the next reconnect sequence to start from the minimum delay.
func shouldResetBackoff(connected bool, lasted time.Duration) bool {
	return connected && lasted >= healthySession
}

// retryDelay picks the wait before the next dial. Auth failures will not fix
// themselves quickly, so they wait the full cap instead of escalating.
func retryDelay(b *Backoff, err error) time.Duration {
	if errors.Is(err, errUnauthorized) || isAgentOutdated(err) {
		return b.Max
	}
	return b.Next()
}

// httpClient returns the handshake client with redirects disabled.
//
// SECURITY: following a redirect would replay the bearer credential to
// whatever host the response names.
func (c *Client) httpClient() *http.Client {
	hc := http.Client{}
	if c.HTTPClient != nil {
		hc = *c.HTTPClient
	}
	hc.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &hc
}

// session runs one connection to completion and reports whether the dial
// succeeded.
func (c *Client) session(ctx context.Context) (connected bool, err error) {
	dialCtx, cancelDial := context.WithTimeout(ctx, dialTimeout)
	sent := time.Now()
	ws, resp, err := websocket.Dial(dialCtx, c.ConnectURL, &websocket.DialOptions{
		HTTPClient: c.httpClient(),
		HTTPHeader: http.Header{"Authorization": {"Bearer " + c.Credential}},
	})
	cancelDial()
	if offset, ok := clock.OffsetFromResponse(resp, sent, time.Now()); ok {
		c.setClockOffset(offset)
	}
	if err != nil {
		if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
			return false, fmt.Errorf("%w (HTTP %d)", errUnauthorized, resp.StatusCode)
		}
		return false, err
	}
	defer ws.CloseNow()
	c.peer.Store(0)
	defer c.peer.Store(0)
	ws.SetReadLimit(maxFrameBytes)
	c.Logger.Info("connected to control plane", "url", c.ConnectURL)

	// NOTE: coder/websocket tears the socket down without a close frame when
	// a Read context is cancelled, so the I/O loops run on a context that
	// outlives shutdown and the watcher below closes gracefully instead.
	ioCtx, stop := context.WithCancel(context.WithoutCancel(ctx))
	defer stop()
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		select {
		case <-ctx.Done():
			_ = ws.Close(websocket.StatusGoingAway, "agent shutting down")
		case <-ioCtx.Done():
		}
	}()

	s := &session{
		Client:   c,
		ws:       ws,
		interval: make(chan time.Duration, 1),
		out:      make(chan *outbound),
		done:     make(chan struct{}),
	}
	writeErr := make(chan error, 1)
	go func() {
		writeErr <- s.writeLoop(ioCtx)
		stop()
	}()
	readErr := s.readLoop(ioCtx)
	stop()
	<-closed
	if c.MetricsInterval != nil {
		c.MetricsInterval(0)
	}
	if c.Exec != nil {
		c.Exec.Disconnected()
	}
	return true, errors.Join(readErr, <-writeErr)
}

type session struct {
	*Client
	ws *websocket.Conn
	// interval carries heartbeat interval changes from the reader to the
	// writer, which owns the socket's write side.
	interval chan time.Duration
	// out carries frames from [Client.Send] to the writer.
	out chan *outbound
	// done is closed when the writer exits.
	done chan struct{}
}

// outbound is one encoded frame and where to report its write result.
type outbound struct {
	data   []byte
	result chan error
}

// Send writes msg through the active connection's single writer and waits
// for the write to finish. It returns [ErrNotConnected] when no connection
// is up (or it drops before the write), and [ErrFrameTooLarge] for a frame
// over the protocol limit.
func (c *Client) Send(ctx context.Context, msg protocol.AgentMessage) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	if len(data) > protocol.MaxAgentFrameBytes {
		return fmt.Errorf("%w: %d bytes", ErrFrameTooLarge, len(data))
	}
	s := c.cur.Load()
	if s == nil {
		return ErrNotConnected
	}
	ob := &outbound{data: data, result: make(chan error, 1)}
	select {
	case s.out <- ob:
	case <-s.done:
		return ErrNotConnected
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-ob.result:
		return err
	case <-s.done:
		// The writer may have exited before or after writing this frame.
		select {
		case err := <-ob.result:
			return err
		default:
			return ErrNotConnected
		}
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *session) writeLoop(ctx context.Context) error {
	defer func() {
		s.cur.CompareAndSwap(s, nil)
		close(s.done)
	}()
	h := s.Hello(ctx, s.observed.Load())
	if h.ProtocolVersion >= protocol.KeyRolloverProtocolVersion {
		h.PinnedKIDs = s.Keys.PinnedKIDs()
	}
	hello := fitHello(h)
	if err := s.write(ctx, &hello); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}
	s.cur.Store(s)
	if s.OnConnect != nil {
		s.OnConnect()
	}

	heartbeat := func() error {
		hb := protocol.Heartbeat{
			Type:               protocol.TypeHeartbeat,
			Seq:                s.seq.Add(1) - 1,
			TS:                 time.Now().UnixMilli(),
			ObservedGeneration: s.observed.Load(),
			Usage:              s.Usage(ctx),
		}
		if err := s.write(ctx, &hb); err != nil {
			return fmt.Errorf("send heartbeat: %w", err)
		}
		return nil
	}

	t := time.NewTicker(cmp.Or(s.HeartbeatInterval, DefaultHeartbeatInterval))
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case d := <-s.interval:
			// Report usage as soon as we're welcomed, so a freshly added
			// server shows live numbers instead of waiting a full interval.
			t.Reset(d)
			if err := heartbeat(); err != nil {
				return err
			}
		case <-t.C:
			if err := heartbeat(); err != nil {
				return err
			}
		case ob := <-s.out:
			err := s.writeRaw(ctx, ob.data)
			ob.result <- err
			if err != nil {
				return fmt.Errorf("send frame: %w", err)
			}
		}
	}
}

func (s *session) write(ctx context.Context, msg protocol.AgentMessage) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	if len(data) > protocol.MaxAgentFrameBytes {
		return fmt.Errorf("%w: %d bytes", ErrFrameTooLarge, len(data))
	}
	return s.writeRaw(ctx, data)
}

func (s *session) writeRaw(ctx context.Context, data []byte) error {
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return s.ws.Write(ctx, websocket.MessageText, data)
}

func (s *session) readLoop(ctx context.Context) error {
	for {
		typ, data, err := s.ws.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusGoingAway || ctx.Err() != nil {
				return nil
			}
			return err
		}
		if typ != websocket.MessageText {
			s.Logger.Warn("dropping control frame", "reason", "binary_frame")
			continue
		}
		s.handle(data)
	}
}

// handle verifies and applies one control frame. It never returns an error:
// a bad frame is logged and dropped so it cannot take the connection down.
func (s *session) handle(data []byte) {
	env, err := protocol.ParseEnvelope(data)
	if err != nil {
		s.drop(env, err)
		return
	}
	key, ok := s.Keys.KeyFor(env.KID, s.controlNow())
	if !ok {
		s.Logger.Warn("dropping control frame", "reason", "unknown_kid", "kid", env.KID, "pinned_kids", s.Keys.PinnedKIDs())
		return
	}
	// NOTE: VerifyEnvelope compares exp strictly; skew correction and the
	// grace window are applied here by shifting the time it is given.
	msg, err := protocol.VerifyEnvelope(env, key, s.NodeID, s.verifyTime())
	if err != nil {
		s.drop(env, err)
		return
	}
	if h := msg.Header(); !s.replay.admit(h.ID, h.ExpiresAt, s.verifyTime().UnixMilli()) {
		s.Logger.Warn("dropping control frame", "reason", "replayed", "kid", env.KID, "msg_id", h.ID)
		return
	}
	s.trust(env.KID, msg)
	s.apply(env.KID, msg)
}

// trust records a verified frame's kid with the key store: the first welcome
// pins the join key's kid, and the first frame from an announced successor
// makes it current and retires the previous key.
func (s *session) trust(kid string, msg protocol.ControlMessage) {
	_, welcome := msg.(*protocol.Welcome)
	previous := s.Keys.CurrentKID()
	changed, err := s.Keys.Verified(kid, welcome)
	if !changed {
		return
	}
	if err != nil {
		s.Logger.Error("persist control plane keys", "kid", kid, "err", err)
	}
	if previous != "" {
		s.Logger.Info("control plane signing key rolled over", "kid", kid, "previous_kid", previous)
		return
	}
	s.Logger.Info("pinned control plane key id", "kid", kid)
	if s.OnControlKeyID != nil {
		if err := s.OnControlKeyID(kid); err != nil {
			s.Logger.Error("persist control plane key id", "kid", kid, "err", err)
		}
	}
}

// announce records the successor keys that a welcome or key_announce signed
// under kid lists. A rejected announcement is logged and changes nothing.
func (s *session) announce(kid string, keys []protocol.SigningKeyAnnouncement) {
	changed, err := s.Keys.SetNext(kid, keys)
	if !changed {
		if err != nil {
			s.Logger.Warn("ignoring signing key announcement", "kid", kid, "err", err)
		}
		return
	}
	if err != nil {
		s.Logger.Error("persist control plane keys", "err", err)
	}
	kids := make([]string, len(keys))
	for i, k := range keys {
		kids[i] = k.KID
	}
	s.Logger.Info("control plane announced successor signing keys", "kid", kid, "next_kids", kids)
}

func (s *session) drop(env protocol.Envelope, err error) {
	reason := "unknown"
	if r, ok := protocol.RejectionOf(err); ok {
		reason = string(r)
	}
	s.Logger.Warn("dropping control frame", "reason", reason, "kid", env.KID, "err", err)
}

// controlNow is the control plane's current time, as of the latest skew
// measurement.
func (c *Client) controlNow() time.Time {
	return time.Now().Add(time.Duration(c.clockOffset.Load()))
}

// verifyTime is the instant expiry is checked against: control-plane time,
// less the grace window.
func (c *Client) verifyTime() time.Time {
	return time.Now().Add(time.Duration(c.clockOffset.Load()) - ExpiryGrace)
}

func (c *Client) setClockOffset(offset time.Duration) {
	if offset.Abs() > maxClockOffset {
		c.Logger.Error("local clock differs from control plane by more than a day; correction capped, fix the clock on this host",
			"offset", offset.Round(time.Second).String())
		offset = max(min(offset, maxClockOffset), -maxClockOffset)
	}
	c.clockOffset.Store(int64(offset))
	if offset.Abs() > clock.WarnThreshold {
		c.Logger.Warn("local clock differs from control plane; correcting for it, but fix NTP on this host",
			"offset", offset.Round(time.Second).String())
	}
}

func (s *session) apply(kid string, msg protocol.ControlMessage) {
	switch m := msg.(type) {
	case *protocol.Welcome:
		d := clampHeartbeatInterval(m.HeartbeatIntervalMS)
		s.announce(kid, m.NextKeys)
		select {
		case <-s.interval:
		default:
		}
		s.interval <- d
		s.Logger.Info("welcomed by control plane", "msg_id", m.ID, "heartbeat_interval", d)
		if s.MetricsInterval != nil {
			s.MetricsInterval(clampMetricsInterval(m.MetricsIntervalMS))
		}
		s.raisePeer(welcomeVersion(m))
	case *protocol.KeyAnnounce:
		s.announce(kid, m.Keys)
		s.raisePeer(protocol.KeyRolloverProtocolVersion)
	case *protocol.DesiredState:
		s.raisePeer(desiredStateVersion(m))
		s.applyDesiredState(m)
	case *protocol.BuildJob:
		if s.Handler == nil {
			s.Logger.Warn("dropping build job", "reason", "no_handler", "build_id", m.BuildID)
			return
		}
		s.Logger.Info("received build job", "msg_id", m.ID, "build_id", m.BuildID, "deployment_id", m.DeploymentID)
		s.Handler.StartBuild(m)
	case *protocol.BuildCancel:
		if s.Handler == nil {
			return
		}
		s.Logger.Info("received build cancel", "msg_id", m.ID, "build_id", m.BuildID)
		s.Handler.CancelBuild(m)
	case *protocol.VolumeDelete:
		s.data(protocol.VolumesProtocolVersion, m.Type, m.ID, func(d DataHandler) { d.DeleteVolume(m) })
	case *protocol.BackupJob:
		s.data(protocol.BackupsProtocolVersion, m.Type, m.ID, func(d DataHandler) { d.StartBackup(m) })
	case *protocol.BackupParts:
		s.data(protocol.BackupsProtocolVersion, m.Type, m.ID, func(d DataHandler) { d.AddBackupParts(m) })
	case *protocol.RestoreJob:
		s.data(protocol.BackupsProtocolVersion, m.Type, m.ID, func(d DataHandler) { d.StartRestore(m) })
	case *protocol.VolumeCopyOut:
		s.data(protocol.BackupsProtocolVersion, m.Type, m.ID, func(d DataHandler) { d.StartCopyOut(m) })
	case *protocol.VolumeCopyIn:
		s.data(protocol.BackupsProtocolVersion, m.Type, m.ID, func(d DataHandler) { d.StartCopyIn(m) })
	case *protocol.DBQuery:
		s.data(protocol.DBQueryProtocolVersion, m.Type, m.ID, func(d DataHandler) { d.RunQuery(m) })
	case *protocol.CertSync:
		s.raisePeer(protocol.CertsProtocolVersion)
		if s.PeerProtocolVersion() < protocol.CertsProtocolVersion {
			return
		}
		if s.Certs == nil {
			s.Logger.Warn("dropping control frame", "reason", "no_handler", "type", m.Type, "msg_id", m.ID)
			return
		}
		s.Logger.Debug("received certificates", "msg_id", m.ID, "upserts", len(m.Upserts), "removes", len(m.Removes))
		s.Certs.SyncCerts(m)
	case *protocol.JobRun:
		s.raisePeer(protocol.JobsProtocolVersion)
		if s.Jobs == nil {
			s.Logger.Warn("dropping control frame", "reason", "no_handler", "type", m.Type, "msg_id", m.ID, "run_id", m.RunID)
			return
		}
		s.Logger.Info("received job run", "msg_id", m.ID, "run_id", m.RunID, "workload_id", m.Workload.ID)
		s.Jobs.RunJob(m)
	case *protocol.JobCancel:
		s.raisePeer(protocol.JobsProtocolVersion)
		if s.Jobs == nil {
			s.Logger.Warn("dropping control frame", "reason", "no_handler", "type", m.Type, "msg_id", m.ID, "run_id", m.RunID)
			return
		}
		s.Logger.Info("received job cancel", "msg_id", m.ID, "run_id", m.RunID)
		s.Jobs.CancelJob(m)
	// SECURITY: shell frames are logged by type and session only; input and
	// output never reach a log (ADR 0014 §15).
	case *protocol.ExecOpen:
		s.exec(m.Type, m.ID, func(h ExecHandler) {
			s.Logger.Info("received exec open", "msg_id", m.ID, "session_id", m.SessionID, "workload_id", m.WorkloadID)
			h.OpenExec(m)
		})
	case *protocol.ExecInput:
		s.exec(m.Type, m.ID, func(h ExecHandler) { h.ExecInput(m) })
	case *protocol.ExecResize:
		s.exec(m.Type, m.ID, func(h ExecHandler) { h.ResizeExec(m) })
	case *protocol.ExecClose:
		s.exec(m.Type, m.ID, func(h ExecHandler) {
			s.Logger.Info("received exec close", "msg_id", m.ID, "session_id", m.SessionID, "reason", m.Reason)
			h.CloseExec(m)
		})
	case *protocol.ImagePush:
		s.raisePeer(protocol.ImagePushProtocolVersion)
		if s.Images == nil {
			s.Logger.Warn("dropping control frame", "reason", "no_handler", "type", m.Type, "msg_id", m.ID, "push_id", m.PushID)
			return
		}
		s.Logger.Info("received image push", "msg_id", m.ID, "push_id", m.PushID, "target", m.Target)
		s.Images.PushImage(m)
	}
}

// exec dispatches a web shell frame.
func (s *session) exec(typ, msgID string, fn func(ExecHandler)) {
	s.raisePeer(protocol.ExecProtocolVersion)
	if s.Exec == nil {
		s.Logger.Warn("dropping control frame", "reason", "no_handler", "type", typ, "msg_id", msgID)
		return
	}
	fn(s.Exec)
}

func (s *session) applyDesiredState(m *protocol.DesiredState) {
	observed := s.observed.Load()
	// An equal generation is re-applied only when nothing is loaded in
	// memory: the state a restarted agent persisted the generation of.
	if m.Generation < observed || (m.Generation == observed && (s.Handler == nil || s.Handler.HasDesiredState())) {
		s.Logger.Debug("ignoring stale desired state", "msg_id", m.ID, "generation", m.Generation, "observed_generation", observed)
		return
	}

	workloads := make([]slog.Attr, 0, len(m.Workloads))
	for _, w := range m.Workloads {
		workloads = append(workloads, slog.String(w.ID, w.Image))
	}
	s.Logger.Info("received desired state",
		"msg_id", m.ID,
		"generation", m.Generation,
		"workload_count", len(m.Workloads),
		slog.GroupAttrs("workloads", workloads...),
	)

	if s.Handler != nil && !s.Handler.ApplyDesiredState(m) {
		return
	}

	s.observed.Store(m.Generation)
	if s.State == nil {
		return
	}
	if err := s.State.Save(state.State{ObservedGeneration: m.Generation}); err != nil {
		// NOTE: keep the in-memory generation so heartbeats stay truthful for
		// this process; after a restart the control plane resends the state.
		s.Logger.Error("persist observed generation", "generation", m.Generation, "err", err)
	}
}

// clampHeartbeatInterval converts a welcome's interval to a duration within
// [MinHeartbeatInterval, MaxHeartbeatInterval]. Clamping happens in
// milliseconds so huge values cannot overflow the conversion.
func clampHeartbeatInterval(ms int64) time.Duration {
	ms = max(min(ms, MaxHeartbeatInterval.Milliseconds()), MinHeartbeatInterval.Milliseconds())
	return time.Duration(ms) * time.Millisecond
}

// clampMetricsInterval converts a welcome's metrics_interval_ms to a
// duration within the protocol's bounds; absent or non-positive is 0 (no
// metrics).
func clampMetricsInterval(ms *int64) time.Duration {
	if ms == nil || *ms <= 0 {
		return 0
	}
	return time.Duration(min(max(*ms, protocol.MinMetricsIntervalMS), protocol.MaxMetricsIntervalMS)) * time.Millisecond
}

// fitHello keeps hello within the frame limit. Status messages go first,
// then statuses from the end: hello must always get through, and the
// control plane learns the rest from workload_status frames.
func fitHello(h protocol.Hello) protocol.Hello {
	fits := func() bool {
		data, err := json.Marshal(&h)
		return err == nil && len(data) <= protocol.MaxAgentFrameBytes
	}
	if fits() {
		return h
	}
	h.Statuses = slices.Clone(h.Statuses)
	for i := range h.Statuses {
		h.Statuses[i].Message = ""
	}
	for len(h.Statuses) > 0 && !fits() {
		h.Statuses = h.Statuses[:len(h.Statuses)/2]
	}
	return h
}

// PeerProtocolVersion returns the lowest protocol version the control plane
// has shown it speaks on the current connection, 0 while disconnected. Frames
// gated above it must not be sent: a control plane rejects frame types it
// doesn't know by closing the connection.
//
// NOTE: welcome carries no protocol version, so it is inferred from what the
// control plane sends, which it never sends above the agent's version: a
// welcome is at least [protocol.MinProtocolVersion], one with next_keys at
// least [protocol.KeyRolloverProtocolVersion] and one with
// metrics_interval_ms at least [protocol.MetricsProtocolVersion]; a desired
// state or a frame using a gated feature at least that feature's version.
func (c *Client) PeerProtocolVersion() int { return int(c.peer.Load()) }

// raisePeer records that the control plane speaks at least version v.
func (c *Client) raisePeer(v int) {
	for {
		cur := c.peer.Load()
		if int64(v) <= cur {
			return
		}
		if c.peer.CompareAndSwap(cur, int64(v)) {
			if c.OnPeerProtocol != nil {
				c.OnPeerProtocol(v)
			}
			return
		}
	}
}

func welcomeVersion(m *protocol.Welcome) int {
	v := protocol.MinProtocolVersion
	if len(m.NextKeys) > 0 {
		v = max(v, protocol.KeyRolloverProtocolVersion)
	}
	if m.MetricsIntervalMS != nil {
		v = max(v, protocol.MetricsProtocolVersion)
	}
	return v
}

func desiredStateVersion(m *protocol.DesiredState) int {
	v := protocol.MinProtocolVersion
	if m.Volumes != nil {
		v = max(v, protocol.VolumesProtocolVersion)
	}
	if m.Mesh != nil || usesMeshFeatures(m.Workloads) {
		v = max(v, protocol.MeshProtocolVersion)
	}
	if m.Ingress != nil || m.Certificates != nil || m.TLSMode == protocol.TLSManaged || usesCertsFeatures(m.Workloads) {
		v = max(v, protocol.CertsProtocolVersion)
	}
	return v
}

// usesCertsFeatures reports whether any route has HSTS or a wildcard
// hostname, which only a [protocol.CertsProtocolVersion] control plane
// sends. In acme mode they are the only sign of it in a desired state.
func usesCertsFeatures(ws []protocol.WorkloadSpec) bool {
	for _, w := range ws {
		for _, r := range w.Routes {
			if r.HSTS != nil || strings.HasPrefix(r.Hostname, "*.") {
				return true
			}
		}
	}
	return false
}

// data dispatches a data-plane frame gated at version gate.
func (s *session) data(gate int, typ, msgID string, fn func(DataHandler)) {
	// A verified frame of a gated type proves the control plane speaks the
	// gate's version: it sends nothing above the agent's.
	s.raisePeer(gate)
	if s.PeerProtocolVersion() < gate {
		return
	}
	if s.Data == nil {
		s.Logger.Warn("dropping control frame", "reason", "no_handler", "type", typ, "msg_id", msgID)
		return
	}
	s.Logger.Debug("received data-plane frame", "type", typ, "msg_id", msgID)
	fn(s.Data)
}

// usesMeshFeatures reports whether any workload is a route workload or has
// a mesh IP or private DNS, which only a [protocol.MeshProtocolVersion]
// control plane sends.
func usesMeshFeatures(ws []protocol.WorkloadSpec) bool {
	for _, w := range ws {
		if w.Kind == protocol.WorkloadRouteOnly || w.MeshIP != "" || w.PrivateDNS != nil {
			return true
		}
	}
	return false
}
