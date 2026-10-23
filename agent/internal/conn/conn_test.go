package conn

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/BankkRoll/Open-Rail/agent/internal/state"
	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
	"github.com/coder/websocket"
)

const (
	testNodeID     = "node_test"
	testCredential = "nc_test"
)

// fakeControlPlane accepts one agent connection at a time, records the
// frames it sends, and lets the test push raw frames or drop the socket.
type fakeControlPlane struct {
	t        *testing.T
	srv      *httptest.Server
	received chan protocol.AgentMessage
	send     chan []byte
	kick     chan struct{}

	mu    sync.Mutex
	ended bool
	// clockAhead shifts the handshake Date header to simulate clock skew.
	clockAhead time.Duration
}

func newFakeControlPlane(t *testing.T) *fakeControlPlane {
	f := &fakeControlPlane{
		t:        t,
		received: make(chan protocol.AgentMessage, 256),
		send:     make(chan []byte, 16),
		kick:     make(chan struct{}, 1),
	}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	// Registered after srv.Close, so it runs first: handlers still draining
	// after the test ends must not call t.Errorf.
	t.Cleanup(func() {
		f.mu.Lock()
		f.ended = true
		f.mu.Unlock()
	})
	return f
}

func (f *fakeControlPlane) errorf(format string, args ...any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.ended {
		f.t.Errorf(format, args...)
	}
}

func (f *fakeControlPlane) url() string {
	return "ws" + strings.TrimPrefix(f.srv.URL, "http")
}

func (f *fakeControlPlane) serve(w http.ResponseWriter, r *http.Request) {
	if got := r.Header.Get("Authorization"); got != "Bearer "+testCredential {
		f.errorf("Authorization header = %q", got)
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	if f.clockAhead != 0 {
		w.Header().Set("Date", time.Now().Add(f.clockAhead).UTC().Format(http.TimeFormat))
	}
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		f.errorf("accept: %v", err)
		return
	}
	defer ws.CloseNow()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		defer cancel()
		for {
			_, data, err := ws.Read(ctx)
			if err != nil {
				return
			}
			msg, err := protocol.DecodeAgentMessage(data)
			if err != nil {
				f.errorf("agent sent invalid frame %s: %v", data, err)
				return
			}
			f.received <- msg
		}
	}()
	for {
		select {
		case b := <-f.send:
			if err := ws.Write(ctx, websocket.MessageText, b); err != nil {
				return
			}
		case <-f.kick:
			ws.Close(websocket.StatusInternalError, "test kick")
			return
		case <-ctx.Done():
			return
		}
	}
}

func (f *fakeControlPlane) push(t *testing.T, priv ed25519.PrivateKey, msg protocol.ControlMessage) {
	t.Helper()
	f.pushKID(t, priv, "test", msg)
}

func (f *fakeControlPlane) pushKID(t *testing.T, priv ed25519.PrivateKey, kid string, msg protocol.ControlMessage) {
	t.Helper()
	env, err := protocol.SignEnvelope(msg, priv, kid)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	f.send <- data
}

func (f *fakeControlPlane) next(t *testing.T) protocol.AgentMessage {
	t.Helper()
	select {
	case m := <-f.received:
		return m
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for agent frame")
		return nil
	}
}

// nextHeartbeatWith skips frames until a heartbeat reports want.
func (f *fakeControlPlane) nextHeartbeatWith(t *testing.T, want int64) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case m := <-f.received:
			if hb, ok := m.(*protocol.Heartbeat); ok && hb.ObservedGeneration == want {
				return
			}
		case <-deadline:
			t.Fatalf("no heartbeat with observed_generation %d", want)
		}
	}
}

// syncBuffer is an io.Writer safe for concurrent slog use.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func header(id string, exp time.Time) protocol.ControlHeader {
	return protocol.ControlHeader{ID: id, NodeID: testNodeID, IssuedAt: time.Now().UnixMilli(), ExpiresAt: exp.UnixMilli()}
}

func desired(id string, gen int64, exp time.Time) *protocol.DesiredState {
	return &protocol.DesiredState{
		Type:          protocol.TypeDesiredState,
		ControlHeader: header(id, exp),
		Generation:    gen,
		Workloads:     []protocol.WorkloadSpec{},
		TLSMode:       protocol.TLSOff,
	}
}

