package jobs

import (
	"context"
	"net/netip"
	"slices"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// MeshRun is a running job container with a mesh IP (ADR 0005): the mesh
// NATs the mesh IP to its bridge IP and admits it to its environment.
type MeshRun struct {
	MeshIP   netip.Addr
	BridgeIP netip.Addr
}

// dnsWait bounds how long a run with private_dns waits for a mesh that is
// still coming up; dnsPoll is how often it looks.
const (
	dnsWait = 30 * time.Second
	dnsPoll = 250 * time.Millisecond
)

// privateDNS returns the private DNS server a run with private_dns resolves
// through, "" for Docker's own upstreams. Like a replica, the run waits
// while the mesh is still coming up, at most [dnsWait] (scaled by the test
// unit); with no listener after that, names outside the mesh must keep
// resolving, so it goes without.
func (r *Runner) privateDNS(ctx context.Context, w *protocol.WorkloadSpec) string {
	if w.PrivateDNS == nil || !*w.PrivateDNS || r.opts.PrivateDNS == nil {
		return ""
	}
	deadline := time.Now().Add(dnsWait * r.opts.unit / time.Second)
	for {
		addr, pending := r.opts.PrivateDNS()
		if addr != "" || !pending || time.Now().After(deadline) || !sleep(ctx, dnsPoll) {
			return addr
		}
	}
}

// withDNS points cc at dns when it is set.
func withDNS(cc docker.ContainerCreate, dns string) docker.ContainerCreate {
	if dns != "" {
		cc.HostConfig.DNS = []string{dns}
	}
	return cc
}

// joinMesh records a started run's mesh IP and its bridge IP from info and
// reports the running set, so its traffic is NATed and admitted from the
// first packet it sends after the report.
func (r *Runner) joinMesh(rn *run, info docker.ContainerInfo) {
	r.mu.Lock()
	meshIP, network := rn.meshIP, rn.network
	r.mu.Unlock()
	if r.opts.MeshRuns == nil || meshIP == "" {
		return
	}
	mesh, err := netip.ParseAddr(meshIP)
	if err != nil {
		return
	}
	bridge, err := netip.ParseAddr(info.NetworkSettings.Networks[network].IPAddress)
	if err != nil {
		r.log.Warn("job has no address on its network; it stays off the mesh", "run_id", rn.id, "network", network)
		return
	}
	r.mu.Lock()
	rn.mesh = &MeshRun{MeshIP: mesh, BridgeIP: bridge}
	r.mu.Unlock()
	r.reportMesh()
}

// leaveMesh drops a run from the mesh once its container exited.
//
// SECURITY: right away, not after its logs are shipped: the exited
// container's bridge IP is free for another container, which the NAT
// would otherwise hand the run's mesh IP and environment.
func (r *Runner) leaveMesh(rn *run) {
	r.mu.Lock()
	had := rn.mesh != nil
	rn.mesh = nil
	r.mu.Unlock()
	if had {
		r.reportMesh()
	}
}

// reportMesh hands the mesh every running run with a mesh IP.
func (r *Runner) reportMesh() {
	if r.opts.MeshRuns == nil {
		return
	}
	// meshMu keeps two reports from reaching the mesh out of order.
	r.meshMu.Lock()
	defer r.meshMu.Unlock()
	r.mu.Lock()
	var out []MeshRun
	for _, rn := range r.runs {
		if rn.mesh != nil && !rn.terminal() {
			out = append(out, *rn.mesh)
		}
	}
	r.mu.Unlock()
	slices.SortFunc(out, func(a, b MeshRun) int { return a.MeshIP.Compare(b.MeshIP) })
	r.opts.MeshRuns(out)
}
