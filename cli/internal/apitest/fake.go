// Package apitest is an in-memory fake of the control plane for tests: the
// REST routes the CLI calls, Better Auth sign-in and sign-out, and the
// project realtime socket.
//
// Responses use the CLI's wire types, whose fields are checked against the
// API's OpenAPI document, and the fake enforces the API's request rules that
// matter to a client: session cookies, the same-origin guard on /v1
// mutations, Better Auth's Origin check on cookie-bearing POSTs, the Origin
// check on the realtime upgrade, and `${{…}}` syntax validation.
package apitest

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"unicode/utf16"

	"github.com/coder/websocket"

	"github.com/BankkRoll/Open-Rail/cli/internal/api"
	"github.com/BankkRoll/Open-Rail/cli/internal/varref"
)

// Seed data, fixed so golden files are stable.
const (
	Email         = "ada@example.com"
	Password      = "correct horse battery"
	SessionToken  = "sess_0123456789abcdef.SIGNATURE%2Babc%3D"
	WorkspaceID   = "ws_acme"
	ProjectID     = "prj_shop"
	ProductionID  = "env_prod"
	StagingID     = "env_staging"
	APIServiceID  = "svc_api"
	DBServiceID   = "svc_db"
	ActiveDeploy  = "dep_0003"
	BuildID       = "bld_0003"
	Now           = int64(1792670400000) // 2026-10-22T12:00:00Z
	CookieName    = "better-auth.session_token"
	SecretValue   = "s3cr3t-hunter2-value"
	NodeID        = "node_0001"
	JoinToken     = "njt_secret_join_token"
	InstallScript = "curl -fsSL http://127.0.0.1/install.sh | sudo bash -s -- --token njt_secret_join_token"
)

// Request is one request the fake received.
type Request struct {
	Method string
	// Pattern is the matched route, e.g. "GET /v1/projects/{projectId}".
	Pattern string
	Path    string
	Query   string
	Header  http.Header
	Body    string
}

type variable struct {
	value   string
	secret  bool
	version int
}

// Fake is a running fake control plane.
type Fake struct {
	Server *httptest.Server
	URL    string

	mu          sync.Mutex
	sessions    map[string]bool
	user        api.User
	workspaces  []api.Membership
	projects    map[string]*api.ProjectDetail
	configs     map[string]*api.ServiceConfig
	vars        map[string]map[string]*variable
	deployments []*api.DeploymentDetail
	logs        map[string][]api.LogEntry
	domains     []api.Domain
	nodes       []api.Node
	requests    []Request
	reveals     [][]string
	seq         int

	// OnGetDeployment runs on every GET of a deployment, under the lock,
	// so tests can advance its status between polls.
	OnGetDeployment func(d *api.DeploymentDetail)

	hub *hub
}

// New starts a fake seeded with one user, workspace, project with two
// environments, two services, variables, deployments, logs, domains and a
// server. It is closed when the test ends.
func New(t testing.TB) *Fake {
	f := &Fake{
		sessions: map[string]bool{},
		projects: map[string]*api.ProjectDetail{},
		configs:  map[string]*api.ServiceConfig{},
		vars:     map[string]map[string]*variable{},
		logs:     map[string][]api.LogEntry{},
		hub:      newHub(),
	}
	f.seed()
	mux := http.NewServeMux()
	f.routes(mux)
	f.Server = httptest.NewServer(f.record(mux))
	f.URL = f.Server.URL
	t.Cleanup(func() {
		f.hub.closeAll()
		f.Server.Close()
	})
	return f
}

func str(s string) *string { return &s }
func i64(n int64) *int64   { return &n }

