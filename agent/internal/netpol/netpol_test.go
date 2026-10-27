package netpol

import (
	"context"
	"errors"
	"flag"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

var update = flag.Bool("update", false, "rewrite the golden files")

func golden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", name+".nft")
	if *update {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run with -update to create it)", err)
	}
	if got != strings.ReplaceAll(string(want), "\r\n", "\n") {
		t.Errorf("%s differs from the golden file (run with -update to accept):\n%s", path, got)
	}
}

func base() *protocol.MeshConfig {
	return &protocol.MeshConfig{
		Supernet: "10.200.0.0/16", NodeIndex: 1, Address: "10.200.1.1", DNSAddress: "10.200.1.2",
		ListenPort: 51820, MTU: 1420, AcceptFwmark: 0x2000000,
		NodeAddresses: []string{"10.200.1.1"},
	}
}

func addr(s string) netip.Addr { return netip.MustParseAddr(s) }

func TestRenderGolden(t *testing.T) {
	cases := []struct {
		name    string
		cfg     func() *protocol.MeshConfig
		bridges map[netip.Addr]netip.Addr
	}{
		{"single-node", base, nil},
		{"peers", func() *protocol.MeshConfig {
			m := base()
			m.NodeAddresses = []string{"10.200.2.1", "10.200.1.1"}
			m.Addresses = []protocol.MeshAddress{
				{IP: "10.200.1.10", EnvTag: 7, NodeID: "node_a", RoutedPorts: []int{8080, 80}},
				{IP: "10.200.2.10", EnvTag: 7, NodeID: "node_b"},
			}
			return m
		}, map[netip.Addr]netip.Addr{addr("10.200.1.10"): addr("172.18.0.2")}},
		{"relay", func() *protocol.MeshConfig {
			m := base()
			m.NodeAddresses = []string{"10.200.1.1", "10.200.2.1", "10.200.3.1"}
			m.ForwardPairs = [][]string{{"10.200.2.0/24", "10.200.3.0/24"}}
			return m
		}, nil},
		{"multi-env", func() *protocol.MeshConfig {
			m := base()
			m.NodeAddresses = []string{"10.200.1.1", "10.200.2.1"}
			m.Addresses = []protocol.MeshAddress{
				{IP: "10.200.1.10", EnvTag: 3, NodeID: "node_a", RoutedPorts: []int{3000}},
				{IP: "10.200.1.11", EnvTag: 9, NodeID: "node_a"},
				{IP: "10.200.1.12", EnvTag: 9, NodeID: "node_a"},
				{IP: "10.200.2.10", EnvTag: 3, NodeID: "node_b"},
				{IP: "10.200.2.11", EnvTag: 9, NodeID: "node_b"},
			}
			return m
		}, map[netip.Addr]netip.Addr{
			addr("10.200.1.10"): addr("172.18.0.2"),
			addr("10.200.1.11"): addr("172.19.0.3"),
			// 10.200.1.12 has no running container yet.
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, err := Build(tc.cfg(), "node_a", tc.bridges)
			if err != nil {
				t.Fatal(err)
			}
			golden(t, tc.name, Render(r))
		})
	}
}

// cloudflareSources is a slice of Cloudflare's published ranges, with an
// overlap and a duplicate the agent must fold away.
var cloudflareSources = []string{
	"173.245.48.0/20", "103.21.244.0/22", "104.16.0.0/13", "104.24.0.0/14", "104.16.0.0/12", "104.16.5.0/24",
	"2400:cb00::/32", "2606:4700::/32", "2400:cb00::/32",
}

func TestRenderIngressGolden(t *testing.T) {
	filter, err := ParseIngress(&cloudflareSources)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("ingress-only", func(t *testing.T) {
		golden(t, "ingress-only", Render(Ruleset{Ingress: filter}))
	})
	t.Run("ingress-meshed", func(t *testing.T) {
		m := base()
		m.NodeAddresses = []string{"10.200.1.1", "10.200.2.1"}
		r, err := Build(m, "node_a", nil)
		if err != nil {
			t.Fatal(err)
		}
		r.Ingress = filter
		golden(t, "ingress-meshed", Render(r))
	})
	t.Run("ingress-v4-only", func(t *testing.T) {
		f, err := ParseIngress(&[]string{"198.51.100.0/24"})
		if err != nil {
			t.Fatal(err)
		}
		golden(t, "ingress-v4-only", Render(Ruleset{Ingress: f}))
	})
}

