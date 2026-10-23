package apitest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
)

// changeSet is a stored change set with what the fake's review reports.
type changeSet struct {
	api.ChangeSet
	deploys []api.PlannedDeploy
	// drift holds ops that conflict as soon as an apply checks them, as if
	// someone changed their target after the last review.
	drift map[string]bool
}

// ChangeSetSpec describes a change set for [Fake.StageChangeSet].
type ChangeSetSpec struct {
	EnvironmentID string
	// Draft makes it the environment's shared dashboard draft.
	Draft  bool
	Title  string
	Source string
	// Changes are stored in order; empty IDs, seqs, statuses and
	// timestamps are filled in.
	Changes []api.StagedChange
	// Deploys is what applying with deploy "affected" starts.
	Deploys []api.PlannedDeploy
}

// StageChangeSet stores a change set in the seeded project and returns
// its ID.
func (f *Fake) StageChangeSet(spec ChangeSetSpec) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	source := spec.Source
	if source == "" {
		source = "dashboard"
	}
	cs := &changeSet{
		ChangeSet: api.ChangeSet{ChangeSetSummary: api.ChangeSetSummary{
			ID: f.nextID("chs"), ProjectID: ProjectID, EnvironmentID: spec.EnvironmentID, Status: api.ChangeSetOpen,
			IsDraft: spec.Draft, Source: source, Revision: 1, CreatedBy: str(f.user.ID),
			CreatedAt: Now - 60000 + int64(f.seq), UpdatedAt: Now - 60000 + int64(f.seq),
		}},
		deploys: slices.Clone(spec.Deploys),
		drift:   map[string]bool{},
	}
	if spec.Title != "" {
		cs.Title = str(spec.Title)
	}
	for i, c := range spec.Changes {
		if c.ID == "" {
			c.ID = fmt.Sprintf("op_%s_%d", cs.ID, i+1)
		}
		if c.Seq == 0 {
			c.Seq = i + 1
		}
		if c.Status == "" {
			c.Status = api.StagedPending
		}
		if c.Op == nil {
			c.Op = json.RawMessage(`{"type":"service.update"}`)
		}
		if c.Diff == nil {
			c.Diff = []api.DiffEntry{}
		}
		if c.CreatedAt == 0 {
			c.CreatedAt, c.UpdatedAt = cs.CreatedAt, cs.CreatedAt
		}
		cs.Changes = append(cs.Changes, c)
	}
	if cs.Changes == nil {
		cs.Changes = []api.StagedChange{}
	}
	if cs.deploys == nil {
		cs.deploys = []api.PlannedDeploy{}
	}
	cs.count()
	f.changeSets = append(f.changeSets, cs)
	return cs.ID
}

// DriftOnApply makes the next apply of a change set find op changed (or,
// with deleted, its target gone) since it was staged.
func (f *Fake) DriftOnApply(changeSetID, opID string, deleted bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, cs := range f.changeSets {
		if cs.ID == changeSetID {
			cs.drift[opID] = deleted
		}
	}
}

// ChangeSet returns a copy of a stored change set, or nil.
func (f *Fake) ChangeSet(id string) *api.ChangeSet {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, cs := range f.changeSets {
		if cs.ID == id {
			out := cs.ChangeSet
			out.Changes = slices.Clone(cs.Changes)
			return &out
		}
	}
	return nil
}

func (cs *changeSet) count() {
	cs.OpCount, cs.ConflictedCount = 0, 0
	for _, c := range cs.Changes {
		if c.Status != api.StagedApplied {
			cs.OpCount++
		}
		if c.Status == api.StagedConflicted {
			cs.ConflictedCount++
		}
	}
}

func (cs *changeSet) bump() {
	cs.Revision++
	cs.UpdatedAt = Now
	cs.count()
}

func (f *Fake) environmentExists(id string) bool {
	for _, p := range f.projects {
		if slices.ContainsFunc(p.Environments, func(e api.Environment) bool { return e.ID == id }) {
			return true
		}
	}
	return false
}

func (f *Fake) findChangeSet(w http.ResponseWriter, id string) *changeSet {
	for _, cs := range f.changeSets {
		if cs.ID == id {
			return cs
		}
	}
	apiError(w, http.StatusNotFound, "not_found", "Change set not found")
	return nil
}

func (f *Fake) listChangeSets(w http.ResponseWriter, r *http.Request) {
	env := r.PathValue("environmentId")
	if !f.environmentExists(env) {
		apiError(w, http.StatusNotFound, "not_found", "Environment not found")
		return
	}
	status := r.URL.Query().Get("status")
	if status != "" && status != "open" && status != "all" {
		apiError(w, http.StatusBadRequest, "invalid_request", "status: Invalid enum value")
		return
	}
	out := []api.ChangeSetSummary{}
	for i := len(f.changeSets) - 1; i >= 0; i-- {
		cs := f.changeSets[i]
		if cs.EnvironmentID == env && (status == "all" || cs.Status == api.ChangeSetOpen) {
			out = append(out, cs.ChangeSetSummary)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"change_sets": out})
}

func (f *Fake) getDraft(w http.ResponseWriter, r *http.Request) {
	env := r.PathValue("environmentId")
	if !f.environmentExists(env) {
		apiError(w, http.StatusNotFound, "not_found", "Environment not found")
		return
	}
	for _, cs := range f.changeSets {
		if cs.EnvironmentID == env && cs.IsDraft && cs.Status == api.ChangeSetOpen {
			writeJSON(w, http.StatusOK, map[string]any{"change_set": cs.ChangeSet})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"change_set": nil})
}

