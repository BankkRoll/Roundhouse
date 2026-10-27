package runtime

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/firewall"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// fakePublish records every allowlist the runtime applies and checks, at
// each apply, that no existing container's port goes uncovered and that a
// port admits sources only when every container holding it is its owner's.
type fakePublish struct {
	d *fakeDocker

	mu          sync.Mutex
	status      firewall.PublishStatus
	current     map[int]firewall.PublishedPort
	applies     [][]firewall.PublishedPort
	violations  []string
	invalidated int
}

func newFakePublish(d *fakeDocker) *fakePublish {
	return &fakePublish{d: d, current: map[int]firewall.PublishedPort{}}
}

func (p *fakePublish) Apply(_ context.Context, ports []firewall.PublishedPort) firewall.PublishStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.applies = append(p.applies, slices.Clone(ports))
	byPort := map[int]firewall.PublishedPort{}
	for _, port := range ports {
		byPort[port.HostPort] = port
	}
	p.d.mu.Lock()
	for _, c := range p.d.containers {
		for _, pub := range parsePublished(c.spec.Labels[LabelPublished]) {
			port, ok := byPort[pub.HostPort]
			wl := c.spec.Labels[LabelWorkloadID]
			switch {
			case !ok:
				p.violations = append(p.violations, fmt.Sprintf("container of %s publishes %d outside the allowlist", wl, pub.HostPort))
			case len(port.Allowed) > 0 && port.Owner != wl:
				p.violations = append(p.violations, fmt.Sprintf("port %d admits %s's sources into %s's container", pub.HostPort, port.Owner, wl))
			case pub.HostIP == "::" && !port.IPv6:
				p.violations = append(p.violations, fmt.Sprintf("port %d on :: without IPv6 rules", pub.HostPort))
			}
		}
	}
	p.d.mu.Unlock()
	if p.status.IPv4 == nil {
		p.current = byPort
	}
	return p.status
}

func (p *fakePublish) Invalidate() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.invalidated++
}

func (p *fakePublish) setStatus(st firewall.PublishStatus) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.status = st
}

func (p *fakePublish) port(n int) (firewall.PublishedPort, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	port, ok := p.current[n]
	return port, ok
}

func (p *fakePublish) check(t *testing.T) {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.violations) > 0 {
		t.Fatalf("allowlist violations:\n%s", strings.Join(p.violations, "\n"))
	}
}

// guardedDocker refuses to create or start a container whose published
// ports the latest successful allowlist does not cover with its owner's
// sources, as a real host would expose them.
type guardedDocker struct {
	*fakeDocker
	pub *fakePublish
}

func (g *guardedDocker) covered(labels map[string]string) error {
	for _, pub := range parsePublished(labels[LabelPublished]) {
		port, ok := g.pub.port(pub.HostPort)
		if !ok || port.Owner != labels[LabelWorkloadID] {
			return fmt.Errorf("port %d published before its allowlist", pub.HostPort)
		}
	}
	return nil
}

func (g *guardedDocker) CreateContainer(ctx context.Context, name string, spec docker.ContainerCreate) (string, error) {
	if err := g.covered(spec.Labels); err != nil {
		g.pub.mu.Lock()
		g.pub.violations = append(g.pub.violations, err.Error())
		g.pub.mu.Unlock()
		return "", err
	}
	return g.fakeDocker.CreateContainer(ctx, name, spec)
}

func (g *guardedDocker) StartContainer(ctx context.Context, id string) error {
	g.fakeDocker.mu.Lock()
	c := g.fakeDocker.containers[id]
	var labels map[string]string
	if c != nil {
		labels = maps.Clone(c.spec.Labels)
	}
	g.fakeDocker.mu.Unlock()
	if err := g.covered(labels); err != nil {
		g.pub.mu.Lock()
		g.pub.violations = append(g.pub.violations, err.Error())
		g.pub.mu.Unlock()
		return err
	}
	return g.fakeDocker.StartContainer(ctx, id)
}

