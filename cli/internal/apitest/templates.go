package apitest

import (
	"cmp"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
)

// Template IDs of the fake's catalogue.
const (
	// TemplateWhoami is one image service with plain variables only.
	TemplateWhoami = "whoami"
	// TemplateN8N has a required string input, a required secret input, an
	// optional select input and a generated secret.
	TemplateN8N = "n8n"
	// TemplateUmami needs databases, which the fake (like the API) lacks.
	TemplateUmami = "umami"
)

// fakeTemplate is a catalogue entry: the detail the API serves, and for
// each variable the raw value deploying renders (`${{input.KEY}}` is
// substituted; generated values are minted).
type fakeTemplate struct {
	api.TemplateDetail
	// raw holds each secret variable's value as written, by key, since the
	// detail hides it.
	raw map[string]string
}

var templateCatalogue = []fakeTemplate{
	{TemplateDetail: api.TemplateDetail{
		TemplateSummary: api.TemplateSummary{ID: TemplateWhoami, Version: 1, Name: "whoami", Description: "Echoes the request back.",
			Icon: str("builtin:globe"), Category: "tool", Tags: []string{"http", "debug"}, DocsURL: str("https://github.com/traefik/whoami"),
			ServiceCount: 1, Requirements: []string{}, Supported: true},
		Inputs: []api.TemplateInput{},
		Services: []api.TemplateService{{Ref: "whoami", Name: "whoami", Kind: "app", Source: api.TemplateSource{Type: "image", Image: "traefik/whoami:v1"},
			Port: intp(80), Public: true, Variables: []api.TemplateVariable{
				{Key: "WHOAMI_PORT_NUMBER", Value: str("80")},
			}}},
		SharedVariables: []api.TemplateVariable{},
	}},
	{TemplateDetail: api.TemplateDetail{
		TemplateSummary: api.TemplateSummary{ID: TemplateN8N, Version: 2, Name: "n8n", Description: "Workflow automation.",
			Icon: str("builtin:n8n"), Category: "automation", Tags: []string{"automation"}, DocsURL: nil,
			ServiceCount: 1, Requirements: []string{}, Supported: true},
		Inputs: []api.TemplateInput{
			{Key: "WEBHOOK_URL", Label: "Webhook URL", Description: str("Public URL n8n is reached at"), Type: api.InputString, Required: true},
			{Key: "ADMIN_PASSWORD", Label: "Admin password", Type: api.InputSecret, Required: true},
			{Key: "TIMEZONE", Label: "Timezone", Type: api.InputSelect, Default: str("UTC"), Options: []string{"UTC", "Europe/Berlin"}},
		},
		Services: []api.TemplateService{{Ref: "n8n", Name: "n8n", Kind: "app", Source: api.TemplateSource{Type: "image", Image: "n8nio/n8n:1"},
			Port: intp(5678), Public: true, StartCommand: nil, Variables: []api.TemplateVariable{
				{Key: "N8N_ENCRYPTION_KEY", Secret: true, Generated: true, Description: str("Encrypts stored credentials")},
				{Key: "N8N_ADMIN_PASSWORD", Secret: true},
				{Key: "WEBHOOK_URL", Value: str("${{input.WEBHOOK_URL}}")},
				{Key: "GENERIC_TIMEZONE", Value: str("${{input.TIMEZONE}}")},
			}}},
		SharedVariables: []api.TemplateVariable{},
	}, raw: map[string]string{"N8N_ADMIN_PASSWORD": "${{input.ADMIN_PASSWORD}}"}},
	{TemplateDetail: api.TemplateDetail{
		TemplateSummary: api.TemplateSummary{ID: TemplateUmami, Version: 1, Name: "Umami", Description: "Web analytics.",
			Category: "monitoring", Tags: []string{"analytics"}, ServiceCount: 2, Requirements: []string{"databases"}, Supported: false},
		Inputs: []api.TemplateInput{},
		Services: []api.TemplateService{
			{Ref: "umami", Name: "Umami", Kind: "app", Source: api.TemplateSource{Type: "image", Image: "ghcr.io/umami-software/umami:postgresql-latest"},
				Port: intp(3000), Public: true, Variables: []api.TemplateVariable{
					{Key: "DATABASE_URL", Value: str("${{db.DATABASE_URL}}")},
				}},
			{Ref: "db", Name: "Postgres", Kind: "database", Source: api.TemplateSource{Type: "database", Engine: "postgres"},
				Port: intp(5432), Variables: []api.TemplateVariable{}},
		},
		SharedVariables: []api.TemplateVariable{},
	}},
}

func intp(n int) *int { return &n }

// FailTemplateDeploy makes the first deployment of a service created from
// a template with this ref fail to start, reported in deploy_errors.
func (f *Fake) FailTemplateDeploy(ref, message string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.templateDeployErrors == nil {
		f.templateDeployErrors = map[string]string{}
	}
	f.templateDeployErrors[ref] = message
}

