package cli

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// addManagedNode adds a server Roundhouse provisioned on Hetzner.
func addManagedNode(h *harness, name string, cost *api.CostEstimate) {
	h.fake.AddNode(api.Node{ID: "node_" + name, Name: name, Status: "online", Provider: "hetzner",
		Region: new("fsn1"), ProviderServerID: new("srv_" + name), EstimatedMonthlyCost: cost, CreatedAt: apitest.Now - 1000})
}

func nodeNames(h *harness) []string {
	var names []string
	for _, n := range h.fake.Nodes() {
		names = append(names, n.Name)
	}
	return names
}

func removeQueries(h *harness) []string {
	var out []string
	for _, req := range h.fake.Requests() {
		if req.Pattern == api.RouteRemoveNode.Method+" "+api.RouteRemoveNode.Path {
			out = append(out, req.Path+"?"+req.Query)
		}
	}
	return out
}

func TestServersRemoveConfirms(t *testing.T) {
	h := newHarness(t)
	h.login()
	addManagedNode(h, "web-1", nil)

	r := h.expect(exitcode.Usage, "", "servers", "remove", "web-1")
	contains(t, r.stderr, "pass --yes")
	if len(removeQueries(h)) != 0 {
		t.Fatal("removed without confirmation")
	}

	r = h.interactive("n\n", "servers", "remove", "web-1")
	if r.code != exitcode.Error {
		t.Fatalf("declined: exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stderr, "removing it also deletes cloud server srv_web-1 and everything on it")
	contains(t, r.stderr, "--keep-server")
	if !slices.Contains(nodeNames(h), "web-1") {
		t.Fatal("declined remove removed the server")
	}

	r = h.interactive("y\n", "servers", "remove", "web-1")
	if r.code != 0 {
		t.Fatalf("exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stdout, "✓ Removed web-1 and deleted cloud server srv_web-1 on hetzner")
	if got := removeQueries(h); !slices.Equal(got, []string{"/v1/workspaces/" + apitest.WorkspaceID + "/nodes/node_web-1?"}) {
		t.Errorf("remove requests = %q", got)
	}
}

func TestServersRemoveKeepServer(t *testing.T) {
	h := newHarness(t)
	h.login()
	addManagedNode(h, "web-1", nil)
	r := h.interactive("y\n", "servers", "remove", "web-1", "--keep-server")
	if r.code != 0 {
		t.Fatalf("exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stderr, "Cloud server srv_web-1 on hetzner keeps running, and billing")
	contains(t, r.stdout, "cloud server srv_web-1 on hetzner is still running")
	if got := removeQueries(h); len(got) != 1 || got[0] != "/v1/workspaces/"+apitest.WorkspaceID+"/nodes/node_web-1?keep_server=true" {
		t.Errorf("remove requests = %q", got)
	}
}

func TestServersRemoveByIDAsJSON(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.ok("", "servers", "remove", apitest.NodeID, "--yes", "--json")
	h.golden("servers-remove.json", r.stdout)
	if len(h.fake.Nodes()) != 0 {
		t.Error("server still listed")
	}
	h.expect(exitcode.NotFound, "", "servers", "remove", "edge-1", "-y")
}

func TestServersRemoveHints(t *testing.T) {
	h := newHarness(t)
	h.login()
	addManagedNode(h, "web-1", nil)
	h.fake.SetProviderConnected("hetzner", false)
	r := h.expect(exitcode.Conflict, "", "servers", "remove", "web-1", "-y")
	contains(t, r.stderr, "error: Connect Hetzner Cloud to this workspace first")
	contains(t, r.stderr, "hint: the cloud server can only be deleted with the workspace's hetzner token")
	contains(t, r.stderr, "pass --keep-server to remove web-1")
	notContains(t, r.stderr, "provider tokens are accepted only in the dashboard")

	r = h.expect(exitcode.Conflict, "", "servers", "remove", "web-1", "-y", "--json")
	var out struct {
		Error struct {
			Code string `json:"code"`
			Hint string `json:"hint"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(r.stderr), &out); err != nil || out.Error.Code != "provider_not_connected" || out.Error.Hint == "" {
		t.Errorf("--json stderr = %q (%v)", r.stderr, err)
	}

	h.ok("", "servers", "remove", "web-1", "-y", "--keep-server")
}

func TestServersCancel(t *testing.T) {
	h := newHarness(t)
	h.login()
	h.fake.AddNodeProvision(api.NodeProvision{ID: "prov_1", Provider: "hetzner", Name: "web-1", Plan: "cx23", Region: "fsn1",
		Status: api.ProvisionBooting, ServerID: new("srv_42"), CreatedAt: apitest.Now, UpdatedAt: apitest.Now})
	r := h.ok("", "servers", "cancel", "prov_1", "--json")
	h.golden("servers-cancel.json", r.stdout)

	r = h.ok("", "servers", "cancel", "prov_1")
	contains(t, r.stdout, "✓ Cancelled web-1 (prov_1); deleted server srv_42")

	r = h.expect(exitcode.NotFound, "", "servers", "cancel", "prov_nope")
	h.fake.AddNodeProvision(api.NodeProvision{ID: "prov_2", Provider: "hetzner", Name: "web-2", Status: api.ProvisionJoined,
		NodeID: new("node_2"), CreatedAt: apitest.Now, UpdatedAt: apitest.Now})
	r = h.expect(exitcode.Conflict, "", "servers", "cancel", "prov_2")
	contains(t, r.stderr, "hint: a server that joined is removed with `roundhouse servers remove NAME`")
}

func TestServersCancelWhileCreating(t *testing.T) {
	h := newHarness(t)
	h.login()
	h.fake.AddNodeProvision(api.NodeProvision{ID: "prov_1", Provider: "hetzner", Name: "web-1", Plan: "cx23", Region: "fsn1",
		Status: api.ProvisionCreating, CreatedAt: apitest.Now, UpdatedAt: apitest.Now})
	r := h.ok("", "servers", "cancel", "prov_1", "--no-wait")
	contains(t, r.stdout, "Cancelling web-1 (prov_1): its server is deleted as soon as the provider has created it")

	h.fake.OnGetNodeProvision = func(p *api.NodeProvision) {
		p.Status, p.ServerID, p.UpdatedAt = api.ProvisionCancelled, new("srv_7"), apitest.Now+2000
	}
	r = h.ok("", "servers", "cancel", "prov_1")
	contains(t, r.stdout, "✓ Cancelled web-1 (prov_1); deleted server srv_7")
}

func TestServersCancelCleanupFailed(t *testing.T) {
	h := newHarness(t)
	h.login()
	h.fake.AddNodeProvision(api.NodeProvision{ID: "prov_1", Provider: "hetzner", Name: "web-1", Status: api.ProvisionCreating,
		CreatedAt: apitest.Now, UpdatedAt: apitest.Now})
	h.fake.OnGetNodeProvision = func(p *api.NodeProvision) {
		p.Status, p.ServerID, p.FailureMessage = api.ProvisionCleanupFailed, new("srv_7"), new("Deleting server srv_7 failed: upstream error")
	}
	r := h.expect(exitcode.ProvisionFailed, "", "servers", "cancel", "prov_1")
	contains(t, r.stderr, "warning: server srv_7 could not be deleted and may still exist and bill")
}

func TestServersAddInterruptedPrintsCancel(t *testing.T) {
	h := newHarness(t)
	h.login()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.fake.OnGetNodeProvision = func(*api.NodeProvision) { cancel() }
	r := h.exec(ctx, "", false, "servers", "add", "--provider", "hetzner", "--plan", "cx23", "--region", "fsn1", "--name", "web-1")
	if r.code != exitcode.Interrupted {
		t.Fatalf("exit %d\n%s", r.code, r.stderr)
	}
	runs := h.fake.NodeProvisions()
	if len(runs) != 1 {
		t.Fatalf("runs = %d", len(runs))
	}
	contains(t, r.stderr, "Provisioning continues in the background")
	contains(t, r.stderr, "roundhouse servers cancel "+runs[0].ID)

	r = h.ok("", "servers", "add", "--provider", "hetzner", "--plan", "cx23", "--region", "fsn1", "--name", "web-2", "--no-wait")
	contains(t, r.stderr, "Cancel it with: roundhouse servers cancel prv_")
}

func TestServersListCosts(t *testing.T) {
	h := newHarness(t)
	h.login()
	addManagedNode(h, "web-1", &api.CostEstimate{MonthlyCents: 449, Currency: "EUR"})
	addManagedNode(h, "web-2", &api.CostEstimate{MonthlyCents: 1490, Currency: "EUR"})
	addManagedNode(h, "do-1", &api.CostEstimate{MonthlyCents: 2400, Currency: "USD"})
	r := h.ok("", "servers", "list")
	contains(t, r.stdout, "EST. COST")
	contains(t, r.stdout, "≈ €4.49/mo")
	contains(t, r.stdout, "≈ $24.00/mo")
	contains(t, r.stdout, "Estimated total: ≈ €19.39/mo + ≈ $24.00/mo (provider catalogue prices; your bill may differ)")
}

func TestFormatMoney(t *testing.T) {
	for _, c := range []struct {
		cents    int
		currency string
		want     string
	}{
		{451, "EUR", "€4.51"},
		{5, "usd", "$0.05"},
		{100000, "GBP", "£1000.00"},
		{1234, "CHF", "12.34 CHF"},
	} {
		if got := formatMoney(c.cents, c.currency); got != c.want {
			t.Errorf("formatMoney(%d, %s) = %q, want %q", c.cents, c.currency, got, c.want)
		}
	}
	if estimateLabel(nil) != "-" {
		t.Error("nil estimate should render as -")
	}
}