// publishedSpec returns a database-like workload publishing 5432 on port.
func publishedSpec(id, service string, port int, hostIP string, cidrs ...string) protocol.WorkloadSpec {
	w := spec(id, service)
	w.Routes = nil
	w.Healthcheck = nil
	w.Ports = []protocol.WorkloadPort{{ContainerPort: 5432, Protocol: protocol.PortTCP,
		Publish: &protocol.PortPublish{HostPort: port, HostIP: hostIP}}}
	w.PublishAllowedCIDRs = cidrs
	return rehash(w)
}

func newPublishHarness(t *testing.T) (*harness, *fakePublish) {
	t.Helper()
	var pub *fakePublish
	h := newHarness(t, func(o *Options) {
		d := o.Docker.(*fakeDocker)
		pub = newFakePublish(d)
		o.Docker = &guardedDocker{fakeDocker: d, pub: pub}
		o.Publish = pub
	})
	t.Cleanup(func() { pub.check(t) })
	return h, pub
}

func TestPublishedPortIsBoundBehindItsAllowlist(t *testing.T) {
	h, pub := newPublishHarness(t)
	w := publishedSpec("wl_db", "svc_db", 25432, "0.0.0.0", "203.0.113.0/24")
	h.rt.Apply(desired(1, w))
	h.waitState("wl_db", protocol.StateHealthy)
	c := h.running("wl_db")

	want := map[string][]docker.PortBinding{"5432/tcp": {{HostIP: "0.0.0.0", HostPort: "25432"}}}
	if !maps.EqualFunc(c.spec.HostConfig.PortBindings, want, slices.Equal) {
		t.Fatalf("port bindings %+v", c.spec.HostConfig.PortBindings)
	}
	if _, ok := c.spec.ExposedPorts["5432/tcp"]; !ok {
		t.Fatalf("exposed ports %v", c.spec.ExposedPorts)
	}
	if got := parsePublished(c.spec.Labels[LabelPublished]); !slices.Equal(got, []protocol.PortPublish{{HostPort: 25432, HostIP: "0.0.0.0"}}) {
		t.Fatalf("published label %q", c.spec.Labels[LabelPublished])
	}
	port, _ := pub.port(25432)
	if port.Owner != "wl_db" || port.IPv6 || !slices.Equal(port.Allowed, []string{"203.0.113.0/24"}) {
		t.Fatalf("allowlist %+v", port)
	}

	v6 := publishedSpec("wl_v6", "svc_v6", 25433, "::", "2001:db8::/32")
	h.rt.Apply(desired(2, w, v6))
	h.waitState("wl_v6", protocol.StateHealthy)
	if port, _ := pub.port(25433); !port.IPv6 || !slices.Equal(port.Allowed, []string{"2001:db8::/32"}) {
		t.Fatalf("a port on :: needs IPv6 rules: %+v", port)
	}
	want = map[string][]docker.PortBinding{"5432/tcp": {{HostIP: "0.0.0.0", HostPort: "25433"}, {HostIP: "::", HostPort: "25433"}}}
	if got := h.running("wl_v6").spec.HostConfig.PortBindings; !maps.EqualFunc(got, want, slices.Equal) {
		t.Fatalf("a port on :: must be bound on both families: %+v", got)
	}
}

func TestPublishFailsClosed(t *testing.T) {
	h, pub := newPublishHarness(t)
	pub.setStatus(firewall.PublishStatus{IPv4: errors.New("iptables-restore: not found")})
	h.rt.Apply(desired(1, publishedSpec("wl_db", "svc_db", 25432, "0.0.0.0", "203.0.113.0/24")))
	eventually(t, "the workload waits for the allowlist", func() bool {
		return h.state("wl_db") == protocol.StatePending && strings.Contains(h.message("wl_db"), "iptables-restore: not found")
	})
	time.Sleep(50 * time.Millisecond)
	if n := len(h.d.byWorkload("wl_db")); n != 0 {
		t.Fatalf("%d containers created without the allowlist", n)
	}
	pub.setStatus(firewall.PublishStatus{})
	h.waitState("wl_db", protocol.StateHealthy)
}

