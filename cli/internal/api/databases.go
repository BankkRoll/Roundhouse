package api

import (
	"context"
	"net/http"
)

// Database, volume and data-browser routes (ADR 0004).
var (
	RouteCreateDatabase = Route{http.MethodPost, "/v1/projects/{projectId}/databases"}
	RouteServiceVolume  = Route{http.MethodGet, "/v1/services/{serviceId}/volume"}
	RouteResizeVolume   = Route{http.MethodPatch, "/v1/volumes/{volumeId}"}
	RouteDeleteVolume   = Route{http.MethodDelete, "/v1/volumes/{volumeId}"}
	RouteUndeleteVolume = Route{http.MethodPost, "/v1/volumes/{volumeId}/undelete"}
	RouteDatabaseQuery  = Route{http.MethodPost, "/v1/services/{serviceId}/database/query"}
	RouteDatabaseSchema = Route{http.MethodGet, "/v1/services/{serviceId}/database/schema"}
)

// DatabaseEngines are the engines a database service runs, from
// SERVICE_DATABASE_ENGINES in packages/shared/src/databases.ts.
var DatabaseEngines = []string{"postgres", "mysql", "redis", "mongodb"}

// Volume size bounds in MiB, from MIN_VOLUME_MB, MAX_VOLUME_MB and
// DEFAULT_DATABASE_VOLUME_MB.
const (
	MinVolumeMB     = 256
	MaxVolumeMB     = 1_048_576
	DefaultVolumeMB = 5120
)

// Data-browser bounds, from MAX_DB_QUERY_ROWS and MAX_DB_QUERY_TIMEOUT_MS in
// packages/protocol, and the API's defaults.
const (
	MaxQueryRows          = 1000
	DefaultQueryRows      = 100
	MinQueryTimeoutMS     = 100
	MaxQueryTimeoutMS     = 30_000
	DefaultQueryTimeoutMS = 10_000
)

// Volume statuses, from VOLUME_STATUSES in packages/shared.
const (
	VolumePending         = "pending"
	VolumeReady           = "ready"
	VolumePendingDeletion = "pending_deletion"
)

// VolumeStatuses lists every volume status, in the API's order.
var VolumeStatuses = []string{"pending", "ready", "migrating", "degraded", "pending_deletion", "deleted", "abandoned", "error"}

// ServiceDatabase is the engine and version a database service runs.
type ServiceDatabase struct {
	Engine  string `json:"engine"`
	Version string `json:"version"`
}

// CreateDatabaseInput is the body of POST /v1/projects/{projectId}/databases.
type CreateDatabaseInput struct {
	Engine string `json:"engine"`
	// Version is the engine's default when empty.
	Version string `json:"version,omitempty"`
	// SizeMB is DefaultVolumeMB when zero.
	SizeMB        int    `json:"size_mb,omitempty"`
	EnvironmentID string `json:"environment_id"`
	// Name defaults to the engine's name.
	Name string `json:"name,omitempty"`
	Slug string `json:"slug,omitempty"`
	// Deploy starts the first deployment in EnvironmentID.
	Deploy bool `json:"deploy"`
}

// Volume is a service's volume in one environment.
type Volume struct {
	ID            string `json:"id"`
	ProjectID     string `json:"project_id"`
	EnvironmentID string `json:"environment_id"`
	ServiceID     string `json:"service_id"`
	MountPath     string `json:"mount_path"`
	SizeMB        int64  `json:"size_mb"`
	// NodeID is nil until the first deployment places the volume.
	NodeID   *string `json:"node_id"`
	NodeName *string `json:"node_name"`
	Status   string  `json:"status"`
	// QuotaMode is how the node enforces the size; "none" means it is not
	// enforced.
	QuotaMode  *string  `json:"quota_mode"`
	UsedBytes  *float64 `json:"used_bytes"`
	Message    *string  `json:"message"`
	ReportedAt *int64   `json:"reported_at"`
	// DeleteAfter is when a pending_deletion volume's data is removed.
	DeleteAfter *int64 `json:"delete_after"`
	CreatedAt   int64  `json:"created_at"`
	UpdatedAt   int64  `json:"updated_at"`
}

// CreatedVariable is a variable adding a database created; its value is
// never returned.
type CreatedVariable struct {
	Key    string `json:"key"`
	Secret bool   `json:"secret"`
}

// SkippedDeployment is a service a change set did not deploy, and why.
type SkippedDeployment struct {
	ServiceID string `json:"service_id"`
	Reason    string `json:"reason"`
}

// CreatedDatabase is what adding a database created.
type CreatedDatabase struct {
	ChangeSetID string  `json:"change_set_id"`
	Service     Service `json:"service"`
	Engine      string  `json:"engine"`
	Version     string  `json:"version"`
	// Volumes holds one volume per environment.
	Volumes       []Volume            `json:"volumes"`
	Variables     []CreatedVariable   `json:"variables"`
	DeploymentIDs []string            `json:"deployment_ids"`
	Skipped       []SkippedDeployment `json:"skipped"`
}

