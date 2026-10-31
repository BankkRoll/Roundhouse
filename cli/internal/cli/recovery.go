package cli

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// -----------------------------------------------------------------------------
// Times
// -----------------------------------------------------------------------------

// zone returns the time zone local times are shown in.
func (a *App) zone() *time.Location {
	if a.Location != nil {
		return a.Location
	}
	return time.Local
}

// localMoment renders a unix ms instant in the local zone to the second,
// e.g. "2026-10-22 04:50:00 PDT".
func (a *App) localMoment(ms int64) string {
	return millis(ms).In(a.zone()).Format("2006-01-02 15:04:05 MST")
}

// utcMoment renders a unix ms instant as RFC 3339 in UTC, which `pitr
// restore --to` accepts as is.
func utcMoment(ms int64) string {
	return millis(ms).Format(time.RFC3339Nano)
}

func (a *App) localIsUTC(ms int64) bool {
	_, off := millis(ms).In(a.zone()).Zone()
	return off == 0
}

// moment renders an instant in local time with UTC alongside, or in UTC
// alone when the local zone is UTC.
func (a *App) moment(ms int64) string {
	if a.localIsUTC(ms) {
		return utcMoment(ms)
	}
	return a.localMoment(ms) + " (" + utcMoment(ms) + ")"
}

// -----------------------------------------------------------------------------
// db pitr
// -----------------------------------------------------------------------------

func (a *App) dbPitrCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "pitr",
		Aliases: []string{"point-in-time"},
		Short:   "Show and restore a Postgres database to a point in time",
		Long: `Point-in-time recovery (PITR) archives a Postgres database's write-ahead
log (WAL) continuously, so it can be restored to any moment a base backup
and the WAL after it cover, not only to when a backup was taken.

Turn it on with ` + "`roundhouse db backups policy set --pitr on`" + `: scheduled
backups then become base backups. "pitr status" shows the restorable
windows and "pitr restore" restores in place or into a new database.
PITR is available for Postgres only.`,
		Example: `  roundhouse db pitr status
  roundhouse db pitr restore --to 2026-10-22T11:50:00Z
  roundhouse db pitr restore db --to 2026-10-22T04:50:00-07:00 --into-new db-before-migration`,
		Args: noArgs,
	}
	cmd.AddCommand(a.dbPitrStatusCmd(), a.dbPitrRestoreCmd())
	return cmd
}

func (a *App) dbPitrStatusCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:   "status [SERVICE]",
		Short: "Show whether PITR is on and the windows a restore can target",
		Long: `Show a database's point-in-time recovery in the environment: whether it
is on, why it cannot be when it cannot, the WAL archive, and every window
a restore can target, in local time and in UTC. The end of a window is
the newest archived point and is exclusive.

The database is SERVICE, --service, the linked service when it is a
database, or the project's only database.`,
		Example: `  roundhouse db pitr status
  roundhouse db pitr status db --environment staging --json`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := serviceArg(&f, args); err != nil {
				return err
			}
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, true)
			if err != nil {
				return err
			}
			st, err := t.sess.client.PitrStatus(ctx, t.service.ID, t.env.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(st)
			}
			a.printPitrStatus(t, st)
			return nil
		},
	}
	f.register(cmd, true)
	return cmd
}

