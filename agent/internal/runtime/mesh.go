package runtime

import (
	"fmt"
	"net"
	"net/netip"
	"slices"
	"strconv"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// MeshHooks is what the runtime needs from the WireGuard mesh (ADR 0005).
type MeshHooks interface {
	// PrivateDNS returns the private DNS address containers with
	// private_dns resolve through, "" when none is listening; pending means
	// the mesh is still coming up and the answer will change shortly.
	PrivateDNS() (addr string, pending bool)
	// SetReplicas receives the local replicas that have a mesh IP whenever
	// they change, so NAT, isolation and DNS follow container IPs.
	SetReplicas(rs []MeshReplica)
	// SetRegistryProxy receives the running proxy registry, the zero value
	// for none, so it alone may reach its upstream over the mesh.
	SetRegistryProxy(p RegistryProxy)
}

// MeshReplica is a running container with a mesh IP.
type MeshReplica struct {
	MeshIP netip.Addr
	// BridgeIP is the container's address on its environment network.
	BridgeIP netip.Addr
	Healthy  bool
}

// privateDNSWait is the status message of a workload waiting for the
// mesh's private DNS before its container is created.
const privateDNSWait = "waiting for the mesh's private DNS"

// admitRoute checks a route-only workload against the node's mesh, and
// returns why it may not be served ("" when it may).
//
// SECURITY: Caddy runs on the host network and dials upstreams from there,
// so an upstream naming loopback, the metadata endpoint or a LAN address
// would turn a route into a proxy to it. Upstreams must be mesh IPs the
// desired state lists on another node, all of one environment.
func admitRoute(w *protocol.WorkloadSpec, mesh *protocol.MeshConfig, self string) string {
	if w.ProjectID == nil || w.EnvironmentID == nil || w.ServiceID == nil || w.DeploymentID == nil {
		return "refusing route workload without project, environment, service and deployment"
	}
	if mesh == nil {
		return "refusing route workload: this node is not in the mesh"
	}
	if len(w.Upstreams) == 0 || len(w.Routes) == 0 {
		return "refusing route workload without upstreams and routes"
	}
	addrs := make(map[string]protocol.MeshAddress, len(mesh.Addresses))
	for _, a := range mesh.Addresses {
		addrs[a.IP] = a
	}
	tag := 0
	for _, u := range w.Upstreams {
		a, ok := addrs[u.IP]
		switch {
		case !ok || !protocol.IPv4InCIDR(u.IP, mesh.Supernet):
			return fmt.Sprintf("refusing route workload: upstream %s is not a mesh IP of this mesh", u.IP)
		case a.NodeID == self:
			return fmt.Sprintf("refusing route workload: upstream %s runs on this node", u.IP)
		case tag != 0 && a.EnvTag != tag:
			return "refusing route workload: its upstreams span environments"
		}
		tag = a.EnvTag
	}
	return ""
}

// routeSpecs lists the admitted route-only workloads of ds. They have no
// container and report no status; they only add routes.
func (r *Runtime) routeSpecs(ds *protocol.DesiredState) []*wantSpec {
	var out []*wantSpec
	for i := range ds.Workloads {
		w := ds.Workloads[i]
		if w.Kind != protocol.WorkloadRouteOnly || r.blocked[w.ID] != "" {
			continue
		}
		out = append(out, &wantSpec{WorkloadSpec: w, generation: ds.Generation})
	}
	return out
}

// routeUpstreams returns the "ip:port" dial addresses of a route-only
// workload's upstreams on the route's port.
func routeUpstreams(s *wantSpec, port int) []string {
	var out []string
	for _, u := range s.Upstreams {
		if u.Port == port {
			out = append(out, u.IP+":"+strconv.Itoa(u.Port))
		}
	}
	return out
}

// usePrivateDNS decides s's private DNS before its container is created,
// and reports whether the create must wait for the mesh. Caller holds r.mu.
func (r *Runtime) usePrivateDNS(s *wantSpec) (wait bool) {
	s.dns = ""
	if s.PrivateDNS == nil || !*s.PrivateDNS || r.opts.Mesh == nil {
		return false
	}
	addr, pending := r.opts.Mesh.PrivateDNS()
	if addr == "" {
		// NOTE: without a listener the container keeps Docker's own
		// upstreams: names outside the mesh still resolve, and the next
		// recreate picks the private DNS up.
		return pending
	}
	s.dns = addr
	return false
}

// meshReplicas lists the running containers of specs that have a mesh IP:
// the current spec's container, else (mid-rollout) a replaced one still
// running. Caller holds r.mu.
func (r *Runtime) meshReplicas(specs []*wantSpec) []MeshReplica {
	var out []MeshReplica
	for _, s := range specs {
		ip, err := netip.ParseAddr(s.MeshIP)
		if s.MeshIP == "" || err != nil {
			continue
		}
		inst := r.current(s)
		if inst == nil || !inst.running {
			inst = nil
			for _, o := range r.sortedInstances() {
				if o.meta.workloadID == s.ID && o.running && o.drainAt.IsZero() {
					inst = o
				}
			}
		}
		if inst == nil || !inst.running {
			continue
		}
		bridge, err := netip.ParseAddr(inst.ips[s.Network])
		if err != nil {
			continue
		}
		out = append(out, MeshReplica{MeshIP: ip, BridgeIP: bridge, Healthy: inst.health == healthHealthy})
	}
	slices.SortFunc(out, func(a, b MeshReplica) int { return a.MeshIP.Compare(b.MeshIP) })
	return out
}

// withoutRoutes drops route-only workloads, which have no container, from
// the specs the reconciler converges containers and networks for.
func withoutRoutes(specs []*wantSpec) []*wantSpec {
	return slices.DeleteFunc(specs, func(s *wantSpec) bool { return s.Kind == protocol.WorkloadRouteOnly })
}

// RegistryProxy is a running proxy registry container and the peer
// registry it pulls through over the mesh.
type RegistryProxy struct {
	// BridgeIP is the container's address on [SystemNetwork].
	BridgeIP netip.Addr
	Upstream netip.AddrPort
}

// registryProxy returns the running proxy registry of specs, the zero
// value when there is none. Caller holds r.mu.
func (r *Runtime) registryProxy(specs []*wantSpec) RegistryProxy {
	plan := r.registry.Load()
	if plan == nil || plan.mode() != protocol.RegistryProxy || plan.blocked != "" {
		return RegistryProxy{}
	}
	for _, s := range specs {
		if s.ID != RegistryWorkloadID {
			continue
		}
		inst := r.current(s)
		if inst == nil || !inst.running {
			return RegistryProxy{}
		}
		bridge, err := netip.ParseAddr(inst.ips[SystemNetwork])
		if err != nil {
			return RegistryProxy{}
		}
		return RegistryProxy{BridgeIP: bridge, Upstream: plan.upstream}
	}
	return RegistryProxy{}
}

// hasAddress reports whether a host interface carries a.
func (r *Runtime) hasAddress(a netip.Addr) bool {
	if r.opts.HasAddress != nil {
		return r.opts.HasAddress(a)
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, n := range addrs {
		if p, ok := n.(*net.IPNet); ok {
			if ip, ok := netip.AddrFromSlice(p.IP); ok && ip.Unmap() == a {
				return true
			}
		}
	}
	return false
}