func TestPublishIPv6FailureRefusesOnlyPortsOnIPv6(t *testing.T) {
	h, pub := newPublishHarness(t)
	pub.setStatus(firewall.PublishStatus{IPv6: errors.New("ip6tables-restore: permission denied")})
	h.rt.Apply(desired(1,
		publishedSpec("wl_v4", "svc_v4", 25432, "0.0.0.0", "203.0.113.0/24"),
		publishedSpec("wl_v6", "svc_v6", 25433, "::", "2001:db8::/32"),
	))
	h.waitState("wl_v4", protocol.StateHealthy)
	eventually(t, "the IPv6 workload refused", func() bool {
		return h.state("wl_v6") == protocol.StatePending && strings.Contains(h.message("wl_v6"), "ip6tables-restore")
	})
	if n := len(h.d.byWorkload("wl_v6")); n != 0 {
		t.Fatalf("%d containers created without IPv6 rules", n)
	}
}

func TestPublishedContainerDoesNotRestartWithoutItsAllowlist(t *testing.T) {
	h, pub := newPublishHarness(t)
	h.rt.Apply(desired(1, publishedSpec("wl_db", "svc_db", 25432, "0.0.0.0", "203.0.113.0/24")))
	c := h.running("wl_db")
	pub.setStatus(firewall.PublishStatus{IPv4: errors.New("DOCKER-USER chain is missing")})
	eventually(t, "the failure noted on the running workload", func() bool {
		return strings.Contains(h.message("wl_db"), "previous rules still apply")
	})
	h.d.crash(c.id, 1)
	eventually(t, "the restart held back", func() bool {
		return strings.Contains(h.message("wl_db"), "not publishing the port")
	})
	time.Sleep(100 * time.Millisecond)
	if cs := h.d.byWorkload("wl_db"); len(cs) != 1 || cs[0].state.Running {
		t.Fatalf("restarted without the allowlist: %+v", cs)
	}
	pub.setStatus(firewall.PublishStatus{})
	h.waitState("wl_db", protocol.StateHealthy)
}

func TestAllowlistEditAppliesWithoutRecreating(t *testing.T) {
	h, pub := newPublishHarness(t)
	w := publishedSpec("wl_db", "svc_db", 25432, "0.0.0.0", "203.0.113.0/24")
	h.rt.Apply(desired(1, w))
	c := h.running("wl_db")

	edited := w
	edited.PublishAllowedCIDRs = []string{"198.51.100.0/24", "2001:db8::/32"}
	if rehash(edited).SpecHash != w.SpecHash {
		t.Fatal("publish_allowed_cidrs must not be hashed")
	}
	h.rt.Apply(desired(2, edited))
	eventually(t, "the edited allowlist", func() bool {
		port, _ := pub.port(25432)
		return slices.Equal(port.Allowed, edited.PublishAllowedCIDRs)
	})
	if cs := h.d.byWorkload("wl_db"); len(cs) != 1 || cs[0].id != c.id || len(cs[0].starts) != 1 {
		t.Fatalf("the edit recreated or restarted the container: %+v", cs)
	}
}

func TestStalePortStaysClosedUntilItsContainerIsGone(t *testing.T) {
	h, pub := newPublishHarness(t)
	a := publishedSpec("wl_a", "svc_a", 25432, "0.0.0.0", "203.0.113.0/24")
	h.rt.Apply(desired(1, a))
	h.running("wl_a")

	// The port moves to another workload in the same generation as wl_a
	// moves to a new port; wl_a's old container must not admit wl_b's
	// sources while it drains (fakePublish checks every apply).
	movedA := publishedSpec("wl_a", "svc_a", 25440, "0.0.0.0", "203.0.113.0/24")
	b := publishedSpec("wl_b", "svc_b", 25432, "0.0.0.0", "198.51.100.0/24")
	h.rt.Apply(desired(2, movedA, b))
	h.waitState("wl_a", protocol.StateHealthy)
	h.waitState("wl_b", protocol.StateHealthy)
	if port, _ := pub.port(25432); port.Owner != "wl_b" || !slices.Equal(port.Allowed, b.PublishAllowedCIDRs) {
		t.Fatalf("port 25432 %+v", port)
	}

	h.rt.Apply(desired(3, movedA))
	eventually(t, "wl_b's port dropped from the allowlist once its container is gone", func() bool {
		_, ok := pub.port(25432)
		return !ok && len(h.d.byWorkload("wl_b")) == 0
	})
}

