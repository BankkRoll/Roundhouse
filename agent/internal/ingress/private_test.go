package ingress

import (
	"context"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

var (
	askerA  = netip.MustParseAddr("172.18.0.5") // env tag 1
	askerB  = netip.MustParseAddr("172.19.0.5") // env tag 2
	unknown = netip.MustParseAddr("172.20.0.9")
)

func privateZone() PrivateZone {
	return PrivateZone{
		Askers: map[netip.Addr]int{askerA: 1, askerB: 2},
		Records: []PrivateRecord{
			// web in env 1: a local replica (bridge IP) and two remote ones.
			{Domain: "web.production.shop.internal", EnvTag: 1, Addr: netip.MustParseAddr("172.18.0.2"), Healthy: true},
			{Domain: "web.production.shop.internal", EnvTag: 1, Addr: netip.MustParseAddr("10.200.2.10"), Healthy: true},
			{Domain: "web.production.shop.internal", EnvTag: 1, Addr: netip.MustParseAddr("10.200.3.10"), Healthy: false},
			// db in env 1: nothing healthy.
			{Domain: "db.production.shop.internal", EnvTag: 1, Addr: netip.MustParseAddr("10.200.2.11")},
			{Domain: "db.production.shop.internal", EnvTag: 1, Addr: netip.MustParseAddr("10.200.2.12")},
			// web in env 2 (staging of the same project).
			{Domain: "web.staging.shop.internal", EnvTag: 2, Addr: netip.MustParseAddr("10.200.2.20"), Healthy: true},
		},
	}
}

func query(t *testing.T, name string, typ dnsmessage.Type) []byte {
	t.Helper()
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: 4242, RecursionDesired: true})
	_ = b.StartQuestions()
	if err := b.Question(dnsmessage.Question{Name: dnsmessage.MustNewName(name), Type: typ, Class: dnsmessage.ClassINET}); err != nil {
		t.Fatal(err)
	}
	out, err := b.Finish()
	if err != nil {
		t.Fatal(err)
	}
	return out
}

type parsed struct {
	rcode dnsmessage.RCode
	addrs []string
	ttl   uint32
	auth  bool
}

func parseDNS(t *testing.T, out []byte) parsed {
	t.Helper()
	var m dnsmessage.Message
	if err := m.Unpack(out); err != nil {
		t.Fatalf("unpack: %v", err)
	}
	if m.ID != 4242 || !m.Response {
		t.Fatalf("header = %+v", m.Header)
	}
	p := parsed{rcode: m.RCode, auth: m.Authoritative}
	for _, a := range m.Answers {
		if r, ok := a.Body.(*dnsmessage.AResource); ok {
			p.addrs = append(p.addrs, netip.AddrFrom4(r.A).String())
			p.ttl = a.Header.TTL
		}
	}
	slices.Sort(p.addrs)
	return p
}

func TestPrivateAnswerPolicy(t *testing.T) {
	p := NewPrivateDNS(PrivateDNSOptions{})
	p.SetZone(privateZone())
	cases := []struct {
		name  string
		src   netip.Addr
		qname string
		typ   dnsmessage.Type
		rcode dnsmessage.RCode
		addrs []string
	}{
		{"same env: healthy local and remote", askerA, "web.production.shop.internal.", dnsmessage.TypeA, dnsmessage.RCodeSuccess,
			[]string{"10.200.2.10", "172.18.0.2"}},
		{"case insensitive", askerA, "WEB.Production.shop.INTERNAL.", dnsmessage.TypeA, dnsmessage.RCodeSuccess,
			[]string{"10.200.2.10", "172.18.0.2"}},
		{"none healthy: all of them", askerA, "db.production.shop.internal.", dnsmessage.TypeA, dnsmessage.RCodeSuccess,
			[]string{"10.200.2.11", "10.200.2.12"}},
		{"phase 1 three-label form", askerA, "web.production.internal.", dnsmessage.TypeA, dnsmessage.RCodeSuccess,
			[]string{"10.200.2.10", "172.18.0.2"}},
		{"AAAA of a known name", askerA, "web.production.shop.internal.", dnsmessage.TypeAAAA, dnsmessage.RCodeSuccess, nil},
		{"cross env is NXDOMAIN", askerB, "web.production.shop.internal.", dnsmessage.TypeA, dnsmessage.RCodeNameError, nil},
		{"cross env three-label is NXDOMAIN", askerB, "web.production.internal.", dnsmessage.TypeA, dnsmessage.RCodeNameError, nil},
		{"own env answers", askerB, "web.staging.shop.internal.", dnsmessage.TypeA, dnsmessage.RCodeSuccess, []string{"10.200.2.20"}},
		{"unknown internal name", askerA, "nope.production.shop.internal.", dnsmessage.TypeA, dnsmessage.RCodeNameError, nil},
		{"bare internal", askerA, "internal.", dnsmessage.TypeA, dnsmessage.RCodeNameError, nil},
		{"non-local asker refused", unknown, "web.production.shop.internal.", dnsmessage.TypeA, dnsmessage.RCodeRefused, nil},
		{"non-local asker never forwarded", unknown, "example.com.", dnsmessage.TypeA, dnsmessage.RCodeRefused, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, fwd := p.answer(query(t, tc.qname, tc.typ), tc.src, maxUDPAnswer)
			if fwd {
				t.Fatal("forwarded a query that must be answered")
			}
			got := parseDNS(t, out)
			if got.rcode != tc.rcode || !slices.Equal(got.addrs, tc.addrs) {
				t.Errorf("got %v %v, want %v %v", got.rcode, got.addrs, tc.rcode, tc.addrs)
			}
			if len(got.addrs) > 0 && got.ttl != PrivateTTL {
				t.Errorf("ttl = %d, want %d", got.ttl, PrivateTTL)
			}
		})
	}
	if _, fwd := p.answer(query(t, "example.com.", dnsmessage.TypeA), askerA, maxUDPAnswer); !fwd {
		t.Error("a local asker's public name was not forwarded")
	}
}