func (f *Fake) getChangeSet(w http.ResponseWriter, r *http.Request) {
	if cs := f.findChangeSet(w, r.PathValue("changeSetId")); cs != nil {
		writeJSON(w, http.StatusOK, cs.ChangeSet)
	}
}

func (f *Fake) reviewChangeSet(w http.ResponseWriter, r *http.Request) {
	cs := f.findChangeSet(w, r.PathValue("changeSetId"))
	if cs == nil {
		return
	}
	review := api.ChangeSetReview{ChangeSet: cs.ChangeSet, Rebases: []string{}, Conflicts: []api.ChangeSetConflict{}, Deploys: cs.deploys}
	for _, c := range cs.Changes {
		if c.Status == api.StagedConflicted && c.Conflict != nil {
			review.Conflicts = append(review.Conflicts, api.ChangeSetConflict{ID: c.ID, Conflict: *c.Conflict})
		}
	}
	writeJSON(w, http.StatusOK, review)
}

func (f *Fake) applyChangeSet(w http.ResponseWriter, r *http.Request) {
	cs := f.findChangeSet(w, r.PathValue("changeSetId"))
	if cs == nil {
		return
	}
	var in api.ApplyChangeSetInput
	if decode(r, &in) != nil || in.ExpectedRevision <= 0 {
		apiError(w, http.StatusBadRequest, "invalid_request", "expected_revision: Required")
		return
	}
	if in.Deploy == "" {
		in.Deploy = api.DeployAffected
	}
	if in.Deploy != api.DeployAffected && in.Deploy != api.DeployNone {
		apiError(w, http.StatusBadRequest, "invalid_request", "deploy: Invalid enum value")
		return
	}
	if cs.Status != api.ChangeSetOpen {
		apiError(w, http.StatusConflict, "conflict", "The change set is "+cs.Status)
		return
	}
	if in.ExpectedRevision != cs.Revision {
		apiError(w, http.StatusConflict, "change_set_changed",
			fmt.Sprintf("The change set changed since you reviewed it; it is at revision %d. Reload and review again", cs.Revision))
		return
	}
	var details []api.ErrorDetail
	for i := range cs.Changes {
		c := &cs.Changes[i]
		deleted, drifted := cs.drift[c.ID]
		if drifted {
			v := 1
			c.Status, c.Conflict = api.StagedConflicted, &api.StagedConflict{BaseVersion: &v, CurrentVersion: &v, Deleted: deleted}
		}
		if c.Status != api.StagedConflicted {
			continue
		}
		why := "changed since it was staged"
		if c.Conflict != nil && c.Conflict.Deleted {
			why = "its target no longer exists"
		}
		details = append(details, api.ErrorDetail{Field: c.ID, Code: "conflict", Message: c.Summary + ": " + why})
	}
	if len(details) > 0 {
		clear(cs.drift)
		cs.bump()
		plural := "s"
		if len(details) == 1 {
			plural = ""
		}
		apiError(w, http.StatusConflict, "change_set_conflict",
			fmt.Sprintf("%d staged change%s conflict with changes made since; resolve them and review again", len(details), plural), details...)
		return
	}
	out := api.AppliedChangeSet{DeploymentIDs: []string{}, Skipped: []api.SkippedDeploy{}}
	if in.Deploy == api.DeployAffected {
		for _, d := range cs.deploys {
			p, svc := f.serviceOf(d.Service)
			if svc == nil {
				out.Skipped = append(out.Skipped, api.SkippedDeploy{ServiceID: d.Service, Reason: "scaled to 0 replicas"})
				continue
			}
			dep := f.deployment(f.nextID("dep"), "queued", Now, nil)
			dep.ProjectID, dep.ServiceID, dep.EnvironmentID = p.ID, svc.ID, cs.EnvironmentID
			f.deployments = append(f.deployments, dep)
			out.DeploymentIDs = append(out.DeploymentIDs, dep.ID)
		}
	}
	for i := range cs.Changes {
		cs.Changes[i].Status = api.StagedApplied
	}
	cs.Status, cs.AppliedBy, cs.AppliedAt = api.ChangeSetApplied, str(f.user.ID), i64(Now)
	cs.bump()
	out.ChangeSet = cs.ChangeSet
	writeJSON(w, http.StatusOK, out)
}

// serviceOf finds a live service without answering the request.
func (f *Fake) serviceOf(id string) (*api.ProjectDetail, *api.Service) {
	for _, p := range f.projects {
		for i, s := range p.Services {
			if s.ID == id {
				return p, &p.Services[i]
			}
		}
	}
	return nil, nil
}

func (f *Fake) discardChangeSet(w http.ResponseWriter, r *http.Request) {
	cs := f.findChangeSet(w, r.PathValue("changeSetId"))
	if cs == nil {
		return
	}
	var in api.DiscardChangeSetInput
	if decode(r, &in) != nil {
		apiError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}
	if cs.Status != api.ChangeSetOpen {
		apiError(w, http.StatusConflict, "conflict", "The change set is "+cs.Status)
		return
	}
	if in.ExpectedRevision != 0 && in.ExpectedRevision != cs.Revision {
		apiError(w, http.StatusConflict, "change_set_changed",
			fmt.Sprintf("The change set changed since you reviewed it; it is at revision %d. Reload and review again", cs.Revision))
		return
	}
	cs.Status = api.ChangeSetDiscarded
	cs.bump()
	writeJSON(w, http.StatusOK, cs.ChangeSet)
}