// QueryOp is one data-browser operation (DatabaseQueryOp). Type is
// list_namespaces, list_tables, describe, rows or raw; the other fields
// belong to some types only.
type QueryOp struct {
	Type      string `json:"type"`
	Namespace string `json:"namespace,omitempty"`
	Table     string `json:"table,omitempty"`
	// Cursor and Pattern page a Redis key scan.
	Cursor  string `json:"cursor,omitempty"`
	Pattern string `json:"pattern,omitempty"`
	// Statement is SQL, or a MongoDB command document as JSON text.
	Statement string `json:"statement,omitempty"`
	// Params are SQL positional parameters; a nil element is NULL.
	Params []*string `json:"params,omitempty"`
	// Argv is a Redis command.
	Argv []string `json:"argv,omitempty"`
}

// Query modes.
const (
	QueryRead  = "read"
	QueryWrite = "write"
)

// DatabaseQueryInput is the body of POST /v1/services/{serviceId}/database/query.
type DatabaseQueryInput struct {
	EnvironmentID string `json:"environment_id"`
	// Mode is QueryRead (the read-only principal in a read-only
	// transaction) or QueryWrite.
	Mode    string  `json:"mode"`
	Op      QueryOp `json:"op"`
	MaxRows int     `json:"max_rows,omitempty"`
	// TimeoutMS is DefaultQueryTimeoutMS when zero.
	TimeoutMS int `json:"timeout_ms,omitempty"`
}

// QueryColumn is one result column.
type QueryColumn struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// DatabaseQueryResult is a data-browser result. OK false is an engine
// error (syntax, permission, a write refused in read mode), not a
// transport failure.
type DatabaseQueryResult struct {
	RequestID string        `json:"request_id"`
	OK        bool          `json:"ok"`
	Columns   []QueryColumn `json:"columns,omitempty"`
	// Rows hold JSON values: binary as {"$b64": "…"}, 64-bit integers as
	// strings.
	Rows     [][]any `json:"rows,omitempty"`
	RowCount *int    `json:"row_count,omitempty"`
	// Truncated is set when more rows existed than max_rows, or the result
	// hit its size cap.
	Truncated  bool   `json:"truncated,omitempty"`
	Notice     string `json:"notice,omitempty"`
	Error      string `json:"error,omitempty"`
	DurationMS int64  `json:"duration_ms"`
}

// DatabaseSchema is a database's namespaces: databases, schemas or Redis
// database indexes.
type DatabaseSchema struct {
	Engine     string              `json:"engine"`
	Version    *string             `json:"version"`
	Namespaces DatabaseQueryResult `json:"namespaces"`
}

// CreateDatabase adds a database service through a change set applied in
// in.EnvironmentID. Its credentials become write-only secret variables.
func (c *Client) CreateDatabase(ctx context.Context, projectID string, in CreateDatabaseInput) (*CreatedDatabase, error) {
	return fetch[CreatedDatabase](ctx, c, RouteCreateDatabase, nil, in, projectID)
}

// ServiceVolume returns a service's volume in an environment; 404 when it
// has none.
func (c *Client) ServiceVolume(ctx context.Context, serviceID, environmentID string) (*Volume, error) {
	return fetch[Volume](ctx, c, RouteServiceVolume, envQuery(environmentID), nil, serviceID)
}

// ResizeVolume grows a volume to sizeMB; the API refuses to shrink one
// (422 volume_shrink_unsupported).
func (c *Client) ResizeVolume(ctx context.Context, volumeID string, sizeMB int64) (*Volume, error) {
	return fetch[Volume](ctx, c, RouteResizeVolume, nil, map[string]int64{"size_mb": sizeMB}, volumeID)
}

// DeleteVolume schedules a volume's data for removal after a 72-hour grace
// period. The API refuses while the service still runs there.
func (c *Client) DeleteVolume(ctx context.Context, volumeID string) (*Volume, error) {
	return fetch[Volume](ctx, c, RouteDeleteVolume, nil, nil, volumeID)
}

// UndeleteVolume cancels a delete within its grace period.
func (c *Client) UndeleteVolume(ctx context.Context, volumeID string) (*Volume, error) {
	return fetch[Volume](ctx, c, RouteUndeleteVolume, nil, nil, volumeID)
}

// QueryDatabase runs one data-browser operation on a database service.
func (c *Client) QueryDatabase(ctx context.Context, serviceID string, in DatabaseQueryInput) (*DatabaseQueryResult, error) {
	return fetch[DatabaseQueryResult](ctx, c, RouteDatabaseQuery, nil, in, serviceID)
}

// DatabaseSchema returns a database's namespaces. The API audits each call
// as opening the data browser.
func (c *Client) DatabaseSchema(ctx context.Context, serviceID, environmentID string) (*DatabaseSchema, error) {
	return fetch[DatabaseSchema](ctx, c, RouteDatabaseSchema, envQuery(environmentID), nil, serviceID)
}
