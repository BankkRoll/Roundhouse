package firewall

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeNetfilter is an in-memory filter table per family that understands
// the iptables and iptables-restore calls the publisher makes.
type fakeNetfilter struct {
	mu     sync.Mutex
	chains map[string]map[string][]string // "4"/"6" -> chain -> rules
	// missing holds binaries that fail every call.
	missing map[string]bool
	calls   []string
	stdin   []string
}

func newFakeNetfilter() *fakeNetfilter {
	f := &fakeNetfilter{chains: map[string]map[string][]string{}, missing: map[string]bool{}}
	for _, fam := range []string{"4", "6"} {
		f.chains[fam] = map[string][]string{
			"INPUT":       {"-m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT"},
			"FORWARD":     nil,
			"DOCKER-USER": {"-j RETURN"},
		}
	}
	return f
}

func familyOf(bin string) string {
	if strings.HasPrefix(bin, "ip6") {
		return "6"
	}
	return "4"
}

func (f *fakeNetfilter) exec(_ context.Context, stdin []byte, name string, args ...string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name+" "+strings.Join(args, " "))
	if f.missing[name] {
		return []byte(name + ": not found"), errors.New("exec: not found")
	}
	if len(args) == 0 || args[0] != "-w" {
		return nil, errors.New("missing -w")
	}
	tables := f.chains[familyOf(name)]
	if strings.HasSuffix(name, "-restore") {
		f.stdin = append(f.stdin, string(stdin))
		if !slices.Contains(args, "--noflush") {
			return nil, errors.New("restore without --noflush would flush every chain")
		}
		next := map[string][]string{}
		for k, v := range tables {
			next[k] = slices.Clone(v)
		}
		for line := range strings.Lines(string(stdin)) {
			line = strings.TrimSpace(line)
			switch {
			case line == "*filter", line == "COMMIT":
			case strings.HasPrefix(line, ":"):
				chain, _, _ := strings.Cut(line[1:], " ")
				next[chain] = []string{}
			case strings.HasPrefix(line, "-A "):
				chain, rule, _ := strings.Cut(line[3:], " ")
				if _, ok := next[chain]; !ok {
					return []byte("no chain " + chain), errors.New("exit status 1")
				}
				next[chain] = append(next[chain], strings.ReplaceAll(rule, `"`, ""))
			default:
				return []byte("bad line " + line), errors.New("exit status 2")
			}
		}
		if !slices.Contains(args, "--test") {
			f.chains[familyOf(name)] = next
		}
		return nil, nil
	}
	chain := args[2]
	rules, ok := tables[chain]
	if !ok {
		return []byte("iptables: No chain/target/match by that name."), errors.New("exit status 1")
	}
	switch args[1] {
	case "-S":
		out := "-N " + chain + "\n"
		for _, r := range rules {
			out += "-A " + chain + " " + r + "\n"
		}
		return []byte(out), nil
	case "-C":
		if slices.Contains(rules, strings.Join(args[3:], " ")) {
			return nil, nil
		}
		return []byte("Bad rule"), errors.New("exit status 1")
	case "-I":
		if args[3] != "1" {
			return nil, errors.New("jumps must be inserted first")
		}
		target := args[len(args)-1]
		if _, ok := tables[target]; !ok {
			return []byte("no chain " + target), errors.New("exit status 2")
		}
		tables[chain] = append([]string{strings.Join(args[4:], " ")}, rules...)
		return nil, nil
	}
	return nil, errors.New("unexpected " + args[1])
}

func (f *fakeNetfilter) chain(fam, name string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.chains[fam][name])
}

func (f *fakeNetfilter) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls, f.stdin = nil, nil
}

func (f *fakeNetfilter) restores() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if strings.Contains(c, "-restore ") && !strings.Contains(c, "--test") {
			n++
		}
	}
	return n
}

const (
	wantDockerJump = "-m conntrack --ctstate DNAT -m comment --comment roundhouse: tcp proxy -j ROUNDHOUSE-PUBLISH"
	wantInputJump  = "! -i lo -m comment --comment roundhouse: tcp proxy -j ROUNDHOUSE-PUBLISH"
)

func rule(port, src, target, owner string) string {
	r := "-p tcp -m conntrack --ctdir ORIGINAL --ctorigdstport " + port
	if src != "" {
		r += " -s " + src
	}
	return r + " -m comment --comment roundhouse: tcp proxy " + owner + " -j " + target
}

