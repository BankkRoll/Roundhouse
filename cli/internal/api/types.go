package api

import (
	"encoding/json"
	"slices"
)

// Wire types mirror the zod schemas in apps/api/src/schemas.ts. Field names
// and nullability follow the API exactly; nullable fields are pointers so a
// `null` survives a decode/encode round trip in --json output.

// User is the signed-in user.
type User struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Email string  `json:"email"`
	Image *string `json:"image"`
}

// Membership is a workspace the user belongs to, with their role in it.
type Membership struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
	Role string `json:"role"`
	// MemberID is the caller's own membership row.
	MemberID string `json:"member_id"`
}

// Me is the response of GET /v1/me. With an API token, User is the token's
// creator and Workspaces holds only the token's workspace.
type Me struct {
	User       User         `json:"user"`
	Workspaces []Membership `json:"workspaces"`
	// Token is the API token the request used; nil for a session.
	Token *MeToken `json:"token,omitempty"`
}

// MeToken describes the API token behind a GET /v1/me request.
type MeToken struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	WorkspaceID string   `json:"workspace_id"`
	Scopes      []string `json:"scopes"`
}

// Project is a project in a workspace.
type Project struct {
	ID          string  `json:"id"`
	WorkspaceID string  `json:"workspace_id"`
	Name        string  `json:"name"`
	Slug        string  `json:"slug"`
	Description *string `json:"description"`
	CreatedAt   int64   `json:"created_at"`
	UpdatedAt   int64   `json:"updated_at"`
}

// ProjectDetail is a project with its environments and services.
type ProjectDetail struct {
	Project
	Environments []Environment `json:"environments"`
	Services     []Service     `json:"services"`
}

// Environment is an environment of a project.
type Environment struct {
	ID           string  `json:"id"`
	ProjectID    string  `json:"project_id"`
	Name         string  `json:"name"`
	Slug         string  `json:"slug"`
	Kind         string  `json:"kind"`
	PRNumber     *int    `json:"pr_number"`
	SourceBranch *string `json:"source_branch"`
	// Protected is true when protection rules narrow deploys, config and
	// variable changes here; production starts protected.
	Protected bool  `json:"protected"`
	CreatedAt int64 `json:"created_at"`
}

// Service is a service of a project. Its config lives per environment.
type Service struct {
	ID        string  `json:"id"`
	ProjectID string  `json:"project_id"`
	Name      string  `json:"name"`
	Slug      string  `json:"slug"`
	Kind      string  `json:"kind"`
	Icon      *string `json:"icon"`
	// Database is set for a database service; nil for any other.
	Database  *ServiceDatabase `json:"database,omitempty"`
	CreatedAt int64            `json:"created_at"`
	UpdatedAt int64            `json:"updated_at"`
}

// ServiceSource says where a service's code comes from: an image, or a git
// repository to build.
type ServiceSource struct {
	// Type is "image" or "git".
	Type                 string `json:"type"`
	Image                string `json:"image,omitempty"`
	RepoURL              string `json:"repo_url,omitempty"`
	Branch               string `json:"branch,omitempty"`
	RootDir              string `json:"root_dir,omitempty"`
	GithubInstallationID string `json:"github_installation_id,omitempty"`
}

// NetworkingConfig is how a service is reached.
type NetworkingConfig struct {
	Port            *int `json:"port"`
	GeneratedDomain bool `json:"generated_domain"`
}

// ServiceConfig is one config version of a service in an environment. Parts
// the CLI does not interpret are kept raw so --json output stays complete.
type ServiceConfig struct {
	ID            string           `json:"id"`
	ServiceID     string           `json:"service_id"`
	EnvironmentID string           `json:"environment_id"`
	Version       int              `json:"version"`
	CreatedBy     *string          `json:"created_by"`
	CreatedAt     int64            `json:"created_at"`
	Source        ServiceSource    `json:"source"`
	Build         json.RawMessage  `json:"build"`
	Deploy        json.RawMessage  `json:"deploy"`
	Resources     json.RawMessage  `json:"resources"`
	Healthcheck   json.RawMessage  `json:"healthcheck"`
	Networking    NetworkingConfig `json:"networking"`
	Placement     json.RawMessage  `json:"placement"`
	// Cron is set for a cron service; nil for any other.
	Cron *CronConfig `json:"cron"`
}

// CreatedService is the response of POST /v1/projects/{projectId}/services.
type CreatedService struct {
	Service Service         `json:"service"`
	Configs []ServiceConfig `json:"configs"`
}

