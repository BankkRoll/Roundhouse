package cli

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// stageDraft stages a production draft that sets a secret and scales the
// API, and returns its ID.
func stageDraft(h *harness) string {
	h.t.Helper()
	return h.fake.StageChangeSet(apitest.ChangeSetSpec{
		EnvironmentID: apitest.ProductionID,
		Draft:         true,
		Changes: []api.StagedChange{
			{
				Summary: "set api.STRIPE_KEY", TargetKey: "var:svc_api:STRIPE_KEY",
				Op:   json.RawMessage(`{"type":"variable.set","scope":"service","service":"svc_api","key":"STRIPE_KEY","confirm_write_only":true,"acknowledge_public":false,"fingerprint":"9f8e7d6c","staged_tier":"secret"}`),
				Diff: []api.DiffEntry{{Path: "/variables/STRIPE_KEY", Before: json.RawMessage(`{"tier":"plain","fingerprint":"1a2b3c4d"}`), After: json.RawMessage(`{"tier":"secret","fingerprint":"9f8e7d6c"}`)}},
			},
			{
				Summary: "update API config", TargetKey: "config:svc_api",
				Diff: []api.DiffEntry{{Path: "/deploy/replicas", Before: json.RawMessage(`1`), After: json.RawMessage(`2`)}},
			},
		},
		Deploys: []api.PlannedDeploy{{Service: apitest.APIServiceID, Name: "API", Reason: "variables"}},
	})
}

func TestChangesList(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "changes", "list")
	contains(t, r.stdout, "No open change sets in production")

	draft := stageDraft(h)
	other := h.fake.StageChangeSet(apitest.ChangeSetSpec{EnvironmentID: apitest.ProductionID, Title: "Rotate keys", Source: "mcp",
		Changes: []api.StagedChange{{Summary: "delete api.OLD_KEY"}}})
	h.ok("", "changes", "discard", other, "--yes")
	h.fake.StageChangeSet(apitest.ChangeSetSpec{EnvironmentID: apitest.StagingID, Draft: true})

	r = h.ok("", "changes")
	contains(t, r.stdout, draft)
	contains(t, r.stdout, "draft")
	notContains(t, r.stdout, other)
	for _, req := range h.fake.Requests() {
		if req.Pattern == "GET "+api.RouteListChangeSets.Path && !strings.Contains(req.Path, apitest.ProductionID) {
			t.Errorf("listed change sets of %s", req.Path)
		}
	}

	r = h.ok("", "changes", "ls", "--all", "--json")
	var out []api.ChangeSetSummary
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 || out[0].ID != other || out[0].Status != api.ChangeSetDiscarded || out[1].OpCount != 2 {
		t.Fatalf("--all: %+v", out)
	}

	r = h.ok("", "changes", "list", "--environment", "staging", "--json")
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil || len(out) != 1 || out[0].EnvironmentID != apitest.StagingID {
		t.Fatalf("staging: %v %+v", err, out)
	}
}

func TestChangesDiffOfDraft(t *testing.T) {
	h := newHarness(t)
	h.link()
	id := stageDraft(h)
	r := h.ok("", "changes", "diff")
	contains(t, r.stdout, id+" (draft of production, open, revision 1, 2 changes)")
	contains(t, r.stdout, "set api.STRIPE_KEY")
	contains(t, r.stdout, "/variables/STRIPE_KEY: <plain fp:1a2b3c4d> -> <secret fp:9f8e7d6c>")
	contains(t, r.stdout, "/deploy/replicas: 1 -> 2")
	contains(t, r.stdout, "will deploy: API (variables)")
	notContains(t, r.stdout, "conflict")

	r = h.ok("", "changes", "diff", id, "--json")
	var review api.ChangeSetReview
	if err := json.Unmarshal([]byte(r.stdout), &review); err != nil {
		t.Fatal(err)
	}
	if review.ChangeSet.ID != id || len(review.ChangeSet.Changes) != 2 || len(review.Deploys) != 1 {
		t.Fatalf("json: %+v", review)
	}
}

