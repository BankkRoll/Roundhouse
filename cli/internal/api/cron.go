package api

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strconv"
)

// Cron routes (ADR 0010).
var (
	RouteCronState     = Route{http.MethodGet, "/v1/services/{serviceId}/cron"}
	RouteListCronRuns  = Route{http.MethodGet, "/v1/services/{serviceId}/cron-runs"}
	RouteTriggerCron   = Route{http.MethodPost, "/v1/services/{serviceId}/cron-runs"}
	RouteGetCronRun    = Route{http.MethodGet, "/v1/cron-runs/{runId}"}
	RouteCronRunLogs   = Route{http.MethodGet, "/v1/cron-runs/{runId}/logs"}
	RouteCancelCronRun = Route{http.MethodPost, "/v1/cron-runs/{runId}/cancel"}
	RoutePauseCron     = Route{http.MethodPost, "/v1/services/{serviceId}/cron/pause"}
	RouteResumeCron    = Route{http.MethodPost, "/v1/services/{serviceId}/cron/resume"}
	RouteCronPreview   = Route{http.MethodGet, "/v1/projects/{projectId}/cron/preview"}
)

// Cron run statuses, from CRON_RUN_STATUSES in packages/shared.
const (
	CronQueued    = "queued"
	CronStarting  = "starting"
	CronRunning   = "running"
	CronSucceeded = "succeeded"
	CronFailed    = "failed"
	CronTimedOut  = "timed_out"
	CronCancelled = "cancelled"
	CronSkipped   = "skipped"
	CronMissed    = "missed"
	CronLost      = "lost"
)

// CronRunStatuses lists every cron run status, in the API's order.
var CronRunStatuses = []string{CronQueued, CronStarting, CronRunning, CronSucceeded, CronFailed,
	CronTimedOut, CronCancelled, CronSkipped, CronMissed, CronLost}

// CronRunTriggers lists what can start a cron run, from CRON_RUN_TRIGGERS.
var CronRunTriggers = []string{"schedule", "manual", "retry", "pre_deploy"}

// ServiceKindCron is the kind of a service that runs on a schedule.
const ServiceKindCron = "cron"

// CronRunPageLimit is the largest page of runs the API returns.
const CronRunPageLimit = 100

// IsCronRunFinished reports whether a run in this status will not change
// again.
func IsCronRunFinished(status string) bool {
	return !slices.Contains([]string{CronQueued, CronStarting, CronRunning}, status)
}

// CronState is a cron service's schedule state in one environment.
type CronState struct {
	ServiceID     string `json:"service_id"`
	EnvironmentID string `json:"environment_id"`
	Paused        bool   `json:"paused"`
	// NextRunAt is nil while paused, before the first deploy, or when the
	// schedule never fires.
	NextRunAt        *int64 `json:"next_run_at"`
	LastScheduledFor *int64 `json:"last_scheduled_for"`
	// ArmedDeploymentID is the deployment runs use; nil until the service
	// is deployed in the environment.
	ArmedDeploymentID *string `json:"armed_deployment_id"`
	// Schedule and Timezone are the armed deployment's.
	Schedule *string `json:"schedule"`
	Timezone *string `json:"timezone"`
	// NextRuns are the next few slots, unix ms; empty while paused or unarmed.
	NextRuns []int64 `json:"next_runs"`
}

// CronRun is one run of a cron service, or a record of missed slots.
type CronRun struct {
	ID            string  `json:"id"`
	ProjectID     string  `json:"project_id"`
	ServiceID     string  `json:"service_id"`
	EnvironmentID string  `json:"environment_id"`
	DeploymentID  *string `json:"deployment_id"`
	// Trigger is schedule, manual, retry or pre_deploy.
	Trigger string `json:"trigger"`
	// ScheduledFor is the slot; for a manual run, when it was requested.
	ScheduledFor int64   `json:"scheduled_for"`
	Attempt      int     `json:"attempt"`
	Status       string  `json:"status"`
	NodeID       *string `json:"node_id"`
	ExitCode     *int    `json:"exit_code"`
	// MissedCount is how many slots a missed record covers.
	MissedCount *int    `json:"missed_count"`
	Error       *string `json:"error"`
	TriggeredBy *string `json:"triggered_by"`
	StartedAt   *int64  `json:"started_at"`
	FinishedAt  *int64  `json:"finished_at"`
	CreatedAt   int64   `json:"created_at"`
	UpdatedAt   int64   `json:"updated_at"`
}

