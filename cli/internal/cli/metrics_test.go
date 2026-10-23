package cli

import (
	"encoding/json"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

const mib = 1024 * 1024

// series builds a series with one point per value, 15 s apart and ending
// at apitest.Now; a nil value is a step without samples.
func series(metric string, values ...*float64) api.MetricSeries {
	s := api.MetricSeries{Metric: metric, Points: []api.MetricPoint{}}
	for i, v := range values {
		s.Points = append(s.Points, api.MetricPoint{T: apitest.Now - int64(len(values)-1-i)*15000, V: v})
	}
	return s
}

func vals(xs ...float64) []*float64 {
	out := make([]*float64, len(xs))
	for i := range xs {
		out[i] = &xs[i]
	}
	return out
}

func seedServiceMetrics(h *harness, d apitest.ServiceMetricsData) {
	cpu := vals(100, 200, 0, 300)
	cpu[2] = nil
	if d.Limits == nil {
		d.Limits = &api.MetricLimits{CPUMillis: 500, MemoryBytes: 512 * mib}
	}
	d.Series = []api.MetricSeries{
		series("restarts", vals(0, 1, 0, 1)...),
		series("net_rx", vals(1024, 2048)...),
		series("memory", vals(128*mib, 256*mib)...),
		series("cpu", cpu...),
	}
	d.Replicas = []api.MetricSeries{
		{Metric: "cpu", WorkloadID: "wl_0002", Points: series("cpu", vals(50, 70)...).Points},
		{Metric: "cpu", WorkloadID: "wl_0001", Points: series("cpu", vals(80, 90)...).Points},
	}
	h.fake.SetServiceMetrics(apitest.APIServiceID, d)
}

// metricsQueries returns the query strings of the requests to route.
func metricsQueries(h *harness, route api.Route) []url.Values {
	var out []url.Values
	for _, req := range h.fake.Requests() {
		if req.Pattern == route.Method+" "+route.Path {
			q, _ := url.ParseQuery(req.Query)
			out = append(out, q)
		}
	}
	return out
}

func lastQuery(t *testing.T, h *harness, route api.Route) url.Values {
	t.Helper()
	qs := metricsQueries(h, route)
	if len(qs) == 0 {
		t.Fatalf("no request to %s", route)
	}
	return qs[len(qs)-1]
}

func TestMetricsTable(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedServiceMetrics(h, apitest.ServiceMetricsData{})

	r := h.ok("", "metrics")
	contains(t, r.stdout, "API in production, last 1h (15s steps)")
	lines := strings.Split(r.stdout, "\n")
	header := strings.Fields(lines[2])
	if strings.Join(header, " ") != "METRIC LATEST AVG MAX LIMIT" {
		t.Errorf("header = %q", lines[2])
	}
	if !strings.HasPrefix(lines[3], "cpu ") || !strings.HasPrefix(lines[4], "memory ") ||
		!strings.HasPrefix(lines[5], "net_rx ") || !strings.HasPrefix(lines[6], "restarts ") {
		t.Errorf("rows not in metric order:\n%s", r.stdout)
	}
	for _, want := range []string{"300m (60%)", "200m (40%)", "500m",
		"256.0 MiB (50%)", "192.0 MiB (38%)", "512.0 MiB",
		"2.0 KiB/s", "1.5 KiB/s", "2 restarts in this range"} {
		contains(t, r.stdout, want)
	}
	notContains(t, r.stdout, "▁")
	notContains(t, r.stdout, "\x1b[")
	if r.stderr != "" {
		t.Errorf("stderr = %q", r.stderr)
	}

	q := lastQuery(t, h, api.RouteServiceMetrics)
	if q.Get("environment_id") != apitest.ProductionID || q.Get("from") != strconv.FormatInt(apitest.Now-3600000, 10) ||
		q.Has("to") || q.Has("metrics") || q.Has("group") {
		t.Errorf("query = %v", q)
	}
}

func TestMetricsJSON(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedServiceMetrics(h, apitest.ServiceMetricsData{Backend: api.MetricsBackendD1})

	r := h.ok("", "metrics", "--json", "--metric", "cpu")
	if r.stderr != "" {
		t.Errorf("--json printed notes: %q", r.stderr)
	}
	var got struct {
		StepS          int64 `json:"step_s"`
		Backend        string
		ShortRetention bool `json:"short_retention"`
		Limits         *api.MetricLimits
		Series         []struct {
			Metric string
			Points [][2]*float64
		}
	}
	if err := json.Unmarshal([]byte(r.stdout), &got); err != nil {
		t.Fatalf("%v\n%s", err, r.stdout)
	}
	if got.StepS != 15 || got.Backend != "d1" || !got.ShortRetention || got.Limits == nil || got.Limits.CPUMillis != 500 {
		t.Errorf("meta = %+v", got)
	}
	if len(got.Series) != 1 || got.Series[0].Metric != "cpu" || len(got.Series[0].Points) != 4 {
		t.Fatalf("series = %+v", got.Series)
	}
	if p := got.Series[0].Points[2]; p[0] == nil || p[1] != nil {
		t.Errorf("a step without samples should be [t, null], got %v", p)
	}
}

func TestMetricsReplicas(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedServiceMetrics(h, apitest.ServiceMetricsData{})

	r := h.ok("", "metrics", "--replicas", "--range", "24h", "-m", "cpu")
	lines := strings.Split(r.stdout, "\n")
	contains(t, lines[0], "last 24h (5m steps)")
	contains(t, lines[2], "REPLICA")
	if !strings.Contains(lines[3], "wl_0001") || !strings.Contains(lines[4], "wl_0002") {
		t.Errorf("replicas not sorted:\n%s", r.stdout)
	}
	q := lastQuery(t, h, api.RouteServiceMetrics)
	if q.Get("group") != "replica" || q.Get("metrics") != "cpu" || q.Get("from") != strconv.FormatInt(apitest.Now-86400000, 10) {
		t.Errorf("query = %v", q)
	}
}

func TestMetricsRangeFlags(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedServiceMetrics(h, apitest.ServiceMetricsData{})

	r := h.ok("", "metrics", "--from", "3h", "--to", "1h", "--metric", "cpu,network", "-m", "cpu")
	q := lastQuery(t, h, api.RouteServiceMetrics)
	if q.Get("from") != strconv.FormatInt(apitest.Now-3*3600000, 10) || q.Get("to") != strconv.FormatInt(apitest.Now-3600000, 10) {
		t.Errorf("range query = %v", q)
	}
	if q.Get("metrics") != "cpu,net_rx,net_tx" {
		t.Errorf("metrics = %q", q.Get("metrics"))
	}
	contains(t, r.stdout, "2026-10-22 09:00 UTC to 2026-10-22 11:00 UTC (1m steps)")

	r = h.ok("", "metrics", "--from", "2026-10-22T10:30:00Z")
	contains(t, r.stdout, "since 2026-10-22 10:30 UTC")
	if q := lastQuery(t, h, api.RouteServiceMetrics); q.Has("to") {
		t.Errorf("--from alone sent to: %v", q)
	}

	r = h.ok("", "metrics", "--range", "6h", "--to", "1h")
	if q := lastQuery(t, h, api.RouteServiceMetrics); q.Get("from") != strconv.FormatInt(apitest.Now-7*3600000, 10) {
		t.Errorf("--range with --to: %v", q)
	}

	before := len(metricsQueries(h, api.RouteServiceMetrics))
	for args, msg := range map[string]string{
		"--range 2h":            `unknown --range "2h"; use one of 1h, 6h, 24h, 7d, 30d`,
		"--range 6h --from 1h":  "pass either --range or --from, not both",
		"--from yesterday":      `invalid --from "yesterday"`,
		"--to soon":             `invalid --to "soon"`,
		"--from 1h --to 2h":     "--from must be before --to",
		"--from 100d":           "at most 90 days",
		"--metric cpu,bogus":    `unknown metric "bogus"; use cpu, memory, memory_max`,
		"--replicas extra-word": "takes no arguments",
	} {
		r := h.expect(exitcode.Usage, "", append([]string{"metrics"}, strings.Fields(args)...)...)
		contains(t, r.stderr, msg)
	}
	if after := len(metricsQueries(h, api.RouteServiceMetrics)); after != before {
		t.Errorf("invalid flags still queried the API (%d requests)", after-before)
	}
}

func TestMetricsNotes(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedServiceMetrics(h, apitest.ServiceMetricsData{Backend: api.MetricsBackendD1, Approximate: true})

	r := h.ok("", "metrics")
	contains(t, r.stderr, "note: this control plane keeps metrics for 48 hours only")
	notContains(t, r.stderr, "samples older than that are missing")
	contains(t, r.stderr, "note: some samples are approximate: they came from Docker stats on a cgroup v1 host")

	r = h.ok("", "metrics", "--range", "7d")
	contains(t, r.stderr, "samples older than that are missing")
}

func TestMetricsWithoutSamples(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "metrics", "--service", "db")
	contains(t, r.stdout, "Postgres in production, last 1h")
	contains(t, r.stdout, "No samples in this range. Metrics are recorded while a deployment of Postgres is running.")
	notContains(t, r.stdout, "METRIC")
}

