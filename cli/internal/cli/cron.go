package cli

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

func (a *App) cronCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "cron",
		Short: "Inspect, run, pause and preview cron services",
		Long: `Work with cron services: services that run their deployed image on a
schedule, to completion, instead of staying up.

Commands act on --service, else the linked service when it is a cron
service, else the project's only cron service, and ask when there are
several. Deploying a cron service arms it; runs use the armed deployment,
and "cron set" changes take effect on the next deploy.`,
		Example: `  roundhouse cron status
  roundhouse cron runs --status failed
  roundhouse cron set --schedule "0 3 * * *" --timezone Europe/Berlin --retries 2
  roundhouse cron run --wait
  roundhouse cron logs crn_01J9Z6Y4M0V8 -f
  roundhouse cron preview "*/15 9-17 * * MON-FRI" --timezone Europe/Berlin`,
		Args: noArgs,
	}
	cmd.AddCommand(a.cronStatusCmd(), a.cronSetCmd(), a.cronRunsCmd(), a.cronRunCmd(), a.cronCancelCmd(), a.cronLogsCmd(),
		a.cronPauseCmd(true), a.cronPauseCmd(false), a.cronPreviewCmd())
	return cmd
}

// resolveCron loads the target and picks its cron service: --service, else
// the linked service when it is a cron service, else the only one, else
// asks.
func (a *App) resolveCron(ctx context.Context, f targetFlags) (*target, error) {
	t, err := a.resolve(ctx, f, serviceOptional)
	if err != nil {
		return nil, err
	}
	if f.service != "" {
		if t.service.Kind != api.ServiceKindCron {
			return nil, exitcode.New(exitcode.Conflict, "%s is not a cron service", t.service.Name)
		}
		return t, nil
	}
	if t.service != nil && t.service.Kind == api.ServiceKindCron {
		return t, nil
	}
	var crons []api.Service
	for _, s := range t.project.Services {
		if s.Kind == api.ServiceKindCron {
			crons = append(crons, s)
		}
	}
	switch len(crons) {
	case 0:
		return nil, exitcode.New(exitcode.NotFound, "project %s has no cron services; create one with `roundhouse services create --kind cron`", t.project.Name)
	case 1:
		t.service = &crons[0]
		return t, nil
	}
	names := make([]string, len(crons))
	for i, s := range crons {
		names[i] = fmt.Sprintf("%s (%s)", s.Name, s.Slug)
	}
	i, err := a.IO.Select("Which cron service?", names, "pass --service")
	if err != nil {
		return nil, err
	}
	t.service = &crons[i]
	return t, nil
}

// zoneTime formats a slot in the schedule's zone, falling back to UTC when
// this machine has no data for it.
func zoneTime(ms int64, zone string) string {
	if zone != "" && zone != "UTC" {
		if loc, err := time.LoadLocation(zone); err == nil {
			return millis(ms).In(loc).Format("2006-01-02 15:04 MST")
		}
	}
	return formatInstant(millis(ms))
}

// -----------------------------------------------------------------------------
// cron status
// -----------------------------------------------------------------------------