func TestChangesDiffNeverPrintsVariableValues(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.StageChangeSet(apitest.ChangeSetSpec{EnvironmentID: apitest.ProductionID, Draft: true, Changes: []api.StagedChange{{
		Summary: "set api.API_KEY",
		Diff: []api.DiffEntry{{Path: "/variables/API_KEY",
			Before: json.RawMessage(`{"value":"` + apitest.SecretValue + `"}`),
			After:  json.RawMessage(`{"tier":"secret","fingerprint":"0badf00d","value":"` + apitest.SecretValue + `"}`)}},
	}, {
		Summary: "update API config",
		Diff:    []api.DiffEntry{{Path: "/build/build_args/NPM_TOKEN", Before: json.RawMessage(`null`), After: json.RawMessage(`{"masked":true}`)}},
	}}})
	r := h.ok("", "changes", "diff")
	contains(t, r.stdout, "/variables/API_KEY: <hidden> -> <secret fp:0badf00d>")
	contains(t, r.stdout, "/build/build_args/NPM_TOKEN: (none) -> <masked>")
	notContains(t, r.stdout, apitest.SecretValue)
}

func TestChangesNoDraft(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "changes", "diff")
	contains(t, r.stdout, "Nothing staged in production")
	r = h.ok("", "changes", "diff", "--json")
	contains(t, r.stdout, `"change_set": null`)

	r = h.expect(exitcode.NotFound, "", "changes", "apply", "--yes")
	contains(t, r.stderr, "nothing staged in production")
	h.expect(exitcode.NotFound, "", "changes", "discard", "--yes")
	h.expect(exitcode.NotFound, "", "changes", "diff", "chs_nope")
}