// UpdateServiceInput is the body of PATCH /v1/services/{serviceId}, limited
// to the parts the CLI changes.
type UpdateServiceInput struct {
	// EnvironmentID is required with any config part.
	EnvironmentID string `json:"environment_id,omitempty"`
	// ExpectedVersion makes the change a 409 unless the latest config
	// version still is this one.
	ExpectedVersion int              `json:"expected_version,omitempty"`
	Cron            *CronConfigPatch `json:"cron,omitempty"`
	Placement       *PlacementPatch  `json:"placement,omitempty"`
}

// UpdatedService is the response of PATCH /v1/services/{serviceId}.
type UpdatedService struct {
	Service Service `json:"service"`
	// Config is the new config version; nil when no config part changed.
	Config *ServiceConfig `json:"config"`
}

// Variable tiers, from VARIABLE_TIERS in packages/shared.
const (
	// TierPlain values are readable by callers with variables:read_plain.
	TierPlain = "plain"
	// TierSecret values are write-only: no route ever returns them.
	TierSecret = "secret"
)

// Variable is a variable as listed. Value is set only for plain variables,
// and only when the caller may read plain values; a secret's value never
// leaves the control plane.
type Variable struct {
	Key string `json:"key"`
	// Tier is [TierPlain] or [TierSecret].
	Tier string `json:"tier"`
	// Locked means the classifier fixed the tier (a public prefix or a known
	// credential format) and no write can change it.
	Locked bool    `json:"locked"`
	Value  *string `json:"value"`
	// Fingerprint is 8 hex characters of a keyed hash of the value, equal
	// for equal values within a project, so values can be told apart
	// without being shown. Nil until the control plane has computed it.
	Fingerprint *string `json:"fingerprint"`
	// AvailableAtBuild passes the variable to builds: plain ones as build
	// args, secrets as BuildKit secrets.
	AvailableAtBuild bool `json:"available_at_build"`
	// MountAsFile delivers the value as the file /run/secrets/KEY instead
	// of an environment variable.
	MountAsFile bool  `json:"mount_as_file"`
	Version     int   `json:"version"`
	UpdatedAt   int64 `json:"updated_at"`
	// UpdatedBy is the ID of the user who last wrote the variable.
	UpdatedBy *string `json:"updated_by"`
}

// Secret reports whether v is write-only.
func (v Variable) Secret() bool { return v.Tier == TierSecret }

// VariableSet is one entry of [VariablesPut.Set]. Nil and empty fields keep
// the stored setting; for a new variable the control plane's classifier
// picks the tier and the flags default to false.
type VariableSet struct {
	Key string `json:"key"`
	// Value nil changes only the tier or flags of an existing variable.
	Value *string `json:"value,omitempty"`
	// Tier is [TierPlain], [TierSecret], or "" to let the classifier decide.
	Tier             string `json:"tier,omitempty"`
	AvailableAtBuild *bool  `json:"available_at_build,omitempty"`
	MountAsFile      *bool  `json:"mount_as_file,omitempty"`
	// ExpectedVersion, when set, fails the write with 409 if the variable
	// changed since that version.
	ExpectedVersion *int `json:"expected_version,omitempty"`
}

// VariablesPut is a bulk change to the variables of one scope.
type VariablesPut struct {
	Set    []VariableSet `json:"set"`
	Delete []string      `json:"delete"`
	// ConfirmWriteOnly acknowledges that keys becoming secret can never be
	// read back. Without it such a write fails with confirmation_required.
	ConfirmWriteOnly bool `json:"confirm_write_only,omitempty"`
	// AcknowledgePublic lists public-prefix keys (VITE_, NEXT_PUBLIC_, …)
	// to store although their value looks like a credential.
	AcknowledgePublic []string `json:"acknowledge_public,omitempty"`
}

// VariableWarning is a classifier note about one written variable.
type VariableWarning struct {
	Key string `json:"key"`
	// Code is public_prefix_secret_value, public_prefix_secret_name or
	// secret_too_short_to_redact.
	Code    string `json:"code"`
	Message string `json:"message"`
}

// VariablesPutResult is the response of a variables write: the scope's
// full list and the classifier's warnings.
type VariablesPutResult struct {
	Variables []Variable        `json:"variables"`
	Warnings  []VariableWarning `json:"warnings"`
}