func (a *App) printPitrStatus(t *target, st *api.PitrStatus) {
	pal := a.IO.OutColor()
	fmt.Fprintf(a.IO.Out, "Point-in-time recovery of %s in %s\n", pal.Bold(t.service.Name), t.env.Name)
	row := func(k, v string) { fmt.Fprintf(a.IO.Out, "  %-13s %s\n", k, v) }
	reason := deref(st.UnavailableReason)
	switch {
	case st.Enabled && reason != "":
		row("PITR", pal.Yellow("on, but not archiving")+": "+reason)
	case st.Enabled:
		row("PITR", pal.Green("on"))
	case reason != "":
		row("PITR", pal.Yellow("unavailable")+": "+reason)
	default:
		row("PITR", pal.Yellow("off")+"; turn it on with `roundhouse db backups policy set --pitr on`")
	}
	if s := st.Stream; s != nil {
		archive := fmt.Sprintf("%s, %s, %s", s.Status, plural(int(s.SegmentCount), "segment", "segments"), formatBytes(float64(s.BytesStored)))
		if s.LastArchivedAt != nil {
			archive += "; last archived " + ago(a.Now(), *s.LastArchivedAt)
		}
		row("WAL archive", archive)
	}
	row("Base backups", strconv.Itoa(st.BaseBackups))
	if len(st.Windows) == 0 {
		fmt.Fprintln(a.IO.Out, "Nothing is restorable to a point in time yet: that needs a base backup and WAL archived after it.")
		return
	}
	fmt.Fprintf(a.IO.Out, "Restorable windows, in %s (the end of each is exclusive):\n", a.zoneLabel())
	for i, w := range st.Windows {
		if a.localIsUTC(w.From) && a.localIsUTC(w.To) {
			fmt.Fprintf(a.IO.Out, "  %d. %s → %s\n", i+1, utcMoment(w.From), utcMoment(w.To))
			continue
		}
		fmt.Fprintf(a.IO.Out, "  %d. %s → %s\n", i+1, a.localMoment(w.From), a.localMoment(w.To))
		fmt.Fprintf(a.IO.Out, "     %s → %s\n", utcMoment(w.From), utcMoment(w.To))
	}
	fmt.Fprintf(a.IO.Out, "Restore with `roundhouse db pitr restore --to <time>`, e.g. --to %s\n", utcMoment(st.Windows[len(st.Windows)-1].To-1000))
}

// zoneLabel says which zones window times are shown in.
func (a *App) zoneLabel() string {
	name, off := a.Now().In(a.zone()).Zone()
	if off == 0 {
		return "UTC"
	}
	return name + " then UTC"
}

// pitrWindowError explains why ms is not restorable, naming the nearest
// restorable point.
func (a *App) pitrWindowError(ms int64, windows []api.PitrRange) error {
	ranges := make([]string, len(windows))
	for i, w := range windows {
		ranges[i] = utcMoment(w.From) + " to " + utcMoment(w.To)
	}
	err := exitcode.New(exitcode.Invalid, "%s is outside the restorable windows: %s", a.moment(ms), strings.Join(ranges, ", "))
	first, last := windows[0], windows[len(windows)-1]
	switch {
	case ms >= last.To:
		return withHint(err, "the newest restorable point is just before "+a.moment(last.To)+"; WAL newer than that is not archived yet")
	case ms < first.From:
		return withHint(err, "the oldest restorable point is "+a.moment(first.From)+"; older WAL is no longer kept")
	}
	return withHint(err, "the time falls in a gap with no base backup and gapless WAL; `roundhouse db pitr status` lists the windows")
}

