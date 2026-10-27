package api

import (
	"context"
	"net/http"
)

// Drain routes (ADR 0005, "Node lifecycle").
var (
	RouteDrainNode    = Route{http.MethodPost, "/v1/workspaces/{workspaceId}/nodes/{nodeId}/drain"}
	RouteGetNodeDrain = Route{http.MethodGet, "/v1/workspaces/{workspaceId}/nodes/{nodeId}/drain"}
	RouteResumeNode   = Route{http.MethodPost, "/v1/workspaces/{workspaceId}/nodes/{nodeId}/resume"}
)

// Drain statuses.
const (
	DrainRunning   = "running"
	DrainBlocked   = "blocked"
	DrainFailed    = "failed"
	DrainCompleted = "completed"
	DrainCancelled = "cancelled"
)

// Error codes of the drain routes.
const (
	// ErrDrainInProgress is the 409 while a drain of the server runs.
	ErrDrainInProgress = "drain_in_progress"
	// ErrNodeNotDrainable is the 409 for a server that never connected.
	ErrNodeNotDrainable = "node_not_drainable"
	// ErrNodeNotDraining is the 409 when resuming a server that is in service.
	ErrNodeNotDraining = "node_not_draining"
)

// NodeDrain is a drain of one server.
type NodeDrain struct {
	ID     string `json:"id"`
	NodeID string `json:"node_id"`
	// Status is one of the Drain* constants.
	Status string      `json:"status"`
	Force  bool        `json:"force"`
	Moves  []DrainMove `json:"moves"`
	// Blocked lists the volume services that keep the drain from finishing.
	Blocked    []DrainBlocker `json:"blocked"`
	Error      *string        `json:"error"`
	StartedBy  *string        `json:"started_by"`
	StartedAt  int64          `json:"started_at"`
	FinishedAt *int64         `json:"finished_at"`
}

// DrainMove is one replica moving off the drained server.
type DrainMove struct {
	WorkloadID    string `json:"workload_id"`
	DeploymentID  string `json:"deployment_id"`
	ServiceID     string `json:"service_id"`
	EnvironmentID string `json:"environment_id"`
	Replica       int    `json:"replica"`
	// State is pending, moving, done, failed or stopped.
	State         string  `json:"state"`
	ToNodeID      *string `json:"to_node_id"`
	NewWorkloadID *string `json:"new_workload_id"`
	Error         *string `json:"error"`
}

// DrainBlocker is a volume service whose data lives on the drained server.
type DrainBlocker struct {
	ServiceID     string `json:"service_id"`
	EnvironmentID string `json:"environment_id"`
	ServiceName   string `json:"service_name"`
}

// DrainNode starts draining a server; force stops volume services instead
// of stopping at blocked.
func (c *Client) DrainNode(ctx context.Context, workspaceID, nodeID string, force bool) (*NodeDrain, error) {
	return fetch[NodeDrain](ctx, c, RouteDrainNode, nil, map[string]bool{"force": force}, workspaceID, nodeID)
}

// GetNodeDrain returns the server's latest drain, nil when it was never drained.
func (c *Client) GetNodeDrain(ctx context.Context, workspaceID, nodeID string) (*NodeDrain, error) {
	out, err := fetch[struct {
		Drain *NodeDrain `json:"drain"`
	}](ctx, c, RouteGetNodeDrain, nil, nil, workspaceID, nodeID)
	if err != nil {
		return nil, err
	}
	return out.Drain, nil
}

// ResumeNode takes a draining or maintenance server back into service.
func (c *Client) ResumeNode(ctx context.Context, workspaceID, nodeID string) (*Node, error) {
	return fetch[Node](ctx, c, RouteResumeNode, nil, nil, workspaceID, nodeID)
}