// Build is an image build.
type Build struct {
	ID              string  `json:"id"`
	DeploymentID    string  `json:"deployment_id"`
	ServiceID       string  `json:"service_id"`
	CommitSHA       string  `json:"commit_sha"`
	CommitMessage   *string `json:"commit_message"`
	CommitAuthor    *string `json:"commit_author"`
	Status          string  `json:"status"`
	NodeID          *string `json:"node_id"`
	ImageRepository string  `json:"image_repository"`
	ImageDigest     *string `json:"image_digest"`
	StartedAt       *int64  `json:"started_at"`
	FinishedAt      *int64  `json:"finished_at"`
	Error           *string `json:"error"`
	CreatedAt       int64   `json:"created_at"`
}

// Deployment is a deployment, with its build when it has one.
type Deployment struct {
	ID            string  `json:"id"`
	ProjectID     string  `json:"project_id"`
	ServiceID     string  `json:"service_id"`
	EnvironmentID string  `json:"environment_id"`
	ConfigVersion int     `json:"config_version"`
	BuildID       *string `json:"build_id"`
	Build         *Build  `json:"build"`
	Image         *string `json:"image"`
	Status        string  `json:"status"`
	Trigger       string  `json:"trigger"`
	TriggeredBy   *string `json:"triggered_by"`
	RollbackOf    *string `json:"rollback_of"`
	FailureReason *string `json:"failure_reason"`
	StartedAt     *int64  `json:"started_at"`
	FinishedAt    *int64  `json:"finished_at"`
	CreatedAt     int64   `json:"created_at"`
	UpdatedAt     int64   `json:"updated_at"`
}

// DeploymentPage is a page of deployments, newest first.
type DeploymentPage struct {
	Deployments []Deployment `json:"deployments"`
	NextCursor  *string      `json:"next_cursor"`
}

// DeploymentEvent is one entry of a deployment's timeline.
type DeploymentEvent struct {
	ID           string         `json:"id"`
	DeploymentID string         `json:"deployment_id"`
	Type         string         `json:"type"`
	Message      string         `json:"message"`
	Data         map[string]any `json:"data"`
	CreatedAt    int64          `json:"created_at"`
}

// Placement is where one replica runs and its last reported state.
type Placement struct {
	ID           string  `json:"id"`
	DeploymentID string  `json:"deployment_id"`
	Replica      int     `json:"replica"`
	NodeID       string  `json:"node_id"`
	NodeName     *string `json:"node_name"`
	WorkloadID   string  `json:"workload_id"`
	ContainerID  *string `json:"container_id"`
	State        string  `json:"state"`
	LastStatusAt *int64  `json:"last_status_at"`
}

// DeploymentDetail is a deployment with its timeline and replicas.
type DeploymentDetail struct {
	Deployment
	Events     []DeploymentEvent `json:"events"`
	Placements []Placement       `json:"placements"`
}

// LogEntry is one stored log line.
type LogEntry struct {
	TS     int64  `json:"ts"`
	Stream string `json:"stream"`
	Text   string `json:"text"`
	// WorkloadID is the replica that wrote the line; empty for build logs.
	WorkloadID string `json:"workload_id,omitempty"`
}

// LogPage is a page of log lines, oldest first. NextCursor fetches the page
// before it and is nil at the beginning.
type LogPage struct {
	Lines      []LogEntry `json:"lines"`
	NextCursor *string    `json:"next_cursor"`
}

// Domain is a hostname routed to a service.
type Domain struct {
	ID                 string `json:"id"`
	ServiceID          string `json:"service_id"`
	EnvironmentID      string `json:"environment_id"`
	Hostname           string `json:"hostname"`
	URL                string `json:"url"`
	Type               string `json:"type"`
	TargetPort         int    `json:"target_port"`
	VerificationStatus string `json:"verification_status"`
	TLSStatus          string `json:"tls_status"`
	// Status is the domain's overall state, e.g. "pending_dns" or "active".
	Status string `json:"status"`
	// Apex is set for a bare domain (example.com), which needs A/AAAA records.
	Apex bool `json:"apex"`
	// Records are the DNS records a custom domain needs, with what was found.
	Records []DNSRecord `json:"records"`
	Error   *string     `json:"error"`
	// Wildcard is set for *.example.com.
	Wildcard bool `json:"wildcard"`
	// HSTS is the policy in effect: a custom domain's own, else the default.
	HSTS DomainHSTS `json:"hsts"`
	// TLS is the certificate serving the domain, with each node's state.
	TLS DomainTLS `json:"tls"`
	// RoutingNodes are the ingress servers in the service's workspace that
	// DNS may point at.
	RoutingNodes []DomainRoutingNode `json:"routing_nodes"`
	// LastCheckedAt, NextCheckAt and VerifiedAt are millisecond timestamps.
	LastCheckedAt *int64 `json:"last_checked_at"`
	NextCheckAt   *int64 `json:"next_check_at"`
	VerifiedAt    *int64 `json:"verified_at"`
	CreatedAt     int64  `json:"created_at"`
}