func (f *Fake) seed() {
	f.user = api.User{ID: "usr_ada", Name: "Ada Lovelace", Email: Email}
	f.workspaces = []api.Membership{{ID: WorkspaceID, Name: "Acme", Slug: "acme", Role: "owner", MemberID: "mem_ada"}}
	envs := []api.Environment{
		{ID: ProductionID, ProjectID: ProjectID, Name: "production", Slug: "production", Kind: "production", CreatedAt: Now - 86400000},
		{ID: StagingID, ProjectID: ProjectID, Name: "staging", Slug: "staging", Kind: "staging", CreatedAt: Now - 86400000},
	}
	services := []api.Service{
		{ID: APIServiceID, ProjectID: ProjectID, Name: "API", Slug: "api", Kind: "app", CreatedAt: Now - 86400000, UpdatedAt: Now - 86400000},
		{ID: DBServiceID, ProjectID: ProjectID, Name: "Postgres", Slug: "db", Kind: "database", CreatedAt: Now - 86400000, UpdatedAt: Now - 86400000},
	}
	f.projects[ProjectID] = &api.ProjectDetail{
		Project:      api.Project{ID: ProjectID, WorkspaceID: WorkspaceID, Name: "Shop", Slug: "shop", Description: str("Storefront"), CreatedAt: Now - 86400000, UpdatedAt: Now - 86400000},
		Environments: envs,
		Services:     services,
	}
	port, dbPort := 8080, 5432
	for _, e := range envs {
		f.configs[APIServiceID+"/"+e.ID] = config(APIServiceID, e.ID, api.ServiceSource{Type: "git", RepoURL: "https://github.com/acme/shop", Branch: "main", RootDir: "."}, &port)
		f.configs[DBServiceID+"/"+e.ID] = config(DBServiceID, e.ID, api.ServiceSource{Type: "image", Image: "postgres:17"}, &dbPort)
	}
	f.vars[varKey(APIServiceID, ProductionID)] = map[string]*variable{
		"NODE_ENV":     {value: "production", version: 1},
		"DATABASE_URL": {value: "postgres://app:${{db.POSTGRES_PASSWORD}}@${{db.OPENRAIL_PRIVATE_DOMAIN}}:${{db.PORT}}/shop", version: 2},
		"API_KEY":      {value: SecretValue, secret: true, version: 1},
		"REGION":       {value: "${{shared.REGION}}", version: 1},
		"LISTEN":       {value: "0.0.0.0:${{PORT}}", version: 1},
	}
	f.vars[varKey(DBServiceID, ProductionID)] = map[string]*variable{
		"POSTGRES_PASSWORD": {value: "pg-secret-password", secret: true, version: 1},
		"UNUSED_SECRET":     {value: "never-revealed", secret: true, version: 1},
	}
	f.vars[varKey(ProjectID, ProductionID)] = map[string]*variable{
		"REGION": {value: "eu-west", version: 1},
	}
	build := &api.Build{ID: BuildID, DeploymentID: ActiveDeploy, ServiceID: APIServiceID, CommitSHA: strings.Repeat("a", 40),
		CommitMessage: str("Add checkout"), CommitAuthor: str("ada"), Status: "succeeded", ImageRepository: "127.0.0.1:5000/prj_shop/svc_api",
		ImageDigest: str("sha256:" + strings.Repeat("b", 64)), StartedAt: i64(Now - 3500000), FinishedAt: i64(Now - 3400000), CreatedAt: Now - 3600000}
	f.deployments = []*api.DeploymentDetail{
		f.deployment("dep_0001", "removed", Now-7200000, nil),
		f.deployment("dep_0002", "failed", Now-5400000, nil),
		f.deployment(ActiveDeploy, "active", Now-3600000, build),
	}
	f.deployments[1].FailureReason = str("Health check timed out")
	f.deployments[2].Events = []api.DeploymentEvent{
		{ID: "dev_0001", DeploymentID: ActiveDeploy, Type: "build_started", Message: "Build started", CreatedAt: Now - 3500000},
		{ID: "dev_0002", DeploymentID: ActiveDeploy, Type: "rollout_finished", Message: "All replicas healthy", CreatedAt: Now - 3300000},
	}
	f.deployments[2].Placements = []api.Placement{{ID: "plc_1", DeploymentID: ActiveDeploy, NodeID: NodeID, NodeName: str("edge-1"), WorkloadID: "wl_0001", State: "healthy"}}
	f.seq = 3
	var runtime []api.LogEntry
	for i := range 250 {
		stream := "stdout"
		if i%50 == 49 {
			stream = "stderr"
		}
		runtime = append(runtime, api.LogEntry{TS: Now - int64(250-i)*1000, Stream: stream, Text: fmt.Sprintf("request %03d", i), WorkloadID: "wl_0001"})
	}
	f.logs["dep:"+ActiveDeploy] = runtime
	f.logs["bld:"+BuildID] = []api.LogEntry{
		{TS: Now - 3500000, Stream: "system", Text: "Cloning https://github.com/acme/shop"},
		{TS: Now - 3450000, Stream: "stdout", Text: "Step 1/3: install"},
		{TS: Now - 3410000, Stream: "stderr", Text: "npm warn deprecated"},
	}
	f.domains = []api.Domain{
		{ID: "dom_0002", ServiceID: APIServiceID, EnvironmentID: ProductionID, Hostname: "shop.example.com", URL: "https://shop.example.com", Type: "custom", TargetPort: 8080, VerificationStatus: "verified", TLSStatus: "active", CreatedAt: Now - 1000},
		{ID: "dom_0001", ServiceID: APIServiceID, EnvironmentID: ProductionID, Hostname: "api-production-x7k2.apps.example.com", URL: "https://api-production-x7k2.apps.example.com", Type: "generated", TargetPort: 8080, VerificationStatus: "verified", TLSStatus: "active", CreatedAt: Now - 86400000},
		{ID: "dom_0003", ServiceID: APIServiceID, EnvironmentID: StagingID, Hostname: "api-staging-q9p1.apps.example.com", URL: "https://api-staging-q9p1.apps.example.com", Type: "generated", TargetPort: 8080, VerificationStatus: "verified", TLSStatus: "active", CreatedAt: Now - 86400000},
	}
	f.nodes = []api.Node{{ID: NodeID, Name: "edge-1", Hostname: str("edge-1"), Status: "online", Provider: "manual", PublicIP: str("203.0.113.10"),
		OS: str("linux"), Arch: str("amd64"), AgentVersion: str("0.4.0"), Capabilities: json.RawMessage(`{"docker":true,"builder":true}`),
		LastHeartbeatAt: i64(Now - 5000), CreatedAt: Now - 86400000}}
}

