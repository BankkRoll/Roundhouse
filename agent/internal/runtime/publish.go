package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strconv"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/firewall"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// PublishFirewall enforces the TCP proxy's source allowlist on published
// ports (ADR 0004); *firewall.Publisher implements it.
type PublishFirewall interface {
	// Apply makes the allowlist hold exactly ports and reports, per address
	// family, whether it is in place.
	Apply(ctx context.Context, ports []firewall.PublishedPort) firewall.PublishStatus
	// Invalidate makes the next Apply check the kernel's rules even when the
	// allowlist did not change.
	Invalidate()
}

// LabelPublished lists the host ports a container publishes for the TCP
// proxy, as JSON [protocol.PortPublish] values, so the allowlist keeps
// covering them for as long as the container exists.
const LabelPublished = "roundhouse.published"

// publishes reports whether w publishes any port on the host.
func publishes(w *protocol.WorkloadSpec) bool {
	return slices.ContainsFunc(w.Ports, func(p protocol.WorkloadPort) bool { return p.Publish != nil })
}

// publishedPorts returns w's published ports in label form.
func publishedPorts(w *protocol.WorkloadSpec) []protocol.PortPublish {
	var out []protocol.PortPublish
	for _, p := range w.Ports {
		if p.Publish != nil {
			out = append(out, *p.Publish)
		}
	}
	return out
}

// publishBindings is the engine's PortBindings for w's published ports.
// The database's port may be declared "http" or "tcp"; either is published
// as TCP.
func publishBindings(w *protocol.WorkloadSpec) map[string][]docker.PortBinding {
	var out map[string][]docker.PortBinding
	for _, p := range w.Ports {
		if p.Publish == nil {
			continue
		}
		if out == nil {
			out = map[string][]docker.PortBinding{}
		}
		key := strconv.Itoa(p.ContainerPort) + "/tcp"
		out[key] = append(out[key], docker.PortBinding{HostIP: p.Publish.HostIP, HostPort: strconv.Itoa(p.Publish.HostPort)})
	}
	return out
}

func publishedLabel(w *protocol.WorkloadSpec) string {
	ports := publishedPorts(w)
	if len(ports) == 0 {
		return ""
	}
	b, _ := json.Marshal(ports)
	return string(b)
}

func parsePublished(v string) []protocol.PortPublish {
	if v == "" {
		return nil
	}
	var out []protocol.PortPublish
	_ = json.Unmarshal([]byte(v), &out)
	return out
}

// allowlist computes the TCP proxy rules from the desired workloads and the
// containers that exist. Caller holds r.mu.
//
// NOTE: the order of events is what keeps a published port closed to
// sources its owner never admitted:
//   - a desired port's rules are applied before its container is created
//     or started (see [Runtime.publishWait]), so Docker never publishes a
//     port the chain does not cover;
//   - a port stays in the rules, DROP only, for as long as any container
//     that publishes it exists, even after its workload stopped asking for
//     it: removing the rules first would leave a draining or stopping
//     container open to the whole internet;
//   - a port admits a workload's sources only when every container that
//     publishes it belongs to that workload. When the control plane hands a
//     freed port to another workload, the old container keeps it DROP only
//     until it is gone, so the new owner's sources never reach the old
//     owner's database.
//
// A DROP left over for a port no container publishes any more is harmless,
// and goes with the next change.
func (r *Runtime) allowlist(specs []*wantSpec) []firewall.PublishedPort {
	type entry struct {
		port    firewall.PublishedPort
		desired []string // workload IDs asking for the port
		holders map[string]bool
	}
	byPort := map[int]*entry{}
	get := func(port int) *entry {
		e := byPort[port]
		if e == nil {
			e = &entry{port: firewall.PublishedPort{HostPort: port}, holders: map[string]bool{}}
			byPort[port] = e
		}
		return e
	}
	for _, s := range specs {
		if s.Kind != protocol.WorkloadService {
			continue
		}
		for _, p := range publishedPorts(&s.WorkloadSpec) {
			e := get(p.HostPort)
			e.desired = append(e.desired, s.ID)
			e.port.IPv6 = e.port.IPv6 || p.HostIP == "::"
			e.port.Allowed = s.PublishAllowedCIDRs
			e.port.Owner = s.ID
		}
	}
	for _, inst := range r.instances {
		for _, p := range inst.meta.published {
			e := get(p.HostPort)
			e.holders[inst.meta.workloadID] = true
			e.port.IPv6 = e.port.IPv6 || p.HostIP == "::"
			if e.port.Owner == "" {
				e.port.Owner = inst.meta.workloadID
			}
		}
	}
	out := make([]firewall.PublishedPort, 0, len(byPort))
	for _, port := range slices.Sorted(maps.Keys(byPort)) {
		e := byPort[port]
		settled := len(e.desired) == 1
		for holder := range e.holders {
			settled = settled && holder == e.desired[0]
		}
		if !settled {
			e.port.Allowed = nil
		}
		out = append(out, e.port)
	}
	return out
}

