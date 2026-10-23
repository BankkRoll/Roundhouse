package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// secretFP is how listings show the seeded secret API_KEY.
var secretFP = "<secret fp:" + apitest.Fingerprint(apitest.SecretValue) + ">"

// lastPut decodes the body of the most recent variables write.
func lastPut(t *testing.T, h *harness) api.VariablesPut {
	t.Helper()
	reqs := h.fake.Requests()
	for i := len(reqs) - 1; i >= 0; i-- {
		if reqs[i].Method == "PUT" && strings.HasSuffix(reqs[i].Path, "/variables") {
			var body api.VariablesPut
			if err := json.Unmarshal([]byte(reqs[i].Body), &body); err != nil {
				t.Fatal(err)
			}
			return body
		}
	}
	t.Fatal("no variables write")
	return api.VariablesPut{}
}

// linkWithToken links the work dir using an API token with scopes.
func linkWithToken(h *harness, scopes ...string) {
	h.t.Helper()
	h.env[EnvURL] = h.fake.URL
	h.env[EnvToken] = h.fake.AddToken("t", scopes...)
	h.ok("", "link", "--project", "shop", "--service", "api", "--gitignore=false", "--insecure")
}

func TestVarsList(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "vars", "--json")
	h.golden("vars.json", r.stdout)
	notContains(t, r.stdout, apitest.SecretValue)
	r = h.ok("", "vars")
	h.golden("vars.txt", r.stdout)
	notContains(t, r.stdout, apitest.SecretValue)
	contains(t, r.stdout, "secret (build)   "+secretFP)
	r = h.ok("", "vars", "get", "--shared")
	contains(t, r.stdout, "REGION   plain   eu-west")
}

func TestVarsListWithoutPlainValues(t *testing.T) {
	h := newHarness(t)
	linkWithToken(h, api.APITokenPresets["read"]...)
	r := h.ok("", "vars", "--insecure")
	contains(t, r.stdout, "NODE_ENV       plain            <hidden fp:"+apitest.Fingerprint("production")+">")
	notContains(t, r.stdout, "production\n")
	r = h.expect(exitcode.Forbidden, "", "vars", "get", "NODE_ENV", "--insecure")
	contains(t, r.stderr, "needs the variables:read_plain permission")
	r = h.ok("", "vars", "export", "--insecure")
	if r.stdout != "" {
		t.Errorf("export without plain values printed %q", r.stdout)
	}
	contains(t, r.stderr, "Left out 1 secret, which can't be read back: API_KEY")
	contains(t, r.stderr, "Left out 4 variables whose values need the variables:read_plain permission: DATABASE_URL, LISTEN, NODE_ENV, REGION")
}

func TestVarsGet(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "vars", "get", "DATABASE_URL")
	if r.stdout != "postgres://app:${{db.POSTGRES_PASSWORD}}@${{db.ROUNDHOUSE_PRIVATE_DOMAIN}}:${{db.PORT}}/shop\n" {
		t.Errorf("get printed %q", r.stdout)
	}
	r = h.ok("", "vars", "get", "API_KEY")
	if r.stdout != secretFP+"\n" {
		t.Errorf("get of a secret printed %q", r.stdout)
	}
	contains(t, r.stderr, "API_KEY is a secret: its value is write-only")
	r = h.ok("", "vars", "get", "API_KEY", "--json")
	var v api.Variable
	if err := json.Unmarshal([]byte(r.stdout), &v); err != nil {
		t.Fatal(err)
	}
	if v.Tier != api.TierSecret || v.Value != nil || v.Fingerprint == nil || *v.Fingerprint != apitest.Fingerprint(apitest.SecretValue) {
		t.Errorf("get --json = %+v", v)
	}
	h.expect(exitcode.NotFound, "", "vars", "get", "MISSING")
}

