package apitest

import (
	"cmp"
	"net/http"
	"regexp"
	"slices"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
)

// previewState is the fake's pull request previews.
type previewState struct {
	previews []*api.Preview
	// onApprove runs on every approve request before the head is
	// compared, under the lock, so tests can push to the PR in between.
	onApprove func(p *api.Preview)
}

func (f *Fake) previewState() *previewState {
	if f.previews == nil {
		f.previews = &previewState{}
	}
	return f.previews
}

// AddPreview stores a preview of the seeded project; ID, project,
// services and timestamps are filled in when empty. It returns the ID.
func (f *Fake) AddPreview(p api.Preview) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if p.ID == "" {
		p.ID = f.nextID("prv")
	}
	p.ProjectID = cmp.Or(p.ProjectID, ProjectID)
	p.RepoFullName = cmp.Or(p.RepoFullName, "acme/shop")
	p.Status = cmp.Or(p.Status, api.PreviewActive)
	p.AuthorAssociation = cmp.Or(p.AuthorAssociation, "CONTRIBUTOR")
	if p.Services == nil {
		p.Services = []api.PreviewService{}
	}
	p.LastActivityAt = cmp.Or(p.LastActivityAt, Now)
	p.CreatedAt = cmp.Or(p.CreatedAt, p.LastActivityAt)
	p.UpdatedAt = cmp.Or(p.UpdatedAt, p.LastActivityAt)
	s := f.previewState()
	s.previews = append(s.previews, &p)
	return p.ID
}

// Previews returns copies of the stored previews.
func (f *Fake) Previews() []api.Preview {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []api.Preview
	for _, p := range f.previewState().previews {
		out = append(out, *p)
	}
	return out
}

// OnApprovePreview runs h on every approve request, under the lock, before
// the request's head_sha is compared with the preview's head.
func (f *Fake) OnApprovePreview(h func(p *api.Preview)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.previewState().onApprove = h
}

// previewProjectOf returns the project of a preview route's preview, for
// token workspace checks. Must hold f.mu.
func (f *Fake) previewProjectOf(r *http.Request) string {
	id := r.PathValue("previewId")
	if id == "" || f.previews == nil {
		return ""
	}
	for _, p := range f.previews.previews {
		if p.ID == id {
			return p.ProjectID
		}
	}
	return ""
}

func (f *Fake) previewRoutes(handlers map[api.Route]guarded) {
	handlers[api.RouteListPreviews] = guarded{"projects:read", f.listPreviews}
	handlers[api.RouteGetPreview] = guarded{"projects:read", f.getPreview}
	handlers[api.RouteApprovePreview] = guarded{"previews:manage", f.approvePreview}
	handlers[api.RouteRedeployPreview] = guarded{"deployments:create", f.redeployPreview}
	handlers[api.RouteDeletePreview] = guarded{"environments:manage", f.deletePreview}
}

func (f *Fake) findPreview(w http.ResponseWriter, id string) *api.Preview {
	for _, p := range f.previewState().previews {
		if p.ID == id {
			return p
		}
	}
	apiError(w, http.StatusNotFound, "not_found", "Preview not found")
	return nil
}

func (f *Fake) listPreviews(w http.ResponseWriter, r *http.Request) {
	if f.project(w, r.PathValue("projectId")) == nil {
		return
	}
	status := cmp.Or(r.URL.Query().Get("status"), "open")
	if status != "open" && status != "all" {
		apiError(w, http.StatusBadRequest, "invalid_request", "status: Invalid enum value")
		return
	}
	out := []api.Preview{}
	for _, p := range f.previewState().previews {
		if p.ProjectID != r.PathValue("projectId") {
			continue
		}
		if status == "open" && (p.Status == api.PreviewClosed || p.Status == api.PreviewExpired) {
			continue
		}
		out = append(out, *p)
	}
	slices.SortStableFunc(out, func(a, b api.Preview) int { return cmp.Compare(b.LastActivityAt, a.LastActivityAt) })
	writeJSON(w, http.StatusOK, map[string]any{"previews": out})
}

func (f *Fake) getPreview(w http.ResponseWriter, r *http.Request) {
	if p := f.findPreview(w, r.PathValue("previewId")); p != nil {
		writeJSON(w, http.StatusOK, p)
	}
}

var shaPattern = regexp.MustCompile(`^([a-f0-9]{40}|[a-f0-9]{64})$`)

// approvePreview mirrors the API: the approver's head_sha must still be the
// PR's head, and only a preview pending approval can be approved.
func (f *Fake) approvePreview(w http.ResponseWriter, r *http.Request) {
	p := f.findPreview(w, r.PathValue("previewId"))
	if p == nil {
		return
	}
	var in api.ApprovePreviewInput
	if decode(r, &in) != nil || !shaPattern.MatchString(in.HeadSHA) {
		apiError(w, http.StatusBadRequest, "invalid_request", "head_sha: Invalid")
		return
	}
	if h := f.previewState().onApprove; h != nil {
		h(p)
	}
	if p.Status != api.PreviewPendingApproval {
		apiError(w, http.StatusConflict, "conflict", "This preview is not waiting for approval")
		return
	}
	if in.HeadSHA != p.HeadSHA {
		apiError(w, http.StatusConflict, "head_moved", "The pull request has new commits; review them and approve again")
		return
	}
	p.Status, p.ApprovedSHA, p.ApprovedByLogin, p.UpdatedAt = api.PreviewCreating, str(in.HeadSHA), str("ada"), Now
	writeJSON(w, http.StatusOK, p)
}

func (f *Fake) redeployPreview(w http.ResponseWriter, r *http.Request) {
	p := f.findPreview(w, r.PathValue("previewId"))
	if p == nil {
		return
	}
	if p.Status != api.PreviewActive {
		apiError(w, http.StatusConflict, "conflict", "Only an active preview can be redeployed")
		return
	}
	for i := range p.Services {
		p.Services[i].DeploymentID = str(f.nextID("dep"))
		p.Services[i].Status = str("queued")
		p.Services[i].CommitSHA = str(p.HeadSHA)
	}
	p.UpdatedAt = Now
	writeJSON(w, http.StatusOK, p)
}

func (f *Fake) deletePreview(w http.ResponseWriter, r *http.Request) {
	p := f.findPreview(w, r.PathValue("previewId"))
	if p == nil {
		return
	}
	p.Status, p.EnvironmentID, p.EnvironmentSlug, p.ClosedAt, p.ExpiresAt, p.UpdatedAt = api.PreviewClosed, nil, nil, i64(Now), nil, Now
	for i := range p.Services {
		p.Services[i].URL = nil
	}
	writeJSON(w, http.StatusOK, p)
}

// WithholdVariable turns a stored variable into a preview placeholder, as
// creating a preview does with a secret or a value derived from one: its
// value becomes empty and it is listed as withheld.
func (f *Fake) WithholdVariable(scopeID, envID, key string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if v, ok := f.vars[varKey(scopeID, envID)][key]; ok {
		v.value, v.withheld = "", true
	}
}
