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

// stageForReview stages a production set that another user opened, in an
// environment that requires approval, and returns its ID.
func stageForReview(h *harness) string {
	h.t.Helper()
	return h.fake.StageChangeSet(apitest.ChangeSetSpec{
		EnvironmentID: apitest.ProductionID, Draft: true, CreatedBy: "usr_grace", RequireApproval: true,
		Changes: []api.StagedChange{
			{Summary: "update API config", Diff: []api.DiffEntry{{Path: "/deploy/replicas", Before: json.RawMessage(`1`), After: json.RawMessage(`3`)}}},
			{Summary: "set API volume", Op: json.RawMessage(`{"type":"volume.set","service":"svc_api","mount_path":"/data","size_gb":10}`)},
		},
		Deploys: []api.PlannedDeploy{{Service: apitest.APIServiceID, Name: "API", Reason: "volume"}},
	})
}

// sentBody returns the body of the last request to route.
func sentBody(h *harness, route api.Route) string {
	h.t.Helper()
	body := ""
	for _, req := range h.fake.Requests() {
		if req.Pattern == route.Method+" "+route.Path {
			body = req.Body
		}
	}
	return body
}

func TestChangesSubmit(t *testing.T) {
	h := newHarness(t)
	h.link()
	id := stageDraft(h)

	r := h.ok("", "changes", "submit", "--note", "Rotates the key")
	contains(t, r.stdout, "Submitted the draft of production for review (2 changes, revision 1)")
	if body := sentBody(h, api.RouteSubmitChangeSet); body != `{"expected_revision":1,"note":"Rotates the key"}` {
		t.Errorf("submit body %s", body)
	}
	if cs := h.fake.ChangeSet(id); cs.ReviewStatus != api.ReviewSubmitted || cs.SubmittedBy == nil {
		t.Fatalf("review status %s", cs.ReviewStatus)
	}

	r = h.ok("", "changes", "submit", id)
	contains(t, r.stdout, "The draft of production is already waiting for a reviewer")

	r = h.ok("", "changes", "diff")
	contains(t, r.stdout, id+" (draft of production, open, revision 1, 2 changes, submitted)")
	contains(t, r.stdout, "review: waiting for a reviewer")
	contains(t, r.stdout, "note: Rotates the key")

	r = h.ok("", "changes", "list")
	contains(t, r.stdout, "REVIEW")
	contains(t, r.stdout, "submitted")

	r = h.ok("", "changes", "submit", "--json")
	var out api.ChangeSet
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil || out.ReviewStatus != api.ReviewSubmitted {
		t.Fatalf("json: %v %+v", err, out)
	}

	empty := h.fake.StageChangeSet(apitest.ChangeSetSpec{EnvironmentID: apitest.StagingID, Title: "Nothing yet"})
	r = h.expect(exitcode.Conflict, "", "changes", "submit", empty)
	contains(t, r.stderr, "Nothing is staged")
}

func TestChangesApproveOwnChangeSet(t *testing.T) {
	h := newHarness(t)
	h.link()
	id := stageDraft(h)
	r := h.expect(exitcode.Forbidden, "", "changes", "approve", "--yes")
	contains(t, r.stderr, "someone else must review it")
	contains(t, r.stderr, "ask someone else with the changes:approve permission to review it with `roundhouse changes diff "+id+"`")
	r = h.expect(exitcode.Forbidden, "", "changes", "reject", id, "--yes")
	contains(t, r.stderr, "someone else must review it")
	if cs := h.fake.ChangeSet(id); cs.ReviewStatus != api.ReviewNone {
		t.Fatalf("review status %s", cs.ReviewStatus)
	}
}

