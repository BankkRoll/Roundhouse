package cli

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/BankkRoll/Open-Rail/cli/internal/apitest"
	"github.com/BankkRoll/Open-Rail/cli/internal/exitcode"
)

func TestVarsList(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "vars", "--json")
	h.golden("vars.json", r.stdout)
	r = h.ok("", "vars")
	h.golden("vars.txt", r.stdout)
	notContains(t, r.stdout, apitest.SecretValue)
	if len(h.fake.Reveals()) != 0 {
		t.Error("listing revealed secrets")
	}
	r = h.ok("", "vars", "get", "--shared")
	contains(t, r.stdout, "REGION   eu-west")
}

func TestVarsGet(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "vars", "get", "DATABASE_URL")
	if r.stdout != "postgres://app:${{db.POSTGRES_PASSWORD}}@${{db.OPENRAIL_PRIVATE_DOMAIN}}:${{db.PORT}}/shop\n" {
		t.Errorf("get printed %q", r.stdout)
	}
	r = h.expect(exitcode.Usage, "", "vars", "get", "API_KEY")
	contains(t, r.stderr, "API_KEY is secret; pass --reveal")
	r = h.ok("", "vars", "get", "API_KEY", "--reveal")
	if r.stdout != apitest.SecretValue+"\n" {
		t.Errorf("revealed %q", r.stdout)
	}
	if got := h.fake.Reveals(); !reflect.DeepEqual(got, [][]string{{"API_KEY"}}) {
		t.Errorf("reveals = %v", got)
	}
	h.expect(exitcode.NotFound, "", "vars", "get", "MISSING")

	r = h.ok("", "vars", "--reveal", "--json")
	contains(t, r.stdout, apitest.SecretValue)
	contains(t, r.stderr, "Revealed 1 secret (recorded in the audit log)")
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

	h.ok("token-from-stdin\r\n", "vars", "set", "--secret", "TOKEN=-")
	if got, secret, _ := h.fake.Variable(apitest.APIServiceID, apitest.ProductionID, "TOKEN"); got != "token-from-stdin" || !secret {
		t.Errorf("TOKEN = %q secret=%v", got, secret)
	}
	h.ok("", "vars", "set", "--shared", "--environment", "staging", "FLAG=on")
	if got, _, _ := h.fake.Variable(apitest.ProjectID, apitest.StagingID, "FLAG"); got != "on" {
		t.Errorf("shared FLAG = %q", got)
	}

	h.expect(exitcode.Usage, "", "vars", "set", "NOEQUALS")
	h.expect(exitcode.Usage, "", "vars", "set", "1BAD=x")
	h.expect(exitcode.Usage, "a\n", "vars", "set", "A=-", "B=-")
	h.expect(exitcode.Usage, "", "vars", "set")
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
	h.ok("S1=a\nS2=b\n", "vars", "import", "-", "--secret")
	if _, secret, _ := h.fake.Variable(apitest.APIServiceID, apitest.ProductionID, "S2"); !secret {
		t.Error("--secret not applied on import")
	}
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
	notContains(t, r.stdout, apitest.SecretValue)
	if len(h.fake.Reveals()) != 0 {
		t.Error("export without --reveal revealed secrets")
	}
	r = h.ok("", "vars", "export", "--reveal")
	contains(t, r.stdout, "API_KEY="+apitest.SecretValue+"\n")
	if !slices.ContainsFunc(h.fake.Reveals(), func(keys []string) bool { return slices.Equal(keys, []string{"API_KEY"}) }) {
		t.Errorf("reveals = %v", h.fake.Reveals())
	}
	r = h.ok("", "vars", "export", "--json")
	contains(t, r.stdout, `"API_KEY": null`)

	// What export writes, import reads back unchanged.
	h.ok("", "vars", "set", "TRICKY=it's \"$HOME\" ${{x}}\nnext")
	r = h.ok("", "vars", "export")
	path := filepath.Join(h.dir, "roundtrip.env")
	if err := os.WriteFile(path, []byte(r.stdout), 0o600); err != nil {
		t.Fatal(err)
	}
	h.ok("", "vars", "import", path, "--service", "db")
	if got, _, _ := h.fake.Variable(apitest.DBServiceID, apitest.ProductionID, "TRICKY"); got != "it's \"$HOME\" ${{x}}\nnext" {
		t.Errorf("round trip = %q", got)
	}
}
