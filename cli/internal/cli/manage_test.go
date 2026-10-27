package cli

import (
	"bytes"
	"encoding/json"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
	"github.com/BankkRoll/Roundhouse/cli/internal/ui"
)

func TestProjects(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "projects", "list", "--json")
	h.golden("projects.json", r.stdout)
	r = h.ok("", "projects", "list")
	contains(t, r.stdout, "*   Shop")
	h.expect(exitcode.NotFound, "", "projects", "list", "--workspace", "nope")

	r = h.ok("", "projects", "create", "Internal Tools", "--slug", "tools", "--json")
	h.golden("projects-create.json", r.stdout)
	r = h.ok("", "projects", "create", "Again", "--slug", "tools")
	contains(t, r.stdout, "Created project Again (slug tools-2, ")

	r = h.expect(exitcode.InputRequired, "", "projects", "delete", "tools")
	contains(t, r.stderr, "pass --confirm tools")
	r = h.expect(exitcode.Usage, "", "projects", "delete", "tools", "--confirm", "shop")
	contains(t, r.stderr, `--confirm "shop" does not match "tools"`)
	if r := h.interactive("wrong\n", "projects", "delete", "tools"); r.code != exitcode.Error {
		t.Errorf("mistyped confirmation: exit %d", r.code)
	}
	if r := h.interactive("tools\n", "projects", "delete", "tools"); r.code != 0 || !strings.Contains(r.stderr, "Type tools to confirm") {
		t.Fatalf("typed confirmation: exit %d\n%s", r.code, r.stderr)
	}
	h.expect(exitcode.NotFound, "", "projects", "delete", "tools", "--confirm", "tools")
	r = h.ok("", "projects", "delete", "prj_shop", "--confirm", "shop", "--json")
	contains(t, r.stdout, `"deleted": "prj_shop"`)
}

func TestServices(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "services", "list", "--json")
	h.golden("services.json", r.stdout)
	r = h.ok("", "services", "list")
	contains(t, r.stdout, "*   API")

	r = h.ok("", "services", "create", "Web", "--image", "nginx:1.27", "--port", "80", "--json")
	h.golden("services-create.json", r.stdout)
	var body map[string]any
	for _, req := range h.fake.Requests() {
		if req.Pattern == "POST /v1/projects/{projectId}/services" {
			_ = json.Unmarshal([]byte(req.Body), &body)
		}
	}
	if cfg, _ := body["config"].(map[string]any); cfg == nil || cfg["networking"].(map[string]any)["port"] != float64(80) {
		t.Errorf("create body = %v", body)
	}
	r = h.ok("", "services", "create", "worker", "--repo", "https://github.com/acme/worker", "--root-dir", "apps/worker")
	contains(t, r.stdout, "roundhouse deploy --service worker")
	// Taken and reserved slugs are suffixed by the API, not refused.
	r = h.ok("", "services", "create", "Shared", "--image", "redis:7")
	contains(t, r.stdout, "Created service Shared (shared-2) in Shop")
	contains(t, r.stdout, "roundhouse deploy --service shared-2")
	r = h.ok("", "services", "create", "API v2", "--slug", "api", "--image", "nginx:1.27", "--json")
	contains(t, r.stdout, `"slug": "api-2"`)
	h.expect(exitcode.Usage, "", "services", "create", "x")
	h.expect(exitcode.Usage, "", "services", "create", "x", "--image", "a", "--repo", "b")

	h.expect(exitcode.InputRequired, "", "services", "delete", "web")
	h.ok("", "services", "delete", "web", "--confirm", "web")
	r = h.ok("", "services", "delete", "api", "--confirm", "api")
	contains(t, r.stdout, "This directory was linked to it")
	h.expect(exitcode.NotFound, "", "services", "delete", "api", "--confirm", "api")
}

func TestServers(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.ok("", "servers", "list", "--json")
	h.golden("servers.json", r.stdout)
	r = h.ok("", "servers", "list")
	contains(t, r.stdout, "edge-1")
	contains(t, r.stdout, "203.0.113.10")
	contains(t, r.stdout, "manual")

	r = h.ok("", "servers", "add", "--json")
	h.golden("servers-add.json", r.stdout)
	r = h.ok("", "servers", "add")
	if strings.TrimSpace(r.stdout) != apitest.InstallScript {
		t.Errorf("stdout = %q, want only the install command", r.stdout)
	}
	contains(t, r.stderr, "expires in 1h0m0s")
	h.expect(exitcode.NotFound, "", "servers", "add", "--workspace", "nope")
}

