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
	Enum       []string           `json:"enum"`
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
		"Project":                   Project{},
		"ProjectDetail":             ProjectDetail{},
		"Environment":               Environment{},
		"Service":                   Service{},
		"CreatedService":            CreatedService{},
		"ServiceConfig":             ServiceConfig{},
		"NetworkingConfig":          NetworkingConfig{},
		"Variable":                  Variable{},
		"VariablesPut":              VariablesPut{},
		"VariableSetEntry":          VariableSet{},
		"VariablesPutResult":        VariablesPutResult{},
		"VariableWarning":           VariableWarning{},
		"Build":                     Build{},
		"Deployment":                Deployment{},
		"DeploymentPage":            DeploymentPage{},
		"DeploymentEvent":           DeploymentEvent{},
		"DeploymentDetail":          DeploymentDetail{},
		"Placement":                 Placement{},
		"LogEntry":                  LogEntry{},
		"LogPage":                   LogPage{},
		"Domain":                    Domain{},
		"Node":                      Node{},
		"CreateProject":             CreateProjectInput{},
		"ApiToken":                  APIToken{},
		"CreateApiToken":            CreateAPITokenInput{},
		"CreatedApiToken":           CreatedAPIToken{},
		"ResolvedVariables":         ResolvedVariables{},
		"ProviderIntegration":       ProviderIntegration{},
		"ProviderOffer":             ProviderOffer{},
		"ProviderOffers":            ProviderOffers{},
		"ProvisionNode":             ProvisionNodeInput{},
		"NodeProvision":             NodeProvision{},
		"DnsRecord":                 DNSRecord{},
		"AddDomain":                 AddDomainInput{},
		"UpdateDomain":              UpdateDomainInput{},
		"DomainHsts":                DomainHSTS{},
		"DomainTls":                 DomainTLS{},
		"DomainTlsNode":             DomainTLSNode{},
		"DomainRoutingNode":         DomainRoutingNode{},
		"CostEstimate":              CostEstimate{},
		"TemplateSummary":           TemplateSummary{},
		"TemplateDetail":            TemplateDetail{},
		"TemplateInput":             TemplateInput{},
		"TemplateVariable":          TemplateVariable{},
		"TemplateService":           TemplateService{},
		"TemplateDeployment":        TemplateDeployment{},
		"CreateProjectFromTemplate": CreateProjectFromTemplateInput{},
		"DeployTemplate":            DeployTemplateInput{},
		"ServiceMetrics":            ServiceMetrics{},
		"NodeMetrics":               NodeMetrics{},
		"MetricSeries":              MetricSeries{},
		"MetricsSummary":            MetricsSummary{},
		"ServiceMetricsSummary":     ServiceMetricsSummary{},
		"CreateDatabase":            CreateDatabaseInput{},
		"Volume":                    Volume{},
		"CreatedDatabase":           CreatedDatabase{},
		"DatabaseQuery":             DatabaseQueryInput{},
		"DatabaseQueryResult":       DatabaseQueryResult{},
		"DatabaseSchema":            DatabaseSchema{},
		"Backup":                    Backup{},
		"BackupPage":                BackupPage{},
		"BackupPolicy":              BackupPolicy{},
		"PutBackupPolicy":           PutBackupPolicyInput{},
		"BackupDownload":            BackupDownload{},
		"BackupDecryptionKey":       BackupDecryptionKey{},
		"RestoreBackup":             RestoreBackupInput{},
		"Restore":                   Restore{},
		"CronConfig":                CronConfig{},
		"CronState":                 CronState{},
		"CronRun":                   CronRun{},
		"CronRunPage":               CronRunPage{},
		"CronPreview":               CronPreview{},
		"ScheduleError":             ScheduleError{},
		"TriggerCronRun":            TriggerCronRunInput{},
		"CronEnvironment":           CronEnvironmentInput{},
		"UpdateService":             UpdateServiceInput{},
		"UpdatedService":            UpdatedService{},
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