// TestVarsNeverPrintSecrets runs every reading command, and a failing
// write, and checks that no output carries a stored secret and that the
// CLI never asks for one.
func TestVarsNeverPrintSecrets(t *testing.T) {
	h := newHarness(t)
	h.link()
	for _, flag := range [][]string{{"vars"}, {"vars", "get"}, {"vars", "export"}} {
		r := h.expect(exitcode.Usage, "", append(flag, "--reveal")...)
		contains(t, r.stderr, "unknown flag: --reveal")
	}
	var out strings.Builder
	for _, args := range [][]string{
		{"vars"}, {"vars", "--json"}, {"vars", "get", "API_KEY"}, {"vars", "get", "API_KEY", "--json"},
		{"vars", "export"}, {"vars", "export", "--json"}, {"run", "--", "env"},
		{"vars", "get", "POSTGRES_PASSWORD", "--service", "db"}, {"vars", "export", "--service", "db"},
	} {
		r := h.ok("", args...)
		out.WriteString(r.stdout + r.stderr)
	}
	r := h.expect(exitcode.Invalid, "", "vars", "set", "API_KEY=new${{nope")
	out.WriteString(r.stdout + r.stderr)
	for _, secret := range []string{apitest.SecretValue, "pg-secret-password", "never-revealed"} {
		notContains(t, out.String(), secret)
	}
	for _, req := range h.fake.Requests() {
		if strings.Contains(req.Path, "reveal") {
			t.Errorf("requested %s %s", req.Method, req.Path)
		}
	}
}

func TestVarsRevealRouteIsGone(t *testing.T) {
	h := newHarness(t)
	h.link()
	for _, path := range []string{"/v1/services/" + apitest.APIServiceID + "/variables/reveal", "/v1/projects/" + apitest.ProjectID + "/variables/reveal"} {
		res, err := h.fake.Server.Client().Post(h.fake.URL+path+"?environment_id="+apitest.ProductionID, "application/json", strings.NewReader(`{"keys":["API_KEY"]}`))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 404 {
			t.Errorf("POST %s = %d, want 404", path, res.StatusCode)
		}
	}
}

func TestVarsSet(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "vars", "set", "A=1", "URL=${{db.HOST}}", "EMPTY=", "EQ=a=b")
	contains(t, r.stdout, "Set A, URL, EMPTY, EQ on API (production). Run `roundhouse deploy` to apply.")
	for key, want := range map[string]string{"A": "1", "URL": "${{db.HOST}}", "EMPTY": "", "EQ": "a=b"} {
		if got, secret, ok := h.fake.Variable(apitest.APIServiceID, apitest.ProductionID, key); !ok || got != want || secret {
			t.Errorf("%s = %q (secret %v, found %v), want %q", key, got, secret, ok, want)
		}
	}
	if body := lastPut(t, h); body.ConfirmWriteOnly || body.Set[0].Tier != "" || body.Set[0].AvailableAtBuild != nil {
		t.Errorf("plain set sent %+v", body)
	}

	h.ok("", "vars", "set", "--shared", "--environment", "staging", "FLAG=on")
	if got, _, _ := h.fake.Variable(apitest.ProjectID, apitest.StagingID, "FLAG"); got != "on" {
		t.Errorf("shared FLAG = %q", got)
	}

	h.expect(exitcode.Usage, "", "vars", "set", "NOEQUALS")
	h.expect(exitcode.Usage, "", "vars", "set", "1BAD=x")
	h.expect(exitcode.Usage, "a\n", "vars", "set", "A=-", "B=-")
	h.expect(exitcode.Usage, "", "vars", "set")
	r = h.expect(exitcode.Usage, "", "vars", "set", "--secret", "--plain", "A=1")
	contains(t, r.stderr, "--secret and --plain can't be combined")
}