func TestServersAddReauth(t *testing.T) {
	h := newHarness(t)
	h.login()
	h.fake.SetSessionStale(true)
	r := h.expect(exitcode.Forbidden, "", "servers", "add")
	contains(t, r.stderr, "error: Confirm your password to continue")
	contains(t, r.stderr, "hint: creating a join token needs a recent sign-in; run `roundhouse login` again, then retry")
	if r.stdout != "" {
		t.Errorf("stdout = %q, want nothing", r.stdout)
	}

	h.fake.SetSessionStale(false)
	h.env[EnvToken] = h.fake.AddToken("ci", "workspace:read", "nodes:manage")
	r = h.expect(exitcode.Forbidden, "", "servers", "add")
	contains(t, r.stderr, "hint: API tokens never count as a recent sign-in, and creating a join token needs one; unset ROUNDHOUSE_TOKEN")
}

func TestVersion(t *testing.T) {
	h := newHarness(t)
	r := h.ok("", "version", "--json")
	var v versionResult
	if err := json.Unmarshal([]byte(r.stdout), &v); err != nil {
		t.Fatal(err)
	}
	if v.Version != "1.2.3" || v.Commit != "abc1234" || v.OS != runtime.GOOS || v.Arch != runtime.GOARCH || !strings.HasPrefix(v.Go, "go") {
		t.Errorf("version = %+v", v)
	}
	r = h.ok("", "--version")
	if r.stdout != "roundhouse 1.2.3 (abc1234)\n" {
		t.Errorf("--version = %q", r.stdout)
	}
}

func TestStubsAreUnavailable(t *testing.T) {
	h := newHarness(t)
	for _, args := range [][]string{{"up"}, {"db", "connect"}, {"db", "connect", "postgres"}} {
		r := h.expect(exitcode.Unavailable, "", args...)
		contains(t, r.stderr, "not available on this control plane yet")
	}
}

func TestCompletion(t *testing.T) {
	h := newHarness(t)
	for _, shell := range []string{"bash", "zsh", "fish", "powershell"} {
		r := h.ok("", "completion", shell)
		contains(t, r.stdout, "roundhouse")
	}
}

func TestUsageErrors(t *testing.T) {
	h := newHarness(t)
	h.expect(exitcode.Usage, "", "nope")
	h.expect(exitcode.Usage, "", "status", "--nope")
	h.expect(exitcode.Usage, "", "status", "extra")
	h.expect(exitcode.Usage, "", "logs", "-n", "-1")
}

// TestEveryCommandHasExamples keeps --help useful as commands are added.
func TestEveryCommandHasExamples(t *testing.T) {
	a := &App{Env: Env{IO: ui.Test("", &bytes.Buffer{}, &bytes.Buffer{})}}
	var walk func(*cobra.Command)
	walk = func(c *cobra.Command) {
		if c.Hidden || c.Name() == "help" || c.Name() == "completion" || c.HasParent() && c.Parent().Name() == "completion" {
			return
		}
		if c.Example == "" {
			t.Errorf("%q has no examples", c.CommandPath())
		}
		if c.Short == "" {
			t.Errorf("%q has no short description", c.CommandPath())
		}
		for _, sub := range c.Commands() {
			walk(sub)
		}
	}
	root := a.rootCommand()
	root.InitDefaultHelpCmd()
	root.InitDefaultCompletionCmd()
	for _, c := range root.Commands() {
		walk(c)
	}
}

func TestNonTTYOutputIsPlain(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.OnGetDeployment = progress("active")
	for _, args := range [][]string{{"status"}, {"deploy", "--wait"}, {"logs", "-n", "5"}, {"vars"}, {"servers", "list"}} {
		r := h.ok("", args...)
		if strings.Contains(r.stdout+r.stderr, "\x1b[") {
			t.Errorf("%v wrote escape codes without a TTY:\n%q", args, r.stdout+r.stderr)
		}
	}
}

// provisionSteps advances every provisioning run one step per poll and ends
// it in final.
func provisionSteps(final string) func(*api.NodeProvision) {
	steps := []struct{ status, step string }{
		{api.ProvisionCreating, "create_server"}, {api.ProvisionBooting, "wait_until_running"}, {final, ""},
	}
	n := 0
	return func(p *api.NodeProvision) {
		if n >= len(steps) {
			return
		}
		s := steps[n]
		n++
		p.Status, p.Step, p.UpdatedAt = s.status, nil, apitest.Now+int64(n)*1000
		if s.step != "" {
			p.Step = new(s.step)
		}
		p.ServerID, p.IPv4 = new("srv_42"), new("198.51.100.7")
		switch final {
		case api.ProvisionJoined:
			if n == len(steps) {
				p.NodeID, p.FinishedAt = new("node_0002"), new(p.UpdatedAt)
			}
		default:
			if n == len(steps) {
				p.FailureReason, p.FailureMessage, p.FinishedAt = new("join_timeout"), new("The agent did not join within 10 minutes"), new(p.UpdatedAt)
			}
		}
	}
}