// DomainHSTS is a domain's Strict-Transport-Security policy.
type DomainHSTS struct {
	Enabled bool `json:"enabled"`
	// MaxAge is in seconds.
	MaxAge            int  `json:"max_age"`
	IncludeSubdomains bool `json:"include_subdomains"`
	Preload           bool `json:"preload"`
}

// DomainTLS is the certificate serving a domain.
type DomainTLS struct {
	// Status is "pending", "issued", "failed" or "disabled".
	Status string  `json:"status"`
	Issuer *string `json:"issuer"`
	// NotBefore, NotAfter and UpdatedAt are millisecond timestamps.
	NotBefore *int64  `json:"not_before"`
	NotAfter  *int64  `json:"not_after"`
	Error     *string `json:"error"`
	UpdatedAt *int64  `json:"updated_at"`
	// Nodes is each serving node's state; empty in internal and off modes.
	Nodes []DomainTLSNode `json:"nodes"`
}

// DomainTLSNode is one ingress node's certificate state for a domain.
type DomainTLSNode struct {
	NodeID string `json:"node_id"`
	Name   string `json:"name"`
	// State is "pending", "issued" or "failed".
	State string  `json:"state"`
	Error *string `json:"error"`
}

// DomainRoutingNode is a server a domain's DNS may point at.
type DomainRoutingNode struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	PublicIP *string `json:"public_ip"`
	// Serves is set when the server runs a replica of the service. Until
	// servers route to each other's replicas, only these answer.
	Serves bool `json:"serves"`
}

// DNSRecord is one DNS record a domain needs and the state it was found in.
type DNSRecord struct {
	// Type is CNAME, A, AAAA or TXT.
	Type  string `json:"type"`
	Name  string `json:"name"`
	Value string `json:"value"`
	// Purpose is "routing", "ownership" or, for a wildcard, "acme_delegation".
	Purpose string `json:"purpose"`
	// State is "unknown", "ok", "missing" or "wrong".
	State string  `json:"state"`
	Note  *string `json:"note"`
}

// CostEstimate is a monthly price in the smallest unit of Currency.
type CostEstimate struct {
	MonthlyCents int    `json:"monthly_cents"`
	Currency     string `json:"currency"`
}

// Node is a server running the node agent.
type Node struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Hostname *string `json:"hostname"`
	Status   string  `json:"status"`
	Provider string  `json:"provider"`
	Region   *string `json:"region"`
	// ProviderServerID is the cloud server's ID when Roundhouse provisioned it.
	ProviderServerID *string `json:"provider_server_id"`
	// ProviderServerMissingAt is when the provider first reported that
	// server gone, in Unix milliseconds.
	ProviderServerMissingAt *int64 `json:"provider_server_missing_at"`
	// EstimatedMonthlyCost is the provider's price for a provisioned server.
	EstimatedMonthlyCost *CostEstimate `json:"estimated_monthly_cost"`
	PublicIP             *string       `json:"public_ip"`
	OS                   *string       `json:"os"`
	Arch                 *string       `json:"arch"`
	Kernel               *string       `json:"kernel"`
	DockerVersion        *string       `json:"docker_version"`
	AgentVersion         *string       `json:"agent_version"`
	// WorkloadsBlocked says why the server takes no workloads, e.g.
	// "upgrade_agent"; nil when it takes them.
	WorkloadsBlocked *string         `json:"workloads_blocked"`
	Capabilities     json.RawMessage `json:"capabilities"`
	CPUTotal         *float64        `json:"cpu_total"`
	MemTotal         *float64        `json:"mem_total"`
	DiskTotal        *float64        `json:"disk_total"`
	CPUPercent       *float64        `json:"cpu_percent"`
	MemUsed          *float64        `json:"mem_used"`
	DiskUsed         *float64        `json:"disk_used"`
	Load1            *float64        `json:"load1"`
	LastHeartbeatAt  *int64          `json:"last_heartbeat_at"`
	CreatedAt        int64           `json:"created_at"`
}

