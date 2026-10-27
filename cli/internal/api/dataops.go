package api

import (
	"context"
	"net/http"
)

// Volume migration, TCP proxy and credential rotation routes (ADR 0004).
var (
	RouteMigrationTargets    = Route{http.MethodGet, "/v1/volumes/{volumeId}/migration-targets"}
	RouteMigrateVolume       = Route{http.MethodPost, "/v1/volumes/{volumeId}/migrate"}
	RouteVolumeMigrations    = Route{http.MethodGet, "/v1/volumes/{volumeId}/migrations"}
	RouteGetVolumeMigration  = Route{http.MethodGet, "/v1/volume-migrations/{migrationId}"}
	RouteGetTCPProxy         = Route{http.MethodGet, "/v1/services/{serviceId}/tcp-proxies"}
	RoutePutTCPProxy         = Route{http.MethodPut, "/v1/services/{serviceId}/tcp-proxies"}
	RouteDeleteTCPProxy      = Route{http.MethodDelete, "/v1/services/{serviceId}/tcp-proxies"}
	RouteRotateCredentials   = Route{http.MethodPost, "/v1/services/{serviceId}/database/rotate-credentials"}
	RouteCredentialRotations = Route{http.MethodGet, "/v1/services/{serviceId}/database/credential-rotations"}
)

// VolumeMigrationPhases are where a migration is, in order, from
// VOLUME_MIGRATION_PHASES in packages/shared/src/data-services.ts.
// rolling_back puts the service back on its source node after a failure.
var VolumeMigrationPhases = []string{"queued", "preparing_target", "stopping", "copying_out", "copying_in", "starting", "done", "rolling_back"}

// Volume migration statuses, which are RESTORE_STATUSES.
const (
	MigrationQueued    = "queued"
	MigrationRunning   = "running"
	MigrationSucceeded = "succeeded"
	MigrationFailed    = "failed"
)

// MigrationStatuses lists every volume migration status, in the API's order.
var MigrationStatuses = []string{MigrationQueued, MigrationRunning, MigrationSucceeded, MigrationFailed}

// DatabasePrincipals are the principals a credential rotation changes, from
// DATABASE_PRINCIPALS in packages/shared/src/databases.ts.
var DatabasePrincipals = []string{"admin", "app", "readonly"}

// Credential rotation statuses, from CREDENTIAL_ROTATION_STATUSES.
const (
	RotationRunning   = "running"
	RotationSucceeded = "succeeded"
	RotationFailed    = "failed"
)

// RotationStatuses lists every credential rotation status, in the API's
// order.
var RotationStatuses = []string{RotationRunning, RotationSucceeded, RotationFailed}

// TCP proxy statuses.
const (
	// TCPProxyActive is published behind the allowlist.
	TCPProxyActive = "active"
	// TCPProxyPending is not placed yet, or waiting for a deploy.
	TCPProxyPending = "pending"
	// TCPProxyUnsupported means the node's agent cannot enforce an
	// allowlist, so nothing is published until it is upgraded.
	TCPProxyUnsupported = "unsupported"
)

// TCPProxyStatuses lists every TCP proxy status, in the API's order.
var TCPProxyStatuses = []string{TCPProxyActive, TCPProxyPending, TCPProxyUnsupported}

// MaxTCPProxyCIDRs is the most sources one TCP proxy admits, from
// MAX_TCP_PROXY_CIDRS.
const MaxTCPProxyCIDRs = 64

// MigrateVolumeInput is the body of POST /v1/volumes/{volumeId}/migrate.
type MigrateVolumeInput struct {
	TargetNodeID string `json:"target_node_id"`
	// Confirm must equal the service's slug.
	Confirm string `json:"confirm"`
}