func TestChangesApprovalRequired(t *testing.T) {
	h := newHarness(t)
	h.link()
	id := stageForReview(h)

	r := h.ok("", "changes", "diff")
	contains(t, r.stdout, "will deploy: API (volume)")
	contains(t, r.stdout, "review: not submitted; approval required before applying")

	before := len(h.fake.Requests())
	r = h.expect(exitcode.Forbidden, "", "changes", "apply", "--yes")
	contains(t, r.stderr, "production requires an approval before changes apply")
	contains(t, r.stderr, "roundhouse changes submit "+id)
	for _, req := range h.fake.Requests()[before:] {
		if req.Pattern == "POST "+api.RouteApplyChangeSet.Path {
			t.Error("applied a set that waits for approval")
		}
	}

	r = h.expect(exitcode.InputRequired, "", "changes", "approve")
	contains(t, r.stderr, "pass --yes")
	r = h.interactive("n\n", "changes", "approve")
	if r.code != exitcode.Error || !strings.Contains(r.stderr, "Approve 2 changes to production at revision 1?") {
		t.Fatalf("declined approve: exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stdout, "/deploy/replicas: 1 -> 3")

	r = h.interactive("y\n", "changes", "approve", "--note", "Looks right")
	if r.code != 0 {
		t.Fatalf("confirmed approve: exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stdout, "Approved the draft of production at revision 1")
	contains(t, r.stdout, "Someone else applies it: `roundhouse changes apply "+id+"`")
	if body := sentBody(h, api.RouteApproveChangeSet); body != `{"expected_revision":1,"note":"Looks right"}` {
		t.Errorf("approve body %s", body)
	}

	r = h.ok("", "changes", "diff")
	contains(t, r.stdout, "2 changes, approved)")
	contains(t, r.stdout, "review: approved by usr_ada")
	notContains(t, r.stdout, "approval required")

	// The fake's caller approved it, so it may not also apply it.
	r = h.expect(exitcode.Forbidden, "", "changes", "apply", "--yes")
	contains(t, r.stderr, "someone else must apply it")
	contains(t, r.stderr, "ask someone else to run `roundhouse changes apply "+id+"`")

	h.fake.ApproveAs(id, "usr_linus")
	r = h.ok("", "changes", "apply", "--yes")
	contains(t, r.stdout, "Applied 2 changes to production ("+id+")")
}

func TestChangesReject(t *testing.T) {
	h := newHarness(t)
	h.link()
	id := stageForReview(h)

	r := h.interactive("n\n", "changes", "reject", id)
	if r.code != exitcode.Error || !strings.Contains(r.stderr, "Reject 2 changes to production at revision 1?") {
		t.Fatalf("declined reject: exit %d\n%s", r.code, r.stderr)
	}
	r = h.ok("", "changes", "reject", "--yes", "--note", "Scale staging\x1b[2J first")
	contains(t, r.stdout, "Rejected the draft of production at revision 1")
	if cs := h.fake.ChangeSet(id); cs.ReviewStatus != api.ReviewRejected || cs.RejectedBy == nil {
		t.Fatalf("review status %s", cs.ReviewStatus)
	}

	r = h.ok("", "changes", "diff")
	contains(t, r.stdout, "review: rejected by usr_ada; approval required before applying")
	contains(t, r.stdout, `note: Scale staging\u001b[2J first`)
	notContains(t, r.stdout, "\x1b[2J")

	r = h.expect(exitcode.Conflict, "", "changes", "apply", "--yes")
	contains(t, r.stderr, "The draft of production was rejected by usr_ada at revision 1")
	contains(t, r.stderr, "roundhouse changes submit "+id)

	r = h.ok("", "changes", "submit")
	contains(t, r.stdout, "Submitted the draft of production for review")
	if cs := h.fake.ChangeSet(id); cs.ReviewStatus != api.ReviewSubmitted || cs.RejectedBy != nil {
		t.Fatalf("after resubmit: %+v", cs.ChangeSetSummary)
	}

	r = h.ok("", "changes", "reject", "--yes", "--json")
	var out api.ChangeSet
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil || out.ReviewStatus != api.ReviewRejected {
		t.Fatalf("json: %v %+v", err, out)
	}
	if body := sentBody(h, api.RouteRejectChangeSet); body != `{"expected_revision":1}` {
		t.Errorf("reject body %s", body)
	}
}

func TestChangesRebase(t *testing.T) {
	h := newHarness(t)
	h.link()
	id := stageForReview(h)

	r := h.ok("", "changes", "rebase")
	contains(t, r.stdout, "The draft of production is up to date")
	if body := sentBody(h, api.RouteRebaseChangeSet); body != `{"expected_revision":1}` {
		t.Errorf("rebase body %s", body)
	}

	h.fake.ApproveAs(id, "usr_linus")
	h.fake.DriftOnRebase(id, "op_"+id+"_1")
	h.fake.DriftOnApply(id, "op_"+id+"_2", true)
	r = h.ok("", "changes", "diff")
	contains(t, r.stdout, "update API config  rebases")

	r = h.ok("", "changes", "rebase", id)
	contains(t, r.stdout, "Rebased 1 change onto the current state (revision 2)")
	contains(t, r.stdout, "rebased:  update API config")
	contains(t, r.stdout, "conflict: set API volume: its target no longer exists")
	contains(t, r.stdout, "The approval no longer applies")
	contains(t, r.stdout, "Next: resolve the conflicts in the dashboard")
	if cs := h.fake.ChangeSet(id); cs.Revision != 2 || cs.ReviewStatus != api.ReviewSubmitted || cs.ConflictedCount != 1 {
		t.Fatalf("after rebase: %+v", cs.ChangeSetSummary)
	}

	r = h.ok("", "changes", "rebase", "--json")
	var out api.RebasedChangeSet
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil {
		t.Fatal(err)
	}
	if out.ChangeSet.ID != id || len(out.Rebased) != 0 || len(out.Conflicts) != 1 || !out.Conflicts[0].Conflict.Deleted {
		t.Fatalf("json: %+v", out)
	}

	h.ok("", "changes", "discard", "--yes")
	r = h.expect(exitcode.NotFound, "", "changes", "rebase")
	contains(t, r.stderr, "nothing staged in production")
	r = h.expect(exitcode.Conflict, "", "changes", "rebase", id)
	contains(t, r.stderr, "only open change sets can be rebased")
}
