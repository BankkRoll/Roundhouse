package runtime

import (
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/BankkRoll/Roundhouse/agent/internal/ingress"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

type fakeMesh struct {
	mu       sync.Mutex
	addr     string
	pending  bool
	replicas []MeshReplica
	proxy    RegistryProxy
}

func (m *fakeMesh) SetRegistryProxy(p RegistryProxy) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.proxy = p
}

func (m *fakeMesh) registryProxy() RegistryProxy {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.proxy
}

func (m *fakeMesh) PrivateDNS() (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.addr, m.pending
}

func (m *fakeMesh) SetReplicas(rs []MeshReplica) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.replicas = rs
}

func (m *fakeMesh) set(addr string, pending bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.addr, m.pending = addr, pending
}

func (m *fakeMesh) current() []MeshReplica {
	m.mu.Lock()
	defer m.mu.Unlock()
	return slices.Clone(m.replicas)
}

func meshFor(addrs ...protocol.MeshAddress) *protocol.MeshConfig {
	return &protocol.MeshConfig{
		Supernet: "10.200.0.0/16", NodeIndex: 1, Address: "10.200.1.1", DNSAddress: "10.200.1.2",
		ListenPort: 51820, MTU: 1420, AcceptFwmark: 0x2000000, Addresses: addrs,
	}
}

func routeWorkload(id string, ups ...protocol.Upstream) protocol.WorkloadSpec {
	w := spec(id, "svc_web")
	w.Kind = protocol.WorkloadRouteOnly
	w.Env, w.Healthcheck, w.EnvSealed = nil, nil, nil
	w.Upstreams = ups
	return rehash(w)
}

func TestAdmitRoute(t *testing.T) {
	mesh := meshFor(
		protocol.MeshAddress{IP: "10.200.2.10", EnvTag: 3, NodeID: "node_b"},
		protocol.MeshAddress{IP: "10.200.3.10", EnvTag: 4, NodeID: "node_c"},
		protocol.MeshAddress{IP: "10.200.1.10", EnvTag: 3, NodeID: "node_a"},
	)
	cases := []struct {
		name string
		ups  []protocol.Upstream
		mesh *protocol.MeshConfig
		want string
	}{
		{"remote mesh IP", []protocol.Upstream{{IP: "10.200.2.10", Port: 80}}, mesh, ""},
		{"no mesh", []protocol.Upstream{{IP: "10.200.2.10", Port: 80}}, nil, "not in the mesh"},
		{"loopback", []protocol.Upstream{{IP: "127.0.0.1", Port: 2019}}, mesh, "not a mesh IP"},
		{"metadata", []protocol.Upstream{{IP: "169.254.169.254", Port: 80}}, mesh, "not a mesh IP"},
		{"unlisted mesh IP", []protocol.Upstream{{IP: "10.200.2.99", Port: 80}}, mesh, "not a mesh IP"},
		{"own node", []protocol.Upstream{{IP: "10.200.1.10", Port: 80}}, mesh, "runs on this node"},
		{"two environments", []protocol.Upstream{{IP: "10.200.2.10", Port: 80}, {IP: "10.200.3.10", Port: 80}}, mesh, "span environments"},
		{"none", nil, mesh, "without upstreams"},
	}
	for _, tc := range cases {
		w := routeWorkload("wl_r", tc.ups...)
		got := admitRoute(&w, tc.mesh, "node_a")
		if (tc.want == "") != (got == "") || !strings.Contains(got, tc.want) {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestRouteWorkloadServesRemoteUpstreams(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Namespace = "node_a" })
	ds := desired(1, routeWorkload("wl_route", protocol.Upstream{IP: "10.200.2.10", Port: 80}, protocol.Upstream{IP: "10.200.2.11", Port: 80},
		protocol.Upstream{IP: "10.200.2.12", Port: 9000}))
	ds.Mesh = meshFor(
		protocol.MeshAddress{IP: "10.200.2.10", EnvTag: 3, NodeID: "node_b"},
		protocol.MeshAddress{IP: "10.200.2.11", EnvTag: 3, NodeID: "node_b"},
		protocol.MeshAddress{IP: "10.200.2.12", EnvTag: 3, NodeID: "node_b"},
	)
	if !h.rt.Apply(ds) {
		t.Fatal("Apply refused")
	}
	var got ingress.Route
	eventually(t, "the route in the ingress config", func() bool {
		for _, r := range h.ing.last().Routes {
			if r.Host == "app.example.com" {
				got = r
				return true
			}
		}
		return false
	})
	if !slices.Equal(got.Upstreams, []string{"10.200.2.10:80", "10.200.2.11:80"}) || !slices.Equal(got.Ports, []int{80}) {
		t.Errorf("route = %+v", got)
	}
	if !slices.Contains(h.ing.last().AllowedHosts, "app.example.com") {
		t.Error("route host not allowed for certificates")
	}
	if ops := h.d.opLog(); slices.ContainsFunc(ops, func(op string) bool { return strings.HasPrefix(op, "create") || strings.HasPrefix(op, "pull") }) {
		t.Errorf("route workload touched the engine: %v", ops)
	}
	if _, ok := h.status.lastOf("wl_route"); ok {
		t.Error("route workload reported a status")
	}
	for _, s := range h.rt.Statuses() {
		if s.WorkloadID == "wl_route" {
			t.Error("route workload in hello's statuses")
		}
	}
}

func TestRouteWorkloadRefusedOffMesh(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Namespace = "node_a" })
	if !h.rt.Apply(desired(1, routeWorkload("wl_route", protocol.Upstream{IP: "127.0.0.1", Port: 2019}))) {
		t.Fatal("Apply refused")
	}
	eventually(t, "a pass", func() bool { return len(h.ing.all()) > 0 })
	for _, r := range h.ing.last().Routes {
		if slices.Contains(r.Upstreams, "127.0.0.1:2019") {
			t.Fatal("a refused route workload's upstream reached the ingress")
		}
	}
}

