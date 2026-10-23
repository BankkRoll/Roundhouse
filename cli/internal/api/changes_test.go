package api

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestChangeSetTypesMatchSchemas(t *testing.T) {
	doc := loadOpenAPI(t)
	for name, v := range map[string]any{
		"ChangeSetSummary": ChangeSetSummary{},
		"ChangeSet":        ChangeSet{},
		"StagedChange":     StagedChange{},
		"DiffEntry":        DiffEntry{},
		"StagedConflict":   StagedConflict{},
		"ChangeSetReview":  ChangeSetReview{},
		"PlannedDeploy":    PlannedDeploy{},
		"AppliedChangeSet": AppliedChangeSet{},
		"ApplyChangeSet":   ApplyChangeSetInput{},
		"DiscardChangeSet": DiscardChangeSetInput{},
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

// TestChangeSetEnumsMatchAPI keeps the statuses the CLI recognises, the
// apply deploy modes and the list filter in step with the API.
func TestChangeSetEnumsMatchAPI(t *testing.T) {
	doc := loadOpenAPI(t)
	enum := func(schema, prop string) []string {
		s := doc.Components.Schemas[schema]
		if s == nil || s.Properties[prop] == nil {
			t.Fatalf("%s.%s missing from the OpenAPI document", schema, prop)
		}
		return s.Properties[prop].Enum
	}
	if got := enum("ChangeSetSummary", "status"); !slices.Equal(got, ChangeSetStatuses) {
		t.Errorf("ChangeSetStatuses = %v\nAPI enum          = %v", ChangeSetStatuses, got)
	}
	if got := enum("StagedChange", "status"); !slices.Equal(got, StagedChangeStatuses) {
		t.Errorf("StagedChangeStatuses = %v\nAPI enum             = %v", StagedChangeStatuses, got)
	}
	if got, want := enum("ApplyChangeSet", "deploy"), []string{DeployAffected, DeployNone}; !slices.Equal(got, want) {
		t.Errorf("deploy modes = %v, API enum = %v", want, got)
	}
}

func TestChangeSetListQueryExists(t *testing.T) {
	doc := loadOpenAPI(t)
	var op struct {
		Parameters []struct {
			In   string `json:"in"`
			Name string `json:"name"`
		} `json:"parameters"`
	}
	raw := doc.Paths[RouteListChangeSets.Path][strings.ToLower(RouteListChangeSets.Method)]
	if err := json.Unmarshal(raw, &op); err != nil {
		t.Fatal(err)
	}
	for _, p := range op.Parameters {
		if p.In == "query" && p.Name == "status" {
			return
		}
	}
	t.Errorf("%s: no query parameter \"status\"", RouteListChangeSets)
}
