package api

import (
	"context"
	"net/http"
)

// Point-in-time recovery, automatic recovery and abandoned-copy routes
// (ADR 0004, "Recovering a volume" and "Point-in-time recovery").
var (
	RoutePitrStatus        = Route{http.MethodGet, "/v1/services/{serviceId}/pitr"}
	RoutePitrRestore       = Route{http.MethodPost, "/v1/services/{serviceId}/pitr/restore"}
	RouteRecoveryPolicy    = Route{http.MethodGet, "/v1/services/{serviceId}/recovery-policy"}
	RoutePutRecoveryPolicy = Route{http.MethodPut, "/v1/services/{serviceId}/recovery-policy"}
	RouteAbandonedCopies   = Route{http.MethodGet, "/v1/services/{serviceId}/volume/abandoned-copies"}
)

// Automatic recovery grace bounds in minutes, from
// MIN_RECOVERY_GRACE_MINUTES, MAX_RECOVERY_GRACE_MINUTES and
// DEFAULT_RECOVERY_GRACE_MINUTES in packages/shared/src/data-services.ts.
const (
	MinRecoveryGraceMinutes     = 5
	MaxRecoveryGraceMinutes     = 10_080
	DefaultRecoveryGraceMinutes = 30
)

// RecoveryPolicyStatuses lists every automatic recovery status, from
// RECOVERY_POLICY_STATUSES.
var RecoveryPolicyStatuses = []string{"idle", "watching", "recovering", "recovered", "blocked", "failed"}

// AbandonedCopyStates lists where an abandoned copy can stand, in the
// API's order.
var AbandonedCopyStates = []string{"waiting_for_server", "scheduled", "kept", "deleting", "deleted"}

// RestoreTriggers lists who can start a restore, from RESTORE_TRIGGERS.
var RestoreTriggers = []string{"manual", "automatic"}

// WALStreamStatuses lists every WAL stream status, from WAL_STREAM_STATUSES.
var WALStreamStatuses = []string{"active", "retired", "deleted"}

// PitrRange is a restorable range of time, unix ms. From is the first
// restorable point and To the newest, exclusive.
type PitrRange struct {
	From int64 `json:"from"`
	To   int64 `json:"to"`
}

// Contains reports whether a restore can target ms.
func (r PitrRange) Contains(ms int64) bool {
	return ms >= r.From && ms < r.To
}

// PitrStream is the WAL stream a service archives into.
type PitrStream struct {
	ID string `json:"id"`
	// Status is active, retired or deleted.
	Status          string `json:"status"`
	SegmentCount    int64  `json:"segment_count"`
	BytesStored     int64  `json:"bytes_stored"`
	FirstArchivedAt *int64 `json:"first_archived_at"`
	LastArchivedAt  *int64 `json:"last_archived_at"`
	CreatedAt       int64  `json:"created_at"`
}

// PitrStatus is a service's point-in-time recovery in one environment.
type PitrStatus struct {
	ServiceID     string `json:"service_id"`
	EnvironmentID string `json:"environment_id"`
	// Enabled is the backup policy's pitr.
	Enabled bool `json:"enabled"`
	// UnavailableReason says why it cannot be turned on (or is not
	// archiving); nil when it can.
	UnavailableReason *string     `json:"unavailable_reason"`
	Stream            *PitrStream `json:"stream"`
	// Windows are the ranges a restore can target, oldest first.
	Windows []PitrRange `json:"windows"`
	// BaseBackups counts the succeeded base backups WAL replays onto.
	BaseBackups int `json:"base_backups"`
}

// PitrRestoreInput is the body of POST /v1/services/{serviceId}/pitr/restore.
type PitrRestoreInput struct {
	EnvironmentID string `json:"environment_id"`
	// TargetTime is the moment to restore to, unix ms, inside a window.
	TargetTime int64  `json:"target_time"`
	Mode       string `json:"mode"`
	// TargetEnvironmentID is where a new_service restore creates the
	// service; EnvironmentID when empty.
	TargetEnvironmentID string `json:"target_environment_id,omitempty"`
	// Slug names a new_service restore's service.
	Slug string `json:"slug,omitempty"`
	// Confirm must equal the service's slug.
	Confirm          string `json:"confirm"`
	SkipSafetyBackup bool   `json:"skip_safety_backup,omitempty"`
}

