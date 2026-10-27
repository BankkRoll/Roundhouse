package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
)

// Backup and restore routes (ADR 0004).
var (
	RouteBackupPolicy    = Route{http.MethodGet, "/v1/services/{serviceId}/backup-policy"}
	RoutePutBackupPolicy = Route{http.MethodPut, "/v1/services/{serviceId}/backup-policy"}
	RouteListBackups     = Route{http.MethodGet, "/v1/services/{serviceId}/backups"}
	RouteCreateBackup    = Route{http.MethodPost, "/v1/services/{serviceId}/backups"}
	RouteGetBackup       = Route{http.MethodGet, "/v1/backups/{backupId}"}
	RouteBackupDownload  = Route{http.MethodGet, "/v1/backups/{backupId}/download"}
	RouteBackupKey       = Route{http.MethodPost, "/v1/backups/{backupId}/decryption-key"}
	RouteRestoreBackup   = Route{http.MethodPost, "/v1/backups/{backupId}/restore"}
	RouteGetRestore      = Route{http.MethodGet, "/v1/restores/{restoreId}"}
)

// Backup and restore statuses, from BACKUP_STATUSES and RESTORE_STATUSES
// in packages/shared/src/data-services.ts.
const (
	BackupQueued    = "queued"
	BackupRunning   = "running"
	BackupSucceeded = "succeeded"
	BackupFailed    = "failed"
	BackupDeleted   = "deleted"
)

// BackupStatuses lists every backup status, in the API's order.
var BackupStatuses = []string{BackupQueued, BackupRunning, BackupSucceeded, BackupFailed, BackupDeleted}

// RestoreModes are the ways a backup can be restored, from RESTORE_MODES.
var RestoreModes = []string{"in_place", "new_service"}

// Restore modes.
const (
	RestoreInPlace    = "in_place"
	RestoreNewService = "new_service"
)

// Backup policy bounds, from PutBackupPolicy.
const (
	MaxKeepLast   = 365
	MaxMaxAgeDays = 3650
)

// Backup is one backup of a service in an environment.
type Backup struct {
	ID            string  `json:"id"`
	ProjectID     string  `json:"project_id"`
	ServiceID     string  `json:"service_id"`
	EnvironmentID string  `json:"environment_id"`
	VolumeID      *string `json:"volume_id"`
	PolicyID      *string `json:"policy_id"`
	// Trigger is schedule, manual, pre_restore or migration.
	Trigger       string  `json:"trigger"`
	Method        string  `json:"method"`
	Engine        *string `json:"engine"`
	EngineVersion *string `json:"engine_version"`
	Status        string  `json:"status"`
	NodeID        *string `json:"node_id"`
	// Pinned backups are exempt from keep_last; manual ones are pinned.
	Pinned    bool   `json:"pinned"`
	PartCount *int64 `json:"part_count"`
	// BytesRaw is the source size; BytesStored the compressed, encrypted
	// object's.
	BytesRaw    *int64 `json:"bytes_raw"`
	BytesStored *int64 `json:"bytes_stored"`
	// SHA256 is the hex digest of the stored object.
	SHA256       *string `json:"sha256"`
	Error        *string `json:"error"`
	RequestedBy  *string `json:"requested_by"`
	ScheduledFor *int64  `json:"scheduled_for"`
	StartedAt    *int64  `json:"started_at"`
	FinishedAt   *int64  `json:"finished_at"`
	CreatedAt    int64   `json:"created_at"`
}

// BackupPage is a page of backups, newest first.
type BackupPage struct {
	Backups    []Backup `json:"backups"`
	NextCursor *string  `json:"next_cursor"`
}

