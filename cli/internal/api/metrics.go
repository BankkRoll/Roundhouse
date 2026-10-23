package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Metrics routes (ADR 0008).
var (
	RouteServiceMetrics = Route{http.MethodGet, "/v1/services/{serviceId}/metrics"}
	RouteMetricsSummary = Route{http.MethodGet, "/v1/projects/{projectId}/metrics/summary"}
	RouteNodeMetrics    = Route{http.MethodGet, "/v1/workspaces/{workspaceId}/nodes/{nodeId}/metrics"}
)

// ServiceMetricNames are the container metrics the API serves, in the order
// of SERVICE_METRICS in packages/shared/src/metrics-layout.ts:
//   - cpu: average millicores;
//   - memory: average working set, bytes; memory_max: its peak in a step;
//   - net_rx, net_tx, disk_read, disk_write: bytes per second;
//   - restarts: restarts in a step; pids: average process count.
var ServiceMetricNames = []string{"cpu", "memory", "memory_max", "net_rx", "net_tx", "disk_read", "disk_write", "restarts", "pids"}

// NodeMetricNames are the server metrics the API serves: CPU percent,
// memory and disk bytes used, and the one-minute load average.
var NodeMetricNames = []string{"cpu_percent", "memory", "disk", "load1"}

// Metrics backends.
const (
	MetricsBackendAnalytics = "analytics_engine"
	// MetricsBackendD1 is the short-retention fallback: samples older than
	// 48 hours are gone.
	MetricsBackendD1 = "d1"
)

// MetricPoint is one step of a series. On the wire it is the tuple
// `[t_ms, value]`, value null for a step without samples.
type MetricPoint struct {
	// T is the start of the step, unix ms.
	T int64
	// V is nil when the step had no samples.
	V *float64
}

// UnmarshalJSON decodes a `[t_ms, value|null]` tuple.
func (p *MetricPoint) UnmarshalJSON(data []byte) error {
	var raw []json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if len(raw) != 2 {
		return fmt.Errorf("metric point: want [t, value], got %d elements", len(raw))
	}
	var t float64
	if err := json.Unmarshal(raw[0], &t); err != nil {
		return fmt.Errorf("metric point time: %w", err)
	}
	p.T, p.V = int64(t), nil
	if bytes.Equal(bytes.TrimSpace(raw[1]), []byte("null")) {
		return nil
	}
	var v float64
	if err := json.Unmarshal(raw[1], &v); err != nil {
		return fmt.Errorf("metric point value: %w", err)
	}
	p.V = &v
	return nil
}

// MarshalJSON encodes the point as the API does, `[t_ms, value|null]`.
func (p MetricPoint) MarshalJSON() ([]byte, error) {
	v := "null"
	if p.V != nil {
		v = strconv.FormatFloat(*p.V, 'f', -1, 64)
	}
	return []byte("[" + strconv.FormatInt(p.T, 10) + "," + v + "]"), nil
}

// MetricSeries is one metric over a range.
type MetricSeries struct {
	Metric string `json:"metric"`
	// WorkloadID is set for per-replica series (group=replica).
	WorkloadID string        `json:"workload_id,omitempty"`
	Points     []MetricPoint `json:"points"`
}

// MetricLimits are a service's configured limits in an environment.
type MetricLimits struct {
	CPUMillis   float64 `json:"cpu_millis"`
	MemoryBytes float64 `json:"memory_bytes"`
}

// ServiceMetrics is a service's metrics over a range.
type ServiceMetrics struct {
	// StepS is the step between points, seconds.
	StepS int64 `json:"step_s"`
	// From and To are the aligned range, unix ms.
	From    int64  `json:"from"`
	To      int64  `json:"to"`
	Backend string `json:"backend"`
	// ShortRetention is set on the D1 fallback, which keeps 48 hours.
	ShortRetention bool `json:"short_retention"`
	// Limits is nil when the service has no config in the environment.
	Limits *MetricLimits `json:"limits"`
	// Approximate is set when some samples came from Docker stats on a
	// cgroup v1 host.
	Approximate bool           `json:"approximate"`
	Series      []MetricSeries `json:"series"`
}

// NodeMetrics is a server's usage over a range.
type NodeMetrics struct {
	StepS          int64          `json:"step_s"`
	From           int64          `json:"from"`
	To             int64          `json:"to"`
	Backend        string         `json:"backend"`
	ShortRetention bool           `json:"short_retention"`
	Series         []MetricSeries `json:"series"`
}

// ServiceMetricsSummary is one service's recent usage. The scalar values
// are averages over the last five minutes, nil without samples.
type ServiceMetricsSummary struct {
	ServiceID      string   `json:"service_id"`
	CPUMillis      *float64 `json:"cpu_millis"`
	MemBytes       *float64 `json:"mem_bytes"`
	CPULimitMillis *float64 `json:"cpu_limit_millis"`
	MemLimitBytes  *float64 `json:"mem_limit_bytes"`
	// CPU and Memory cover the last hour in 5-minute steps, oldest first.
	CPU    []MetricPoint `json:"cpu"`
	Memory []MetricPoint `json:"memory"`
}

// MetricsSummary is the recent usage of every service in a project
// environment.
type MetricsSummary struct {
	EnvironmentID  string                  `json:"environment_id"`
	Backend        string                  `json:"backend"`
	ShortRetention bool                    `json:"short_retention"`
	Services       []ServiceMetricsSummary `json:"services"`
}

// MetricsQuery selects a range and metrics. Zero From or To lets the API
// default them (to now, and from an hour before to).
type MetricsQuery struct {
	From, To int64
	// Metrics is empty for every metric.
	Metrics []string
}

func (q MetricsQuery) values() url.Values {
	v := url.Values{}
	if q.From > 0 {
		v.Set("from", strconv.FormatInt(q.From, 10))
	}
	if q.To > 0 {
		v.Set("to", strconv.FormatInt(q.To, 10))
	}
	if len(q.Metrics) > 0 {
		v.Set("metrics", strings.Join(q.Metrics, ","))
	}
	return v
}

// ServiceMetrics returns a service's container metrics in an environment;
// perReplica keeps one series per replica instead of the service total.
func (c *Client) ServiceMetrics(ctx context.Context, serviceID, environmentID string, q MetricsQuery, perReplica bool) (*ServiceMetrics, error) {
	v := q.values()
	v.Set("environment_id", environmentID)
	if perReplica {
		v.Set("group", "replica")
	}
	return fetch[ServiceMetrics](ctx, c, RouteServiceMetrics, v, nil, serviceID)
}

// MetricsSummary returns the recent usage of every service in a project
// environment; an empty environmentID means production.
func (c *Client) MetricsSummary(ctx context.Context, projectID, environmentID string) (*MetricsSummary, error) {
	var v url.Values
	if environmentID != "" {
		v = envQuery(environmentID)
	}
	return fetch[MetricsSummary](ctx, c, RouteMetricsSummary, v, nil, projectID)
}

// NodeMetrics returns a server's usage over a range.
func (c *Client) NodeMetrics(ctx context.Context, workspaceID, nodeID string, q MetricsQuery) (*NodeMetrics, error) {
	return fetch[NodeMetrics](ctx, c, RouteNodeMetrics, q.values(), nil, workspaceID, nodeID)
}
