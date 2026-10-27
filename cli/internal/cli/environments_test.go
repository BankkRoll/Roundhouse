package cli

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

func TestEnvCreateCloneAndList(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "environments", "create", "QA", "--from", "production", "--variables", "non_secret")
	contains(t, r.stdout, "Created QA (qa)")
	var body api.CreateEnvironmentInput
	for _, req := range h.fake.Requests() {
		if req.Pattern == "POST /v1/projects/{projectId}/environments" {
			if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
				t.Fatal(err)
			}
		}
	}
	if body.Clone == nil || body.Clone.FromEnvironmentID != apitest.ProductionID || body.Clone.Variables != "non_secret" || body.Kind != "staging" {
		t.Fatalf("create body %+v", body)
	}
	r = h.ok("", "environments", "list")
	contains(t, r.stdout, "qa")
	contains(t, r.stdout, "production")

	h.expect(exitcode.Usage, "", "environments", "create", "X", "--variables", "all")
	h.expect(exitcode.Usage, "", "environments", "create", "X", "--from", "production", "--variables", "some")
	h.expect(exitcode.NotFound, "", "environments", "create", "X", "--from", "nope")
}

func TestEnvDiffNeverShowsValues(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.ok("", "environments", "create", "QA", "--from", "production")
	r := h.ok("", "environments", "diff", "production", "qa")
	contains(t, r.stdout, "SERVICE")
	notContains(t, r.stdout, apitest.SecretValue)
	r = h.ok("", "environments", "diff", "production", "qa", "--json")
	var diff api.EnvironmentDiff
	if err := json.Unmarshal([]byte(r.stdout), &diff); err != nil {
		t.Fatal(err)
	}
	if diff.BaseEnvironmentID != apitest.ProductionID || len(diff.Services) == 0 {
		t.Fatalf("diff %+v", diff)
	}
	notContains(t, r.stdout, apitest.SecretValue)
}

func TestEnvPromote(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.ok("", "environments", "create", "QA", "--from", "production", "--variables", "none")
	r := h.ok("", "environments", "promote", "--from", "production", "--into", "qa", "--variables", "all", "--no-image")
	contains(t, r.stdout, "Proposed")
	contains(t, r.stdout, "roundhouse changes")
	var body api.PromoteInput
	for _, req := range h.fake.Requests() {
		if strings.HasSuffix(req.Pattern, "/promote") {
			if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
				t.Fatal(err)
			}
		}
	}
	if body.FromEnvironmentID != apitest.ProductionID || body.Include.Variables != "all" || body.Include.Image || !body.Include.Config {
		t.Fatalf("promote body %+v", body)
	}
	h.expect(exitcode.Usage, "", "environments", "promote", "--from", "production")
	h.expect(exitcode.Usage, "", "environments", "promote", "--from", "production", "--into", "qa", "--variables", "secret")
}

func TestEnvDelete(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.ok("", "environments", "create", "QA")
	h.expect(exitcode.Usage, "", "environments", "delete", "qa")
	h.expect(exitcode.Conflict, "", "environments", "delete", "production", "--yes")
	r := h.ok("", "environments", "delete", "qa", "--yes")
	contains(t, r.stdout, "Deleted QA")
	for _, req := range h.fake.Requests() {
		if req.Pattern == "DELETE /v1/environments/{environmentId}" && req.Query != "confirm=qa" {
			t.Errorf("delete query %q", req.Query)
		}
	}
	h.expect(exitcode.NotFound, "", "environments", "delete", "qa", "--yes")
}

func TestEnvRBAC(t *testing.T) {
	h := newHarness(t)
	h.env[EnvURL] = h.fake.URL
	h.env[EnvToken] = h.fake.AddToken("ci", "projects:read")
	r := h.expect(exitcode.Forbidden, "", "environments", "create", "QA", "--project", "shop", "--insecure")
	contains(t, r.stderr, "environments:manage")
	h.ok("", "environments", "diff", "production", "staging", "--project", "shop", "--insecure")
}
