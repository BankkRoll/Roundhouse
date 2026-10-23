package cli

import (
	"cmp"
	"context"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

type metricsRange struct {
	label string
	span  time.Duration
}

// metricsRanges mirrors METRICS_RANGES in packages/shared/src/metrics-layout.ts.
var metricsRanges = []metricsRange{
	{"1h", time.Hour},
	{"6h", 6 * time.Hour},
	{"24h", 24 * time.Hour},
	{"7d", 7 * 24 * time.Hour},
	{"30d", 30 * 24 * time.Hour},
}

// maxMetricsRange mirrors MAX_METRICS_RANGE_MS: Analytics Engine keeps
// three months.
const maxMetricsRange = 90 * 24 * time.Hour

// shortRetention mirrors D1_METRICS_RETENTION_MS.
const shortRetention = 48 * time.Hour

// sparkWidth is the most characters a sparkline takes.
const sparkWidth = 24

// serviceMetricAliases expand to the pair of metrics they name.
var serviceMetricAliases = map[string][]string{
	"network": {"net_rx", "net_tx"},
	"disk":    {"disk_read", "disk_write"},
}

func rangeLabels() []string {
	out := make([]string, len(metricsRanges))
	for i, r := range metricsRanges {
		out[i] = r.label
	}
	return out
}

// -----------------------------------------------------------------------------
// Flags
// -----------------------------------------------------------------------------

// metricsFlags select the range and metrics of a metrics query.
type metricsFlags struct {
	rng, from, to string
	metrics       []string
}

func (f *metricsFlags) register(cmd *cobra.Command, names []string, aliases bool) {
	cmd.Flags().StringVar(&f.rng, "range", "1h", "range ending now (or at --to): "+strings.Join(rangeLabels(), ", "))
	cmd.Flags().StringVar(&f.from, "from", "", "start of the range: a duration ago (90m, 2d) or a time (RFC 3339)")
	cmd.Flags().StringVar(&f.to, "to", "", "end of the range, in the same forms as --from (default: now)")
	help := "metric to show, repeatable or comma-separated (default: all): " + strings.Join(names, ", ")
	if aliases {
		help += "; network and disk select both directions"
	}
	cmd.Flags().StringSliceVarP(&f.metrics, "metric", "m", nil, help)
}

// metricsWindow is a validated query and a description of its range.
type metricsWindow struct {
	query api.MetricsQuery
	label string
	span  time.Duration
}

// window validates the flags against names (the metrics the route serves)
// and builds the query. A preset range leaves `to` to the control plane's
// clock, so a skewed local clock cannot push the range into the future.
func (f *metricsFlags) window(cmd *cobra.Command, now time.Time, names []string, aliases map[string][]string) (*metricsWindow, error) {
	if cmd.Flags().Changed("range") && f.from != "" {
		return nil, exitcode.New(exitcode.Usage, "pass either --range or --from, not both")
	}
	i := slices.IndexFunc(metricsRanges, func(r metricsRange) bool { return r.label == f.rng })
	if i < 0 {
		return nil, exitcode.New(exitcode.Usage, "unknown --range %q; use one of %s, or --from and --to", f.rng, strings.Join(rangeLabels(), ", "))
	}
	end := now
	if f.to != "" {
		t, ok := parseMoment(f.to, now)
		if !ok {
			return nil, exitcode.New(exitcode.Usage, "invalid --to %q: use a duration ago like 30m or 2d, or a time like 2026-10-21T09:00:00Z", f.to)
		}
		end = t
	}
	start := end.Add(-metricsRanges[i].span)
	if f.from != "" {
		t, ok := parseMoment(f.from, now)
		if !ok {
			return nil, exitcode.New(exitcode.Usage, "invalid --from %q: use a duration ago like 90m or 2d, or a time like 2026-10-21T09:00:00Z", f.from)
		}
		start = t
	}
	if !start.Before(end) {
		return nil, exitcode.New(exitcode.Usage, "--from must be before --to")
	}
	if end.Sub(start) > maxMetricsRange {
		return nil, exitcode.New(exitcode.Usage, "the range may span at most 90 days")
	}
	picked, err := pickMetrics(f.metrics, names, aliases)
	if err != nil {
		return nil, err
	}
	w := &metricsWindow{query: api.MetricsQuery{From: start.UnixMilli(), Metrics: picked}, span: end.Sub(start)}
	switch {
	case f.from == "" && f.to == "":
		w.label = "last " + f.rng
	case f.to == "":
		w.label = "since " + formatInstant(start)
	default:
		w.query.To = end.UnixMilli()
		w.label = formatInstant(start) + " to " + formatInstant(end)
	}
	return w, nil
}

// pickMetrics expands aliases, drops duplicates and rejects unknown names.
func pickMetrics(in, names []string, aliases map[string][]string) ([]string, error) {
	var out []string
	for _, m := range in {
		m = strings.ToLower(strings.TrimSpace(m))
		if m == "" {
			continue
		}
		expanded := []string{m}
		if a, ok := aliases[m]; ok && !slices.Contains(names, m) {
			expanded = a
		}
		for _, e := range expanded {
			if !slices.Contains(names, e) {
				return nil, exitcode.New(exitcode.Usage, "unknown metric %q; use %s", m, strings.Join(names, ", "))
			}
			if !slices.Contains(out, e) {
				out = append(out, e)
			}
		}
	}
	return out, nil
}

func formatInstant(t time.Time) string {
	return t.UTC().Format("2006-01-02 15:04 UTC")
}

// -----------------------------------------------------------------------------
// metrics
// -----------------------------------------------------------------------------

func (a *App) metricsCmd() *cobra.Command {
	var f targetFlags
	var mf metricsFlags
	var replicas bool
	cmd := &cobra.Command{
		Use:   "metrics",
		Short: "Show a service's CPU, memory, network and disk usage",
		Long: `Show the linked service's resource usage over a range: the latest value,
the average and the peak of each metric, against the service's limits where
it has them. CPU is in millicores (1000m is one core); network and disk are
rates.

--range picks a range ending now; --from and --to give one of your own, as
a duration ago (90m, 2d) or a time. --replicas shows each replica on its own
row instead of the service total. On a terminal each row ends with a
sparkline of the range.

"metrics summary" shows every service of the project at a glance; "servers
metrics" shows a server's usage.`,
		Example: `  roundhouse metrics
  roundhouse metrics --range 24h --metric cpu --metric memory
  roundhouse metrics --service api --environment staging --replicas
  roundhouse metrics --from 2026-10-21T09:00:00Z --to 2026-10-21T12:00:00Z
  roundhouse metrics --json | jq '.series[] | select(.metric == "cpu")'`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			w, err := mf.window(cmd, a.Now(), api.ServiceMetricNames, serviceMetricAliases)
			if err != nil {
				return err
			}
			return a.runServiceMetrics(cmd.Context(), f, w, replicas)
		},
	}
	f.register(cmd, true)
	mf.register(cmd, api.ServiceMetricNames, true)
	cmd.Flags().BoolVar(&replicas, "replicas", false, "one row per replica instead of the service total")
	cmd.AddCommand(a.metricsSummaryCmd())
	return cmd
}

