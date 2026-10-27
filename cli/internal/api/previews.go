package api

import (
	"context"
	"net/http"
	"net/url"
)

// Pull request preview routes (ADR 0007). Previews are created by the
// GitHub webhook, never through the API.
var (
	RouteListPreviews    = Route{http.MethodGet, "/v1/projects/{projectId}/previews"}
	RouteGetPreview      = Route{http.MethodGet, "/v1/previews/{previewId}"}
	RouteApprovePreview  = Route{http.MethodPost, "/v1/previews/{previewId}/approve"}
	RouteRedeployPreview = Route{http.MethodPost, "/v1/previews/{previewId}/redeploy"}
	RouteDeletePreview   = Route{http.MethodDelete, "/v1/previews/{previewId}"}
)

// Preview statuses, from PREVIEW_STATUSES in packages/shared.
const (
	// PreviewPendingApproval is a fork PR waiting for a maintainer's
	// approval of its head before any of its code is built.
	PreviewPendingApproval = "pending_approval"
	PreviewForkDisabled    = "fork_disabled"
	PreviewQueuedLimit     = "queued_limit"
	PreviewCreating        = "creating"
	PreviewActive          = "active"
	PreviewFailed          = "failed"
	PreviewExpired         = "expired"
	PreviewClosed          = "closed"
)

// PreviewStatuses lists every preview status, in the API's order.
var PreviewStatuses = []string{PreviewPendingApproval, PreviewForkDisabled, PreviewQueuedLimit,
	PreviewCreating, PreviewActive, PreviewFailed, PreviewExpired, PreviewClosed}

// Preview is a pull request's preview of a project.
//
// SECURITY: the PR fields (title, refs, logins) are written by whoever
// opened the pull request, possibly from a fork; sanitise them before
// printing to a terminal.
type Preview struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	// EnvironmentID is nil while gated or queued, and after teardown.
	EnvironmentID   *string `json:"environment_id"`
	EnvironmentSlug *string `json:"environment_slug"`
	RepoFullName    string  `json:"repo_full_name"`
	PRNumber        int     `json:"pr_number"`
	PRURL           string  `json:"pr_url"`
	Title           string  `json:"title"`
	HeadRef         string  `json:"head_ref"`
	HeadSHA         string  `json:"head_sha"`
	// HeadRepoFullName is nil when the fork was deleted.
	HeadRepoFullName *string `json:"head_repo_full_name"`
	IsFork           bool    `json:"is_fork"`
	// Withheld means the preview's secrets were replaced by empty
	// placeholders.
	Withheld          bool    `json:"withheld"`
	AuthorLogin       string  `json:"author_login"`
	AuthorAssociation string  `json:"author_association"`
	Draft             bool    `json:"draft"`
	Status            string  `json:"status"`
	ApprovedSHA       *string `json:"approved_sha"`
	ApprovedByLogin   *string `json:"approved_by_login"`
	LastActivityAt    int64   `json:"last_activity_at"`
	ExpiresAt         *int64  `json:"expires_at"`
	ClosedAt          *int64  `json:"closed_at"`
	// Error says why creating failed; never a variable value or build
	// output.
	Error     *string          `json:"error"`
	Services  []PreviewService `json:"services"`
	CreatedAt int64            `json:"created_at"`
	UpdatedAt int64            `json:"updated_at"`
}

// PreviewService is one service of a preview: its link and latest
// deployment.
type PreviewService struct {
	ServiceID string `json:"service_id"`
	Slug      string `json:"slug"`
	Name      string `json:"name"`
	// URL is the public URL of its generated domain, if it has one.
	URL          *string `json:"url"`
	DeploymentID *string `json:"deployment_id"`
	Status       *string `json:"status"`
	CommitSHA    *string `json:"commit_sha"`
}

// ApprovePreviewInput is the body of POST /v1/previews/{previewId}/approve.
type ApprovePreviewInput struct {
	// HeadSHA is the head the approver was shown. The API answers 409
	// head_moved when the pull request has moved on since.
	HeadSHA string `json:"head_sha"`
}

// ListPreviews returns a project's previews, newest PR activity first: the
// open ones, or with all every preview including closed and expired ones.
func (c *Client) ListPreviews(ctx context.Context, projectID string, all bool) ([]Preview, error) {
	status := "open"
	if all {
		status = "all"
	}
	out, err := fetch[struct {
		Previews []Preview `json:"previews"`
	}](ctx, c, RouteListPreviews, url.Values{"status": {status}}, nil, projectID)
	if err != nil {
		return nil, err
	}
	return out.Previews, nil
}

// GetPreview returns one preview.
func (c *Client) GetPreview(ctx context.Context, previewID string) (*Preview, error) {
	return fetch[Preview](ctx, c, RouteGetPreview, nil, nil, previewID)
}

// ApprovePreview approves a fork PR's head, which must be headSHA; the
// preview is then created or deployed at it.
func (c *Client) ApprovePreview(ctx context.Context, previewID, headSHA string) (*Preview, error) {
	return fetch[Preview](ctx, c, RouteApprovePreview, nil, ApprovePreviewInput{HeadSHA: headSHA}, previewID)
}

// RedeployPreview deploys an active preview's git services again at the
// PR's head.
func (c *Client) RedeployPreview(ctx context.Context, previewID string) (*Preview, error) {
	return fetch[Preview](ctx, c, RouteRedeployPreview, nil, nil, previewID)
}

// DeletePreview tears a preview down: its deployments stop, its volumes are
// scheduled for deletion and it becomes closed.
func (c *Client) DeletePreview(ctx context.Context, previewID string) (*Preview, error) {
	return fetch[Preview](ctx, c, RouteDeletePreview, nil, nil, previewID)
}