func (a *App) dbPitrRestoreCmd() *cobra.Command {
	var f targetFlags
	var to, intoNew, confirm string
	var skipSafety, wait bool
	var timeout time.Duration
	cmd := &cobra.Command{
		Use:   "restore [SERVICE] --to TIME",
		Short: "Restore a Postgres database to a moment in time",
		Long: `Restore a database to the moment --to, an RFC 3339 time with a zone
(e.g. 2026-10-22T11:50:00Z or 2026-10-22T04:50:00-07:00). The time must
fall inside a restorable window (` + "`roundhouse db pitr status`" + `); it is
checked here before anything is sent.

By default the database is restored in place: its data is replaced by
the data as of --to and everything written after that is lost. A safety
backup of the current data is taken first unless --skip-safety-backup is
given. With --into-new SLUG a new database with that slug is added in the
same environment and restored instead; the original is not touched.

You are asked to type the database's slug; in scripts pass it with
--confirm. Restoring needs a recent sign-in, so API tokens cannot
restore. With --wait, follow the restore until it succeeds (exit 0) or
fails (exit 1).`,
		Example: `  roundhouse db pitr restore --to 2026-10-22T11:50:00Z
  roundhouse db pitr restore db --to 2026-10-22T11:50:00Z --confirm db --wait
  roundhouse db pitr restore --to 2026-10-22T04:50:00-07:00 --into-new db-before-migration`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := serviceArg(&f, args); err != nil {
				return err
			}
			if to == "" {
				return exitcode.New(exitcode.Usage, "pass --to with the moment to restore to, e.g. --to 2026-10-22T11:50:00Z")
			}
			at, err := time.Parse(time.RFC3339Nano, to)
			if err != nil {
				return exitcode.New(exitcode.Usage, "--to %q is not an RFC 3339 time with a zone, e.g. 2026-10-22T11:50:00Z or 2026-10-22T04:50:00-07:00", to)
			}
			if intoNew != "" && !isSlug(intoNew) {
				return exitcode.New(exitcode.Usage, "--into-new %q is not a slug: lowercase letters, digits and dashes, up to 40 characters", intoNew)
			}
			if skipSafety && intoNew != "" {
				return exitcode.New(exitcode.Usage, "--skip-safety-backup applies to in-place restores only; --into-new leaves the original untouched")
			}
			ms := at.UnixMilli()
			if at.After(a.Now()) {
				return exitcode.New(exitcode.Invalid, "--to %s is in the future", a.moment(ms))
			}
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, true)
			if err != nil {
				return err
			}
			c := t.sess.client
			st, err := c.PitrStatus(ctx, t.service.ID, t.env.ID)
			if err != nil {
				return err
			}
			if len(st.Windows) == 0 {
				err := exitcode.New(exitcode.Invalid, "nothing of %s in %s is restorable to a point in time yet", t.service.Name, t.env.Name)
				switch {
				case st.UnavailableReason != nil:
					return withHint(err, *st.UnavailableReason)
				case !st.Enabled:
					return withHint(err, "turn point-in-time recovery on with `roundhouse db backups policy set --pitr on`; restores can target times after its first base backup")
				}
				return withHint(err, "it needs a base backup and WAL archived after it; `roundhouse db pitr status` shows the archive")
			}
			if !slices.ContainsFunc(st.Windows, func(w api.PitrRange) bool { return w.Contains(ms) }) {
				return a.pitrWindowError(ms, st.Windows)
			}
			in := api.PitrRestoreInput{EnvironmentID: t.env.ID, TargetTime: ms, Mode: api.RestoreInPlace, Confirm: t.service.Slug, SkipSafetyBackup: skipSafety}
			when := a.moment(ms)
			warning := fmt.Sprintf("This restores %s in %s to %s, replacing its current data: everything written after that moment is lost.", t.service.Name, t.env.Name, when)
			switch {
			case intoNew != "":
				in.Mode, in.Slug = api.RestoreNewService, intoNew
				warning = fmt.Sprintf("This restores %s in %s as of %s into a new database %s. %s is not touched.", t.service.Name, t.env.Name, when, intoNew, t.service.Name)
			case skipSafety:
				warning += " No safety backup is taken."
			default:
				warning += " A safety backup of the current data is taken first."
			}
			if err := a.IO.ConfirmTyped(warning, t.service.Slug, confirm); err != nil {
				return err
			}
			r, err := c.PitrRestore(ctx, t.service.ID, in)
			if err != nil {
				var apiErr *api.Error
				if errors.As(err, &apiErr) && apiErr.Code == "pitr_target_unavailable" {
					return withHint(err, "the windows changed since they were checked; `roundhouse db pitr status` shows them now")
				}
				return a.reauthHint(err, "a point-in-time restore")
			}
			var created *api.Service
			if r.Mode == api.RestoreNewService && r.TargetServiceID != nil {
				// NOTE: best effort; the restore has started either way, and
				// its ID alone still identifies the new service.
				created, _ = c.GetService(ctx, *r.TargetServiceID)
			}
			if !a.jsonOut {
				a.printPitrRestoreStarted(t, r, created, ms)
			}
			if !wait {
				if a.jsonOut {
					return a.printJSON(r)
				}
				return nil
			}
			r, err = a.waitRestore(ctx, c, r, "Restoring "+t.service.Name, timeout)
			if err != nil {
				return err
			}
			if a.jsonOut {
				a.printJSON(r)
			}
			if r.Status != "succeeded" {
				if a.jsonOut {
					return exitcode.Silent(exitcode.Error)
				}
				return exitcode.New(exitcode.Error, "restore %s failed: %s", r.ID, cmp.Or(deref(r.Error), "unknown error"))
			}
			if !a.jsonOut {
				into := t.service.Name
				if created != nil {
					into = fmt.Sprintf("%s (%s)", created.Name, created.Slug)
				}
				fmt.Fprintf(a.IO.Out, "%s Restored %s to %s\n", a.IO.OutColor().Green("✓"), into, when)
			}
			return nil
		},
	}
	f.register(cmd, true)
	cmd.Flags().StringVar(&to, "to", "", "RFC 3339 time to restore to, e.g. 2026-10-22T11:50:00Z")
	cmd.Flags().StringVar(&intoNew, "into-new", "", "restore into a new database with this slug instead of in place")
	cmd.Flags().StringVar(&confirm, "confirm", "", "the database's slug, to skip the prompt")
	cmd.Flags().BoolVar(&skipSafety, "skip-safety-backup", false, "in place, do not back up the current data first")
	cmd.Flags().BoolVarP(&wait, "wait", "w", false, "wait until the restore finishes")
	cmd.Flags().DurationVar(&timeout, "timeout", time.Hour, "with --wait, give up after this long")
	return cmd
}