// applyAllowlist installs the TCP proxy rules for this pass, before any
// container is created or started. With nothing published and nothing
// installed by this process, it does nothing.
func (r *Runtime) applyAllowlist(ctx context.Context, specs []*wantSpec) {
	if r.opts.Publish == nil {
		return
	}
	r.mu.Lock()
	ports := r.allowlist(specs)
	if len(ports) == 0 && !r.publishUsed {
		r.mu.Unlock()
		return
	}
	r.publishUsed = true
	r.mu.Unlock()
	st := r.opts.Publish.Apply(ctx, ports)
	r.mu.Lock()
	r.publishStatus = st
	r.mu.Unlock()
}

// publishWait returns why s's container may not be created or started yet
// because its published ports are not covered by the allowlist, "" when
// they are or it publishes none. Caller holds r.mu.
func (r *Runtime) publishWait(s *wantSpec) string {
	if !publishes(&s.WorkloadSpec) {
		return ""
	}
	if r.opts.Publish == nil {
		return noPublishReason(&s.WorkloadSpec)
	}
	ipv6 := slices.ContainsFunc(publishedPorts(&s.WorkloadSpec), func(p protocol.PortPublish) bool { return p.HostIP == "::" })
	if !r.publishUsed {
		return "waiting for the TCP proxy's source allowlist to be installed"
	}
	if err := r.publishStatus.Enforced(ipv6); err != nil {
		// SECURITY: fail closed: a port is never published without the rule
		// that drops every source outside publish_allowed_cidrs.
		return "not publishing the port: " + err.Error()
	}
	return ""
}

// publishNote is the status note of a running workload whose allowlist
// edit could not be applied: the rules it started with still hold. Caller
// holds r.mu.
func (r *Runtime) publishNote(s *wantSpec) string {
	if r.opts.Publish == nil || !publishes(&s.WorkloadSpec) || !r.publishUsed {
		return ""
	}
	ipv6 := slices.ContainsFunc(publishedPorts(&s.WorkloadSpec), func(p protocol.PortPublish) bool { return p.HostIP == "::" })
	if err := r.publishStatus.Enforced(ipv6); err != nil {
		return "the TCP proxy allowlist could not be updated; the previous rules still apply: " + err.Error()
	}
	return ""
}

func noPublishReason(w *protocol.WorkloadSpec) string {
	port := 0
	for _, p := range w.Ports {
		if p.Publish != nil {
			port = p.ContainerPort
			break
		}
	}
	return fmt.Sprintf("refusing to publish port %d on the host: this node cannot enforce the TCP proxy's "+
		"source allowlist (it needs iptables, CAP_NET_ADMIN and Docker's DOCKER-USER chain), and will not "+
		"publish a port without it", port)
}
