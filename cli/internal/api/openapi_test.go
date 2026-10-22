package api

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// The snapshot is generated from the API source by scripts/gen-openapi.sh.
// When a route or schema changes, regenerate it; these tests then show
// whether the CLI still matches.

type openAPIDoc struct {
	Paths      map[string]map[string]json.RawMessage `json:"paths"`
	Components struct {
		Schemas map[string]*schema `json:"schemas"`
	} `json:"components"`
}

type schema struct {
	Ref        string             `json:"$ref"`
	AllOf      []*schema          `json:"allOf"`
	Properties map[string]*schema `json:"properties"`
	Required   []string           `json:"required"`
	Items      *schema            `json:"items"`
}

func loadOpenAPI(t *testing.T) *openAPIDoc {
	t.Helper()
	data, err := os.ReadFile("testdata/openapi.json")
	if err != nil {
		t.Fatalf("read snapshot (regenerate with scripts/gen-openapi.sh): %v", err)
	}
	var doc openAPIDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	return &doc
}

func TestRoutesExistInOpenAPI(t *testing.T) {
	doc := loadOpenAPI(t)
	for _, r := range Routes {
		item, ok := doc.Paths[r.Path]
		if !ok {
			t.Errorf("%s: path not in the API's OpenAPI document", r)
			continue
		}
		if _, ok := item[strings.ToLower(r.Method)]; !ok {
			t.Errorf("%s: path exists but not with method %s", r, r.Method)
		}
	}
}

func TestRoutesAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, r := range append(slices.Clone(Routes), AuthRoutes...) {
		if seen[r.String()] {
			t.Errorf("duplicate route %s", r)
		}
		seen[r.String()] = true
	}
}

// properties flattens a schema's properties through $ref and allOf.
func (d *openAPIDoc) properties(s *schema) (props map[string]bool, required map[string]bool) {
	props, required = map[string]bool{}, map[string]bool{}
	var walk func(*schema)
	walk = func(s *schema) {
		if s == nil {
			return
		}
		if s.Ref != "" {
			walk(d.Components.Schemas[strings.TrimPrefix(s.Ref, "#/components/schemas/")])
		}
		for _, sub := range s.AllOf {
			walk(sub)
		}
		for name := range s.Properties {
			props[name] = true
		}
		for _, name := range s.Required {
			required[name] = true
		}
	}
	walk(s)
	return props, required
}

// jsonFields lists a struct's JSON field names, following embedded structs.
func jsonFields(t reflect.Type) []string {
	var out []string
	for f := range t.Fields() {
		if f.Anonymous {
			out = append(out, jsonFields(f.Type)...)
			continue
		}
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		if name != "" && name != "-" {
			out = append(out, name)
		}
	}
	return out
}

// TestWireTypesMatchSchemas checks each response type field by field: every
// Go field must be a schema property (no typos, no removed fields), and every
// required property must have a Go field (so --json output loses nothing).
func TestWireTypesMatchSchemas(t *testing.T) {
	doc := loadOpenAPI(t)
	for name, v := range map[string]any{
		"Project":          Project{},
		"ProjectDetail":    ProjectDetail{},
		"Environment":      Environment{},
		"Service":          Service{},
		"CreatedService":   CreatedService{},
		"ServiceConfig":    ServiceConfig{},
		"NetworkingConfig": NetworkingConfig{},
		"Variable":         Variable{},
		"VariablesPut":     VariablesPut{},
		"Build":            Build{},
		"Deployment":       Deployment{},
		"DeploymentPage":   DeploymentPage{},
		"DeploymentEvent":  DeploymentEvent{},
		"DeploymentDetail": DeploymentDetail{},
		"Placement":        Placement{},
		"LogEntry":         LogEntry{},
		"LogPage":          LogPage{},
		"Domain":           Domain{},
		"Node":             Node{},
		"CreateProject":    CreateProjectInput{},
	} {
		s, ok := doc.Components.Schemas[name]
		if !ok {
			t.Errorf("schema %s missing from the OpenAPI document", name)
			continue
		}
		props, required := doc.properties(s)
		fields := jsonFields(reflect.TypeOf(v))
		for _, f := range fields {
			if !props[f] {
				t.Errorf("%s.%s: no such property in the API schema", name, f)
			}
		}
		for p := range required {
			if !slices.Contains(fields, p) {
				t.Errorf("%s.%s: required by the API schema but missing from the Go type", name, p)
			}
		}
	}
}

func TestErrorShapeMatchesSchema(t *testing.T) {
	doc := loadOpenAPI(t)
	envelope := doc.Components.Schemas["Error"].Properties["error"]
	if envelope == nil {
		t.Fatal("Error.error missing from the API schema")
	}
	props, _ := doc.properties(envelope)
	for _, f := range []string{"code", "message", "details"} {
		if !props[f] {
			t.Errorf("Error.error.%s missing from the API schema", f)
		}
	}
	details := envelope.Properties["details"]
	if details == nil || details.Items == nil {
		t.Fatal("Error.error.details items missing from the API schema")
	}
	detailProps, _ := doc.properties(details.Items)
	for _, f := range jsonFields(reflect.TypeOf(ErrorDetail{})) {
		if !detailProps[f] {
			t.Errorf("ErrorDetail.%s: no such property in the API schema", f)
		}
	}
}