func (a *App) printPitrRestoreStarted(t *target, r *api.Restore, created *api.Service, ms int64) {
	how := "in place"
	if r.Mode == api.RestoreNewService {
		how = "into a new database"
		switch {
		case created != nil:
			how += fmt.Sprintf(" %s (%s)", created.Name, created.Slug)
		case r.TargetServiceID != nil:
			how += " " + *r.TargetServiceID
		}
	}
	fmt.Fprintf(a.IO.Out, "%s Started restore %s of %s in %s to %s, %s\n", a.IO.OutColor().Green("✓"), r.ID, t.service.Name, t.env.Name, a.moment(ms), how)
	fmt.Fprintf(a.IO.Out, "  Base backup: %s, with the WAL archived after it replayed up to that moment\n", r.BackupID)
	if r.SafetyBackupID != nil {
		fmt.Fprintf(a.IO.Out, "  Safety backup: %s\n", *r.SafetyBackupID)
	}
	if r.Mode == api.RestoreNewService {
		fmt.Fprintf(a.IO.Out, "  %s is not touched. The data is restored once the new database runs.\n", t.service.Name)
	}
}

// waitRestore polls a restore until it succeeds or fails.
func (a *App) waitRestore(ctx context.Context, c *api.Client, r *api.Restore, label string, timeout time.Duration) (*api.Restore, error) {
	wctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	err := a.pollUntil(wctx, label, func() (bool, string, error) {
		cur, err := c.GetRestore(wctx, r.ID)
		if err != nil {
			return false, "", err
		}
		r = cur
		return r.Status == "succeeded" || r.Status == "failed", r.Status, nil
	})
	if err != nil {
		return nil, a.waitErr(err, timeout, r.ID)
	}
	return r, nil
}

// -----------------------------------------------------------------------------
// db recovery
// -----------------------------------------------------------------------------

func (a *App) dbRecoveryCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "recovery",
		Short: "Show or set automatic recovery of a lost server's volume",
		Long: `Automatic recovery rebuilds a database's volume on another server when
its server stays offline longer than a grace period: the same recovery as
` + "`roundhouse db volume recover`" + `, from the newest backup, run by the
control plane. It is off by default and set per environment.`,
		Example: `  roundhouse db recovery policy
  roundhouse db recovery policy set --enable --grace 30m`,
		Args: noArgs,
	}
	cmd.AddCommand(a.dbRecoveryPolicyCmd())
	return cmd
}

func (a *App) dbRecoveryPolicyCmd() *cobra.Command {
	var f targetFlags
	show := func(cmd *cobra.Command, args []string, f targetFlags) error {
		if err := serviceArg(&f, args); err != nil {
			return err
		}
		ctx := cmd.Context()
		t, err := a.resolveDatabase(ctx, f, true)
		if err != nil {
			return err
		}
		p, err := t.sess.client.RecoveryPolicy(ctx, t.service.ID, t.env.ID)
		if err != nil {
			return err
		}
		if a.jsonOut {
			return a.printJSON(p)
		}
		a.printRecoveryPolicy(t, p)
		return nil
	}
	cmd := &cobra.Command{
		Use:   "policy",
		Short: "Show a database's automatic recovery policy",
		Long: `Show the automatic recovery policy of a database (or of --service) in
the environment: whether it is on, the grace period, and what it is doing
now. "policy set" changes it.`,
		Example: `  roundhouse db recovery policy
  roundhouse db recovery policy get db --environment staging --json
  roundhouse db recovery policy set --enable --grace 1h`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, args []string) error { return show(cmd, args, f) },
	}
	f.register(cmd, true)

	var gf targetFlags
	get := &cobra.Command{
		Use:     "get [SERVICE]",
		Aliases: []string{"show"},
		Short:   "Show a database's automatic recovery policy",
		Example: `  roundhouse db recovery policy get
  roundhouse db recovery policy get db --json`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error { return show(cmd, args, gf) },
	}
	gf.register(get, true)
	cmd.AddCommand(get, a.dbRecoveryPolicySetCmd())
	return cmd
}