func TestPrivateDNSGating(t *testing.T) {
	mesh := &fakeMesh{pending: true}
	h := newHarness(t, func(o *Options) { o.Mesh = mesh })
	w := spec("wl_a", "svc_web")
	w.PrivateDNS = ptr(true)
	w.MeshIP = "10.200.1.10"
	h.rt.Apply(desired(1, rehash(w)))
	eventually(t, "the workload to wait for private DNS", func() bool {
		st, ok := h.status.lastOf("wl_a")
		return ok && st.Message == privateDNSWait
	})
	if len(h.d.byWorkload("wl_a")) != 0 {
		t.Fatal("container created while the mesh was still coming up")
	}
	mesh.set("10.200.1.2", false)
	eventually(t, "the container", func() bool { return len(h.d.byWorkload("wl_a")) == 1 })
	c := h.d.byWorkload("wl_a")[0]
	if !slices.Equal(c.spec.HostConfig.DNS, []string{"10.200.1.2"}) {
		t.Errorf("HostConfig.Dns = %v", c.spec.HostConfig.DNS)
	}
	h.probes.set(c.ip, true)
	eventually(t, "the mesh replica", func() bool {
		rs := mesh.current()
		return len(rs) == 1 && rs[0].MeshIP.String() == "10.200.1.10" && rs[0].BridgeIP.String() == c.ip && rs[0].Healthy
	})
}

func TestPrivateDNSOmittedWithoutListener(t *testing.T) {
	mesh := &fakeMesh{}
	h := newHarness(t, func(o *Options) { o.Mesh = mesh })
	w := spec("wl_a", "svc_web")
	w.PrivateDNS = ptr(true)
	other := spec("wl_b", "svc_api")
	other.Routes = nil
	h.rt.Apply(desired(1, rehash(w), other))
	eventually(t, "both containers", func() bool { return len(h.d.byWorkload("wl_a")) == 1 && len(h.d.byWorkload("wl_b")) == 1 })
	for _, id := range []string{"wl_a", "wl_b"} {
		if dns := h.d.byWorkload(id)[0].spec.HostConfig.DNS; dns != nil {
			t.Errorf("%s: HostConfig.Dns = %v, want Docker's own", id, dns)
		}
	}
	// Without private_dns the mesh's DNS is never used.
	mesh.set("10.200.1.2", false)
	if s := (&wantSpec{WorkloadSpec: other}); h.rt.usePrivateDNS(s) || s.dns != "" {
		t.Errorf("private DNS for a workload without private_dns: %q", s.dns)
	}
}

func TestRemoteReplicasServeOnlyWithoutHealthyLocalOnes(t *testing.T) {
	rt := New(Options{Docker: newFakeDocker()})
	w := spec("wl_a", "svc_web")
	ws := &wantSpec{WorkloadSpec: w}
	route := routeWorkload("wl_route", protocol.Upstream{IP: "10.200.2.10", Port: w.Routes[0].ContainerPort})
	route.Routes = w.Routes
	routes := []*wantSpec{{WorkloadSpec: route}}
	ds := desired(1, w)
	upstreams := func() []string {
		c := rt.ingressConfig(ds, []*wantSpec{ws}, nil, routes)
		if len(c.Routes) != 1 {
			t.Fatalf("routes = %+v", c.Routes)
		}
		return c.Routes[0].Upstreams
	}
	remote := fmt.Sprintf("10.200.2.10:%d", w.Routes[0].ContainerPort)
	local := fmt.Sprintf("10.0.0.2:%d", w.Routes[0].ContainerPort)

	if got := upstreams(); !slices.Equal(got, []string{remote}) {
		t.Fatalf("no local container: %v", got)
	}
	inst := &instance{id: "c1", running: true, health: healthUnhealthy, ips: map[string]string{w.Network: "10.0.0.2"},
		meta: meta{workloadID: "wl_a", specHash: w.SpecHash, network: w.Network, routes: w.Routes}}
	rt.instances["c1"] = inst
	if got := upstreams(); !slices.Equal(got, []string{remote}) {
		t.Fatalf("unhealthy local container: %v", got)
	}
	inst.health = healthHealthy
	if got := upstreams(); !slices.Equal(got, []string{local}) {
		t.Fatalf("healthy local container: %v", got)
	}
}