func provisionBody(t *testing.T, h *harness) (api.ProvisionNodeInput, int) {
	t.Helper()
	var in api.ProvisionNodeInput
	n := 0
	for _, req := range h.fake.Requests() {
		if req.Pattern == "POST /v1/workspaces/{workspaceId}/nodes/provision" {
			n++
			if err := json.Unmarshal([]byte(req.Body), &in); err != nil {
				t.Fatal(err)
			}
		}
	}
	return in, n
}

func requested(h *harness, route api.Route) bool {
	for _, req := range h.fake.Requests() {
		if req.Pattern == route.Method+" "+route.Path {
			return true
		}
	}
	return false
}

func TestServersAddProvisionRecommended(t *testing.T) {
	h := newHarness(t)
	h.login()
	h.fake.OnGetNodeProvision = provisionSteps(api.ProvisionJoined)
	r := h.ok("", "servers", "add", "--provider", "hetzner", "--name", "web-1", "--json")
	h.golden("servers-provision.json", r.stdout)
	contains(t, r.stderr, "Using cx23 in nbg1 (Nuremberg): 2 vCPU, 4 GiB RAM, 40 GB disk, amd64, 4.49 EUR/month — Cheapest node plan")
	contains(t, r.stderr, "Provisioning web-1 (cx23 in nbg1) on Hetzner Cloud")
	for _, want := range []string{"queued", "creating (create_server)", "booting (wait_until_running)", "joined"} {
		contains(t, r.stderr, "  "+want+"\n")
	}
	in, _ := provisionBody(t, h)
	if in != (api.ProvisionNodeInput{Provider: "hetzner", Plan: "cx23", Region: "nbg1", Name: "web-1"}) {
		t.Errorf("provision body = %+v", in)
	}

	h.fake.OnGetNodeProvision = provisionSteps(api.ProvisionJoined)
	r = h.ok("", "servers", "add", "--provider", "hetzner")
	if !regexp.MustCompile(`^✓ server-[a-z0-9]{4} joined as node_0002 \(198\.51\.100\.7\)\n$`).MatchString(r.stdout) {
		t.Errorf("stdout = %q", r.stdout)
	}
}

func TestServersAddProvisionPicks(t *testing.T) {
	h := newHarness(t)
	h.login()

	r := h.ok("", "servers", "add", "--provider", "hetzner", "--region", "fsn1", "--name", "a", "--no-wait")
	contains(t, r.stderr, "Using cx23 in fsn1 (Falkenstein)")
	contains(t, r.stdout, "Started prv_")
	if in, _ := provisionBody(t, h); in.Plan != "cx23" || in.Region != "fsn1" {
		t.Errorf("--region fsn1 picked %s in %s", in.Plan, in.Region)
	}

	r = h.ok("", "servers", "add", "--provider", "hetzner", "--builder", "--name", "b", "--no-wait")
	contains(t, r.stderr, "Using cpx31 in fsn1")
	if in, _ := provisionBody(t, h); in.Plan != "cpx31" || !in.Builder {
		t.Errorf("--builder body = %+v", in)
	}

	r = h.ok("", "servers", "add", "--provider", "hetzner", "--plan", "cx23", "--name", "c", "--no-wait")
	contains(t, r.stderr, "Using cx23 in nbg1")

	r = h.expect(exitcode.NotFound, "", "servers", "add", "--provider", "hetzner", "--plan", "cx99", "--name", "d")
	contains(t, r.stderr, "Hetzner Cloud has no node offer for plan cx99")
}

func TestServersAddProvisionExplicit(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.ok("", "servers", "add", "--provider", "hetzner", "--plan", "cpx31", "--region", "nbg1", "--name", "web-2", "--no-wait", "--json")
	var p api.NodeProvision
	if err := json.Unmarshal([]byte(r.stdout), &p); err != nil {
		t.Fatal(err)
	}
	if p.Status != api.ProvisionQueued || p.Plan != "cpx31" || p.Region != "nbg1" || p.Name != "web-2" {
		t.Errorf("provision = %+v", p)
	}
	if requested(h, api.RouteProviderOffers) {
		t.Error("fetched offers although --plan and --region were given")
	}
	if requested(h, api.RouteNodeProvision) {
		t.Error("polled the run with --no-wait")
	}
	r = h.expect(exitcode.Conflict, "", "servers", "add", "--provider", "hetzner", "--plan", "cpx31", "--region", "nbg1", "--name", "web-2")
	contains(t, r.stderr, "already exists")
}