// formatGrace renders whole minutes compactly, e.g. "30m", "1h 30m", "7d".
func formatGrace(minutes int) string {
	d, h, m := minutes/1440, minutes%1440/60, minutes%60
	var parts []string
	if d > 0 {
		parts = append(parts, strconv.Itoa(d)+"d")
	}
	if h > 0 {
		parts = append(parts, strconv.Itoa(h)+"h")
	}
	if m > 0 || len(parts) == 0 {
		parts = append(parts, strconv.Itoa(m)+"m")
	}
	return strings.Join(parts, " ")
}

// parseGrace reads a grace period as a Go duration (30m, 2h30m) or whole
// days (7d) and checks it against the API's bounds.
func parseGrace(s string) (int, error) {
	bounds := fmt.Sprintf("--grace must be whole minutes from %s to %s, e.g. 30m, 2h or 7d", formatGrace(api.MinRecoveryGraceMinutes), formatGrace(api.MaxRecoveryGraceMinutes))
	var d time.Duration
	if days, ok := strings.CutSuffix(strings.TrimSpace(s), "d"); ok {
		n, err := strconv.Atoi(days)
		if err != nil {
			return 0, exitcode.New(exitcode.Usage, "%s", bounds)
		}
		d = time.Duration(n) * 24 * time.Hour
	} else {
		var err error
		if d, err = time.ParseDuration(strings.TrimSpace(s)); err != nil {
			return 0, exitcode.New(exitcode.Usage, "%s", bounds)
		}
	}
	if d%time.Minute != 0 || d < api.MinRecoveryGraceMinutes*time.Minute || d > api.MaxRecoveryGraceMinutes*time.Minute {
		return 0, exitcode.New(exitcode.Usage, "%s", bounds)
	}
	return int(d / time.Minute), nil
}

func (a *App) printRecoveryPolicy(t *target, p *api.RecoveryPolicy) {
	pal := a.IO.OutColor()
	title := fmt.Sprintf("Automatic recovery of %s in %s", pal.Bold(t.service.Name), t.env.Name)
	if p.ID == nil {
		title += pal.Dim(" (defaults; not saved yet)")
	}
	fmt.Fprintln(a.IO.Out, title)
	row := func(k, v string) { fmt.Fprintf(a.IO.Out, "  %-12s %s\n", k, v) }
	if p.Enabled {
		on := pal.Green("on")
		if p.EnabledBy != nil {
			on += "; recoveries run with the access of " + *p.EnabledBy + ", checked each time"
		}
		row("Recovery", on)
	} else {
		row("Recovery", pal.Yellow("off")+"; recover a lost server's volume with `roundhouse db volume recover`")
	}
	row("Grace", formatGrace(p.GraceMinutes)+" offline before recovery starts")
	status := p.Status
	switch p.Status {
	case "recovered":
		status = pal.Green(status)
	case "watching", "recovering":
		status = pal.Yellow(status)
	case "blocked", "failed":
		status = pal.Red(status)
	}
	if p.Message != nil && *p.Message != "" {
		status += ": " + *p.Message
	}
	row("Status", status)
	if p.LostNodeID != nil {
		row("Lost server", *p.LostNodeID)
	}
	if p.RestoreID != nil {
		last := *p.RestoreID
		if p.TriggeredAt != nil {
			last += ", started " + a.moment(*p.TriggeredAt)
		}
		row("Last run", last)
	}
}

