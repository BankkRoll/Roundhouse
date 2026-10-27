// Package apitest is an in-memory fake of the control plane for tests: the
// REST routes the CLI calls, Better Auth sign-in and sign-out, and the
// project realtime socket. Cloud provider offers and provisioning runs are
// canned: tests connect providers and advance runs themselves.
//
// Responses use the CLI's wire types, whose fields are checked against the
// API's OpenAPI document, and the fake enforces the API's request rules that
// matter to a client: session cookies and their refresh, workspace API
// tokens with their workspace and scopes, the same-origin guard on /v1
// mutations, Better Auth's Origin check on cookie-bearing POSTs, the
// realtime socket's Origin check and close codes, slug suffixing,
// `${{…}}` syntax validation and resolution, and write-only secrets: tiers
// picked by a subset of the API's classifier, confirmations for keys
// becoming secret, and no route that returns a secret's value.
package apitest

import (
	"cmp"
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

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
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
	// TOTPCode is the authenticator code the fake accepts once two-factor is on.
	TOTPCode = "123456"
	// BackupCode is the fake's one backup code; it works once.
	BackupCode = "abcde-12345"
	// ChallengeCookie names the two-factor challenge cookie, as Better Auth does over HTTP.
	ChallengeCookie = "better-auth.two_factor"
	challengeValue  = "2fa-challenge.SIGNATURE"
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
	value     string
	secret    bool
	locked    bool
	build     bool
	file      bool
	version   int
	updatedBy string
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
	dns         map[string]DNSState
	// routingNodes are what new domains report as their routing_nodes; see
	// [Fake.SetRoutingNodes].
	routingNodes []api.DomainRoutingNode
	nodes        []api.Node
	providers    map[string]bool
	offers       []api.ProviderOffer
	provisions   []*api.NodeProvision
	requests     []Request
	seq          int
	tokens       []*apiToken
	tokenSeq     int
	changeSets   []*changeSet

	serviceMetrics map[string]ServiceMetricsData
	nodeMetrics    map[string]NodeMetricsData
	summaries      map[string]api.ServiceMetricsSummary
	summaryBackend string

	// data holds databases, volumes and backups; see [Fake.dataState].
	data *dataState

	// cron holds cron schedule states and runs; see [Fake.cronState].
	cron *cronState

	// templateDeployErrors maps a template service ref to the message its
	// first deployment fails to start with; see [Fake.FailTemplateDeploy].
	templateDeployErrors map[string]string

	// twoFactor makes sign-in answer with a challenge; backupUsed records
	// that the one backup code was spent; lockedFor, when set, answers
	// sign-in with 429 account_locked.
	twoFactor  bool
	backupUsed bool
	lockedFor  int

	// refresh, when set, is the session cookie the next authenticated /v1
	// response sets; endSession, when set, ends the session on the next /v1
	// request with this clearing cookie.
	refresh    *http.Cookie
	endSession *http.Cookie

	// OnGetDeployment runs on every GET of a deployment, under the lock,
	// so tests can advance its status between polls.
	OnGetDeployment func(d *api.DeploymentDetail)

	// OnGetNodeProvision runs on every GET of a provisioning run, under the
	// lock, so tests can advance it between polls.
	OnGetNodeProvision func(p *api.NodeProvision)

	hub *hub
}

// apiToken is a stored API token: what the API lists, plus its secret and
// workspace.
type apiToken struct {
	api.APIToken
	secret      string
	workspaceID string
}

// caller is who made an authenticated request: the seeded user through a
// session, or one of their API tokens.
type caller struct {
	// token is nil for a session.
	token *apiToken
}

// can reports whether the caller may perform action. The seeded user is
// the workspace owner, so a session may do anything; a token only what its
// scopes list.
func (c *caller) can(action string) bool {
	return c.token == nil || action == "" || slices.Contains(c.token.Scopes, action)
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
		{ID: ProductionID, ProjectID: ProjectID, Name: "production", Slug: "production", Kind: "production", Protected: true, CreatedAt: Now - 86400000},
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
		"DATABASE_URL": {value: "postgres://app:${{db.POSTGRES_PASSWORD}}@${{db.ROUNDHOUSE_PRIVATE_DOMAIN}}:${{db.PORT}}/shop", version: 2},
		"API_KEY":      {value: SecretValue, secret: true, build: true, version: 1},
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
		{ID: "dom_0002", ServiceID: APIServiceID, EnvironmentID: ProductionID, Hostname: "shop.example.com", URL: "https://shop.example.com", Type: "custom", TargetPort: 8080, VerificationStatus: "verified", TLSStatus: "active", Status: "active", Records: []api.DNSRecord{}, VerifiedAt: i64(Now - 1000), CreatedAt: Now - 1000},
		{ID: "dom_0001", ServiceID: APIServiceID, EnvironmentID: ProductionID, Hostname: "api-production-x7k2.apps.example.com", URL: "https://api-production-x7k2.apps.example.com", Type: "generated", TargetPort: 8080, VerificationStatus: "verified", TLSStatus: "active", Status: "active", Records: []api.DNSRecord{}, VerifiedAt: i64(Now - 86400000), CreatedAt: Now - 86400000},
		{ID: "dom_0003", ServiceID: APIServiceID, EnvironmentID: StagingID, Hostname: "api-staging-q9p1.apps.example.com", URL: "https://api-staging-q9p1.apps.example.com", Type: "generated", TargetPort: 8080, VerificationStatus: "verified", TLSStatus: "active", Status: "active", Records: []api.DNSRecord{}, VerifiedAt: i64(Now - 86400000), CreatedAt: Now - 86400000},
	}
	f.routingNodes = []api.DomainRoutingNode{{ID: NodeID, Name: "edge-1", PublicIP: str("203.0.113.10"), Serves: true}}
	for i := range f.domains {
		d := &f.domains[i]
		d.TLSStatus = "issued"
		d.HSTS = DefaultHSTS
		d.TLS = issuedTLS(*d.VerifiedAt)
		d.RoutingNodes = slices.Clone(f.routingNodes)
	}
	f.nodes = []api.Node{{ID: NodeID, Name: "edge-1", Hostname: str("edge-1"), Status: "online", Provider: "manual", PublicIP: str("203.0.113.10"),
		OS: str("linux"), Arch: str("amd64"), AgentVersion: str("0.4.0"), Capabilities: json.RawMessage(`{"docker":true,"builder":true}`),
		LastHeartbeatAt: i64(Now - 5000), CreatedAt: Now - 86400000}}
	f.providers = map[string]bool{"hetzner": true}
	offer := func(plan, region, regionName string, vcpus, memMiB, disk, cents int) api.ProviderOffer {
		return api.ProviderOffer{ID: plan + "@" + region, Plan: plan, Description: strings.ToUpper(plan), Category: str("shared"),
			Region: region, RegionName: regionName, Country: str("DE"), VCPUs: vcpus, MemoryMiB: memMiB, DiskGB: disk,
			Arch: "amd64", MonthlyCents: cents, Currency: "EUR"}
	}
	f.offers = []api.ProviderOffer{
		offer("cx23", "fsn1", "Falkenstein", 2, 4096, 40, 449),
		offer("cx23", "nbg1", "Nuremberg", 2, 4096, 40, 449),
		offer("cpx31", "fsn1", "Falkenstein", 4, 8192, 160, 1490),
	}
}

