package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/BankkRoll/Open-Rail/agent/internal/atomicfile"
	"github.com/BankkRoll/Open-Rail/agent/internal/docker"
	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
)

// adoptedFile, under [Options.DataDir], lists the unlabelled containers the
// runtime adopted. It holds container IDs only, nothing secret.
const adoptedFile = "adopted-containers.json"

// networkGCInterval is how often unused networks are looked for. A variable
// so tests can shorten it.
var networkGCInterval = time.Minute

func (r *Runtime) adoptedPath() string {
	if r.opts.DataDir == "" {
		return ""
	}
	return filepath.Join(r.opts.DataDir, adoptedFile)
}

// loadAdopted reads the adopted container IDs; a missing or unreadable file
// means none, since a container whose workload is still desired is simply
// adopted again.
func loadAdopted(path string, log *slog.Logger) map[string]bool {
	out := map[string]bool{}
	if path == "" {
		return out
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Warn("read adopted containers", "path", path, "err", err)
		}
		return out
	}
	var ids []string
	if err := json.Unmarshal(data, &ids); err != nil {
		log.Warn("adopted containers file is corrupt; ignoring it", "path", path, "err", err)
		return out
	}
	for _, id := range ids {
		out[id] = true
	}
	return out
}

// saveAdopted persists r.adopted. Caller holds r.mu.
func (r *Runtime) saveAdopted() {
	path := r.adoptedPath()
	if path == "" {
		return
	}
	ids := make([]string, 0, len(r.adopted))
	for id := range r.adopted {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	data, _ := json.Marshal(ids)
	if err := atomicfile.Write(path, data, 0o600); err != nil {
		r.log.Warn("persist adopted containers", "path", path, "err", err)
	}
}

// listOwn lists the containers this runtime manages: those in its namespace
// and, with [Options.AdoptUnlabelled], unlabelled ones it adopts.
//
// SECURITY: an agent sharing its Docker engine with another node (or with a
// Phase 1 agent) must never manage, drain or remove that node's containers.
// Containers of another namespace are therefore invisible, and an
// unlabelled one is adopted only once this node's desired state names its
// workload, which a control plane only does for workloads it placed here.
func (r *Runtime) listOwn(ctx context.Context) ([]docker.ContainerSummary, error) {
	if !r.adopting() {
		return r.d.ListContainers(ctx, r.selector()...)
	}
	all, err := r.d.ListContainers(ctx, ManagedFilter)
	if err != nil {
		return nil, err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	var wanted map[string]bool
	if ds := r.desired; ds != nil {
		specs := r.wantSpecs(ds)
		wanted = make(map[string]bool, len(specs))
		for _, s := range specs {
			wanted[s.ID] = true
		}
	}
	changed := false
	present := make(map[string]bool, len(all))
	own := all[:0:0]
	for _, c := range all {
		present[c.ID] = true
		switch ns := c.Labels[LabelNamespace]; {
		case ns == r.opts.Namespace:
			own = append(own, c)
		case ns != "":
			// Another node's (or a test's) container.
		case r.adopted[c.ID]:
			own = append(own, c)
		case wanted[c.Labels[LabelWorkloadID]]:
			r.adopted[c.ID] = true
			changed = true
			r.log.Info("adopting a container created before node namespaces",
				"container", short(c.ID), "workload_id", c.Labels[LabelWorkloadID])
			own = append(own, c)
		}
	}
	for id := range r.adopted {
		if !present[id] {
			delete(r.adopted, id)
			changed = true
		}
	}
	if changed {
		r.saveAdopted()
	}
	return own, nil
}

// collectNetworks removes networks that no desired workload and no remaining
// container uses, at most once per [networkGCInterval]: this namespace's
// environment networks, and the Phase 1 per-project network of a project
// this node runs once every replica moved to its environment network. The
// engine refuses to remove a network a container is still attached to, so a
// race with a container being created on it fails safe.
func (r *Runtime) collectNetworks(ctx context.Context, specs []*wantSpec) {
	if r.opts.Namespace == "" {
		return
	}
	r.mu.Lock()
	due := time.Since(r.networksCheckedAt) >= networkGCInterval
	if due {
		r.networksCheckedAt = time.Now()
	}
	inUse := map[string]bool{SystemNetwork: true}
	projects := map[string]bool{}
	for _, s := range specs {
		inUse[s.Network] = true
		if s.ProjectID != nil {
			projects[*s.ProjectID] = true
		}
	}
	for _, inst := range r.instances {
		inUse[inst.meta.network] = true
		for name := range inst.ips {
			inUse[name] = true
		}
	}
	r.mu.Unlock()
	if !due {
		return
	}
	nets, err := r.d.ListNetworks(ctx, ManagedFilter)
	if err != nil {
		if ctx.Err() == nil {
			r.log.Debug("list networks", "err", err)
		}
		return
	}
	for _, n := range nets {
		ns, project := n.Labels[LabelNamespace], n.Labels[LabelProjectID]
		legacy := ns == "" && projects[project] && n.Name == protocol.ProjectNetworkName(project)
		if inUse[n.Name] || (ns != r.opts.Namespace && !legacy) {
			continue
		}
		if err := r.d.RemoveNetwork(ctx, n.Name); err != nil {
			r.log.Debug("keep network", "network", n.Name, "err", err)
			continue
		}
		r.mu.Lock()
		delete(r.networks, n.Name)
		r.mu.Unlock()
		r.log.Info("removed unused network", "network", n.Name)
	}
}