// VolumeMigration is one move of a volume to another node.
type VolumeMigration struct {
	ID            string  `json:"id"`
	VolumeID      string  `json:"volume_id"`
	ServiceID     string  `json:"service_id"`
	EnvironmentID string  `json:"environment_id"`
	SourceNodeID  *string `json:"source_node_id"`
	TargetNodeID  *string `json:"target_node_id"`
	Status        string  `json:"status"`
	// Phase is one of [VolumeMigrationPhases].
	Phase string `json:"phase"`
	// BackupID is the snapshot that carried the data; kept for 72 hours.
	BackupID *string `json:"backup_id"`
	// DeploymentID is the redeploy on the target node.
	DeploymentID *string  `json:"deployment_id"`
	CopiedBytes  *float64 `json:"copied_bytes"`
	Error        *string  `json:"error"`
	RequestedBy  *string  `json:"requested_by"`
	// CleanupAfter is when the node left with an unused copy deletes it.
	CleanupAfter *int64 `json:"cleanup_after"`
	StartedAt    *int64 `json:"started_at"`
	FinishedAt   *int64 `json:"finished_at"`
	CreatedAt    int64  `json:"created_at"`
}

// MigrationTarget is a node a volume could move to.
type MigrationTarget struct {
	NodeID   string `json:"node_id"`
	Name     string `json:"name"`
	Eligible bool   `json:"eligible"`
	// Reason says why the node cannot take the volume; nil when eligible.
	Reason    *string `json:"reason"`
	QuotaMode *string `json:"quota_mode"`
}

// MigrationTargets lists the nodes a volume can move to.
type MigrationTargets struct {
	VolumeID     string  `json:"volume_id"`
	SourceNodeID *string `json:"source_node_id"`
	// EstimatedDowntimeMS is how long the service is expected to be down:
	// the copy out and in, plus a restart.
	EstimatedDowntimeMS int64             `json:"estimated_downtime_ms"`
	Targets             []MigrationTarget `json:"targets"`
}

// VolumeMigrationList is a volume's recent migrations, newest first.
type VolumeMigrationList struct {
	Migrations []VolumeMigration `json:"migrations"`
}

// PutTCPProxyInput is the body of PUT /v1/services/{serviceId}/tcp-proxies.
type PutTCPProxyInput struct {
	EnvironmentID string `json:"environment_id"`
	// ContainerPort is the service's networking port when zero.
	ContainerPort int `json:"container_port,omitempty"`
	// AllowedCIDRs are the sources allowed to connect: IPv4 or IPv6 CIDRs,
	// or bare addresses.
	AllowedCIDRs []string `json:"allowed_cidrs"`
	// AcknowledgeOpen is required to admit every address (0.0.0.0/0 or
	// ::/0).
	AcknowledgeOpen bool `json:"acknowledge_open,omitempty"`
}

// TCPProxy is a service's published TCP port in one environment.
type TCPProxy struct {
	ID            string   `json:"id"`
	ServiceID     string   `json:"service_id"`
	EnvironmentID string   `json:"environment_id"`
	ContainerPort int      `json:"container_port"`
	PublicPort    int      `json:"public_port"`
	AllowedCIDRs  []string `json:"allowed_cidrs"`
	// Host is the node's public hostname or IP; nil until the service is
	// placed.
	Host   *string `json:"host"`
	NodeID *string `json:"node_id"`
	// Status is one of [TCPProxyStatuses].
	Status string `json:"status"`
	// OpenToAll is set when the allowlist admits every address.
	OpenToAll bool  `json:"open_to_all"`
	CreatedAt int64 `json:"created_at"`
	UpdatedAt int64 `json:"updated_at"`
}

// RotateCredentialsInput is the body of POST
// /v1/services/{serviceId}/database/rotate-credentials.
type RotateCredentialsInput struct {
	EnvironmentID string `json:"environment_id"`
	// Principals defaults to every principal the engine has.
	Principals []string `json:"principals,omitempty"`
	// Confirm must equal the service's slug.
	Confirm string `json:"confirm"`
}

