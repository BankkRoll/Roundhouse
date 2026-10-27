package cli

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
	"github.com/BankkRoll/Roundhouse/cli/internal/ui"
)

// maxLogPage is the API's largest log page.
const maxLogPage = 1000

// maxReconnectDelay caps the backoff between realtime reconnects.
const maxReconnectDelay = 30 * time.Second

func (a *App) logsCmd() *cobra.Command {
	var f targetFlags
	var o logsOptions
	var since string
	cmd := &cobra.Command{
		Use:   "logs",
		Short: "Show and follow deployment or build logs",
		Long: `Print the logs of the linked service's latest deployment, or of the
deployment given with --deployment. --build shows the deployment's build
logs instead. History is paged from the log endpoints; -f then follows new
lines live over the project's realtime socket, reconnecting if it drops.

stderr lines are red and system lines cyan on a colour terminal. With
--json each line is printed as one JSON object (NDJSON).`,
		Example: `  roundhouse logs
  roundhouse logs -f
  roundhouse logs --build --deployment dep_01J9Z6Y4M0V8 -f
  roundhouse logs --since 30m
  roundhouse logs --since 2026-10-21T09:00:00Z -n 5000 --json | jq -r .text`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if since != "" {
				t, err := parseSince(since, a.Now())
				if err != nil {
					return exitcode.Wrap(exitcode.Usage, err)
				}
				o.since = t
			}
			if o.lines < 0 {
				return exitcode.New(exitcode.Usage, "--lines must not be negative")
			}
			return a.runLogs(cmd.Context(), f, o)
		},
	}
	f.register(cmd, true)
	cmd.Flags().BoolVarP(&o.follow, "follow", "f", false, "follow new lines live")
	cmd.Flags().StringVarP(&o.deploymentID, "deployment", "d", "", "deployment ID (default: latest deployment of the service)")
	cmd.Flags().BoolVar(&o.build, "build", false, "show the deployment's build logs")
	cmd.Flags().StringVar(&since, "since", "", "only lines newer than a duration (10m, 2h, 1d) or time (RFC 3339)")
	cmd.Flags().IntVarP(&o.lines, "lines", "n", 100, "history lines to print when --since is not given (0: none)")
	return cmd
}

type logsOptions struct {
	follow       bool
	deploymentID string
	build        bool
	since        time.Time
	lines        int
}

// logTarget is a resolved log source.
type logTarget struct {
	client     *api.Client
	projectID  string
	deployment *api.DeploymentDetail
	source     api.LogSource
}

