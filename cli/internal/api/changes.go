package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
)

// Change set routes (ADR 0006): staged changes reviewed and applied as one.
var (
	RouteListChangeSets   = Route{http.MethodGet, "/v1/environments/{environmentId}/change-sets"}
	RouteGetDraft         = Route{http.MethodGet, "/v1/environments/{environmentId}/draft"}
	RouteGetChangeSet     = Route{http.MethodGet, "/v1/change-sets/{changeSetId}"}
	RouteReviewChangeSet  = Route{http.MethodGet, "/v1/change-sets/{changeSetId}/diff"}
	RouteApplyChangeSet   = Route{http.MethodPost, "/v1/change-sets/{changeSetId}/apply"}
	RouteDiscardChangeSet = Route{http.MethodPost, "/v1/change-sets/{changeSetId}/discard"}
)

// Change set statuses.
const (
	ChangeSetOpen      = "open"
	ChangeSetApplying  = "applying"
	ChangeSetApplied   = "applied"
	ChangeSetDiscarded = "discarded"
	ChangeSetFailed    = "failed"
)

// ChangeSetStatuses lists every change set status, in the API's order.
var ChangeSetStatuses = []string{ChangeSetOpen, ChangeSetApplying, ChangeSetApplied, ChangeSetDiscarded, ChangeSetFailed}

// Staged change statuses.
const (
	StagedPending    = "pending"
	StagedConflicted = "conflicted"
	StagedApplied    = "applied"
)

// StagedChangeStatuses lists every staged change status, in the API's order.
var StagedChangeStatuses = []string{StagedPending, StagedConflicted, StagedApplied}

// Deploy modes of [ApplyChangeSetInput].
const (
	DeployAffected = "affected"
	DeployNone     = "none"
)

// ChangeSetError is why a change set's last apply stopped.
type ChangeSetError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ChangeSetSummary is a change set without its ops.
type ChangeSetSummary struct {
	ID            string `json:"id"`
	ProjectID     string `json:"project_id"`
	EnvironmentID string `json:"environment_id"`
	// Status is one of [ChangeSetStatuses].
	Status string `json:"status"`
	// IsDraft is set for the environment's shared dashboard draft.
	IsDraft bool    `json:"is_draft"`
	Source  string  `json:"source"`
	Title   *string `json:"title"`
	// Revision is bumped on every change to the set; applying and
	// discarding send it back as expected_revision.
	Revision        int     `json:"revision"`
	OpCount         int     `json:"op_count"`
	ConflictedCount int     `json:"conflicted_count"`
	CreatedBy       *string `json:"created_by"`
	// CreatedByToken is the API token that proposed the set, if any.
	CreatedByToken *string         `json:"created_by_token"`
	AppliedBy      *string         `json:"applied_by"`
	AppliedAt      *int64          `json:"applied_at"`
	Error          *ChangeSetError `json:"error"`
	CreatedAt      int64           `json:"created_at"`
	UpdatedAt      int64           `json:"updated_at"`
}

// ChangeSet is a change set with its ops in apply order.
type ChangeSet struct {
	ChangeSetSummary
	Changes []StagedChange `json:"changes"`
}

// StagedChange is one op of a change set.
type StagedChange struct {
	ID        string `json:"id"`
	Seq       int    `json:"seq"`
	TargetKey string `json:"target_key"`
	// Op is the staged op, a union keyed by its "type". A staged variable
	// carries its fingerprint, never its value.
	Op json.RawMessage `json:"op"`
	// Summary is a value-free one-liner, e.g. "set api.DATABASE_URL".
	Summary string      `json:"summary"`
	Diff    []DiffEntry `json:"diff"`
	// Status is one of [StagedChangeStatuses].
	Status    string          `json:"status"`
	Conflict  *StagedConflict `json:"conflict"`
	CreatedBy *string         `json:"created_by"`
	CreatedAt int64           `json:"created_at"`
	UpdatedAt int64           `json:"updated_at"`
}

// DiffEntry is one changed value: a JSON pointer and both sides. A
// variable's sides are {tier, fingerprint} or null, never its value; a
// secret build arg's are {masked: true}.
type DiffEntry struct {
	Path   string          `json:"path"`
	Before json.RawMessage `json:"before"`
	After  json.RawMessage `json:"after"`
}

// StagedConflict is why an op can't apply as staged.
type StagedConflict struct {
	Theirs         json.RawMessage `json:"theirs,omitempty"`
	Paths          []string        `json:"paths,omitempty"`
	BaseVersion    *int            `json:"base_version"`
	CurrentVersion *int            `json:"current_version"`
	// Deleted is set when the op's target no longer exists.
	Deleted bool `json:"deleted,omitempty"`
}

