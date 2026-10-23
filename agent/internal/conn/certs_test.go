package conn

import (
	"crypto/ed25519"
	"crypto/rand"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/leaktest"
	"github.com/BankkRoll/Roundhouse/agent/internal/sealtest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// fakeCerts records the cert_sync frames it is handed.
type fakeCerts struct {
	mu  sync.Mutex
	got []string
}

func (f *fakeCerts) SyncCerts(m *protocol.CertSync) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, m.ID)
}

func (f *fakeCerts) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.got)
}

func certSync(t *testing.T, id string, ttl time.Duration, upsert bool) *protocol.CertSync {
	t.Helper()
	now := time.Now()
	m := &protocol.CertSync{
		Type:          protocol.TypeCertSync,
		ControlHeader: protocol.ControlHeader{ID: id, NodeID: testNodeID, IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(ttl).UnixMilli()},
		Upserts:       []protocol.CertUpsert{},
		Removes:       []string{},
	}
	if upsert {
		sha := strings.Repeat("a", 64)
		box := sealtest.SealCertKey(t, sealtest.Key().PublicKey(), testNodeID, "cer_1", sha, "-----BEGIN PRIVATE KEY-----\n")
		m.Upserts = []protocol.CertUpsert{{
			ID: "cer_1", Hostnames: []string{"shop.example.com"}, CertPEM: "-----BEGIN CERTIFICATE-----\n",
			SHA256: sha, KeySealed: *box, NotAfter: now.Add(90 * 24 * time.Hour).UnixMilli(),
		}}
	} else {
		m.Removes = []string{"cer_2"}
	}
	return m
}

func TestCertSyncIsDispatchedAndExpiresFast(t *testing.T) {
	leaktest.Check(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	cp := newFakeControlPlane(t)
	logs := &syncBuffer{}
	c := newTestClient(t, cp.url(), pub, nil, logs)
	certs := &fakeCerts{}
	c.Certs = certs
	stop := startClient(t, c)
	cp.next(t)

	future := time.Now().Add(time.Minute)
	cp.push(t, priv, &protocol.Welcome{Type: protocol.TypeWelcome, ControlHeader: header("m_w", future), HeartbeatIntervalMS: 10_000})
	waitFor(t, "a plain welcome", func() bool { return c.PeerProtocolVersion() == protocol.MinProtocolVersion })

	// SECURITY: a cert_sync carrying keys that lives longer than the
	// credential TTL is dropped before the handler sees it.
	cp.push(t, priv, certSync(t, "m_long", 2*time.Minute, true))
	cp.push(t, priv, certSync(t, "m_ok", 30*time.Second, true))
	cp.push(t, priv, certSync(t, "m_removes", 2*time.Minute, false))
	waitFor(t, "the cert_sync frames", func() bool { return len(certs.seen()) == 2 })
	if got := certs.seen(); !slices.Equal(got, []string{"m_ok", "m_removes"}) {
		t.Fatalf("dispatched %v", got)
	}
	if v := c.PeerProtocolVersion(); v != protocol.CertsProtocolVersion {
		t.Fatalf("peer version %d after cert_sync", v)
	}
	if err := stop(); err != nil {
		t.Fatal(err)
	}
}

func TestCertSyncWithoutHandlerIsDropped(t *testing.T) {
	leaktest.Check(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	cp := newFakeControlPlane(t)
	logs := &syncBuffer{}
	c := newTestClient(t, cp.url(), pub, nil, logs)
	stop := startClient(t, c)
	cp.next(t)
	cp.push(t, priv, certSync(t, "m_ok", 30*time.Second, true))
	waitFor(t, "the drop", func() bool { return strings.Contains(logs.String(), "no_handler") })
	if err := stop(); err != nil {
		t.Fatal(err)
	}
}

func TestDesiredStateVersionCertsFeatures(t *testing.T) {
	route := func(r protocol.WorkloadRoute) *protocol.DesiredState {
		return &protocol.DesiredState{Workloads: []protocol.WorkloadSpec{{Routes: []protocol.WorkloadRoute{r}}}}
	}
	for name, ds := range map[string]*protocol.DesiredState{
		"managed":  {TLSMode: protocol.TLSManaged},
		"hsts":     route(protocol.WorkloadRoute{Hostname: "a.example.com", HSTS: &protocol.RouteHSTS{MaxAge: 1}}),
		"wildcard": route(protocol.WorkloadRoute{Hostname: "*.example.com"}),
		"ingress":  {Ingress: &protocol.IngressSettings{}},
	} {
		if v := desiredStateVersion(ds); v != protocol.CertsProtocolVersion {
			t.Errorf("%s: %d", name, v)
		}
	}
	if v := desiredStateVersion(route(protocol.WorkloadRoute{Hostname: "a.example.com"})); v != protocol.MinProtocolVersion {
		t.Errorf("plain route: %d", v)
	}
}