// JoinToken is a single-use node join token and the command that uses it.
type JoinToken struct {
	Token          string `json:"token"`
	ExpiresAt      int64  `json:"expires_at"`
	InstallCommand string `json:"install_command"`
}

// ResolvedVariables is the response of GET
// /v1/services/{serviceId}/variables/resolved: a service's plain environment
// as a deployment would get it. Secret values never leave the control plane.
type ResolvedVariables struct {
	// Variables maps each plain key, built-ins included, to its resolved
	// value.
	Variables map[string]string `json:"variables"`
	// LocalKeys are the secret and secret-derived keys left out of
	// Variables, sorted; a local .env file supplies them.
	LocalKeys []string `json:"local_keys"`
}

// APITokenCreator is the member who created an API token.
type APITokenCreator struct {
	UserID string  `json:"user_id"`
	Name   *string `json:"name"`
}

// APIToken is a workspace API token as listed; its secret is never returned
// after creation.
type APIToken struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Scopes []string `json:"scopes"`
	// Prefix is `tok_` and the next four characters of the secret.
	Prefix    *string          `json:"prefix"`
	CreatedBy *APITokenCreator `json:"created_by"`
	// LastUsedAt, ExpiresAt and RevokedAt are millisecond timestamps.
	LastUsedAt *int64 `json:"last_used_at"`
	// ExpiresAt is nil for a token that never expires.
	ExpiresAt *int64 `json:"expires_at"`
	RevokedAt *int64 `json:"revoked_at"`
	CreatedAt int64  `json:"created_at"`
}

// State is "revoked", "expired" or "active" at now (milliseconds).
func (t *APIToken) State(now int64) string {
	switch {
	case t.RevokedAt != nil:
		return "revoked"
	case t.ExpiresAt != nil && *t.ExpiresAt <= now:
		return "expired"
	}
	return "active"
}

// CreateAPITokenInput is the body of POST /v1/workspaces/{workspaceId}/tokens.
type CreateAPITokenInput struct {
	Name   string   `json:"name"`
	Scopes []string `json:"scopes"`
	// ExpiresInDays is 1..[MaxAPITokenDays]; nil (sent as null) never expires.
	ExpiresInDays *int `json:"expires_in_days"`
}

// CreatedAPIToken is the response of POST /v1/workspaces/{workspaceId}/tokens.
type CreatedAPIToken struct {
	Token APIToken `json:"token"`
	// Secret is the `tok_…` value, returned this once. SECURITY: print it
	// only to stdout, never to logs or files.
	Secret string `json:"secret"`
}

// MaxAPITokenDays is the longest token lifetime the API accepts
// (MAX_API_TOKEN_TTL_DAYS).
const MaxAPITokenDays = 366

// APITokenScopes are the scopes a token may carry, from API_TOKEN_SCOPES in
// packages/shared/src/tokens.ts (every RBAC action but the instance ones).
var APITokenScopes = []string{
	"workspace:read", "workspace:update", "workspace:delete",
	"members:read", "members:manage", "tokens:manage",
	"nodes:read", "nodes:manage", "audit:read",
	"projects:create", "github:manage",
	"projects:read", "projects:manage", "access:manage",
	"services:read", "services:manage", "deployments:create",
	"variables:read", "variables:read_plain", "variables:manage",
	"data:read", "data:write", "backups:manage", "backups:restore",
	"changes:approve", "changes:auto_apply", "shell:open",
}

// APITokenPresets are the named scope sets of API_TOKEN_PRESETS.
var APITokenPresets = map[string][]string{
	"read": {"workspace:read", "projects:read", "services:read", "variables:read", "nodes:read"},
	"deploy": {"workspace:read", "projects:read", "services:read", "variables:read", "nodes:read",
		"services:manage", "deployments:create", "variables:manage"},
}

// CreateProjectInput is the body of POST /v1/workspaces/{workspaceId}/projects.
type CreateProjectInput struct {
	Name        string `json:"name"`
	Slug        string `json:"slug,omitempty"`
	Description string `json:"description,omitempty"`
}

// CreateServiceInput is the body of POST /v1/projects/{projectId}/services.
type CreateServiceInput struct {
	Name   string        `json:"name"`
	Slug   string        `json:"slug,omitempty"`
	Kind   string        `json:"kind,omitempty"`
	Source ServiceSource `json:"source"`
	// Config holds overrides of the default config; nil sends none.
	Config map[string]any `json:"config,omitempty"`
}