func newTestClient(t *testing.T, url string, pub ed25519.PublicKey, store *state.Store, logs *syncBuffer) *Client {
	return &Client{
		ConnectURL: url,
		Credential: testCredential,
		NodeID:     testNodeID,
		ControlKey: pub,
		Hello: func(_ context.Context, observed int64) protocol.Hello {
			return protocol.Hello{
				Type:               protocol.TypeHello,
				ProtocolVersion:    protocol.ProtocolVersion,
				NodeID:             testNodeID,
				AgentVersion:       "test",
				OS:                 "ubuntu 24.04",
				Arch:               protocol.ArchAMD64,
				Hardware:           protocol.Hardware{CPUCores: 1},
				ObservedGeneration: observed,
			}
		},
		Usage:             func(context.Context) protocol.NodeUsage { return protocol.NodeUsage{CPUPercent: 1} },
		State:             store,
		Logger:            slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		HeartbeatInterval: 20 * time.Millisecond,
		MinBackoff:        10 * time.Millisecond,
		MaxBackoff:        50 * time.Millisecond,
	}
}

// startClient runs c until the test ends and returns a function that stops
// it and reports what Run returned.
func startClient(t *testing.T, c *Client) (stop func() error) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Run(ctx) }()
	var (
		once sync.Once
		err  error
	)
	stop = func() error {
		once.Do(func() {
			cancel()
			select {
			case err = <-done:
			case <-time.After(10 * time.Second):
				err = errors.New("Run did not return after cancel")
			}
		})
		return err
	}
	t.Cleanup(func() {
		if err := stop(); err != nil {
			t.Error(err)
		}
	})
	return stop
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestClientSession(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	_, attackerPriv, _ := ed25519.GenerateKey(rand.Reader)
	cp := newFakeControlPlane(t)
	store := state.NewStore(filepath.Join(t.TempDir(), "state.json"))
	logs := &syncBuffer{}
	c := newTestClient(t, cp.url(), pub, store, logs)

	stop := startClient(t, c)

	persisted := func(want int64) func() bool {
		return func() bool {
			st, err := store.Load()
			return err == nil && st.ObservedGeneration == want
		}
	}

	hello, ok := cp.next(t).(*protocol.Hello)
	if !ok || hello.NodeID != testNodeID || hello.ObservedGeneration != 0 {
		t.Fatalf("first frame = %+v, want hello", hello)
	}
	if _, ok := cp.next(t).(*protocol.Heartbeat); !ok {
		t.Fatal("second frame is not a heartbeat")
	}

	future := time.Now().Add(time.Minute)
	cp.push(t, priv, &protocol.Welcome{
		Type:                protocol.TypeWelcome,
		ControlHeader:       header("m_welcome", future),
		HeartbeatIntervalMS: 15,
	})
	cp.push(t, priv, desired("m_5", 5, future))
	waitFor(t, "generation 5 to persist", persisted(5))

	t.Run("rejected envelopes are ignored", func(t *testing.T) {
		cp.push(t, attackerPriv, desired("m_forged", 9, future))
		wrongNode := desired("m_wrong_node", 9, future)
		wrongNode.NodeID = "node_other"
		cp.push(t, priv, wrongNode)
		cp.push(t, priv, desired("m_expired", 9, time.Now().Add(-2*ExpiryGrace)))
		cp.send <- []byte(`{"v":1,"kid":"test","payload":"{}"}`)
		cp.push(t, priv, desired("m_stale", 4, future))
		// Frames are handled in order, so once this lands every frame above
		// has been processed; had any been accepted, 6 would be stale.
		cp.push(t, priv, desired("m_6", 6, future))
		waitFor(t, "generation 6 to persist", persisted(6))

		if got := c.ObservedGeneration(); got != 6 {
			t.Fatalf("observed generation = %d, want 6", got)
		}
		for _, reason := range []string{"bad_signature", "wrong_node", "expired", "malformed"} {
			if !strings.Contains(logs.String(), `"reason":"`+reason+`"`) {
				t.Errorf("no %s rejection logged", reason)
			}
		}
		cp.nextHeartbeatWith(t, 6)
	})

	t.Run("hello is re-sent after reconnect", func(t *testing.T) {
		cp.kick <- struct{}{}
		deadline := time.After(5 * time.Second)
		for {
			select {
			case m := <-cp.received:
				if h, ok := m.(*protocol.Hello); ok {
					if h.ObservedGeneration != 6 {
						t.Fatalf("reconnect hello observed_generation = %d, want 6", h.ObservedGeneration)
					}
					return
				}
			case <-deadline:
				t.Fatal("no hello after reconnect")
			}
		}
	})

	if err := stop(); err != nil {
		t.Fatalf("Run returned %v", err)
	}
}

