package certs

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/ingress"
	"github.com/BankkRoll/Roundhouse/agent/internal/leaktest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

func TestParseEvent(t *testing.T) {
	for _, tc := range []struct {
		line string
		want Event
		ok   bool
	}{
		{`{"level":"info","ts":1,"logger":"tls.obtain","msg":"obtaining certificate","identifier":"Shop.Example.com"}`,
			Event{Host: "shop.example.com", Kind: EventPending}, true},
		{`{"level":"info","logger":"tls.on_demand","msg":"obtaining new certificate","remote_ip":"1.2.3.4","server_name":"shop.example.com"}`,
			Event{Host: "shop.example.com", Kind: EventPending}, true},
		{`{"level":"info","logger":"tls.obtain","msg":"certificate obtained successfully","identifier":"shop.example.com","issuer":"acme-v02.api.letsencrypt.org-directory"}`,
			Event{Host: "shop.example.com", Kind: EventObtained}, true},
		{`{"level":"info","logger":"tls.renew","msg":"certificate renewed successfully","identifier":"shop.example.com"}`,
			Event{Host: "shop.example.com", Kind: EventObtained, Renewal: true}, true},
		{`{"level":"error","logger":"tls.obtain","msg":"could not get certificate from issuer","identifier":"shop.example.com","issuer":"acme-v02.api.letsencrypt.org-directory","error":"HTTP 400 urn:ietf:params:acme:error:dns - DNS problem: NXDOMAIN"}`,
			Event{Host: "shop.example.com", Kind: EventFailed, Error: "HTTP 400 urn:ietf:params:acme:error:dns - DNS problem: NXDOMAIN"}, true},
		{`{"level":"error","logger":"tls.renew","msg":"could not get certificate from issuer","identifier":"shop.example.com"}`,
			Event{Host: "shop.example.com", Kind: EventFailed, Renewal: true, Error: "could not get certificate from issuer"}, true},
		{`{"level":"error","logger":"tls.obtain","msg":"will retry","error":"[shop.example.com] Obtain: [shop.example.com] solving challenges: timeout","attempt":1}`,
			Event{Host: "shop.example.com", Kind: EventFailed, Error: "[shop.example.com] Obtain: [shop.example.com] solving challenges: timeout"}, true},
		{`{"level":"error","logger":"tls.obtain","msg":"final attempt; giving up","error":"[shop.example.com] Obtain: x"}`,
			Event{Host: "shop.example.com", Kind: EventFailed, Error: "[shop.example.com] Obtain: x"}, true},
		{`{"logger":"tls.obtain","msg":"will retry","error":"no host prefix"}`, Event{}, false},
		{`{"logger":"tls.obtain","msg":"acquiring lock","identifier":"shop.example.com"}`, Event{}, false},
		{`{"logger":"http.log","msg":"obtaining certificate","identifier":"shop.example.com"}`, Event{}, false},
		{`{"logger":"tls.obtain","msg":"obtaining certificate"}`, Event{}, false},
		{`not json`, Event{}, false},
	} {
		got, ok := ParseEvent([]byte(tc.line))
		if ok != tc.ok || got != tc.want {
			t.Errorf("%s\n got %+v %v, want %+v %v", tc.line, got, ok, tc.want, tc.ok)
		}
	}
}

func TestListenLogLoopbackOnly(t *testing.T) {
	if _, err := ListenLog("0.0.0.0:0"); err == nil {
		t.Fatal("non-loopback address accepted")
	}
	if _, err := ListenLog("localhost:0"); err == nil {
		t.Fatal("hostname accepted")
	}
}