// BackupPolicy is a service's backup policy in one environment, or the
// defaults when none is saved (ID nil).
type BackupPolicy struct {
	ID            *string `json:"id"`
	ServiceID     string  `json:"service_id"`
	EnvironmentID string  `json:"environment_id"`
	Enabled       bool    `json:"enabled"`
	Method        string  `json:"method"`
	// Schedule is a five-field cron expression, evaluated in Timezone
	// (always UTC).
	Schedule   string   `json:"schedule"`
	Timezone   string   `json:"timezone"`
	KeepLast   int      `json:"keep_last"`
	MaxAgeDays *int     `json:"max_age_days"`
	Quiesce    string   `json:"quiesce"`
	Databases  []string `json:"databases"`
	NextRunAt  *int64   `json:"next_run_at"`
	// NextRuns are the next few slots, unix ms.
	NextRuns []int64 `json:"next_runs"`
}

// PutBackupPolicyInput is the body of PUT
// /v1/services/{serviceId}/backup-policy; nil fields keep their value.
type PutBackupPolicyInput struct {
	EnvironmentID string  `json:"environment_id"`
	Enabled       *bool   `json:"enabled,omitempty"`
	Schedule      *string `json:"schedule,omitempty"`
	KeepLast      *int    `json:"keep_last,omitempty"`
	// MaxAgeDays is omitted when nil, and sent as null (no age limit) when
	// it points to nil.
	MaxAgeDays **int `json:"max_age_days,omitempty"`
}

// BackupDownload is a presigned download of a backup's encrypted object.
type BackupDownload struct {
	// URL is a presigned GET, valid for 15 minutes. It carries its own
	// authorization and must never be sent the control plane's credential.
	URL       string  `json:"url"`
	ExpiresAt int64   `json:"expires_at"`
	Filename  string  `json:"filename"`
	SHA256    *string `json:"sha256"`
}

// BackupDecryptionKey is a project's age identity.
//
// SECURITY: Identity decrypts every backup of the project. Never print,
// log or store it.
type BackupDecryptionKey struct {
	Identity  string `json:"identity"`
	Recipient string `json:"recipient"`
}

// RestoreBackupInput is the body of POST /v1/backups/{backupId}/restore.
type RestoreBackupInput struct {
	Mode string `json:"mode"`
	// TargetEnvironmentID is where a new_service restore creates the
	// service; the backup's environment when empty.
	TargetEnvironmentID string `json:"target_environment_id,omitempty"`
	// Slug is the new service's slug for a new_service restore; the server
	// picks <slug>-restore-<yyyymmdd> when empty.
	Slug string `json:"slug,omitempty"`
	// Confirm must equal the backed-up service's slug.
	Confirm          string `json:"confirm"`
	SkipSafetyBackup bool   `json:"skip_safety_backup,omitempty"`
	// TargetNodeID recovers an in_place restore onto this server because
	// the volume's server is lost (offline or removed): a new volume is
	// created there, the service redeployed onto it, and the backup
	// restored. No safety backup is taken.
	TargetNodeID string `json:"target_node_id,omitempty"`
}

// Restore is a restore of a backup.
type Restore struct {
	ID                  string  `json:"id"`
	BackupID            string  `json:"backup_id"`
	Mode                string  `json:"mode"`
	TargetServiceID     *string `json:"target_service_id"`
	TargetEnvironmentID *string `json:"target_environment_id"`
	SafetyBackupID      *string `json:"safety_backup_id"`
	// TargetNodeID is the server a recovery restored onto; nil otherwise.
	TargetNodeID *string `json:"target_node_id"`
	Status       string  `json:"status"`
	Error        *string `json:"error"`
	RequestedBy  *string `json:"requested_by"`
	StartedAt    *int64  `json:"started_at"`
	FinishedAt   *int64  `json:"finished_at"`
	CreatedAt    int64   `json:"created_at"`
}

// BackupPolicy returns a service's backup policy in an environment.
func (c *Client) BackupPolicy(ctx context.Context, serviceID, environmentID string) (*BackupPolicy, error) {
	return fetch[BackupPolicy](ctx, c, RouteBackupPolicy, envQuery(environmentID), nil, serviceID)
}

