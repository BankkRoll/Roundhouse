package api

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// REST routes the client calls. Each must exist in the API's OpenAPI
// document with the same method; openapi_test.go checks that.
var (
	RouteMe              = Route{http.MethodGet, "/v1/me"}
	RouteListProjects    = Route{http.MethodGet, "/v1/workspaces/{workspaceId}/projects"}
	RouteCreateProject   = Route{http.MethodPost, "/v1/workspaces/{workspaceId}/projects"}
	RouteGetProject      = Route{http.MethodGet, "/v1/projects/{projectId}"}
	RouteDeleteProject   = Route{http.MethodDelete, "/v1/projects/{projectId}"}
	RouteListServices    = Route{http.MethodGet, "/v1/projects/{projectId}/services"}
	RouteCreateService   = Route{http.MethodPost, "/v1/projects/{projectId}/services"}
	RouteGetService      = Route{http.MethodGet, "/v1/services/{serviceId}"}
	RouteUpdateService   = Route{http.MethodPatch, "/v1/services/{serviceId}"}
	RouteDeleteService   = Route{http.MethodDelete, "/v1/services/{serviceId}"}
	RouteServiceConfig   = Route{http.MethodGet, "/v1/services/{serviceId}/config"}
	RouteServiceVars     = Route{http.MethodGet, "/v1/services/{serviceId}/variables"}
	RoutePutServiceVars  = Route{http.MethodPut, "/v1/services/{serviceId}/variables"}
	RouteResolveVars     = Route{http.MethodGet, "/v1/services/{serviceId}/variables/resolved"}
	RouteSharedVars      = Route{http.MethodGet, "/v1/projects/{projectId}/variables"}
	RoutePutSharedVars   = Route{http.MethodPut, "/v1/projects/{projectId}/variables"}
	RouteListDeployments = Route{http.MethodGet, "/v1/services/{serviceId}/deployments"}
	RouteCreateDeploy    = Route{http.MethodPost, "/v1/services/{serviceId}/deployments"}
	RouteGetDeployment   = Route{http.MethodGet, "/v1/deployments/{deploymentId}"}
	RouteRollback        = Route{http.MethodPost, "/v1/deployments/{deploymentId}/rollback"}
	RouteCancel          = Route{http.MethodPost, "/v1/deployments/{deploymentId}/cancel"}
	RouteDeploymentLogs  = Route{http.MethodGet, "/v1/deployments/{deploymentId}/logs"}
	RouteBuildLogs       = Route{http.MethodGet, "/v1/builds/{buildId}/logs"}
	RouteListDomains     = Route{http.MethodGet, "/v1/services/{serviceId}/domains"}
	RouteListNodes       = Route{http.MethodGet, "/v1/workspaces/{workspaceId}/nodes"}
	RouteJoinToken       = Route{http.MethodPost, "/v1/workspaces/{workspaceId}/nodes/join-tokens"}
	RouteIntegrations    = Route{http.MethodGet, "/v1/workspaces/{workspaceId}/integrations"}
	RouteProviderOffers  = Route{http.MethodGet, "/v1/workspaces/{workspaceId}/providers/{provider}/offers"}
	RouteProvisionNode   = Route{http.MethodPost, "/v1/workspaces/{workspaceId}/nodes/provision"}
	RouteNodeProvision   = Route{http.MethodGet, "/v1/workspaces/{workspaceId}/node-provisions/{provisionId}"}
	RouteCancelProvision = Route{http.MethodPost, "/v1/workspaces/{workspaceId}/node-provisions/{provisionId}/cancel"}
	RouteRemoveNode      = Route{http.MethodDelete, "/v1/workspaces/{workspaceId}/nodes/{nodeId}"}
	RouteRealtime        = Route{http.MethodGet, "/v1/projects/{projectId}/realtime"}
	RouteListTokens      = Route{http.MethodGet, "/v1/workspaces/{workspaceId}/tokens"}
	RouteCreateToken     = Route{http.MethodPost, "/v1/workspaces/{workspaceId}/tokens"}
	RouteRevokeToken     = Route{http.MethodDelete, "/v1/workspaces/{workspaceId}/tokens/{tokenId}"}
	RouteListTemplates   = Route{http.MethodGet, "/v1/workspaces/{workspaceId}/templates"}
	RouteGetTemplate     = Route{http.MethodGet, "/v1/workspaces/{workspaceId}/templates/{templateId}"}
	RouteFromTemplate    = Route{http.MethodPost, "/v1/workspaces/{workspaceId}/projects/from-template"}
	RouteDeployTemplate  = Route{http.MethodPost, "/v1/projects/{projectId}/templates/deploy"}
)