// CronRunPage is a page of runs, newest slot first.
type CronRunPage struct {
	Runs       []CronRun `json:"runs"`
	NextCursor *string   `json:"next_cursor"`
}

// ScheduleError says where a schedule or time zone stopped parsing. Start
// and End are offsets into the schedule (or, for invalid_timezone, the
// zone) in UTF-16 code units; see [UTF16Span].
type ScheduleError struct {
	// Code is invalid_schedule or invalid_timezone.
	Code    string `json:"code"`
	Message string `json:"message"`
	Start   int    `json:"start"`
	End     int    `json:"end"`
}

// CronPreview is the next slots of a schedule, or why it does not parse.
type CronPreview struct {
	Valid    bool           `json:"valid"`
	NextRuns []int64        `json:"next_runs"`
	Error    *ScheduleError `json:"error"`
}

// TriggerCronRunInput is the body of POST /v1/services/{serviceId}/cron-runs.
type TriggerCronRunInput struct {
	EnvironmentID string `json:"environment_id"`
	// Force cancels runs in progress first; without it a run in progress
	// is a 409 run_in_progress.
	Force bool `json:"force,omitempty"`
}

// CronEnvironmentInput is the body of the pause and resume routes.
type CronEnvironmentInput struct {
	EnvironmentID string `json:"environment_id"`
}

// CronRunListOptions filters and pages [Client.ListCronRuns].
type CronRunListOptions struct {
	Cursor string
	Limit  int
	// Status keeps only runs in this status.
	Status string
}

// CronState returns a cron service's schedule state in an environment.
func (c *Client) CronState(ctx context.Context, serviceID, environmentID string) (*CronState, error) {
	return fetch[CronState](ctx, c, RouteCronState, envQuery(environmentID), nil, serviceID)
}

// ListCronRuns returns a page of a cron service's runs in an environment,
// newest slot first.
func (c *Client) ListCronRuns(ctx context.Context, serviceID, environmentID string, o CronRunListOptions) (*CronRunPage, error) {
	q := envQuery(environmentID)
	if o.Cursor != "" {
		q.Set("cursor", o.Cursor)
	}
	if o.Limit > 0 {
		q.Set("limit", strconv.Itoa(o.Limit))
	}
	if o.Status != "" {
		q.Set("status", o.Status)
	}
	return fetch[CronRunPage](ctx, c, RouteListCronRuns, q, nil, serviceID)
}

// TriggerCronRun runs a cron service's armed deployment now.
func (c *Client) TriggerCronRun(ctx context.Context, serviceID string, in TriggerCronRunInput) (*CronRun, error) {
	return fetch[CronRun](ctx, c, RouteTriggerCron, nil, in, serviceID)
}

// GetCronRun returns one run.
func (c *Client) GetCronRun(ctx context.Context, runID string) (*CronRun, error) {
	return fetch[CronRun](ctx, c, RouteGetCronRun, nil, nil, runID)
}

// CronRunLogs returns a page of a run's output. Without a cursor it is the
// newest page; NextCursor pages backwards.
func (c *Client) CronRunLogs(ctx context.Context, runID, cursor string, limit int) (*LogPage, error) {
	q := url.Values{}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	return fetch[LogPage](ctx, c, RouteCronRunLogs, q, nil, runID)
}

// CancelCronRun stops a run: a queued one at once, a running one through
// its node.
func (c *Client) CancelCronRun(ctx context.Context, runID string) (*CronRun, error) {
	return fetch[CronRun](ctx, c, RouteCancelCronRun, nil, nil, runID)
}

