package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

const (
	fromTemplatePattern   = "POST /v1/workspaces/{workspaceId}/projects/from-template"
	deployTemplatePattern = "POST /v1/projects/{projectId}/templates/deploy"
)

// templateBodies decodes every request body sent to a template deploy route.
func templateBodies(t *testing.T, h *harness, pattern string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, r := range h.fake.Requests() {
		if r.Pattern == pattern {
			var body map[string]any
			if err := json.Unmarshal([]byte(r.Body), &body); err != nil {
				t.Fatal(err)
			}
			out = append(out, body)
		}
	}
	return out
}

func decodeDeployment(t *testing.T, stdout string) api.TemplateDeployment {
	t.Helper()
	var res api.TemplateDeployment
	if err := json.Unmarshal([]byte(stdout), &res); err != nil {
		t.Fatalf("%v\n%s", err, stdout)
	}
	return res
}

func TestTemplatesList(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.ok("", "templates", "list", "--json")
	var list []api.TemplateSummary
	if err := json.Unmarshal([]byte(r.stdout), &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 || list[0].ID != apitest.TemplateWhoami || list[2].Supported {
		t.Errorf("list = %+v", list)
	}
	r = h.ok("", "templates", "list")
	contains(t, r.stdout, "ID       NAME     CATEGORY     SERVICES   NOTES")
	contains(t, r.stdout, "whoami   whoami   tool         1          -")
	contains(t, r.stdout, "umami    Umami    monitoring   2          not supported here: needs databases")
	h.expect(exitcode.NotFound, "", "templates", "list", "--workspace", "nope")
}

func TestTemplatesShow(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.ok("", "templates", "show", apitest.TemplateN8N)
	contains(t, r.stdout, "n8n (n8n, version 2, automation)")
	contains(t, r.stdout, "WEBHOOK_URL      string                       required   -             Webhook URL")
	contains(t, r.stdout, "ADMIN_PASSWORD   secret                       required")
	contains(t, r.stdout, "TIMEZONE         select (UTC|Europe/Berlin)")
	contains(t, r.stdout, "default UTC")
	contains(t, r.stdout, "n8n (n8n): app, image n8nio/n8n:1, port 5678, public")
	contains(t, r.stdout, "N8N_ENCRYPTION_KEY   (generated)")
	contains(t, r.stdout, "N8N_ADMIN_PASSWORD   (secret)")
	contains(t, r.stdout, "WEBHOOK_URL          ${{input.WEBHOOK_URL}}")

	r = h.ok("", "templates", "show", apitest.TemplateN8N, "--json")
	var d api.TemplateDetail
	if err := json.Unmarshal([]byte(r.stdout), &d); err != nil {
		t.Fatal(err)
	}
	if len(d.Inputs) != 3 || len(d.Services) != 1 || d.Services[0].Variables[0].Value != nil {
		t.Errorf("show --json = %+v", d)
	}
	contains(t, r.stdout, `"source": {`+"\n"+`        "image": "n8nio/n8n:1",`+"\n"+`        "type": "image"`)

	r = h.ok("", "templates", "show", apitest.TemplateUmami)
	contains(t, r.stdout, "Not deployable here: needs databases, which this control plane doesn't support yet")
	contains(t, r.stdout, "Postgres (db): database, database postgres, port 5432")
	r = h.ok("", "templates", "show", apitest.TemplateUmami, "--json")
	contains(t, r.stdout, `"version": null`)

	r = h.expect(exitcode.NotFound, "", "templates", "show", "nope")
	contains(t, r.stderr, "Template not found")
}

func TestTemplatesDeployNewProject(t *testing.T) {
	h := newHarness(t)
	h.login()
	const password = "hunter2-admin-password"
	r := h.ok(password+"\n", "templates", "deploy", apitest.TemplateN8N, "--name", "Automations",
		"--input", "WEBHOOK_URL=https://n8n.example.com", "--input", "ADMIN_PASSWORD=-", "--yes")
	contains(t, r.stdout, "✓ Created project Automations (slug automations) from template n8n in workspace Acme")
	contains(t, r.stdout, "+ n8n   n8n   svc_")
	contains(t, r.stdout, "deployment dep_")
	contains(t, r.stderr, "Write-only, never shown again: N8N_ENCRYPTION_KEY, N8N_ADMIN_PASSWORD.")
	notContains(t, r.stdout+r.stderr, password)

	bodies := templateBodies(t, h, fromTemplatePattern)
	if len(bodies) != 1 {
		t.Fatalf("%d create requests", len(bodies))
	}
	b := bodies[0]
	inputs, _ := b["inputs"].(map[string]any)
	if b["template_id"] != "n8n" || b["name"] != "Automations" || b["deploy"] != true || b["confirm_write_only"] != true ||
		inputs["ADMIN_PASSWORD"] != password || inputs["WEBHOOK_URL"] != "https://n8n.example.com" {
		t.Errorf("body = %v", b)
	}
	if _, err := os.Stat(filepath.Join(h.dir, ".roundhouse")); !os.IsNotExist(err) {
		t.Errorf("templates deploy linked the directory: %v", err)
	}

	r = h.ok("", "templates", "deploy", apitest.TemplateWhoami, "--slug", "automations", "--json")
	res := decodeDeployment(t, r.stdout)
	if res.Project.Slug != "automations-2" || res.Template.ID != "whoami" || len(res.Services) != 1 || len(res.Deployments) != 1 ||
		res.Deployments[0].ServiceID != res.Services[0].ID || res.Environment.Kind != "production" {
		t.Errorf("deploy --json = %+v", res)
	}
	if v, secret, ok := h.fake.Variable(res.Services[0].ID, res.Environment.ID, "WHOAMI_PORT_NUMBER"); !ok || secret || v != "80" {
		t.Errorf("WHOAMI_PORT_NUMBER = %q, secret %v, stored %v", v, secret, ok)
	}
}

func TestTemplatesDeployStoresInputsAsSecrets(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.ok("", "templates", "deploy", apitest.TemplateN8N, "--input", "WEBHOOK_URL=https://n8n.example.com",
		"--input", "ADMIN_PASSWORD=pw-123456", "--yes", "--json")
	res := decodeDeployment(t, r.stdout)
	svc, env := res.Services[0].ID, res.Environment.ID
	if v, secret, _ := h.fake.Variable(svc, env, "N8N_ADMIN_PASSWORD"); v != "pw-123456" || !secret {
		t.Errorf("N8N_ADMIN_PASSWORD = %q, secret %v", v, secret)
	}
	if v, _, _ := h.fake.Variable(svc, env, "GENERIC_TIMEZONE"); v != "UTC" {
		t.Errorf("GENERIC_TIMEZONE = %q, want the input's default", v)
	}
	if _, secret, ok := h.fake.Variable(svc, env, "N8N_ENCRYPTION_KEY"); !ok || !secret {
		t.Error("N8N_ENCRYPTION_KEY was not generated as a secret")
	}
}

func TestTemplatesDeployIntoLinkedProject(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "templates", "deploy", apitest.TemplateWhoami, "--linked", "--environment", "staging")
	contains(t, r.stdout, "✓ Deployed template whoami into Shop / staging")
	contains(t, r.stdout, "+ whoami   whoami   svc_")
	bodies := templateBodies(t, h, deployTemplatePattern)
	if len(bodies) != 1 || bodies[0]["environment_id"] != apitest.StagingID || bodies[0]["template_id"] != "whoami" {
		t.Errorf("bodies = %v", bodies)
	}
	if len(templateBodies(t, h, fromTemplatePattern)) != 0 {
		t.Error("--linked created a project")
	}

	// The linked environment is used when none is named; a second copy gets a suffixed slug.
	r = h.ok("", "templates", "deploy", apitest.TemplateWhoami, "--linked", "--json")
	res := decodeDeployment(t, r.stdout)
	if res.Project.ID != apitest.ProjectID || res.Environment.ID != apitest.ProductionID || res.Services[0].Slug != "whoami-2" {
		t.Errorf("deploy --linked --json = %+v", res)
	}
	r = h.ok("", "templates", "deploy", apitest.TemplateWhoami, "--project", "shop", "-e", "production", "--json")
	if res := decodeDeployment(t, r.stdout); res.Services[0].Slug != "whoami-3" {
		t.Errorf("slug = %s", res.Services[0].Slug)
	}

	r = h.expect(exitcode.Usage, "", "templates", "deploy", apitest.TemplateWhoami, "--linked", "--name", "x")
	contains(t, r.stderr, "--name names a new project; it can't be combined with --linked")
	h.expect(exitcode.NotFound, "", "templates", "deploy", apitest.TemplateWhoami, "--linked", "--environment", "nope")
}