func (a *App) runServiceMetrics(ctx context.Context, f targetFlags, w *metricsWindow, replicas bool) error {
	t, err := a.resolve(ctx, f, serviceRequired)
	if err != nil {
		return err
	}
	m, err := t.sess.client.ServiceMetrics(ctx, t.service.ID, t.env.ID, w.query, replicas)
	if err != nil {
		return err
	}
	if a.jsonOut {
		return a.printJSON(m)
	}
	view := seriesView{
		order:    api.ServiceMetricNames,
		format:   formatServiceMetric,
		replicas: replicas,
	}
	if m.Limits != nil {
		limits := *m.Limits
		view.limit = func(metric string) float64 { return serviceLimit(metric, limits) }
	}
	fmt.Fprintf(a.IO.Out, "%s in %s, %s (%s steps)\n", t.service.Name, t.env.Name, w.label, formatStep(m.StepS))
	if !a.printSeries(view, m.Series) {
		fmt.Fprintf(a.IO.Out, "No samples in this range. Metrics are recorded while a deployment of %s is running.\n", t.service.Name)
	} else if n := restartsIn(m.Series); n > 0 {
		fmt.Fprintf(a.IO.Out, "\n%s in this range\n", a.IO.OutColor().Yellow(plural(n, "restart", "restarts")))
	}
	a.metricsNotes(m.ShortRetention, m.Approximate, w.span)
	return nil
}

// restartsIn totals the restarts series, across replicas.
func restartsIn(series []api.MetricSeries) int {
	total := 0.0
	for _, s := range series {
		if s.Metric == "restarts" {
			total += statsOf(s.Points).sum
		}
	}
	return int(math.Round(total))
}

