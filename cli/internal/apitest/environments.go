package apitest

import (
	"cmp"
	"net/http"
	"slices"
	"strings"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
)

// environmentRoutes registers the environment lifecycle routes (ADR 0007).
func (f *Fake) environmentRoutes(handlers map[api.Route]guarded) {
	handlers[api.RouteCreateEnvironment] = guarded{"environments:manage", f.createEnvironment}
	handlers[api.RouteEnvironmentDiff] = guarded{"projects:read", f.diffEnvironments}
	handlers[api.RoutePromoteEnvironment] = guarded{"environments:manage", f.promoteEnvironment}
	handlers[api.RouteDeleteEnvironment] = guarded{"environments:manage", f.deleteEnvironment}
}

// environmentProjectOf returns the project of an environment route's
// environment, for token workspace checks. Must hold f.mu.
func (f *Fake) environmentProjectOf(r *http.Request) string {
	id := r.PathValue("environmentId")
	if id == "" {
		return ""
	}
	for _, p := range f.projects {
		if slices.ContainsFunc(p.Environments, func(e api.Environment) bool { return e.ID == id }) {
			return p.ID
		}
	}
	return ""
}

// findEnvironment returns the project and environment of an environment ID.
func (f *Fake) findEnvironment(w http.ResponseWriter, id string) (*api.ProjectDetail, *api.Environment) {
	for _, p := range f.projects {
		for i := range p.Environments {
			if p.Environments[i].ID == id {
				return p, &p.Environments[i]
			}
		}
	}
	apiError(w, http.StatusNotFound, "not_found", "Environment not found")
	return nil, nil
}

func (f *Fake) createEnvironment(w http.ResponseWriter, r *http.Request) {
	p := f.project(w, r.PathValue("projectId"))
	if p == nil {
		return
	}
	var in api.CreateEnvironmentInput
	if decode(r, &in) != nil || in.Name == "" || (in.Kind != "staging" && in.Kind != "preview") {
		apiError(w, http.StatusBadRequest, "invalid_request", "name and kind (staging or preview) are required")
		return
	}
	env := api.Environment{
		ID:        f.nextID("env"),
		ProjectID: p.ID,
		Name:      in.Name,
		Slug:      cmp.Or(in.Slug, strings.ToLower(strings.ReplaceAll(in.Name, " ", "-"))),
		Kind:      in.Kind,
		CreatedAt: Now,
	}
	if in.Clone != nil {
		from := slices.IndexFunc(p.Environments, func(e api.Environment) bool { return e.ID == in.Clone.FromEnvironmentID })
		if from < 0 {
			apiError(w, http.StatusNotFound, "not_found", "Environment not found")
			return
		}
		mode := cmp.Or(in.Clone.Variables, "all")
		owners := []string{p.ID}
		for _, s := range p.Services {
			owners = append(owners, s.ID)
		}
		for _, owner := range owners {
			src := f.vars[varKey(owner, in.Clone.FromEnvironmentID)]
			if mode == "none" || len(src) == 0 {
				continue
			}
			dst := map[string]*variable{}
			for k, v := range src {
				if mode == "non_secret" && v.secret {
					continue
				}
				c := *v
				c.version = 1
				dst[k] = &c
			}
			f.vars[varKey(owner, env.ID)] = dst
		}
	}
	p.Environments = append(p.Environments, env)
	writeJSON(w, http.StatusCreated, env)
}

// compareVars compares two variable sets by value, as the API does by
// fingerprint; values never leave.
func compareVars(base, target map[string]*variable) []api.VariableComparison {
	keys := map[string]bool{}
	for k := range base {
		keys[k] = true
	}
	for k := range target {
		keys[k] = true
	}
	out := []api.VariableComparison{}
	for k := range keys {
		b, t := base[k], target[k]
		c := api.VariableComparison{Key: k, Secret: b != nil && b.secret || t != nil && t.secret}
		switch {
		case b == nil:
			c.Change = "added"
		case t == nil:
			c.Change = "removed"
		case b.value == t.value && b.secret == t.secret:
			c.Change = "same"
		default:
			c.Change = "changed"
		}
		out = append(out, c)
	}
	slices.SortFunc(out, func(a, b api.VariableComparison) int { return strings.Compare(a.Key, b.Key) })
	return out
}

