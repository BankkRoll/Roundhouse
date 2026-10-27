package certs

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/ingress"
	"github.com/BankkRoll/Roundhouse/agent/internal/leaktest"
	"github.com/BankkRoll/Roundhouse/agent/internal/sealtest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// fakeIngress records certificate sets.
type fakeIngress struct {
	mu   sync.Mutex
	sets [][]ingress.Certificate
}

func (f *fakeIngress) SetCertificates(_ context.Context, certs []ingress.Certificate) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sets = append(f.sets, slices.Clone(certs))
	return nil
}

// last returns the latest set, by ID.
func (f *fakeIngress) last() map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]string{}
	if len(f.sets) > 0 {
		for _, c := range f.sets[len(f.sets)-1] {
			out[c.ID] = c.SHA256
		}
	}
	return out
}

// sender records frames.
type sender struct {
	mu      sync.Mutex
	frames  []protocol.AgentMessage
	enabled bool
	fail    bool
}

func (s *sender) Send(_ context.Context, m protocol.AgentMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return errors.New("not connected")
	}
	s.frames = append(s.frames, m)
	return nil
}

func (s *sender) Enabled() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.enabled
}

// snapshot returns the recorded frames.
func (s *sender) snapshot() []protocol.AgentMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.frames)
}

// take returns and forgets the recorded frames.
func (s *sender) take() []protocol.AgentMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.frames
	s.frames = nil
	return out
}

type storeEnv struct {
	dir, index string
	ing        *fakeIngress
	send       *sender
	now        time.Time
}

func newStoreEnv(t *testing.T) *storeEnv {
	root := t.TempDir()
	return &storeEnv{
		dir: filepath.Join(root, "certs"), index: filepath.Join(root, "data", "certs.json"),
		ing: &fakeIngress{}, send: &sender{enabled: true}, now: time.Now(),
	}
}

func (e *storeEnv) open(t *testing.T) *Store {
	t.Helper()
	s, err := NewStore(StoreOptions{
		Dir: e.dir, IndexPath: e.index, NodeID: testNode, Key: sealtest.Key(), Group: "roundhouse-no-such-group",
		Ingress: e.ing, Send: e.send.Send, Enabled: e.send.Enabled, Now: func() time.Time { return e.now },
	})
	if err != nil {
		t.Fatal(err)
	}
	// Pacing runs on the wall clock; TestStorePacesFrames covers it.
	s.requestBudget, s.ackBudget = frameBudget{}, frameBudget{}
	return s
}

func sync1(upserts []protocol.CertUpsert, removes ...string) *protocol.CertSync {
	return &protocol.CertSync{Type: protocol.TypeCertSync, Upserts: upserts, Removes: removes}
}

func ids(frames []protocol.AgentMessage, typ string) [][]string {
	var out [][]string
	for _, f := range frames {
		switch m := f.(type) {
		case *protocol.CertAck:
			if typ == protocol.TypeCertAck {
				out = append(out, m.IDs)
			}
		case *protocol.CertRequest:
			if typ == protocol.TypeCertRequest {
				out = append(out, m.IDs)
			}
		}
	}
	return out
}

