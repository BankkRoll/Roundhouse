package varref

import (
	"reflect"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	refs, errs := Parse("postgres://${{db.HOST}}:${{ PORT }}/x $${{literal}} ${{bad ref}} ${{open")
	want := []Reference{
		{Namespace: "db", Name: "HOST", Start: 11, End: 23},
		{Namespace: "", Name: "PORT", Start: 24, End: 35},
	}
	if !reflect.DeepEqual(refs, want) {
		t.Fatalf("refs = %+v, want %+v", refs, want)
	}
	if len(errs) != 2 || errs[0].Code != "malformed_reference" || errs[1].Code != "unclosed_reference" {
		t.Fatalf("errs = %+v", errs)
	}
}

func TestResolve(t *testing.T) {
	env, errs := Resolve(Input{
		Service: "api",
		Services: map[string]map[string]string{
			"api": {"DB": "${{db.URL}}", "SELF": "${{PORT}}-${{NAME}}", "NAME": "api", "REGION": "${{shared.REGION}}", "ESC": "$${{x}}"},
			"db":  {"URL": "postgres://${{OPENRAIL_PRIVATE_DOMAIN}}:5432"},
		},
		Shared:   map[string]string{"REGION": "eu"},
		Builtins: map[string]map[string]string{"api": {"PORT": "8080"}, "db": {"OPENRAIL_PRIVATE_DOMAIN": "db.production.internal"}},
	})
	if errs != nil {
		t.Fatal(errs)
	}
	want := map[string]string{
		"PORT": "8080", "DB": "postgres://db.production.internal:5432", "SELF": "8080-api",
		"NAME": "api", "REGION": "eu", "ESC": "${{x}}",
	}
	if !reflect.DeepEqual(env, want) {
		t.Fatalf("env = %v, want %v", env, want)
	}
}

func TestResolveErrors(t *testing.T) {
	_, errs := Resolve(Input{
		Service: "api",
		Services: map[string]map[string]string{
			"api": {"A": "${{B}}", "B": "${{A}}", "C": "${{nope.X}}", "D": "${{shared.MISSING}}"},
		},
	})
	codes := map[string]bool{}
	for _, e := range errs {
		codes[e.Code] = true
	}
	for _, c := range []string{"cycle", "unknown_service", "unknown_variable"} {
		if !codes[c] {
			t.Errorf("missing %s in %+v", c, errs)
		}
	}
	for _, e := range errs {
		if e.Code == "cycle" && !strings.Contains(e.Message, "api.A → api.B → api.A") {
			t.Errorf("cycle message = %q", e.Message)
		}
	}
}

func TestResolveTooLarge(t *testing.T) {
	big := strings.Repeat("x", MaxResolvedValueBytes/2+1)
	_, errs := Resolve(Input{Service: "a", Services: map[string]map[string]string{"a": {"X": big, "Y": "${{X}}${{X}}"}}})
	if len(errs) != 1 || errs[0].Code != "value_too_large" {
		t.Fatalf("errs = %+v", errs)
	}
}

func TestNamespaces(t *testing.T) {
	got := Namespaces(map[string]string{"A": "${{db.X}} ${{shared.Y}} ${{api.Z}} ${{W}}"}, "api")
	if !reflect.DeepEqual(got, []string{"db", "shared"}) {
		t.Fatalf("got %v", got)
	}
}