func TestRenderRegistryEgressGolden(t *testing.T) {
	m := base()
	m.NodeAddresses = []string{"10.200.1.1", "10.200.2.1"}
	r, err := Build(m, "node_a", nil)
	if err != nil {
		t.Fatal(err)
	}
	upstream := netip.MustParseAddrPort("10.200.2.1:5000")
	r.RegistryEgress = []Egress{{From: addr("172.20.0.2"), To: upstream}, {From: addr("172.20.0.2"), To: upstream}}
	golden(t, "registry-egress", Render(r))
}

func TestParseIngress(t *testing.T) {
	if f, err := ParseIngress(nil); f != nil || err != nil {
		t.Errorf("nil sources: %v, %v", f, err)
	}
	f, err := ParseIngress(&cloudflareSources)
	if err != nil {
		t.Fatal(err)
	}
	want4 := []string{"103.21.244.0/22", "104.16.0.0/12", "173.245.48.0/20"}
	want6 := []string{"2400:cb00::/32", "2606:4700::/32"}
	if got := prefixes(f.V4); !slices.Equal(got, want4) {
		t.Errorf("v4 = %v, want %v", got, want4)
	}
	if got := prefixes(f.V6); !slices.Equal(got, want6) {
		t.Errorf("v6 = %v, want %v", got, want6)
	}
	f, err = ParseIngress(&[]string{"10.1.2.3/8"})
	if err != nil || prefixes(f.V4)[0] != "10.0.0.0/8" {
		t.Errorf("unmasked prefix: %v, %v", f, err)
	}
	if f.String() != "1 IPv4 and 0 IPv6 ranges" || (*IngressFilter)(nil).String() != "none" {
		t.Errorf("String = %q", f.String())
	}
	// Fails closed: bad entries are left out, the filter stays.
	f, err = ParseIngress(&[]string{"10.0.0.0", "198.51.100.0/24"})
	if err == nil || f == nil || !slices.Equal(prefixes(f.V4), []string{"198.51.100.0/24"}) {
		t.Errorf("partly bad sources: %v, %v", f, err)
	}
	f, err = ParseIngress(&[]string{"nope/8"})
	if err == nil || f == nil || len(f.V4)+len(f.V6) != 0 {
		t.Errorf("all bad sources: %v, %v", f, err)
	}
	if f, err := ParseIngress(&[]string{}); err != nil || f == nil {
		t.Errorf("empty sources: %v, %v", f, err)
	}
}

func TestRenderDeterministic(t *testing.T) {
	m := base()
	m.Addresses = []protocol.MeshAddress{
		{IP: "10.200.1.12", EnvTag: 2, NodeID: "node_a"},
		{IP: "10.200.1.10", EnvTag: 1, NodeID: "node_a"},
		{IP: "10.200.1.11", EnvTag: 2, NodeID: "node_a"},
	}
	bridges := map[netip.Addr]netip.Addr{
		addr("10.200.1.10"): addr("172.18.0.2"), addr("10.200.1.11"): addr("172.19.0.2"), addr("10.200.1.12"): addr("172.19.0.3"),
	}
	r1, _ := Build(m, "node_a", bridges)
	slices.Reverse(m.Addresses)
	r2, _ := Build(m, "node_a", bridges)
	if Render(r1) != Render(r2) {
		t.Error("render depends on input order")
	}
}

