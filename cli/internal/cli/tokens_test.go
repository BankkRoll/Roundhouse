package cli

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/BankkRoll/Open-Rail/cli/internal/api"
	"github.com/BankkRoll/Open-Rail/cli/internal/apitest"
	"github.com/BankkRoll/Open-Rail/cli/internal/exitcode"
)

func lastBody(t *testing.T, h *harness, pattern string) map[string]any {
	t.Helper()
	var body map[string]any
	for _, req := range h.fake.Requests() {
		if req.Pattern == pattern {
			body = nil
			if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
				t.Fatalf("%s body: %v", pattern, err)
			}
		}
	}
	return body
}

func TestTokensCreate(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.ok("", "tokens", "create", "--name", "ci", "--preset", "deploy")
	// stdout is the secret alone, so `$(roundhouse tokens create …)` captures it.
	if r.stdout != "tok_k001SecretValueXq9vLm2PzR7t\n" {
		t.Errorf("stdout = %q", r.stdout)
	}
	h.golden("tokens-create.txt", r.stderr)
	body := lastBody(t, h, "POST /v1/workspaces/{workspaceId}/tokens")
	if body["name"] != "ci" || body["expires_in_days"] != float64(90) || len(body["scopes"].([]any)) != len(api.APITokenPresets["deploy"]) {
		t.Errorf("create body = %v", body)
	}

	r = h.ok("", "tokens", "create", "--name", "dashboards", "--preset", "read", "--scope", "audit:read", "--scope", "projects:read", "--expires", "never", "--json")
	h.golden("tokens-create.json", r.stdout)
	contains(t, r.stderr, "will not be shown again")
	body = lastBody(t, h, "POST /v1/workspaces/{workspaceId}/tokens")
	if v, ok := body["expires_in_days"]; !ok || v != nil {
		t.Errorf("--expires never must send expires_in_days: null, got %v", body)
	}
	wantScopes := append(append([]any{}, toAny(api.APITokenPresets["read"])...), "audit:read")
	if !reflect.DeepEqual(body["scopes"], wantScopes) {
		t.Errorf("scopes = %v, want the preset then the extra scope, without repeats", body["scopes"])
	}

	// The secret goes to stdout only.
	notContains(t, r.stderr, "SecretValue")
}

func toAny(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}

func TestTokensCreateErrors(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.expect(exitcode.Usage, "", "tokens", "create", "--name", "x", "--preset", "admin")
	contains(t, r.stderr, `unknown --preset "admin"`)
	r = h.expect(exitcode.Usage, "", "tokens", "create", "--name", "x", "--scope", "instance:manage")
	contains(t, r.stderr, `unknown --scope "instance:manage"`)
	for _, bad := range []string{"0d", "367d", "soon", "-1"} {
		r = h.expect(exitcode.Usage, "", "tokens", "create", "--name", "x", "--preset", "read", "--expires", bad)
		contains(t, r.stderr, "invalid --expires")
	}
	// Without a TTY, missing choices fail and name the flag.
	r = h.expect(exitcode.InputRequired, "", "tokens", "create", "--preset", "read")
	contains(t, r.stderr, "--name")
	r = h.expect(exitcode.InputRequired, "", "tokens", "create", "--name", "x")
	contains(t, r.stderr, "--preset")
	for _, req := range h.fake.Requests() {
		if req.Pattern == "POST /v1/workspaces/{workspaceId}/tokens" {
			t.Error("created a token from invalid flags")
		}
	}

	// A token can only grant scopes it holds.
	h.env[EnvToken] = h.fake.AddToken("manager", "workspace:read", "tokens:manage")
	r = h.expect(exitcode.Forbidden, "", "tokens", "create", "--name", "escalate", "--preset", "deploy")
	contains(t, r.stderr, "only grant scopes it holds")
}