// ProviderDisplayNames are the providers' names, from PROVIDERS in
// packages/providers.
var ProviderDisplayNames = map[string]string{
	"hetzner": "Hetzner Cloud", "digitalocean": "DigitalOcean", "vultr": "Vultr", "linode": "Akamai Cloud (Linode)",
}

// SetProviderConnected connects or disconnects the workspace from a cloud
// provider. Only hetzner is connected in the seed.
// AddNode adds a server to the seeded workspace, e.g. a provider-managed one.
func (f *Fake) AddNode(n api.Node) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nodes = append(f.nodes, n)
}

// Nodes returns copies of the workspace's servers.
func (f *Fake) Nodes() []api.Node {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.nodes)
}

// AddNodeProvision adds a provisioning run as if it had been started.
func (f *Fake) AddNodeProvision(p api.NodeProvision) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.provisions = append(f.provisions, &p)
}

func (f *Fake) SetProviderConnected(provider string, connected bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.providers[provider] = connected
}

// NodeProvisions returns copies of the provisioning runs started so far.
func (f *Fake) NodeProvisions() []api.NodeProvision {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]api.NodeProvision, len(f.provisions))
	for i, p := range f.provisions {
		out[i] = *p
	}
	return out
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
		Deployment: api.Deployment{ID: id, ProjectID: ProjectID, ServiceID: APIServiceID, EnvironmentID: ProductionID, ConfigVersion: 1, Status: status,
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

// StoredVariable is a variable as the fake stores it, secret value included.
type StoredVariable struct {
	Value            string
	Tier             string
	Locked           bool
	AvailableAtBuild bool
	MountAsFile      bool
	Version          int
}

// Stored returns a stored variable with its value and settings.
func (f *Fake) Stored(scopeID, envID, key string) (StoredVariable, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	v, ok := f.vars[varKey(scopeID, envID)][key]
	if !ok {
		return StoredVariable{}, false
	}
	return StoredVariable{Value: v.value, Tier: v.tier(), Locked: v.locked, AvailableAtBuild: v.build, MountAsFile: v.file, Version: v.version}, true
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

// AddToken stores an API token of the seeded workspace, created by the
// seeded user, and returns its secret.
func (f *Fake) AddToken(name string, scopes ...string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.addToken(WorkspaceID, name, scopes, nil).secret
}

// AddTokenIn stores an API token of another workspace, which owns none of
// the seeded resources, and returns its secret.
func (f *Fake) AddTokenIn(workspaceID, name string, scopes ...string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.addToken(workspaceID, name, scopes, nil).secret
}

// Token returns a stored API token by ID.
func (f *Fake) Token(id string) *api.APIToken {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, t := range f.tokens {
		if t.ID == id {
			out := t.APIToken
			return &out
		}
	}
	return nil
}

// RefreshSession makes the next authenticated /v1 response set the session
// cookie to value with Max-Age maxAge, as Better Auth does when it extends a
// session. The new value is accepted from then on.
func (f *Fake) RefreshSession(value string, maxAge int) {
	f.mu.Lock()
	f.refresh = &http.Cookie{Name: CookieName, Value: value, Path: "/", MaxAge: maxAge, HttpOnly: true, SameSite: http.SameSiteLaxMode}
	f.mu.Unlock()
}

// EndSession makes the next /v1 request end the seeded session, answering
// 401 with clear, a Set-Cookie that deletes the session cookie.
func (f *Fake) EndSession(clear *http.Cookie) {
	f.mu.Lock()
	f.endSession = clear
	f.mu.Unlock()
}

func (f *Fake) addToken(workspaceID, name string, scopes []string, expiresInDays *int) *apiToken {
	f.tokenSeq++
	secret := fmt.Sprintf("tok_k%03dSecretValueXq9vLm2PzR7t", f.tokenSeq)
	t := &apiToken{
		APIToken: api.APIToken{
			ID: fmt.Sprintf("tok_%04d", f.tokenSeq), Name: name, Scopes: slices.Clone(scopes), Prefix: str(secret[:8]),
			CreatedBy: &api.APITokenCreator{UserID: f.user.ID, Name: str(f.user.Name)}, CreatedAt: Now + int64(f.tokenSeq),
		},
		secret: secret, workspaceID: workspaceID,
	}
	if expiresInDays != nil {
		t.ExpiresAt = i64(Now + int64(*expiresInDays)*86400000)
	}
	f.tokens = append(f.tokens, t)
	return t
}

// -----------------------------------------------------------------------------
// HTTP plumbing
// -----------------------------------------------------------------------------

// record keeps every request before handling it, so a realtime socket that is
// still open (or closing) is already on record.
func (f *Fake) record(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r = r.WithContext(context.WithValue(r.Context(), bodyKey{}, body))
		_, pattern := mux.Handler(r)
		f.mu.Lock()
		f.requests = append(f.requests, Request{Method: r.Method, Pattern: pattern, Path: r.URL.Path, Query: r.URL.RawQuery, Header: r.Header.Clone(), Body: string(body)})
		f.mu.Unlock()
		mux.ServeHTTP(w, r)
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

// authenticate finds the caller of a request: a live session cookie, or an
// API token that is neither revoked nor expired. Must hold f.mu.
func (f *Fake) authenticate(r *http.Request) (*caller, bool) {
	if secret, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
		for _, t := range f.tokens {
			if t.secret == secret && t.State(Now) == "active" {
				t.LastUsedAt = i64(Now)
				return &caller{token: t}, true
			}
		}
		return nil, false
	}
	ck, err := r.Cookie(CookieName)
	if err != nil || !f.sessions[ck.Value] {
		return nil, false
	}
	return &caller{}, true
}

// workspaceOf returns the workspace that owns a route's resource, or "" when
// the resource does not exist (the handler then answers 404). Must hold f.mu.
func (f *Fake) workspaceOf(r *http.Request) string {
	if id := r.PathValue("workspaceId"); id != "" {
		return id
	}
	projectID := r.PathValue("projectId")
	serviceID := r.PathValue("serviceId")
	if id := f.dataServiceOf(r); id != "" {
		serviceID = id
	}
	if id := f.cronServiceOf(r); id != "" {
		serviceID = id
	}
	for _, d := range f.deployments {
		if d.ID == r.PathValue("deploymentId") || d.BuildID != nil && *d.BuildID == r.PathValue("buildId") {
			serviceID = d.ServiceID
		}
	}
	for _, p := range f.projects {
		if p.ID == projectID || slices.ContainsFunc(p.Services, func(s api.Service) bool { return s.ID == serviceID }) {
			return p.WorkspaceID
		}
	}
	return ""
}

type callerKey struct{}

// callerOf returns the authenticated caller of a guarded request.
func callerOf(r *http.Request) *caller {
	c, _ := r.Context().Value(callerKey{}).(*caller)
	return c
}

// guard applies the API's request rules before a /v1 handler: the
// same-origin guard, authentication (with session refresh), and for an API
// token its workspace (404 outside it) and its scopes (403 without action).
func (f *Fake) guard(action string, h func(http.ResponseWriter, *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Mirrors sameOriginMutations in apps/api/src/lib/guards.ts.
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
			origin, site := r.Header.Get("Origin"), r.Header.Get("Sec-Fetch-Site")
			if origin != "" && origin != f.URL || origin == "" && site != "" && site != "same-origin" && site != "none" {
				apiError(w, http.StatusForbidden, "forbidden", "Cross-origin request rejected")
				return
			}
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if clear := f.endSession; clear != nil {
			f.endSession = nil
			delete(f.sessions, SessionToken)
			http.SetCookie(w, clear)
			apiError(w, http.StatusUnauthorized, "unauthorized", "Your session expired; sign in again")
			return
		}
		c, ok := f.authenticate(r)
		if !ok {
			apiError(w, http.StatusUnauthorized, "unauthorized", "Sign in to continue")
			return
		}
		if ck := f.refresh; ck != nil {
			f.refresh = nil
			f.sessions[ck.Value] = true
			http.SetCookie(w, ck)
		}
		if c.token != nil {
			if ws := f.workspaceOf(r); ws != "" && ws != c.token.workspaceID {
				apiError(w, http.StatusNotFound, "not_found", "Not found")
				return
			}
			if !c.can(action) {
				apiError(w, http.StatusForbidden, "forbidden", "This API token lacks the "+action+" scope")
				return
			}
		}
		h(w, r.WithContext(context.WithValue(r.Context(), callerKey{}, c)))
	}
}

// guarded is a /v1 handler and the RBAC action its route requires, from
// apps/api/src/contracts.ts; "" for routes any signed-in caller may use.
type guarded struct {
	action string
	h      func(http.ResponseWriter, *http.Request)
}

func (f *Fake) routes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/auth/sign-in/email", f.signIn)
	mux.HandleFunc("POST /api/auth/sign-out", f.signOut)
	mux.HandleFunc("POST /api/auth/two-factor/verify-totp", f.verifySecondFactor)
	mux.HandleFunc("POST /api/auth/two-factor/verify-backup-code", f.verifySecondFactor)
	handlers := map[api.Route]guarded{
		api.RouteMe:              {"", f.me},
		api.RouteListProjects:    {"projects:read", f.listProjects},
		api.RouteCreateProject:   {"projects:manage", f.createProject},
		api.RouteGetProject:      {"projects:read", f.getProject},
		api.RouteDeleteProject:   {"projects:manage", f.deleteProject},
		api.RouteListServices:    {"services:read", f.listServices},
		api.RouteCreateService:   {"services:manage", f.createService},
		api.RouteGetService:      {"services:read", f.getService},
		api.RouteDeleteService:   {"services:manage", f.deleteService},
		api.RouteServiceConfig:   {"services:read", f.serviceConfig},
		api.RouteServiceVars:     {"variables:read", f.listVars},
		api.RoutePutServiceVars:  {"variables:manage", f.putVars},
		api.RouteResolveVars:     {"variables:read_plain", f.resolveVars},
		api.RouteSharedVars:      {"variables:read", f.listVars},
		api.RoutePutSharedVars:   {"variables:manage", f.putVars},
		api.RouteListDeployments: {"services:read", f.listDeployments},
		api.RouteCreateDeploy:    {"deployments:create", f.createDeployment},
		api.RouteGetDeployment:   {"services:read", f.getDeployment},
		api.RouteRollback:        {"deployments:create", f.rollback},
		api.RouteCancel:          {"deployments:create", f.cancel},
		api.RouteDeploymentLogs:  {"services:read", f.getLogs},
		api.RouteBuildLogs:       {"services:read", f.getLogs},
		api.RouteListDomains:     {"services:read", f.listDomains},
		api.RouteAddDomain:       {"services:manage", f.addDomain},
		api.RouteGetDomain:       {"services:read", f.getDomain},
		api.RouteUpdateDomain:    {"services:manage", f.updateDomain},
		api.RouteCheckDomain:     {"services:manage", f.recheckDomain},
		api.RouteRemoveDomain:    {"services:manage", f.removeDomain},
		api.RouteListNodes:       {"nodes:read", f.listNodes},
		api.RouteJoinToken:       {"nodes:manage", f.joinToken},
		api.RouteIntegrations:    {"nodes:manage", f.listIntegrations},
		api.RouteProviderOffers:  {"nodes:manage", f.providerOffers},
		api.RouteProvisionNode:   {"nodes:manage", f.provisionNode},
		api.RouteNodeProvision:   {"nodes:read", f.getNodeProvision},
		api.RouteCancelProvision: {"nodes:manage", f.cancelNodeProvision},
		api.RouteRemoveNode:      {"nodes:manage", f.removeNode},
		api.RouteListTokens:      {"tokens:manage", f.listTokens},
		api.RouteCreateToken:     {"tokens:manage", f.createToken},
		api.RouteRevokeToken:     {"tokens:manage", f.revokeToken},
		api.RouteListTemplates:   {"projects:read", f.listTemplates},
		api.RouteGetTemplate:     {"projects:read", f.getTemplate},
		api.RouteFromTemplate:    {"projects:create", f.createFromTemplate},
		api.RouteDeployTemplate:  {"services:manage", f.deployTemplate},

		api.RouteListChangeSets:   {"projects:read", f.listChangeSets},
		api.RouteGetDraft:         {"projects:read", f.getDraft},
		api.RouteGetChangeSet:     {"projects:read", f.getChangeSet},
		api.RouteReviewChangeSet:  {"projects:read", f.reviewChangeSet},
		api.RouteApplyChangeSet:   {"projects:read", f.applyChangeSet},
		api.RouteDiscardChangeSet: {"projects:read", f.discardChangeSet},
		api.RouteSubmitChangeSet:  {"projects:read", f.submitChangeSet},
		api.RouteApproveChangeSet: {"changes:approve", f.approveChangeSet},
		api.RouteRejectChangeSet:  {"changes:approve", f.rejectChangeSet},
		api.RouteRebaseChangeSet:  {"projects:read", f.rebaseChangeSet},

		api.RouteServiceMetrics: {"services:read", f.serviceMetricsHandler},
		api.RouteMetricsSummary: {"projects:read", f.metricsSummaryHandler},
		api.RouteNodeMetrics:    {"nodes:read", f.nodeMetricsHandler},
	}
	f.dataRoutes(mux, handlers)
	f.cronRoutes(handlers)
	for route, g := range handlers {
		mux.HandleFunc(route.Method+" "+route.Path, f.guard(g.action, g.h))
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
	f.mu.Lock()
	locked, twoFactor := f.lockedFor, f.twoFactor
	f.mu.Unlock()
	if locked > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(locked))
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"code": "account_locked", "message": fmt.Sprintf("Too many failed attempts. Try again in %d seconds.", locked)})
		return
	}
	var body struct{ Email, Password string }
	if decode(r, &body) != nil || body.Email != Email || body.Password != Password {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "INVALID_EMAIL_OR_PASSWORD", "message": "Invalid email or password"})
		return
	}
	if twoFactor {
		// Better Auth clears the session cookie it had set and sets the challenge.
		http.SetCookie(w, &http.Cookie{Name: CookieName, Value: "", Path: "/", MaxAge: -1})
		http.SetCookie(w, &http.Cookie{Name: ChallengeCookie, Value: challengeValue, Path: "/", MaxAge: 600, HttpOnly: true})
		writeJSON(w, http.StatusOK, map[string]any{"twoFactorRedirect": true, "twoFactorMethods": []string{"totp"}})
		return
	}
	f.startSession(w)
}