// Better Auth routes. They are served by Better Auth's own router, outside
// the OpenAPI document.
var (
	RouteSignIn           = Route{http.MethodPost, "/api/auth/sign-in/email"}
	RouteSignOut          = Route{http.MethodPost, "/api/auth/sign-out"}
	RouteVerifyTOTP       = Route{http.MethodPost, "/api/auth/two-factor/verify-totp"}
	RouteVerifyBackupCode = Route{http.MethodPost, "/api/auth/two-factor/verify-backup-code"}
)

// Routes lists every REST route in the OpenAPI document that the client calls.
var Routes = []Route{
	RouteMe, RouteListProjects, RouteCreateProject, RouteGetProject, RouteDeleteProject,
	RouteListServices, RouteCreateService, RouteGetService, RouteUpdateService, RouteDeleteService, RouteServiceConfig,
	RouteServiceVars, RoutePutServiceVars, RouteResolveVars,
	RouteSharedVars, RoutePutSharedVars,
	RouteListDeployments, RouteCreateDeploy, RouteGetDeployment, RouteRollback, RouteCancel,
	RouteDeploymentLogs, RouteBuildLogs, RouteListDomains, RouteListNodes, RouteJoinToken,
	RouteAddDomain, RouteGetDomain, RouteUpdateDomain, RouteCheckDomain, RouteRemoveDomain,
	RouteIntegrations, RouteProviderOffers, RouteProvisionNode, RouteNodeProvision,
	RouteCancelProvision, RouteRemoveNode,
	RouteRealtime, RouteListTokens, RouteCreateToken, RouteRevokeToken,
	RouteListTemplates, RouteGetTemplate, RouteFromTemplate, RouteDeployTemplate,
	RouteListChangeSets, RouteGetDraft, RouteGetChangeSet, RouteReviewChangeSet,
	RouteApplyChangeSet, RouteDiscardChangeSet,
	RouteServiceMetrics, RouteMetricsSummary, RouteNodeMetrics,
	RouteCreateDatabase, RouteServiceVolume, RouteResizeVolume, RouteDeleteVolume, RouteUndeleteVolume,
	RouteDatabaseQuery, RouteDatabaseSchema,
	RouteBackupPolicy, RoutePutBackupPolicy, RouteListBackups, RouteCreateBackup, RouteGetBackup,
	RouteBackupDownload, RouteBackupKey, RouteRestoreBackup, RouteGetRestore,
	RouteCronState, RouteListCronRuns, RouteTriggerCron, RouteGetCronRun, RouteCronRunLogs,
	RouteCancelCronRun, RoutePauseCron, RouteResumeCron, RouteCronPreview,
}

// AuthRoutes lists the Better Auth routes the client calls.
var AuthRoutes = []Route{RouteSignIn, RouteSignOut, RouteVerifyTOTP, RouteVerifyBackupCode}

func envQuery(environmentID string) url.Values {
	return url.Values{"environment_id": {environmentID}}
}

// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------

