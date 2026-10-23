package cli

import (
	"bytes"
	"encoding/json"
	"runtime"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Open-Rail/cli/internal/apitest"
	"github.com/BankkRoll/Open-Rail/cli/internal/exitcode"
	"github.com/BankkRoll/Open-Rail/cli/internal/ui"
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

	r = h.ok("", "servers", "add", "--json")
	h.golden("servers-add.json", r.stdout)
	r = h.ok("", "servers", "add")
	if strings.TrimSpace(r.stdout) != apitest.InstallScript {
		t.Errorf("stdout = %q, want only the install command", r.stdout)
	}
	contains(t, r.stderr, "expires in 1h0m0s")
	h.expect(exitcode.NotFound, "", "servers", "add", "--workspace", "nope")
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
	for _, args := range [][]string{{"up"}, {"shell"}, {"db", "connect"}, {"db", "connect", "postgres"}} {
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