func (a *App) dbRecoveryPolicySetCmd() *cobra.Command {
	var f targetFlags
	var grace string
	var enable, disable bool
	cmd := &cobra.Command{
		Use:   "set [SERVICE]",
		Short: "Turn automatic recovery on or off, or change its grace period",
		Long: `Change the automatic recovery policy; flags you leave out keep their
value.

--grace is how long the volume's server must stay offline before
recovery starts: whole minutes from 5m to 7d (default 30m). Recoveries
run with the access of whoever last turned the policy on, checked again
each time, so turning it on needs what a manual recovery needs. Changing
the policy needs a recent sign-in, so API tokens cannot change it.`,
		Example: `  roundhouse db recovery policy set --enable
  roundhouse db recovery policy set db --enable --grace 2h
  roundhouse db recovery policy set --disable`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := serviceArg(&f, args); err != nil {
				return err
			}
			if enable && disable {
				return exitcode.New(exitcode.Usage, "pass either --enable or --disable, not both")
			}
			in := api.PutRecoveryPolicyInput{}
			if enable || disable {
				in.Enabled = &enable
			}
			if cmd.Flags().Changed("grace") {
				minutes, err := parseGrace(grace)
				if err != nil {
					return err
				}
				in.GraceMinutes = &minutes
			}
			if in.Enabled == nil && in.GraceMinutes == nil {
				return exitcode.New(exitcode.Usage, "nothing to change; pass --enable, --disable or --grace")
			}
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, true)
			if err != nil {
				return err
			}
			in.EnvironmentID = t.env.ID
			p, err := t.sess.client.PutRecoveryPolicy(ctx, t.service.ID, in)
			if err != nil {
				return a.reauthHint(err, "changing automatic recovery")
			}
			if a.jsonOut {
				return a.printJSON(p)
			}
			fmt.Fprintf(a.IO.Out, "%s Saved the recovery policy\n", a.IO.OutColor().Green("✓"))
			a.printRecoveryPolicy(t, p)
			return nil
		},
	}
	f.register(cmd, true)
	cmd.Flags().StringVar(&grace, "grace", "", "time offline before recovery starts, 5m to 7d, e.g. 30m")
	cmd.Flags().BoolVar(&enable, "enable", false, "turn automatic recovery on")
	cmd.Flags().BoolVar(&disable, "disable", false, "turn automatic recovery off")
	return cmd
}

// -----------------------------------------------------------------------------
// db volume abandoned
// -----------------------------------------------------------------------------

func (a *App) dbVolumeAbandonedCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:     "abandoned [SERVICE]",
		Aliases: []string{"abandoned-copies"},
		Short:   "List the copies recoveries left on lost servers",
		Long: `List the copies of a database's volume (or --service's) that recoveries
left on lost servers in the environment, newest first, and where each
one's deletion stands.

A copy is deleted once its server is back, its grace period (72 hours
after the recovery) has passed, the service's new volume is ready on
another server and a restore into it has succeeded. Until then it is kept,
as it may hold the only copy of the data.

States: waiting_for_server, scheduled, kept, deleting, deleted.`,
		Example: `  roundhouse db volume abandoned
  roundhouse db volume abandoned db --environment staging --json`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := serviceArg(&f, args); err != nil {
				return err
			}
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, true)
			if err != nil {
				return err
			}
			list, err := t.sess.client.AbandonedCopies(ctx, t.service.ID, t.env.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(list)
			}
			if len(list.Copies) == 0 {
				fmt.Fprintf(a.IO.Out, "No abandoned copies of %s's volume in %s.\n", t.service.Name, t.env.Name)
				return nil
			}
			tb := a.newTable("volume", "server", "state", "used", "abandoned", "deletion")
			var notes []api.AbandonedCopy
			for _, c := range list.Copies {
				abandoned := "-"
				if c.AbandonedAt != nil {
					abandoned = ago(a.Now(), *c.AbandonedAt)
				}
				tb.row(c.VolumeID, orDash(cmp.Or(deref(c.NodeName), deref(c.NodeID))), c.State, abandonedUsage(c), abandoned, a.abandonedDeletion(c))
				if c.Message != nil && *c.Message != "" && c.State != "deleted" {
					notes = append(notes, c)
				}
			}
			tb.flush()
			for _, c := range notes {
				fmt.Fprintf(a.IO.Out, "%s %s: %s\n", a.IO.OutColor().Dim("note"), c.VolumeID, *c.Message)
			}
			return nil
		},
	}
	f.register(cmd, true)
	return cmd
}

func abandonedUsage(c api.AbandonedCopy) string {
	if c.UsedBytes == nil {
		return "- / " + formatMiB(c.SizeMB)
	}
	return formatBytes(float64(*c.UsedBytes)) + " / " + formatMiB(c.SizeMB)
}

// abandonedDeletion says when a copy was or may be deleted.
func (a *App) abandonedDeletion(c api.AbandonedCopy) string {
	switch {
	case c.CleanedAt != nil:
		return "deleted " + ago(a.Now(), *c.CleanedAt)
	case c.DeleteSentAt != nil:
		return "requested " + ago(a.Now(), *c.DeleteSentAt)
	case c.DeleteAfter != nil:
		return "not before " + formatInstant(millis(*c.DeleteAfter))
	}
	return "-"
}
