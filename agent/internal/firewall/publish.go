package firewall

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/netip"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// PublishChain is the user chain, in the filter table of each family, that
// holds the TCP proxy's source allowlist (ADR 0004, "TCP proxy").
const PublishChain = "ROUNDHOUSE-PUBLISH"

// PublishComment tags the TCP proxy's rules and jumps.
const PublishComment = "roundhouse: tcp proxy"

// VerifyInterval is how often an unchanged allowlist is checked against the
// kernel, so rules lost to a firewall reload or a reboot are put back.
const VerifyInterval = 30 * time.Second

// PublishedPort is a host port the node publishes for the TCP proxy, and the
// sources it admits.
type PublishedPort struct {
	HostPort int
	// IPv6 means the port is published on "::", which needs IPv6 rules as
	// well as IPv4 ones.
	IPv6 bool
	// Allowed are the admitted source CIDRs; empty admits no source, which
	// is how a port is kept closed while its owner is not settled.
	Allowed []string
	// Owner names the port in rule comments, usually a workload ID.
	Owner string
}

// PublishStatus is the outcome of [Publisher.Apply] per family: nil when the
// family's rules are in place or not needed.
type PublishStatus struct {
	IPv4, IPv6 error
}

// Enforced returns nil when a port published on "0.0.0.0" (ipv6 false) or
// "::" (ipv6 true) is covered by the allowlist, else why not.
func (s PublishStatus) Enforced(ipv6 bool) error {
	if s.IPv4 != nil {
		return s.IPv4
	}
	if ipv6 {
		return s.IPv6
	}
	return nil
}

// Exec runs an iptables-family command, feeding it stdin, and returns its
// combined output.
type Exec func(ctx context.Context, stdin []byte, name string, args ...string) ([]byte, error)

// publishFamily is one address family's tooling for the allowlist.
type publishFamily struct {
	name, bin, restore string
	// requireDockerUser means a missing DOCKER-USER chain is an error. Docker
	// creates the IPv6 one only when its ip6tables support is on; without
	// it, Docker does not DNAT IPv6 to containers, and docker-proxy, which
	// the INPUT jump covers, serves published IPv6 ports instead.
	requireDockerUser bool
}

var (
	familyV4 = publishFamily{name: "ipv4", bin: "iptables", restore: "iptables-restore", requireDockerUser: true}
	familyV6 = publishFamily{name: "ipv6", bin: "ip6tables", restore: "ip6tables-restore"}
)

// jump is a rule in a built-in or Docker chain that sends traffic to
// [PublishChain].
type jump struct {
	chain string
	match []string
}

// jumps sends published traffic through the allowlist on both paths it can
// take: Docker's DNAT to a container (FORWARD, via DOCKER-USER) and
// docker-proxy on the host (INPUT).
//
// NOTE: the DOCKER-USER jump only takes DNATed connections. Without that, a
// container's own outbound connection to some remote server on a port that
// happens to be published here would match the drop.
var jumps = []jump{
	{chain: Chain, match: []string{"-m", "conntrack", "--ctstate", "DNAT"}},
	{chain: "INPUT", match: []string{"!", "-i", "lo"}},
}

func (j jump) args() []string {
	return append(slices.Clone(j.match), "-m", "comment", "--comment", PublishComment, "-j", PublishChain)
}

// Publisher keeps [PublishChain] in step with the ports the node publishes.
// The zero value is not usable; create one with [NewPublisher].
type Publisher struct {
	exec Exec
	log  *slog.Logger
	now  func() time.Time

	mu    sync.Mutex
	state map[string]*familyState
}

// familyState is what the publisher last installed for one family.
type familyState struct {
	// payload is the last iptables-restore input applied; "" when the
	// family was never applied by this process.
	payload  string
	rules    int
	verified time.Time
	// failed is the last error logged, so a persistent failure logs once.
	failed string
}