func TestTemplatesDeployLinkedNeedsLink(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.expect(exitcode.NotLinked, "", "templates", "deploy", apitest.TemplateWhoami, "--linked")
	contains(t, r.stderr, "no project linked to this directory")
}

func TestTemplatesDeployMissingRequiredInputs(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.expect(exitcode.InputRequired, "", "templates", "deploy", apitest.TemplateN8N, "--yes")
	contains(t, r.stderr, "template n8n needs WEBHOOK_URL (Webhook URL), ADMIN_PASSWORD (Admin password), but input is not interactive")
	contains(t, r.stderr, "pass --input WEBHOOK_URL=… --input ADMIN_PASSWORD=…")
	r = h.expect(exitcode.InputRequired, "", "templates", "deploy", apitest.TemplateN8N, "--yes", "--input", "WEBHOOK_URL=https://x.example")
	contains(t, r.stderr, "template n8n needs ADMIN_PASSWORD (Admin password)")
	if n := len(templateBodies(t, h, fromTemplatePattern)); n != 0 {
		t.Errorf("%d deploy requests sent with inputs missing", n)
	}

	// The API's own checks still apply, e.g. to an input the template lacks.
	r = h.expect(exitcode.Invalid, "", "templates", "deploy", apitest.TemplateN8N, "--yes",
		"--input", "WEBHOOK_URL=https://x.example", "--input", "ADMIN_PASSWORD=pw-123456", "--input", "NOPE=1")
	contains(t, r.stderr, "inputs.NOPE: The template declares no such input")
	r = h.expect(exitcode.Invalid, "", "templates", "deploy", apitest.TemplateN8N, "--yes",
		"--input", "WEBHOOK_URL=https://x.example", "--input", "ADMIN_PASSWORD=pw-123456", "--input", "TIMEZONE=Mars")
	contains(t, r.stderr, "inputs.TIMEZONE: Expected one of UTC, Europe/Berlin")

	h.expect(exitcode.Usage, "", "templates", "deploy", apitest.TemplateN8N, "--input", "WEBHOOK_URL")
	h.expect(exitcode.Usage, "", "templates", "deploy", apitest.TemplateN8N, "--input", "A=1", "--input", "A=2")
}