// Deployment statuses, from DEPLOYMENT_STATUSES in packages/shared.
const (
	StatusQueued     = "queued"
	StatusBuilding   = "building"
	StatusDeploying  = "deploying"
	StatusActive     = "active"
	StatusFailed     = "failed"
	StatusCrashed    = "crashed"
	StatusCancelled  = "cancelled"
	StatusRemoved    = "removed"
	StatusRolledBack = "rolled_back"
)

// IsSettled reports whether a deployment has stopped progressing: it is
// active, or it ended. A deploy watcher stops at a settled status.
func IsSettled(status string) bool {
	return status != StatusQueued && status != StatusBuilding && status != StatusDeploying
}

// IsSuccess reports whether a settled deployment came up. `removed` and
// `rolled_back` are only reachable from `active`, so they count as success:
// the deployment ran and was superseded.
func IsSuccess(status string) bool {
	return status == StatusActive || status == StatusRemoved || status == StatusRolledBack
}

// IsCancellable mirrors CANCELLABLE_DEPLOYMENT_STATUSES.
func IsCancellable(status string) bool {
	return !IsSettled(status)
}

// IsRollbackSource mirrors ROLLBACK_SOURCE_STATUSES.
func IsRollbackSource(status string) bool {
	return slices.Contains([]string{StatusActive, StatusCrashed, StatusRemoved, StatusRolledBack}, status)
}

// IsBuildFinished reports whether a build status is terminal.
func IsBuildFinished(status string) bool {
	return status == "succeeded" || status == "failed" || status == "cancelled"
}

// -----------------------------------------------------------------------------
// Cloud providers
// -----------------------------------------------------------------------------

// ProviderIDs are the cloud providers the control plane can provision on,
// from PROVIDER_IDS in packages/providers.
var ProviderIDs = []string{"hetzner", "digitalocean", "vultr", "linode"}

// ProviderIntegration is a workspace's connection to one cloud provider. The
// token itself is write-only and never returned.
type ProviderIntegration struct {
	Provider    string `json:"provider"`
	DisplayName string `json:"display_name"`
	Connected   bool   `json:"connected"`
	// AccountLabel is the account name or email the provider reported.
	AccountLabel     *string `json:"account_label"`
	TokenFingerprint *string `json:"token_fingerprint"`
	TokenLast4       *string `json:"token_last4"`
	LastValidatedAt  *int64  `json:"last_validated_at"`
	UpdatedAt        *int64  `json:"updated_at"`
}

// ProviderOffer is one orderable plan in one region, priced as the provider
// bills it.
type ProviderOffer struct {
	ID          string  `json:"id"`
	Plan        string  `json:"plan"`
	Description string  `json:"description"`
	Category    *string `json:"category"`
	Region      string  `json:"region"`
	RegionName  string  `json:"region_name"`
	Country     *string `json:"country"`
	VCPUs       int     `json:"vcpus"`
	MemoryMiB   int     `json:"memory_mib"`
	DiskGB      int     `json:"disk_gb"`
	Arch        string  `json:"arch"`
	Dedicated   bool    `json:"dedicated"`
	// MonthlyCents is the monthly price in the smallest unit of Currency.
	MonthlyCents      int      `json:"monthly_cents"`
	Currency          string   `json:"currency"`
	IncludedTrafficTB *float64 `json:"included_traffic_tb"`
	Deprecated        bool     `json:"deprecated"`
	UnavailableAfter  *string  `json:"unavailable_after"`
}

// OfferRecommendation suggests one offer, with why.
type OfferRecommendation struct {
	OfferID string `json:"offer_id"`
	Reason  string `json:"reason"`
}

// ProviderOffers is a provider's live offers for a role and the recommended
// picks, the first being the default.
type ProviderOffers struct {
	Provider        string                `json:"provider"`
	Role            string                `json:"role"`
	Offers          []ProviderOffer       `json:"offers"`
	Recommendations []OfferRecommendation `json:"recommendations"`
	FetchedAt       int64                 `json:"fetched_at"`
}

// Offer returns the offer with this ID, or nil.
func (o *ProviderOffers) Offer(id string) *ProviderOffer {
	for i := range o.Offers {
		if o.Offers[i].ID == id {
			return &o.Offers[i]
		}
	}
	return nil
}

// ProvisionNodeInput is the body of POST
// /v1/workspaces/{workspaceId}/nodes/provision.
type ProvisionNodeInput struct {
	Provider string `json:"provider"`
	Plan     string `json:"plan"`
	Region   string `json:"region"`
	// Name is the server's name: a lowercase DNS label.
	Name    string `json:"name"`
	Builder bool   `json:"builder"`
}