// PutBackupPolicy creates or updates a service's backup policy.
func (c *Client) PutBackupPolicy(ctx context.Context, serviceID string, in PutBackupPolicyInput) (*BackupPolicy, error) {
	return fetch[BackupPolicy](ctx, c, RoutePutBackupPolicy, nil, in, serviceID)
}

// ListBackups returns a page of a service's backups in an environment,
// newest first.
func (c *Client) ListBackups(ctx context.Context, serviceID, environmentID, cursor string, limit int) (*BackupPage, error) {
	q := envQuery(environmentID)
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	return fetch[BackupPage](ctx, c, RouteListBackups, q, nil, serviceID)
}

// CreateBackup queues a manual, pinned backup.
func (c *Client) CreateBackup(ctx context.Context, serviceID, environmentID string) (*Backup, error) {
	return fetch[Backup](ctx, c, RouteCreateBackup, nil, map[string]string{"environment_id": environmentID}, serviceID)
}

// GetBackup returns one backup.
func (c *Client) GetBackup(ctx context.Context, backupID string) (*Backup, error) {
	return fetch[Backup](ctx, c, RouteGetBackup, nil, nil, backupID)
}

// BackupDownload returns a presigned download of a succeeded backup. The
// API audits it.
func (c *Client) BackupDownload(ctx context.Context, backupID string) (*BackupDownload, error) {
	return fetch[BackupDownload](ctx, c, RouteBackupDownload, nil, nil, backupID)
}

// BackupDecryptionKey returns the project's age identity. It needs a fresh
// session (403 reauth_required otherwise) and is audited.
func (c *Client) BackupDecryptionKey(ctx context.Context, backupID string) (*BackupDecryptionKey, error) {
	return fetch[BackupDecryptionKey](ctx, c, RouteBackupKey, nil, nil, backupID)
}

// RestoreBackup starts restoring a backup. It needs a fresh session. 422
// restore_mode_unsupported refuses a new_service restore of a snapshot
// backup of a service that is not a database.
func (c *Client) RestoreBackup(ctx context.Context, backupID string, in RestoreBackupInput) (*Restore, error) {
	return fetch[Restore](ctx, c, RouteRestoreBackup, nil, in, backupID)
}

// GetRestore returns one restore.
func (c *Client) GetRestore(ctx context.Context, restoreID string) (*Restore, error) {
	return fetch[Restore](ctx, c, RouteGetRestore, nil, nil, restoreID)
}

// -----------------------------------------------------------------------------
// Object downloads
// -----------------------------------------------------------------------------

// OpenObject starts a GET of a presigned object URL from
// [Client.BackupDownload] and returns its body.
//
// SECURITY: the URL points at object storage, not the control plane, so
// the request carries no credential and follows no redirect. It must be
// https, except for a loopback host when the control plane itself is plain
// http (development and tests).
func (c *Client) OpenObject(ctx context.Context, rawURL string) (io.ReadCloser, int64, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" || u.User != nil {
		return nil, 0, errors.New("the control plane returned an invalid download URL")
	}
	switch {
	case u.Scheme == "https":
	case u.Scheme == "http" && c.base.Scheme == "http" && IsLoopback(u.Hostname()):
	default:
		return nil, 0, fmt.Errorf("refusing to download over %s:// from %s", u.Scheme, u.Host)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, 0, err
	}
	if c.userAgent != "" {
		req.Header.Set("User-Agent", c.userAgent)
	}
	res, err := c.objects.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, 0, ctx.Err()
		}
		return nil, 0, &NetworkError{URL: u.Scheme + "://" + u.Host, Err: unwrapURLError(err)}
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		return nil, 0, &Error{Status: res.StatusCode, Code: "download_failed",
			Message: fmt.Sprintf("object storage answered %d %s", res.StatusCode, http.StatusText(res.StatusCode))}
	}
	return res.Body, res.ContentLength, nil
}