func TestTokensCreateInteractive(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.interactive("laptop\n2\n", "tokens", "create", "--expires", "7d")
	if r.code != 0 {
		t.Fatalf("exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stderr, "Token name:")
	contains(t, r.stderr, "Which scopes?")
	tok := h.fake.Token("tok_0001")
	if tok == nil || tok.Name != "laptop" || !reflect.DeepEqual(tok.Scopes, api.APITokenPresets["deploy"]) || *tok.ExpiresAt != apitest.Now+7*86400000 {
		t.Errorf("token = %+v", tok)
	}
}

func TestTokensList(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.ok("", "tokens", "list")
	contains(t, r.stdout, "No API tokens in Acme")
	h.ok("", "tokens", "create", "--name", "ci", "--preset", "deploy")
	h.ok("", "tokens", "create", "--name", "audit", "--scope", "audit:read", "--expires", "never")
	h.ok("", "tokens", "revoke", "ci", "--yes")
	r = h.ok("", "tokens", "list", "--json")
	h.golden("tokens.json", r.stdout)
	r = h.ok("", "tokens", "list")
	h.golden("tokens.txt", r.stdout)
	notContains(t, r.stdout, "SecretValue")
	h.expect(exitcode.NotFound, "", "tokens", "list", "--workspace", "nope")
}

func TestTokensRevoke(t *testing.T) {
	h := newHarness(t)
	h.login()
	h.fake.AddToken("ci", "workspace:read")
	h.fake.AddToken("dup", "workspace:read")
	h.fake.AddToken("dup", "workspace:read")

	r := h.expect(exitcode.InputRequired, "", "tokens", "revoke", "ci")
	contains(t, r.stderr, "pass --yes")
	if r := h.interactive("n\n", "tokens", "revoke", "ci"); r.code != exitcode.Error || !strings.Contains(r.stderr, "Revoke token ci (tok_0001, tok_k001)?") {
		t.Fatalf("declined revoke: exit %d\n%s", r.code, r.stderr)
	}
	if h.fake.Token("tok_0001").RevokedAt != nil {
		t.Fatal("revoked despite declining")
	}
	if r := h.interactive("y\n", "tokens", "revoke", "ci"); r.code != 0 || !strings.Contains(r.stdout, "Revoked token ci (tok_0001)") {
		t.Fatalf("confirmed revoke: exit %d\n%s%s", r.code, r.stdout, r.stderr)
	}
	if h.fake.Token("tok_0001").RevokedAt == nil {
		t.Fatal("not revoked")
	}
	r = h.ok("", "tokens", "revoke", "ci", "--yes")
	contains(t, r.stdout, "was already revoked")

	r = h.expect(exitcode.Usage, "", "tokens", "revoke", "dup", "--yes")
	contains(t, r.stderr, `2 tokens are named "dup"; pass the token ID`)
	r = h.ok("", "tokens", "revoke", "tok_0003", "--yes", "--json")
	contains(t, r.stdout, `"revoked": "tok_0003"`)
	// With one usable "dup" left, the name is no longer ambiguous.
	h.ok("", "tokens", "revoke", "dup", "--yes")
	if h.fake.Token("tok_0002").RevokedAt == nil {
		t.Error("tok_0002 not revoked")
	}
	h.expect(exitcode.NotFound, "", "tokens", "revoke", "nope", "--yes")
	h.expect(exitcode.Usage, "", "tokens", "revoke")
}

func TestTokensWorkspaceFromLink(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.ok("", "tokens", "list")
	for _, req := range h.fake.Requests() {
		if req.Pattern == "GET /v1/workspaces/{workspaceId}/tokens" && req.Path != "/v1/workspaces/"+apitest.WorkspaceID+"/tokens" {
			t.Errorf("listed tokens of %s", req.Path)
		}
	}
	h.expect(exitcode.NotFound, "", "tokens", "list", "--workspace", "other")
}

func TestTokensNeedScope(t *testing.T) {
	h := newHarness(t)
	h.login()
	h.env[EnvToken] = h.fake.AddToken("reader", api.APITokenPresets["read"]...)
	r := h.expect(exitcode.Forbidden, "", "tokens", "list")
	contains(t, r.stderr, "lacks the tokens:manage scope")
}
