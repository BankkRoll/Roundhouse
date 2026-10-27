package cli

import (
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

func TestDBVolumeRecover(t *testing.T) {
	h := newHarness(t)
	h.link()
	_, _, manual := seedBackups(h)
	addServers(h)

	h.expect(exitcode.Usage, "", "db", "volume", "recover")
	r := h.expect(exitcode.Conflict, "", "db", "volume", "recover", "--to", "edge-2", "--yes")
	contains(t, r.stderr, "recovery is for a lost server")
	contains(t, r.stderr, "hint: the volume's server is reachable: `roundhouse db volume move --to edge-2`")

	h.fake.SetNodeStatus(apitest.NodeID, "offline")
	r = h.expect(exitcode.NotFound, "", "db", "volume", "recover", "--to", "edge-9")
	contains(t, r.stderr, `no server "edge-9"`)
	r = h.expect(exitcode.Invalid, "", "db", "volume", "recover", "--to", "edge-3")
	contains(t, r.stderr, "edge-3 cannot take the volume: the server is offline")
	r = h.expect(exitcode.InputRequired, "", "db", "volume", "recover", "--to", "edge-2")
	contains(t, r.stderr, "pass --confirm db")

	h.fake.SetSessionStale(true)
	r = h.expect(exitcode.Forbidden, "", "db", "volume", "recover", "--to", "edge-2", "--yes")
	contains(t, r.stderr, "hint: recovering a volume needs a recent sign-in")
	h.fake.SetSessionStale(false)

	r = h.interactive("db\n", "db", "volume", "recover", "--to", "EDGE-2")
	if r.code != 0 {
		t.Fatalf("recover: exit %d, %s", r.code, r.stderr)
	}
	contains(t, r.stderr, "This rebuilds the volume of Postgres in production on edge-2 from backup "+manual)
	contains(t, r.stderr, "everything written after the backup is lost")
	contains(t, r.stdout, "✓ Started recovering the volume of Postgres in production onto edge-2 (rst_")
	body := lastBody(t, h, api.RouteRestoreBackup.String())
	if body["mode"] != "in_place" || body["target_node_id"] != "node_0002" || body["confirm"] != "db" {
		t.Errorf("body = %v", body)
	}
	if _, ok := body["skip_safety_backup"]; ok {
		t.Errorf("body carries skip_safety_backup: %v", body)
	}

	r = h.ok("", "db", "volume", "--json")
	contains(t, r.stdout, `"node_id": "node_0002"`)
	contains(t, r.stdout, `"status": "pending"`)
}

func TestDBVolumeRecoverPicksBackup(t *testing.T) {
	h := newHarness(t)
	h.link()
	scheduled, failed, _ := seedBackups(h)
	addServers(h)
	h.fake.SetNodeStatus(apitest.NodeID, "offline")

	r := h.expect(exitcode.Conflict, "", "db", "volume", "recover", "--to", "edge-2", "--backup", failed, "--yes")
	contains(t, r.stderr, "only a succeeded backup can be restored")
	r = h.ok("", "db", "volume", "recover", "--to", "node_0002", "--backup", scheduled, "--yes", "--json")
	contains(t, r.stdout, `"target_node_id": "node_0002"`)
	contains(t, r.stdout, `"backup_id": "`+scheduled+`"`)
}