// NewPublisher returns a publisher that runs commands with exec; nil runs the
// host binaries.
func NewPublisher(run Exec, log *slog.Logger) *Publisher {
	if run == nil {
		run = func(ctx context.Context, stdin []byte, name string, args ...string) ([]byte, error) {
			cmd := exec.CommandContext(ctx, name, args...)
			if stdin != nil {
				cmd.Stdin = bytes.NewReader(stdin)
			}
			return cmd.CombinedOutput()
		}
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Publisher{
		exec: run, log: log, now: time.Now,
		state: map[string]*familyState{familyV4.name: {}, familyV6.name: {}},
	}
}

// Probe reports whether this host can enforce the allowlist for IPv4: the
// agent can read Docker's DOCKER-USER chain and iptables-restore accepts a
// declaration of [PublishChain]. It changes nothing, so it is safe while
// published containers run. A node advertises the TCP proxy only when it
// passes.
func (p *Publisher) Probe(ctx context.Context) error {
	f := familyV4
	if out, err := p.exec(ctx, nil, f.bin, "-w", "-S", Chain); err != nil {
		return fmt.Errorf("%s cannot read Docker's %s chain (is iptables installed, does the agent have CAP_NET_ADMIN, "+
			"and does Docker manage iptables?): %w: %s", f.bin, Chain, err, firstLine(strings.TrimSpace(string(out))))
	}
	payload := []byte("*filter\n:" + PublishChain + " - [0:0]\nCOMMIT\n")
	if out, err := p.exec(ctx, payload, f.restore, "-w", "--test", "--noflush"); err != nil {
		return fmt.Errorf("%s: %w: %s", f.restore, err, firstLine(strings.TrimSpace(string(out))))
	}
	return nil
}

// Invalidate makes the next [Publisher.Apply] check the kernel's rules even
// if the allowlist did not change, e.g. after the Docker daemon restarted.
func (p *Publisher) Invalidate() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, st := range p.state {
		st.verified = time.Time{}
	}
}