func TestVarsSetSecret(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("token-from-stdin\r\n", "vars", "set", "--secret", "TOKEN=-")
	contains(t, r.stderr, "Write-only, never shown again: TOKEN.")
	body := lastPut(t, h)
	if s := body.Set[0]; s.Tier != api.TierSecret || s.Value == nil || *s.Value != "token-from-stdin" || !body.ConfirmWriteOnly {
		t.Errorf("--secret sent %+v (set %+v)", body, s)
	}
	if got, _ := h.fake.Stored(apitest.APIServiceID, apitest.ProductionID, "TOKEN"); got.Value != "token-from-stdin" || got.Tier != api.TierSecret {
		t.Errorf("TOKEN = %+v", got)
	}

	// --build and --mount-as-file are sent only when given, so a later
	// write keeps them.
	h.ok("", "vars", "set", "--secret", "--build", "--mount-as-file", "TOKEN=v2-token")
	h.ok("", "vars", "set", "TOKEN=v3-token")
	if body := lastPut(t, h); body.Set[0].AvailableAtBuild != nil || body.Set[0].MountAsFile != nil || body.Set[0].Tier != "" {
		t.Errorf("set without flags sent %+v", body.Set[0])
	}
	if got, _ := h.fake.Stored(apitest.APIServiceID, apitest.ProductionID, "TOKEN"); got.Tier != api.TierSecret || !got.AvailableAtBuild || !got.MountAsFile {
		t.Errorf("TOKEN = %+v", got)
	}
	h.ok("", "vars", "set", "--build=false", "TOKEN")
	if got, _ := h.fake.Stored(apitest.APIServiceID, apitest.ProductionID, "TOKEN"); got.AvailableAtBuild || got.Value != "v3-token" {
		t.Errorf("TOKEN after --build=false = %+v", got)
	}

	// A bare key changes only the tier: plain to secret keeps the value,
	// secret to plain needs it again.
	h.ok("", "vars", "set", "--secret", "NODE_ENV")
	if body := lastPut(t, h); body.Set[0].Value != nil {
		t.Errorf("bare key sent a value: %+v", body.Set[0])
	}
	if got, _ := h.fake.Stored(apitest.APIServiceID, apitest.ProductionID, "NODE_ENV"); got.Value != "production" || got.Tier != api.TierSecret {
		t.Errorf("NODE_ENV = %+v", got)
	}
	r = h.expect(exitcode.Invalid, "", "vars", "set", "--plain", "API_KEY")
	contains(t, r.stderr, "API_KEY: Re-enter the value to make a secret plain")
	h.ok("", "vars", "set", "--plain", "API_KEY=now-plain")
	if got, _ := h.fake.Stored(apitest.APIServiceID, apitest.ProductionID, "API_KEY"); got.Tier != api.TierPlain || !got.AvailableAtBuild {
		t.Errorf("API_KEY = %+v", got)
	}

	r = h.ok("", "vars", "set", "--secret", "PIN=1234")
	contains(t, r.stderr, "warning: PIN: PIN is shorter than 6 characters")
}