func (a *App) runLogs(ctx context.Context, f targetFlags, o logsOptions) error {
	lt, err := a.logTarget(ctx, f, o)
	if err != nil {
		return err
	}
	p := &logPrinter{a: a, pal: a.IO.OutColor(), seen: newDedupe(8192), replicas: len(lt.deployment.Placements) > 1}
	if !o.follow {
		lines, err := a.logHistory(ctx, lt, o)
		if err != nil {
			return err
		}
		p.print(lines, false)
		return nil
	}
	if ended := sourceEnded(lt); ended != "" {
		lines, err := a.logHistory(ctx, lt, o)
		if err != nil {
			return err
		}
		p.print(lines, false)
		a.IO.Info("%s; not following.", ended)
		return nil
	}
	err = a.followLogs(ctx, lt, o, p)
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func (a *App) logTarget(ctx context.Context, f targetFlags, o logsOptions) (*logTarget, error) {
	lt := &logTarget{}
	id := o.deploymentID
	if id == "" {
		t, err := a.resolve(ctx, f, serviceRequired)
		if err != nil {
			return nil, err
		}
		latest, err := latestDeployment(ctx, t)
		if err != nil {
			return nil, err
		}
		if latest == nil {
			return nil, exitcode.New(exitcode.NotFound, "%s has no deployments in %s yet; run `roundhouse deploy`", t.service.Name, t.env.Name)
		}
		lt.client, lt.projectID, id = t.sess.client, t.project.ID, latest.ID
	} else {
		sess, err := a.connect()
		if err != nil {
			return nil, err
		}
		lt.client = sess.client
	}
	d, err := lt.client.GetDeployment(ctx, id)
	if err != nil {
		return nil, err
	}
	lt.deployment = d
	if o.build {
		if d.BuildID == nil {
			return nil, exitcode.New(exitcode.NotFound, "deployment %s has no build (its source is an image)", d.ID)
		}
		lt.source = api.LogSource{BuildID: *d.BuildID}
	} else {
		lt.source = api.LogSource{DeploymentID: d.ID}
	}
	if lt.projectID == "" {
		lt.projectID = d.ProjectID
	}
	// NOTE: a control plane older than Deployment.project_id leaves it empty.
	if lt.projectID == "" && o.follow {
		svc, err := lt.client.GetService(ctx, d.ServiceID)
		if err != nil {
			return nil, err
		}
		lt.projectID = svc.ProjectID
	}
	return lt, nil
}

// logHistory pages backwards from the newest line until it has enough:
// `lines` lines, or everything since `since`. Lines come back oldest first.
func (a *App) logHistory(ctx context.Context, lt *logTarget, o logsOptions) ([]api.LogEntry, error) {
	if o.since.IsZero() && o.lines == 0 {
		return nil, nil
	}
	sinceMs := o.since.UnixMilli()
	limit := maxLogPage
	if o.since.IsZero() {
		limit = min(o.lines, maxLogPage)
	}
	var pages [][]api.LogEntry
	total, cursor := 0, ""
	for {
		page, err := lt.client.Logs(ctx, lt.source, cursor, limit)
		if err != nil {
			return nil, err
		}
		pages = append(pages, page.Lines)
		total += len(page.Lines)
		if page.NextCursor == nil || len(page.Lines) == 0 {
			break
		}
		if o.since.IsZero() && total >= o.lines {
			break
		}
		if !o.since.IsZero() && page.Lines[0].TS < sinceMs {
			break
		}
		cursor = *page.NextCursor
	}
	lines := make([]api.LogEntry, 0, total)
	for i := len(pages) - 1; i >= 0; i-- {
		lines = append(lines, pages[i]...)
	}
	if !o.since.IsZero() {
		start := 0
		for start < len(lines) && lines[start].TS < sinceMs {
			start++
		}
		return lines[start:], nil
	}
	if len(lines) > o.lines {
		lines = lines[len(lines)-o.lines:]
	}
	return lines, nil
}

// followLogs subscribes to live lines, prints history, then streams until
// the source ends or ctx is cancelled. It subscribes before reading history
// so no line falls between the two; duplicates are dropped.
func (a *App) followLogs(ctx context.Context, lt *logTarget, o logsOptions, p *logPrinter) error {
	topic := api.RealtimeTopic{DeploymentID: lt.source.DeploymentID, BuildID: lt.source.BuildID}
	delay := time.Second
	first := true
	for {
		rt, err := lt.client.DialRealtime(ctx, lt.projectID)
		if err == nil {
			err = rt.Subscribe(ctx, topic)
			if err != nil {
				rt.Close()
			}
		}
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if !retryableRealtime(err) {
				return err
			}
			a.IO.Warn("realtime connection failed: %v; retrying in %s", err, delay)
			if !sleepCtx(ctx, delay) {
				return ctx.Err()
			}
			delay = min(delay*2, maxReconnectDelay)
			continue
		}
		connected := time.Now()

		hist := o
		if !first {
			// Fill the gap while disconnected from the newest page.
			hist = logsOptions{lines: maxLogPage}
		}
		lines, err := a.logHistory(ctx, lt, hist)
		if err != nil {
			rt.Close()
			return err
		}
		// The first history page is printed whole; a gap fill after a
		// reconnect overlaps what was already printed.
		p.print(lines, !first)
		first = false

		done, err := a.streamLogs(ctx, rt, lt, p)
		rt.Close()
		if done || ctx.Err() != nil {
			return ctx.Err()
		}
		if !retryableRealtime(err) {
			return err
		}
		// A socket that stayed up a while starts the backoff over; one closed
		// right after opening keeps backing off, so a server that accepts and
		// drops every socket is not hammered.
		if time.Since(connected) > maxReconnectDelay {
			delay = time.Second
		}
		a.IO.Warn("realtime connection lost (%v); reconnecting in %s", err, delay)
		if !sleepCtx(ctx, delay) {
			return ctx.Err()
		}
		delay = min(delay*2, maxReconnectDelay)
	}
}

// retryableRealtime reports whether reconnecting could help after err: not
// for a close code that means the socket will keep being refused (lost
// session or access, unknown project, protocol error), nor for an upgrade an
// older control plane refused with a 4xx other than 429.
func retryableRealtime(err error) bool {
	var closed *api.RealtimeClosedError
	if errors.As(err, &closed) {
		return closed.Retryable()
	}
	var apiErr *api.Error
	if errors.As(err, &apiErr) {
		return apiErr.Status >= 500 || apiErr.Status == http.StatusTooManyRequests
	}
	return true
}

// streamLogs prints live lines until the source ends (done) or the socket
// fails (err).
func (a *App) streamLogs(ctx context.Context, rt *api.Realtime, lt *logTarget, p *logPrinter) (done bool, err error) {
	for {
		msg, err := rt.Read(ctx)
		if err != nil {
			return false, err
		}
		switch msg.Type {
		case "log.lines":
			if msg.Source == nil || !matchesSource(msg.Source, lt.source) {
				continue
			}
			for i := range msg.Lines {
				msg.Lines[i].WorkloadID = msg.Source.WorkloadID
			}
			p.print(msg.Lines, true)
		case "deployment.updated":
			d := msg.Deployment
			if d == nil || d.ID != lt.deployment.ID {
				continue
			}
			if lt.source.BuildID != "" && d.Build != nil && api.IsBuildFinished(d.Build.Status) {
				a.IO.Info("Build %s.", d.Build.Status)
				return true, nil
			}
			if stopsLogs(d.Status) {
				a.IO.Info("Deployment %s is now %s; no more logs will arrive.", d.ID, d.Status)
				return true, nil
			}
		}
	}
}

