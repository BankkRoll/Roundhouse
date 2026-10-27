package conn

import (
	"testing"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// A desired state using any mesh feature proves the control plane speaks
// the mesh version, which gates mesh_status and mesh_key.
func TestDesiredStateMeshVersion(t *testing.T) {
	yes := true
	cases := map[string]*protocol.DesiredState{
		"mesh":        {Mesh: &protocol.MeshConfig{}},
		"mesh ip":     {Workloads: []protocol.WorkloadSpec{{MeshIP: "10.200.1.10"}}},
		"private dns": {Workloads: []protocol.WorkloadSpec{{PrivateDNS: &yes}}},
		"route":       {Workloads: []protocol.WorkloadSpec{{Kind: protocol.WorkloadRouteOnly}}},
	}
	for name, ds := range cases {
		if v := desiredStateVersion(ds); v < protocol.MeshProtocolVersion {
			t.Errorf("%s: version %d, want at least %d", name, v, protocol.MeshProtocolVersion)
		}
	}
	if v := desiredStateVersion(&protocol.DesiredState{Workloads: []protocol.WorkloadSpec{{Kind: protocol.WorkloadService}}}); v != protocol.MinProtocolVersion {
		t.Errorf("plain state: version %d", v)
	}
}