// NodeProvision is one one-click provisioning run.
type NodeProvision struct {
	ID       string `json:"id"`
	Provider string `json:"provider"`
	Name     string `json:"name"`
	Plan     string `json:"plan"`
	Region   string `json:"region"`
	Builder  bool   `json:"builder"`
	// Status is one of the ProvisionStatus constants.
	Status string `json:"status"`
	// Step is the latest provider step, e.g. "create_server".
	Step           *string `json:"step"`
	FailureReason  *string `json:"failure_reason"`
	FailureMessage *string `json:"failure_message"`
	// ServerID is the cloud server's ID once the provider created it.
	ServerID *string `json:"server_id"`
	IPv4     *string `json:"ipv4"`
	IPv6     *string `json:"ipv6"`
	// NodeID is set once the server's agent joined.
	NodeID *string `json:"node_id"`
	// CancelRequestedAt is when someone asked to cancel the run.
	CancelRequestedAt    *int64        `json:"cancel_requested_at"`
	EstimatedMonthlyCost *CostEstimate `json:"estimated_monthly_cost"`
	CreatedAt            int64         `json:"created_at"`
	UpdatedAt            int64         `json:"updated_at"`
	FinishedAt           *int64        `json:"finished_at"`
}

// Provisioning run statuses, from NODE_PROVISION_STATUSES.
const (
	ProvisionQueued        = "queued"
	ProvisionCreating      = "creating"
	ProvisionBooting       = "booting"
	ProvisionJoined        = "joined"
	ProvisionFailed        = "failed"
	ProvisionCancelled     = "cancelled"
	ProvisionCleanupFailed = "cleanup_failed"
)

// ProvisionStatuses lists every provisioning run status.
var ProvisionStatuses = []string{
	ProvisionQueued, ProvisionCreating, ProvisionBooting,
	ProvisionJoined, ProvisionFailed, ProvisionCancelled, ProvisionCleanupFailed,
}

// IsProvisionFinished reports whether a provisioning run has stopped: the
// server joined, or the run failed or was cancelled.
func IsProvisionFinished(status string) bool {
	return status == ProvisionJoined || status == ProvisionFailed || status == ProvisionCancelled || status == ProvisionCleanupFailed
}

// -----------------------------------------------------------------------------
// Templates
// -----------------------------------------------------------------------------

// Template input types, from TEMPLATE_INPUT_TYPES in packages/shared.
const (
	InputString  = "string"
	InputSecret  = "secret"
	InputNumber  = "number"
	InputBoolean = "boolean"
	InputSelect  = "select"
)

// TemplateInputTypes lists every template input type.
var TemplateInputTypes = []string{InputString, InputSecret, InputNumber, InputBoolean, InputSelect}

// TemplateSummary is a template as the gallery lists it.
type TemplateSummary struct {
	ID string `json:"id"`
	// Version is bumped whenever the template changes.
	Version     int    `json:"version"`
	Name        string `json:"name"`
	Description string `json:"description"`
	// Icon is `builtin:<name>` for an icon the dashboard ships, or an https URL.
	Icon         *string  `json:"icon"`
	Category     string   `json:"category"`
	Tags         []string `json:"tags"`
	DocsURL      *string  `json:"docs_url"`
	ServiceCount int      `json:"service_count"`
	// Requirements are platform features the template needs beyond plain
	// services: "databases", "volumes".
	Requirements []string `json:"requirements"`
	// Supported is false when the control plane lacks a requirement;
	// deploying then answers 409.
	Supported bool `json:"supported"`
}

// TemplateInput is a value the deployer supplies.
type TemplateInput struct {
	Key         string  `json:"key"`
	Label       string  `json:"label"`
	Description *string `json:"description"`
	// Type is one of [TemplateInputTypes].
	Type     string `json:"type"`
	Required bool   `json:"required"`
	// Default is used when the input is left empty; never set for secrets.
	Default *string `json:"default"`
	// Options are the choices of a select input.
	Options []string `json:"options"`
}

// TemplateVariable is a variable a template sets.
type TemplateVariable struct {
	Key string `json:"key"`
	// Secret means it is stored write-only: generated, marked secret, or
	// filled from a secret input.
	Secret bool `json:"secret"`
	// Generated means a fresh value is minted on every deploy.
	Generated bool `json:"generated"`
	// Value is as written, references and `${{input.KEY}}` included; nil
	// for secret variables.
	Value       *string `json:"value"`
	Description *string `json:"description"`
}