func (a *App) cronStatusCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show a cron service's schedule, state and next runs",
		Example: `  roundhouse cron status
  roundhouse cron status --service nightly --environment staging --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolveCron(ctx, f)
			if err != nil {
				return err
			}
			st, err := t.sess.client.CronState(ctx, t.service.ID, t.env.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(st)
			}
			cfg, err := t.sess.client.ServiceConfig(ctx, t.service.ID, t.env.ID)
			if err != nil {
				return err
			}
			a.printCronState(t, st, cfg.Cron)
			return nil
		},
	}
	f.register(cmd, true)
	return cmd
}

// printCronState prints the armed schedule and its next slots, then the
// rules of the saved config (nil when the service has none), which a
// deploy arms.
func (a *App) printCronState(t *target, st *api.CronState, cron *api.CronConfig) {
	pal := a.IO.OutColor()
	fmt.Fprintf(a.IO.Out, "%s in %s\n", pal.Bold(t.service.Name), t.env.Name)
	row := func(k, v string) { fmt.Fprintf(a.IO.Out, "  %-10s %s\n", k, v) }
	if st.ArmedDeploymentID == nil {
		row("State", pal.Yellow("not deployed")+"; run `roundhouse deploy` to arm it")
		if cron != nil {
			row("Schedule", cron.Schedule+" ("+cron.Timezone+")")
			cronRuleRows(row, cron)
		}
		return
	}
	zone := deref(st.Timezone)
	if st.Schedule != nil {
		row("Schedule", *st.Schedule+" ("+orDash(zone)+")")
	}
	if cron != nil && (st.Schedule == nil || cron.Schedule != *st.Schedule || cron.Timezone != zone) {
		row("Saved", cron.Schedule+" ("+cron.Timezone+"); deploy to apply it")
	}
	if st.Paused {
		row("State", pal.Yellow("paused")+"; resume with `roundhouse cron resume`")
	} else {
		row("State", pal.Green("active"))
	}
	row("Deployment", *st.ArmedDeploymentID)
	if len(st.NextRuns) > 0 {
		runs := make([]string, len(st.NextRuns))
		for i, ms := range st.NextRuns {
			runs[i] = zoneTime(ms, zone)
		}
		row("Next runs", strings.Join(runs, ", "))
	} else if !st.Paused {
		row("Next runs", "none; the schedule never fires")
	}
	if st.LastScheduledFor != nil {
		row("Last slot", zoneTime(*st.LastScheduledFor, zone))
	}
	if cron != nil {
		cronRuleRows(row, cron)
	}
}

// cronRuleRows prints what a cron config does besides its schedule.
func cronRuleRows(row func(k, v string), c *api.CronConfig) {
	overlap := map[string]string{
		"forbid":  "forbid: a slot is skipped while a run is in progress",
		"replace": "replace: a slot cancels the run in progress",
		"allow":   "allow: runs may overlap",
	}
	if o, ok := overlap[c.Concurrency]; ok {
		row("Overlap", o)
	} else {
		row("Overlap", c.Concurrency)
	}
	row("Timeout", formatSeconds(c.TimeoutS))
	if c.Retries == 0 {
		row("Retries", "none")
	} else {
		row("Retries", fmt.Sprintf("%d, first after %s, doubling", c.Retries, formatSeconds(c.RetryBackoffS)))
	}
	row("Late start", "up to "+formatSeconds(c.StartingDeadlineS)+", else missed")
	row("History", fmt.Sprintf("%d runs kept", c.HistoryLimit))
}

// formatSeconds writes a config's seconds the way they are usually given:
// 3600 as 1h, 90 as 1m 30s.
func formatSeconds(n int) string {
	var parts []string
	if h := n / 3600; h > 0 {
		parts = append(parts, fmt.Sprintf("%dh", h))
	}
	if m := n % 3600 / 60; m > 0 {
		parts = append(parts, fmt.Sprintf("%dm", m))
	}
	if s := n % 60; s > 0 || len(parts) == 0 {
		parts = append(parts, fmt.Sprintf("%ds", s))
	}
	return strings.Join(parts, " ")
}

// -----------------------------------------------------------------------------
// cron set
// -----------------------------------------------------------------------------

// cronDurationFlags are the cron set flags that take seconds or a duration.
var cronDurationFlags = []struct {
	name, usage string
	lim         api.CronLimit
}{
	{"timeout", "stop a run after this long (10s to 24h)", api.CronTimeoutLimit},
	{"starting-deadline", "how late a run may still start before its slot counts as missed (0s to 1h)", api.CronStartingDeadlineLimit},
	{"retry-backoff", "wait before the first retry, doubled for each further one (10s to 1h)", api.CronRetryBackoffLimit},
}

func (a *App) cronSetCmd() *cobra.Command {
	var f targetFlags
	var schedule, timezone, concurrency string
	durations := map[string]*string{}
	var retries, historyLimit int
	cmd := &cobra.Command{
		Use:   "set",
		Short: "Change a cron service's schedule and run rules",
		Long: `Change the cron config of the service in the environment. Only the flags