func TestStoreWritesLoadsThenAcks(t *testing.T) {
	ca := newCA(t)
	e := newStoreEnv(t)
	s := e.open(t)
	ctx := context.Background()
	a := ca.valid(t, "shop.example.com")
	ua := upsert(t, "cer_a", a, "shop.example.com")
	s.SetManifest([]protocol.CertificateRef{{ID: "cer_a", SHA256: ua.SHA256}})
	s.housekeep(ctx)
	if got := ids(e.send.take(), protocol.TypeCertRequest); len(got) != 1 || !slices.Equal(got[0], []string{"cer_a"}) {
		t.Fatalf("requests = %v", got)
	}

	s.apply(ctx, sync1([]protocol.CertUpsert{ua}))
	s.housekeep(ctx)
	path := filepath.Join(e.dir, "cer_a.pem")
	data, err := os.ReadFile(path)
	if err != nil || string(data) != a.chain+a.key {
		t.Fatalf("file = %q, %v", data, err)
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(path)
		if fi.Mode().Perm() != 0o640 {
			t.Fatalf("mode %v", fi.Mode())
		}
		di, _ := os.Stat(e.dir)
		if di.Mode().Perm() != 0o700 {
			t.Fatalf("dir mode %v without the caddy group", di.Mode())
		}
	}
	if got := e.ing.last(); !maps.Equal(got, map[string]string{"cer_a": ua.SHA256}) {
		t.Fatalf("ingress = %v", got)
	}
	// SECURITY: no ack before Caddy runs a config with this digest.
	if f := e.send.take(); len(f) != 0 {
		t.Fatalf("sent before the load: %v", f)
	}
	s.Loaded(ingress.Loaded{TLSMode: protocol.TLSManaged, Certificates: map[string]string{"cer_a": otherDigest(ua.SHA256)}})
	s.housekeep(ctx)
	if f := e.send.take(); len(f) != 0 {
		t.Fatalf("acked another digest: %v", f)
	}
	s.Loaded(ingress.Loaded{TLSMode: protocol.TLSManaged, Certificates: map[string]string{"cer_a": ua.SHA256}})
	s.housekeep(ctx)
	if got := ids(e.send.take(), protocol.TypeCertAck); len(got) != 1 || !slices.Equal(got[0], []string{"cer_a"}) {
		t.Fatalf("acks = %v", got)
	}
	s.housekeep(ctx)
	if f := e.send.take(); len(f) != 0 {
		t.Fatalf("acked twice: %v", f)
	}
	s.Connected()
	s.housekeep(ctx)
	if got := ids(e.send.take(), protocol.TypeCertAck); len(got) != 1 {
		t.Fatalf("no ack after reconnect: %v", got)
	}

	// A renewal is listed, requested, written over the same file and acked
	// once loaded.
	a2 := ca.valid(t, "shop.example.com")
	ua2 := upsert(t, "cer_a", a2, "shop.example.com")
	s.SetManifest([]protocol.CertificateRef{{ID: "cer_a", SHA256: ua2.SHA256}})
	s.Connected()
	s.housekeep(ctx)
	f := e.send.take()
	if got := ids(f, protocol.TypeCertAck); len(got) != 0 {
		t.Fatalf("re-acked the replaced digest after a reconnect: %v", got)
	}
	if got := ids(f, protocol.TypeCertRequest); len(got) != 1 {
		t.Fatalf("renewal not requested: %v", got)
	}
	s.apply(ctx, sync1([]protocol.CertUpsert{ua2}))
	if got := e.ing.last(); got["cer_a"] != ua2.SHA256 {
		t.Fatalf("renewal not handed over: %v", got)
	}
	s.housekeep(ctx)
	if f := e.send.take(); len(f) != 0 {
		t.Fatalf("renewal acked before caddy loaded it: %v", f)
	}
	s.Loaded(ingress.Loaded{TLSMode: protocol.TLSManaged, Certificates: map[string]string{"cer_a": ua2.SHA256}})
	s.housekeep(ctx)
	if got := ids(e.send.take(), protocol.TypeCertAck); len(got) != 1 {
		t.Fatalf("renewal not acked: %v", got)
	}
	if entries, _ := os.ReadDir(e.dir); len(entries) != 1 {
		t.Fatalf("leftover files: %v", entries)
	}
}

func TestStoreRejectsBadUpserts(t *testing.T) {
	ca := newCA(t)
	e := newStoreEnv(t)
	s := e.open(t)
	good := ca.valid(t, "shop.example.com")
	bad := upsert(t, "cer_bad", good, "evil.example.com")
	s.apply(context.Background(), sync1([]protocol.CertUpsert{bad, upsert(t, "cer_ok", good, "shop.example.com")}))
	if got := s.Held(); len(got) != 1 || got["cer_ok"] == "" {
		t.Fatalf("held = %v", got)
	}
	if _, err := os.Stat(filepath.Join(e.dir, "cer_bad.pem")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a rejected certificate was written")
	}
}