func (f *Fake) diffEnvironments(w http.ResponseWriter, r *http.Request) {
	p := f.project(w, r.PathValue("projectId"))
	if p == nil {
		return
	}
	base, target := r.URL.Query().Get("base"), r.URL.Query().Get("target")
	has := func(id string) bool {
		return slices.ContainsFunc(p.Environments, func(e api.Environment) bool { return e.ID == id })
	}
	if base == "" || target == "" {
		apiError(w, http.StatusBadRequest, "invalid_request", "base and target are required")
		return
	}
	if !has(base) || !has(target) {
		apiError(w, http.StatusNotFound, "not_found", "Environment not found")
		return
	}
	out := api.EnvironmentDiff{BaseEnvironmentID: base, TargetEnvironmentID: target}
	for _, s := range p.Services {
		out.Services = append(out.Services, api.ServiceComparison{
			ServiceID: s.ID,
			Slug:      s.Slug,
			Presence:  "both",
			Config:    []api.ConfigDifference{},
			Variables: compareVars(f.vars[varKey(s.ID, base)], f.vars[varKey(s.ID, target)]),
		})
	}
	out.SharedVariables = compareVars(f.vars[varKey(p.ID, base)], f.vars[varKey(p.ID, target)])
	writeJSON(w, http.StatusOK, out)
}

func (f *Fake) promoteEnvironment(w http.ResponseWriter, r *http.Request) {
	p, target := f.findEnvironment(w, r.PathValue("environmentId"))
	if target == nil {
		return
	}
	var in api.PromoteInput
	if decode(r, &in) != nil || in.FromEnvironmentID == "" {
		apiError(w, http.StatusBadRequest, "invalid_request", "from_environment_id: Required")
		return
	}
	if in.FromEnvironmentID == target.ID {
		apiError(w, http.StatusBadRequest, "invalid_request", "from_environment_id: promote from another environment")
		return
	}
	if !slices.ContainsFunc(p.Environments, func(e api.Environment) bool { return e.ID == in.FromEnvironmentID }) {
		apiError(w, http.StatusNotFound, "not_found", "Environment not found")
		return
	}
	var changes []api.StagedChange
	for _, owner := range append([]string{p.ID}, serviceIDs(p)...) {
		// "added" here means only the target has it; promotion only writes what the source holds.
		for _, c := range compareVars(f.vars[varKey(owner, in.FromEnvironmentID)], f.vars[varKey(owner, target.ID)]) {
			if c.Change == "same" || c.Change == "added" || (c.Secret && in.Include.Variables != "all") || in.Include.Variables == "none" {
				continue
			}
			changes = append(changes, api.StagedChange{
				ID:        f.nextID("stg"),
				Seq:       len(changes) + 1,
				TargetKey: "var:" + owner + ":" + c.Key,
				Summary:   "set " + c.Key,
				Status:    "pending",
				CreatedAt: Now,
				UpdatedAt: Now,
			})
		}
	}
	if len(changes) == 0 {
		apiError(w, http.StatusConflict, "conflict", "Nothing differs between the environments")
		return
	}
	title := "Promote"
	set := api.ChangeSet{
		ChangeSetSummary: api.ChangeSetSummary{
			ID:            f.nextID("chs"),
			ProjectID:     p.ID,
			EnvironmentID: target.ID,
			Status:        "open",
			Source:        "promote",
			Title:         &title,
			Revision:      len(changes),
			OpCount:       len(changes),
			ReviewStatus:  "none",
			CreatedAt:     Now,
			UpdatedAt:     Now,
		},
		Changes: changes,
	}
	writeJSON(w, http.StatusCreated, set)
}

func serviceIDs(p *api.ProjectDetail) []string {
	out := make([]string, len(p.Services))
	for i, s := range p.Services {
		out[i] = s.ID
	}
	return out
}

func (f *Fake) deleteEnvironment(w http.ResponseWriter, r *http.Request) {
	p, env := f.findEnvironment(w, r.PathValue("environmentId"))
	if env == nil {
		return
	}
	if env.Kind == "production" {
		apiError(w, http.StatusConflict, "conflict", "A production environment can never be deleted")
		return
	}
	if r.URL.Query().Get("confirm") != env.Slug {
		apiError(w, http.StatusBadRequest, "invalid_request", "confirm must equal the environment's slug")
		return
	}
	id := env.ID
	p.Environments = slices.DeleteFunc(p.Environments, func(e api.Environment) bool { return e.ID == id })
	w.WriteHeader(http.StatusNoContent)
}