given change; the rest keep their value. The change is saved as a new
config version and takes effect on the next deploy.

Durations take a number of seconds or a value such as 90s, 15m or 2h. An
invalid schedule or zone exits 7 and underlines the offending part, as
"cron preview" does.`,
		Example: `  roundhouse cron set --schedule "0 3 * * *" --timezone Europe/Berlin
  roundhouse cron set --concurrency replace --timeout 30m
  roundhouse cron set --retries 3 --retry-backoff 2m --environment staging --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			changed := cmd.Flags().Changed
			var p api.CronConfigPatch
			if changed("schedule") {
				p.Schedule = &schedule
			}
			if changed("timezone") {
				p.Timezone = &timezone
			}
			if changed("concurrency") {
				if !slices.Contains(api.CronConcurrencyPolicies, concurrency) {
					return exitcode.New(exitcode.Usage, "--concurrency must be one of %s", strings.Join(api.CronConcurrencyPolicies, ", "))
				}
				p.Concurrency = &concurrency
			}
			seconds := map[string]**int{"timeout": &p.TimeoutS, "starting-deadline": &p.StartingDeadlineS, "retry-backoff": &p.RetryBackoffS}
			for _, d := range cronDurationFlags {
				if !changed(d.name) {
					continue
				}
				n, err := parseSeconds(d.name, *durations[d.name], d.lim)
				if err != nil {
					return err
				}
				*seconds[d.name] = &n
			}
			for _, c := range []struct {
				name string
				v    int
				lim  api.CronLimit
				dst  **int
			}{
				{"retries", retries, api.CronRetriesLimit, &p.Retries},
				{"history-limit", historyLimit, api.CronHistoryLimit, &p.HistoryLimit},
			} {
				if !changed(c.name) {
					continue
				}
				if c.v < c.lim.Min || c.v > c.lim.Max {
					return exitcode.New(exitcode.Usage, "--%s must be between %d and %d", c.name, c.lim.Min, c.lim.Max)
				}
				*c.dst = &c.v
			}
			if p == (api.CronConfigPatch{}) {
				return exitcode.New(exitcode.Usage, "nothing to change: pass --schedule, --timezone, --concurrency, --timeout, "+
					"--starting-deadline, --retries, --retry-backoff or --history-limit")
			}

			ctx := cmd.Context()
			t, err := a.resolveCron(ctx, f)
			if err != nil {
				return err
			}
			updated, err := t.sess.client.UpdateService(ctx, t.service.ID, api.UpdateServiceInput{EnvironmentID: t.env.ID, Cron: &p})
			if err != nil {
				return a.cronConfigErr(err, p.Schedule, p.Timezone)
			}
			if a.jsonOut {
				return a.printJSON(updated)
			}
			check := a.IO.OutColor().Green("✓")
			if c := updated.Config; c != nil && c.Cron != nil {
				fmt.Fprintf(a.IO.Out, "%s Saved the cron config of %s in %s (version %d)\n", check, t.service.Name, t.env.Name, c.Version)
				row := func(k, v string) { fmt.Fprintf(a.IO.Out, "  %-10s %s\n", k, v) }
				row("Schedule", c.Cron.Schedule+" ("+c.Cron.Timezone+")")
				cronRuleRows(row, c.Cron)
			} else {
				fmt.Fprintf(a.IO.Out, "%s Saved the cron config of %s in %s\n", check, t.service.Name, t.env.Name)
			}
			fmt.Fprintf(a.IO.Out, "  Deploy to apply it: roundhouse deploy --service %s --environment %s\n", t.service.Slug, t.env.Slug)
			return nil
		},
	}
	f.register(cmd, true)
	fl := cmd.Flags()
	fl.StringVar(&schedule, "schedule", "", "five-field cron expression, or a macro such as @daily")
	fl.StringVar(&timezone, "timezone", "", "IANA time zone the schedule is read in (default UTC)")
	fl.StringVar(&concurrency, "concurrency", "", "when a slot comes while a run is in progress: forbid (skip the slot), replace or allow")
	for _, d := range cronDurationFlags {
		durations[d.name] = new(string)
		fl.StringVar(durations[d.name], d.name, "", d.usage)
	}
	fl.IntVar(&retries, "retries", 0, "retries of a failed run (0 to 5)")
	fl.IntVar(&historyLimit, "history-limit", 0, "finished runs kept (10 to 1000)")
	return cmd
}