// Apply makes [PublishChain] hold exactly the rules for ports, in every
// family that needs them: IPv4 always, IPv6 for ports published on "::".
// For each port, one RETURN per admitted source CIDR of the family comes
// before a final DROP of everything else to that port, matched on the
// connection's original destination port in the original direction only,
// so replies are never dropped and an allowlist edit cuts established
// connections from removed sources too.
//
// The chain is replaced in one iptables-restore transaction, so a port
// never goes without its DROP; on failure the previous rules stay. An
// unchanged allowlist is only re-checked every [VerifyInterval]. A family
// no port needs is emptied if this process filled it, without that
// affecting the result.
func (p *Publisher) Apply(ctx context.Context, ports []PublishedPort) PublishStatus {
	for _, port := range ports {
		if err := validPort(port); err != nil {
			return PublishStatus{IPv4: err, IPv6: err}
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	var st PublishStatus
	for _, f := range []publishFamily{familyV4, familyV6} {
		needed := len(ports) > 0
		if f == familyV6 {
			needed = slices.ContainsFunc(ports, func(p PublishedPort) bool { return p.IPv6 })
		}
		fs := p.state[f.name]
		if !needed && fs.payload == "" {
			continue
		}
		var portsOf []PublishedPort
		if needed {
			portsOf = ports
			if f == familyV6 {
				portsOf = slices.DeleteFunc(slices.Clone(ports), func(p PublishedPort) bool { return !p.IPv6 })
			}
		}
		payload, rules := renderChain(f, portsOf)
		err := p.applyFamily(ctx, f, fs, payload, rules, len(portsOf))
		if err == nil && !needed {
			fs.payload = ""
		}
		if err != nil && needed {
			if f == familyV4 {
				st.IPv4 = err
			} else {
				st.IPv6 = err
			}
		}
	}
	return st
}

// applyFamily installs one family's chain and jumps unless they are already
// in place. Caller holds p.mu.
func (p *Publisher) applyFamily(ctx context.Context, f publishFamily, fs *familyState, payload string, rules, ports int) error {
	now := p.now()
	if payload == fs.payload && now.Sub(fs.verified) < VerifyInterval && !fs.verified.IsZero() {
		return nil
	}
	if payload == fs.payload && p.inPlace(ctx, f, rules) {
		fs.verified = now
		return nil
	}
	changed := payload != fs.payload
	err := p.install(ctx, f, payload)
	if err != nil {
		err = fmt.Errorf("could not install the TCP proxy allowlist (%s): %w", f.name, err)
		if msg := err.Error(); msg != fs.failed {
			fs.failed = msg
			p.log.Error("TCP proxy allowlist not applied; ports that need it stay closed or unpublished",
				"family", f.name, "ports", ports, "err", err)
		}
		return err
	}
	if fs.failed != "" || changed {
		p.log.Info("applied the TCP proxy allowlist", "family", f.name, "ports", ports, "rules", rules)
	} else {
		p.log.Warn("restored the TCP proxy allowlist after it went missing", "family", f.name, "ports", ports)
	}
	fs.payload, fs.rules, fs.verified, fs.failed = payload, rules, now, ""
	return nil
}

// install replaces the chain, then makes sure the jumps to it exist. The
// chain is filled before any jump points at it.
func (p *Publisher) install(ctx context.Context, f publishFamily, payload string) error {
	// NOTE: with --noflush, iptables-restore leaves every other chain alone
	// and flushes only the chains the input declares, and commits the whole
	// input as one transaction.
	if out, err := p.exec(ctx, []byte(payload), f.restore, "-w", "--noflush"); err != nil {
		return fmt.Errorf("%s: %w: %s", f.restore, err, strings.TrimSpace(string(out)))
	}
	for _, j := range jumps {
		args := j.args()
		if _, err := p.exec(ctx, nil, f.bin, append([]string{"-w", "-C", j.chain}, args...)...); err == nil {
			continue
		}
		// NOTE: inserted first, not appended: DOCKER-USER ends in Docker's own
		// RETURN and INPUT may end in a distribution's ACCEPT or REJECT.
		out, err := p.exec(ctx, nil, f.bin, append([]string{"-w", "-I", j.chain, "1"}, args...)...)
		if err == nil {
			continue
		}
		if j.chain == Chain && !p.chainExists(ctx, f, Chain) {
			if !f.requireDockerUser {
				continue
			}
			return fmt.Errorf("the %s chain is missing; is Docker running with its iptables support enabled?", Chain)
		}
		return fmt.Errorf("%s -I %s: %w: %s", f.bin, j.chain, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// inPlace reports whether the jumps exist and the chain holds as many rules
// as were installed: a reboot, a firewall reload or a flush shows up as a
// missing jump or a short chain.
func (p *Publisher) inPlace(ctx context.Context, f publishFamily, rules int) bool {
	for _, j := range jumps {
		if _, err := p.exec(ctx, nil, f.bin, append([]string{"-w", "-C", j.chain}, j.args()...)...); err != nil {
			if j.chain == Chain && !f.requireDockerUser && !p.chainExists(ctx, f, Chain) {
				continue
			}
			return false
		}
	}
	out, err := p.exec(ctx, nil, f.bin, "-w", "-S", PublishChain)
	if err != nil {
		return false
	}
	n := 0
	for line := range strings.Lines(string(out)) {
		if strings.HasPrefix(line, "-A ") {
			n++
		}
	}
	return n == rules
}

func (p *Publisher) chainExists(ctx context.Context, f publishFamily, chain string) bool {
	_, err := p.exec(ctx, nil, f.bin, "-w", "-S", chain)
	return err == nil
}

// renderChain returns the iptables-restore input that replaces the family's
// chain with the rules for ports, and how many rules it holds.
func renderChain(f publishFamily, ports []PublishedPort) (string, int) {
	ports = slices.Clone(ports)
	slices.SortFunc(ports, func(a, b PublishedPort) int { return a.HostPort - b.HostPort })
	var b strings.Builder
	b.WriteString("*filter\n:" + PublishChain + " - [0:0]\n")
	rules := 0
	for i, port := range ports {
		allowed := sourcesOf(f, port.Allowed)
		// A port listed twice admits no source: two owners can't both be
		// trusted with it.
		if i > 0 && ports[i-1].HostPort == port.HostPort || i+1 < len(ports) && ports[i+1].HostPort == port.HostPort {
			allowed = nil
		}
		match := "-A " + PublishChain + " -p tcp -m conntrack --ctdir ORIGINAL --ctorigdstport " + strconv.Itoa(port.HostPort)
		comment := ` -m comment --comment "` + commentFor(port) + `"`
		for _, src := range allowed {
			b.WriteString(match + " -s " + src + comment + " -j RETURN\n")
			rules++
		}
		b.WriteString(match + comment + " -j DROP\n")
		rules++
	}
	b.WriteString("COMMIT\n")
	return b.String(), rules
}

// sourcesOf returns the CIDRs of family f, canonical and without repeats.
func sourcesOf(f publishFamily, cidrs []string) []string {
	var out []string
	for _, c := range cidrs {
		pfx, err := netip.ParsePrefix(c)
		if err != nil || pfx.Addr().Is4() != (f == familyV4) {
			continue
		}
		s := pfx.Masked().String()
		if !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	return out
}

// commentFor names a port's rules. Only characters that need no quoting
// in iptables-restore input are kept from the owner.
func commentFor(p PublishedPort) string {
	owner := p.Owner
	ok := owner != "" && len(owner) <= 64 && !strings.ContainsFunc(owner, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.')
	})
	if !ok {
		owner = "port " + strconv.Itoa(p.HostPort)
	}
	return PublishComment + " " + owner
}

func validPort(p PublishedPort) error {
	if p.HostPort < 1 || p.HostPort > 65535 {
		return fmt.Errorf("invalid published port %d", p.HostPort)
	}
	for _, c := range p.Allowed {
		if _, err := netip.ParsePrefix(c); err != nil {
			return fmt.Errorf("port %d: invalid source %q", p.HostPort, c)
		}
	}
	return nil
}