// RecoveryPolicy is a service's automatic recovery in one environment, or
// the defaults when none is saved (ID nil).
type RecoveryPolicy struct {
	ID            *string `json:"id"`
	ServiceID     string  `json:"service_id"`
	EnvironmentID string  `json:"environment_id"`
	Enabled       bool    `json:"enabled"`
	// GraceMinutes is how long the volume's server must stay offline
	// before recovery starts.
	GraceMinutes int `json:"grace_minutes"`
	// EnabledBy is whose access recoveries run with.
	EnabledBy *string `json:"enabled_by"`
	// Status is one of [RecoveryPolicyStatuses].
	Status string `json:"status"`
	// Message says why the status is what it is.
	Message *string `json:"message"`
	// LostNodeID is the offline server being watched or recovered from.
	LostNodeID *string `json:"lost_node_id"`
	// RestoreID is the last automatic recovery.
	RestoreID   *string `json:"restore_id"`
	TriggeredAt *int64  `json:"triggered_at"`
	UpdatedAt   *int64  `json:"updated_at"`
}

// PutRecoveryPolicyInput is the body of PUT
// /v1/services/{serviceId}/recovery-policy; nil fields keep their value.
type PutRecoveryPolicyInput struct {
	EnvironmentID string `json:"environment_id"`
	Enabled       *bool  `json:"enabled,omitempty"`
	GraceMinutes  *int   `json:"grace_minutes,omitempty"`
}

// AbandonedCopy is a volume a recovery left on a lost server, and where its
// deletion stands.
type AbandonedCopy struct {
	VolumeID string  `json:"volume_id"`
	NodeID   *string `json:"node_id"`
	NodeName *string `json:"node_name"`
	// State is one of [AbandonedCopyStates].
	State string `json:"state"`
	// Message says why a copy is kept or waiting.
	Message   *string `json:"message"`
	SizeMB    int64   `json:"size_mb"`
	UsedBytes *int64  `json:"used_bytes"`
	// AbandonedAt is when the recovery replaced it; DeleteAfter when it may
	// be deleted once its server is back.
	AbandonedAt  *int64 `json:"abandoned_at"`
	DeleteAfter  *int64 `json:"delete_after"`
	DeleteSentAt *int64 `json:"delete_sent_at"`
	CleanedAt    *int64 `json:"cleaned_at"`
}

// AbandonedCopyList is a service's abandoned copies in one environment,
// newest first.
type AbandonedCopyList struct {
	Copies []AbandonedCopy `json:"copies"`
}

// PitrStatus returns a service's point-in-time recovery status and
// restorable windows in an environment.
func (c *Client) PitrStatus(ctx context.Context, serviceID, environmentID string) (*PitrStatus, error) {
	return fetch[PitrStatus](ctx, c, RoutePitrStatus, envQuery(environmentID), nil, serviceID)
}

// PitrRestore starts restoring a service to a point in time. It needs a
// fresh session (403 reauth_required otherwise); 422
// pitr_target_unavailable means no base backup and WAL cover the time.
func (c *Client) PitrRestore(ctx context.Context, serviceID string, in PitrRestoreInput) (*Restore, error) {
	return fetch[Restore](ctx, c, RoutePitrRestore, nil, in, serviceID)
}

// RecoveryPolicy returns a service's automatic recovery policy in an
// environment.
func (c *Client) RecoveryPolicy(ctx context.Context, serviceID, environmentID string) (*RecoveryPolicy, error) {
	return fetch[RecoveryPolicy](ctx, c, RouteRecoveryPolicy, envQuery(environmentID), nil, serviceID)
}

// PutRecoveryPolicy creates or updates a service's automatic recovery
// policy. It needs a fresh session.
func (c *Client) PutRecoveryPolicy(ctx context.Context, serviceID string, in PutRecoveryPolicyInput) (*RecoveryPolicy, error) {
	return fetch[RecoveryPolicy](ctx, c, RoutePutRecoveryPolicy, nil, in, serviceID)
}

// AbandonedCopies lists the copies recoveries left of a service's volume
// in an environment, newest first.
func (c *Client) AbandonedCopies(ctx context.Context, serviceID, environmentID string) (*AbandonedCopyList, error) {
	return fetch[AbandonedCopyList](ctx, c, RouteAbandonedCopies, envQuery(environmentID), nil, serviceID)
}