func TestTemplatesDeployPromptsForInputs(t *testing.T) {
	h := newHarness(t)
	h.login()
	// Inputs, then the write-only confirmation the first request is refused for.
	r := h.interactive("https://n8n.example.com\n\nsecret-pw-1\ny\n", "templates", "deploy", apitest.TemplateN8N)
	if r.code != 0 {
		t.Fatalf("exit %d\n%s\n%s", r.code, r.stdout, r.stderr)
	}
	contains(t, r.stderr, "Public URL n8n is reached at")
	contains(t, r.stderr, "Webhook URL (WEBHOOK_URL):")
	contains(t, r.stderr, "Admin password (ADMIN_PASSWORD):")
	contains(t, r.stderr, "N8N_ENCRYPTION_KEY, N8N_ADMIN_PASSWORD look secret and will be write-only")
	notContains(t, r.stderr, "Timezone")
	bodies := templateBodies(t, h, fromTemplatePattern)
	if len(bodies) != 2 || bodies[0]["confirm_write_only"] != false || bodies[1]["confirm_write_only"] != true {
		t.Fatalf("bodies = %v", bodies)
	}
	inputs, _ := bodies[1]["inputs"].(map[string]any)
	if inputs["WEBHOOK_URL"] != "https://n8n.example.com" || inputs["ADMIN_PASSWORD"] != "secret-pw-1" {
		t.Errorf("inputs = %v", inputs)
	}
}