// SignInResult is the outcome of a successful sign-in: a session, or, for an
// account with two-factor authentication, a challenge to answer with
// [Client.VerifySecondFactor].
type SignInResult struct {
	// Session is the session cookie to send on later requests; nil while
	// TwoFactor is set.
	Session *http.Cookie
	User    User
	// TwoFactor is set when the password was right and a code is needed.
	TwoFactor *TwoFactorChallenge
}

// TwoFactorChallenge is a sign-in waiting for its second factor: the
// short-lived challenge cookie the control plane set after the password.
type TwoFactorChallenge struct {
	cookies []*http.Cookie
}

// SignIn signs in with email and password. It sends no Origin header and no
// cookie, which Better Auth's CSRF check accepts for a first login.
func (c *Client) SignIn(ctx context.Context, email, password string) (*SignInResult, error) {
	var out struct {
		User              User `json:"user"`
		TwoFactorRedirect bool `json:"twoFactorRedirect"`
	}
	body := map[string]any{"email": email, "password": password, "rememberMe": true}
	var cookies []*http.Cookie
	req := request{method: RouteSignIn.Method, path: RouteSignIn.Path, body: body, cookies: &cookies}
	if err := c.do(ctx, req, &out); err != nil {
		return nil, err
	}
	if out.TwoFactorRedirect {
		var challenge []*http.Cookie
		for _, ck := range cookies {
			if ck.Value != "" && strings.HasSuffix(ck.Name, ".two_factor") {
				challenge = append(challenge, ck)
			}
		}
		if len(challenge) == 0 {
			return nil, &Error{Status: http.StatusBadGateway, Code: "no_challenge",
				Message: "the control plane asked for a two-factor code but set no challenge cookie"}
		}
		return &SignInResult{TwoFactor: &TwoFactorChallenge{cookies: challenge}}, nil
	}
	return sessionResult(cookies, out.User)
}