// sourceEnded describes why a log source will produce no more lines, or
// returns "" while it may.
func sourceEnded(lt *logTarget) string {
	d := lt.deployment
	if lt.source.BuildID != "" {
		if d.Build != nil && api.IsBuildFinished(d.Build.Status) {
			return "The build finished (" + d.Build.Status + ")"
		}
		return ""
	}
	if stopsLogs(d.Status) {
		return "Deployment " + d.ID + " is " + d.Status
	}
	return ""
}

// stopsLogs reports whether a deployment in this status will write no more
// lines: it ended, or was superseded. A crashed deployment may recover.
func stopsLogs(status string) bool {
	switch status {
	case api.StatusFailed, api.StatusCancelled, api.StatusRemoved, api.StatusRolledBack:
		return true
	}
	return false
}

func matchesSource(s *api.RealtimeLogSource, want api.LogSource) bool {
	if want.BuildID != "" {
		return s.Type == "build" && s.BuildID == want.BuildID
	}
	return s.Type == "runtime" && s.DeploymentID == want.DeploymentID
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// parseSince accepts a duration (with a `d` suffix for days), an RFC 3339
// time, or a date.
func parseSince(s string, now time.Time) (time.Time, error) {
	if t, ok := parseMoment(s, now); ok {
		return t, nil
	}
	return time.Time{}, fmt.Errorf("invalid --since %q: use a duration like 10m or 2h, or a time like 2026-10-21T09:00:00Z", s)
}

// parseMoment reads a time given as a duration ago (with a `d` suffix for
// days), an RFC 3339 time, or a local date and time.
func parseMoment(s string, now time.Time) (time.Time, bool) {
	if days, ok := strings.CutSuffix(s, "d"); ok {
		if n, err := strconv.Atoi(days); err == nil && n >= 0 {
			return now.Add(-time.Duration(n) * 24 * time.Hour), true
		}
	}
	if d, err := time.ParseDuration(s); err == nil {
		if d < 0 {
			d = -d
		}
		return now.Add(-d), true
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02"} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// -----------------------------------------------------------------------------
// Printing
// -----------------------------------------------------------------------------

// logPrinter writes log lines. Where history and live lines overlap it
// drops lines already printed, identified by timestamp, stream, replica and
// [dedupe].
type logPrinter struct {
	a        *App
	pal      ui.Palette
	seen     *dedupe
	replicas bool
}

// print writes lines and remembers each; with skipSeen it drops lines
// remembered earlier.
func (p *logPrinter) print(lines []api.LogEntry, skipSeen bool) {
	for _, l := range lines {
		if !p.seen.add(logKey(l)) && skipSeen {
			continue
		}
		if p.a.jsonOut {
			writeJSONLine(p.a.IO.Out, l)
			continue
		}
		var b strings.Builder
		b.WriteString(p.pal.Dim(millis(l.TS).Local().Format("Jan 02 15:04:05")))
		b.WriteByte(' ')
		if p.replicas && l.WorkloadID != "" {
			tag := l.WorkloadID
			if len(tag) > 6 {
				tag = tag[len(tag)-6:]
			}
			b.WriteString(p.pal.Magenta("[" + tag + "]"))
			b.WriteByte(' ')
		}
		switch l.Stream {
		case "stderr":
			b.WriteString(p.pal.Red(l.Text))
		case "system":
			b.WriteString(p.pal.Cyan(l.Text))
		default:
			b.WriteString(l.Text)
		}
		fmt.Fprintln(p.a.IO.Out, b.String())
	}
}

// dedupe remembers the last n keys it saw.
type dedupe struct {
	set  map[string]struct{}
	ring []string
	next int
}

func newDedupe(n int) *dedupe {
	return &dedupe{set: make(map[string]struct{}, n), ring: make([]string, n)}
}

// add records key and reports whether it was new.
func (d *dedupe) add(key string) bool {
	if _, ok := d.set[key]; ok {
		return false
	}
	if old := d.ring[d.next]; old != "" {
		delete(d.set, old)
	}
	d.ring[d.next] = key
	d.set[key] = struct{}{}
	d.next = (d.next + 1) % len(d.ring)
	return true
}

// logKey identifies a line by timestamp, stream, replica and text, for
// [dedupe].
func logKey(l api.LogEntry) string {
	return fmt.Sprintf("%d\x00%s\x00%s\x00%s", l.TS, l.Stream, l.WorkloadID, l.Text)
}

// has reports whether key is remembered.
func (d *dedupe) has(key string) bool {
	_, ok := d.set[key]
	return ok
}
