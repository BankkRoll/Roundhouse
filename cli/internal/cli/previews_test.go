package cli

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

var (
	forkHead  = strings.Repeat("c", 40)
	movedHead = strings.Repeat("d", 40)
	// rlo is U+202E RIGHT-TO-LEFT OVERRIDE, which makes text display reversed.
	rlo = "\xe2\x80\xae"
)

// seedPreviews adds an active same-repo preview of PR 7, a fork's PR 12
// pending approval, and a closed PR 3.
func seedPreviews(h *harness) (active, pending, closed string) {
	h.t.Helper()
	active = h.fake.AddPreview(api.Preview{
		PRNumber: 7, PRURL: "https://github.com/acme/shop/pull/7", Title: "Add a much longer checkout flow with saved carts and coupons",
		HeadRef: "checkout", HeadSHA: strings.Repeat("a", 40), HeadRepoFullName: strp("acme/shop"), AuthorLogin: "ada",
		Status: api.PreviewActive, EnvironmentID: strp("env_pr7"), EnvironmentSlug: strp("pr-7"), ExpiresAt: i64p(apitest.Now + 3*86400000),
		LastActivityAt: apitest.Now - 1000,
		Services:       []api.PreviewService{{ServiceID: apitest.APIServiceID, Slug: "api", Name: "API", URL: strp("https://api-pr-7.apps.example.com")}},
	})
	pending = h.fake.AddPreview(api.Preview{
		PRNumber: 12, PRURL: "https://github.com/acme/shop/pull/12", Title: "Fix typo\x1b]0;pwned\x07 " + rlo + "gnp.exe",
		HeadRef: "patch-1", HeadSHA: forkHead, HeadRepoFullName: strp("mallory/shop"), AuthorLogin: "mallory",
		IsFork: true, Withheld: true, Status: api.PreviewPendingApproval, LastActivityAt: apitest.Now,
	})
	closed = h.fake.AddPreview(api.Preview{
		PRNumber: 3, PRURL: "https://github.com/acme/shop/pull/3", Title: "Old work", HeadRef: "old", HeadSHA: strings.Repeat("b", 40),
		AuthorLogin: "ada", Status: api.PreviewClosed, ClosedAt: i64p(apitest.Now - 86400000), LastActivityAt: apitest.Now - 86400000,
	})
	return active, pending, closed
}

func TestPreviewsList(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "previews", "list")
	contains(t, r.stdout, "Shop has no open previews")

	_, pending, _ := seedPreviews(h)
	r = h.ok("", "previews", "list")
	contains(t, r.stdout, "TITLE")
	contains(t, r.stdout, "mallory (fork)")
	contains(t, r.stdout, "pending_approval")
	contains(t, r.stdout, "ccccccc")
	contains(t, r.stdout, "withheld")
	contains(t, r.stdout, "in 3d")
	contains(t, r.stdout, "https://api-pr-7.apps.example.com")
	contains(t, r.stdout, "Add a much longer checkout flow with sav…")
	notContains(t, r.stdout, "#3 ")
	// SECURITY: a fork author's title must not reach the terminal raw.
	notContains(t, r.stdout, "\x1b")
	notContains(t, r.stdout, rlo)
	contains(t, r.stdout, "Fix typo\\u001b]0;pwned\\u0007 \\u202egnp.exe")
	if strings.Index(r.stdout, "#12") > strings.Index(r.stdout, "#7") {
		t.Errorf("not newest activity first:\n%s", r.stdout)
	}

	r = h.ok("", "previews", "ls", "--all", "--json")
	var out []api.Preview
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 3 || out[0].ID != pending || out[2].Status != api.PreviewClosed {
		t.Fatalf("--all --json: %+v", out)
	}
	for _, req := range h.fake.Requests() {
		if req.Pattern == "GET /v1/projects/{projectId}/previews" && req.Query != "status=open" && req.Query != "status=all" {
			t.Errorf("list query %q", req.Query)
		}
	}

	h.ok("", "unlink")
	r = h.expect(exitcode.NotLinked, "", "previews", "list")
	contains(t, r.stderr, "pass --project")
	r = h.ok("", "previews", "list", "--project", "shop")
	contains(t, r.stdout, "#12")
}