// TemplateSource says where a template service's code comes from: an image,
// a git repository, or a database engine.
type TemplateSource struct {
	// Type is "image", "git" or "database".
	Type    string `json:"type"`
	Image   string `json:"image,omitempty"`
	RepoURL string `json:"repo_url,omitempty"`
	Branch  string `json:"branch,omitempty"`
	RootDir string `json:"root_dir,omitempty"`
	Engine  string `json:"engine,omitempty"`
	// Version is the database engine's major version, nil for the default.
	Version *string `json:"version,omitempty"`
}

// MarshalJSON writes only the fields of the source's type, keeping a
// database source's `"version": null`.
func (s TemplateSource) MarshalJSON() ([]byte, error) {
	switch s.Type {
	case "image":
		return json.Marshal(map[string]any{"type": s.Type, "image": s.Image})
	case "git":
		return json.Marshal(map[string]any{"type": s.Type, "repo_url": s.RepoURL, "branch": s.Branch, "root_dir": s.RootDir})
	case "database":
		return json.Marshal(map[string]any{"type": s.Type, "engine": s.Engine, "version": s.Version})
	}
	type plain TemplateSource
	return json.Marshal(plain(s))
}

// TemplateService is one service a template creates.
type TemplateService struct {
	// Ref is the default slug; suffixed -2, -3, … when taken in the project.
	Ref    string         `json:"ref"`
	Name   string         `json:"name"`
	Kind   string         `json:"kind"`
	Icon   *string        `json:"icon"`
	Source TemplateSource `json:"source"`
	// Port is the port the service listens on, or nil for no listener.
	Port *int `json:"port"`
	// Public means it gets a public generated hostname.
	Public       bool               `json:"public"`
	StartCommand *string            `json:"start_command"`
	Variables    []TemplateVariable `json:"variables"`
}

// TemplateDetail is a template with everything a deploy needs.
type TemplateDetail struct {
	TemplateSummary
	Inputs          []TemplateInput    `json:"inputs"`
	Services        []TemplateService  `json:"services"`
	SharedVariables []TemplateVariable `json:"shared_variables"`
}

// TemplateDeployOptions are the fields both template deploy bodies share.
type TemplateDeployOptions struct {
	// Inputs are values for the template's inputs, by key.
	Inputs map[string]string `json:"inputs"`
	// Deploy starts a first deployment of every created service.
	Deploy bool `json:"deploy"`
	// ConfirmWriteOnly acknowledges that generated and secret variables
	// become write-only. Without it a template that sets any fails with
	// confirmation_required.
	ConfirmWriteOnly bool `json:"confirm_write_only"`
	// AcknowledgePublic lists public-prefix keys to store although their
	// value looks like a credential.
	AcknowledgePublic []string `json:"acknowledge_public,omitempty"`
}

// CreateProjectFromTemplateInput is the body of POST
// /v1/workspaces/{workspaceId}/projects/from-template.
type CreateProjectFromTemplateInput struct {
	TemplateID string `json:"template_id"`
	// Name is the project's name; the template's when empty.
	Name string `json:"name,omitempty"`
	// Slug is derived from the name when empty; -2, -3, … is added when taken.
	Slug        string `json:"slug,omitempty"`
	Description string `json:"description,omitempty"`
	TemplateDeployOptions
}

// DeployTemplateInput is the body of POST
// /v1/projects/{projectId}/templates/deploy.
type DeployTemplateInput struct {
	TemplateID string `json:"template_id"`
	// EnvironmentID gets the template's variables and first deployments.
	EnvironmentID string `json:"environment_id"`
	TemplateDeployOptions
}

// TemplateRef names one version of a template.
type TemplateRef struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
}

// TemplateDeployError is a service whose first deployment could not start.
// The service exists regardless.
type TemplateDeployError struct {
	ServiceID string `json:"service_id"`
	Message   string `json:"message"`
}

// TemplateDeployment is what deploying a template created.
type TemplateDeployment struct {
	Template    TemplateRef `json:"template"`
	Project     Project     `json:"project"`
	Environment Environment `json:"environment"`
	// Services are the created services, in template order.
	Services []Service `json:"services"`
	// Deployments are the first deployments that started; empty when
	// Deploy was false.
	Deployments  []Deployment          `json:"deployments"`
	DeployErrors []TemplateDeployError `json:"deploy_errors"`
	Warnings     []VariableWarning     `json:"warnings"`
}