func TestBuildRejects(t *testing.T) {
	for name, mut := range map[string]func(*protocol.MeshConfig){
		"supernet":     func(m *protocol.MeshConfig) { m.Supernet = "nope" },
		"mark":         func(m *protocol.MeshConfig) { m.AcceptFwmark = 0 },
		"node address": func(m *protocol.MeshConfig) { m.NodeAddresses = []string{"::1"} },
		"forward pair": func(m *protocol.MeshConfig) { m.ForwardPairs = [][]string{{"10.200.2.0/24"}} },
		"outside":      func(m *protocol.MeshConfig) { m.Addresses = []protocol.MeshAddress{{IP: "10.9.0.1", EnvTag: 1}} },
		"routed port": func(m *protocol.MeshConfig) {
			m.Addresses = []protocol.MeshAddress{{IP: "10.200.1.9", EnvTag: 1, NodeID: "n", RoutedPorts: []int{0}}}
		},
		"env tag":       func(m *protocol.MeshConfig) { m.Addresses = []protocol.MeshAddress{{IP: "10.200.1.9"}} },
		"bad addresses": func(m *protocol.MeshConfig) { m.Address = "x" },
	} {
		m := base()
		mut(m)
		if _, err := Build(m, "n", nil); err == nil {
			t.Errorf("%s: Build accepted it", name)
		}
	}
}

type call struct {
	name  string
	args  string
	stdin string
}

type fakeRun struct {
	calls []call
	fail  func(c call) bool
}

func (f *fakeRun) run(_ context.Context, stdin []byte, name string, args ...string) ([]byte, error) {
	c := call{name, strings.Join(args, " "), string(stdin)}
	f.calls = append(f.calls, c)
	if f.fail != nil && f.fail(c) {
		return []byte("boom"), errors.New("exit status 1")
	}
	return nil, nil
}

func (f *fakeRun) count(prefix string) int {
	n := 0
	for _, c := range f.calls {
		if strings.HasPrefix(c.name+" "+c.args, prefix) {
			n++
		}
	}
	return n
}

func TestFirewallApplySkipsUnchanged(t *testing.T) {
	f := &fakeRun{}
	fw := NewFirewall(f.run, nil)
	ctx := context.Background()
	if err := fw.Apply(ctx, "script"); err != nil {
		t.Fatal(err)
	}
	if err := fw.Apply(ctx, "script"); err != nil {
		t.Fatal(err)
	}
	if n := f.count("nft -f -"); n != 1 {
		t.Errorf("nft -f ran %d times, want 1", n)
	}
	// The table vanished (a firewall reload): apply again.
	f.fail = func(c call) bool { return c.args == "list table inet roundhouse" }
	if err := fw.Apply(ctx, "script"); err != nil {
		t.Fatal(err)
	}
	if n := f.count("nft -f -"); n != 2 {
		t.Errorf("nft -f ran %d times, want 2", n)
	}
	f.fail = func(c call) bool { return c.args == "-f -" }
	if err := fw.Apply(ctx, "other"); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Errorf("Apply error = %v, want nft's output", err)
	}
}

// chainRun serves `iptables -S DOCKER-USER` from rules and applies -I and
// -D of the mark rule to it.
type chainRun struct {
	fakeRun
	rules []string
}

const ourRule = `-A DOCKER-USER -m mark --mark 0x2000000/0x2000000 -m comment --comment "roundhouse: mesh" -j ACCEPT`

func (c *chainRun) run(ctx context.Context, stdin []byte, name string, args ...string) ([]byte, error) {
	_, _ = c.fakeRun.run(ctx, stdin, name, args...)
	switch {
	case slices.Equal(args, []string{"-w", "-S", "DOCKER-USER"}):
		return []byte("-N DOCKER-USER\n" + strings.Join(c.rules, "\n") + "\n"), nil
	case len(args) > 3 && args[1] == "-I":
		c.rules = append([]string{ourRule}, c.rules...)
	case len(args) > 2 && args[1] == "-D":
		i := slices.Index(c.rules, ourRule)
		if i < 0 {
			return nil, errors.New("no such rule")
		}
		c.rules = slices.Delete(c.rules, i, i+1)
	}
	return nil, nil
}