func TestChangesApply(t *testing.T) {
	h := newHarness(t)
	h.link()
	id := stageDraft(h)

	r := h.expect(exitcode.InputRequired, "", "changes", "apply")
	contains(t, r.stderr, "pass --yes")
	r = h.interactive("n\n", "changes", "apply")
	if r.code != exitcode.Error || !strings.Contains(r.stderr, "Apply 2 changes to production and deploy 1 service?") {
		t.Fatalf("declined apply: exit %d\n%s", r.code, r.stderr)
	}
	if h.fake.ChangeSet(id).Status != api.ChangeSetOpen {
		t.Fatal("applied despite declining")
	}

	r = h.interactive("y\n", "changes", "apply")
	if r.code != 0 {
		t.Fatalf("confirmed apply: exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stdout, "/variables/STRIPE_KEY: <plain fp:1a2b3c4d> -> <secret fp:9f8e7d6c>")
	contains(t, r.stdout, "Applied 2 changes to production ("+id+")")
	contains(t, r.stdout, "Deploying: dep_")
	if cs := h.fake.ChangeSet(id); cs.Status != api.ChangeSetApplied {
		t.Fatalf("status %s", cs.Status)
	}
	var sent api.ApplyChangeSetInput
	for _, req := range h.fake.Requests() {
		if req.Pattern == "POST "+api.RouteApplyChangeSet.Path {
			if err := json.Unmarshal([]byte(req.Body), &sent); err != nil {
				t.Fatal(err)
			}
		}
	}
	if sent.ExpectedRevision != 1 || sent.Deploy != api.DeployAffected {
		t.Fatalf("apply body: %+v", sent)
	}

	r = h.expect(exitcode.Conflict, "", "changes", "apply", id, "--yes")
	contains(t, r.stderr, "is applied; only open change sets can be applied")
}

func TestChangesApplyNoDeployJSON(t *testing.T) {
	h := newHarness(t)
	h.link()
	id := stageDraft(h)
	before := len(h.fake.Requests())
	r := h.ok("", "changes", "apply", id, "--no-deploy", "--yes", "--json")
	var out api.AppliedChangeSet
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil {
		t.Fatal(err)
	}
	if out.ChangeSet.Status != api.ChangeSetApplied || len(out.DeploymentIDs) != 0 {
		t.Fatalf("json: %+v", out)
	}
	for _, req := range h.fake.Requests()[before:] {
		if req.Pattern == "POST "+api.RouteApplyChangeSet.Path && !strings.Contains(req.Body, `"deploy":"none"`) {
			t.Errorf("apply body %s", req.Body)
		}
	}
}

func TestChangesApplyConflict(t *testing.T) {
	h := newHarness(t)
	h.link()
	id := stageDraft(h)
	h.fake.DriftOnApply(id, "op_"+id+"_2", false)

	r := h.expect(exitcode.Conflict, "", "changes", "apply", "--yes")
	contains(t, r.stderr, "1 staged change conflict with changes made since")
	contains(t, r.stderr, "update API config: changed since it was staged")
	contains(t, r.stderr, "resolve the conflicts in the dashboard ("+h.fake.URL+"/w/"+apitest.WorkspaceID+"/p/"+apitest.ProjectID+")")
	contains(t, r.stderr, "roundhouse changes diff "+id)
	if h.fake.ChangeSet(id).Status != api.ChangeSetOpen {
		t.Fatal("applied despite the conflict")
	}

	// The conflict is now on record, so the review refuses before asking.
	before := len(h.fake.Requests())
	r = h.expect(exitcode.Conflict, "", "changes", "apply", id, "--yes")
	contains(t, r.stderr, "1 staged change conflicts with changes made since they were staged")
	contains(t, r.stderr, "update API config: changed since it was staged")
	for _, req := range h.fake.Requests()[before:] {
		if req.Pattern == "POST "+api.RouteApplyChangeSet.Path {
			t.Error("applied a set with a known conflict")
		}
	}

	r = h.ok("", "changes", "diff")
	contains(t, r.stdout, "conflicted")
	contains(t, r.stdout, "conflicts: 1 change must be resolved in the dashboard")

	r = h.expect(exitcode.Conflict, "", "changes", "apply", "--yes", "--json")
	var body struct {
		Error struct {
			Message string `json:"message"`
			Hint    string `json:"hint"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(r.stderr), &body); err != nil || !strings.Contains(body.Error.Message, "update API config") || !strings.Contains(body.Error.Hint, "dashboard") {
		t.Fatalf("json error: %v\n%s", err, r.stderr)
	}
}

func TestChangesDiscard(t *testing.T) {
	h := newHarness(t)
	h.link()
	id := stageDraft(h)

	r := h.expect(exitcode.InputRequired, "", "changes", "discard")
	contains(t, r.stderr, "pass --yes")
	r = h.interactive("n\n", "changes", "discard")
	if r.code != exitcode.Error || !strings.Contains(r.stderr, "Discard the draft of production (2 changes)?") {
		t.Fatalf("declined discard: exit %d\n%s", r.code, r.stderr)
	}
	r = h.interactive("y\n", "changes", "discard")
	if r.code != 0 || !strings.Contains(r.stdout, "Discarded the draft of production (2 changes)") {
		t.Fatalf("confirmed discard: exit %d\n%s%s", r.code, r.stdout, r.stderr)
	}
	if h.fake.ChangeSet(id).Status != api.ChangeSetDiscarded {
		t.Fatal("not discarded")
	}
	for _, req := range h.fake.Requests() {
		if req.Pattern == "POST "+api.RouteDiscardChangeSet.Path && req.Body != `{"expected_revision":1}` {
			t.Errorf("discard body %s", req.Body)
		}
	}
	r = h.expect(exitcode.NotFound, "", "changes", "discard", "--yes")
	contains(t, r.stderr, "nothing staged in production")
	r = h.expect(exitcode.Conflict, "", "changes", "discard", id, "--yes")
	contains(t, r.stderr, "is discarded")
}