// ChangeSetConflict names a conflicted op in a [ChangeSetReview].
type ChangeSetConflict struct {
	ID       string         `json:"id"`
	Conflict StagedConflict `json:"conflict"`
}

// PlannedDeploy is a service an apply would deploy, and why.
type PlannedDeploy struct {
	// Service is a service ID, or "new:<n>" for one the set creates.
	Service string `json:"service"`
	Name    string `json:"name"`
	// Reason is config, variables, created or references.
	Reason string `json:"reason"`
}

// ChangeSetReview is a change set checked against the current state.
type ChangeSetReview struct {
	ChangeSet ChangeSet `json:"change_set"`
	// Rebases are ops whose base drifted but merge cleanly.
	Rebases []string `json:"rebases"`
	// Conflicts are ops that need a decision before the set can apply.
	Conflicts []ChangeSetConflict `json:"conflicts"`
	// Deploys is what applying with [DeployAffected] would start.
	Deploys []PlannedDeploy `json:"deploys"`
}

// ApplyChangeSetInput is the body of POST /v1/change-sets/{id}/apply.
type ApplyChangeSetInput struct {
	// ExpectedRevision is the revision the caller reviewed; the API answers
	// 409 change_set_changed when the set moved on since.
	ExpectedRevision int `json:"expected_revision"`
	// Deploy is [DeployAffected] or [DeployNone].
	Deploy string `json:"deploy,omitempty"`
}

// DiscardChangeSetInput is the body of POST /v1/change-sets/{id}/discard.
type DiscardChangeSetInput struct {
	// ExpectedRevision, when set, refuses the discard if the set changed.
	ExpectedRevision int `json:"expected_revision,omitempty"`
}

// SkippedDeploy is an affected service an apply did not deploy.
type SkippedDeploy struct {
	ServiceID string `json:"service_id"`
	Reason    string `json:"reason"`
}

// AppliedChangeSet is the response of the apply route.
type AppliedChangeSet struct {
	ChangeSet     ChangeSet       `json:"change_set"`
	DeploymentIDs []string        `json:"deployment_ids"`
	Skipped       []SkippedDeploy `json:"skipped"`
}

// ListChangeSets lists an environment's change sets, newest first: the
// open ones, or every one when all is set.
func (c *Client) ListChangeSets(ctx context.Context, environmentID string, all bool) ([]ChangeSetSummary, error) {
	status := "open"
	if all {
		status = "all"
	}
	var out struct {
		ChangeSets []ChangeSetSummary `json:"change_sets"`
	}
	if err := c.call(ctx, RouteListChangeSets, url.Values{"status": {status}}, nil, &out, environmentID); err != nil {
		return nil, err
	}
	return out.ChangeSets, nil
}

// Draft returns an environment's shared dashboard draft, or nil when
// nothing is staged.
func (c *Client) Draft(ctx context.Context, environmentID string) (*ChangeSet, error) {
	var out struct {
		ChangeSet *ChangeSet `json:"change_set"`
	}
	if err := c.call(ctx, RouteGetDraft, nil, nil, &out, environmentID); err != nil {
		return nil, err
	}
	return out.ChangeSet, nil
}

// GetChangeSet returns a change set with its ops and value-free diffs.
func (c *Client) GetChangeSet(ctx context.Context, changeSetID string) (*ChangeSet, error) {
	return fetch[ChangeSet](ctx, c, RouteGetChangeSet, nil, nil, changeSetID)
}

// ReviewChangeSet checks a change set against the current state without
// changing it: which ops rebase, which conflict, and what applying deploys.
func (c *Client) ReviewChangeSet(ctx context.Context, changeSetID string) (*ChangeSetReview, error) {
	return fetch[ChangeSetReview](ctx, c, RouteReviewChangeSet, nil, nil, changeSetID)
}

// ApplyChangeSet applies a change set exactly as reviewed. The API answers
// 409 change_set_changed or change_set_conflict (details name each
// conflicted op), and 422 invalid_references.
func (c *Client) ApplyChangeSet(ctx context.Context, changeSetID string, in ApplyChangeSetInput) (*AppliedChangeSet, error) {
	return fetch[AppliedChangeSet](ctx, c, RouteApplyChangeSet, nil, in, changeSetID)
}

// DiscardChangeSet throws a change set away.
func (c *Client) DiscardChangeSet(ctx context.Context, changeSetID string, in DiscardChangeSetInput) (*ChangeSet, error) {
	return fetch[ChangeSet](ctx, c, RouteDiscardChangeSet, nil, in, changeSetID)
}