// PauseCron stops scheduling a cron service's runs in an environment.
func (c *Client) PauseCron(ctx context.Context, serviceID, environmentID string) (*CronState, error) {
	return fetch[CronState](ctx, c, RoutePauseCron, nil, CronEnvironmentInput{EnvironmentID: environmentID}, serviceID)
}

// ResumeCron resumes scheduling from the next future slot.
func (c *Client) ResumeCron(ctx context.Context, serviceID, environmentID string) (*CronState, error) {
	return fetch[CronState](ctx, c, RouteResumeCron, nil, CronEnvironmentInput{EnvironmentID: environmentID}, serviceID)
}

// PreviewCronSchedule returns the next count slots of a schedule read in
// timezone, or where it stopped parsing. An unparsable schedule is not an
// error: the result has Valid false and Error set.
func (c *Client) PreviewCronSchedule(ctx context.Context, projectID, schedule, timezone string, count int) (*CronPreview, error) {
	q := url.Values{"schedule": {schedule}}
	if timezone != "" {
		q.Set("timezone", timezone)
	}
	if count > 0 {
		q.Set("count", strconv.Itoa(count))
	}
	return fetch[CronPreview](ctx, c, RouteCronPreview, q, nil, projectID)
}

// CronConfig is a cron service's schedule and run rules.
type CronConfig struct {
	// Schedule is a five-field cron expression or a macro (@daily), read in
	// Timezone.
	Schedule string `json:"schedule"`
	// Timezone is an IANA time zone.
	Timezone string `json:"timezone"`
	// Concurrency is forbid, replace or allow: what a slot does while the
	// previous run still runs.
	Concurrency       string `json:"concurrency"`
	TimeoutS          int    `json:"timeout_s"`
	StartingDeadlineS int    `json:"starting_deadline_s"`
	Retries           int    `json:"retries"`
	RetryBackoffS     int    `json:"retry_backoff_s"`
	HistoryLimit      int    `json:"history_limit"`
}

// CronConcurrencyPolicies lists what a slot may do while the previous run
// still runs, from CRON_CONCURRENCY_POLICIES in packages/shared.
var CronConcurrencyPolicies = []string{"forbid", "replace", "allow"}

// CronLimit is the inclusive range the API accepts for a numeric
// [CronConfig] field.
type CronLimit struct{ Min, Max int }

// Bounds of the numeric [CronConfig] fields, from CRON_LIMITS in
// packages/shared.
var (
	CronTimeoutLimit          = CronLimit{10, 86400}
	CronStartingDeadlineLimit = CronLimit{0, 3600}
	CronRetriesLimit          = CronLimit{0, 5}
	CronRetryBackoffLimit     = CronLimit{10, 3600}
	CronHistoryLimit          = CronLimit{10, 1000}
)

// CronConfigPatch is a partial [CronConfig]: nil fields keep their current
// value, or the default when the service has no cron config yet.
type CronConfigPatch struct {
	Schedule          *string `json:"schedule,omitempty"`
	Timezone          *string `json:"timezone,omitempty"`
	Concurrency       *string `json:"concurrency,omitempty"`
	TimeoutS          *int    `json:"timeout_s,omitempty"`
	StartingDeadlineS *int    `json:"starting_deadline_s,omitempty"`
	Retries           *int    `json:"retries,omitempty"`
	RetryBackoffS     *int    `json:"retry_backoff_s,omitempty"`
	HistoryLimit      *int    `json:"history_limit,omitempty"`
}

// ScheduleErrorOf extracts where a schedule or zone stopped parsing from a
// 422 invalid_schedule answer to a config change; nil for any other error.
func ScheduleErrorOf(err error) *ScheduleError {
	var e *Error
	if !errors.As(err, &e) || e.Code != "invalid_schedule" {
		return nil
	}
	for _, d := range e.Details {
		if (d.Code == "invalid_schedule" || d.Code == "invalid_timezone") && d.Start != nil && d.End != nil {
			return &ScheduleError{Code: d.Code, Message: d.Message, Start: *d.Start, End: *d.End}
		}
	}
	return nil
}