func TestStalePortIsDropOnlyWhileItsContainerExists(t *testing.T) {
	d := newFakeDocker()
	pub := newFakePublish(d)
	rt := New(Options{Docker: d, Publish: pub})
	old := publishedSpec("wl_a", "svc_a", 25432, "0.0.0.0", "203.0.113.0/24")
	rt.instances["c1"] = &instance{id: "c1", meta: parseMeta(containerLabels(&wantSpec{WorkloadSpec: old}))}
	b := publishedSpec("wl_b", "svc_b", 25432, "0.0.0.0", "198.51.100.0/24")
	ports := rt.allowlist([]*wantSpec{{WorkloadSpec: b}})
	if len(ports) != 1 || ports[0].HostPort != 25432 || len(ports[0].Allowed) != 0 {
		t.Fatalf("a port another workload's container still holds must be drop only: %+v", ports)
	}
	ports = rt.allowlist(nil)
	if len(ports) != 1 || len(ports[0].Allowed) != 0 {
		t.Fatalf("an undesired port must stay, drop only, while its container exists: %+v", ports)
	}
	same := publishedSpec("wl_a", "svc_a", 25432, "0.0.0.0", "192.0.2.0/24")
	ports = rt.allowlist([]*wantSpec{{WorkloadSpec: same}})
	if len(ports) != 1 || !slices.Equal(ports[0].Allowed, []string{"192.0.2.0/24"}) {
		t.Fatalf("the owner's own container takes its new sources: %+v", ports)
	}
	twice := []*wantSpec{{WorkloadSpec: same}, {WorkloadSpec: publishedSpec("wl_c", "svc_c", 25432, "0.0.0.0", "0.0.0.0/0")}}
	if ports = rt.allowlist(twice); len(ports[0].Allowed) != 0 {
		t.Fatalf("a port two workloads claim must be drop only: %+v", ports)
	}
	delete(rt.instances, "c1")
	if ports := rt.allowlist(nil); len(ports) != 0 {
		t.Fatalf("ports %+v", ports)
	}
}

func TestPublishedLabelCannotBeSpoofed(t *testing.T) {
	w := spec("wl_a", "svc_web")
	w.Labels[LabelPublished] = `[{"host_port":25432,"host_ip":"0.0.0.0"}]`
	if l := containerLabels(&wantSpec{WorkloadSpec: w}); l[LabelPublished] != "" {
		t.Fatalf("user label kept: %q", l[LabelPublished])
	}
}

func TestPublishBindings(t *testing.T) {
	v4 := publishedSpec("wl_a", "svc_a", 25432, "0.0.0.0", "203.0.113.0/24")
	want := map[string][]docker.PortBinding{"5432/tcp": {{HostIP: "0.0.0.0", HostPort: "25432"}}}
	if got := publishBindings(&v4); !maps.EqualFunc(got, want, slices.Equal) {
		t.Fatalf("0.0.0.0 must publish on IPv4 only: %+v", got)
	}
	dual := publishedSpec("wl_b", "svc_b", 25433, "::", "203.0.113.0/24", "2001:db8::/32")
	want = map[string][]docker.PortBinding{"5432/tcp": {{HostIP: "0.0.0.0", HostPort: "25433"}, {HostIP: "::", HostPort: "25433"}}}
	if got := publishBindings(&dual); !maps.EqualFunc(got, want, slices.Equal) {
		t.Fatalf(":: must publish on both families: %+v", got)
	}
	if got := publishBindings(&protocol.WorkloadSpec{Ports: []protocol.WorkloadPort{{ContainerPort: 80}}}); got != nil {
		t.Fatalf("no published port: %+v", got)
	}
}
