package ingress

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"slices"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"

	"github.com/BankkRoll/Roundhouse/agent/internal/leaktest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// serveDNS starts m's DNS server on loopback and returns a resolver built
// the way Caddy builds the one for its "a" upstream source: the Go resolver,
// dialing only that address.
func serveDNS(t *testing.T, m *Manager) (*net.Resolver, string) {
	t.Helper()
	pc, ln, err := ListenDNS("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- m.ServeDNSOn(ctx, pc, ln) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("ServeDNSOn: %v", err)
		}
	})
	addr := pc.LocalAddr().String()
	d := net.Dialer{Timeout: time.Second}
	return &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return d.DialContext(ctx, network, addr)
		},
	}, addr
}

func addrsOf(ips []net.IP) []netip.Addr {
	out := make([]netip.Addr, 0, len(ips))
	for _, ip := range ips {
		a, _ := netip.AddrFromSlice(ip.To4())
		out = append(out, a)
	}
	slices.SortFunc(out, func(a, b netip.Addr) int { return a.Compare(b) })
	return out
}

func TestDNSAnswersUpstreams(t *testing.T) {
	leaktest.Check(t)
	m := New(Options{AdminURL: "http://127.0.0.1:1"})
	res, _ := serveDNS(t, m)
	ctx := context.Background()
	route := Route{Host: "app.example.com", Upstreams: []string{"172.18.0.3:80", "172.18.0.2:80"}}
	_ = m.Apply(ctx, Config{TLSMode: protocol.TLSOff, Routes: []Route{route}})
	name := UpstreamName("app.example.com", "", 80)

	ips, err := res.LookupIP(ctx, "ip4", name)
	if err != nil {
		t.Fatal(err)
	}
	if got := fmt.Sprint(addrsOf(ips)); got != "[172.18.0.2 172.18.0.3]" {
		t.Fatalf("answers %s", got)
	}

	// The answer follows Apply at once.
	route.Upstreams = []string{"172.18.0.9:80"}
	_ = m.Apply(ctx, Config{TLSMode: protocol.TLSOff, Routes: []Route{route}})
	ips, err = res.LookupIP(ctx, "ip4", name)
	if err != nil || fmt.Sprint(addrsOf(ips)) != "[172.18.0.9]" {
		t.Fatalf("after the swap: %v %v", ips, err)
	}

	var dnsErr *net.DNSError
	if _, err := res.LookupIP(ctx, "ip4", UpstreamName("gone.example.com", "", 80)); !errors.As(err, &dnsErr) || !dnsErr.IsNotFound {
		t.Fatalf("unknown name: %v", err)
	}
}

// Enough upstreams to overflow a UDP answer: the reply is truncated and the
// Go resolver, like Caddy's, retries over TCP and gets every address.
func TestDNSTruncatesToTCP(t *testing.T) {
	leaktest.Check(t)
	m := New(Options{AdminURL: "http://127.0.0.1:1"})
	res, _ := serveDNS(t, m)
	var ups []string
	for i := range 80 {
		ups = append(ups, fmt.Sprintf("10.1.%d.%d:80", i/200, i%200+1))
	}
	_ = m.Apply(context.Background(), Config{Routes: []Route{{Host: "big.example.com", Upstreams: ups}}})
	ips, err := res.LookupIP(context.Background(), "ip4", UpstreamName("big.example.com", "", 80))
	if err != nil {
		t.Fatal(err)
	}
	if len(ips) != 80 {
		t.Fatalf("got %d addresses, want 80", len(ips))
	}
}

func TestDNSRefusesOtherZones(t *testing.T) {
	s := newDNSServer()
	s.set(dnsTable{"a." + UpstreamZone: {netip.MustParseAddr("10.0.0.1")}})
	query := func(name string, typ dnsmessage.Type) dnsmessage.Message {
		t.Helper()
		b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: 7, RecursionDesired: true})
		_ = b.StartQuestions()
		_ = b.Question(dnsmessage.Question{Name: dnsmessage.MustNewName(name), Type: typ, Class: dnsmessage.ClassINET})
		q, _ := b.Finish()
		var m dnsmessage.Message
		if err := m.Unpack(s.answer(q, maxUDPAnswer)); err != nil {
			t.Fatal(err)
		}
		if m.ID != 7 || !m.Response {
			t.Fatalf("bad header %+v", m.Header)
		}
		return m
	}
	if m := query("example.com.", dnsmessage.TypeA); m.RCode != dnsmessage.RCodeRefused || len(m.Answers) != 0 {
		t.Fatalf("outside the zone: %v %d answers", m.RCode, len(m.Answers))
	}
	if m := query("a."+UpstreamZone, dnsmessage.TypeAAAA); m.RCode != dnsmessage.RCodeSuccess || len(m.Answers) != 0 {
		t.Fatalf("AAAA: %v %d answers", m.RCode, len(m.Answers))
	}
	if m := query("b."+UpstreamZone, dnsmessage.TypeA); m.RCode != dnsmessage.RCodeNameError {
		t.Fatalf("unknown name: %v", m.RCode)
	}
	if m := query("A."+UpstreamZone, dnsmessage.TypeA); len(m.Answers) != 1 || !m.Authoritative {
		t.Fatalf("names are case-insensitive: %+v", m)
	}
	if s.answer([]byte{1, 2, 3}, maxUDPAnswer) != nil {
		t.Fatal("answered garbage")
	}
}

func TestListenDNSLoopbackOnly(t *testing.T) {
	if _, _, err := ListenDNS("0.0.0.0:0"); err == nil {
		t.Fatal("wildcard address accepted")
	}
	if _, _, err := ListenDNS("localhost:0"); err == nil {
		t.Fatal("hostname accepted")
	}
}