// TestTokenScopesMatchAPI keeps the scopes `tokens create` validates and
// completes in step with the API's ApiTokenScope enum.
func TestTokenScopesMatchAPI(t *testing.T) {
	doc := loadOpenAPI(t)
	s := doc.Components.Schemas["ApiTokenScope"]
	if s == nil {
		t.Fatal("schema ApiTokenScope missing from the OpenAPI document")
	}
	if !slices.Equal(s.Enum, APITokenScopes) {
		t.Errorf("APITokenScopes = %v\nAPI enum      = %v", APITokenScopes, s.Enum)
	}
	for name, scopes := range APITokenPresets {
		for _, sc := range scopes {
			if !slices.Contains(s.Enum, sc) {
				t.Errorf("preset %s: unknown scope %s", name, sc)
			}
		}
	}
}

// TestQueryParamsExist checks the query parameters the client sends on
// routes where an unknown one would be silently ignored.
func TestQueryParamsExist(t *testing.T) {
	data, err := os.ReadFile("testdata/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	type param struct {
		In   string `json:"in"`
		Name string `json:"name"`
	}
	var doc struct {
		Paths map[string]map[string]struct {
			Parameters []param `json:"parameters"`
		} `json:"paths"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		route Route
		param string
	}{{RouteListProjects, "slug"}, {RouteRealtime, "client"}, {RouteResolveVars, "environment_id"},
		{RouteProviderOffers, "role"}, {RouteProviderOffers, "region"},
		{RouteServiceMetrics, "environment_id"}, {RouteServiceMetrics, "from"}, {RouteServiceMetrics, "to"},
		{RouteServiceMetrics, "metrics"}, {RouteServiceMetrics, "group"}, {RouteMetricsSummary, "environment_id"},
		{RouteNodeMetrics, "from"}, {RouteNodeMetrics, "to"}, {RouteNodeMetrics, "metrics"},
		{RouteServiceVolume, "environment_id"}, {RouteDatabaseSchema, "environment_id"},
		{RouteBackupPolicy, "environment_id"}, {RouteListBackups, "environment_id"},
		{RouteListBackups, "cursor"}, {RouteListBackups, "limit"},
		{RouteCronState, "environment_id"}, {RouteListCronRuns, "environment_id"}, {RouteListCronRuns, "cursor"},
		{RouteListCronRuns, "limit"}, {RouteListCronRuns, "status"}, {RouteCronRunLogs, "cursor"}, {RouteCronRunLogs, "limit"},
		{RouteCronPreview, "schedule"}, {RouteCronPreview, "timezone"}, {RouteCronPreview, "count"}} {
		op := doc.Paths[c.route.Path][strings.ToLower(c.route.Method)]
		if !slices.Contains(op.Parameters, param{In: "query", Name: c.param}) {
			t.Errorf("%s: no query parameter %q", c.route, c.param)
		}
	}
}

// TestVariableTiersMatchAPI keeps the tiers the CLI sends and recognises in
// step with the API's VariableTier enum.
func TestVariableTiersMatchAPI(t *testing.T) {
	doc := loadOpenAPI(t)
	s := doc.Components.Schemas["VariableTier"]
	if s == nil {
		t.Fatal("schema VariableTier missing from the OpenAPI document")
	}
	if want := []string{TierPlain, TierSecret}; !slices.Equal(s.Enum, want) {
		t.Errorf("tiers = %v, API enum = %v", want, s.Enum)
	}
}

// TestProviderEnumsMatchAPI keeps the providers `servers add --provider`
// accepts and the provisioning statuses it waits on in step with the API.
func TestProviderEnumsMatchAPI(t *testing.T) {
	doc := loadOpenAPI(t)
	if s := doc.Components.Schemas["ProviderId"]; s == nil {
		t.Error("schema ProviderId missing from the OpenAPI document")
	} else if !slices.Equal(s.Enum, ProviderIDs) {
		t.Errorf("ProviderIDs = %v\nAPI enum    = %v", ProviderIDs, s.Enum)
	}
	if s := doc.Components.Schemas["NodeProvision"]; s == nil || s.Properties["status"] == nil {
		t.Error("NodeProvision.status missing from the OpenAPI document")
	} else if !slices.Equal(s.Properties["status"].Enum, ProvisionStatuses) {
		t.Errorf("ProvisionStatuses = %v\nAPI enum          = %v", ProvisionStatuses, s.Properties["status"].Enum)
	}
}

// TestTemplateSourceMatchesSchema checks each variant of the TemplateSource
// union against the fields [TemplateSource] decodes.
func TestTemplateSourceMatchesSchema(t *testing.T) {
	doc := loadOpenAPI(t)
	data, err := os.ReadFile("testdata/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	var raw struct {
		Components struct {
			Schemas struct {
				TemplateSource struct {
					OneOf []*schema `json:"oneOf"`
				} `json:"TemplateSource"`
			} `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	variants := raw.Components.Schemas.TemplateSource.OneOf
	if len(variants) == 0 {
		t.Fatal("TemplateSource.oneOf missing from the API schema")
	}
	fields := jsonFields(reflect.TypeOf(TemplateSource{}))
	for _, v := range variants {
		_, required := doc.properties(v)
		for p := range required {
			if !slices.Contains(fields, p) {
				t.Errorf("TemplateSource.%s: required by a variant but missing from the Go type", p)
			}
		}
	}
}

// TestTemplateInputTypesMatchAPI keeps the input types `templates deploy`
// prompts for in step with the API's enum.
func TestTemplateInputTypesMatchAPI(t *testing.T) {
	doc := loadOpenAPI(t)
	s := doc.Components.Schemas["TemplateInput"]
	if s == nil || s.Properties["type"] == nil {
		t.Fatal("TemplateInput.type missing from the OpenAPI document")
	}
	if !slices.Equal(s.Properties["type"].Enum, TemplateInputTypes) {
		t.Errorf("TemplateInputTypes = %v\nAPI enum           = %v", TemplateInputTypes, s.Properties["type"].Enum)
	}
}

// TestMetricNamesMatchAPI keeps the metrics `roundhouse metrics` and
// `servers metrics` accept in step with the API, which lists them in the
// `metrics` query parameter's description.
func TestMetricNamesMatchAPI(t *testing.T) {
	data, err := os.ReadFile("testdata/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Paths map[string]map[string]struct {
			Parameters []struct {
				In          string `json:"in"`
				Name        string `json:"name"`
				Description string `json:"description"`
			} `json:"parameters"`
		} `json:"paths"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	for route, want := range map[Route][]string{RouteServiceMetrics: ServiceMetricNames, RouteNodeMetrics: NodeMetricNames} {
		var desc string
		for _, p := range doc.Paths[route.Path]["get"].Parameters {
			if p.In == "query" && p.Name == "metrics" {
				desc = p.Description
			}
		}
		_, list, ok := strings.Cut(desc, "subset of: ")
		if !ok {
			t.Errorf("%s: metrics parameter description %q does not list the metrics", route, desc)
			continue
		}
		if got := strings.Split(strings.TrimSuffix(list, "."), ", "); !slices.Equal(got, want) {
			t.Errorf("%s: CLI metrics = %v\nAPI metrics = %v", route, want, got)
		}
	}
}

// TestDataEnumsMatchAPI keeps the engines, statuses and restore modes the
// db commands accept and recognise in step with the API.
func TestDataEnumsMatchAPI(t *testing.T) {
	doc := loadOpenAPI(t)
	for _, c := range []struct {
		schema, prop string
		want         []string
	}{
		{"DatabaseChoice", "engine", DatabaseEngines},
		{"Volume", "status", VolumeStatuses},
		{"Backup", "status", BackupStatuses},
		{"RestoreBackup", "mode", RestoreModes},
		{"CronRun", "status", CronRunStatuses},
		{"CronRun", "trigger", CronRunTriggers},
	} {
		s := doc.Components.Schemas[c.schema]
		if s == nil || s.Properties[c.prop] == nil {
			t.Errorf("%s.%s missing from the OpenAPI document", c.schema, c.prop)
			continue
		}
		if got := s.Properties[c.prop].Enum; !slices.Equal(got, c.want) {
			t.Errorf("%s.%s: CLI = %v\nAPI enum = %v", c.schema, c.prop, c.want, got)
		}
	}
}
