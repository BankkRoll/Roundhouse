package conn

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/leaktest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

func TestReplayGuard(t *testing.T) {
	var g replayGuard
	if !g.admit("m_1", 2000, 1000) {
		t.Fatal("a new frame was refused")
	}
	if g.admit("m_1", 2000, 1500) {
		t.Fatal("a replay within the TTL was admitted")
	}
	if !g.admit("m_2", 2000, 1500) {
		t.Fatal("another frame was refused")
	}
	// Past its exp the envelope check refuses the frame anyway; the ID may go.
	if !g.admit("m_1", 4000, 2001) {
		t.Fatal("an expired entry still blocks its ID")
	}
}

func TestReplayGuardStaysBounded(t *testing.T) {
	var g replayGuard
	for i := range maxRememberedFrames + 10 {
		g.admit("m_"+strconv.Itoa(i), 10_000, 1)
	}
	if n := len(g.seen); n > maxRememberedFrames {
		t.Fatalf("remembered %d frames, cap %d", n, maxRememberedFrames)
	}
}

func TestReplayedFramesAreDropped(t *testing.T) {
	leaktest.Check(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	cp := newFakeControlPlane(t)
	h := &fakeHandler{}
	logs := &syncBuffer{}
	c := newTestClient(t, cp.url(), pub, nil, logs)
	c.Handler = h
	stop := startClient(t, c)
	cp.next(t)

	env, err := protocol.SignEnvelope(buildJob("bld_1", time.Now().Add(time.Minute)), priv, "test")
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	cp.send <- data
	cp.send <- data
	cp.push(t, priv, buildJob("bld_2", time.Now().Add(time.Minute)))
	waitFor(t, "the second build", func() bool { _, b := h.snapshot(); return len(b) >= 2 })
	if _, builds := h.snapshot(); len(builds) != 2 || builds[0] != "bld_1" || builds[1] != "bld_2" {
		t.Fatalf("builds %v, want bld_1 once then bld_2", builds)
	}
	if !strings.Contains(logs.String(), `"reason":"replayed"`) {
		t.Error("no replayed rejection logged")
	}
	if err := stop(); err != nil {
		t.Fatal(err)
	}
}