func TestVarsSetConfirmsWriteOnly(t *testing.T) {
	h := newHarness(t)
	h.link()
	// The control plane makes STRIPE_TOKEN secret by its name; nothing is
	// stored until the user agrees.
	r := h.expect(exitcode.Invalid, "", "vars", "set", "STRIPE_TOKEN=tok-value-1")
	contains(t, r.stderr, "STRIPE_TOKEN will be write-only")
	contains(t, r.stderr, "hint: secrets are write-only; pass --yes")
	if _, _, ok := h.fake.Variable(apitest.APIServiceID, apitest.ProductionID, "STRIPE_TOKEN"); ok {
		t.Error("stored without confirmation")
	}

	r = h.interactive("n\n", "vars", "set", "STRIPE_TOKEN=tok-value-1")
	if r.code != exitcode.Error {
		t.Errorf("declined: exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stderr, "STRIPE_TOKEN looks secret and will be write-only")
	contains(t, r.stderr, "nothing stored; pass --plain")
	if _, _, ok := h.fake.Variable(apitest.APIServiceID, apitest.ProductionID, "STRIPE_TOKEN"); ok {
		t.Error("stored although declined")
	}

	r = h.interactive("y\n", "vars", "set", "STRIPE_TOKEN=tok-value-1")
	if r.code != 0 {
		t.Fatalf("confirmed: exit %d\n%s", r.code, r.stderr)
	}
	if body := lastPut(t, h); !body.ConfirmWriteOnly || body.Set[0].Tier != "" {
		t.Errorf("resend = %+v", body)
	}
	if _, secret, _ := h.fake.Variable(apitest.APIServiceID, apitest.ProductionID, "STRIPE_TOKEN"); !secret {
		t.Error("STRIPE_TOKEN not secret")
	}

	h.ok("", "vars", "set", "--yes", "GITHUB_TOKEN=gh-value-1")
	if _, secret, _ := h.fake.Variable(apitest.APIServiceID, apitest.ProductionID, "GITHUB_TOKEN"); !secret {
		t.Error("--yes did not store GITHUB_TOKEN as a secret")
	}
	h.ok("", "vars", "set", "--plain", "SESSION_TOKEN_TTL=3600")
	if _, secret, _ := h.fake.Variable(apitest.APIServiceID, apitest.ProductionID, "SESSION_TOKEN_TTL"); secret {
		t.Error("--plain stored a secret")
	}
}

func TestVarsSetLockedTiers(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.expect(exitcode.Invalid, "", "vars", "set", "--secret", "VITE_API=https://x")
	contains(t, r.stderr, "VITE_API: VITE_ variables are public and can't be secret")
	r = h.expect(exitcode.Invalid, "", "vars", "set", "--plain", "STRIPE=sk_live_abcdef")
	contains(t, r.stderr, "must stay secret")

	r = h.expect(exitcode.Invalid, "", "vars", "set", "VITE_STRIPE=sk_live_abcdef")
	contains(t, r.stderr, "hint: public-prefix variables are bundled into client code; pass --acknowledge-public")
	r = h.ok("", "vars", "set", "--acknowledge-public", "VITE_STRIPE=sk_live_abcdef")
	contains(t, r.stderr, "warning: VITE_STRIPE: VITE_STRIPE looks like a credential")
	if body := lastPut(t, h); len(body.AcknowledgePublic) != 1 || body.AcknowledgePublic[0] != "VITE_STRIPE" {
		t.Errorf("acknowledge_public = %v", body.AcknowledgePublic)
	}
	r = h.ok("", "vars")
	contains(t, r.stdout, "VITE_STRIPE    plain (locked)   sk_live_abcdef")

	r = h.ok("", "vars", "set", "--json", "--acknowledge-public", "VITE_STRIPE=sk_live_abcdef")
	var res api.VariablesPutResult
	if err := json.Unmarshal([]byte(r.stdout), &res); err != nil {
		t.Fatal(err)
	}
	if len(res.Warnings) != 1 || res.Warnings[0].Code != "public_prefix_secret_value" || len(res.Variables) == 0 {
		t.Errorf("set --json = %+v", res)
	}
}

func TestVarsInvalidReference(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.expect(exitcode.Invalid, "", "vars", "set", "BAD=postgres://${{db.}}/x")
	h.golden("vars-invalid-reference.txt", r.stderr)

	// A multi-byte prefix: the API counts UTF-16 units, the CLI must still underline the reference.
	r = h.expect(exitcode.Invalid, "", "vars", "set", "BAD=héllo 😀 ${{bad ref}}")
	contains(t, r.stderr, "      héllo 😀 ${{bad ref}}\n              ^^^^^^^^^^^^\n")

	// Secret values are never echoed; only the reference itself is.
	r = h.expect(exitcode.Invalid, "", "vars", "set", "--secret", "BAD=hunter2-secret${{nope")
	notContains(t, r.stderr, "hunter2-secret")
	contains(t, r.stderr, "${{nope")
	r = h.expect(exitcode.Invalid, "", "vars", "set", "API_KEY=hunter2-secret${{nope")
	notContains(t, r.stderr, "hunter2-secret")

	r = h.expect(exitcode.Invalid, "", "vars", "set", "BAD=x ${{1}}", "--json")
	contains(t, r.stderr, `"code": "invalid_reference"`)
	contains(t, r.stderr, `"start": 2`)
}

func TestVarsUnset(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "vars", "unset", "NODE_ENV", "REGION", "NODE_ENV")
	contains(t, r.stdout, "Removed NODE_ENV, REGION, NODE_ENV from API (production)")
	for _, k := range []string{"NODE_ENV", "REGION"} {
		if _, _, ok := h.fake.Variable(apitest.APIServiceID, apitest.ProductionID, k); ok {
			t.Errorf("%s still set", k)
		}
	}
	h.expect(exitcode.Usage, "", "vars", "unset", "bad-key")
}

func TestVarsImport(t *testing.T) {
	h := newHarness(t)
	h.link()
	env := "# app\nexport PLAIN=hello world # comment\nREF='${{shared.REGION}}'\nQUOTED=\"line1\\nline2\"\n"
	path := filepath.Join(h.dir, ".env")
	if err := os.WriteFile(path, []byte(env), 0o600); err != nil {
		t.Fatal(err)
	}
	r := h.ok("", "vars", "import", path)
	contains(t, r.stdout, "Imported 3 variables into API (production)")
	for key, want := range map[string]string{"PLAIN": "hello world", "REF": "${{shared.REGION}}", "QUOTED": "line1\nline2"} {
		if got, _, _ := h.fake.Variable(apitest.APIServiceID, apitest.ProductionID, key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
	h.ok("S1=a1b2c3\nS2=b1c2d3\n", "vars", "import", "-", "--secret")
	if body := lastPut(t, h); !body.ConfirmWriteOnly || body.Set[1].Tier != api.TierSecret {
		t.Errorf("import --secret sent %+v", body)
	}
	if _, secret, _ := h.fake.Variable(apitest.APIServiceID, apitest.ProductionID, "S2"); !secret {
		t.Error("--secret not applied on import")
	}
	r = h.expect(exitcode.Invalid, "DB_PASSWORD=x1y2z3\n", "vars", "import", "-")
	contains(t, r.stderr, "hint: secrets are write-only; pass --yes")
	r = h.expect(exitcode.Usage, "BROKEN\n", "vars", "import", "-")
	contains(t, r.stderr, "line 1: expected KEY=VALUE")
	h.expect(exitcode.Usage, "", "vars", "import", filepath.Join(h.dir, "missing.env"))
}

func TestVarsImportBatches(t *testing.T) {
	h := newHarness(t)
	h.link()
	var b strings.Builder
	for i := range 600 {
		b.WriteString("K_" + strconv.Itoa(i) + "=v\n")
	}
	h.ok(b.String(), "vars", "import", "-")
	puts := 0
	for _, req := range h.fake.Requests() {
		if req.Pattern == "PUT /v1/services/{serviceId}/variables" {
			puts++
		}
	}
	if puts != 3 {
		t.Errorf("600 variables took %d requests, want 3 of at most 256", puts)
	}
}

func TestVarsExport(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "vars", "export")
	h.golden("vars-export.env", r.stdout)
	notContains(t, r.stdout, "API_KEY")
	if r.stderr != "Left out 1 secret, which can't be read back: API_KEY\n" {
		t.Errorf("stderr = %q", r.stderr)
	}
	r = h.ok("", "vars", "export", "--json")
	notContains(t, r.stdout, "API_KEY")
	contains(t, r.stdout, `"NODE_ENV": "production"`)
	contains(t, r.stderr, "Left out 1 secret")

	// What export writes, import reads back unchanged.
	h.ok("", "vars", "set", "TRICKY=it's \"$HOME\" ${{x}}\nnext")
	r = h.ok("", "vars", "export")
	path := filepath.Join(h.dir, "roundtrip.env")
	if err := os.WriteFile(path, []byte(r.stdout), 0o600); err != nil {
		t.Fatal(err)
	}
	h.ok("", "vars", "import", path, "--service", "db", "--yes")
	if got, _, _ := h.fake.Variable(apitest.DBServiceID, apitest.ProductionID, "TRICKY"); got != "it's \"$HOME\" ${{x}}\nnext" {
		t.Errorf("round trip = %q", got)
	}
}