func findTemplate(w http.ResponseWriter, id string) *fakeTemplate {
	for i := range templateCatalogue {
		if templateCatalogue[i].ID == id {
			return &templateCatalogue[i]
		}
	}
	apiError(w, http.StatusNotFound, "not_found", "Template not found")
	return nil
}

func (f *Fake) listTemplates(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	out := make([]api.TemplateSummary, len(templateCatalogue))
	for i, t := range templateCatalogue {
		out[i] = t.TemplateSummary
	}
	writeJSON(w, http.StatusOK, map[string]any{"templates": out})
}

func (f *Fake) getTemplate(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	if t := findTemplate(w, r.PathValue("templateId")); t != nil {
		writeJSON(w, http.StatusOK, t.TemplateDetail)
	}
}

// createFromTemplate mirrors createProjectFromTemplate in
// apps/api/src/lib/templates.ts: every check runs before anything is
// created, so a refused deploy leaves no project behind.
func (f *Fake) createFromTemplate(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	var in api.CreateProjectFromTemplateInput
	if decode(r, &in) != nil || !validSlug.MatchString(in.TemplateID) || in.Slug != "" && !validSlug.MatchString(in.Slug) {
		apiError(w, http.StatusBadRequest, "invalid_request", "template_id: expected a lowercase slug")
		return
	}
	t := findTemplate(w, in.TemplateID)
	if t == nil {
		return
	}
	plan, ok := f.planTemplate(w, r, t, in.TemplateDeployOptions)
	if !ok {
		return
	}
	name := cmp.Or(in.Name, t.Name)
	ws := r.PathValue("workspaceId")
	slug := uniqueSlug(cmp.Or(in.Slug, slugify(name)), func(s string) bool {
		for _, p := range f.projects {
			if p.WorkspaceID == ws && p.Slug == s {
				return true
			}
		}
		return false
	})
	id := f.nextID("prj")
	env := api.Environment{ID: f.nextID("env"), ProjectID: id, Name: "production", Slug: "production", Kind: "production", Protected: true, CreatedAt: Now}
	p := &api.ProjectDetail{
		Project:      api.Project{ID: id, WorkspaceID: ws, Name: name, Slug: slug, CreatedAt: Now, UpdatedAt: Now},
		Environments: []api.Environment{env}, Services: []api.Service{},
	}
	if in.Description != "" {
		p.Description = &in.Description
	}
	f.projects[id] = p
	writeJSON(w, http.StatusCreated, f.applyTemplate(t, p, env, plan, in.Deploy))
}

// deployTemplate mirrors deployTemplateIntoProject: the template's services
// join an existing project, with variables in one environment.
func (f *Fake) deployTemplate(w http.ResponseWriter, r *http.Request) {
	p := f.project(w, r.PathValue("projectId"))
	if p == nil {
		return
	}
	var in api.DeployTemplateInput
	if decode(r, &in) != nil || !validSlug.MatchString(in.TemplateID) || in.EnvironmentID == "" {
		apiError(w, http.StatusBadRequest, "invalid_request", "template_id and environment_id are required")
		return
	}
	i := slices.IndexFunc(p.Environments, func(e api.Environment) bool { return e.ID == in.EnvironmentID })
	if i < 0 {
		apiError(w, http.StatusNotFound, "not_found", "Environment not found")
		return
	}
	t := findTemplate(w, in.TemplateID)
	if t == nil {
		return
	}
	plan, ok := f.planTemplate(w, r, t, in.TemplateDeployOptions)
	if !ok {
		return
	}
	writeJSON(w, http.StatusCreated, f.applyTemplate(t, p, p.Environments[i], plan, in.Deploy))
}

