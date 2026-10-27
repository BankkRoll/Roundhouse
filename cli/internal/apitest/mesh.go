package apitest

import (
	"net/http"
	"slices"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
)

// DefaultSupernet is the mesh supernet a fresh install reports, as the
// instance setting's default.
const DefaultSupernet = "10.200.0.0/16"

func (f *Fake) meshRoutes(handlers map[api.Route]guarded) {
	handlers[api.RouteGetMesh] = guarded{"nodes:read", f.getMesh}
	handlers[api.RouteRotateMeshKey] = guarded{"nodes:manage", f.rotateMeshKey}
}

// SetMesh replaces the workspace's mesh. Until it is called the mesh is off
// and lists every server as supported but not joined.
func (f *Fake) SetMesh(m api.Mesh) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mesh = cloneMesh(&m)
}

// Mesh returns a copy of the workspace's mesh as GET would return it.
func (f *Fake) Mesh() api.Mesh {
	f.mu.Lock()
	defer f.mu.Unlock()
	return *f.meshState()
}

// cloneMesh copies the slices a test or handler may change.
func cloneMesh(m *api.Mesh) *api.Mesh {
	out := *m
	out.Nodes = slices.Clone(m.Nodes)
	out.Pairs = slices.Clone(m.Pairs)
	if out.Nodes == nil {
		out.Nodes = []api.MeshNode{}
	}
	if out.Pairs == nil {
		out.Pairs = []api.MeshPair{}
	}
	return &out
}

// meshState returns the stored mesh, or the default one for an install that
// never turned it on. Must hold f.mu.
func (f *Fake) meshState() *api.Mesh {
	if f.mesh == nil {
		f.mesh = &api.Mesh{Supernet: DefaultSupernet, Nodes: []api.MeshNode{}, Pairs: []api.MeshPair{}}
		for _, n := range f.nodes {
			f.mesh.Nodes = append(f.mesh.Nodes, api.MeshNode{ID: n.ID, Name: n.Name, Status: n.Status, Supported: true})
		}
	}
	return cloneMesh(f.mesh)
}

func (f *Fake) getMesh(w http.ResponseWriter, r *http.Request) {
	if f.workspace(w, r) {
		writeJSON(w, http.StatusOK, f.meshState())
	}
}

// rotateMeshKey mirrors the API: one server rotates at a time, and only a
// server that joined the mesh has a key to rotate.
func (f *Fake) rotateMeshKey(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	id := r.PathValue("nodeId")
	if !slices.ContainsFunc(f.nodes, func(n api.Node) bool { return n.ID == id }) {
		apiError(w, http.StatusNotFound, "not_found", "Server not found")
		return
	}
	m := f.meshState()
	i := slices.IndexFunc(m.Nodes, func(n api.MeshNode) bool { return n.ID == id })
	if !m.Enabled || i < 0 || m.Nodes[i].MeshIndex == nil {
		apiError(w, http.StatusConflict, api.ErrMeshNotJoined, "This server has not joined the private network")
		return
	}
	if j := slices.IndexFunc(m.Nodes, func(n api.MeshNode) bool { return n.Rotating }); j >= 0 {
		apiError(w, http.StatusConflict, api.ErrMeshRotationInProgress, m.Nodes[j].Name+" is rotating its key; try again when it finishes")
		return
	}
	m.Nodes[i].Rotating = true
	f.mesh = m
	writeJSON(w, http.StatusAccepted, m.Nodes[i])
}
