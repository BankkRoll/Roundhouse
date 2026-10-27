package cli

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// seedMesh turns the mesh on with four servers: edge-1 (public, the relay),
// web-1 (public), nat-1 (behind NAT, not ready) and old-1 (an agent without
// mesh support), with a direct, a relayed and a down pair.
func seedMesh(h *harness) {
	for _, name := range []string{"web-1", "nat-1", "old-1"} {
		h.fake.AddNode(api.Node{ID: "node_" + name, Name: name, Status: "online", Provider: "manual", CreatedAt: apitest.Now - 1000})
	}
	joined := func(id, name string, index int, nat string, endpoint *string) api.MeshNode {
		return api.MeshNode{ID: id, Name: name, Status: "online", Supported: true, MeshIndex: new(index),
			Address: new(fmt.Sprintf("10.200.%d.1", index)), PublicKey: new("pk" + name + "="), Mode: new(api.MeshModeKernel),
			NAT: new(nat), Endpoint: endpoint, ListenPort: new(51820), DockerFirewall: new("iptables"), AcceptFwmark: new(true),
			Ready: true, KeyEpoch: 1, StatusAt: new(apitest.Now - 5000)}
	}
	edge := joined(apitest.NodeID, "edge-1", 1, api.MeshNATPublic, new("203.0.113.10:51820"))
	edge.Relay = true
	web := joined("node_web-1", "web-1", 2, api.MeshNATPublic, new("203.0.113.11:51820"))
	nat := joined("node_nat-1", "nat-1", 3, api.MeshNATBehind, nil)
	nat.Mode, nat.Ready, nat.Error = new(api.MeshModeUserspace), false, new("wg0: firewall rules not applied")
	old := api.MeshNode{ID: "node_old-1", Name: "old-1", Status: "online"}
	h.fake.SetMesh(api.Mesh{
		Enabled: true, Supernet: apitest.DefaultSupernet,
		Nodes: []api.MeshNode{edge, web, nat, old},
		Pairs: []api.MeshPair{
			{Nodes: [2]string{apitest.NodeID, "node_web-1"}, Path: api.MeshPathDirect, LastHandshakeAt: new(apitest.Now - 90_000),
				Sides: []api.MeshPeerView{{NodeID: apitest.NodeID, Endpoint: new("203.0.113.11:51820"), LastHandshakeAt: new(apitest.Now - 90_000), RxBytes: 10, TxBytes: 20}}},
			{Nodes: [2]string{"node_nat-1", "node_web-1"}, Path: api.MeshPathRelayed, RelayNodeID: new(apitest.NodeID),
				LastHandshakeAt: new(apitest.Now - 30_000), Sides: []api.MeshPeerView{}},
			{Nodes: [2]string{apitest.NodeID, "node_nat-1"}, Path: api.MeshPathDown, Sides: []api.MeshPeerView{}},
		},
	})
}

func rotateRequests(h *harness) []string {
	var out []string
	for _, req := range h.fake.Requests() {
		if req.Pattern == api.RouteRotateMeshKey.Method+" "+api.RouteRotateMeshKey.Path {
			out = append(out, req.Path)
		}
	}
	return out
}

func TestServersMesh(t *testing.T) {
	h := newHarness(t)
	h.login()
	seedMesh(h)
	r := h.ok("", "servers", "mesh")
	h.golden("servers-mesh.txt", r.stdout)
	contains(t, r.stdout, "Private network: on, supernet 10.200.0.0/16")
	contains(t, r.stdout, "not ready: wg0: firewall rules not applied")
	contains(t, r.stdout, "unsupported agent")
	contains(t, r.stdout, "1 server runs an agent without mesh support")
	contains(t, r.stdout, "edge-1 <-> web-1   1m ago")
	contains(t, r.stdout, "relayed via edge-1")
	contains(t, r.stdout, "never")

	r = h.ok("", "servers", "mesh", "--json")
	h.golden("servers-mesh.json", r.stdout)
	var m api.Mesh
	if err := json.Unmarshal([]byte(r.stdout), &m); err != nil || !m.Enabled || len(m.Nodes) != 4 || len(m.Pairs) != 3 {
		t.Errorf("--json = %+v (%v)", m, err)
	}
}

