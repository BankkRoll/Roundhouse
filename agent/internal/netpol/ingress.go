package netpol

import (
	"cmp"
	"errors"
	"fmt"
	"net/netip"
	"slices"
)

// IngressFilter is desired_state.ingress.allowed_sources, split by family:
// the only sources admitted to the node's ports 80 and 443
// (ingress_firewall cloudflare_only).
type IngressFilter struct {
	V4, V6 []netip.Prefix
}

// ParseIngress parses allowed_sources; nil (no filter) gives nil. Prefixes
// are masked, and those inside another are dropped, since nft refuses
// overlapping intervals in one set.
//
// SECURITY: the filter fails closed. Non-nil sources always give a filter,
// of the valid entries only, with an error naming the others: a bad entry
// narrows what is admitted, it never lifts the filter.
func ParseIngress(sources *[]string) (*IngressFilter, error) {
	if sources == nil {
		return nil, nil
	}
	f := &IngressFilter{}
	var errs []error
	for _, s := range *sources {
		p, err := netip.ParsePrefix(s)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if p.Addr().Is4() {
			f.V4 = append(f.V4, p.Masked())
		} else {
			f.V6 = append(f.V6, p.Masked())
		}
	}
	f.V4, f.V6 = disjoint(f.V4), disjoint(f.V6)
	if err := errors.Join(errs...); err != nil {
		return f, fmt.Errorf("ingress.allowed_sources: %w", err)
	}
	return f, nil
}

// disjoint sorts prefixes and drops each that another one covers.
func disjoint(in []netip.Prefix) []netip.Prefix {
	slices.SortFunc(in, func(a, b netip.Prefix) int {
		return cmp.Or(a.Addr().Compare(b.Addr()), cmp.Compare(a.Bits(), b.Bits()))
	})
	var out []netip.Prefix
	for _, p := range in {
		// Sorted by address, a prefix inside an earlier one comes after it
		// and after everything else inside it, so only the last kept one
		// can cover it.
		if n := len(out); n > 0 && out[n-1].Bits() <= p.Bits() && out[n-1].Contains(p.Addr()) {
			continue
		}
		out = append(out, p)
	}
	return out
}

// renderIngress writes the ingress source filter: an input chain that
// returns early for everything but TCP and UDP (HTTP/3) to ports 80 and
// 443, admits those from the allowed sources, loopback and, on a meshed
// node, other nodes over wg0, and drops the rest.
//
// SECURITY: a drop in this table is final whatever Docker's or the host
// firewall's chains accept later; an accept here only ends this chain.
func renderIngress(w writer, r Ruleset) {
	set(w, "ingress_v4", "ipv4_addr", prefixes(r.Ingress.V4), "interval")
	set(w, "ingress_v6", "ipv6_addr", prefixes(r.Ingress.V6), "interval")
	w(1, "chain ingress_filter {")
	w(2, "type filter hook input priority filter - 1; policy accept;")
	w(2, `iifname "lo" accept`)
	w(2, "meta l4proto != { tcp, udp } accept")
	w(2, "th dport != { 80, 443 } accept")
	w(2, "ip saddr @ingress_v4 accept")
	w(2, "ip6 saddr @ingress_v6 accept")
	if r.meshed() {
		w(2, `iifname "%s" ip saddr @nodes accept`, Interface)
	}
	w(2, "drop")
	w(1, "}")
}

func prefixes(in []netip.Prefix) []string {
	out := make([]string, len(in))
	for i, p := range in {
		out[i] = p.String()
	}
	return out
}

// String summarises f for logs: how many ranges of each family.
func (f *IngressFilter) String() string {
	if f == nil {
		return "none"
	}
	return fmt.Sprintf("%d IPv4 and %d IPv6 ranges", len(f.V4), len(f.V6))
}
