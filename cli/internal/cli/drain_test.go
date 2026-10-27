package cli

import (
	"encoding/json"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

func TestServersDrainAndResume(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.ok("", "servers", "drain", "edge-1", "--status")
	contains(t, r.stdout, "edge-1 has never been drained.")

	h.expect(exitcode.Usage, "", "servers", "drain", "edge-1")
	r = h.ok("", "servers", "drain", "edge-1", "--force", "--yes")
	contains(t, r.stdout, "Drain of edge-1: drained: in maintenance, safe to reboot")
	contains(t, r.stdout, "No replicas had to move.")

	r = h.ok("", "servers", "drain", "edge-1", "--status", "--json")
	var d api.NodeDrain
	if err := json.Unmarshal([]byte(r.stdout), &d); err != nil || !d.Force || d.Status != api.DrainCompleted {
		t.Errorf("--status --json = %+v (%v)", d, err)
	}

	r = h.ok("", "servers", "resume", "edge-1")
	contains(t, r.stdout, "edge-1 is back in service")
	r = h.expect(exitcode.Conflict, "", "servers", "resume", "edge-1")
	contains(t, r.stderr, "hint: edge-1 is in service; drain it first")
	h.expect(exitcode.NotFound, "", "servers", "drain", "nope", "-y")
}

func TestServersDrainBlocked(t *testing.T) {
	h := newHarness(t)
	h.login()
	to := apitest.NodeID
	msg := "no other server can take it"
	h.fake.SetDrain(api.NodeDrain{
		ID: "drn_1", NodeID: apitest.NodeID, Status: api.DrainBlocked,
		Moves: []api.DrainMove{
			{WorkloadID: "wl_1", ServiceID: "svc_api", Replica: 0, State: "done", ToNodeID: &to},
			{WorkloadID: "wl_2", ServiceID: "svc_api", Replica: 1, State: "failed", Error: &msg},
		},
		Blocked: []api.DrainBlocker{{ServiceID: "svc_db", ServiceName: "Postgres"}},
	})
	r := h.ok("", "servers", "drain", "edge-1", "--status")
	contains(t, r.stdout, "Blocked by services with volumes: Postgres")
	contains(t, r.stdout, "--force")
	contains(t, r.stdout, "no other server can take it")
}