func TestStoreRequestsBackOff(t *testing.T) {
	e := newStoreEnv(t)
	s := e.open(t)
	ctx := context.Background()
	sha := digest("x")
	s.SetManifest([]protocol.CertificateRef{{ID: "cer_x", SHA256: sha}, {ID: "cer_y", SHA256: sha}})
	requests := func() [][]string { s.housekeep(ctx); return ids(e.send.take(), protocol.TypeCertRequest) }
	if got := requests(); len(got) != 1 || !slices.Equal(got[0], []string{"cer_x", "cer_y"}) {
		t.Fatalf("first = %v", got)
	}
	e.now = e.now.Add(10 * time.Second)
	if got := requests(); len(got) != 0 {
		t.Fatalf("re-requested within 30 s: %v", got)
	}
	e.now = e.now.Add(20 * time.Second)
	if got := requests(); len(got) != 1 {
		t.Fatalf("not re-requested after 30 s: %v", got)
	}
	e.now = e.now.Add(30 * time.Second)
	if got := requests(); len(got) != 0 {
		t.Fatalf("no backoff: %v", got)
	}
	e.now = e.now.Add(30 * time.Second)
	if got := requests(); len(got) != 1 {
		t.Fatalf("not re-requested after 60 s: %v", got)
	}
	// A reconnect asks again at once; nothing is sent while disabled.
	e.send.enabled = false
	s.Connected()
	if got := requests(); len(got) != 0 {
		t.Fatalf("sent to an older control plane: %v", got)
	}
	e.send.enabled = true
	if got := requests(); len(got) != 1 {
		t.Fatalf("not requested after reconnect: %v", got)
	}
	// A failed send is retried on the next pass.
	s.Connected()
	e.send.fail = true
	_ = requests()
	e.send.fail = false
	if got := requests(); len(got) != 1 {
		t.Fatalf("not retried after a failed send: %v", got)
	}
}

func TestStorePrunesByManifestAfterCaddyDropsTheFile(t *testing.T) {
	ca := newCA(t)
	e := newStoreEnv(t)
	s := e.open(t)
	ctx := context.Background()
	a, b := ca.valid(t, "a.example.com"), ca.valid(t, "b.example.com")
	ua, ub := upsert(t, "cer_a", a, "a.example.com"), upsert(t, "cer_b", b, "b.example.com")
	s.SetManifest([]protocol.CertificateRef{{ID: "cer_a", SHA256: ua.SHA256}, {ID: "cer_b", SHA256: ub.SHA256}})
	s.apply(ctx, sync1([]protocol.CertUpsert{ua, ub}))
	s.Loaded(ingress.Loaded{Certificates: map[string]string{"cer_a": ua.SHA256, "cer_b": ub.SHA256}})
	s.housekeep(ctx)

	s.SetManifest([]protocol.CertificateRef{{ID: "cer_a", SHA256: ua.SHA256}})
	s.housekeep(ctx)
	if got := e.ing.last(); len(got) != 1 || got["cer_b"] != "" {
		t.Fatalf("pruned certificate still loaded: %v", got)
	}
	// Caddy still runs the old config, so the file stays.
	if _, err := os.Stat(filepath.Join(e.dir, "cer_b.pem")); err != nil {
		t.Fatalf("file removed while caddy may read it: %v", err)
	}
	s.Loaded(ingress.Loaded{Certificates: map[string]string{"cer_a": ua.SHA256}})
	s.housekeep(ctx)
	if _, err := os.Stat(filepath.Join(e.dir, "cer_b.pem")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("pruned file kept: %v", err)
	}

	// cert_sync removes work the same way.
	s.apply(ctx, sync1(nil, "cer_a"))
	if got := e.ing.last(); len(got) != 0 {
		t.Fatalf("removed certificate still loaded: %v", got)
	}
	s.Loaded(ingress.Loaded{Certificates: map[string]string{}})
	s.housekeep(ctx)
	if _, err := os.Stat(filepath.Join(e.dir, "cer_a.pem")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("removed file kept: %v", err)
	}
}