func TestMetricsSparkline(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedServiceMetrics(h, apitest.ServiceMetricsData{})

	h.tty, h.ttyColor = true, true
	r := h.ok("", "metrics", "-m", "cpu")
	contains(t, r.stdout, "TREND")
	contains(t, r.stdout, "\x1b[36m▃▆ █\x1b[0m")

	r = h.ok("", "metrics", "-m", "cpu", "--no-color")
	contains(t, r.stdout, "TREND")
	contains(t, r.stdout, "▃▆ █")
	notContains(t, r.stdout, "\x1b[")

	h.tty = false
	r = h.ok("", "metrics", "-m", "cpu")
	notContains(t, r.stdout, "TREND")
	notContains(t, r.stdout, "▃")
}

func TestMetricsErrors(t *testing.T) {
	h := newHarness(t)
	h.link()

	r := h.expect(exitcode.NotFound, "", "metrics", "--service", "nope")
	contains(t, r.stderr, `no service "nope" in project Shop`)

	h.env[EnvToken] = h.fake.AddToken("viewer", "projects:read")
	r = h.expect(exitcode.Forbidden, "", "metrics")
	contains(t, r.stderr, "services:read")
	contains(t, r.stderr, "hint: the API token lacks a scope")

	r = h.expect(exitcode.Forbidden, "", "metrics", "--json")
	var body struct {
		Error struct {
			Status   int `json:"status"`
			ExitCode int `json:"exit_code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(r.stderr), &body); err != nil || body.Error.Status != 403 || body.Error.ExitCode != exitcode.Forbidden {
		t.Errorf("--json error = %s (%v)", r.stderr, err)
	}
}

func TestMetricsSummary(t *testing.T) {
	h := newHarness(t)
	h.link()
	cpu, cpuLimit, mem, memLimit := 120.0, 500.0, 180.0*mib, 512.0*mib
	h.fake.SetMetricsSummary(api.ServiceMetricsSummary{
		ServiceID: apitest.APIServiceID, CPUMillis: &cpu, CPULimitMillis: &cpuLimit, MemBytes: &mem, MemLimitBytes: &memLimit,
		CPU: series("cpu", vals(10, 120)...).Points, Memory: series("memory", vals(mem)...).Points,
	}, "")

	r := h.ok("", "metrics", "summary", "--environment", "staging")
	contains(t, r.stdout, "Shop in staging, last 5 minutes")
	lines := strings.Split(r.stdout, "\n")
	if strings.Join(strings.Fields(lines[2]), " ") != "SERVICE CPU MEMORY" {
		t.Errorf("header = %q", lines[2])
	}
	contains(t, lines[3], "API")
	contains(t, lines[3], "120m of 500m (24%)")
	contains(t, lines[3], "180.0 MiB of 512.0 MiB (35%)")
	if strings.Join(strings.Fields(lines[4]), " ") != "Postgres - -" {
		t.Errorf("service without samples = %q", lines[4])
	}
	if q := lastQuery(t, h, api.RouteMetricsSummary); q.Get("environment_id") != apitest.StagingID {
		t.Errorf("query = %v", q)
	}

	h.tty = true
	r = h.ok("", "metrics", "summary")
	contains(t, r.stdout, "CPU 1H")
	contains(t, r.stdout, "▂█")

	r = h.ok("", "metrics", "summary", "--json")
	var got api.MetricsSummary
	if err := json.Unmarshal([]byte(r.stdout), &got); err != nil {
		t.Fatal(err)
	}
	if got.EnvironmentID != apitest.ProductionID || len(got.Services) != 2 || got.Services[1].CPUMillis != nil {
		t.Errorf("summary = %+v", got)
	}
	contains(t, r.stdout, `"cpu_millis": null`)
}

func TestServersMetrics(t *testing.T) {
	h := newHarness(t)
	h.login()
	h.fake.SetNodeMetrics(apitest.NodeID, apitest.NodeMetricsData{Series: []api.MetricSeries{
		series("load1", vals(0.25, 0.5)...),
		series("cpu_percent", vals(10, 13)...),
		series("disk", vals(20*1024*mib)...),
		series("memory", vals(1536*mib)...),
	}})

	r := h.ok("", "servers", "metrics", "edge-1")
	contains(t, r.stdout, "edge-1, last 1h (15s steps)")
	lines := strings.Split(r.stdout, "\n")
	if strings.Join(strings.Fields(lines[2]), " ") != "METRIC LATEST AVG MAX" {
		t.Errorf("header = %q", lines[2])
	}
	for i, prefix := range []string{"cpu_percent", "memory", "disk", "load1"} {
		if !strings.HasPrefix(lines[3+i], prefix+" ") {
			t.Errorf("row %d = %q, want %s", i, lines[3+i], prefix)
		}
	}
	contains(t, lines[3], "13.0%")
	contains(t, lines[3], "11.5%")
	contains(t, lines[4], "1.5 GiB")
	contains(t, lines[5], "20.0 GiB")
	contains(t, lines[6], "0.50")

	h.ok("", "servers", "metrics", apitest.NodeID, "--range", "7d", "-m", "cpu_percent")
	q := lastQuery(t, h, api.RouteNodeMetrics)
	if q.Get("metrics") != "cpu_percent" || q.Get("from") != strconv.FormatInt(apitest.Now-7*86400000, 10) {
		t.Errorf("query = %v", q)
	}

	r = h.ok("", "servers", "metrics", "edge-1", "--json")
	var got api.NodeMetrics
	if err := json.Unmarshal([]byte(r.stdout), &got); err != nil || len(got.Series) != 4 || got.Backend != "analytics_engine" {
		t.Errorf("--json = %s (%v)", r.stdout, err)
	}

	r = h.expect(exitcode.NotFound, "", "servers", "metrics", "web-9")
	contains(t, r.stderr, `no server "web-9" in Acme`)
	r = h.expect(exitcode.Usage, "", "servers", "metrics", "edge-1", "-m", "network")
	contains(t, r.stderr, `unknown metric "network"; use cpu_percent, memory, disk, load1`)
	h.expect(exitcode.Usage, "", "servers", "metrics")

	h.env[EnvToken] = h.fake.AddToken("viewer", "projects:read")
	h.expect(exitcode.Forbidden, "", "servers", "metrics", "edge-1")
}

func TestSparkline(t *testing.T) {
	pts := func(vs ...*float64) []api.MetricPoint {
		return series("x", vs...).Points
	}
	none := []*float64{nil}
	for name, c := range map[string]struct {
		points []api.MetricPoint
		width  int
		want   string
	}{
		"scale":        {pts(vals(0, 1, 2, 3, 4, 5, 6, 7)...), 24, "▁▂▃▄▅▆▇█"},
		"zeros":        {pts(vals(0, 0, 0)...), 24, "▁▁▁"},
		"gap":          {pts(append(append(vals(1), none...), vals(8)...)...), 24, "▂ █"},
		"no samples":   {pts(nil, nil), 24, ""},
		"empty":        {nil, 24, ""},
		"bucket peaks": {pts(vals(1, 8, 1, 1, 4, 1)...), 3, "█▂▅"},
	} {
		if got := sparkline(c.points, c.width); got != c.want {
			t.Errorf("%s: sparkline = %q, want %q", name, got, c.want)
		}
	}
}

func TestMetricFormats(t *testing.T) {
	for _, c := range []struct{ got, want string }{
		{formatCPU(0), "0m"},
		{formatCPU(2.5), "2.5m"},
		{formatCPU(250), "250m"},
		{formatCPU(1500), "1.50 cores"},
		{formatBytes(512), "512 B"},
		{formatBytes(1536), "1.5 KiB"},
		{formatBytes(3 * 1024 * mib), "3.0 GiB"},
		{formatServiceMetric("disk_write", 2048), "2.0 KiB/s"},
		{formatServiceMetric("pids", 12), "12"},
		{formatServiceMetric("pids", 12.4), "12.4"},
		{formatStep(15), "15s"},
		{formatStep(300), "5m"},
		{formatStep(21600), "6h"},
	} {
		if c.got != c.want {
			t.Errorf("got %q, want %q", c.got, c.want)
		}
	}
}