// IsTOTPCode reports whether a code looks like an authenticator code (six
// digits, spaces ignored) rather than a backup code.
func IsTOTPCode(code string) bool {
	digits := strings.ReplaceAll(strings.TrimSpace(code), " ", "")
	if len(digits) != 6 {
		return false
	}
	for _, r := range digits {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// VerifySecondFactor answers a two-factor challenge with an authenticator
// code or a backup code (told apart by [IsTOTPCode]) and returns the session.
// The challenge cookie makes this a cookie-bearing request, so it sends the
// control plane's Origin like [Client.SignOut].
func (c *Client) VerifySecondFactor(ctx context.Context, ch *TwoFactorChallenge, code string) (*SignInResult, error) {
	route := RouteVerifyBackupCode
	code = strings.TrimSpace(code)
	if IsTOTPCode(code) {
		route = RouteVerifyTOTP
		code = strings.ReplaceAll(code, " ", "")
	}
	var out struct {
		User User `json:"user"`
	}
	var cookies []*http.Cookie
	req := request{
		method: route.Method, path: route.Path, body: map[string]any{"code": code},
		origin: true, sendCookies: ch.cookies, cookies: &cookies,
	}
	if err := c.do(ctx, req, &out); err != nil {
		return nil, err
	}
	return sessionResult(cookies, out.User)
}

func sessionResult(cookies []*http.Cookie, user User) (*SignInResult, error) {
	var session *http.Cookie
	for _, ck := range cookies {
		if IsSessionCookie(ck.Name) && ck.Value != "" {
			session = ck
		}
	}
	if session == nil {
		return nil, &Error{Status: http.StatusBadGateway, Code: "no_session",
			Message: "sign-in succeeded but the control plane set no session cookie"}
	}
	return &SignInResult{Session: session, User: user}, nil
}

// SignOut revokes the current session.
//
// Better Auth checks the Origin of any cookie-bearing POST against its
// trusted origins, which is the control plane's own origin, so this request
// sends it.
func (c *Client) SignOut(ctx context.Context) error {
	return c.do(ctx, request{method: RouteSignOut.Method, path: RouteSignOut.Path, body: map[string]any{}, origin: true}, nil)
}

// -----------------------------------------------------------------------------
// Workspaces and projects
// -----------------------------------------------------------------------------

// Me returns the signed-in user and their workspaces.
func (c *Client) Me(ctx context.Context) (*Me, error) {
	return fetch[Me](ctx, c, RouteMe, nil, nil)
}

// ListProjects lists the live projects of a workspace.
func (c *Client) ListProjects(ctx context.Context, workspaceID string) ([]Project, error) {
	return c.listProjects(ctx, workspaceID, nil)
}

// ProjectBySlug returns the live project of a workspace with exactly this
// slug, or nil when there is none.
//
// NOTE: a control plane that predates the `slug` filter ignores it and
// returns every project, so the result is filtered here as well.
func (c *Client) ProjectBySlug(ctx context.Context, workspaceID, slug string) (*Project, error) {
	projects, err := c.listProjects(ctx, workspaceID, url.Values{"slug": {slug}})
	if err != nil {
		return nil, err
	}
	for i := range projects {
		if projects[i].Slug == slug {
			return &projects[i], nil
		}
	}
	return nil, nil
}

func (c *Client) listProjects(ctx context.Context, workspaceID string, q url.Values) ([]Project, error) {
	var out struct {
		Projects []Project `json:"projects"`
	}
	if err := c.call(ctx, RouteListProjects, q, nil, &out, workspaceID); err != nil {
		return nil, err
	}
	return out.Projects, nil
}

// CreateProject creates a project with a production environment.
func (c *Client) CreateProject(ctx context.Context, workspaceID string, in CreateProjectInput) (*ProjectDetail, error) {
	return fetch[ProjectDetail](ctx, c, RouteCreateProject, nil, in, workspaceID)
}

// GetProject returns a project with its environments and services.
func (c *Client) GetProject(ctx context.Context, projectID string) (*ProjectDetail, error) {
	return fetch[ProjectDetail](ctx, c, RouteGetProject, nil, nil, projectID)
}

// DeleteProject deletes a project and removes its workloads.
func (c *Client) DeleteProject(ctx context.Context, projectID string) error {
	return c.call(ctx, RouteDeleteProject, nil, nil, nil, projectID)
}

// -----------------------------------------------------------------------------
// Services
// -----------------------------------------------------------------------------

// ListServices lists a project's live services.
func (c *Client) ListServices(ctx context.Context, projectID string) ([]Service, error) {
	var out struct {
		Services []Service `json:"services"`
	}
	if err := c.call(ctx, RouteListServices, nil, nil, &out, projectID); err != nil {
		return nil, err
	}
	return out.Services, nil
}

// CreateService creates a service and its first config in every environment.
func (c *Client) CreateService(ctx context.Context, projectID string, in CreateServiceInput) (*CreatedService, error) {
	return fetch[CreatedService](ctx, c, RouteCreateService, nil, in, projectID)
}

// GetService returns a service.
func (c *Client) GetService(ctx context.Context, serviceID string) (*Service, error) {
	return fetch[Service](ctx, c, RouteGetService, nil, nil, serviceID)
}

// UpdateService changes a service or, with EnvironmentID, stores a new
// config version in that environment. A config change applies on the next
// deployment.
func (c *Client) UpdateService(ctx context.Context, serviceID string, in UpdateServiceInput) (*UpdatedService, error) {
	return fetch[UpdatedService](ctx, c, RouteUpdateService, nil, in, serviceID)
}

// DeleteService deletes a service and removes its workloads.
func (c *Client) DeleteService(ctx context.Context, serviceID string) error {
	return c.call(ctx, RouteDeleteService, nil, nil, nil, serviceID)
}

// ServiceConfig returns the latest config version of a service in an environment.
func (c *Client) ServiceConfig(ctx context.Context, serviceID, environmentID string) (*ServiceConfig, error) {
	return fetch[ServiceConfig](ctx, c, RouteServiceConfig, envQuery(environmentID), nil, serviceID)
}

// ListDomains lists a service's domains in an environment (all
// environments when environmentID is empty).
func (c *Client) ListDomains(ctx context.Context, serviceID, environmentID string) ([]Domain, error) {
	var q url.Values
	if environmentID != "" {
		q = envQuery(environmentID)
	}
	var out struct {
		Domains []Domain `json:"domains"`
	}
	if err := c.call(ctx, RouteListDomains, q, nil, &out, serviceID); err != nil {
		return nil, err
	}
	return out.Domains, nil
}

// -----------------------------------------------------------------------------
// Variables
// -----------------------------------------------------------------------------

// VariableScope selects a service's variables, or a project's shared ones.
type VariableScope struct {
	// ServiceID selects a service's variables.
	ServiceID string
	// ProjectID selects shared variables when ServiceID is empty.
	ProjectID string
}

func (s VariableScope) routes() (list, put Route, id string) {
	if s.ServiceID != "" {
		return RouteServiceVars, RoutePutServiceVars, s.ServiceID
	}
	return RouteSharedVars, RoutePutSharedVars, s.ProjectID
}

// ListVariables lists a scope's variables. Secret values are never returned,
// and plain ones only to callers with variables:read_plain.
func (c *Client) ListVariables(ctx context.Context, scope VariableScope, environmentID string) ([]Variable, error) {
	list, _, id := scope.routes()
	var out struct {
		Variables []Variable `json:"variables"`
	}
	if err := c.call(ctx, list, envQuery(environmentID), nil, &out, id); err != nil {
		return nil, err
	}
	return out.Variables, nil
}

// PutVariables sets and deletes variables in one transaction and returns the
// scope's full list with the classifier's warnings. Nothing is stored when
// the API refuses any entry.
func (c *Client) PutVariables(ctx context.Context, scope VariableScope, environmentID string, in VariablesPut) (*VariablesPutResult, error) {
	_, put, id := scope.routes()
	if in.Set == nil {
		in.Set = []VariableSet{}
	}
	if in.Delete == nil {
		in.Delete = []string{}
	}
	return fetch[VariablesPutResult](ctx, c, put, envQuery(environmentID), in, id)
}

// ResolveVariables returns a service's plain environment as a deployment in
// environmentID would get it, resolved by the control plane's own resolver,
// and the secret and secret-derived keys it leaves out. The control plane
// audits every call.
func (c *Client) ResolveVariables(ctx context.Context, serviceID, environmentID string) (*ResolvedVariables, error) {
	return fetch[ResolvedVariables](ctx, c, RouteResolveVars, envQuery(environmentID), nil, serviceID)
}

// -----------------------------------------------------------------------------
// Deployments and logs
// -----------------------------------------------------------------------------

// ListDeployments returns a page of a service's deployments, newest first.
func (c *Client) ListDeployments(ctx context.Context, serviceID, environmentID, cursor string, limit int) (*DeploymentPage, error) {
	q := envQuery(environmentID)
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	return fetch[DeploymentPage](ctx, c, RouteListDeployments, q, nil, serviceID)
}

// CreateDeployment deploys the latest config of a service in an environment.
func (c *Client) CreateDeployment(ctx context.Context, serviceID, environmentID string) (*Deployment, error) {
	return fetch[Deployment](ctx, c, RouteCreateDeploy, envQuery(environmentID), map[string]any{}, serviceID)
}

// GetDeployment returns a deployment with its events and placements.
func (c *Client) GetDeployment(ctx context.Context, deploymentID string) (*DeploymentDetail, error) {
	return fetch[DeploymentDetail](ctx, c, RouteGetDeployment, nil, nil, deploymentID)
}

// RollbackDeployment creates a deployment from an earlier one's image.
func (c *Client) RollbackDeployment(ctx context.Context, deploymentID string) (*Deployment, error) {
	return fetch[Deployment](ctx, c, RouteRollback, nil, nil, deploymentID)
}

// CancelDeployment cancels a queued, building or deploying deployment.
func (c *Client) CancelDeployment(ctx context.Context, deploymentID string) (*Deployment, error) {
	return fetch[Deployment](ctx, c, RouteCancel, nil, nil, deploymentID)
}

// LogSource selects a deployment's runtime logs or a build's logs.
type LogSource struct {
	DeploymentID string
	BuildID      string
}

// Logs returns a page of log lines. Without a cursor it is the newest page.
func (c *Client) Logs(ctx context.Context, src LogSource, cursor string, limit int) (*LogPage, error) {
	q := url.Values{}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	if src.BuildID != "" {
		return fetch[LogPage](ctx, c, RouteBuildLogs, q, nil, src.BuildID)
	}
	return fetch[LogPage](ctx, c, RouteDeploymentLogs, q, nil, src.DeploymentID)
}

// -----------------------------------------------------------------------------
// Servers
// -----------------------------------------------------------------------------

// ListNodes lists a workspace's servers.
func (c *Client) ListNodes(ctx context.Context, workspaceID string) ([]Node, error) {
	var out struct {
		Nodes []Node `json:"nodes"`
	}
	if err := c.call(ctx, RouteListNodes, nil, nil, &out, workspaceID); err != nil {
		return nil, err
	}
	return out.Nodes, nil
}

// CreateJoinToken mints a single-use join token and its install command.
func (c *Client) CreateJoinToken(ctx context.Context, workspaceID string) (*JoinToken, error) {
	return fetch[JoinToken](ctx, c, RouteJoinToken, nil, nil, workspaceID)
}

// ListIntegrations lists every cloud provider and whether the workspace is
// connected to it.
func (c *Client) ListIntegrations(ctx context.Context, workspaceID string) ([]ProviderIntegration, error) {
	var out struct {
		Integrations []ProviderIntegration `json:"integrations"`
	}
	if err := c.call(ctx, RouteIntegrations, nil, nil, &out, workspaceID); err != nil {
		return nil, err
	}
	return out.Integrations, nil
}

// ProviderOffers lists a connected provider's plans and regions with prices
// for role ("node" or "builder"), in one region when region is not empty.
func (c *Client) ProviderOffers(ctx context.Context, workspaceID, provider, role, region string) (*ProviderOffers, error) {
	q := url.Values{"role": {role}}
	if region != "" {
		q.Set("region", region)
	}
	return fetch[ProviderOffers](ctx, c, RouteProviderOffers, q, nil, workspaceID, provider)
}

// ProvisionNode starts creating a cloud server that joins the workspace on
// first boot. Poll the returned run with [Client.GetNodeProvision].
func (c *Client) ProvisionNode(ctx context.Context, workspaceID string, in ProvisionNodeInput) (*NodeProvision, error) {
	return fetch[NodeProvision](ctx, c, RouteProvisionNode, nil, in, workspaceID)
}

// GetNodeProvision returns one provisioning run.
func (c *Client) GetNodeProvision(ctx context.Context, workspaceID, provisionID string) (*NodeProvision, error) {
	return fetch[NodeProvision](ctx, c, RouteNodeProvision, nil, nil, workspaceID, provisionID)
}

// CancelNodeProvision cancels a provisioning run that has not finished. A
// queued or booting run comes back cancelled (or cleanup_failed); one still
// creating its server keeps its status, with CancelRequestedAt set, until
// the server exists and can be deleted. Repeating the call is harmless.
func (c *Client) CancelNodeProvision(ctx context.Context, workspaceID, provisionID string) (*NodeProvision, error) {
	return fetch[NodeProvision](ctx, c, RouteCancelProvision, nil, nil, workspaceID, provisionID)
}

// RemoveNode removes a server from the workspace and revokes its
// credential. For a server Roundhouse provisioned it also deletes the cloud
// server, unless keepServer is set.
func (c *Client) RemoveNode(ctx context.Context, workspaceID, nodeID string, keepServer bool) error {
	var q url.Values
	if keepServer {
		q = url.Values{"keep_server": {"true"}}
	}
	return c.call(ctx, RouteRemoveNode, q, nil, nil, workspaceID, nodeID)
}

// -----------------------------------------------------------------------------
// API tokens
// -----------------------------------------------------------------------------

// ListAPITokens lists a workspace's API tokens, newest first, revoked and
// expired ones included.
func (c *Client) ListAPITokens(ctx context.Context, workspaceID string) ([]APIToken, error) {
	var out struct {
		Tokens []APIToken `json:"tokens"`
	}
	if err := c.call(ctx, RouteListTokens, nil, nil, &out, workspaceID); err != nil {
		return nil, err
	}
	return out.Tokens, nil
}

// CreateAPIToken creates a token; the returned secret is never shown again.
func (c *Client) CreateAPIToken(ctx context.Context, workspaceID string, in CreateAPITokenInput) (*CreatedAPIToken, error) {
	return fetch[CreatedAPIToken](ctx, c, RouteCreateToken, nil, in, workspaceID)
}

// RevokeAPIToken revokes a token at once; revoking it again is a no-op.
func (c *Client) RevokeAPIToken(ctx context.Context, workspaceID, tokenID string) error {
	return c.call(ctx, RouteRevokeToken, nil, nil, nil, workspaceID, tokenID)
}

// -----------------------------------------------------------------------------
// Templates
// -----------------------------------------------------------------------------

// ListTemplates lists the built-in templates, in gallery order.
func (c *Client) ListTemplates(ctx context.Context, workspaceID string) ([]TemplateSummary, error) {
	var out struct {
		Templates []TemplateSummary `json:"templates"`
	}
	if err := c.call(ctx, RouteListTemplates, nil, nil, &out, workspaceID); err != nil {
		return nil, err
	}
	return out.Templates, nil
}

// GetTemplate returns a template with its inputs, services and variables.
// Secret and generated variables come without a value.
func (c *Client) GetTemplate(ctx context.Context, workspaceID, templateID string) (*TemplateDetail, error) {
	return fetch[TemplateDetail](ctx, c, RouteGetTemplate, nil, nil, workspaceID, templateID)
}

// CreateProjectFromTemplate creates a project with a production environment
// and the template's services. It answers 409 for a template that needs
// something the control plane lacks.
func (c *Client) CreateProjectFromTemplate(ctx context.Context, workspaceID string, in CreateProjectFromTemplateInput) (*TemplateDeployment, error) {
	if in.Inputs == nil {
		in.Inputs = map[string]string{}
	}
	return fetch[TemplateDeployment](ctx, c, RouteFromTemplate, nil, in, workspaceID)
}

// DeployTemplate adds a template's services to an existing project; its
// variables and first deployments go to in.EnvironmentID.
func (c *Client) DeployTemplate(ctx context.Context, projectID string, in DeployTemplateInput) (*TemplateDeployment, error) {
	if in.Inputs == nil {
		in.Inputs = map[string]string{}
	}
	return fetch[TemplateDeployment](ctx, c, RouteDeployTemplate, nil, in, projectID)
}

func (c *Client) call(ctx context.Context, r Route, q url.Values, in, out any, params ...string) error {
	return c.do(ctx, request{method: r.Method, path: r.expand(params...), query: q, body: in}, out)
}

// fetch calls a route and decodes its JSON response into a new T.
func fetch[T any](ctx context.Context, c *Client, r Route, q url.Values, in any, params ...string) (*T, error) {
	var out T
	if err := c.call(ctx, r, q, in, &out, params...); err != nil {
		return nil, err
	}
	return &out, nil
}