func (f *Fake) startSession(w http.ResponseWriter) {
	f.mu.Lock()
	f.sessions[SessionToken] = true
	f.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: CookieName, Value: SessionToken, Path: "/", MaxAge: 604800, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	writeJSON(w, http.StatusOK, map[string]any{"redirect": false, "token": "sess_0123456789abcdef", "user": f.user})
}

// verifySecondFactor answers both two-factor endpoints like Better Auth: the
// challenge cookie names the sign-in, the code finishes it.
func (f *Fake) verifySecondFactor(w http.ResponseWriter, r *http.Request) {
	if !f.betterAuthOrigin(w, r) {
		return
	}
	if ck, err := r.Cookie(ChallengeCookie); err != nil || ck.Value != challengeValue {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "INVALID_TWO_FACTOR_COOKIE", "message": "Invalid two factor cookie"})
		return
	}
	var body struct{ Code string }
	_ = decode(r, &body)
	f.mu.Lock()
	ok := false
	if strings.HasSuffix(r.URL.Path, "/verify-totp") {
		ok = body.Code == TOTPCode
	} else if body.Code == BackupCode && !f.backupUsed {
		f.backupUsed = true
		ok = true
	}
	f.mu.Unlock()
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "INVALID_CODE", "message": "Invalid code"})
		return
	}
	http.SetCookie(w, &http.Cookie{Name: ChallengeCookie, Value: "", Path: "/", MaxAge: -1})
	f.startSession(w)
}

