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
	CreatedAt    int64   `json:"created_at"`
}

// Service is a service of a project. Its config lives per environment.
type Service struct {
	ID        string  `json:"id"`
	ProjectID string  `json:"project_id"`
	Name      string  `json:"name"`
	Slug      string  `json:"slug"`
	Kind      string  `json:"kind"`
	Icon      *string `json:"icon"`
	CreatedAt int64   `json:"created_at"`
	UpdatedAt int64   `json:"updated_at"`
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
}

// CreatedService is the response of POST /v1/projects/{projectId}/services.
type CreatedService struct {
	Service Service         `json:"service"`
	Configs []ServiceConfig `json:"configs"`
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
	CreatedAt          int64  `json:"created_at"`
}

// Node is a server running the node agent.
type Node struct {
	ID              string          `json:"id"`
	Name            string          `json:"name"`
	Hostname        *string         `json:"hostname"`
	Status          string          `json:"status"`
	Provider        string          `json:"provider"`
	Region          *string         `json:"region"`
	PublicIP        *string         `json:"public_ip"`
	OS              *string         `json:"os"`
	Arch            *string         `json:"arch"`
	Kernel          *string         `json:"kernel"`
	DockerVersion   *string         `json:"docker_version"`
	AgentVersion    *string         `json:"agent_version"`
	Capabilities    json.RawMessage `json:"capabilities"`
	CPUTotal        *float64        `json:"cpu_total"`
	MemTotal        *float64        `json:"mem_total"`
	DiskTotal       *float64        `json:"disk_total"`
	CPUPercent      *float64        `json:"cpu_percent"`
	MemUsed         *float64        `json:"mem_used"`
	DiskUsed        *float64        `json:"disk_used"`
	Load1           *float64        `json:"load1"`
	LastHeartbeatAt *int64          `json:"last_heartbeat_at"`
	CreatedAt       int64           `json:"created_at"`
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