func TestServersMeshColours(t *testing.T) {
	h := newHarness(t)
	h.tty, h.ttyColor = true, true
	h.login()
	seedMesh(h)
	r := h.ok("", "servers", "mesh")
	contains(t, r.stdout, "\x1b[32mdirect\x1b[0m")
	contains(t, r.stdout, "\x1b[33mrelayed via edge-1\x1b[0m")
	contains(t, r.stdout, "\x1b[31mdown\x1b[0m")
}

func TestServersMeshOff(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.ok("", "servers", "mesh")
	contains(t, r.stdout, "The private network between servers is off (supernet 10.200.0.0/16).")
	contains(t, r.stdout, "Settings → Platform → Network")
	contains(t, r.stdout, `PATCH /v1/instance/settings {"mesh_enabled": true}`)
	notContains(t, r.stdout, "NAME")

	r = h.expect(exitcode.Conflict, "", "servers", "mesh", "rotate-key", "edge-1", "-y")
	contains(t, r.stderr, "hint: the private network is off")
}

func TestServersMeshRotateKeyConfirms(t *testing.T) {
	h := newHarness(t)
	h.login()
	seedMesh(h)

	r := h.expect(exitcode.Usage, "", "servers", "mesh", "rotate-key", "web-1")
	contains(t, r.stderr, "pass --yes")

	r = h.interactive("n\n", "servers", "mesh", "rotate-key", "web-1")
	if r.code != exitcode.Error {
		t.Fatalf("declined: exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stderr, "tunnels to it pause for about two seconds")
	if len(rotateRequests(h)) != 0 {
		t.Fatal("rotated without confirmation")
	}

	r = h.interactive("y\n", "servers", "mesh", "rotate-key", "web-1")
	if r.code != 0 {
		t.Fatalf("exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stdout, "✓ Started rotating the WireGuard key of web-1; tunnels to it pause for about two seconds")
	if got := rotateRequests(h); len(got) != 1 || got[0] != "/v1/workspaces/"+apitest.WorkspaceID+"/nodes/node_web-1/mesh/rotate-key" {
		t.Errorf("rotate requests = %q", got)
	}
	r = h.ok("", "servers", "mesh")
	contains(t, r.stdout, "rotating key")

	h.expect(exitcode.NotFound, "", "servers", "mesh", "rotate-key", "nope-1", "-y")
}

func TestServersMeshRotateKeyByIDAsJSON(t *testing.T) {
	h := newHarness(t)
	h.login()
	seedMesh(h)
	r := h.ok("", "servers", "mesh", "rotate-key", apitest.NodeID, "--yes", "--json")
	var n api.MeshNode
	if err := json.Unmarshal([]byte(r.stdout), &n); err != nil || n.ID != apitest.NodeID || !n.Rotating {
		t.Errorf("--json = %q (%v)", r.stdout, err)
	}
}

func TestServersMeshRotateKeyHints(t *testing.T) {
	h := newHarness(t)
	h.login()
	seedMesh(h)
	h.ok("", "servers", "mesh", "rotate-key", "edge-1", "-y")

	r := h.expect(exitcode.Conflict, "", "servers", "mesh", "rotate-key", "web-1", "-y")
	contains(t, r.stderr, "error: edge-1 is rotating its key")
	contains(t, r.stderr, "hint: one server rotates at a time")

	r = h.expect(exitcode.Conflict, "", "servers", "mesh", "rotate-key", "old-1", "-y", "--json")
	var out struct {
		Error struct {
			Code string `json:"code"`
			Hint string `json:"hint"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(r.stderr), &out); err != nil || out.Error.Code != api.ErrMeshNotJoined {
		t.Fatalf("--json stderr = %q (%v)", r.stderr, err)
	}
	contains(t, out.Error.Hint, "the agent on old-1 predates the private network")

	m := h.fake.Mesh()
	m.Nodes[2].MeshIndex = nil
	m.Nodes[0].Rotating = false
	h.fake.SetMesh(m)
	r = h.expect(exitcode.Conflict, "", "servers", "mesh", "rotate-key", "nat-1", "-y")
	contains(t, r.stderr, "hint: nat-1 has not joined the private network yet")
}