func config(serviceID, envID string, src api.ServiceSource, port *int) *api.ServiceConfig {
	return &api.ServiceConfig{
		ID: "cfg_" + serviceID + "_" + envID, ServiceID: serviceID, EnvironmentID: envID, Version: 1, CreatedAt: Now - 86400000, Source: src,
		Build:       json.RawMessage(`{"builder":"railpack","build_args":{}}`),
		Deploy:      json.RawMessage(`{"replicas":1,"restart_policy":"on_failure","max_retries":10,"drain_s":10}`),
		Resources:   json.RawMessage(`{"cpu_millis":1000,"memory_mb":512}`),
		Healthcheck: json.RawMessage(`null`), Networking: api.NetworkingConfig{Port: port, GeneratedDomain: true},
		Placement: json.RawMessage(`{"node_selector":{}}`),
	}
}

func (f *Fake) deployment(id, status string, created int64, build *api.Build) *api.DeploymentDetail {
	d := &api.DeploymentDetail{
		Deployment: api.Deployment{ID: id, ServiceID: APIServiceID, EnvironmentID: ProductionID, ConfigVersion: 1, Status: status,
			Trigger: "manual", TriggeredBy: str("usr_ada"), CreatedAt: created, UpdatedAt: created},
		Events: []api.DeploymentEvent{}, Placements: []api.Placement{},
	}
	if build != nil {
		d.BuildID, d.Build = &build.ID, build
	}
	return d
}

func varKey(scopeID, envID string) string { return scopeID + "/" + envID }

// -----------------------------------------------------------------------------
// Inspection
// -----------------------------------------------------------------------------

// Requests returns every request received so far.
func (f *Fake) Requests() []Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.requests)
}

// Reveals returns the key lists of every reveal call, in order.
func (f *Fake) Reveals() [][]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.reveals)
}

// Variable returns a stored variable's raw value and secret flag.
func (f *Fake) Variable(scopeID, envID, key string) (string, bool, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	v, ok := f.vars[varKey(scopeID, envID)][key]
	if !ok {
		return "", false, false
	}
	return v.value, v.secret, true
}

// Deployment returns a deployment by ID.
func (f *Fake) Deployment(id string) *api.DeploymentDetail {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, d := range f.deployments {
		if d.ID == id {
			return d
		}
	}
	return nil
}

// SessionValid reports whether the seeded session is still signed in.
func (f *Fake) SessionValid() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sessions[SessionToken]
}

// Login marks the seeded session signed in without going through sign-in.
func (f *Fake) Login() {
	f.mu.Lock()
	f.sessions[SessionToken] = true
	f.mu.Unlock()
}

// SetLogs replaces the log lines of a deployment ("dep:<id>") or build ("bld:<id>").
func (f *Fake) SetLogs(source string, lines []api.LogEntry) {
	f.mu.Lock()
	f.logs[source] = lines
	f.mu.Unlock()
}

// -----------------------------------------------------------------------------
// HTTP plumbing
// -----------------------------------------------------------------------------

func (f *Fake) record(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r = r.WithContext(context.WithValue(r.Context(), bodyKey{}, body))
		next.ServeHTTP(w, r)
		f.mu.Lock()
		f.requests = append(f.requests, Request{Method: r.Method, Pattern: r.Pattern, Path: r.URL.Path, Query: r.URL.RawQuery, Header: r.Header.Clone(), Body: string(body)})
		f.mu.Unlock()
	})
}

type bodyKey struct{}

