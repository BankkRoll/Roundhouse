package api

import (
	"context"
	"net/http"
	"net/url"
)

// Environment lifecycle routes (ADR 0007): create or clone, compare, propose
// a promotion, delete.
var (
	RouteCreateEnvironment  = Route{http.MethodPost, "/v1/projects/{projectId}/environments"}
	RouteEnvironmentDiff    = Route{http.MethodGet, "/v1/projects/{projectId}/environments/diff"}
	RoutePromoteEnvironment = Route{http.MethodPost, "/v1/environments/{environmentId}/promote"}
	RouteDeleteEnvironment  = Route{http.MethodDelete, "/v1/environments/{environmentId}"}
)

// CloneInput copies another environment into a new one. Database
// credentials are never copied: each environment gets fresh ones.
type CloneInput struct {
	FromEnvironmentID string `json:"from_environment_id"`
	// Variables is all, non_secret or none.
	Variables string `json:"variables,omitempty"`
	// Volumes is empty or latest_backup (restore each database's latest dump).
	Volumes  string   `json:"volumes,omitempty"`
	Services []string `json:"services,omitempty"`
}

// CreateEnvironmentInput is the body of POST /v1/projects/{projectId}/environments.
type CreateEnvironmentInput struct {
	Name  string      `json:"name"`
	Slug  string      `json:"slug,omitempty"`
	Kind  string      `json:"kind"`
	Clone *CloneInput `json:"clone,omitempty"`
}

// VariableComparison is how one variable compares between two
// environments; never its value.
type VariableComparison struct {
	Key string `json:"key"`
	// Change is added, removed, changed or same.
	Change string `json:"change"`
	Secret bool   `json:"secret"`
}

// ConfigDifference is one changed config value, by JSON pointer.
type ConfigDifference struct {
	Path   string `json:"path"`
	Before any    `json:"before"`
	After  any    `json:"after"`
}

// ServiceComparison is one service in an environment diff.
type ServiceComparison struct {
	ServiceID string `json:"service_id"`
	Slug      string `json:"slug"`
	// Presence is both, only_base or only_target.
	Presence  string               `json:"presence"`
	Config    []ConfigDifference   `json:"config"`
	Variables []VariableComparison `json:"variables"`
	Image     struct {
		Base   *string `json:"base"`
		Target *string `json:"target"`
	} `json:"image"`
}

// EnvironmentDiff is what differs between two environments, changed
// services first.
type EnvironmentDiff struct {
	BaseEnvironmentID   string               `json:"base_environment_id"`
	TargetEnvironmentID string               `json:"target_environment_id"`
	Services            []ServiceComparison  `json:"services"`
	SharedVariables     []VariableComparison `json:"shared_variables"`
}

// PromoteInclude says what a promotion carries over.
type PromoteInclude struct {
	Config bool `json:"config"`
	// Variables is none, non_secret or all.
	Variables string `json:"variables"`
	Image     bool   `json:"image"`
}

// PromoteInput is the body of POST /v1/environments/{environmentId}/promote.
type PromoteInput struct {
	FromEnvironmentID string `json:"from_environment_id"`
	// Services is "all" or a list of service IDs.
	Services any            `json:"services"`
	Include  PromoteInclude `json:"include"`
}

// CreateEnvironment creates an environment, blank or cloned.
func (c *Client) CreateEnvironment(ctx context.Context, projectID string, in CreateEnvironmentInput) (*Environment, error) {
	return fetch[Environment](ctx, c, RouteCreateEnvironment, nil, in, projectID)
}

// DiffEnvironments compares two environments of a project; secrets are
// compared by fingerprint, and no value is returned.
func (c *Client) DiffEnvironments(ctx context.Context, projectID, base, target string) (*EnvironmentDiff, error) {
	return fetch[EnvironmentDiff](ctx, c, RouteEnvironmentDiff, url.Values{"base": {base}, "target": {target}}, nil, projectID)
}

// PromoteEnvironment proposes promoting another environment into
// environmentID as a change set; it never applies it.
func (c *Client) PromoteEnvironment(ctx context.Context, environmentID string, in PromoteInput) (*ChangeSet, error) {
	return fetch[ChangeSet](ctx, c, RoutePromoteEnvironment, nil, in, environmentID)
}

// DeleteEnvironment deletes an environment; confirm must be its slug.
func (c *Client) DeleteEnvironment(ctx context.Context, environmentID, confirm string) error {
	return c.call(ctx, RouteDeleteEnvironment, url.Values{"confirm": {confirm}}, nil, nil, environmentID)
}