// parseSeconds reads a flag given as whole seconds or as a Go duration and
// checks it against the API's bounds, so a mistake exits 2 before any
// request.
func parseSeconds(flag, value string, lim api.CronLimit) (int, error) {
	n, err := strconv.Atoi(value)
	if err != nil {
		d, derr := time.ParseDuration(value)
		if derr != nil {
			return 0, exitcode.New(exitcode.Usage, "--%s: %q is not a number of seconds or a duration such as 90s, 15m or 2h", flag, value)
		}
		if d%time.Second != 0 {
			return 0, exitcode.New(exitcode.Usage, "--%s must be whole seconds", flag)
		}
		n = int(d / time.Second)
	}
	if n < lim.Min || n > lim.Max {
		return 0, exitcode.New(exitcode.Usage, "--%s must be between %s and %s", flag, formatSeconds(lim.Min), formatSeconds(lim.Max))
	}
	return n, nil
}

// cronConfigErr shows a 422 invalid_schedule the way "cron preview" does
// when the offending schedule or zone is one the caller passed. Any other
// error, and every error under --json, is returned as the API sent it.
func (a *App) cronConfigErr(err error, schedule, timezone *string) error {
	se := api.ScheduleErrorOf(err)
	if se == nil || a.jsonOut {
		return err
	}
	switch {
	case se.Code == "invalid_timezone" && timezone != nil:
		return a.scheduleError(se, deref(schedule), *timezone)
	case se.Code == "invalid_schedule" && schedule != nil:
		return a.scheduleError(se, *schedule, deref(timezone))
	}
	return err
}

// -----------------------------------------------------------------------------
// cron runs
// -----------------------------------------------------------------------------