// planTemplate runs the API's checks in its order: requirements (409), the
// caller's actions (403), inputs (400 invalid_request with one detail per
// input) and write-only confirmation (400 confirmation_required). It
// returns the resolved inputs.
func (f *Fake) planTemplate(w http.ResponseWriter, r *http.Request, t *fakeTemplate, opts api.TemplateDeployOptions) (map[string]string, bool) {
	if !t.Supported {
		apiError(w, http.StatusConflict, "conflict",
			t.Name+" needs "+strings.Join(t.Requirements, " and ")+", which this control plane doesn't support yet")
		return nil, false
	}
	c := callerOf(r)
	actions := []string{"services:manage", "variables:manage"}
	if opts.Deploy {
		actions = append(actions, "deployments:create")
	}
	for _, a := range actions {
		if !c.can(a) {
			apiError(w, http.StatusForbidden, "forbidden", "Deploying this template needs "+a+", which you lack here")
			return nil, false
		}
	}
	var issues []api.ErrorDetail
	for _, k := range slices.Sorted(mapKeys(opts.Inputs)) {
		if !slices.ContainsFunc(t.Inputs, func(in api.TemplateInput) bool { return in.Key == k }) {
			issues = append(issues, api.ErrorDetail{Field: "inputs." + k, Code: "unknown_input", Message: "The template declares no such input"})
		}
	}
	inputs := map[string]string{}
	for _, in := range t.Inputs {
		v := opts.Inputs[in.Key]
		if v == "" && in.Default != nil {
			v = *in.Default
		}
		switch {
		case v == "" && in.Required:
			issues = append(issues, api.ErrorDetail{Field: "inputs." + in.Key, Code: "required", Message: "Required"})
		case v != "" && in.Type == api.InputSelect && !slices.Contains(in.Options, v):
			issues = append(issues, api.ErrorDetail{Field: "inputs." + in.Key, Code: "invalid", Message: "Expected one of " + strings.Join(in.Options, ", ")})
		}
		inputs[in.Key] = v
	}
	if len(issues) > 0 {
		apiError(w, http.StatusBadRequest, "invalid_request", issues[0].Field+": "+issues[0].Message, issues...)
		return nil, false
	}
	var confirm []api.ErrorDetail
	for _, s := range t.Services {
		for _, v := range s.Variables {
			if v.Secret {
				confirm = append(confirm, api.ErrorDetail{Field: v.Key, Code: "confirmation_required", Message: "Becomes write-only"})
			}
		}
	}
	if len(confirm) > 0 && !opts.ConfirmWriteOnly {
		keys := make([]string, len(confirm))
		for i, d := range confirm {
			keys[i] = d.Field
		}
		apiError(w, http.StatusBadRequest, "confirmation_required",
			strings.Join(keys, ", ")+" will be write-only: nobody can read them back. Resend with confirm_write_only to continue", confirm...)
		return nil, false
	}
	return inputs, true
}

// applyTemplate creates the template's services in p, their variables in
// env and, when deploy is set, a queued first deployment of each.
func (f *Fake) applyTemplate(t *fakeTemplate, p *api.ProjectDetail, env api.Environment, inputs map[string]string, deploy bool) api.TemplateDeployment {
	out := api.TemplateDeployment{
		Template: api.TemplateRef{ID: t.ID, Version: t.Version}, Project: p.Project, Environment: env,
		Services: []api.Service{}, Deployments: []api.Deployment{}, DeployErrors: []api.TemplateDeployError{}, Warnings: []api.VariableWarning{},
	}
	render := func(v api.TemplateVariable) *variable {
		if v.Generated {
			return &variable{value: fmt.Sprintf("generated-%s-%d", strings.ToLower(v.Key), f.seq), secret: true, version: 1}
		}
		raw := deref(v.Value)
		if v.Secret {
			raw = t.raw[v.Key]
		}
		for k, val := range inputs {
			raw = strings.ReplaceAll(raw, "${{input."+k+"}}", val)
		}
		return &variable{value: raw, secret: v.Secret, version: 1}
	}
	for _, ts := range t.Services {
		slug := uniqueSlug(ts.Ref, func(s string) bool {
			return s == sharedNamespace || slices.ContainsFunc(p.Services, func(x api.Service) bool { return x.Slug == s })
		})
		svc := api.Service{Health: "ok", ID: f.nextID("svc"), ProjectID: p.ID, Name: ts.Name, Slug: slug, Kind: ts.Kind, Icon: ts.Icon, CreatedAt: Now, UpdatedAt: Now}
		p.Services = append(p.Services, svc)
		src := api.ServiceSource{Type: ts.Source.Type, Image: ts.Source.Image, RepoURL: ts.Source.RepoURL, Branch: ts.Source.Branch, RootDir: ts.Source.RootDir}
		for _, e := range p.Environments {
			f.configs[svc.ID+"/"+e.ID] = config(svc.ID, e.ID, src, ts.Port)
		}
		vars := map[string]*variable{}
		for _, v := range ts.Variables {
			vars[v.Key] = render(v)
		}
		f.vars[varKey(svc.ID, env.ID)] = vars
		out.Services = append(out.Services, svc)
		if !deploy {
			continue
		}
		if msg, failed := f.templateDeployErrors[ts.Ref]; failed {
			out.DeployErrors = append(out.DeployErrors, api.TemplateDeployError{ServiceID: svc.ID, Message: msg})
			continue
		}
		d := f.deployment(f.nextID("dep"), "queued", Now, nil)
		d.ProjectID, d.ServiceID, d.EnvironmentID = p.ID, svc.ID, env.ID
		f.deployments = append(f.deployments, d)
		out.Deployments = append(out.Deployments, d.Deployment)
	}
	if len(t.SharedVariables) > 0 {
		key := varKey(p.ID, env.ID)
		if f.vars[key] == nil {
			f.vars[key] = map[string]*variable{}
		}
		for _, v := range t.SharedVariables {
			f.vars[key][v.Key] = render(v)
		}
	}
	return out
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