func TestServeLogOn(t *testing.T) {
	leaktest.Check(t)
	ln, err := ListenLog("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var got []Event
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- ServeLogOn(ctx, ln, func(ev Event) { mu.Lock(); got = append(got, ev); mu.Unlock() })
	}()
	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	_, _ = c.Write([]byte(`{"logger":"tls.obtain","msg":"obtaining certificate","identifier":"a.example.com"}` + "\n" +
		`{"logger":"tls.obtain","msg":"lock acquired"}` + "\n" +
		`{"logger":"tls.obtain","msg":"certificate obtained successfully","identifier":"a.example.com"}` + "\n"))
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		n := len(got)
		mu.Unlock()
		if n == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("events = %d", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
	// The connection stays open, as Caddy keeps it; shutdown closes it.
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	c.Close()
}

// prober answers probes from a table.
type prober struct {
	mu     sync.Mutex
	leaves map[string]*x509.Certificate
	errs   map[string]error
	calls  map[string]int
}

func (p *prober) probe(_ context.Context, host string) (*x509.Certificate, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls[host]++
	if err := p.errs[host]; err != nil {
		return nil, err
	}
	if l := p.leaves[host]; l != nil {
		return l, nil
	}
	return nil, errors.New("remote error: tls: internal error")
}

func (p *prober) count(host string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls[host]
}

func statuses(frames []protocol.AgentMessage) []protocol.CertStatus {
	var out []protocol.CertStatus
	for _, f := range frames {
		if m, ok := f.(*protocol.CertStatus); ok {
			out = append(out, *m)
		}
	}
	return out
}

type trackerEnv struct {
	tr   *Tracker
	p    *prober
	send *sender
	now  time.Time
	mu   sync.Mutex
}

func newTrackerEnv(t *testing.T) *trackerEnv {
	e := &trackerEnv{p: &prober{leaves: map[string]*x509.Certificate{}, errs: map[string]error{}, calls: map[string]int{}},
		send: &sender{enabled: true}, now: time.Now()}
	e.tr = NewTracker(TrackerOptions{
		Send: e.send.Send, Enabled: e.send.Enabled, Probe: e.p.probe, Recheck: time.Hour,
		Now: func() time.Time { e.mu.Lock(); defer e.mu.Unlock(); return e.now },
	})
	return e
}

// drain runs queued probes and sends, synchronously.
func (e *trackerEnv) drain(ctx context.Context) {
	for {
		e.tr.mu.Lock()
		var host string
		if len(e.tr.pending) > 0 {
			host, e.tr.pending = e.tr.pending[0], e.tr.pending[1:]
		}
		e.tr.mu.Unlock()
		if host == "" {
			break
		}
		e.tr.probe(ctx, host)
	}
	e.tr.flush(ctx)
}

func TestTrackerReportsOnChangeOnly(t *testing.T) {
	ca := newCA(t)
	e := newTrackerEnv(t)
	ctx := context.Background()
	leaf := ca.valid(t, "a.example.com").leaf
	e.p.leaves["a.example.com"] = leaf
	e.tr.Loaded(ingress.Loaded{TLSMode: protocol.TLSACME, Hosts: []string{"a.example.com", "b.example.com"}})
	e.drain(ctx)
	got := statuses(e.send.take())
	if len(got) != 2 {
		t.Fatalf("statuses = %+v", got)
	}
	a, b := got[0], got[1]
	if a.Hostname != "a.example.com" || a.State != protocol.CertIssued || a.Issuer != "Roundhouse Test Test CA R1" ||
		a.NotAfter == nil || *a.NotAfter != leaf.NotAfter.UnixMilli() || a.Error != "" {
		t.Fatalf("a = %+v", a)
	}
	if b.State != protocol.CertFailed || !strings.Contains(b.Error, "TLS handshake failed") {
		t.Fatalf("b = %+v", b)
	}

	// Nothing changed: nothing sent, even on a re-check.
	e.tr.Loaded(ingress.Loaded{TLSMode: protocol.TLSACME, Hosts: []string{"a.example.com", "b.example.com"}})
	e.tr.mu.Lock()
	e.tr.enqueue("a.example.com")
	e.tr.mu.Unlock()
	e.drain(ctx)
	if f := e.send.take(); len(f) != 0 {
		t.Fatalf("resent unchanged statuses: %+v", statuses(f))
	}

	// Caddy's log says b is being issued, then failed with a reason.
	e.tr.HandleEvent(Event{Host: "b.example.com", Kind: EventPending})
	e.drain(ctx)
	if got := statuses(e.send.take()); len(got) != 1 || got[0].State != protocol.CertPending {
		t.Fatalf("pending = %+v", got)
	}
	e.tr.HandleEvent(Event{Host: "b.example.com", Kind: EventFailed, Error: "DNS problem: NXDOMAIN"})
	e.drain(ctx)
	if got := statuses(e.send.take()); len(got) != 1 || got[0].Error != "DNS problem: NXDOMAIN" {
		t.Fatalf("failed = %+v", got)
	}
	// An obtained event alone proves nothing; the handshake does.
	e.tr.HandleEvent(Event{Host: "b.example.com", Kind: EventObtained})
	e.drain(ctx)
	if f := e.send.take(); len(f) != 0 {
		t.Fatalf("issued without a certificate: %+v", statuses(f))
	}
	e.p.mu.Lock()
	e.p.leaves["b.example.com"] = ca.valid(t, "b.example.com").leaf
	e.p.mu.Unlock()
	e.tr.HandleEvent(Event{Host: "b.example.com", Kind: EventObtained})
	e.drain(ctx)
	if got := statuses(e.send.take()); len(got) != 1 || got[0].State != protocol.CertIssued {
		t.Fatalf("issued = %+v", got)
	}

	// A failed renewal of a valid certificate keeps it issued.
	e.tr.HandleEvent(Event{Host: "a.example.com", Kind: EventFailed, Renewal: true, Error: "rate limited"})
	e.drain(ctx)
	if f := e.send.take(); len(f) != 0 {
		t.Fatalf("renewal failure reported: %+v", statuses(f))
	}

	// After a reconnect everything is sent again.
	e.tr.Connected()
	e.drain(ctx)
	if got := statuses(e.send.take()); len(got) != 2 {
		t.Fatalf("after reconnect = %+v", got)
	}
}

func TestTrackerGatesAndForgets(t *testing.T) {
	ca := newCA(t)
	e := newTrackerEnv(t)
	ctx := context.Background()
	e.p.leaves["a.example.com"] = ca.valid(t, "a.example.com").leaf
	e.p.leaves["x.example.com"] = ca.valid(t, "other.example.com").leaf

	// Never sent to a control plane below the certificates version.
	e.send.enabled = false
	e.tr.Loaded(ingress.Loaded{TLSMode: protocol.TLSACME, Hosts: []string{"a.example.com", "x.example.com"}})
	e.drain(ctx)
	if f := e.send.take(); len(f) != 0 {
		t.Fatalf("sent while disabled: %+v", f)
	}
	e.send.enabled = true
	e.tr.Connected()
	e.drain(ctx)
	got := statuses(e.send.take())
	if len(got) != 2 || got[1].State != protocol.CertFailed || !strings.Contains(got[1].Error, "does not cover x.example.com") {
		t.Fatalf("after enabling = %+v", got)
	}

	// Hosts no longer listed are forgotten; other modes track nothing.
	e.tr.Loaded(ingress.Loaded{TLSMode: protocol.TLSManaged, Hosts: []string{"a.example.com"}})
	if _, ok := e.tr.Status("x.example.com"); ok {
		t.Fatal("unrouted host still tracked")
	}
	e.tr.HandleEvent(Event{Host: "x.example.com", Kind: EventFailed, Error: "x"})
	e.drain(ctx)
	if f := e.send.take(); len(f) != 0 {
		t.Fatalf("reported an untracked host: %+v", statuses(f))
	}
	e.tr.Loaded(ingress.Loaded{TLSMode: protocol.TLSInternal, Hosts: []string{"a.example.com"}})
	e.tr.Connected()
	e.drain(ctx)
	if f := e.send.take(); len(f) != 0 || len(e.tr.hosts) != 0 {
		t.Fatalf("internal mode reported: %+v", statuses(f))
	}
	// Wildcards are never probed.
	e.tr.Loaded(ingress.Loaded{TLSMode: protocol.TLSACME, Hosts: []string{"*.example.com"}})
	if len(e.tr.hosts) != 0 {
		t.Fatal("wildcard tracked")
	}
}

func TestTrackerTimeoutIsPendingAndErrorsAreBounded(t *testing.T) {
	e := newTrackerEnv(t)
	ctx := context.Background()
	e.p.errs["slow.example.com"] = context.DeadlineExceeded
	e.tr.Loaded(ingress.Loaded{TLSMode: protocol.TLSACME, Hosts: []string{"slow.example.com"}})
	e.drain(ctx)
	if got := statuses(e.send.take()); len(got) != 1 || got[0].State != protocol.CertPending {
		t.Fatalf("timeout = %+v", got)
	}
	e.tr.HandleEvent(Event{Host: "slow.example.com", Kind: EventFailed, Error: strings.Repeat("é", 5000)})
	e.drain(ctx)
	got := statuses(e.send.take())
	if len(got) != 1 || len(got[0].Error) > protocol.MaxMessageBytes || got[0].Validate() != nil {
		t.Fatalf("long error = %d bytes", len(got[0].Error))
	}
}

func TestTrackerRechecks(t *testing.T) {
	ca := newCA(t)
	e := newTrackerEnv(t)
	ctx := context.Background()
	e.p.leaves["a.example.com"] = ca.valid(t, "a.example.com").leaf
	e.tr.Loaded(ingress.Loaded{TLSMode: protocol.TLSACME, Hosts: []string{"a.example.com"}})
	e.drain(ctx)
	e.tr.recheck()
	e.drain(ctx)
	if n := e.p.count("a.example.com"); n != 1 {
		t.Fatalf("re-checked early: %d probes", n)
	}
	e.mu.Lock()
	e.now = e.now.Add(70 * time.Minute)
	e.mu.Unlock()
	renewed := ca.issue(t, time.Now().Add(-time.Hour), time.Now().Add(100*24*time.Hour), "a.example.com").leaf
	e.p.mu.Lock()
	e.p.leaves["a.example.com"] = renewed
	e.p.mu.Unlock()
	e.tr.recheck()
	e.drain(ctx)
	got := statuses(e.send.take())
	if e.p.count("a.example.com") != 2 || len(got) != 2 || *got[1].NotAfter != renewed.NotAfter.UnixMilli() {
		t.Fatalf("re-check: %d probes, %+v", e.p.count("a.example.com"), got)
	}
}

func TestTrackerRunProbesWithRealHandshake(t *testing.T) {
	leaktest.Check(t)
	ca := newCA(t)
	c := ca.valid(t, "a.example.com")
	srv := tlsServer(t, c)
	send := &sender{enabled: true}
	tr := NewTracker(TrackerOptions{HTTPSAddr: srv, Send: send.Send, Enabled: send.Enabled, HandshakeTimeout: 5 * time.Second})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- tr.Run(ctx) }()
	tr.Loaded(ingress.Loaded{TLSMode: protocol.TLSACME, Hosts: []string{"a.example.com"}})
	deadline := time.Now().Add(5 * time.Second)
	for len(statuses(send.snapshot())) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("no status")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := statuses(send.snapshot())[0]; got.State != protocol.CertIssued {
		t.Fatalf("status = %+v", got)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// tlsServer serves c on a loopback port and returns its address.
func tlsServer(t *testing.T, c issued) string {
	t.Helper()
	pair, err := tls.X509KeyPair([]byte(c.chain), []byte(c.key))
	if err != nil {
		t.Fatal(err)
	}
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{pair}})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			_ = conn.(*tls.Conn).Handshake()
			conn.Close()
		}
	}()
	t.Cleanup(func() { ln.Close(); <-done })
	return ln.Addr().String()
}

func TestTrackerPacesStatuses(t *testing.T) {
	e := newTrackerEnv(t)
	ctx := context.Background()
	hosts := make([]string, 0, statusesPerSecond+4)
	for i := range cap(hosts) {
		hosts = append(hosts, fmt.Sprintf("h%02d.example.com", i))
	}
	e.tr.Loaded(ingress.Loaded{TLSMode: protocol.TLSACME, Hosts: hosts})
	e.drain(ctx)
	if got := statuses(e.send.take()); len(got) != statusesPerSecond {
		t.Fatalf("sent %d statuses in one second", len(got))
	}
	if e.tr.retry == nil {
		t.Fatal("no wake-up armed for the statuses held back")
	}
	e.tr.budget.start = e.tr.budget.start.Add(-time.Second)
	e.tr.flush(ctx)
	if got := statuses(e.send.take()); len(got) != 4 {
		t.Fatalf("held-back statuses = %d, want 4", len(got))
	}
}