func TestPreviewsListShowsRepoWhenSeveral(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.AddPreview(api.Preview{PRNumber: 4, RepoFullName: "acme/shop", Title: "a", HeadSHA: forkHead, AuthorLogin: "ada"})
	h.fake.AddPreview(api.Preview{PRNumber: 4, RepoFullName: "acme/web", Title: "b", HeadSHA: forkHead, AuthorLogin: "ada"})
	r := h.ok("", "previews", "list")
	contains(t, r.stdout, "acme/shop#4")
	contains(t, r.stdout, "acme/web#4")

	r = h.expect(exitcode.Usage, "", "previews", "redeploy", "4")
	contains(t, r.stderr, "matches 2 previews")
	contains(t, r.stderr, "pass the preview ID")
	r = h.ok("", "previews", "redeploy", "acme/web#4")
	contains(t, r.stdout, "Redeploying the preview of acme/web#4 at ccccccc")
}

func approveBody(t *testing.T, h *harness) []string {
	t.Helper()
	var shas []string
	for _, req := range h.fake.Requests() {
		if req.Pattern == "POST /v1/previews/{previewId}/approve" {
			var in api.ApprovePreviewInput
			if err := json.Unmarshal([]byte(req.Body), &in); err != nil {
				t.Fatal(err)
			}
			shas = append(shas, in.HeadSHA)
		}
	}
	return shas
}