func decode(r *http.Request, v any) error {
	body, _ := r.Context().Value(bodyKey{}).([]byte)
	return json.Unmarshal(body, v)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func apiError(w http.ResponseWriter, status int, code, message string, details ...api.ErrorDetail) {
	body := map[string]any{"code": code, "message": message}
	if len(details) > 0 {
		body["details"] = details
	}
	writeJSON(w, status, map[string]any{"error": body})
}

func (f *Fake) authed(r *http.Request) bool {
	ck, err := r.Cookie(CookieName)
	if err != nil {
		return false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sessions[ck.Value]
}

// guard applies the API's request rules before a /v1 handler.
func (f *Fake) guard(h func(http.ResponseWriter, *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Mirrors sameOriginMutations in apps/api/src/lib/guards.ts.
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
			origin, site := r.Header.Get("Origin"), r.Header.Get("Sec-Fetch-Site")
			if origin != "" && origin != f.URL || origin == "" && site != "" && site != "same-origin" && site != "none" {
				apiError(w, http.StatusForbidden, "forbidden", "Cross-origin request rejected")
				return
			}
		}
		if !f.authed(r) {
			apiError(w, http.StatusUnauthorized, "unauthorized", "Sign in to continue")
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		h(w, r)
	}
}

func (f *Fake) routes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/auth/sign-in/email", f.signIn)
	mux.HandleFunc("POST /api/auth/sign-out", f.signOut)
	handlers := map[api.Route]func(http.ResponseWriter, *http.Request){
		api.RouteMe:              f.me,
		api.RouteListProjects:    f.listProjects,
		api.RouteCreateProject:   f.createProject,
		api.RouteGetProject:      f.getProject,
		api.RouteDeleteProject:   f.deleteProject,
		api.RouteListServices:    f.listServices,
		api.RouteCreateService:   f.createService,
		api.RouteGetService:      f.getService,
		api.RouteDeleteService:   f.deleteService,
		api.RouteServiceConfig:   f.serviceConfig,
		api.RouteServiceVars:     f.listVars,
		api.RoutePutServiceVars:  f.putVars,
		api.RouteRevealService:   f.revealVars,
		api.RouteSharedVars:      f.listVars,
		api.RoutePutSharedVars:   f.putVars,
		api.RouteRevealShared:    f.revealVars,
		api.RouteListDeployments: f.listDeployments,
		api.RouteCreateDeploy:    f.createDeployment,
		api.RouteGetDeployment:   f.getDeployment,
		api.RouteRollback:        f.rollback,
		api.RouteCancel:          f.cancel,
		api.RouteDeploymentLogs:  f.getLogs,
		api.RouteBuildLogs:       f.getLogs,
		api.RouteListDomains:     f.listDomains,
		api.RouteListNodes:       f.listNodes,
		api.RouteJoinToken:       f.joinToken,
	}
	for route, h := range handlers {
		mux.HandleFunc(route.Method+" "+route.Path, f.guard(h))
	}
	mux.HandleFunc(api.RouteRealtime.Method+" "+api.RouteRealtime.Path, f.realtime)
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		apiError(w, http.StatusNotFound, "not_found", "No such endpoint")
	})
}

// -----------------------------------------------------------------------------
// Better Auth
// -----------------------------------------------------------------------------

// betterAuthOrigin mirrors Better Auth's CSRF check: a POST carrying a
// cookie must carry an Origin equal to a trusted origin.
func (f *Fake) betterAuthOrigin(w http.ResponseWriter, r *http.Request) bool {
	if r.Header.Get("Cookie") == "" && r.Header.Get("Origin") == "" {
		return true
	}
	if r.Header.Get("Origin") != f.URL {
		writeJSON(w, http.StatusForbidden, map[string]string{"code": "MISSING_OR_NULL_ORIGIN", "message": "Missing or null Origin"})
		return false
	}
	return true
}

func (f *Fake) signIn(w http.ResponseWriter, r *http.Request) {
	if !f.betterAuthOrigin(w, r) {
		return
	}
	var body struct{ Email, Password string }
	if decode(r, &body) != nil || body.Email != Email || body.Password != Password {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "INVALID_EMAIL_OR_PASSWORD", "message": "Invalid email or password"})
		return
	}
	f.mu.Lock()
	f.sessions[SessionToken] = true
	f.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: CookieName, Value: SessionToken, Path: "/", MaxAge: 604800, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	writeJSON(w, http.StatusOK, map[string]any{"redirect": false, "token": "sess_0123456789abcdef", "user": f.user})
}

func (f *Fake) signOut(w http.ResponseWriter, r *http.Request) {
	if !f.betterAuthOrigin(w, r) {
		return
	}
	if ck, err := r.Cookie(CookieName); err == nil {
		f.mu.Lock()
		delete(f.sessions, ck.Value)
		f.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: CookieName, Value: "", Path: "/", MaxAge: -1})
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// -----------------------------------------------------------------------------
// Workspaces, projects, services
// -----------------------------------------------------------------------------

func (f *Fake) nextID(prefix string) string {
	f.seq++
	return fmt.Sprintf("%s_%04d", prefix, f.seq)
}

func (f *Fake) me(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, api.Me{User: f.user, Workspaces: f.workspaces})
}

func (f *Fake) workspace(w http.ResponseWriter, r *http.Request) bool {
	if slices.ContainsFunc(f.workspaces, func(m api.Membership) bool { return m.ID == r.PathValue("workspaceId") }) {
		return true
	}
	apiError(w, http.StatusNotFound, "not_found", "Workspace not found")
	return false
}

