package api

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
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
	RouteDeleteService   = Route{http.MethodDelete, "/v1/services/{serviceId}"}
	RouteServiceConfig   = Route{http.MethodGet, "/v1/services/{serviceId}/config"}
	RouteServiceVars     = Route{http.MethodGet, "/v1/services/{serviceId}/variables"}
	RoutePutServiceVars  = Route{http.MethodPut, "/v1/services/{serviceId}/variables"}
	RouteRevealService   = Route{http.MethodPost, "/v1/services/{serviceId}/variables/reveal"}
	RouteResolveVars     = Route{http.MethodPost, "/v1/services/{serviceId}/variables/resolve"}
	RouteSharedVars      = Route{http.MethodGet, "/v1/projects/{projectId}/variables"}
	RoutePutSharedVars   = Route{http.MethodPut, "/v1/projects/{projectId}/variables"}
	RouteRevealShared    = Route{http.MethodPost, "/v1/projects/{projectId}/variables/reveal"}
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
	RouteRealtime        = Route{http.MethodGet, "/v1/projects/{projectId}/realtime"}
	RouteListTokens      = Route{http.MethodGet, "/v1/workspaces/{workspaceId}/tokens"}
	RouteCreateToken     = Route{http.MethodPost, "/v1/workspaces/{workspaceId}/tokens"}
	RouteRevokeToken     = Route{http.MethodDelete, "/v1/workspaces/{workspaceId}/tokens/{tokenId}"}
)

// Better Auth routes. They are served by Better Auth's own router, outside
// the OpenAPI document.
var (
	RouteSignIn  = Route{http.MethodPost, "/api/auth/sign-in/email"}
	RouteSignOut = Route{http.MethodPost, "/api/auth/sign-out"}
)

// Routes lists every REST route in the OpenAPI document that the client calls.
var Routes = []Route{
	RouteMe, RouteListProjects, RouteCreateProject, RouteGetProject, RouteDeleteProject,
	RouteListServices, RouteCreateService, RouteGetService, RouteDeleteService, RouteServiceConfig,
	RouteServiceVars, RoutePutServiceVars, RouteRevealService, RouteResolveVars,
	RouteSharedVars, RoutePutSharedVars, RouteRevealShared,
	RouteListDeployments, RouteCreateDeploy, RouteGetDeployment, RouteRollback, RouteCancel,
	RouteDeploymentLogs, RouteBuildLogs, RouteListDomains, RouteListNodes, RouteJoinToken,
	RouteRealtime, RouteListTokens, RouteCreateToken, RouteRevokeToken,
}

// AuthRoutes lists the Better Auth routes the client calls.
var AuthRoutes = []Route{RouteSignIn, RouteSignOut}

func envQuery(environmentID string) url.Values {
	return url.Values{"environment_id": {environmentID}}
}

// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------

// SignInResult is the outcome of a successful sign-in.
type SignInResult struct {
	// Session is the session cookie to send on later requests.
	Session *http.Cookie
	User    User
}

// SignIn signs in with email and password. It sends no Origin header and no
// cookie, which Better Auth's CSRF check accepts for a first login.
func (c *Client) SignIn(ctx context.Context, email, password string) (*SignInResult, error) {
	var out struct {
		User User `json:"user"`
	}
	body := map[string]any{"email": email, "password": password, "rememberMe": true}
	var cookies []*http.Cookie
	req := request{method: RouteSignIn.Method, path: RouteSignIn.Path, body: body, cookies: &cookies}
	if err := c.do(ctx, req, &out); err != nil {
		return nil, err
	}
	var session *http.Cookie
	for _, ck := range cookies {
		if IsSessionCookie(ck.Name) {
			session = ck
		}
	}
	if session == nil || session.Value == "" {
		return nil, &Error{Status: http.StatusBadGateway, Code: "no_session",
			Message: "sign-in succeeded but the control plane set no session cookie"}
	}
	return &SignInResult{Session: session, User: out.User}, nil
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

func (s VariableScope) routes() (list, put, reveal Route, id string) {
	if s.ServiceID != "" {
		return RouteServiceVars, RoutePutServiceVars, RouteRevealService, s.ServiceID
	}
	return RouteSharedVars, RoutePutSharedVars, RouteRevealShared, s.ProjectID
}

// ListVariables lists a scope's variables with secrets masked.
func (c *Client) ListVariables(ctx context.Context, scope VariableScope, environmentID string) ([]Variable, error) {
	list, _, _, id := scope.routes()
	var out struct {
		Variables []Variable `json:"variables"`
	}
	if err := c.call(ctx, list, envQuery(environmentID), nil, &out, id); err != nil {
		return nil, err
	}
	return out.Variables, nil
}

// PutVariables sets and deletes variables in one transaction and returns
// the scope's full masked list.
func (c *Client) PutVariables(ctx context.Context, scope VariableScope, environmentID string, in VariablesPut) ([]Variable, error) {
	_, put, _, id := scope.routes()
	if in.Set == nil {
		in.Set = []VariableSet{}
	}
	if in.Delete == nil {
		in.Delete = []string{}
	}
	var out struct {
		Variables []Variable `json:"variables"`
	}
	if err := c.call(ctx, put, envQuery(environmentID), in, &out, id); err != nil {
		return nil, err
	}
	return out.Variables, nil
}

// RevealVariables returns plaintext for keys. The control plane audits
// every reveal (keys only, never values).
func (c *Client) RevealVariables(ctx context.Context, scope VariableScope, environmentID string, keys []string) ([]RevealedVariable, error) {
	_, _, reveal, id := scope.routes()
	var out struct {
		Variables []RevealedVariable `json:"variables"`
	}
	if err := c.call(ctx, reveal, envQuery(environmentID), map[string]any{"keys": keys}, &out, id); err != nil {
		return nil, err
	}
	return out.Variables, nil
}

// ResolveVariables returns a service's environment exactly as a deployment
// in environmentID would get it, secrets in plaintext, resolved by the
// control plane's own resolver. The control plane audits every call.
func (c *Client) ResolveVariables(ctx context.Context, serviceID, environmentID string) ([]ResolvedVariable, error) {
	out, err := fetch[ResolvedVariables](ctx, c, RouteResolveVars, envQuery(environmentID), nil, serviceID)
	if err != nil {
		return nil, err
	}
	return out.Variables, nil
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