// CredentialRotation is one rotation of a database's passwords. It never
// carries a password.
type CredentialRotation struct {
	ID            string   `json:"id"`
	ServiceID     string   `json:"service_id"`
	EnvironmentID string   `json:"environment_id"`
	Status        string   `json:"status"`
	Principals    []string `json:"principals"`
	// Applied are the principals whose new password the database accepted.
	Applied []string `json:"applied"`
	// ChangeSetID is the change set that stored the new passwords.
	ChangeSetID   *string  `json:"change_set_id"`
	DeploymentIDs []string `json:"deployment_ids"`
	Error         *string  `json:"error"`
	RequestedBy   *string  `json:"requested_by"`
	CreatedAt     int64    `json:"created_at"`
	FinishedAt    *int64   `json:"finished_at"`
}

// CredentialRotationList is a database's recent rotations, newest first.
type CredentialRotationList struct {
	Rotations []CredentialRotation `json:"rotations"`
}

// MigrationTargets lists the nodes a volume could move to, why each
// ineligible one cannot take it, and the expected downtime.
func (c *Client) MigrationTargets(ctx context.Context, volumeID string) (*MigrationTargets, error) {
	return fetch[MigrationTargets](ctx, c, RouteMigrationTargets, nil, nil, volumeID)
}

// MigrateVolume starts moving a volume to another node; the service is down
// for the whole copy. It needs a fresh session (403 reauth_required).
func (c *Client) MigrateVolume(ctx context.Context, volumeID string, in MigrateVolumeInput) (*VolumeMigration, error) {
	return fetch[VolumeMigration](ctx, c, RouteMigrateVolume, nil, in, volumeID)
}

// VolumeMigrations lists a volume's recent migrations, newest first.
func (c *Client) VolumeMigrations(ctx context.Context, volumeID string) (*VolumeMigrationList, error) {
	return fetch[VolumeMigrationList](ctx, c, RouteVolumeMigrations, nil, nil, volumeID)
}

// GetVolumeMigration returns one volume migration.
func (c *Client) GetVolumeMigration(ctx context.Context, migrationID string) (*VolumeMigration, error) {
	return fetch[VolumeMigration](ctx, c, RouteGetVolumeMigration, nil, nil, migrationID)
}

// TCPProxy returns a service's TCP proxy in an environment; 404 when it has
// none.
func (c *Client) TCPProxy(ctx context.Context, serviceID, environmentID string) (*TCPProxy, error) {
	return fetch[TCPProxy](ctx, c, RouteGetTCPProxy, envQuery(environmentID), nil, serviceID)
}

// PutTCPProxy publishes a service's TCP port behind a source allowlist, or
// changes the allowlist. It needs a fresh session (403 reauth_required).
func (c *Client) PutTCPProxy(ctx context.Context, serviceID string, in PutTCPProxyInput) (*TCPProxy, error) {
	return fetch[TCPProxy](ctx, c, RoutePutTCPProxy, nil, in, serviceID)
}

// DeleteTCPProxy stops publishing a service's TCP port in an environment.
func (c *Client) DeleteTCPProxy(ctx context.Context, serviceID, environmentID string) error {
	return c.call(ctx, RouteDeleteTCPProxy, envQuery(environmentID), nil, nil, serviceID)
}

// RotateCredentials rotates a database's passwords and redeploys every
// service using them, the database included. It needs a fresh session (403
// reauth_required). A rotation interrupted after the engine accepted a
// password is finished by the next call; 409 while another call runs it.
func (c *Client) RotateCredentials(ctx context.Context, serviceID string, in RotateCredentialsInput) (*CredentialRotation, error) {
	return fetch[CredentialRotation](ctx, c, RouteRotateCredentials, nil, in, serviceID)
}

// CredentialRotations lists a database's recent credential rotations in an
// environment, newest first.
func (c *Client) CredentialRotations(ctx context.Context, serviceID, environmentID string) (*CredentialRotationList, error) {
	return fetch[CredentialRotationList](ctx, c, RouteCredentialRotations, envQuery(environmentID), nil, serviceID)
}