func TestTemplatesDeployWriteOnlyConfirmation(t *testing.T) {
	h := newHarness(t)
	h.login()
	args := []string{"templates", "deploy", apitest.TemplateN8N, "--input", "WEBHOOK_URL=https://x.example", "--input", "ADMIN_PASSWORD=pw-123456"}
	r := h.expect(exitcode.Invalid, "", args...)
	contains(t, r.stderr, "N8N_ENCRYPTION_KEY, N8N_ADMIN_PASSWORD will be write-only")
	contains(t, r.stderr, "hint: "+templateWriteOnlyHint)
	notContains(t, r.stderr, "--plain")

	r = h.expect(exitcode.Invalid, "", append(args, "--json")...)
	var out struct {
		Error struct {
			Code string `json:"code"`
			Hint string `json:"hint"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(r.stderr), &out); err != nil || out.Error.Code != "confirmation_required" || out.Error.Hint != templateWriteOnlyHint {
		t.Errorf("--json error = %+v (%v)", out, err)
	}

	r = h.interactive("n\n", args...)
	if r.code != exitcode.Error {
		t.Fatalf("declined: exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stderr, "nothing created; the template's secrets can only be stored write-only")

	r = h.ok("", "projects", "list", "--json")
	var projects []api.Project
	_ = json.Unmarshal([]byte(r.stdout), &projects)
	if len(projects) != 1 {
		t.Errorf("a refused deploy left %d projects", len(projects))
	}

	// Templates without secrets need no confirmation.
	h.ok("", "templates", "deploy", apitest.TemplateWhoami)
}

func TestTemplatesDeployNoDeploy(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.ok("", "templates", "deploy", apitest.TemplateWhoami, "--no-deploy")
	contains(t, r.stdout, "whoami   svc_")
	contains(t, r.stdout, "not deployed")
	contains(t, r.stdout, "Deploy with: roundhouse deploy --project whoami --service <slug>")
	if b := templateBodies(t, h, fromTemplatePattern); len(b) != 1 || b[0]["deploy"] != false {
		t.Errorf("bodies = %v", b)
	}
	r = h.ok("", "templates", "deploy", apitest.TemplateWhoami, "--no-deploy", "--json")
	if res := decodeDeployment(t, r.stdout); len(res.Deployments) != 0 || len(res.Services) != 1 {
		t.Errorf("--no-deploy --json = %+v", res)
	}
}

func TestTemplatesDeployErrors(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.expect(exitcode.NotFound, "", "templates", "deploy", "nope")
	contains(t, r.stderr, "Template not found")

	// An unsupported template is sent without prompting, so the API says why.
	r = h.interactive("", "templates", "deploy", apitest.TemplateUmami)
	if r.code != exitcode.Conflict {
		t.Fatalf("unsupported: exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stderr, "Umami needs databases, which this control plane doesn't support yet")

	h.fake.FailTemplateDeploy("whoami", "no server is online")
	r = h.expect(exitcode.Error, "", "templates", "deploy", apitest.TemplateWhoami)
	contains(t, r.stdout, "✓ Created project whoami")
	contains(t, r.stdout, "deployment did not start: no server is online")
	contains(t, r.stderr, "the first deployment of whoami did not start; the services were created")
	r = h.expect(exitcode.Error, "", "templates", "deploy", apitest.TemplateWhoami, "--json")
	if res := decodeDeployment(t, r.stdout); len(res.DeployErrors) != 1 || res.DeployErrors[0].Message != "no server is online" {
		t.Errorf("deploy_errors = %+v", res.DeployErrors)
	}
}

func TestTemplatesDeployWithToken(t *testing.T) {
	h := newHarness(t)
	h.env[EnvURL] = h.fake.URL
	h.env[EnvToken] = h.fake.AddToken("ci", "projects:read", "projects:create", "services:manage", "variables:manage")
	r := h.expect(exitcode.Forbidden, "", "templates", "deploy", apitest.TemplateWhoami, "--insecure")
	contains(t, r.stderr, "needs deployments:create")
	h.ok("", "templates", "deploy", apitest.TemplateWhoami, "--no-deploy", "--insecure")
}

func TestInitTemplate(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.ok("", "init", "--template", apitest.TemplateWhoami, "--name", "Echo", "--gitignore=false", "--json")
	var out struct {
		Path       string                 `json:"path"`
		Link       map[string]string      `json:"link"`
		Gitignore  string                 `json:"gitignore"`
		Deployment api.TemplateDeployment `json:"deployment"`
	}
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil {
		t.Fatalf("%v\n%s", err, r.stdout)
	}
	d := out.Deployment
	if out.Link["project_id"] != d.Project.ID || out.Link["service_id"] != d.Services[0].ID || out.Link["environment_id"] != d.Environment.ID ||
		d.Project.Name != "Echo" || out.Gitignore != "skipped" {
		t.Errorf("init --template --json = %+v", out)
	}
	r = h.ok("", "status")
	contains(t, r.stdout, "Echo")

	r = h.ok("", "init", "--template", apitest.TemplateWhoami, "--name", "Echo", "--gitignore=false", "--no-deploy")
	contains(t, r.stdout, "✓ Created project Echo (slug echo-2) from template whoami")
	contains(t, r.stdout, "not deployed")
	contains(t, r.stdout, "Linked "+h.dir+" to Echo / production / whoami")

	r = h.expect(exitcode.Usage, "", "init", "--input", "A=1")
	contains(t, r.stderr, "--input needs --template")
	h.expect(exitcode.InputRequired, "", "init", "--template", apitest.TemplateN8N, "--gitignore=false", "--yes")
}
