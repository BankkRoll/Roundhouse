package conn

import (
	"crypto/ed25519"
	"crypto/rand"
	"math"
	"testing"
	"time"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

func TestClampMetricsInterval(t *testing.T) {
	ptr := func(v int64) *int64 { return &v }
	for _, tc := range []struct {
		ms   *int64
		want time.Duration
	}{
		{nil, 0},
		{ptr(0), 0},
		{ptr(-1), 0},
		{ptr(1), time.Second},
		{ptr(15_000), 15 * time.Second},
		{ptr(math.MaxInt64), 5 * time.Minute},
	} {
		if got := clampMetricsInterval(tc.ms); got != tc.want {
			t.Errorf("clampMetricsInterval(%v) = %v, want %v", tc.ms, got, tc.want)
		}
	}
}

func TestWelcomeSetsMetricsInterval(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	cp := newFakeControlPlane(t)
	c := newTestClient(t, cp.url(), pub, nil, &syncBuffer{})
	got := make(chan time.Duration, 16)
	c.MetricsInterval = func(d time.Duration) { got <- d }
	startClient(t, c)
	cp.next(t)

	next := func() time.Duration {
		t.Helper()
		select {
		case d := <-got:
			return d
		case <-time.After(5 * time.Second):
			t.Fatal("MetricsInterval not called")
			return 0
		}
	}
	future := time.Now().Add(time.Minute)
	ms := int64(15_000)
	cp.push(t, priv, &protocol.Welcome{
		Type: protocol.TypeWelcome, ControlHeader: header("m_w1", future),
		HeartbeatIntervalMS: 1000, MetricsIntervalMS: &ms,
	})
	if d := next(); d != 15*time.Second {
		t.Fatalf("interval = %v, want 15s", d)
	}
	cp.push(t, priv, &protocol.Welcome{
		Type: protocol.TypeWelcome, ControlHeader: header("m_w2", future), HeartbeatIntervalMS: 1000,
	})
	if d := next(); d != 0 {
		t.Fatalf("welcome without metrics_interval_ms gave %v, want 0", d)
	}
	cp.push(t, priv, &protocol.Welcome{
		Type: protocol.TypeWelcome, ControlHeader: header("m_w3", future),
		HeartbeatIntervalMS: 1000, MetricsIntervalMS: &ms,
	})
	if d := next(); d != 15*time.Second {
		t.Fatalf("interval = %v, want 15s", d)
	}
	cp.kick <- struct{}{}
	if d := next(); d != 0 {
		t.Fatalf("disconnect gave %v, want 0", d)
	}
}