func TestStoreRestoresAcrossRestart(t *testing.T) {
	ca := newCA(t)
	e := newStoreEnv(t)
	s := e.open(t)
	ctx := context.Background()
	a, b, c := ca.valid(t, "a.example.com"), ca.valid(t, "b.example.com"), ca.valid(t, "c.example.com")
	ua, ub, uc := upsert(t, "cer_a", a, "a.example.com"), upsert(t, "cer_b", b, "b.example.com"), upsert(t, "cer_c", c, "c.example.com")
	s.SetManifest([]protocol.CertificateRef{{ID: "cer_a", SHA256: ua.SHA256}, {ID: "cer_b", SHA256: ub.SHA256}, {ID: "cer_c", SHA256: uc.SHA256}})
	s.housekeep(ctx)
	s.apply(ctx, sync1([]protocol.CertUpsert{ua, ub, uc}))
	// An orphan the index does not know, and a file changed behind the
	// agent's back.
	if err := os.WriteFile(filepath.Join(e.dir, "cer_orphan.pem"), []byte(a.chain+a.key), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.dir, "cer_c.pem"), []byte(b.chain+b.key), 0o600); err != nil {
		t.Fatal(err)
	}

	e.ing = &fakeIngress{}
	s2 := e.open(t)
	if got := s2.Held(); !maps.Equal(got, map[string]string{"cer_a": ua.SHA256, "cer_b": ub.SHA256}) {
		t.Fatalf("restored %v", got)
	}
	if got := e.ing.last(); len(got) != 2 {
		t.Fatalf("restored certificates not handed to the ingress: %v", got)
	}
	// Nothing is deleted before Caddy's running config is known.
	s2.housekeep(ctx)
	if _, err := os.Stat(filepath.Join(e.dir, "cer_orphan.pem")); err != nil {
		t.Fatal("orphan deleted before caddy's config was known")
	}
	s2.Loaded(ingress.Loaded{Certificates: map[string]string{"cer_a": ua.SHA256, "cer_b": ub.SHA256}})
	s2.housekeep(ctx)
	for _, id := range []string{"cer_orphan", "cer_c"} {
		if _, err := os.Stat(filepath.Join(e.dir, id+".pem")); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s kept", id)
		}
	}
	if got := ids(e.send.take(), protocol.TypeCertRequest); len(got) == 0 || !slices.Contains(got[len(got)-1], "cer_c") {
		t.Fatalf("damaged certificate not requested again: %v", got)
	}

	// Only entries still in the persisted manifest come back.
	s2.SetManifest([]protocol.CertificateRef{{ID: "cer_a", SHA256: ua.SHA256}})
	s2.housekeep(ctx)
	e.ing = &fakeIngress{}
	if got := e.open(t).Held(); !maps.Equal(got, map[string]string{"cer_a": ua.SHA256}) {
		t.Fatalf("restored %v", got)
	}

	// An expired certificate is not restored.
	e.now = e.now.Add(100 * 24 * time.Hour)
	if got := e.open(t).Held(); len(got) != 0 {
		t.Fatalf("restored expired %v", got)
	}
}