func (a *App) cronRunsCmd() *cobra.Command {
	var f targetFlags
	var o api.CronRunListOptions
	cmd := &cobra.Command{
		Use:     "runs",
		Aliases: []string{"history"},
		Short:   "List a cron service's runs, newest slot first",
		Example: `  roundhouse cron runs
  roundhouse cron runs --status failed --limit 50
  roundhouse cron runs --cursor crn_01J9Z6Y4M0V8 --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if o.Limit < 1 || o.Limit > api.CronRunPageLimit {
				return exitcode.New(exitcode.Usage, "--limit must be between 1 and %d", api.CronRunPageLimit)
			}
			if o.Status != "" && !slices.Contains(api.CronRunStatuses, o.Status) {
				return exitcode.New(exitcode.Usage, "--status must be one of %s", strings.Join(api.CronRunStatuses, ", "))
			}
			ctx := cmd.Context()
			t, err := a.resolveCron(ctx, f)
			if err != nil {
				return err
			}
			page, err := t.sess.client.ListCronRuns(ctx, t.service.ID, t.env.ID, o)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(page)
			}
			if len(page.Runs) == 0 {
				fmt.Fprintf(a.IO.Out, "No runs of %s in %s. Start one with `roundhouse cron run`.\n", t.service.Name, t.env.Name)
				return nil
			}
			pal := a.IO.OutColor()
			tb := a.newTable("id", "status", "trigger", "slot", "started", "duration", "exit", "node")
			var failed []api.CronRun
			for _, r := range page.Runs {
				status := r.Status
				if r.Status == api.CronMissed && r.MissedCount != nil && *r.MissedCount > 1 {
					status += fmt.Sprintf(" (%d)", *r.MissedCount)
				}
				started, exit := "-", "-"
				if r.StartedAt != nil {
					started = ago(a.Now(), *r.StartedAt)
				}
				if r.ExitCode != nil {
					exit = fmt.Sprint(*r.ExitCode)
				}
				tb.row(r.ID, status, r.Trigger, formatInstant(millis(r.ScheduledFor)), started, a.runDuration(&r), exit, orDash(deref(r.NodeID)))
				if r.Error != nil && r.Status != api.CronSucceeded {
					failed = append(failed, r)
				}
			}
			tb.flush()
			for _, r := range failed {
				fmt.Fprintf(a.IO.Out, "%s %s: %s\n", pal.Red(r.Status), r.ID, *r.Error)
			}
			if page.NextCursor != nil {
				fmt.Fprintf(a.IO.Err, "%s more runs: pass --cursor %s\n", a.IO.ErrColor().Dim("note:"), *page.NextCursor)
			}
			return nil
		},
	}
	f.register(cmd, true)
	cmd.Flags().StringVar(&o.Status, "status", "", "only runs in this status (queued, running, succeeded, failed, …)")
	cmd.Flags().IntVar(&o.Limit, "limit", 20, fmt.Sprintf("runs to list (up to %d)", api.CronRunPageLimit))
	cmd.Flags().StringVar(&o.Cursor, "cursor", "", "continue a listing from this cursor")
	return cmd
}

// runDuration is how long a run took, or has been running so far.
func (a *App) runDuration(r *api.CronRun) string {
	switch {
	case r.StartedAt == nil:
		return "-"
	case r.FinishedAt == nil:
		return formatDuration(a.Now().Sub(millis(*r.StartedAt))) + "…"
	}
	return formatDuration(time.Duration(*r.FinishedAt-*r.StartedAt) * time.Millisecond)
}

// -----------------------------------------------------------------------------
// cron run
// -----------------------------------------------------------------------------

func (a *App) cronRunCmd() *cobra.Command {
	var f targetFlags
	var force, wait bool
	var timeout time.Duration
	cmd := &cobra.Command{
		Use:     "run",
		Aliases: []string{"now", "trigger"},
		Short:   "Run a cron service now",
		Long: `Start a run of the cron service's armed deployment now, outside its
schedule. A run already in progress refuses it (exit 6) unless --force,
which cancels that run first.

With --wait, stream the run's output until it ends: exit 0 when it
succeeds, 1 otherwise. With --json, --wait prints only the finished run.`,
		Example: `  roundhouse cron run
  roundhouse cron run --service nightly --wait --timeout 30m
  roundhouse cron run --force`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolveCron(ctx, f)
			if err != nil {
				return err
			}
			c := t.sess.client
			run, err := c.TriggerCronRun(ctx, t.service.ID, api.TriggerCronRunInput{EnvironmentID: t.env.ID, Force: force})
			if err != nil {
				var apiErr *api.Error
				switch {
				case errors.As(err, &apiErr) && apiErr.Code == "run_in_progress":
					return withHint(err, "pass --force to cancel it and start a new run, or follow it: `roundhouse cron runs --status running`")
				case api.IsStatus(err, http.StatusConflict):
					return withHint(err, "deploy it first with `roundhouse deploy`")
				}
				return err
			}
			if !wait {
				if a.jsonOut {
					return a.printJSON(run)
				}
				fmt.Fprintf(a.IO.Out, "%s Started run %s of %s in %s\n", a.IO.OutColor().Green("✓"), run.ID, t.service.Name, t.env.Name)
				fmt.Fprintf(a.IO.Out, "  Follow it with `roundhouse cron logs %s -f`, or pass --wait next time.\n", run.ID)
				return nil
			}
			if !a.jsonOut {
				a.IO.Info("Started run %s of %s in %s", run.ID, t.service.Name, t.env.Name)
			}
			wctx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()
			run, err = a.watchRun(wctx, c, run, !a.jsonOut)
			if err != nil {
				return a.waitErr(err, timeout, run.ID)
			}
			if a.jsonOut {
				a.printJSON(run)
			}
			return a.runResult(run)
		},
	}
	f.register(cmd, true)
	cmd.Flags().BoolVar(&force, "force", false, "cancel a run in progress first")
	cmd.Flags().BoolVarP(&wait, "wait", "w", false, "stream the run's output until it ends")
	cmd.Flags().DurationVar(&timeout, "timeout", 2*time.Hour, "with --wait, give up after this long")
	return cmd
}

// runResult turns a finished run into the command's exit status.
func (a *App) runResult(run *api.CronRun) error {
	if run.Status == api.CronSucceeded {
		if !a.jsonOut {
			a.IO.Info("%s Run %s succeeded in %s", a.IO.ErrColor().Green("✓"), run.ID, a.runDuration(run))
		}
		return nil
	}
	if a.jsonOut {
		return exitcode.Silent(exitcode.Error)
	}
	msg := "run " + run.ID + " " + run.Status
	if run.ExitCode != nil {
		msg += fmt.Sprintf(" (exit %d)", *run.ExitCode)
	}
	if run.Error != nil {
		msg += ": " + *run.Error
	}
	return exitcode.New(exitcode.Error, "%s", msg)
}

// watchRun polls a run until it finishes, printing new output as it
// arrives when withLogs is set, and returns the finished run.
func (a *App) watchRun(ctx context.Context, c *api.Client, run *api.CronRun, withLogs bool) (*api.CronRun, error) {
	p := &logPrinter{a: a, pal: a.IO.OutColor(), seen: newDedupe(8192)}
	failures := 0
	for {
		cur, err := c.GetCronRun(ctx, run.ID)
		if err == nil && withLogs {
			// The run is read before its output, so the lines of a finished
			// run are complete once it is seen finished.
			err = a.printNewRunLogs(ctx, c, run.ID, p)
		}
		switch {
		case err == nil:
			failures = 0
			run = cur
			if api.IsCronRunFinished(run.Status) {
				return run, nil
			}
		case ctx.Err() != nil:
			return run, ctx.Err()
		default:
			var netErr *api.NetworkError
			if !errors.As(err, &netErr) || failures >= maxPollFailures {
				return run, err
			}
			failures++
		}
		if !sleepCtx(ctx, a.PollInterval) {
			return run, ctx.Err()
		}
	}
}

// printNewRunLogs pages backwards from the newest line until it reaches a
// line already printed (or the first line), then prints the new lines
// oldest first.
func (a *App) printNewRunLogs(ctx context.Context, c *api.Client, runID string, p *logPrinter) error {
	var pages [][]api.LogEntry
	cursor := ""
	for {
		page, err := c.CronRunLogs(ctx, runID, cursor, maxLogPage)
		if err != nil {
			return err
		}
		pages = append(pages, page.Lines)
		if page.NextCursor == nil || len(page.Lines) == 0 || p.seen.has(logKey(page.Lines[0])) {
			break
		}
		cursor = *page.NextCursor
	}
	for i := len(pages) - 1; i >= 0; i-- {
		p.print(pages[i], true)
	}
	return nil
}

// -----------------------------------------------------------------------------
// cron logs
// -----------------------------------------------------------------------------

func (a *App) cronLogsCmd() *cobra.Command {
	var follow bool
	cmd := &cobra.Command{
		Use:   "logs RUN_ID",
		Short: "Print a cron run's output",
		Long: `Print a run's output, oldest line first. With -f, keep polling for new
lines until the run ends. With --json each line is printed as one JSON
object (NDJSON).`,
		Example: `  roundhouse cron logs crn_01J9Z6Y4M0V8
  roundhouse cron logs crn_01J9Z6Y4M0V8 -f`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			sess, err := a.connect()
			if err != nil {
				return err
			}
			c := sess.client
			run, err := c.GetCronRun(ctx, args[0])
			if err != nil {
				return err
			}
			if !follow || api.IsCronRunFinished(run.Status) {
				p := &logPrinter{a: a, pal: a.IO.OutColor(), seen: newDedupe(8192)}
				if err := a.printNewRunLogs(ctx, c, run.ID, p); err != nil {
					return err
				}
				if follow {
					a.IO.Info("Run %s is %s; not following.", run.ID, run.Status)
				}
				return nil
			}
			run, err = a.watchRun(ctx, c, run, true)
			if errors.Is(err, context.Canceled) {
				return nil
			}
			if err != nil {
				return err
			}
			a.IO.Info("Run %s %s.", run.ID, run.Status)
			return nil
		},
	}
	cmd.Flags().BoolVarP(&follow, "follow", "f", false, "keep printing new lines until the run ends")
	return cmd
}

// -----------------------------------------------------------------------------
// cron cancel
// -----------------------------------------------------------------------------

func (a *App) cronCancelCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "cancel RUN_ID",
		Short: "Cancel a queued or running cron run",
		Long: `Cancel a run. A queued run is cancelled at once; a running one is stopped
by its server, and shows as cancelled once the server reports it.`,
		Example: `  roundhouse cron cancel crn_01J9Z6Y4M0V8`,
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			sess, err := a.connect()
			if err != nil {
				return err
			}
			run, err := sess.client.CancelCronRun(ctx, args[0])
			if err != nil {
				if api.IsStatus(err, http.StatusConflict) {
					return withHint(err, "only a queued or running run can be cancelled")
				}
				return err
			}
			if a.jsonOut {
				return a.printJSON(run)
			}
			if run.Status == api.CronCancelled {
				fmt.Fprintf(a.IO.Out, "%s Cancelled run %s\n", a.IO.OutColor().Green("✓"), run.ID)
			} else {
				fmt.Fprintf(a.IO.Out, "%s Cancelling run %s; its server stops it\n", a.IO.OutColor().Green("✓"), run.ID)
			}
			return nil
		},
	}
}

// -----------------------------------------------------------------------------
// cron pause / resume
// -----------------------------------------------------------------------------

func (a *App) cronPauseCmd(pause bool) *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:   "pause",
		Short: "Stop scheduling a cron service's runs",
		Long: `Stop scheduling runs of the cron service in the environment until it is
resumed. Slots while paused are neither run nor recorded as missed; a run
in progress continues, and "cron run" still works.`,
		Example: `  roundhouse cron pause
  roundhouse cron pause --service nightly --environment staging`,
		Args: noArgs,
	}
	if !pause {
		cmd.Use, cmd.Short = "resume", "Resume scheduling a paused cron service"
		cmd.Long = `Resume scheduling runs of the cron service in the environment, from the
next future slot. Slots that passed while paused are not run.`
		cmd.Example = `  roundhouse cron resume`
	}
	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		ctx := cmd.Context()
		t, err := a.resolveCron(ctx, f)
		if err != nil {
			return err
		}
		c := t.sess.client
		var st *api.CronState
		if pause {
			st, err = c.PauseCron(ctx, t.service.ID, t.env.ID)
		} else {
			st, err = c.ResumeCron(ctx, t.service.ID, t.env.ID)
		}
		if err != nil {
			return err
		}
		if a.jsonOut {
			return a.printJSON(st)
		}
		check := a.IO.OutColor().Green("✓")
		switch {
		case pause:
			fmt.Fprintf(a.IO.Out, "%s Paused %s in %s; no runs are scheduled until `roundhouse cron resume`\n", check, t.service.Name, t.env.Name)
		case st.NextRunAt != nil:
			fmt.Fprintf(a.IO.Out, "%s Resumed %s in %s; next run %s\n", check, t.service.Name, t.env.Name, zoneTime(*st.NextRunAt, deref(st.Timezone)))
		default:
			fmt.Fprintf(a.IO.Out, "%s Resumed %s in %s\n", check, t.service.Name, t.env.Name)
		}
		return nil
	}
	f.register(cmd, true)
	return cmd
}

// -----------------------------------------------------------------------------
// cron preview
// -----------------------------------------------------------------------------

func (a *App) cronPreviewCmd() *cobra.Command {
	var f targetFlags
	var timezone string
	var count int
	cmd := &cobra.Command{
		Use:   "preview SCHEDULE",
		Short: "Show the next slots of a cron schedule",
		Long: `Check a schedule the way the control plane reads it and show its next
slots. SCHEDULE is a five-field cron expression (minute hour day-of-month
month day-of-week) or a macro such as @daily; quote it, or pass the fields
as separate arguments. An invalid schedule exits 7 and underlines the
offending part.`,
		Example: `  roundhouse cron preview "0 3 * * *"
  roundhouse cron preview "*/15 9-17 * * MON-FRI" --timezone Europe/Berlin --count 10
  roundhouse cron preview @weekly`,
		Args: minArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if count < 1 || count > 10 {
				return exitcode.New(exitcode.Usage, "--count must be between 1 and 10")
			}
			schedule := strings.Join(args, " ")
			ctx := cmd.Context()
			t, err := a.resolve(ctx, f, serviceOptional)
			if err != nil {
				return err
			}
			pv, err := t.sess.client.PreviewCronSchedule(ctx, t.project.ID, schedule, timezone, count)
			if err != nil {
				return err
			}
			if a.jsonOut {
				a.printJSON(pv)
				if !pv.Valid {
					return exitcode.Silent(exitcode.Invalid)
				}
				return nil
			}
			if !pv.Valid {
				return a.scheduleError(pv.Error, schedule, timezone)
			}
			fmt.Fprintf(a.IO.Out, "Next runs of %q (%s):\n", schedule, timezone)
			for _, ms := range pv.NextRuns {
				fmt.Fprintf(a.IO.Out, "  %s\n", zoneTime(ms, timezone))
			}
			return nil
		},
	}
	cmd.Flags().StringVarP(&f.project, "project", "p", "", "project ID or slug (default: linked project)")
	cmd.Flags().StringVar(&timezone, "timezone", "UTC", "IANA time zone the schedule is read in")
	cmd.Flags().IntVar(&count, "count", 5, "slots to show (1-10)")
	return cmd
}

// scheduleError prints where a schedule or zone stopped parsing, with a
// caret under the offending span, and returns the exit status.
func (a *App) scheduleError(se *api.ScheduleError, schedule, timezone string) error {
	if se == nil {
		return exitcode.New(exitcode.Invalid, "invalid schedule")
	}
	value := schedule
	if se.Code == "invalid_timezone" {
		value = timezone
	}
	c := a.IO.ErrColor()
	fmt.Fprintf(a.IO.Err, "%s %s\n", c.Red("error:"), se.Message)
	start, end := api.UTF16Span(value, se.Start, se.End)
	if start < end {
		fmt.Fprintf(a.IO.Err, "  %s\n  %s%s\n", value, strings.Repeat(" ", displayWidth(value[:start])),
			c.Red(strings.Repeat("^", max(1, displayWidth(value[start:end])))))
	}
	return exitcode.Silent(exitcode.Invalid)
}
