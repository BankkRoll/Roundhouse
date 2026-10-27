package mesh

import (
	"net"
	"net/netip"
	"strings"
)

// Reachability values of hello.mesh.nat.
const (
	NATPublic = "public"
	NATBehind = "nat"
)

// cgnat is the shared address space of RFC 6598, used by carrier-grade NAT.
var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// Interface is one network interface as NAT inference sees it.
type Interface struct {
	Name  string
	Up    bool
	Addrs []netip.Prefix
}

// ignoredInterface reports whether an interface's addresses say nothing
// about how the internet reaches this host: loopback, Docker's and the
// agent's bridges and veths, and the mesh's own interfaces.
func ignoredInterface(name string) bool {
	switch name {
	case "lo", "docker0", "wg0", "rh-dns0", "docker_gwbridge":
		return true
	}
	for _, p := range []string{"br-", "veth", "rh-"} {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// InferNAT returns [NATPublic] when an up interface other than the ignored
// ones has a global unicast IPv4 address that is not private (RFC 1918),
// not CGNAT (100.64.0.0/10) and not link-local, and [NATBehind] otherwise.
// An operator who knows better (a port forward) sets mesh.endpoint, which
// overrides this.
func InferNAT(ifaces []Interface) string {
	for _, i := range ifaces {
		if !i.Up || ignoredInterface(i.Name) {
			continue
		}
		for _, p := range i.Addrs {
			a := p.Addr().Unmap()
			if a.Is4() && a.IsGlobalUnicast() && !a.IsPrivate() && !cgnat.Contains(a) && !a.IsLinkLocalUnicast() {
				return NATPublic
			}
		}
	}
	return NATBehind
}

// HostInterfaces lists the host's interfaces for [InferNAT].
func HostInterfaces() ([]Interface, error) {
	list, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	out := make([]Interface, 0, len(list))
	for _, ni := range list {
		i := Interface{Name: ni.Name, Up: ni.Flags&net.FlagUp != 0}
		addrs, err := ni.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok {
				ip, ok := netip.AddrFromSlice(ipn.IP)
				if !ok {
					continue
				}
				bits, _ := ipn.Mask.Size()
				i.Addrs = append(i.Addrs, netip.PrefixFrom(ip.Unmap(), bits))
			}
		}
		out = append(out, i)
	}
	return out, nil
}