func TestStoreRunProcessesFrames(t *testing.T) {
	leaktest.Check(t)
	ca := newCA(t)
	e := newStoreEnv(t)
	s := e.open(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()
	a := ca.valid(t, "a.example.com")
	ua := upsert(t, "cer_a", a, "a.example.com")
	s.SyncCerts(sync1([]protocol.CertUpsert{ua}))
	deadline := time.Now().Add(5 * time.Second)
	for e.ing.last()["cer_a"] == "" {
		if time.Now().After(deadline) {
			t.Fatal("frame not processed")
		}
		time.Sleep(5 * time.Millisecond)
	}
	s.Loaded(ingress.Loaded{Certificates: map[string]string{"cer_a": ua.SHA256}})
	for len(ids(e.send.snapshot(), protocol.TypeCertAck)) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("ack not sent")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// otherDigest returns a digest that differs from d in its first character.
func otherDigest(d string) string {
	if d[0] == '0' {
		return "1" + d[1:]
	}
	return "0" + d[1:]
}

func TestStorePacesFrames(t *testing.T) {
	ca := newCA(t)
	e := newStoreEnv(t)
	s := e.open(t)
	s.requestBudget, s.ackBudget = frameBudget{per: 1}, frameBudget{per: 1}
	ctx := context.Background()
	elapse := func(b *frameBudget) { b.start = b.start.Add(-time.Second) }

	refs := make([]protocol.CertificateRef, 0, 300)
	for i := range 300 {
		refs = append(refs, protocol.CertificateRef{ID: fmt.Sprintf("cer_%03d", i), SHA256: digest("x")})
	}
	s.SetManifest(refs)
	s.housekeep(ctx)
	if got := ids(e.send.take(), protocol.TypeCertRequest); len(got) != 1 || len(got[0]) != requestChunk {
		t.Fatalf("first pass = %d frames", len(got))
	}
	s.housekeep(ctx)
	if got := ids(e.send.take(), protocol.TypeCertRequest); len(got) != 0 {
		t.Fatalf("sent %d requests over the budget", len(got))
	}
	if s.retry == nil {
		t.Fatal("no wake-up armed for the requests held back")
	}
	var asked []string
	for range 2 {
		elapse(&s.requestBudget)
		s.housekeep(ctx)
		got := ids(e.send.take(), protocol.TypeCertRequest)
		if len(got) != 1 {
			t.Fatalf("after a second = %d frames", len(got))
		}
		asked = append(asked, got[0]...)
	}
	if len(asked) != 300-requestChunk || slices.Contains(asked, "cer_000") {
		t.Fatalf("held-back requests = %d IDs", len(asked))
	}

	a := ca.valid(t, "a.example.com")
	ua := upsert(t, "cer_a", a, "a.example.com")
	s.SetManifest([]protocol.CertificateRef{{ID: "cer_a", SHA256: ua.SHA256}})
	s.apply(ctx, sync1([]protocol.CertUpsert{ua}))
	s.Loaded(ingress.Loaded{Certificates: map[string]string{"cer_a": ua.SHA256}})
	s.housekeep(ctx)
	if got := ids(e.send.take(), protocol.TypeCertAck); len(got) != 1 {
		t.Fatalf("acks = %v", got)
	}
	s.Connected()
	s.housekeep(ctx)
	if got := ids(e.send.take(), protocol.TypeCertAck); len(got) != 0 {
		t.Fatalf("acked over the budget: %v", got)
	}
	elapse(&s.ackBudget)
	s.housekeep(ctx)
	if got := ids(e.send.take(), protocol.TypeCertAck); len(got) != 1 {
		t.Fatalf("held-back ack not sent: %v", got)
	}
}

func TestStoreAppliesFramesTogether(t *testing.T) {
	ca := newCA(t)
	e := newStoreEnv(t)
	s := e.open(t)
	a, b := ca.valid(t, "a.example.com"), ca.valid(t, "b.example.com")
	e.ing.mu.Lock()
	before := len(e.ing.sets)
	e.ing.mu.Unlock()
	s.apply(context.Background(),
		sync1([]protocol.CertUpsert{upsert(t, "cer_a", a, "a.example.com")}),
		sync1([]protocol.CertUpsert{upsert(t, "cer_b", b, "b.example.com")}))
	e.ing.mu.Lock()
	n := len(e.ing.sets) - before
	e.ing.mu.Unlock()
	if got := e.ing.last(); n != 1 || len(got) != 2 {
		t.Fatalf("%d certificate sets, last %v; want one with both", n, got)
	}
}