func TestEnsureMarkRule(t *testing.T) {
	ctx := context.Background()
	publish := `-A DOCKER-USER -m conntrack --ctstate DNAT -m comment --comment "roundhouse: tcp proxy" -j ROUNDHOUSE-PUBLISH`
	c := &chainRun{rules: []string{publish, "-A DOCKER-USER -j RETURN"}}
	fw := NewFirewall(c.run, nil)
	if err := fw.EnsureMarkRule(ctx, 0x2000000); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(c.rules, []string{ourRule, publish, "-A DOCKER-USER -j RETURN"}) {
		t.Errorf("chain = %q", c.rules)
	}
	want := "iptables -w -I DOCKER-USER 1 -m mark --mark 0x2000000/0x2000000 -m comment --comment roundhouse: mesh -j ACCEPT"
	if c.count(want) != 1 {
		t.Errorf("insert calls: %+v", c.calls)
	}

	c.calls = nil
	if err := fw.EnsureMarkRule(ctx, 0x2000000); err != nil {
		t.Fatal(err)
	}
	if len(c.calls) != 1 {
		t.Errorf("rule already first: %d calls, want just the listing", len(c.calls))
	}

	// Something else went in at the top since: ours moves back to first.
	c.rules = append([]string{publish}, slices.Delete(slices.Clone(c.rules), 1, 2)...)
	c.rules = append(c.rules[:1], append([]string{ourRule}, c.rules[1:]...)...)
	if err := fw.EnsureMarkRule(ctx, 0x2000000); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(c.rules, []string{ourRule, publish, "-A DOCKER-USER -j RETURN"}) {
		t.Errorf("after reorder chain = %q", c.rules)
	}

	broken := NewFirewall(func(ctx context.Context, stdin []byte, name string, args ...string) ([]byte, error) {
		return []byte("iptables: No chain/target/match by that name."), errors.New("exit status 1")
	}, nil)
	if err := broken.EnsureMarkRule(ctx, 0x2000000); err == nil || !strings.Contains(err.Error(), "No chain") {
		t.Errorf("missing chain: err = %v", err)
	}
}

func TestDaemonAcceptsMark(t *testing.T) {
	const m = 0x2000000
	cases := []struct {
		name     string
		json     string
		cmdlines [][]string
		want     bool
		err      error
	}{
		{"json", `{"bridge-accept-fwmark":"0x2000000/0x2000000"}`, nil, true, nil},
		{"json decimal", `{"bridge-accept-fwmark":"33554432"}`, nil, false, nil},
		{"json other mark", `{"bridge-accept-fwmark":"0x1/0x1"}`, nil, false, nil},
		{"json wide mask", `{"bridge-accept-fwmark":"0x2000000/0xffffffff"}`, nil, false, nil},
		{"flag", ``, [][]string{{"/usr/bin/dockerd", "--bridge-accept-fwmark=0x2000000/0x2000000"}}, true, nil},
		{"flag split", ``, [][]string{{"dockerd", "--bridge-accept-fwmark", "0x2000000/0x2000000"}}, true, nil},
		{"flag wins", `{"bridge-accept-fwmark":"0x2000000/0x2000000"}`, [][]string{{"dockerd", "--bridge-accept-fwmark=0x1"}}, false, nil},
		{"absent", `{"log-driver":"json-file"}`, [][]string{{"containerd"}}, false, ErrMarkUnknown},
	}
	for _, tc := range cases {
		var data []byte
		if tc.json != "" {
			data = []byte(tc.json)
		}
		got, err := DaemonAcceptsMark(data, tc.cmdlines, m)
		if got != tc.want || !errors.Is(err, tc.err) {
			t.Errorf("%s: got %v, %v; want %v, %v", tc.name, got, err, tc.want, tc.err)
		}
	}
	if !strings.Contains(MarkFix(m), `"bridge-accept-fwmark": "0x2000000/0x2000000"`) {
		t.Errorf("MarkFix = %q", MarkFix(m))
	}
}

func TestParseBackend(t *testing.T) {
	for in, want := range map[string]Backend{
		"": BackendIPTables, "iptables": BackendIPTables, "iptables+firewalld": BackendIPTables, "nftables": BackendNFTables,
	} {
		if got := ParseBackend(in); got != want {
			t.Errorf("ParseBackend(%q) = %s, want %s", in, got, want)
		}
	}
}