func TestServersAddProvisionFailure(t *testing.T) {
	h := newHarness(t)
	h.login()
	h.fake.OnGetNodeProvision = provisionSteps(api.ProvisionFailed)
	r := h.expect(exitcode.ProvisionFailed, "", "servers", "add", "--provider", "hetzner", "--name", "web-1")
	contains(t, r.stderr, "error: provisioning web-1 failed: join_timeout: The agent did not join within 10 minutes")
	if strings.Contains(r.stderr, "may still exist") {
		t.Errorf("failed run warned about a leftover server:\n%s", r.stderr)
	}

	h.fake.OnGetNodeProvision = provisionSteps(api.ProvisionCleanupFailed)
	r = h.expect(exitcode.ProvisionFailed, "", "servers", "add", "--provider", "hetzner", "--name", "web-2", "--json")
	contains(t, r.stderr, "warning: server srv_42 could not be deleted and may still exist and bill")
	var p api.NodeProvision
	if err := json.Unmarshal([]byte(r.stdout), &p); err != nil || p.Status != api.ProvisionCleanupFailed {
		t.Errorf("--json stdout = %q (%v)", r.stdout, err)
	}
}

func TestServersAddProvisionErrors(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.expect(exitcode.Conflict, "", "servers", "add", "--provider", "vultr")
	contains(t, r.stderr, "error: Vultr is not connected to workspace")
	contains(t, r.stderr, "hint: provider tokens are accepted only in the dashboard: Servers → Add server → Cloud provider")
	if _, n := provisionBody(t, h); n != 0 {
		t.Error("provisioned on a provider that is not connected")
	}

	h.expect(exitcode.Usage, "", "servers", "add", "--provider", "aws")
	h.expect(exitcode.Usage, "", "servers", "add", "--plan", "cx23")
	h.expect(exitcode.Usage, "", "servers", "add", "--no-wait")
	h.expect(exitcode.Usage, "", "servers", "add", "--provider", "hetzner", "--name", "Web_1")
	h.expect(exitcode.Usage, "", "servers", "add", "--provider", "hetzner", "--name", "-web")

	h.env[EnvURL] = h.fake.URL
	h.env[EnvToken] = h.fake.AddToken("ci", "nodes:read", "nodes:manage", "workspace:read")
	r = h.expect(exitcode.Forbidden, "", "servers", "add", "--provider", "hetzner", "--plan", "cx23", "--region", "fsn1", "--insecure")
	contains(t, r.stderr, "hint: API tokens cannot provision servers")
}

func TestServicesCreateCron(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "services", "create", "Nightly", "--kind", "cron", "--image", "ghcr.io/acme/report:1",
		"--schedule", "0 3 * * *", "--timezone", "Europe/Berlin")
	contains(t, r.stdout, "✓ Created service Nightly (nightly) in Shop")
	contains(t, r.stdout, "  Runs on 0 3 * * * (Europe/Berlin) once deployed; change it with `roundhouse cron set`\n")
	body := lastBody(t, h, api.RouteCreateService.String())
	cfg, _ := body["config"].(map[string]any)
	if body["kind"] != "cron" || len(cfg) != 1 {
		t.Fatalf("body = %v", body)
	}
	if cron, _ := cfg["cron"].(map[string]any); len(cron) != 2 || cron["schedule"] != "0 3 * * *" || cron["timezone"] != "Europe/Berlin" {
		t.Errorf("cron = %v", cfg["cron"])
	}
	r = h.ok("", "cron", "status", "--service", "nightly")
	contains(t, r.stdout, "not deployed")
	contains(t, r.stdout, "Schedule   0 3 * * * (Europe/Berlin)\n")

	r = h.ok("", "services", "create", "Hourly", "--kind", "cron", "--image", "busybox", "--schedule", "@hourly", "--json")
	h.golden("services-create-cron.json", r.stdout)

	r = h.expect(exitcode.Usage, "", "services", "create", "x", "--kind", "cron", "--image", "busybox")
	contains(t, r.stderr, "a cron service needs --schedule")
	r = h.expect(exitcode.Usage, "", "services", "create", "x", "--image", "busybox", "--timezone", "UTC")
	contains(t, r.stderr, "--schedule and --timezone are only for --kind cron")
	r = h.expect(exitcode.Invalid, "", "services", "create", "x", "--kind", "cron", "--image", "busybox", "--schedule", "61 * * * *")
	contains(t, r.stderr, "  61 * * * *\n  ^^\n")
}
