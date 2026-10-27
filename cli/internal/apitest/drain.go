package apitest

import (
	"net/http"
	"slices"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
)

func (f *Fake) drainRoutes(handlers map[api.Route]guarded) {
	handlers[api.RouteDrainNode] = guarded{"nodes:manage", f.drainNode}
	handlers[api.RouteGetNodeDrain] = guarded{"nodes:read", f.getNodeDrain}
	handlers[api.RouteResumeNode] = guarded{"nodes:manage", f.resumeNode}
}

// SetDrain stores a server's latest drain, for tests of a running or
// blocked one; drains the fake starts finish at once.
func (f *Fake) SetDrain(d api.NodeDrain) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.drains == nil {
		f.drains = map[string]api.NodeDrain{}
	}
	f.drains[d.NodeID] = d
}

// nodeIndex finds a node of the workspace; must hold f.mu.
func (f *Fake) nodeIndex(w http.ResponseWriter, r *http.Request) int {
	id := r.PathValue("nodeId")
	i := slices.IndexFunc(f.nodes, func(n api.Node) bool { return n.ID == id })
	if i < 0 {
		apiError(w, http.StatusNotFound, "not_found", "Server not found")
	}
	return i
}

func (f *Fake) getNodeDrain(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	i := f.nodeIndex(w, r)
	if i < 0 {
		return
	}
	out := struct {
		Drain *api.NodeDrain `json:"drain"`
	}{}
	if d, ok := f.drains[f.nodes[i].ID]; ok {
		out.Drain = &d
	}
	writeJSON(w, http.StatusOK, out)
}

func (f *Fake) drainNode(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	i := f.nodeIndex(w, r)
	if i < 0 {
		return
	}
	var body struct {
		Force bool `json:"force"`
	}
	_ = decode(r, &body)
	n := &f.nodes[i]
	if d, ok := f.drains[n.ID]; ok && d.Status == api.DrainRunning {
		apiError(w, http.StatusConflict, api.ErrDrainInProgress, "This server is already draining")
		return
	}
	if n.Status == "pending" {
		apiError(w, http.StatusConflict, api.ErrNodeNotDrainable, "This server hasn't connected yet")
		return
	}
	finished := Now
	d := api.NodeDrain{ID: f.nextID("drn"), NodeID: n.ID, Status: api.DrainCompleted, Force: body.Force,
		Moves: []api.DrainMove{}, Blocked: []api.DrainBlocker{}, StartedAt: Now, FinishedAt: &finished}
	if f.drains == nil {
		f.drains = map[string]api.NodeDrain{}
	}
	f.drains[n.ID] = d
	n.Status = "maintenance"
	writeJSON(w, http.StatusAccepted, d)
}

func (f *Fake) resumeNode(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	i := f.nodeIndex(w, r)
	if i < 0 {
		return
	}
	n := &f.nodes[i]
	if n.Status != "draining" && n.Status != "maintenance" {
		apiError(w, http.StatusConflict, api.ErrNodeNotDraining, "This server isn't draining or in maintenance")
		return
	}
	if d, ok := f.drains[n.ID]; ok && d.Status == api.DrainRunning {
		d.Status = api.DrainCancelled
		f.drains[n.ID] = d
	}
	n.Status = "online"
	writeJSON(w, http.StatusOK, *n)
}