// EnableTwoFactor makes sign-in ask for a second factor ([TOTPCode] or
// [BackupCode]).
func (f *Fake) EnableTwoFactor() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.twoFactor = true
}

// LockAccount makes sign-in answer 429 account_locked for this many seconds.
func (f *Fake) LockAccount(seconds int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lockedFor = seconds
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

// me answers a token with its creator, its workspace only, and itself.
func (f *Fake) me(w http.ResponseWriter, r *http.Request) {
	c := callerOf(r)
	if c.token == nil {
		writeJSON(w, http.StatusOK, api.Me{User: f.user, Workspaces: f.workspaces})
		return
	}
	t := c.token
	out := api.Me{User: f.user, Workspaces: []api.Membership{},
		Token: &api.MeToken{ID: t.ID, Name: t.Name, WorkspaceID: t.workspaceID, Scopes: t.Scopes}}
	for _, m := range f.workspaces {
		if m.ID == t.workspaceID {
			out.Workspaces = append(out.Workspaces, m)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// uniqueSlug suffixes base with -2, -3, … until taken reports it free, as
// the API does for project and service slugs.
func uniqueSlug(base string, taken func(string) bool) string {
	slug := base
	for n := 2; taken(slug); n++ {
		slug = fmt.Sprintf("%s-%d", base, n)
	}
	return slug
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
	slug, filtered := r.URL.Query()["slug"]
	if filtered && !validSlug.MatchString(slug[0]) {
		apiError(w, http.StatusBadRequest, "invalid_request", "slug: expected a lowercase slug")
		return
	}
	out := []api.Project{}
	for _, id := range slices.Sorted(mapKeys(f.projects)) {
		if p := f.projects[id]; p.WorkspaceID == r.PathValue("workspaceId") && (!filtered || p.Slug == slug[0]) {
			out = append(out, p.Project)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": out})
}

var (
	nonSlugChars = regexp.MustCompile(`[^a-z0-9]+`)
	validSlug    = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)
)

func slugify(name string) string {
	return strings.Trim(nonSlugChars.ReplaceAllString(strings.ToLower(name), "-"), "-")
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
	ws := r.PathValue("workspaceId")
	slug = uniqueSlug(slug, func(s string) bool {
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
	// `shared` is the shared variables' reference namespace, so it is reserved.
	slug = uniqueSlug(slug, func(s string) bool {
		return s == sharedNamespace || slices.ContainsFunc(p.Services, func(x api.Service) bool { return x.Slug == s })
	})
	kind := in.Kind
	if kind == "" {
		kind = "app"
	}
	cron, ok := createCron(w, kind, in.Config)
	if !ok {
		return
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
		if cron != nil {
			cc := *cron
			c.Cron = &cc
		}
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

func (v *variable) tier() string {
	if v.secret {
		return api.TierSecret
	}
	return api.TierPlain
}

// listed is a scope's variables as the API lists them: never a secret's
// value, and a plain one only when plain is set.
func (f *Fake) listed(key string, plain bool) []api.Variable {
	out := []api.Variable{}
	vars := f.vars[key]
	for _, k := range slices.Sorted(mapKeys(vars)) {
		v := vars[k]
		item := api.Variable{Key: k, Tier: v.tier(), Locked: v.locked, Fingerprint: str(fingerprint(v.value)),
			AvailableAtBuild: v.build, MountAsFile: v.file, Version: v.version, UpdatedAt: Now, UpdatedBy: str(cmp.Or(v.updatedBy, f.user.ID))}
		if !v.secret && plain {
			item.Value = str(v.value)
		}
		out = append(out, item)
	}
	return out
}

func (f *Fake) listVars(w http.ResponseWriter, r *http.Request) {
	if key, ok := f.varScope(w, r); ok {
		writeJSON(w, http.StatusOK, map[string]any{"variables": f.listed(key, callerOf(r).can("variables:read_plain"))})
	}
}

var keyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// utf16Offset converts a byte offset to UTF-16 code units, as the API counts.
func utf16Offset(s string, b int) int {
	return len(utf16.Encode([]rune(s[:b])))
}

// putVars mirrors putVariables in apps/api/src/lib/variables.ts: the whole
// write is refused, nothing stored, for a malformed reference, a stale
// expected_version, a tier the classifier forbids, an unacknowledged public
// credential, or a key becoming secret without confirm_write_only.
func (f *Fake) putVars(w http.ResponseWriter, r *http.Request) {
	key, ok := f.varScope(w, r)
	if !ok {
		return
	}
	var in api.VariablesPut
	if decode(r, &in) != nil || len(in.Set) > 256 || len(in.Delete) > 256 || len(in.AcknowledgePublic) > 256 {
		apiError(w, http.StatusBadRequest, "invalid_request", "invalid body")
		return
	}
	var details []api.ErrorDetail
	for _, s := range in.Set {
		if !keyPattern.MatchString(s.Key) || (s.Tier != "" && s.Tier != api.TierPlain && s.Tier != api.TierSecret) {
			apiError(w, http.StatusBadRequest, "invalid_request", "set: expected a name like DATABASE_URL and a tier of plain or secret")
			return
		}
		if s.Value == nil {
			continue
		}
		_, errs := parseValue(*s.Value)
		for _, e := range errs {
			start, end := utf16Offset(*s.Value, e.start), utf16Offset(*s.Value, e.end)
			details = append(details, api.ErrorDetail{Field: s.Key, Code: e.code, Message: e.message, Start: &start, End: &end})
		}
	}
	if len(details) > 0 {
		d := details[0]
		apiError(w, http.StatusBadRequest, "invalid_reference", fmt.Sprintf("%s: %s (at %d-%d)", d.Field, d.Message, *d.Start, *d.End), details...)
		return
	}

	type plannedWrite struct {
		set    api.VariableSet
		value  string
		secret bool
		locked bool
	}
	var planned []plannedWrite
	var problems []api.ErrorDetail
	var needAck, needConfirm []string
	warnings := []api.VariableWarning{}
	for _, s := range in.Set {
		prior := f.vars[key][s.Key]
		if s.ExpectedVersion != nil && prior != nil && prior.version != *s.ExpectedVersion {
			apiError(w, http.StatusConflict, "conflict", fmt.Sprintf("%s changed since version %d", s.Key, *s.ExpectedVersion))
			return
		}
		if s.Value == nil && prior == nil {
			problems = append(problems, api.ErrorDetail{Field: s.Key, Code: "value_required", Message: "A new variable needs a value"})
			continue
		}
		value := ""
		if s.Value != nil {
			value = *s.Value
		} else {
			value = prior.value
		}
		c := classify(s.Key, value)
		secret, problem := decideTier(c, s.Tier, prior, s.Value != nil)
		if problem != nil {
			problems = append(problems, api.ErrorDetail{Field: s.Key, Code: problem.code, Message: problem.message})
			continue
		}
		for _, wn := range c.warnings {
			if wn.code == "public_prefix_secret_value" && !slices.Contains(in.AcknowledgePublic, s.Key) {
				needAck = append(needAck, s.Key)
			}
			warnings = append(warnings, api.VariableWarning{Key: s.Key, Code: wn.code, Message: wn.message})
		}
		if secret && len([]rune(value)) > 0 && len([]rune(value)) < 6 {
			warnings = append(warnings, api.VariableWarning{Key: s.Key, Code: "secret_too_short_to_redact",
				Message: s.Key + " is shorter than 6 characters, so it can't be redacted from logs"})
		}
		if secret && (prior == nil || !prior.secret) {
			needConfirm = append(needConfirm, s.Key)
		}
		planned = append(planned, plannedWrite{set: s, value: value, secret: secret, locked: c.locked})
	}
	if len(problems) > 0 {
		p := problems[0]
		apiError(w, http.StatusBadRequest, p.Code, p.Field+": "+p.Message, problems...)
		return
	}
	if len(needAck) > 0 {
		ack := make([]api.ErrorDetail, len(needAck))
		for i, k := range needAck {
			ack[i] = api.ErrorDetail{Field: k, Code: "public_prefix_secret_value", Message: "Looks like a credential"}
		}
		apiError(w, http.StatusBadRequest, "public_prefix_secret_value",
			strings.Join(needAck, ", ")+" will ship to every browser but looks like a credential; add it to acknowledge_public to store anyway", ack...)
		return
	}
	if len(needConfirm) > 0 && !in.ConfirmWriteOnly {
		confirm := make([]api.ErrorDetail, len(needConfirm))
		for i, k := range needConfirm {
			confirm[i] = api.ErrorDetail{Field: k, Code: "confirmation_required", Message: "Becomes write-only"}
		}
		apiError(w, http.StatusBadRequest, "confirmation_required",
			strings.Join(needConfirm, ", ")+" will be write-only: nobody can read it back. Resend with confirm_write_only to continue", confirm...)
		return
	}

	if f.vars[key] == nil {
		f.vars[key] = map[string]*variable{}
	}
	for _, p := range planned {
		v := f.vars[key][p.set.Key]
		if v == nil {
			v = &variable{}
			f.vars[key][p.set.Key] = v
		}
		v.value, v.secret, v.locked, v.updatedBy = p.value, p.secret, p.locked, f.user.ID
		if p.set.AvailableAtBuild != nil {
			v.build = *p.set.AvailableAtBuild
		}
		if p.set.MountAsFile != nil {
			v.file = *p.set.MountAsFile
		}
		v.version++
	}
	for _, k := range in.Delete {
		delete(f.vars[key], k)
	}
	writeJSON(w, http.StatusOK, api.VariablesPutResult{Variables: f.listed(key, callerOf(r).can("variables:read_plain")), Warnings: warnings})
}

// resolveVars mirrors the resolved route in apps/api/src/routes/variables.ts:
// every service's raw variables, the shared ones and the built-ins go
// through the resolver, reference errors become one detail each, and secret
// and secret-derived keys are named in local_keys instead of answered.
func (f *Fake) resolveVars(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	envID, ok := environment(w, r, p, true)
	if !ok {
		return
	}
	secrets := map[string]bool{}
	raw := func(scopeID, ns string) map[string]string {
		out := map[string]string{}
		for k, v := range f.vars[varKey(scopeID, envID)] {
			out[k] = v.value
			if v.secret {
				secrets[ns+"."+k] = true
			}
		}
		return out
	}
	in := resolveInput{service: s.Slug, services: map[string]map[string]string{}, shared: raw(p.ID, sharedNamespace),
		builtins: map[string]map[string]string{}, secrets: secrets}
	for _, svc := range p.Services {
		in.services[svc.Slug] = raw(svc.ID, svc.Slug)
		in.builtins[svc.Slug] = f.builtins(p, svc, envID)
	}
	env, local, errs := resolveEnv(in)
	if len(errs) > 0 {
		details := make([]api.ErrorDetail, len(errs))
		for i, e := range errs {
			details[i] = api.ErrorDetail{Field: e.variable, Code: e.code, Message: e.message}
		}
		apiError(w, http.StatusBadRequest, "invalid_reference", errs[0].variable+": "+errs[0].message, details...)
		return
	}
	if local == nil {
		local = []string{}
	}
	writeJSON(w, http.StatusOK, api.ResolvedVariables{Variables: env, LocalKeys: local})
}

// builtins computes a service's built-in variables in an environment as the
// deploy workflow does; the deployment ones come from its live deployment.
func (f *Fake) builtins(p *api.ProjectDetail, svc api.Service, envID string) map[string]string {
	envSlug := ""
	for _, e := range p.Environments {
		if e.ID == envID {
			envSlug = e.Slug
		}
	}
	b := map[string]string{
		"ROUNDHOUSE_PRIVATE_DOMAIN": svc.Slug + "." + envSlug + ".internal",
		"ROUNDHOUSE_ENVIRONMENT":    envSlug,
		"ROUNDHOUSE_SERVICE_NAME":   svc.Name,
	}
	if c, ok := f.configs[svc.ID+"/"+envID]; ok && c.Networking.Port != nil {
		b["PORT"] = strconv.Itoa(*c.Networking.Port)
	}
	var first *api.Domain
	for i, d := range f.domains {
		if d.ServiceID == svc.ID && d.EnvironmentID == envID && (first == nil || d.ID < first.ID) {
			first = &f.domains[i]
		}
	}
	if first != nil {
		b["ROUNDHOUSE_PUBLIC_DOMAIN"] = first.Hostname
	}
	for _, d := range f.deployments {
		if d.ServiceID == svc.ID && d.EnvironmentID == envID && d.Status == api.StatusActive {
			b["ROUNDHOUSE_DEPLOYMENT_ID"] = d.ID
			if d.Build != nil {
				b["ROUNDHOUSE_GIT_COMMIT_SHA"] = d.Build.CommitSHA
			}
		}
	}
	return b
}

// -----------------------------------------------------------------------------
// API tokens
// -----------------------------------------------------------------------------

func (f *Fake) listTokens(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	out := []api.APIToken{}
	for i := len(f.tokens) - 1; i >= 0; i-- {
		if t := f.tokens[i]; t.workspaceID == r.PathValue("workspaceId") {
			out = append(out, t.APIToken)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": out})
}

// createToken validates like CreateApiTokenSchema; a token creating a token
// may only grant scopes it holds itself.
func (f *Fake) createToken(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	var in struct {
		Name          string          `json:"name"`
		Scopes        []string        `json:"scopes"`
		ExpiresInDays json.RawMessage `json:"expires_in_days"`
	}
	if decode(r, &in) != nil || strings.TrimSpace(in.Name) == "" || len(in.Name) > 100 {
		apiError(w, http.StatusBadRequest, "invalid_request", "name: Required")
		return
	}
	if len(in.Scopes) == 0 || len(in.Scopes) > len(api.APITokenScopes) {
		apiError(w, http.StatusBadRequest, "invalid_request", "scopes: expected at least one scope")
		return
	}
	for i, s := range in.Scopes {
		if !slices.Contains(api.APITokenScopes, s) || slices.Contains(in.Scopes[:i], s) {
			apiError(w, http.StatusBadRequest, "invalid_request", "scopes: invalid or repeated scope "+s)
			return
		}
	}
	var days *int
	if in.ExpiresInDays == nil {
		apiError(w, http.StatusBadRequest, "invalid_request", "expires_in_days: Required")
		return
	}
	if err := json.Unmarshal(in.ExpiresInDays, &days); err != nil || days != nil && (*days < 1 || *days > api.MaxAPITokenDays) {
		apiError(w, http.StatusBadRequest, "invalid_request", "expires_in_days: expected 1-366 or null")
		return
	}
	if c := callerOf(r); c.token != nil {
		for _, s := range in.Scopes {
			if !c.can(s) {
				apiError(w, http.StatusForbidden, "forbidden", "A token can only grant scopes it holds: "+s)
				return
			}
		}
	}
	t := f.addToken(r.PathValue("workspaceId"), strings.TrimSpace(in.Name), in.Scopes, days)
	writeJSON(w, http.StatusCreated, api.CreatedAPIToken{Token: t.APIToken, Secret: t.secret})
}

func (f *Fake) revokeToken(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	for _, t := range f.tokens {
		if t.ID == r.PathValue("tokenId") && t.workspaceID == r.PathValue("workspaceId") {
			if t.RevokedAt == nil {
				t.RevokedAt = i64(Now)
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	apiError(w, http.StatusNotFound, "not_found", "Token not found")
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
	d.ProjectID, d.ServiceID, d.EnvironmentID = p.ID, s.ID, env
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
	d.ProjectID, d.ServiceID, d.EnvironmentID, d.Trigger, d.RollbackOf = src.ProjectID, src.ServiceID, src.EnvironmentID, "rollback", &src.ID
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

// getLogs serves deployment, build and cron run logs. It pages backwards:
// no cursor is the newest page; the cursor is the index of the oldest line
// already returned.
func (f *Fake) getLogs(w http.ResponseWriter, r *http.Request) {
	source := "dep:" + r.PathValue("deploymentId")
	if id := r.PathValue("buildId"); id != "" {
		source = "bld:" + id
	}
	if id := r.PathValue("runId"); id != "" {
		source = "crn:" + id
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

// -----------------------------------------------------------------------------
// Cloud providers
// -----------------------------------------------------------------------------

func (f *Fake) listIntegrations(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	out := []api.ProviderIntegration{}
	for _, id := range api.ProviderIDs {
		in := api.ProviderIntegration{Provider: id, DisplayName: ProviderDisplayNames[id], Connected: f.providers[id]}
		if in.Connected {
			in.AccountLabel, in.TokenFingerprint, in.TokenLast4 = str("ada@example.com"), str("fp_0001"), str("x7k2")
			in.LastValidatedAt, in.UpdatedAt = i64(Now-60000), i64(Now-86400000)
		}
		out = append(out, in)
	}
	writeJSON(w, http.StatusOK, map[string]any{"integrations": out})
}

// connected answers 400 for an unknown provider and 409
// provider_not_connected for one the workspace has no token for.
func (f *Fake) connected(w http.ResponseWriter, provider string) bool {
	if !slices.Contains(api.ProviderIDs, provider) {
		apiError(w, http.StatusBadRequest, "invalid_request", "provider: invalid enum value")
		return false
	}
	if !f.providers[provider] {
		apiError(w, http.StatusConflict, "provider_not_connected", "Connect "+ProviderDisplayNames[provider]+" to this workspace first")
		return false
	}
	return true
}

// providerOffers serves the seeded offers for any connected provider. The
// node role is recommended the cheapest offers, Nuremberg first; the
// builder role the larger plan.
func (f *Fake) providerOffers(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) || !f.connected(w, r.PathValue("provider")) {
		return
	}
	role := cmp.Or(r.URL.Query().Get("role"), "node")
	if role != "node" && role != "builder" {
		apiError(w, http.StatusBadRequest, "invalid_request", "role: invalid enum value")
		return
	}
	region := r.URL.Query().Get("region")
	offers := []api.ProviderOffer{}
	for _, o := range f.offers {
		if region == "" || o.Region == region {
			offers = append(offers, o)
		}
	}
	recommended := []string{"cx23@nbg1", "cx23@fsn1"}
	if role == "builder" {
		recommended = []string{"cpx31@fsn1"}
	}
	recs := []api.OfferRecommendation{}
	for _, id := range recommended {
		if slices.ContainsFunc(offers, func(o api.ProviderOffer) bool { return o.ID == id }) {
			recs = append(recs, api.OfferRecommendation{OfferID: id, Reason: "Cheapest " + role + " plan"})
		}
	}
	writeJSON(w, http.StatusOK, api.ProviderOffers{Provider: r.PathValue("provider"), Role: role, Offers: offers, Recommendations: recs, FetchedAt: Now})
}

var serverName = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// provisionNode starts a run in status queued. Like the API's fresh-session
// check, it refuses API tokens: they are never a recent sign-in.
func (f *Fake) provisionNode(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	if callerOf(r).token != nil {
		apiError(w, http.StatusForbidden, "reauth_required", "Confirm your password to continue")
		return
	}
	var in api.ProvisionNodeInput
	if err := decode(r, &in); err != nil {
		apiError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}
	if !f.connected(w, in.Provider) {
		return
	}
	if !serverName.MatchString(in.Name) || in.Plan == "" || in.Region == "" {
		apiError(w, http.StatusBadRequest, "invalid_request", "name, plan and region are required")
		return
	}
	if slices.ContainsFunc(f.nodes, func(n api.Node) bool { return n.Name == in.Name }) ||
		slices.ContainsFunc(f.provisions, func(p *api.NodeProvision) bool { return p.Name == in.Name && p.Status != api.ProvisionFailed }) {
		apiError(w, http.StatusConflict, "conflict", "A server named "+in.Name+" already exists")
		return
	}
	p := &api.NodeProvision{ID: f.nextID("prv"), Provider: in.Provider, Name: in.Name, Plan: in.Plan, Region: in.Region,
		Builder: in.Builder, Status: api.ProvisionQueued, CreatedAt: Now, UpdatedAt: Now}
	f.provisions = append(f.provisions, p)
	writeJSON(w, http.StatusAccepted, p)
}

// cancelNodeProvision mirrors the API: a queued or booting run is cancelled
// at once, one still creating keeps its status with the cancel requested,
// and a finished run is 409. Repeating a cancel returns the run unchanged.
func (f *Fake) cancelNodeProvision(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	i := slices.IndexFunc(f.provisions, func(p *api.NodeProvision) bool { return p.ID == r.PathValue("provisionId") })
	if i < 0 {
		apiError(w, http.StatusNotFound, "not_found", "Provisioning run not found")
		return
	}
	p := f.provisions[i]
	switch {
	case p.CancelRequestedAt != nil:
	case api.IsProvisionFinished(p.Status):
		apiError(w, http.StatusConflict, "conflict", "This run already finished ("+p.Status+")")
		return
	default:
		p.CancelRequestedAt, p.UpdatedAt = i64(Now+1000), Now+1000
		if p.Status != api.ProvisionCreating {
			p.Status, p.FailureReason, p.FailureMessage, p.FinishedAt = api.ProvisionCancelled, str("cancelled"), str("Cancelled before the server joined"), i64(Now+1000)
		}
	}
	writeJSON(w, http.StatusOK, p)
}

// removeNode deletes a server. A provider-managed one needs its provider
// connected unless keep_server=true, as the API deletes the cloud server
// first.
func (f *Fake) removeNode(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	i := slices.IndexFunc(f.nodes, func(n api.Node) bool { return n.ID == r.PathValue("nodeId") })
	if i < 0 {
		apiError(w, http.StatusNotFound, "not_found", "Server not found")
		return
	}
	n := f.nodes[i]
	if n.ProviderServerID != nil && r.URL.Query().Get("keep_server") != "true" && !f.providers[n.Provider] {
		apiError(w, http.StatusConflict, "provider_not_connected", "Connect "+cmp.Or(ProviderDisplayNames[n.Provider], n.Provider)+" to this workspace first")
		return
	}
	f.nodes = slices.Delete(f.nodes, i, i+1)
	w.WriteHeader(http.StatusNoContent)
}

func (f *Fake) getNodeProvision(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	for _, p := range f.provisions {
		if p.ID == r.PathValue("provisionId") {
			if f.OnGetNodeProvision != nil {
				f.OnGetNodeProvision(p)
			}
			writeJSON(w, http.StatusOK, p)
			return
		}
	}
	apiError(w, http.StatusNotFound, "not_found", "Provisioning run not found")
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

// realtime mirrors apps/api/src/routes/realtime.ts: only a non-upgrade
// request (426) and a cookie upgrade from another Origin (403) are refused
// over HTTP. A caller who may not open the socket gets it accepted and
// closed at once with 4401 (not signed in), 4404 (no such project, or one
// outside a token's workspace) or 4403 (a token without projects:read).
func (f *Fake) realtime(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		apiError(w, http.StatusUpgradeRequired, "upgrade_required", "Expected a WebSocket upgrade")
		return
	}
	bearer := strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !bearer && r.Header.Get("Origin") != f.URL {
		apiError(w, http.StatusForbidden, "forbidden", "Cross-origin WebSocket rejected")
		return
	}
	f.mu.Lock()
	who, authed := f.authenticate(r)
	p, found := f.projects[r.PathValue("projectId")]
	var refuse websocket.StatusCode
	var reason string
	switch {
	case !authed:
		refuse, reason = api.CloseUnauthorized, "unauthorized"
	case !found || who.token != nil && p.WorkspaceID != who.token.workspaceID:
		refuse, reason = api.CloseNotFound, "project not found"
	case !who.can("projects:read"):
		refuse, reason = api.CloseForbidden, "forbidden"
	}
	f.mu.Unlock()
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	if refuse != 0 {
		_ = conn.Close(refuse, reason)
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

// CloseSockets closes every realtime socket with a close frame, as the
// project room does when its periodic re-check finds a session expired
// (4401) or access lost (4403).
func (f *Fake) CloseSockets(code int, reason string) {
	f.hub.mu.Lock()
	var clients []*client
	for c := range f.hub.clients {
		clients = append(clients, c)
	}
	f.hub.mu.Unlock()
	// Close waits for the client's reply, read by the socket's own handler,
	// which needs the hub lock to unregister; so close outside it.
	for _, c := range clients {
		go func() { _ = c.conn.Close(websocket.StatusCode(code), reason) }()
	}
}
