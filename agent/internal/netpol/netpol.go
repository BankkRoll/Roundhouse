// Package netpol renders and applies the agent's nftables table: the
// isolation of environments across the WireGuard mesh (ADR 0005,
// "Isolation with nftables") and the ingress source filter of
// cloudflare_only (docs/cloudflare-for-saas.md).
//
// Responsibilities:
//   - build a [Ruleset] from desired_state.mesh and the node's local
//     replicas (mesh IP to container bridge IP) ([Build]), and the ingress
//     filter from desired_state.ingress.allowed_sources ([ParseIngress]);
//   - render it as one nft script that replaces `table inet roundhouse`
//     atomically ([Render]);
//   - apply, verify and remove that table, and keep Docker's DOCKER-USER
//     chain accepting packets that carry the mesh mark on the iptables
//     backend ([Firewall]);
//   - tell which firewall backend Docker uses and whether an nftables
//     daemon accepts the mark ([ParseBackend], [DaemonAcceptsMark]).
//
// The table is the only place cross-node traffic is admitted. The sending
// node checks that the destination is in the source's environment, the
// receiving node that the source is, and every packet the policy admits is
// marked so Docker's own forward drops let it through. Everything else that
// enters over wg0 is dropped, and a drop in this table is final.
package netpol

import (
	"cmp"
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"strconv"
	"strings"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// Table is the nftables table the agent owns; it never edits any other.
const Table = "inet roundhouse"

// Interface is the WireGuard interface every rule keys on.
const Interface = "wg0"

// RegistryPort is where a node's registry listens on its mesh address.
const RegistryPort = 5000

// Local is one replica on this node that has a mesh IP.
type Local struct {
	MeshIP netip.Addr
	// BridgeIP is the container's address on its environment network.
	BridgeIP netip.Addr
	EnvTag   int
}

// Ruleset is everything the rendered table depends on.
type Ruleset struct {
	// Supernet is the mesh supernet, e.g. 10.200.0.0/16.
	Supernet netip.Prefix
	// Address is this node's wg0 address (.1); DNSAddress its private DNS
	// address (.2).
	Address, DNSAddress netip.Addr
	// Mark is the bit set on admitted packets, which Docker accepts.
	Mark uint32
	// Nodes are every node's .1 address: the sources ingress traffic comes
	// from.
	Nodes []netip.Addr
	// ForwardPairs are the CIDR pairs this node relays wg0 to wg0, in both
	// directions.
	ForwardPairs [][2]netip.Prefix
	// Locals are this node's replicas whose bridge IP is known.
	Locals []Local
	// Envs holds every mesh IP of each environment, cluster-wide, by env tag.
	Envs map[int][]netip.Addr
	// Routed are the local (mesh IP, port) pairs with an ingress route,
	// admitted from Nodes.
	Routed []netip.AddrPort
	// RegistryEgress are local containers without a mesh IP that may reach
	// a peer's registry: a proxy registry and its upstream.
	RegistryEgress []Egress
	// Ingress, when set, admits ports 80 and 443 only from its sources. A
	// ruleset with only Ingress (no Supernet) renders just that filter, for
	// a node outside the mesh.
	Ingress *IngressFilter
}

// Egress admits one local container to one address and port over wg0.
type Egress struct {
	From netip.Addr
	To   netip.AddrPort
}

// meshed reports whether r carries the mesh part of the table.
func (r Ruleset) meshed() bool { return r.Supernet.IsValid() }

// Build derives a ruleset from desired_state.mesh. self is this node's ID;
// bridges maps the mesh IP of each local replica that runs to its bridge
// IP. A local mesh IP without a running container gets no NAT entry, so
// traffic for it is dropped until the container is up.
func Build(m *protocol.MeshConfig, self string, bridges map[netip.Addr]netip.Addr) (Ruleset, error) {
	supernet, err := netip.ParsePrefix(m.Supernet)
	if err != nil || !supernet.Addr().Is4() {
		return Ruleset{}, fmt.Errorf("mesh supernet %q: not an IPv4 prefix", m.Supernet)
	}
	supernet = supernet.Masked()
	addr, err1 := netip.ParseAddr(m.Address)
	dns, err2 := netip.ParseAddr(m.DNSAddress)
	if err := errors.Join(err1, err2); err != nil {
		return Ruleset{}, fmt.Errorf("mesh address: %w", err)
	}
	if m.AcceptFwmark <= 0 || m.AcceptFwmark > 0xffff_ffff {
		return Ruleset{}, fmt.Errorf("mesh accept_fwmark %#x: out of range", m.AcceptFwmark)
	}
	r := Ruleset{
		Supernet: supernet, Address: addr, DNSAddress: dns, Mark: uint32(m.AcceptFwmark),
		Envs: map[int][]netip.Addr{},
	}
	for _, s := range m.NodeAddresses {
		a, err := netip.ParseAddr(s)
		if err != nil || !a.Is4() {
			return Ruleset{}, fmt.Errorf("mesh node address %q: not IPv4", s)
		}
		r.Nodes = append(r.Nodes, a)
	}
	for _, pair := range m.ForwardPairs {
		if len(pair) != 2 {
			return Ruleset{}, errors.New("mesh forward pair: need two prefixes")
		}
		a, err1 := netip.ParsePrefix(pair[0])
		b, err2 := netip.ParsePrefix(pair[1])
		if err := errors.Join(err1, err2); err != nil || !a.Addr().Is4() || !b.Addr().Is4() {
			return Ruleset{}, fmt.Errorf("mesh forward pair %v: not IPv4 prefixes", pair)
		}
		r.ForwardPairs = append(r.ForwardPairs, [2]netip.Prefix{a.Masked(), b.Masked()})
	}
	for _, a := range m.Addresses {
		ip, err := netip.ParseAddr(a.IP)
		if err != nil || !ip.Is4() || !supernet.Contains(ip) {
			return Ruleset{}, fmt.Errorf("mesh address %q: not an IPv4 address in the supernet", a.IP)
		}
		if a.EnvTag < 1 {
			return Ruleset{}, fmt.Errorf("mesh address %s: invalid env tag %d", a.IP, a.EnvTag)
		}
		r.Envs[a.EnvTag] = append(r.Envs[a.EnvTag], ip)
		if a.NodeID != self {
			continue
		}
		for _, p := range a.RoutedPorts {
			if p < 1 || p > 65535 {
				return Ruleset{}, fmt.Errorf("mesh address %s: invalid routed port %d", a.IP, p)
			}
			r.Routed = append(r.Routed, netip.AddrPortFrom(ip, uint16(p)))
		}
		if bridge, ok := bridges[ip]; ok && bridge.Is4() {
			r.Locals = append(r.Locals, Local{MeshIP: ip, BridgeIP: bridge, EnvTag: a.EnvTag})
		}
	}
	return r, nil
}

// Render returns the nft script that replaces the table with r in one
// transaction: the empty table declaration makes the delete valid when the
// table doesn't exist yet, and the delete drops chains and sets that r no
// longer has. Output is deterministic, so equal rulesets render equal text.
func Render(r Ruleset) string {
	var b strings.Builder
	w := func(indent int, format string, args ...any) {
		b.WriteString(strings.Repeat("\t", indent))
		fmt.Fprintf(&b, format, args...)
		b.WriteByte('\n')
	}
	w(0, "table %s {}", Table)
	w(0, "delete table %s", Table)
	w(0, "table %s {", Table)
	if r.meshed() {
		renderMesh(w, r)
	}
	if r.Ingress != nil {
		renderIngress(w, r)
	}
	w(0, "}")
	return b.String()
}

// writer writes one line of the script at an indent.
type writer func(indent int, format string, args ...any)

// renderMesh writes the mesh's sets, maps and chains.
func renderMesh(w writer, r Ruleset) {
	mark := fmt.Sprintf("meta mark set meta mark or 0x%08x", r.Mark)
	supernet := r.Supernet.String()
	tags := envTags(r.Envs)

	// Sets and env chains come before the maps whose verdicts jump to those
	// chains, and the maps before the base chains that look them up.
	set(w, "nodes", "ipv4_addr", addrs(r.Nodes))
	set(w, "routed", "ipv4_addr . inet_service", addrPorts(r.Routed))
	for _, tag := range tags {
		set(w, envSet(tag), "ipv4_addr", addrs(r.Envs[tag]))
	}
	for _, tag := range tags {
		w(1, "chain %s_out {", envSet(tag))
		w(2, "ct original ip daddr @%s %s accept", envSet(tag), mark)
		w(2, "drop")
		w(1, "}")
		w(1, "chain %s_in {", envSet(tag))
		w(2, "ip saddr @%s %s accept", envSet(tag), mark)
		w(2, "ip saddr @nodes ct original ip daddr . tcp dport @routed %s accept", mark)
		w(2, "drop")
		w(1, "}")
	}

	locals := slices.Clone(r.Locals)
	slices.SortFunc(locals, func(a, b Local) int { return a.MeshIP.Compare(b.MeshIP) })
	var dnat, snat, bridgeEnv, meshEnvIn []string
	for _, l := range locals {
		dnat = append(dnat, l.MeshIP.String()+" : "+l.BridgeIP.String())
		snat = append(snat, l.BridgeIP.String()+" : "+l.MeshIP.String())
		bridgeEnv = append(bridgeEnv, l.BridgeIP.String()+" : jump "+envSet(l.EnvTag)+"_out")
		meshEnvIn = append(meshEnvIn, l.MeshIP.String()+" : jump "+envSet(l.EnvTag)+"_in")
	}
	slices.Sort(snat)
	slices.Sort(bridgeEnv)
	set(w, "map mesh_dnat", "ipv4_addr : ipv4_addr", dnat)
	set(w, "map mesh_snat", "ipv4_addr : ipv4_addr", snat)
	set(w, "map bridge_env", "ipv4_addr : verdict", bridgeEnv)
	set(w, "map mesh_env_in", "ipv4_addr : verdict", meshEnvIn)

	w(1, "chain nat_prerouting {")
	w(2, "type nat hook prerouting priority dstnat - 1; policy accept;")
	// NOTE: a map lookup that misses ends the rule without a verdict, so
	// only local mesh IPs are translated.
	w(2, "ip daddr %s dnat ip to ip daddr map @mesh_dnat", supernet)
	w(1, "}")
	w(1, "chain nat_postrouting {")
	w(2, "type nat hook postrouting priority srcnat - 1; policy accept;")
	w(2, `oifname "%s" snat ip to ip saddr map @mesh_snat`, Interface)
	w(1, "}")

	w(1, "chain filter_forward {")
	w(2, "type filter hook forward priority filter - 1; policy accept;")
	w(2, `oifname "%s" tcp flags syn tcp option maxseg size set rt mtu`, Interface)
	// Replies of admitted connections pass before the drops below, including
	// those of SNATed connections whose original destination is remote.
	w(2, "ct state established,related ct original ip daddr %s %s accept", supernet, mark)
	w(2, "ct state established,related ct original ip saddr %s %s accept", supernet, mark)
	w(2, `iifname "%s" ip saddr != %s drop`, Interface, supernet)
	egress := slices.Clone(r.RegistryEgress)
	slices.SortFunc(egress, func(a, b Egress) int { return cmp.Or(a.From.Compare(b.From), a.To.Compare(b.To)) })
	for _, e := range slices.Compact(egress) {
		w(2, `iifname != "%s" oifname "%s" ip saddr %s ip daddr %s tcp dport %d %s accept`,
			Interface, Interface, e.From, e.To.Addr(), e.To.Port(), mark)
	}
	w(2, `iifname != "%s" ct original ip daddr %s ip saddr vmap @bridge_env`, Interface, supernet)
	// SECURITY: a container without a mesh IP (or with one this node does
	// not know yet) never reaches the mesh; Docker would masquerade it to
	// this node's .1, which remote nodes admit to routed ports.
	w(2, `iifname != "%s" ct original ip daddr %s drop`, Interface, supernet)
	pairs := slices.Clone(r.ForwardPairs)
	slices.SortFunc(pairs, func(a, b [2]netip.Prefix) int {
		return cmp.Or(comparePrefix(a[0], b[0]), comparePrefix(a[1], b[1]))
	})
	for _, p := range pairs {
		for _, dir := range [][2]netip.Prefix{{p[0], p[1]}, {p[1], p[0]}} {
			w(2, `iifname "%s" oifname "%s" ip saddr %s ip daddr %s %s accept`, Interface, Interface, dir[0], dir[1], mark)
		}
	}
	// NOTE: a primary's mesh registry listener is a container published on
	// .1, so Docker's DNAT makes its connections forwarded, not input.
	w(2, `iifname "%s" ip saddr @nodes meta l4proto tcp ct original ip daddr %s ct original proto-dst %d %s accept`,
		Interface, r.Address, RegistryPort, mark)
	w(2, `iifname "%s" ct original ip daddr vmap @mesh_env_in`, Interface)
	w(2, `iifname "%s" drop`, Interface)
	w(2, `oifname "%s" drop`, Interface)
	w(1, "}")

	w(1, "chain filter_input {")
	w(2, "type filter hook input priority filter - 1; policy accept;")
	w(2, `iifname "%s" ct state established,related accept`, Interface)
	w(2, `iifname "%s" ip saddr != %s drop`, Interface, supernet)
	w(2, `ip daddr %s udp dport 53 iifname != "%s" accept`, r.DNSAddress, Interface)
	w(2, `ip daddr %s tcp dport 53 iifname != "%s" accept`, r.DNSAddress, Interface)
	w(2, "ip daddr %s drop", r.DNSAddress)
	w(2, `iifname "%s" ip daddr %s tcp dport %d ip saddr @nodes accept`, Interface, r.Address, RegistryPort)
	w(2, `iifname "%s" ip daddr %s icmp type echo-request accept`, Interface, r.Address)
	// SECURITY: nothing else on this host answers over the mesh, whichever
	// local address a peer puts in its packets.
	w(2, `iifname "%s" drop`, Interface)
	w(1, "}")
}

// set writes a set or map declaration; kind is a set name, or "map " and a
// map name. An empty set has no elements line, which nft would reject.
func set(w writer, kind, typ string, elements []string, flags ...string) {
	if !strings.HasPrefix(kind, "map ") {
		kind = "set " + kind
	}
	w(1, "%s {", kind)
	w(2, "type %s", typ)
	if len(flags) > 0 {
		w(2, "flags %s", strings.Join(flags, ", "))
	}
	if len(elements) > 0 {
		w(2, "elements = { %s }", strings.Join(elements, ", "))
	}
	w(1, "}")
}

func envSet(tag int) string { return "env_" + strconv.Itoa(tag) }

func envTags(envs map[int][]netip.Addr) []int {
	tags := make([]int, 0, len(envs))
	for t := range envs {
		tags = append(tags, t)
	}
	slices.Sort(tags)
	return tags
}

func addrs(in []netip.Addr) []string {
	sorted := slices.Clone(in)
	slices.SortFunc(sorted, netip.Addr.Compare)
	sorted = slices.Compact(sorted)
	out := make([]string, len(sorted))
	for i, a := range sorted {
		out[i] = a.String()
	}
	return out
}

func addrPorts(in []netip.AddrPort) []string {
	sorted := slices.Clone(in)
	slices.SortFunc(sorted, netip.AddrPort.Compare)
	sorted = slices.Compact(sorted)
	out := make([]string, len(sorted))
	for i, ap := range sorted {
		out[i] = ap.Addr().String() + " . " + strconv.Itoa(int(ap.Port()))
	}
	return out
}

func comparePrefix(a, b netip.Prefix) int {
	return cmp.Or(a.Addr().Compare(b.Addr()), cmp.Compare(a.Bits(), b.Bits()))
}
