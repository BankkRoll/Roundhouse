package apitest

import (
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
)

// ServiceMetricsData is what the fake answers for a service's metrics in
// every environment; see [Fake.SetServiceMetrics].
type ServiceMetricsData struct {
	// Backend is "analytics_engine" when empty.
	Backend     string
	Approximate bool
	Limits      *api.MetricLimits
	// Series is answered for group=service, Replicas for group=replica.
	Series   []api.MetricSeries
	Replicas []api.MetricSeries
}

// NodeMetricsData is what the fake answers for a server's metrics.
type NodeMetricsData struct {
	Backend string
	Series  []api.MetricSeries
}

// SetServiceMetrics sets the metrics answered for a service.
func (f *Fake) SetServiceMetrics(serviceID string, d ServiceMetricsData) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.serviceMetrics == nil {
		f.serviceMetrics = map[string]ServiceMetricsData{}
	}
	f.serviceMetrics[serviceID] = d
}

// SetNodeMetrics sets the metrics answered for a server.
func (f *Fake) SetNodeMetrics(nodeID string, d NodeMetricsData) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.nodeMetrics == nil {
		f.nodeMetrics = map[string]NodeMetricsData{}
	}
	f.nodeMetrics[nodeID] = d
}

// SetMetricsSummary sets a service's entry in project summaries; services
// without one are answered without samples.
func (f *Fake) SetMetricsSummary(s api.ServiceMetricsSummary, backend string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.summaries == nil {
		f.summaries = map[string]api.ServiceMetricsSummary{}
	}
	f.summaries[s.ServiceID] = s
	f.summaryBackend = backend
}

// metricsSteps mirrors STEPS in packages/shared/src/metrics-layout.ts.
var metricsSteps = [][2]int64{
	{3600000, 15}, {6 * 3600000, 60}, {24 * 3600000, 300},
	{7 * 24 * 3600000, 1800}, {30 * 24 * 3600000, 7200}, {90 * 24 * 3600000, 21600},
}

// metricsRange validates from and to as the API does and returns the
// range and its step.
func metricsRange(w http.ResponseWriter, r *http.Request) (from, to, step int64, ok bool) {
	q := r.URL.Query()
	to = Now
	if s := q.Get("to"); s != "" {
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil || v < 0 {
			apiError(w, http.StatusBadRequest, "invalid_request", "to: Expected number")
			return 0, 0, 0, false
		}
		to = v
	}
	from = to - 3600000
	if s := q.Get("from"); s != "" {
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil || v < 0 {
			apiError(w, http.StatusBadRequest, "invalid_request", "from: Expected number")
			return 0, 0, 0, false
		}
		from = v
	}
	if from >= to {
		apiError(w, http.StatusBadRequest, "invalid_request", "`from` must be before `to`")
		return 0, 0, 0, false
	}
	span := to - from
	if span > metricsSteps[len(metricsSteps)-1][0] {
		apiError(w, http.StatusBadRequest, "invalid_request", "The range may span at most 90 days")
		return 0, 0, 0, false
	}
	for _, s := range metricsSteps {
		if span <= s[0] {
			return from, to, s[1], true
		}
	}
	return from, to, metricsSteps[len(metricsSteps)-1][1], true
}

// pickSeries filters series to the `metrics` query, rejecting unknown names.
func pickSeries(w http.ResponseWriter, r *http.Request, names []string, series []api.MetricSeries) ([]api.MetricSeries, bool) {
	raw := r.URL.Query().Get("metrics")
	if raw == "" {
		return nonNil(series), true
	}
	var picked []string
	for _, m := range strings.Split(raw, ",") {
		m = strings.TrimSpace(m)
		if m == "" {
			continue
		}
		if !slices.Contains(names, m) {
			apiError(w, http.StatusBadRequest, "invalid_request", "metrics: unknown metric "+m)
			return nil, false
		}
		picked = append(picked, m)
	}
	out := []api.MetricSeries{}
	for _, s := range series {
		if slices.Contains(picked, s.Metric) {
			out = append(out, s)
		}
	}
	return out, true
}

func nonNil(s []api.MetricSeries) []api.MetricSeries {
	if s == nil {
		return []api.MetricSeries{}
	}
	return s
}

func backendOr(b string) string {
	if b == "" {
		return api.MetricsBackendAnalytics
	}
	return b
}

func (f *Fake) serviceMetricsHandler(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	env, ok := environment(w, r, p, true)
	if !ok {
		return
	}
	group := r.URL.Query().Get("group")
	if group != "" && group != "service" && group != "replica" {
		apiError(w, http.StatusBadRequest, "invalid_request", "group: Invalid enum value")
		return
	}
	from, to, step, ok := metricsRange(w, r)
	if !ok {
		return
	}
	d := f.serviceMetrics[s.ID]
	all := d.Series
	if group == "replica" {
		all = d.Replicas
	}
	series, ok := pickSeries(w, r, api.ServiceMetricNames, all)
	if !ok {
		return
	}
	limits := d.Limits
	if _, configured := f.configs[s.ID+"/"+env]; !configured {
		limits = nil
	}
	backend := backendOr(d.Backend)
	writeJSON(w, http.StatusOK, api.ServiceMetrics{
		StepS: step, From: from, To: to, Backend: backend, ShortRetention: backend == api.MetricsBackendD1,
		Limits: limits, Approximate: d.Approximate, Series: series,
	})
}

func (f *Fake) metricsSummaryHandler(w http.ResponseWriter, r *http.Request) {
	p := f.project(w, r.PathValue("projectId"))
	if p == nil {
		return
	}
	env, ok := environment(w, r, p, false)
	if !ok {
		return
	}
	if env == "" {
		env = ProductionID
	}
	services := []api.ServiceMetricsSummary{}
	for _, s := range p.Services {
		sum, ok := f.summaries[s.ID]
		if !ok {
			sum = api.ServiceMetricsSummary{ServiceID: s.ID, CPU: []api.MetricPoint{}, Memory: []api.MetricPoint{}}
		}
		services = append(services, sum)
	}
	backend := backendOr(f.summaryBackend)
	writeJSON(w, http.StatusOK, api.MetricsSummary{
		EnvironmentID: env, Backend: backend, ShortRetention: backend == api.MetricsBackendD1, Services: services,
	})
}

func (f *Fake) nodeMetricsHandler(w http.ResponseWriter, r *http.Request) {
	if !f.workspace(w, r) {
		return
	}
	if !slices.ContainsFunc(f.nodes, func(n api.Node) bool { return n.ID == r.PathValue("nodeId") }) {
		apiError(w, http.StatusNotFound, "not_found", "Server not found")
		return
	}
	from, to, step, ok := metricsRange(w, r)
	if !ok {
		return
	}
	d := f.nodeMetrics[r.PathValue("nodeId")]
	series, ok := pickSeries(w, r, api.NodeMetricNames, d.Series)
	if !ok {
		return
	}
	backend := backendOr(d.Backend)
	writeJSON(w, http.StatusOK, api.NodeMetrics{
		StepS: step, From: from, To: to, Backend: backend, ShortRetention: backend == api.MetricsBackendD1, Series: series,
	})
}