// metricsNotes explains what limits a response's accuracy, on stderr.
func (a *App) metricsNotes(shortRet, approximate bool, span time.Duration) {
	c := a.IO.ErrColor()
	if shortRet {
		msg := "this control plane keeps metrics for 48 hours only (D1 fallback; configure Analytics Engine for 90 days)"
		if span > shortRetention {
			msg += "; samples older than that are missing"
		}
		fmt.Fprintf(a.IO.Err, "%s %s\n", c.Dim("note:"), msg)
	}
	if approximate {
		fmt.Fprintf(a.IO.Err, "%s %s\n", c.Dim("note:"), "some samples are approximate: they came from Docker stats on a cgroup v1 host")
	}
}

// -----------------------------------------------------------------------------
// metrics summary
// -----------------------------------------------------------------------------

func (a *App) metricsSummaryCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:     "summary",
		Aliases: []string{"project"},
		Short:   "Show every service's current CPU and memory",
		Long: `Show each service of the linked project in one environment: CPU and
memory averaged over the last five minutes, against their limits. On a
terminal, sparklines show the last hour.`,
		Example: `  roundhouse metrics summary
  roundhouse metrics summary --project shop --environment staging --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolve(ctx, f, serviceOptional)
			if err != nil {
				return err
			}
			s, err := t.sess.client.MetricsSummary(ctx, t.project.ID, t.env.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(s)
			}
			a.printMetricsSummary(t, s)
			a.metricsNotes(s.ShortRetention, false, 0)
			return nil
		},
	}
	f.register(cmd, false)
	return cmd
}

func (a *App) printMetricsSummary(t *target, s *api.MetricsSummary) {
	fmt.Fprintf(a.IO.Out, "%s in %s, last 5 minutes\n", t.project.Name, t.env.Name)
	if len(s.Services) == 0 {
		fmt.Fprintf(a.IO.Out, "No services in %s. Create one with `roundhouse services create`.\n", t.project.Name)
		return
	}
	rank := func(id string) int {
		if i := slices.IndexFunc(t.project.Services, func(x api.Service) bool { return x.ID == id }); i >= 0 {
			return i
		}
		return len(t.project.Services)
	}
	services := slices.Clone(s.Services)
	slices.SortStableFunc(services, func(x, y api.ServiceMetricsSummary) int {
		return cmp.Or(cmp.Compare(rank(x.ServiceID), rank(y.ServiceID)), strings.Compare(x.ServiceID, y.ServiceID))
	})
	spark := a.IO.StdoutTTY()
	headers := []string{"service", "cpu", "memory"}
	if spark {
		headers = append(headers, "cpu 1h", "memory 1h")
	}
	fmt.Fprintln(a.IO.Out)
	tb := a.newTable(headers...)
	for _, svc := range services {
		name := svc.ServiceID
		if x := findService(t.project.Services, svc.ServiceID); x != nil {
			name = x.Name
		}
		row := []string{name, ofLimit(svc.CPUMillis, svc.CPULimitMillis, formatCPU), ofLimit(svc.MemBytes, svc.MemLimitBytes, formatBytes)}
		if spark {
			row = append(row, a.sparkline(svc.CPU), a.sparkline(svc.Memory))
		}
		tb.row(row...)
	}
	tb.flush()
	if !slices.ContainsFunc(services, func(s api.ServiceMetricsSummary) bool { return s.CPUMillis != nil || s.MemBytes != nil }) {
		fmt.Fprintln(a.IO.Out, "\nNo samples in the last 5 minutes. Metrics are recorded while deployments are running.")
	}
}

// ofLimit renders a value against its limit, e.g. "120m of 500m (24%)".
func ofLimit(v, limit *float64, format func(float64) string) string {
	if v == nil {
		return "-"
	}
	if limit == nil || *limit <= 0 {
		return format(*v)
	}
	return format(*v) + " of " + format(*limit) + " " + percentOf(*v, *limit)
}

// -----------------------------------------------------------------------------
// servers metrics
// -----------------------------------------------------------------------------

func (a *App) serversMetricsCmd() *cobra.Command {
	var workspace string
	var mf metricsFlags
	cmd := &cobra.Command{
		Use:   "metrics SERVER",
		Short: "Show a server's CPU, memory, disk and load",
		Long: `Show a server's usage over a range, by name or ID: the latest value, the