func TestPublishRulesPerFamily(t *testing.T) {
	f := newFakeNetfilter()
	p := NewPublisher(f.exec, nil)
	st := p.Apply(context.Background(), []PublishedPort{
		{HostPort: 20002, IPv6: true, Allowed: []string{"198.51.100.7/32", "2001:db8:1::/48"}, Owner: "wl_b"},
		{HostPort: 20001, Allowed: []string{"203.0.113.9/24", "2001:db8::/32", "203.0.113.0/24"}, Owner: "wl_a"},
	})
	if st.Enforced(false) != nil || st.Enforced(true) != nil {
		t.Fatalf("status %+v", st)
	}
	wantV4 := []string{
		rule("20001", "203.0.113.0/24", "RETURN", "wl_a"),
		rule("20001", "", "DROP", "wl_a"),
		rule("20002", "198.51.100.7/32", "RETURN", "wl_b"),
		rule("20002", "", "DROP", "wl_b"),
	}
	if got := f.chain("4", PublishChain); !slices.Equal(got, wantV4) {
		t.Fatalf("IPv4 chain\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(wantV4, "\n"))
	}
	wantV6 := []string{
		rule("20002", "2001:db8:1::/48", "RETURN", "wl_b"),
		rule("20002", "", "DROP", "wl_b"),
	}
	if got := f.chain("6", PublishChain); !slices.Equal(got, wantV6) {
		t.Fatalf("IPv6 chain\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(wantV6, "\n"))
	}
	for _, fam := range []string{"4", "6"} {
		if got := f.chain(fam, Chain); !slices.Equal(got, []string{wantDockerJump, "-j RETURN"}) {
			t.Errorf("IPv%s DOCKER-USER %q", fam, got)
		}
		if got := f.chain(fam, "INPUT"); len(got) != 2 || got[0] != wantInputJump {
			t.Errorf("IPv%s INPUT %q", fam, got)
		}
	}
}

func TestPublishOnlyIPv4WhenNoPortNeedsIPv6(t *testing.T) {
	f := newFakeNetfilter()
	f.missing["ip6tables"], f.missing["ip6tables-restore"] = true, true
	p := NewPublisher(f.exec, nil)
	st := p.Apply(context.Background(), []PublishedPort{{HostPort: 20001, Allowed: []string{"2001:db8::/32"}, Owner: "wl_a"}})
	if st.Enforced(false) != nil {
		t.Fatalf("status %+v", st)
	}
	if got := f.chain("4", PublishChain); !slices.Equal(got, []string{rule("20001", "", "DROP", "wl_a")}) {
		t.Fatalf("a port with only IPv6 sources must drop every IPv4 source: %q", got)
	}
	for _, c := range f.calls {
		if strings.HasPrefix(c, "ip6tables") {
			t.Fatalf("touched IPv6 without a port on \"::\": %s", c)
		}
	}
}

func TestPublishReplacesTheChainAtomically(t *testing.T) {
	f := newFakeNetfilter()
	p := NewPublisher(f.exec, nil)
	ctx := context.Background()
	p.Apply(ctx, []PublishedPort{{HostPort: 20001, Allowed: []string{"203.0.113.0/24"}, Owner: "wl_a"}})
	f.reset()
	st := p.Apply(ctx, []PublishedPort{{HostPort: 20001, Allowed: []string{"198.51.100.0/24"}, Owner: "wl_a"}})
	if st.IPv4 != nil {
		t.Fatal(st.IPv4)
	}
	if len(f.stdin) != 1 {
		t.Fatalf("%d restores, want one transaction", len(f.stdin))
	}
	in := f.stdin[0]
	if !strings.HasPrefix(in, "*filter\n:ROUNDHOUSE-PUBLISH - [0:0]\n") || !strings.HasSuffix(in, "COMMIT\n") {
		t.Fatalf("restore input:\n%s", in)
	}
	if !strings.Contains(in, `--comment "roundhouse: tcp proxy wl_a"`) {
		t.Fatalf("comments must be quoted:\n%s", in)
	}
	want := []string{rule("20001", "198.51.100.0/24", "RETURN", "wl_a"), rule("20001", "", "DROP", "wl_a")}
	if got := f.chain("4", PublishChain); !slices.Equal(got, want) {
		t.Fatalf("chain %q, want the old source gone", got)
	}
	for _, c := range f.calls {
		if strings.Contains(c, " -D ") || strings.Contains(c, " -F ") || strings.Contains(c, " -A ") {
			t.Fatalf("rules must change only through iptables-restore: %s", c)
		}
	}
}

func TestPublishJumpsAreIdempotent(t *testing.T) {
	f := newFakeNetfilter()
	p := NewPublisher(f.exec, nil)
	now := time.Unix(1_000, 0)
	p.now = func() time.Time { return now }
	ctx := context.Background()
	for i := range 4 {
		p.Apply(ctx, []PublishedPort{{HostPort: 20001 + i, Allowed: []string{"203.0.113.0/24"}}})
		now = now.Add(VerifyInterval)
	}
	if got := f.chain("4", Chain); !slices.Equal(got, []string{wantDockerJump, "-j RETURN"}) {
		t.Fatalf("DOCKER-USER %q", got)
	}
	if got := f.chain("4", "INPUT"); strings.Count(strings.Join(got, "\n"), PublishChain) != 1 {
		t.Fatalf("INPUT %q", got)
	}
	if got := f.chain("4", PublishChain); len(got) != 2 || !strings.Contains(got[1], "--ctorigdstport 20004") ||
		!strings.Contains(got[1], "tcp proxy port 20004") {
		t.Fatalf("chain %q", got)
	}
}

func TestPublishSkipsUnchangedRulesUntilVerify(t *testing.T) {
	f := newFakeNetfilter()
	p := NewPublisher(f.exec, nil)
	now := time.Unix(1_000, 0)
	p.now = func() time.Time { return now }
	ctx := context.Background()
	ports := []PublishedPort{{HostPort: 20001, Allowed: []string{"203.0.113.0/24"}, Owner: "wl_a"}}
	p.Apply(ctx, ports)
	f.reset()
	p.Apply(ctx, ports)
	if len(f.calls) != 0 {
		t.Fatalf("unchanged rules ran %q", f.calls)
	}

	now = now.Add(VerifyInterval)
	p.Apply(ctx, ports)
	if f.restores() != 0 || len(f.calls) == 0 {
		t.Fatalf("verify ran %q; want checks and no restore", f.calls)
	}

	// A firewall reload flushes the chain; the next verify restores it.
	f.mu.Lock()
	f.chains["4"][PublishChain] = []string{}
	f.mu.Unlock()
	p.Invalidate()
	f.reset()
	if st := p.Apply(ctx, ports); st.IPv4 != nil {
		t.Fatal(st.IPv4)
	}
	if f.restores() != 1 || len(f.chain("4", PublishChain)) != 2 {
		t.Fatalf("calls %q chain %q", f.calls, f.chain("4", PublishChain))
	}

	// A reboot loses the jumps and the chain alike.
	f.mu.Lock()
	delete(f.chains["4"], PublishChain)
	f.chains["4"][Chain] = []string{"-j RETURN"}
	f.chains["4"]["INPUT"] = nil
	f.mu.Unlock()
	now = now.Add(VerifyInterval)
	if st := p.Apply(ctx, ports); st.IPv4 != nil {
		t.Fatal(st.IPv4)
	}
	if got := f.chain("4", Chain); got[0] != wantDockerJump {
		t.Fatalf("DOCKER-USER %q", got)
	}
}

func TestPublishFailsClosed(t *testing.T) {
	ctx := context.Background()
	ports := []PublishedPort{{HostPort: 20001, Allowed: []string{"203.0.113.0/24"}}}

	f := newFakeNetfilter()
	f.missing["iptables-restore"] = true
	st := NewPublisher(f.exec, nil).Apply(ctx, ports)
	if st.Enforced(false) == nil || !strings.Contains(st.IPv4.Error(), "iptables-restore") {
		t.Fatalf("status %+v", st)
	}

	f = newFakeNetfilter()
	delete(f.chains["4"], Chain)
	st = NewPublisher(f.exec, nil).Apply(ctx, ports)
	if st.Enforced(false) == nil || !strings.Contains(st.IPv4.Error(), "DOCKER-USER chain is missing") {
		t.Fatalf("status %+v", st)
	}

	// IPv6 without Docker's ip6tables support: docker-proxy serves the
	// port, and the INPUT jump alone covers it.
	f = newFakeNetfilter()
	delete(f.chains["6"], Chain)
	v6 := []PublishedPort{{HostPort: 20001, IPv6: true, Allowed: []string{"2001:db8::/32"}}}
	if st := NewPublisher(f.exec, nil).Apply(ctx, v6); st.Enforced(true) != nil {
		t.Fatalf("status %+v", st)
	}
	if got := f.chain("6", "INPUT"); got[0] != wantInputJump {
		t.Fatalf("IPv6 INPUT %q", got)
	}

	f = newFakeNetfilter()
	f.missing["ip6tables-restore"] = true
	st = NewPublisher(f.exec, nil).Apply(ctx, append(v6, PublishedPort{HostPort: 20002}))
	if st.Enforced(false) != nil || st.Enforced(true) == nil {
		t.Fatalf("an IPv6 failure must refuse only ports on \"::\": %+v", st)
	}

	st = NewPublisher(newFakeNetfilter().exec, nil).Apply(ctx, []PublishedPort{{HostPort: 20001, Allowed: []string{"nope"}}})
	if st.Enforced(false) == nil || st.Enforced(true) == nil {
		t.Fatalf("an invalid source must refuse everything: %+v", st)
	}
}

func TestPublishFailureKeepsThePreviousRules(t *testing.T) {
	f := newFakeNetfilter()
	p := NewPublisher(f.exec, nil)
	ctx := context.Background()
	p.Apply(ctx, []PublishedPort{{HostPort: 20001, Allowed: []string{"203.0.113.0/24"}}})
	before := f.chain("4", PublishChain)
	f.missing["iptables-restore"] = true
	if st := p.Apply(ctx, []PublishedPort{{HostPort: 20001, Allowed: []string{"0.0.0.0/0"}}}); st.IPv4 == nil {
		t.Fatal("want an error")
	}
	if got := f.chain("4", PublishChain); !slices.Equal(got, before) {
		t.Fatalf("chain changed on failure: %q", got)
	}
	delete(f.missing, "iptables-restore")
	if st := p.Apply(ctx, []PublishedPort{{HostPort: 20001, Allowed: []string{"0.0.0.0/0"}}}); st.IPv4 != nil {
		t.Fatal(st.IPv4)
	}
}

func TestPublishEmptiesAFamilyNoLongerNeeded(t *testing.T) {
	f := newFakeNetfilter()
	p := NewPublisher(f.exec, nil)
	ctx := context.Background()
	p.Apply(ctx, []PublishedPort{{HostPort: 20001, IPv6: true, Allowed: []string{"2001:db8::/32"}}})
	if len(f.chain("6", PublishChain)) != 2 {
		t.Fatal("IPv6 rules missing")
	}
	p.Apply(ctx, []PublishedPort{{HostPort: 20002}})
	if got := f.chain("6", PublishChain); len(got) != 0 {
		t.Fatalf("IPv6 chain %q, want empty", got)
	}
	f.reset()
	p.Apply(ctx, nil)
	if got := f.chain("4", PublishChain); len(got) != 0 {
		t.Fatalf("IPv4 chain %q, want empty", got)
	}
	f.reset()
	p.Apply(ctx, nil)
	if len(f.calls) != 0 {
		t.Fatalf("an empty allowlist kept running %q", f.calls)
	}
}

func TestPublishRepeatedPortAdmitsNoSource(t *testing.T) {
	f := newFakeNetfilter()
	NewPublisher(f.exec, nil).Apply(context.Background(), []PublishedPort{
		{HostPort: 20001, Allowed: []string{"203.0.113.0/24"}, Owner: "wl_a"},
		{HostPort: 20001, Allowed: []string{"198.51.100.0/24"}, Owner: "wl_b"},
	})
	for _, r := range f.chain("4", PublishChain) {
		if strings.HasSuffix(r, "RETURN") {
			t.Fatalf("a contested port admitted a source: %q", f.chain("4", PublishChain))
		}
	}
}

func TestPublishCommentsAreSanitised(t *testing.T) {
	f := newFakeNetfilter()
	NewPublisher(f.exec, nil).Apply(context.Background(), []PublishedPort{{HostPort: 20001, Owner: `wl" -j ACCEPT`}})
	if got := f.chain("4", PublishChain); !slices.Equal(got, []string{rule("20001", "", "DROP", "port 20001")}) {
		t.Fatalf("chain %q", got)
	}
}

func TestProbe(t *testing.T) {
	f := newFakeNetfilter()
	if err := NewPublisher(f.exec, nil).Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.chains["4"][PublishChain]; ok {
		t.Fatal("the probe must not change the rules")
	}
	delete(f.chains["4"], Chain)
	if err := NewPublisher(f.exec, nil).Probe(context.Background()); err == nil || !strings.Contains(err.Error(), "DOCKER-USER") {
		t.Fatalf("err %v", err)
	}
	f = newFakeNetfilter()
	f.missing["iptables-restore"] = true
	if err := NewPublisher(f.exec, nil).Probe(context.Background()); err == nil {
		t.Fatal("probe passed without iptables-restore")
	}
}