func TestPrivateAnswerRotates(t *testing.T) {
	p := NewPrivateDNS(PrivateDNSOptions{})
	p.SetZone(privateZone())
	firsts := map[string]bool{}
	for range 4 {
		out, _ := p.answer(query(t, "web.production.shop.internal.", dnsmessage.TypeA), askerA, maxUDPAnswer)
		var m dnsmessage.Message
		if err := m.Unpack(out); err != nil {
			t.Fatal(err)
		}
		firsts[netip.AddrFrom4(m.Answers[0].Body.(*dnsmessage.AResource).A).String()] = true
	}
	if len(firsts) != 2 {
		t.Errorf("first answers %v, want both healthy replicas to lead in turn", firsts)
	}
}

// fakeResolver answers every UDP and TCP query on 127.0.0.1:<port> with
// 192.0.2.1, or never when silent.
func fakeResolver(t *testing.T, silent bool) string {
	t.Helper()
	pc, ln, err := ListenDNS("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close(); ln.Close() })
	respond := func(q []byte) []byte {
		var m dnsmessage.Message
		if err := m.Unpack(q); err != nil {
			return nil
		}
		m.Response = true
		m.Answers = []dnsmessage.Resource{{
			Header: dnsmessage.ResourceHeader{Name: m.Questions[0].Name, Class: dnsmessage.ClassINET, TTL: 60},
			Body:   &dnsmessage.AResource{A: [4]byte{192, 0, 2, 1}},
		}}
		out, _ := m.Pack()
		return out
	}
	go func() {
		buf := make([]byte, 1500)
		for {
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			if !silent {
				_, _ = pc.WriteTo(respond(buf[:n]), from)
			}
		}
	}()
	_, port, _ := net.SplitHostPort(pc.LocalAddr().String())
	return port
}

func forwarder(t *testing.T, port string) *PrivateDNS {
	t.Helper()
	conf := filepath.Join(t.TempDir(), "resolv.conf")
	if err := os.WriteFile(conf, []byte("# test\nsearch example\nnameserver 127.0.0.1\noptions ndots:0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	p := NewPrivateDNS(PrivateDNSOptions{ResolvConf: conf, Timeout: 300 * time.Millisecond})
	p.upstreamPort = port
	p.SetZone(privateZone())
	return p
}

func TestPrivateForwards(t *testing.T) {
	p := forwarder(t, fakeResolver(t, false))
	q := query(t, "example.com.", dnsmessage.TypeA)
	got := parseDNS(t, p.forward(context.Background(), q, false))
	if got.rcode != dnsmessage.RCodeSuccess || !slices.Equal(got.addrs, []string{"192.0.2.1"}) {
		t.Errorf("forwarded answer = %+v", got)
	}
}

func TestPrivateForwardFailureIsServfail(t *testing.T) {
	p := forwarder(t, fakeResolver(t, true))
	start := time.Now()
	got := parseDNS(t, p.forward(context.Background(), query(t, "example.com.", dnsmessage.TypeA), false))
	if got.rcode != dnsmessage.RCodeServerFailure {
		t.Errorf("rcode = %v, want SERVFAIL", got.rcode)
	}
	if time.Since(start) > 2*time.Second {
		t.Errorf("forward took %v; the timeout is not applied", time.Since(start))
	}
}

func TestPrivateListenServes(t *testing.T) {
	p := NewPrivateDNS(PrivateDNSOptions{})
	p.SetZone(PrivateZone{
		Askers:  map[netip.Addr]int{netip.MustParseAddr("127.0.0.1"): 1},
		Records: []PrivateRecord{{Domain: "web.production.shop.internal", EnvTag: 1, Addr: netip.MustParseAddr("10.200.2.10"), Healthy: true}},
	})
	pc, ln, err := ListenDNS("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := pc.LocalAddr().String()
	pc.Close()
	ln.Close()
	if err := p.Listen(addr); err != nil {
		t.Skipf("port taken meanwhile: %v", err)
	}
	defer p.Close()
	if p.Addr() != addr {
		t.Errorf("Addr = %q, want %q", p.Addr(), addr)
	}
	for _, network := range []string{"udp", "tcp"} {
		r := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, addr)
		}}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		ips, err := r.LookupNetIP(ctx, "ip4", "web.production.shop.internal.")
		cancel()
		if err != nil || len(ips) != 1 || ips[0].String() != "10.200.2.10" {
			t.Errorf("%s lookup = %v, %v", network, ips, err)
		}
	}
	p.Close()
	if p.Addr() != "" {
		t.Error("Addr after Close is not empty")
	}
}

func TestParseNameservers(t *testing.T) {
	got := ParseNameservers(strings.NewReader("nameserver 127.0.0.53\nnameserver fe80::1%eth0\n# nameserver 9.9.9.9\nnameserver bogus\nsearch x\n"))
	if !slices.Equal(got, []string{"127.0.0.53", "fe80::1"}) {
		t.Errorf("ParseNameservers = %v", got)
	}
}