average and the peak of CPU, memory used, disk used and the one-minute load
average. On a terminal each row ends with a sparkline of the range.`,
		Example: `  roundhouse servers metrics web-1
  roundhouse servers metrics web-1 --range 7d --metric cpu_percent
  roundhouse servers metrics node_01J9Z6Y4M0V8 --json`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			w, err := mf.window(cmd, a.Now(), api.NodeMetricNames, nil)
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			sess, err := a.connect()
			if err != nil {
				return err
			}
			ws, err := a.findWorkspace(ctx, sess.client, workspace)
			if err != nil {
				return err
			}
			nodes, err := sess.client.ListNodes(ctx, ws.ID)
			if err != nil {
				return err
			}
			n := findNode(nodes, args[0])
			if n == nil {
				return exitcode.New(exitcode.NotFound, "no server %q in %s; list them with `roundhouse servers list`", args[0], ws.Name)
			}
			m, err := sess.client.NodeMetrics(ctx, ws.ID, n.ID, w.query)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(m)
			}
			fmt.Fprintf(a.IO.Out, "%s, %s (%s steps)\n", n.Name, w.label, formatStep(m.StepS))
			if !a.printSeries(seriesView{order: api.NodeMetricNames, format: formatNodeMetric}, m.Series) {
				fmt.Fprintln(a.IO.Out, "No samples in this range. Servers report usage while their agent is connected.")
			}
			a.metricsNotes(m.ShortRetention, false, w.span)
			return nil
		},
	}
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "workspace ID, slug or name")
	mf.register(cmd, api.NodeMetricNames, false)
	return cmd
}

// -----------------------------------------------------------------------------
// Series tables
// -----------------------------------------------------------------------------

// seriesView says how to tabulate a metrics response.
type seriesView struct {
	// order ranks metrics; others follow by name.
	order  []string
	format func(metric string, v float64) string
	// limit returns a metric's limit, or 0 for none; nil hides the column.
	limit    func(metric string) float64
	replicas bool
}

// pointStats summarises the non-null points of a series.
type pointStats struct {
	n                     int
	latest, avg, max, sum float64
}

func statsOf(points []api.MetricPoint) pointStats {
	var s pointStats
	for _, p := range points {
		if p.V == nil {
			continue
		}
		v := *p.V
		if s.n == 0 || v > s.max {
			s.max = v
		}
		s.n++
		s.sum += v
		s.latest = v
	}
	if s.n > 0 {
		s.avg = s.sum / float64(s.n)
	}
	return s
}

// printSeries writes one row per series and reports whether any had
// samples; without samples it writes nothing.
func (a *App) printSeries(v seriesView, series []api.MetricSeries) bool {
	if !slices.ContainsFunc(series, func(s api.MetricSeries) bool { return statsOf(s.Points).n > 0 }) {
		return false
	}
	rank := func(m string) int {
		if i := slices.Index(v.order, m); i >= 0 {
			return i
		}
		return len(v.order)
	}
	sorted := slices.Clone(series)
	slices.SortStableFunc(sorted, func(x, y api.MetricSeries) int {
		return cmp.Or(cmp.Compare(rank(x.Metric), rank(y.Metric)), strings.Compare(x.Metric, y.Metric), strings.Compare(x.WorkloadID, y.WorkloadID))
	})
	spark := a.IO.StdoutTTY()
	headers := []string{"metric"}
	if v.replicas {
		headers = append(headers, "replica")
	}
	headers = append(headers, "latest", "avg", "max")
	if v.limit != nil {
		headers = append(headers, "limit")
	}
	if spark {
		headers = append(headers, "trend")
	}
	fmt.Fprintln(a.IO.Out)
	tb := a.newTable(headers...)
	for _, s := range sorted {
		st := statsOf(s.Points)
		limit := 0.0
		if v.limit != nil {
			limit = v.limit(s.Metric)
		}
		cell := func(x float64) string {
			if st.n == 0 {
				return "-"
			}
			out := v.format(s.Metric, x)
			if limit > 0 {
				out += " " + percentOf(x, limit)
			}
			return out
		}
		row := []string{s.Metric}
		if v.replicas {
			row = append(row, orDash(s.WorkloadID))
		}
		row = append(row, cell(st.latest), cell(st.avg), cell(st.max))
		if v.limit != nil {
			l := "-"
			if limit > 0 {
				l = v.format(s.Metric, limit)
			}
			row = append(row, l)
		}
		if spark {
			row = append(row, a.sparkline(s.Points))
		}
		tb.row(row...)
	}
	tb.flush()
	return true
}

// serviceLimit is the configured limit a metric is measured against.
func serviceLimit(metric string, l api.MetricLimits) float64 {
	switch metric {
	case "cpu":
		return l.CPUMillis
	case "memory", "memory_max":
		return l.MemoryBytes
	}
	return 0
}

func formatServiceMetric(metric string, v float64) string {
	switch metric {
	case "cpu":
		return formatCPU(v)
	case "memory", "memory_max":
		return formatBytes(v)
	case "net_rx", "net_tx", "disk_read", "disk_write":
		return formatBytes(v) + "/s"
	}
	return formatCount(v)
}

func formatNodeMetric(metric string, v float64) string {
	switch metric {
	case "cpu_percent":
		return strconv.FormatFloat(v, 'f', 1, 64) + "%"
	case "memory", "disk":
		return formatBytes(v)
	case "load1":
		return strconv.FormatFloat(v, 'f', 2, 64)
	}
	return formatCount(v)
}

// formatCPU renders millicores: "250m", or cores from one core up.
func formatCPU(m float64) string {
	switch {
	case m >= 1000:
		return strconv.FormatFloat(m/1000, 'f', 2, 64) + " cores"
	case m > 0 && m < 10:
		return strconv.FormatFloat(m, 'f', 1, 64) + "m"
	}
	return strconv.FormatFloat(m, 'f', 0, 64) + "m"
}

// formatBytes renders a byte count with binary units, e.g. "180.5 MiB".
func formatBytes(b float64) string {
	if math.Abs(b) < 1024 {
		return strconv.FormatFloat(b, 'f', 0, 64) + " B"
	}
	units := []string{"KiB", "MiB", "GiB", "TiB", "PiB"}
	i := -1
	for math.Abs(b) >= 1024 && i < len(units)-1 {
		b /= 1024
		i++
	}
	return strconv.FormatFloat(b, 'f', 1, 64) + " " + units[i]
}

func formatCount(v float64) string {
	if v == math.Trunc(v) {
		return strconv.FormatFloat(v, 'f', 0, 64)
	}
	return strconv.FormatFloat(v, 'f', 1, 64)
}

func percentOf(v, limit float64) string {
	return "(" + strconv.FormatFloat(v/limit*100, 'f', 0, 64) + "%)"
}

// formatStep renders a step in seconds as "15s", "5m" or "6h".
func formatStep(s int64) string {
	switch {
	case s >= 3600 && s%3600 == 0:
		return strconv.FormatInt(s/3600, 10) + "h"
	case s >= 60 && s%60 == 0:
		return strconv.FormatInt(s/60, 10) + "m"
	}
	return strconv.FormatInt(s, 10) + "s"
}

// -----------------------------------------------------------------------------
// Sparklines
// -----------------------------------------------------------------------------

var sparkBars = []rune("▁▂▃▄▅▆▇█")

// sparkline draws points in at most sparkWidth bars, coloured when stdout
// takes colour.
func (a *App) sparkline(points []api.MetricPoint) string {
	s := sparkline(points, sparkWidth)
	if s == "" {
		return ""
	}
	return a.IO.OutColor().Cyan(s)
}

// sparkline draws points as bars scaled from zero to the highest value, so
// a flat line near zero stays low instead of filling the range. With more
// points than width, each bar is the peak of its bucket so short spikes
// stay visible; a bucket without samples is a space.
func sparkline(points []api.MetricPoint, width int) string {
	if len(points) == 0 || width <= 0 {
		return ""
	}
	buckets := min(width, len(points))
	vals := make([]*float64, buckets)
	for i, p := range points {
		if p.V == nil {
			continue
		}
		b := i * buckets / len(points)
		if vals[b] == nil || *p.V > *vals[b] {
			v := *p.V
			vals[b] = &v
		}
	}
	hi := 0.0
	for _, v := range vals {
		if v != nil && *v > hi {
			hi = *v
		}
	}
	var sb strings.Builder
	for _, v := range vals {
		switch {
		case v == nil:
			sb.WriteRune(' ')
		case hi <= 0 || *v <= 0:
			sb.WriteRune(sparkBars[0])
		default:
			sb.WriteRune(sparkBars[int(math.Round(*v/hi*float64(len(sparkBars)-1)))])
		}
	}
	return strings.TrimRight(sb.String(), " ")
}