func TestClientRestoresObservedGeneration(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	cp := newFakeControlPlane(t)
	store := state.NewStore(filepath.Join(t.TempDir(), "state.json"))
	if err := store.Save(state.State{ObservedGeneration: 41}); err != nil {
		t.Fatal(err)
	}
	c := newTestClient(t, cp.url(), pub, store, &syncBuffer{})
	startClient(t, c)

	if h, ok := cp.next(t).(*protocol.Hello); !ok || h.ObservedGeneration != 41 {
		t.Fatalf("hello = %+v, want observed_generation 41", h)
	}
}

func TestSessionUnauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"unknown credential"}`, http.StatusUnauthorized)
	}))
	defer srv.Close()
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	c := newTestClient(t, "ws"+strings.TrimPrefix(srv.URL, "http"), pub, nil, &syncBuffer{})

	connected, err := c.session(context.Background())
	if connected || !errors.Is(err, errUnauthorized) {
		t.Fatalf("session = %v, %v; want errUnauthorized", connected, err)
	}
}

func persistedGeneration(store *state.Store, want int64) func() bool {
	return func() bool {
		st, err := store.Load()
		return err == nil && st.ObservedGeneration == want
	}
}

func TestClockSkewCorrection(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	cp := newFakeControlPlane(t)
	// The agent's clock runs ten minutes fast relative to the control plane.
	cp.clockAhead = -10 * time.Minute
	store := state.NewStore(filepath.Join(t.TempDir(), "state.json"))
	logs := &syncBuffer{}
	c := newTestClient(t, cp.url(), pub, store, logs)
	startClient(t, c)
	cp.next(t)

	serverNow := time.Now().Add(cp.clockAhead)
	cp.push(t, priv, desired("m_fresh", 3, serverNow.Add(30*time.Second)))
	waitFor(t, "skew-corrected frame to apply", persistedGeneration(store, 3))

	cp.push(t, priv, desired("m_grace", 4, serverNow.Add(-30*time.Second)))
	waitFor(t, "frame inside the grace window to apply", persistedGeneration(store, 4))

	cp.push(t, priv, desired("m_stale", 9, serverNow.Add(-2*time.Minute)))
	cp.push(t, priv, desired("m_sentinel", 5, serverNow.Add(30*time.Second)))
	waitFor(t, "sentinel frame to apply", persistedGeneration(store, 5))

	if !strings.Contains(logs.String(), `"reason":"expired"`) {
		t.Error("frame expired beyond the grace window was not rejected")
	}
	if !strings.Contains(logs.String(), "local clock differs from control plane") {
		t.Error("no clock skew warning logged")
	}
}

func TestKeyIDPinning(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	cp := newFakeControlPlane(t)
	store := state.NewStore(filepath.Join(t.TempDir(), "state.json"))
	logs := &syncBuffer{}
	c := newTestClient(t, cp.url(), pub, store, logs)
	pinned := make(chan string, 1)
	c.OnControlKeyID = func(kid string) error {
		pinned <- kid
		return nil
	}
	startClient(t, c)
	cp.next(t)

	future := time.Now().Add(time.Minute)
	cp.pushKID(t, priv, "k1", &protocol.Welcome{
		Type:                protocol.TypeWelcome,
		ControlHeader:       header("m_welcome", future),
		HeartbeatIntervalMS: 1000,
	})
	select {
	case kid := <-pinned:
		if kid != "k1" {
			t.Fatalf("pinned %q, want k1", kid)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("kid was not pinned from the welcome")
	}

	// Validly signed, but under a kid other than the pinned one.
	cp.pushKID(t, priv, "k2", desired("m_other_kid", 9, future))
	cp.pushKID(t, priv, "k1", desired("m_sentinel", 5, future))
	waitFor(t, "sentinel frame to apply", persistedGeneration(store, 5))
	if !strings.Contains(logs.String(), `"reason":"unknown_kid"`) {
		t.Error("frame with an unpinned kid was not rejected")
	}
}

func TestPreconfiguredKeyIDRejectsOthers(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	cp := newFakeControlPlane(t)
	store := state.NewStore(filepath.Join(t.TempDir(), "state.json"))
	logs := &syncBuffer{}
	c := newTestClient(t, cp.url(), pub, store, logs)
	c.ControlKeyID = "k1"
	c.OnControlKeyID = func(string) error {
		t.Error("an already pinned kid must not be re-pinned")
		return nil
	}
	startClient(t, c)
	cp.next(t)

	future := time.Now().Add(time.Minute)
	cp.pushKID(t, priv, "k2", &protocol.Welcome{Type: protocol.TypeWelcome, ControlHeader: header("m_w2", future), HeartbeatIntervalMS: 1000})
	cp.pushKID(t, priv, "k2", desired("m_other_kid", 9, future))
	cp.pushKID(t, priv, "k1", desired("m_sentinel", 5, future))
	waitFor(t, "sentinel frame to apply", persistedGeneration(store, 5))
	if !strings.Contains(logs.String(), `"reason":"unknown_kid"`) {
		t.Error("frame with an unpinned kid was not rejected")
	}
}

func TestDialDoesNotFollowRedirects(t *testing.T) {
	var leaked atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			leaked.Store(true)
		}
		http.Error(w, "not here", http.StatusNotFound)
	}))
	defer target.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/connect", http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()

	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	c := newTestClient(t, "ws"+strings.TrimPrefix(redirector.URL, "http"), pub, nil, &syncBuffer{})
	c.HTTPClient = &http.Client{}
	if connected, err := c.session(context.Background()); connected || err == nil {
		t.Fatalf("session = %v, %v; want a failed dial", connected, err)
	}
	if leaked.Load() {
		t.Fatal("bearer credential was replayed to the redirect target")
	}
}

func TestClampHeartbeatInterval(t *testing.T) {
	for _, tc := range []struct {
		ms   int64
		want time.Duration
	}{
		{1, MinHeartbeatInterval},
		{0, MinHeartbeatInterval},
		{-5, MinHeartbeatInterval},
		{15_000, 15 * time.Second},
		{math.MaxInt64, MaxHeartbeatInterval},
	} {
		if got := clampHeartbeatInterval(tc.ms); got != tc.want {
			t.Errorf("clampHeartbeatInterval(%d) = %v, want %v", tc.ms, got, tc.want)
		}
	}
}

func TestHostileWelcomeIntervalKeepsAgentAlive(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	cp := newFakeControlPlane(t)
	c := newTestClient(t, cp.url(), pub, nil, &syncBuffer{})
	c.HeartbeatInterval = time.Hour
	stop := startClient(t, c)
	cp.next(t)

	cp.push(t, priv, &protocol.Welcome{
		Type:                protocol.TypeWelcome,
		ControlHeader:       header("m_overflow", time.Now().Add(time.Minute)),
		HeartbeatIntervalMS: math.MaxInt64,
	})
	if _, ok := cp.next(t).(*protocol.Heartbeat); !ok {
		t.Fatal("expected a heartbeat after the welcome")
	}
	if err := stop(); err != nil {
		t.Fatal(err)
	}
}

func TestShouldResetBackoff(t *testing.T) {
	if shouldResetBackoff(true, healthySession-time.Millisecond) {
		t.Error("a short-lived session must not reset backoff")
	}
	if shouldResetBackoff(false, time.Hour) {
		t.Error("a failed dial must not reset backoff")
	}
	if !shouldResetBackoff(true, healthySession) {
		t.Error("a healthy session must reset backoff")
	}
}

func TestClockOffsetIsCapped(t *testing.T) {
	c := &Client{Logger: slog.New(slog.DiscardHandler)}
	c.setClockOffset(-30 * 24 * time.Hour)
	if got := time.Duration(c.clockOffset.Load()); got != -maxClockOffset {
		t.Fatalf("offset = %v, want %v", got, -maxClockOffset)
	}
}

func TestRunWithoutLoggerOrState(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	cp := newFakeControlPlane(t)
	c := newTestClient(t, cp.url(), pub, nil, &syncBuffer{})
	c.Logger = nil
	startClient(t, c)
	cp.next(t)

	cp.push(t, priv, desired("m_1", 1, time.Now().Add(time.Minute)))
	waitFor(t, "in-memory generation", func() bool { return c.ObservedGeneration() == 1 })
}

func TestAgentOutdatedRetriesAtMaxBackoff(t *testing.T) {
	outdated := errors.Join(errors.New("read"), websocket.CloseError{Code: closeAgentOutdated, Reason: "agent_outdated"})
	if !isAgentOutdated(outdated) {
		t.Fatal("4002 not recognised")
	}
	if d := retryDelay(NewBackoff(time.Second, time.Minute), outdated); d != time.Minute {
		t.Errorf("outdated retry in %v, want the maximum", d)
	}
	removed := websocket.CloseError{Code: 4001, Reason: "node removed"}
	if isAgentOutdated(removed) || isAgentOutdated(errors.New("eof")) {
		t.Error("other closes are not agent_outdated")
	}
}