func (f *Fake) listProjects(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	out := []api.Project{}
	for _, id := range slices.Sorted(mapKeys(f.projects)) {
		if p := f.projects[id]; p.WorkspaceID == r.PathValue("workspaceId") {
			out = append(out, p.Project)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": out})
}

var slugPattern = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(name string) string {
	return strings.Trim(slugPattern.ReplaceAllString(strings.ToLower(name), "-"), "-")
}

func (f *Fake) createProject(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	var in api.CreateProjectInput
	if decode(r, &in) != nil || strings.TrimSpace(in.Name) == "" {
		apiError(w, http.StatusBadRequest, "invalid_request", "name: Required")
		return
	}
	slug := in.Slug
	if slug == "" {
		slug = slugify(in.Name)
	}
	for _, p := range f.projects {
		if p.Slug == slug {
			apiError(w, http.StatusConflict, "conflict", "A project with slug "+slug+" exists")
			return
		}
	}
	id := f.nextID("prj")
	env := api.Environment{ID: f.nextID("env"), ProjectID: id, Name: "production", Slug: "production", Kind: "production", CreatedAt: Now}
	p := &api.ProjectDetail{
		Project:      api.Project{ID: id, WorkspaceID: r.PathValue("workspaceId"), Name: in.Name, Slug: slug, CreatedAt: Now, UpdatedAt: Now},
		Environments: []api.Environment{env}, Services: []api.Service{},
	}
	if in.Description != "" {
		p.Description = &in.Description
	}
	f.projects[id] = p
	writeJSON(w, http.StatusCreated, p)
}

func (f *Fake) project(w http.ResponseWriter, id string) *api.ProjectDetail {
	p, ok := f.projects[id]
	if !ok {
		apiError(w, http.StatusNotFound, "not_found", "Project not found")
	}
	return p
}

func (f *Fake) getProject(w http.ResponseWriter, r *http.Request) {
	if p := f.project(w, r.PathValue("projectId")); p != nil {
		writeJSON(w, http.StatusOK, p)
	}
}

func (f *Fake) deleteProject(w http.ResponseWriter, r *http.Request) {
	if p := f.project(w, r.PathValue("projectId")); p != nil {
		delete(f.projects, p.ID)
		w.WriteHeader(http.StatusNoContent)
	}
}

func (f *Fake) listServices(w http.ResponseWriter, r *http.Request) {
	if p := f.project(w, r.PathValue("projectId")); p != nil {
		writeJSON(w, http.StatusOK, map[string]any{"services": p.Services})
	}
}

func (f *Fake) createService(w http.ResponseWriter, r *http.Request) {
	p := f.project(w, r.PathValue("projectId"))
	if p == nil {
		return
	}
	var in api.CreateServiceInput
	if decode(r, &in) != nil || in.Name == "" || (in.Source.Type != "image" && in.Source.Type != "git") {
		apiError(w, http.StatusBadRequest, "invalid_request", "source: Invalid input")
		return
	}
	slug := in.Slug
	if slug == "" {
		slug = slugify(in.Name)
	}
	kind := in.Kind
	if kind == "" {
		kind = "app"
	}
	svc := api.Service{ID: f.nextID("svc"), ProjectID: p.ID, Name: in.Name, Slug: slug, Kind: kind, CreatedAt: Now, UpdatedAt: Now}
	p.Services = append(p.Services, svc)
	port := 8080
	if n, ok := in.Config["networking"].(map[string]any); ok {
		if v, ok := n["port"].(float64); ok {
			port = int(v)
		}
	}
	out := api.CreatedService{Service: svc}
	for _, e := range p.Environments {
		c := config(svc.ID, e.ID, in.Source, &port)
		f.configs[svc.ID+"/"+e.ID] = c
		out.Configs = append(out.Configs, *c)
	}
	writeJSON(w, http.StatusCreated, out)
}

// service finds a live service and its project.
func (f *Fake) service(w http.ResponseWriter, id string) (*api.ProjectDetail, *api.Service) {
	for _, p := range f.projects {
		for i, s := range p.Services {
			if s.ID == id {
				return p, &p.Services[i]
			}
		}
	}
	apiError(w, http.StatusNotFound, "not_found", "Service not found")
	return nil, nil
}

func (f *Fake) getService(w http.ResponseWriter, r *http.Request) {
	if _, s := f.service(w, r.PathValue("serviceId")); s != nil {
		writeJSON(w, http.StatusOK, s)
	}
}

func (f *Fake) deleteService(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	id := s.ID
	p.Services = slices.DeleteFunc(p.Services, func(x api.Service) bool { return x.ID == id })
	w.WriteHeader(http.StatusNoContent)
}

// environment checks the environment_id query against a project.
func environment(w http.ResponseWriter, r *http.Request, p *api.ProjectDetail, required bool) (string, bool) {
	id := r.URL.Query().Get("environment_id")
	if id == "" {
		if required {
			apiError(w, http.StatusBadRequest, "invalid_request", "environment_id: Required")
			return "", false
		}
		return "", true
	}
	if !slices.ContainsFunc(p.Environments, func(e api.Environment) bool { return e.ID == id }) {
		apiError(w, http.StatusNotFound, "not_found", "Environment not found")
		return "", false
	}
	return id, true
}

func (f *Fake) serviceConfig(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	env, ok := environment(w, r, p, true)
	if !ok {
		return
	}
	c, ok := f.configs[s.ID+"/"+env]
	if !ok {
		apiError(w, http.StatusNotFound, "not_found", "Service config not found")
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (f *Fake) listDomains(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	env, ok := environment(w, r, p, false)
	if !ok {
		return
	}
	out := []api.Domain{}
	for _, d := range f.domains {
		if d.ServiceID == s.ID && (env == "" || d.EnvironmentID == env) {
			out = append(out, d)
		}
	}
	slices.SortFunc(out, func(a, b api.Domain) int { return strings.Compare(a.Hostname, b.Hostname) })
	writeJSON(w, http.StatusOK, map[string]any{"domains": out})
}

// -----------------------------------------------------------------------------
// Variables
// -----------------------------------------------------------------------------

// varScope resolves a variables route to its scope key.
func (f *Fake) varScope(w http.ResponseWriter, r *http.Request) (string, bool) {
	var p *api.ProjectDetail
	scopeID := r.PathValue("serviceId")
	if scopeID != "" {
		if p, _ = f.service(w, scopeID); p == nil {
			return "", false
		}
	} else {
		scopeID = r.PathValue("projectId")
		if p = f.project(w, scopeID); p == nil {
			return "", false
		}
	}
	env, ok := environment(w, r, p, true)
	if !ok {
		return "", false
	}
	return varKey(scopeID, env), true
}

func (f *Fake) listed(key string) []api.Variable {
	out := []api.Variable{}
	vars := f.vars[key]
	for _, k := range slices.Sorted(mapKeys(vars)) {
		v := vars[k]
		item := api.Variable{Key: k, IsSecret: v.secret, Version: v.version, UpdatedAt: Now}
		if !v.secret {
			item.Value = str(v.value)
		}
		out = append(out, item)
	}
	return out
}

func (f *Fake) listVars(w http.ResponseWriter, r *http.Request) {
	if key, ok := f.varScope(w, r); ok {
		writeJSON(w, http.StatusOK, map[string]any{"variables": f.listed(key)})
	}
}

var keyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// utf16Offset converts a byte offset to UTF-16 code units, as the API counts.
func utf16Offset(s string, b int) int {
	return len(utf16.Encode([]rune(s[:b])))
}

func (f *Fake) putVars(w http.ResponseWriter, r *http.Request) {
	key, ok := f.varScope(w, r)
	if !ok {
		return
	}
	var in api.VariablesPut
	if decode(r, &in) != nil || len(in.Set) > 256 || len(in.Delete) > 256 {
		apiError(w, http.StatusBadRequest, "invalid_request", "invalid body")
		return
	}
	var details []api.ErrorDetail
	for _, s := range in.Set {
		if !keyPattern.MatchString(s.Key) {
			apiError(w, http.StatusBadRequest, "invalid_request", "set.key: expected a name like DATABASE_URL")
			return
		}
		_, errs := varref.Parse(s.Value)
		for _, e := range errs {
			start, end := utf16Offset(s.Value, e.Start), utf16Offset(s.Value, e.End)
			details = append(details, api.ErrorDetail{Field: s.Key, Code: e.Code, Message: e.Message, Start: &start, End: &end})
		}
	}
	if len(details) > 0 {
		d := details[0]
		apiError(w, http.StatusBadRequest, "invalid_reference", fmt.Sprintf("%s: %s (at %d-%d)", d.Field, d.Message, *d.Start, *d.End), details...)
		return
	}
	if f.vars[key] == nil {
		f.vars[key] = map[string]*variable{}
	}
	for _, s := range in.Set {
		v := f.vars[key][s.Key]
		if v == nil {
			v = &variable{}
			f.vars[key][s.Key] = v
		}
		v.value = s.Value
		v.version++
		if s.IsSecret != nil {
			v.secret = *s.IsSecret
		}
	}
	for _, k := range in.Delete {
		delete(f.vars[key], k)
	}
	writeJSON(w, http.StatusOK, map[string]any{"variables": f.listed(key)})
}

func (f *Fake) revealVars(w http.ResponseWriter, r *http.Request) {
	key, ok := f.varScope(w, r)
	if !ok {
		return
	}
	var in struct {
		Keys []string `json:"keys"`
	}
	if decode(r, &in) != nil || len(in.Keys) == 0 || len(in.Keys) > 256 {
		apiError(w, http.StatusBadRequest, "invalid_request", "keys: expected 1-256 keys")
		return
	}
	f.reveals = append(f.reveals, slices.Clone(in.Keys))
	out := []api.RevealedVariable{}
	for _, k := range in.Keys {
		if v, ok := f.vars[key][k]; ok {
			out = append(out, api.RevealedVariable{Key: k, Value: v.value})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"variables": out})
}

// -----------------------------------------------------------------------------
// Deployments and logs
// -----------------------------------------------------------------------------

func (f *Fake) listDeployments(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	env, ok := environment(w, r, p, true)
	if !ok {
		return
	}
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		limit, _ = strconv.Atoi(l)
	}
	cursor := r.URL.Query().Get("cursor")
	var all []api.Deployment
	for i := len(f.deployments) - 1; i >= 0; i-- {
		d := f.deployments[i]
		if d.ServiceID == s.ID && d.EnvironmentID == env && (cursor == "" || d.ID < cursor) {
			all = append(all, d.Deployment)
		}
	}
	page := api.DeploymentPage{Deployments: all[:min(limit, len(all))]}
	if page.Deployments == nil {
		page.Deployments = []api.Deployment{}
	}
	if len(all) > limit {
		page.NextCursor = str(page.Deployments[limit-1].ID)
	}
	writeJSON(w, http.StatusOK, page)
}

func (f *Fake) createDeployment(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	env, ok := environment(w, r, p, true)
	if !ok {
		return
	}
	d := f.deployment(f.nextID("dep"), "queued", Now, nil)
	d.ServiceID, d.EnvironmentID = s.ID, env
	f.deployments = append(f.deployments, d)
	writeJSON(w, http.StatusCreated, d.Deployment)
}

func (f *Fake) findDeployment(w http.ResponseWriter, id string) *api.DeploymentDetail {
	for _, d := range f.deployments {
		if d.ID == id {
			return d
		}
	}
	apiError(w, http.StatusNotFound, "not_found", "Deployment not found")
	return nil
}

func (f *Fake) getDeployment(w http.ResponseWriter, r *http.Request) {
	d := f.findDeployment(w, r.PathValue("deploymentId"))
	if d == nil {
		return
	}
	if f.OnGetDeployment != nil {
		f.OnGetDeployment(d)
	}
	writeJSON(w, http.StatusOK, d)
}

func (f *Fake) rollback(w http.ResponseWriter, r *http.Request) {
	src := f.findDeployment(w, r.PathValue("deploymentId"))
	if src == nil {
		return
	}
	if !api.IsRollbackSource(src.Status) {
		apiError(w, http.StatusConflict, "conflict", "Cannot roll back to a "+src.Status+" deployment")
		return
	}
	d := f.deployment(f.nextID("dep"), "queued", Now, nil)
	d.ServiceID, d.EnvironmentID, d.Trigger, d.RollbackOf = src.ServiceID, src.EnvironmentID, "rollback", &src.ID
	f.deployments = append(f.deployments, d)
	writeJSON(w, http.StatusCreated, d.Deployment)
}

func (f *Fake) cancel(w http.ResponseWriter, r *http.Request) {
	d := f.findDeployment(w, r.PathValue("deploymentId"))
	if d == nil {
		return
	}
	if !api.IsCancellable(d.Status) {
		apiError(w, http.StatusConflict, "conflict", "A "+d.Status+" deployment can't be cancelled")
		return
	}
	d.Status, d.FailureReason = "cancelled", str("Cancelled by a user")
	writeJSON(w, http.StatusOK, d.Deployment)
}

// getLogs pages backwards: no cursor is the newest page; the cursor is the
// index of the oldest line already returned.
func (f *Fake) getLogs(w http.ResponseWriter, r *http.Request) {
	source := "dep:" + r.PathValue("deploymentId")
	if id := r.PathValue("buildId"); id != "" {
		source = "bld:" + id
	}
	lines := f.logs[source]
	end := len(lines)
	if c := r.URL.Query().Get("cursor"); c != "" {
		end, _ = strconv.Atoi(c)
	}
	limit := 200
	if l := r.URL.Query().Get("limit"); l != "" {
		limit, _ = strconv.Atoi(l)
	}
	if limit < 1 || limit > 1000 {
		apiError(w, http.StatusBadRequest, "invalid_request", "limit: Number must be between 1 and 1000")
		return
	}
	start := max(0, end-limit)
	page := api.LogPage{Lines: slices.Clone(lines[start:end])}
	if page.Lines == nil {
		page.Lines = []api.LogEntry{}
	}
	if strings.HasPrefix(source, "bld:") {
		for i := range page.Lines {
			page.Lines[i].WorkloadID = ""
		}
	}
	if start > 0 {
		page.NextCursor = str(strconv.Itoa(start))
	}
	writeJSON(w, http.StatusOK, page)
}

// -----------------------------------------------------------------------------
// Servers
// -----------------------------------------------------------------------------

func (f *Fake) listNodes(w http.ResponseWriter, r *http.Request) {
	if f.workspace(w, r) {
		writeJSON(w, http.StatusOK, map[string]any{"nodes": f.nodes})
	}
}

func (f *Fake) joinToken(w http.ResponseWriter, r *http.Request) {
	if f.workspace(w, r) {
		writeJSON(w, http.StatusCreated, api.JoinToken{Token: JoinToken, ExpiresAt: Now + 3600000, InstallCommand: InstallScript})
	}
}

func mapKeys[V any](m map[string]V) func(func(string) bool) {
	return func(yield func(string) bool) {
		for k := range m {
			if !yield(k) {
				return
			}
		}
	}
}

// -----------------------------------------------------------------------------
// Realtime
// -----------------------------------------------------------------------------

// hub holds the open realtime sockets and their subscriptions.
type hub struct {
	mu      sync.Mutex
	clients map[*client]bool
	subs    chan string
}

type client struct {
	conn   *websocket.Conn
	mu     sync.Mutex
	topics map[string]bool
}

func newHub() *hub {
	return &hub{clients: map[*client]bool{}, subs: make(chan string, 64)}
}

func (h *hub) closeAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		_ = c.conn.CloseNow()
	}
}

// realtime mirrors apps/api/src/routes/realtime.ts: WebSocket upgrade only,
// Origin must equal the control plane's, session required.
func (f *Fake) realtime(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		apiError(w, http.StatusUpgradeRequired, "upgrade_required", "Expected a WebSocket upgrade")
		return
	}
	if r.Header.Get("Origin") != f.URL {
		apiError(w, http.StatusForbidden, "forbidden", "Cross-origin WebSocket rejected")
		return
	}
	if !f.authed(r) {
		apiError(w, http.StatusUnauthorized, "unauthorized", "Sign in to continue")
		return
	}
	f.mu.Lock()
	_, ok := f.projects[r.PathValue("projectId")]
	f.mu.Unlock()
	if !ok {
		apiError(w, http.StatusNotFound, "not_found", "Project not found")
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	c := &client{conn: conn, topics: map[string]bool{}}
	f.hub.mu.Lock()
	f.hub.clients[c] = true
	f.hub.mu.Unlock()
	defer func() {
		f.hub.mu.Lock()
		delete(f.hub.clients, c)
		f.hub.mu.Unlock()
		_ = conn.CloseNow()
	}()
	for {
		_, data, err := conn.Read(context.Background())
		if err != nil {
			return
		}
		var msg struct {
			Type  string            `json:"type"`
			Topic map[string]string `json:"topic"`
		}
		if json.Unmarshal(data, &msg) != nil || msg.Type != "subscribe" && msg.Type != "unsubscribe" {
			_ = conn.Close(websocket.StatusPolicyViolation, "invalid message")
			return
		}
		key := msg.Topic["kind"] + ":" + msg.Topic["deployment_id"] + msg.Topic["build_id"]
		c.mu.Lock()
		c.topics[key] = msg.Type == "subscribe"
		c.mu.Unlock()
		if msg.Type == "subscribe" {
			f.hub.subs <- key
		}
	}
}

// WaitSubscribed blocks until a socket subscribes to topic, e.g.
// "deployment_logs:dep_0003" or "build_logs:bld_0003".
func (f *Fake) WaitSubscribed(t testing.TB, topic string) {
	t.Helper()
	for key := range f.hub.subs {
		if key == topic {
			return
		}
	}
}

// Publish sends a message to every socket; log lines only reach sockets
// subscribed to their source, as in ProjectRoom.
func (f *Fake) Publish(msg api.RealtimeMessage) {
	data, _ := json.Marshal(msg)
	topic := ""
	if msg.Type == "log.lines" && msg.Source != nil {
		if msg.Source.Type == "build" {
			topic = "build_logs:" + msg.Source.BuildID
		} else {
			topic = "deployment_logs:" + msg.Source.DeploymentID
		}
	}
	f.hub.mu.Lock()
	defer f.hub.mu.Unlock()
	for c := range f.hub.clients {
		c.mu.Lock()
		subscribed := topic == "" || c.topics[topic]
		c.mu.Unlock()
		if subscribed {
			_ = c.conn.Write(context.Background(), websocket.MessageText, data)
		}
	}
}

// DropSockets closes every realtime socket abnormally, to test reconnects.
func (f *Fake) DropSockets() {
	f.hub.closeAll()
}