func TestPreviewsApprove(t *testing.T) {
	h := newHarness(t)
	h.link()
	_, pending, _ := seedPreviews(h)

	r := h.expect(exitcode.Usage, "", "previews", "approve", "12")
	contains(t, r.stderr, "pass --yes")
	if len(approveBody(t, h)) != 0 {
		t.Fatal("approved without confirmation")
	}

	r = h.interactive("n\n", "previews", "approve", "#12")
	if r.code != exitcode.Error || len(approveBody(t, h)) != 0 {
		t.Fatalf("declined approve: exit %d, requests %v", r.code, approveBody(t, h))
	}
	contains(t, r.stderr, "Approve the preview of acme/shop#12")
	contains(t, r.stderr, "mallory (fork)")
	contains(t, r.stderr, "mallory/shop:patch-1")
	contains(t, r.stderr, forkHead)
	contains(t, r.stderr, "withheld")
	contains(t, r.stderr, "runs this commit's code")
	notContains(t, r.stderr, "\x1b]")

	r = h.interactive("y\n", "previews", "approve", "12")
	if r.code != 0 {
		t.Fatalf("confirmed approve: exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stdout, "Approved ccccccc of acme/shop#12; the preview is creating")
	if got := approveBody(t, h); len(got) != 1 || got[0] != forkHead {
		t.Fatalf("approve sent head_sha %v, want the shown %s", got, forkHead)
	}

	r = h.expect(exitcode.Conflict, "", "previews", "approve", pending, "--yes")
	contains(t, r.stderr, "is creating; only a preview pending approval")
	r = h.expect(exitcode.NotFound, "", "previews", "approve", "99", "--yes")
	contains(t, r.stderr, "no preview of pull request 99")
	h.expect(exitcode.NotFound, "", "previews", "approve", "prv_missing", "--yes")
	h.expect(exitcode.Usage, "", "previews", "approve", "twelve", "--yes")
}

func TestPreviewsApproveJSON(t *testing.T) {
	h := newHarness(t)
	h.link()
	_, pending, _ := seedPreviews(h)
	r := h.ok("", "previews", "approve", pending, "--yes", "--json")
	var out api.Preview
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil {
		t.Fatalf("stdout is not just JSON: %v\n%s", err, r.stdout)
	}
	if out.Status != api.PreviewCreating || out.ApprovedSHA == nil || *out.ApprovedSHA != forkHead {
		t.Fatalf("json: %+v", out)
	}
	contains(t, r.stderr, "Approve the preview of acme/shop#12")
}

func TestPreviewsApproveHeadMoved(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPreviews(h)
	h.fake.OnApprovePreview(func(p *api.Preview) { p.HeadSHA = movedHead })

	r := h.expect(exitcode.Conflict, "", "previews", "approve", "12", "--yes")
	contains(t, r.stderr, "acme/shop#12 has new commits since ccccccc was shown; nothing was approved")
	contains(t, r.stderr, "roundhouse previews approve 12")
	if got := approveBody(t, h); len(got) != 1 || got[0] != forkHead {
		t.Fatalf("approve sent %v", got)
	}
	for _, p := range h.fake.Previews() {
		if p.PRNumber == 12 && (p.Status != api.PreviewPendingApproval || p.ApprovedSHA != nil) {
			t.Fatalf("moved head was approved: %+v", p)
		}
	}
}

func TestPreviewsDestroy(t *testing.T) {
	h := newHarness(t)
	h.link()
	active, _, closed := seedPreviews(h)
	status := func(id string) string {
		for _, p := range h.fake.Previews() {
			if p.ID == id {
				return p.Status
			}
		}
		return ""
	}

	r := h.expect(exitcode.Usage, "", "previews", "destroy", "7")
	contains(t, r.stderr, "pass --yes")
	r = h.interactive("n\n", "previews", "destroy", "7")
	if r.code != exitcode.Error || status(active) != api.PreviewActive {
		t.Fatalf("declined destroy: exit %d, status %s", r.code, status(active))
	}
	r = h.interactive("y\n", "previews", "destroy", "7")
	if r.code != 0 {
		t.Fatalf("confirmed destroy: exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stdout, "Tore down the preview of acme/shop#7")
	if status(active) != api.PreviewClosed {
		t.Fatalf("status after destroy: %s", status(active))
	}

	r = h.ok("", "previews", "destroy", closed, "--yes")
	contains(t, r.stdout, "already torn down")

	_, pending, _ := seedPreviews(h)
	r = h.ok("", "previews", "rm", pending, "--yes", "--json")
	var out api.Preview
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil {
		t.Fatal(err)
	}
	if out.Status != api.PreviewClosed || out.EnvironmentID != nil {
		t.Fatalf("json: %+v", out)
	}
}

func TestPreviewsRedeploy(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPreviews(h)
	r := h.ok("", "previews", "redeploy", "7")
	contains(t, r.stdout, "Redeploying the preview of acme/shop#7 at aaaaaaa")
	r = h.expect(exitcode.Conflict, "", "previews", "redeploy", "12")
	contains(t, r.stderr, "Only an active preview")
}

func TestPreviewsRBAC(t *testing.T) {
	h := newHarness(t)
	h.env[EnvURL] = h.fake.URL
	h.env[EnvToken] = h.fake.AddToken("ci", "projects:read")
	_, pending, _ := seedPreviews(h)

	r := h.ok("", "previews", "list", "--project", "shop", "--insecure")
	contains(t, r.stdout, "#12")

	r = h.expect(exitcode.Forbidden, "", "previews", "approve", pending, "--yes", "--insecure")
	contains(t, r.stderr, "lacks the previews:manage scope")
	contains(t, r.stderr, "hint:")
	r = h.expect(exitcode.Forbidden, "", "previews", "destroy", "12", "--project", "shop", "--yes", "--insecure")
	contains(t, r.stderr, "environments:manage")
	r = h.expect(exitcode.Forbidden, "", "previews", "redeploy", "7", "--project", "shop", "--insecure")
	contains(t, r.stderr, "deployments:create")
	for _, p := range h.fake.Previews() {
		if p.Status == api.PreviewClosed && p.PRNumber != 3 || p.ApprovedSHA != nil {
			t.Fatalf("forbidden request changed a preview: %+v", p)
		}
	}

	// A token of another workspace sees the preview as missing.
	h.env[EnvToken] = h.fake.AddTokenIn("ws_other", "other", "projects:read", "previews:manage")
	h.expect(exitcode.NotFound, "", "previews", "approve", pending, "--yes", "--insecure")
}

func TestParsePreviewRef(t *testing.T) {
	for in, want := range map[string]previewRef{
		"prv_01J9": {id: "prv_01J9"}, "12": {pr: 12}, "#12": {pr: 12}, "acme/shop#12": {repo: "acme/shop", pr: 12},
	} {
		if got, err := parsePreviewRef(in); err != nil || got != want {
			t.Errorf("parsePreviewRef(%q) = %+v, %v; want %+v", in, got, err, want)
		}
	}
	for _, in := range []string{"", "0", "-1", "+3", "twelve", "acme#12", "a/b/c#1", "acme/shop#", "12#"} {
		if _, err := parsePreviewRef(in); err == nil {
			t.Errorf("parsePreviewRef(%q) accepted", in)
		}
	}
}

func TestVarsMarksWithheld(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.WithholdVariable(apitest.APIServiceID, apitest.ProductionID, "DATABASE_URL")
	r := h.ok("", "vars")
	contains(t, r.stdout, "<withheld from preview>")
	r = h.ok("", "vars", "get", "DATABASE_URL")
	contains(t, r.stdout, "<withheld from preview>")
	contains(t, r.stderr, "withheld from this preview")
	r = h.ok("", "vars", "export")
	notContains(t, r.stdout, "DATABASE_URL")
	contains(t, r.stderr, "withheld from this preview: DATABASE_URL")
}
