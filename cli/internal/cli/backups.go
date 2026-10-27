package cli

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"filippo.io/age"
	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
	"github.com/BankkRoll/Roundhouse/cli/internal/ui"
)

func (a *App) dbBackupsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "backups",
		Aliases: []string{"backup"},
		Short:   "List, take, schedule, restore and download backups",
		Long: `Back up a database: list its backups, take one now, set its schedule and
retention, restore one, or download one.

Backups are encrypted on the server with the project's backup key before
they reach object storage. An instance admin configures the bucket in the
dashboard (Settings → Backups).`,
		Example: `  roundhouse db backups list
  roundhouse db backups run --wait
  roundhouse db backups policy set --schedule "0 2 * * *" --keep-last 14
  roundhouse db backups restore bak_01J9Z6Y4M0V8 --mode in_place --confirm postgres
  roundhouse db backups restore bak_01J9Z6Y4M0V8 --mode new_service --slug postgres-copy
  roundhouse db backups download bak_01J9Z6Y4M0V8 --decrypt`,
		Args: noArgs,
	}
	cmd.AddCommand(a.backupsListCmd(), a.backupsRunCmd(), a.backupsPolicyCmd(), a.backupsRestoreCmd(), a.backupsDownloadCmd())
	return cmd
}

// reauthHint words the fresh-session refusal for what needed it.
func (a *App) reauthHint(err error, what string) error {
	var apiErr *api.Error
	if !errors.As(err, &apiErr) || apiErr.Code != "reauth_required" {
		return err
	}
	if a.apiToken {
		return withHint(err, "API tokens never count as a recent sign-in, and "+what+" needs one; unset "+EnvToken+" and sign in with `roundhouse login`")
	}
	return withHint(err, what+" needs a recent sign-in; run `roundhouse login` again, then retry")
}

// formatDuration renders a whole-second duration, e.g. "1m 05s".
func formatDuration(d time.Duration) string {
	d = d.Round(time.Second)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm %02ds", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%dh %02dm", int(d.Hours()), int(d.Minutes())%60)
}

func backupDuration(b *api.Backup) string {
	if b.StartedAt == nil || b.FinishedAt == nil {
		return "-"
	}
	return formatDuration(time.Duration(*b.FinishedAt-*b.StartedAt) * time.Millisecond)
}

func backupSize(b *api.Backup) string {
	if b.BytesStored == nil {
		return "-"
	}
	return formatBytes(float64(*b.BytesStored))
}

// pollUntil calls check every PollInterval until it reports done, riding
// out a few network errors.
func (a *App) pollUntil(ctx context.Context, label string, check func() (done bool, status string, err error)) error {
	return a.pollSpinning(ctx, label, func(*ui.Spinner) (bool, string, error) { return check() })
}

// pollSpinning is pollUntil for checks that print progress lines above the
// spinner.
func (a *App) pollSpinning(ctx context.Context, label string, check func(spin *ui.Spinner) (done bool, status string, err error)) error {
	spin := a.IO.StartSpinner(label)
	defer spin.Stop()
	failures := 0
	for {
		done, status, err := check(spin)
		switch {
		case err == nil:
			failures = 0
			if done {
				return nil
			}
			spin.Update(label + ": " + status)
		case ctx.Err() != nil:
			return ctx.Err()
		default:
			var netErr *api.NetworkError
			if !errors.As(err, &netErr) || failures >= maxPollFailures {
				return err
			}
			failures++
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(a.PollInterval):
		}
	}
}

// waitErr explains a wait that ended early; the work continues on the
// control plane.
func (a *App) waitErr(err error, timeout time.Duration, id string) error {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return exitcode.New(exitcode.Error, "timed out after %s waiting for %s; it continues on the control plane", timeout, id)
	case errors.Is(err, context.Canceled):
		a.IO.Info("Stopped watching; %s continues on the control plane.", id)
	}
	return err
}

// -----------------------------------------------------------------------------
// backups list
// -----------------------------------------------------------------------------

func (a *App) backupsListCmd() *cobra.Command {
	var f targetFlags
	var limit int
	var cursor string
	cmd := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List a database's backups, newest first",
		Example: `  roundhouse db backups list
  roundhouse db backups list --service cache --environment staging --limit 50 --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if limit < 1 || limit > 100 {
				return exitcode.New(exitcode.Usage, "--limit must be between 1 and 100")
			}
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, true)
			if err != nil {
				return err
			}
			page, err := t.sess.client.ListBackups(ctx, t.service.ID, t.env.ID, cursor, limit)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(page)
			}
			if len(page.Backups) == 0 {
				fmt.Fprintf(a.IO.Out, "No backups of %s in %s. Take one with `roundhouse db backups run`.\n", t.service.Name, t.env.Name)
				return nil
			}
			pal := a.IO.OutColor()
			tb := a.newTable("id", "status", "trigger", "size", "took", "created")
			var failed []api.Backup
			for _, b := range page.Backups {
				trigger := b.Trigger
				if b.Pinned {
					trigger += " (pinned)"
				}
				tb.row(b.ID, b.Status, trigger, backupSize(&b), backupDuration(&b), ago(a.Now(), b.CreatedAt))
				if b.Status == api.BackupFailed && b.Error != nil {
					failed = append(failed, b)
				}
			}
			tb.flush()
			for _, b := range failed {
				fmt.Fprintf(a.IO.Out, "%s %s: %s\n", pal.Red("failed"), b.ID, *b.Error)
			}
			if page.NextCursor != nil {
				fmt.Fprintf(a.IO.Err, "%s more backups: pass --cursor %s\n", a.IO.ErrColor().Dim("note:"), *page.NextCursor)
			}
			return nil
		},
	}
	f.register(cmd, true)
	cmd.Flags().IntVar(&limit, "limit", 20, "backups to list (up to 100)")
	cmd.Flags().StringVar(&cursor, "cursor", "", "continue a listing from this cursor")
	return cmd
}

// -----------------------------------------------------------------------------
// backups run
// -----------------------------------------------------------------------------

func (a *App) backupsRunCmd() *cobra.Command {
	var f targetFlags
	var wait bool
	var timeout time.Duration
	cmd := &cobra.Command{
		Use:     "run",
		Aliases: []string{"create", "now"},
		Short:   "Take a backup now",
		Long: `Queue a backup of the database in the environment. Manual backups are
pinned: retention never deletes them. With --wait, follow it until it
succeeds (exit 0) or fails (exit 1).`,
		Example: `  roundhouse db backups run
  roundhouse db backups run --service cache --wait --timeout 30m`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, true)
			if err != nil {
				return err
			}
			b, err := t.sess.client.CreateBackup(ctx, t.service.ID, t.env.ID)
			if err != nil {
				return err
			}
			if !wait {
				if a.jsonOut {
					return a.printJSON(b)
				}
				fmt.Fprintf(a.IO.Out, "%s Queued backup %s of %s in %s\n", a.IO.OutColor().Green("✓"), b.ID, t.service.Name, t.env.Name)
				fmt.Fprintf(a.IO.Out, "  Follow it with `roundhouse db backups list`, or pass --wait next time.\n")
				return nil
			}
			if !a.jsonOut {
				fmt.Fprintf(a.IO.Out, "Queued backup %s of %s in %s\n", b.ID, t.service.Name, t.env.Name)
			}
			wctx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()
			err = a.pollUntil(wctx, "Backing up "+t.service.Name, func() (bool, string, error) {
				cur, err := t.sess.client.GetBackup(wctx, b.ID)
				if err != nil {
					return false, "", err
				}
				b = cur
				return b.Status == api.BackupSucceeded || b.Status == api.BackupFailed || b.Status == api.BackupDeleted, b.Status, nil
			})
			if err != nil {
				return a.waitErr(err, timeout, b.ID)
			}
			if a.jsonOut {
				a.printJSON(b)
			}
			if b.Status != api.BackupSucceeded {
				msg := "backup " + b.ID + " " + b.Status
				if b.Error != nil {
					msg += ": " + *b.Error
				}
				if a.jsonOut {
					return exitcode.Silent(exitcode.Error)
				}
				return exitcode.New(exitcode.Error, "%s", msg)
			}
			if !a.jsonOut {
				fmt.Fprintf(a.IO.Out, "%s Backup %s succeeded: %s stored in %s\n", a.IO.OutColor().Green("✓"), b.ID, backupSize(b), backupDuration(b))
			}
			return nil
		},
	}
	f.register(cmd, true)
	cmd.Flags().BoolVarP(&wait, "wait", "w", false, "wait until the backup finishes")
	cmd.Flags().DurationVar(&timeout, "timeout", time.Hour, "with --wait, give up after this long")
	return cmd
}

// -----------------------------------------------------------------------------
// backups policy
// -----------------------------------------------------------------------------

func (a *App) backupsPolicyCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:     "policy",
		Aliases: []string{"schedule"},
		Short:   "Show or set a database's backup schedule and retention",
		Long: `Show the database's backup policy in the environment: whether scheduled
backups run, their schedule (five-field cron, in UTC) with the next runs,
and how many are kept. "policy set" changes it.`,
		Example: `  roundhouse db backups policy
  roundhouse db backups policy set --schedule "0 2 * * *" --keep-last 14 --max-age-days 30`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, true)
			if err != nil {
				return err
			}
			p, err := t.sess.client.BackupPolicy(ctx, t.service.ID, t.env.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(p)
			}
			a.printBackupPolicy(t, p)
			return nil
		},
	}
	f.register(cmd, true)
	cmd.AddCommand(a.backupsPolicySetCmd())
	return cmd
}

func (a *App) printBackupPolicy(t *target, p *api.BackupPolicy) {
	pal := a.IO.OutColor()
	title := fmt.Sprintf("Backups of %s in %s", pal.Bold(t.service.Name), t.env.Name)
	if p.ID == nil {
		title += pal.Dim(" (defaults; not saved yet)")
	}
	fmt.Fprintln(a.IO.Out, title)
	row := func(k, v string) { fmt.Fprintf(a.IO.Out, "  %-10s %s\n", k, v) }
	if p.Enabled {
		row("Scheduled", pal.Green("on")+" ("+p.Method+")")
	} else {
		row("Scheduled", pal.Yellow("off")+"; only manual backups run")
	}
	row("Schedule", p.Schedule+" ("+p.Timezone+")")
	if p.Enabled && len(p.NextRuns) > 0 {
		runs := make([]string, 0, 3)
		for _, ms := range p.NextRuns[:min(3, len(p.NextRuns))] {
			runs = append(runs, formatInstant(millis(ms)))
		}
		row("Next runs", strings.Join(runs, ", "))
	}
	row("Keep", fmt.Sprintf("the last %s; manual backups are pinned", plural(p.KeepLast, "scheduled backup", "scheduled backups")))
	if p.MaxAgeDays != nil {
		row("Max age", plural(*p.MaxAgeDays, "day", "days"))
	} else {
		row("Max age", "none")
	}
	if len(p.Databases) > 0 {
		row("Databases", strings.Join(p.Databases, ", "))
	}
}

// validSchedule loosely checks a five-field cron expression; the control
// plane validates it fully.
func validSchedule(s string) bool {
	fields := strings.Fields(s)
	if len(fields) != 5 {
		return false
	}
	return !slices.ContainsFunc(fields, func(f string) bool {
		return strings.Trim(strings.ToUpper(f), "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789*/,-") != ""
	})
}

func (a *App) backupsPolicySetCmd() *cobra.Command {
	var f targetFlags
	var schedule string
	var keepLast, maxAge int
	var noMaxAge, enable, disable bool
	cmd := &cobra.Command{
		Use:   "set",
		Short: "Change a database's backup schedule and retention",
		Long: `Change the backup policy; flags you leave out keep their value.

--schedule is a five-field cron expression in UTC. After each backup,
scheduled backups beyond --keep-last (newest kept) and any backup older
than --max-age-days are deleted; manual backups are exempt from
--keep-last.`,
		Example: `  roundhouse db backups policy set --schedule "0 */6 * * *"
  roundhouse db backups policy set --keep-last 30 --max-age-days 90
  roundhouse db backups policy set --no-max-age
  roundhouse db backups policy set --disable`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			in := api.PutBackupPolicyInput{}
			fl := cmd.Flags()
			if enable && disable {
				return exitcode.New(exitcode.Usage, "pass either --enable or --disable, not both")
			}
			if fl.Changed("max-age-days") && noMaxAge {
				return exitcode.New(exitcode.Usage, "pass either --max-age-days or --no-max-age, not both")
			}
			if enable || disable {
				in.Enabled = &enable
			}
			if fl.Changed("schedule") {
				schedule = strings.Join(strings.Fields(schedule), " ")
				if !validSchedule(schedule) {
					return exitcode.New(exitcode.Usage, `--schedule must be a five-field cron expression, e.g. "0 3 * * *" (daily at 03:00 UTC)`)
				}
				in.Schedule = &schedule
			}
			if fl.Changed("keep-last") {
				if keepLast < 1 || keepLast > api.MaxKeepLast {
					return exitcode.New(exitcode.Usage, "--keep-last must be between 1 and %d", api.MaxKeepLast)
				}
				in.KeepLast = &keepLast
			}
			switch {
			case fl.Changed("max-age-days"):
				if maxAge < 1 || maxAge > api.MaxMaxAgeDays {
					return exitcode.New(exitcode.Usage, "--max-age-days must be between 1 and %d", api.MaxMaxAgeDays)
				}
				p := &maxAge
				in.MaxAgeDays = &p
			case noMaxAge:
				var none *int
				in.MaxAgeDays = &none
			}
			if in.Enabled == nil && in.Schedule == nil && in.KeepLast == nil && in.MaxAgeDays == nil {
				return exitcode.New(exitcode.Usage, "nothing to change; pass --schedule, --keep-last, --max-age-days, --no-max-age, --enable or --disable")
			}
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, true)
			if err != nil {
				return err
			}
			in.EnvironmentID = t.env.ID
			p, err := t.sess.client.PutBackupPolicy(ctx, t.service.ID, in)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(p)
			}
			fmt.Fprintf(a.IO.Out, "%s Saved the backup policy\n", a.IO.OutColor().Green("✓"))
			a.printBackupPolicy(t, p)
			return nil
		},
	}
	f.register(cmd, true)
	cmd.Flags().StringVar(&schedule, "schedule", "", `five-field cron expression in UTC, e.g. "0 3 * * *"`)
	cmd.Flags().IntVar(&keepLast, "keep-last", 0, fmt.Sprintf("scheduled backups to keep (1-%d)", api.MaxKeepLast))
	cmd.Flags().IntVar(&maxAge, "max-age-days", 0, fmt.Sprintf("delete backups older than this many days (1-%d)", api.MaxMaxAgeDays))
	cmd.Flags().BoolVar(&noMaxAge, "no-max-age", false, "keep backups regardless of age")
	cmd.Flags().BoolVar(&enable, "enable", false, "run scheduled backups")
	cmd.Flags().BoolVar(&disable, "disable", false, "stop scheduled backups (manual ones still work)")
	return cmd
}

// -----------------------------------------------------------------------------
// backups restore
// -----------------------------------------------------------------------------

func (a *App) backupsRestoreCmd() *cobra.Command {
	var mode, confirm, slug, environment string
	var skipSafety, wait bool
	var timeout time.Duration
	cmd := &cobra.Command{
		Use:   "restore BACKUP_ID --mode in_place|new_service",
		Short: "Restore a backup in place or into a new database",
		Long: `Restore a succeeded backup.

--mode in_place replaces the data of the backed-up database in its
environment. A safety backup is taken first unless --skip-safety-backup is
given.

--mode new_service adds a new database next to the original, with the
backup's engine and version, fresh credentials and its own volume, and
restores into it once it runs; the original is not touched. --slug names
it (default <slug>-restore-<yyyymmdd>) and --environment picks where it is
added (default the backup's environment). Only a database dump restores
this way; a snapshot restores in place.

You are asked to type the database's slug; in scripts pass it with
--confirm. Restoring needs a recent sign-in, so API tokens cannot restore.
With --wait, follow the restore until it succeeds (exit 0) or fails (exit 1).`,
		Example: `  roundhouse db backups restore bak_01J9Z6Y4M0V8 --mode in_place
  roundhouse db backups restore bak_01J9Z6Y4M0V8 --mode in_place --confirm postgres --wait
  roundhouse db backups restore bak_01J9Z6Y4M0V8 --mode new_service --slug postgres-copy --environment staging`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !slices.Contains(api.RestoreModes, mode) {
				return exitcode.New(exitcode.Usage, "--mode must be in_place or new_service")
			}
			if skipSafety && mode != api.RestoreInPlace {
				return exitcode.New(exitcode.Usage, "--skip-safety-backup applies to --mode in_place only")
			}
			if mode != api.RestoreNewService && (slug != "" || environment != "") {
				return exitcode.New(exitcode.Usage, "--slug and --environment apply to --mode new_service only")
			}
			ctx := cmd.Context()
			sess, err := a.connect()
			if err != nil {
				return err
			}
			c := sess.client
			b, err := c.GetBackup(ctx, args[0])
			if err != nil {
				return err
			}
			if b.Status != api.BackupSucceeded {
				return exitcode.New(exitcode.Conflict, "backup %s is %s; only a succeeded backup can be restored", b.ID, b.Status)
			}
			svc, err := c.GetService(ctx, b.ServiceID)
			if err != nil {
				return err
			}
			in := api.RestoreBackupInput{Mode: mode, Confirm: svc.Slug, SkipSafetyBackup: skipSafety, Slug: slug}
			var env *api.Environment
			if mode == api.RestoreNewService {
				p, err := c.GetProject(ctx, b.ProjectID)
				if err != nil {
					return err
				}
				if env, err = pickEnvironment(p, cmp.Or(environment, b.EnvironmentID)); err != nil {
					return err
				}
				if environment != "" {
					in.TargetEnvironmentID = env.ID
				}
			}
			taken := formatInstant(millis(cmpInt64(b.FinishedAt, b.CreatedAt)))
			warning := fmt.Sprintf("This replaces the data of %s with backup %s from %s.", svc.Name, b.ID, taken)
			switch {
			case mode == api.RestoreNewService:
				name := "a new database"
				if slug != "" {
					name += " " + slug
				}
				warning = fmt.Sprintf("This restores backup %s of %s from %s into %s in %s. %s is not touched.", b.ID, svc.Name, taken, name, env.Name, svc.Name)
			case skipSafety:
				warning += " No safety backup is taken: the current data is lost."
			default:
				warning += " A safety backup of the current data is taken first."
			}
			if err := a.IO.ConfirmTyped(warning, svc.Slug, confirm); err != nil {
				return err
			}
			r, err := c.RestoreBackup(ctx, b.ID, in)
			if err != nil {
				var apiErr *api.Error
				if errors.As(err, &apiErr) && apiErr.Code == "restore_mode_unsupported" {
					return withHint(err, "a snapshot restores in place only: --mode in_place")
				}
				return a.reauthHint(err, "restoring a backup")
			}
			var created *api.Service
			if r.TargetServiceID != nil && r.Mode == api.RestoreNewService {
				// NOTE: best effort; the restore has started either way, and
				// its ID alone still identifies the new service.
				created, _ = c.GetService(ctx, *r.TargetServiceID)
			}
			if !a.jsonOut {
				a.printRestoreStarted(r, svc, created, env)
			}
			if !wait {
				if a.jsonOut {
					return a.printJSON(r)
				}
				return nil
			}
			wctx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()
			err = a.pollUntil(wctx, "Restoring "+svc.Name, func() (bool, string, error) {
				cur, err := c.GetRestore(wctx, r.ID)
				if err != nil {
					return false, "", err
				}
				r = cur
				return r.Status == "succeeded" || r.Status == "failed", r.Status, nil
			})
			if err != nil {
				return a.waitErr(err, timeout, r.ID)
			}
			if a.jsonOut {
				a.printJSON(r)
			}
			if r.Status != "succeeded" {
				if a.jsonOut {
					return exitcode.Silent(exitcode.Error)
				}
				msg := "restore " + r.ID + " failed"
				if r.Error != nil {
					msg += ": " + *r.Error
				}
				return exitcode.New(exitcode.Error, "%s", msg)
			}
			if a.jsonOut {
				return nil
			}
			pal := a.IO.OutColor()
			if created == nil {
				fmt.Fprintf(a.IO.Out, "%s Restore %s succeeded\n", pal.Green("✓"), r.ID)
				return nil
			}
			fmt.Fprintf(a.IO.Out, "%s Restore %s succeeded into %s (%s)\n", pal.Green("✓"), r.ID, created.Name, created.Slug)
			if created.Database != nil {
				if keys := connectionKeys[created.Database.Engine]; len(keys) > 0 {
					fmt.Fprintf(a.IO.Out, "  Reference it from another service:\n    roundhouse vars set '%s=%s' --service <app>\n", keys[0], reference(created.Slug, keys[0]))
				}
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&mode, "mode", "", "in_place or new_service")
	cmd.Flags().StringVar(&confirm, "confirm", "", "the database's slug, to skip the prompt")
	cmd.Flags().BoolVar(&skipSafety, "skip-safety-backup", false, "with --mode in_place, do not back up the current data first")
	cmd.Flags().StringVar(&slug, "slug", "", "with --mode new_service, the new database's slug (default <slug>-restore-<yyyymmdd>)")
	cmd.Flags().StringVarP(&environment, "environment", "e", "", "with --mode new_service, the environment to add it to (default the backup's)")
	cmd.Flags().BoolVarP(&wait, "wait", "w", false, "wait until the restore finishes")
	cmd.Flags().DurationVar(&timeout, "timeout", time.Hour, "with --wait, give up after this long")
	_ = cmd.MarkFlagRequired("mode")
	return cmd
}

func cmpInt64(p *int64, def int64) int64 {
	if p != nil {
		return *p
	}
	return def
}

// printRestoreStarted reports a started restore; created and env are the
// new database and its environment for a new_service restore, created nil
// when it could not be read.
func (a *App) printRestoreStarted(r *api.Restore, svc, created *api.Service, env *api.Environment) {
	how := "in place into " + svc.Name
	if r.Mode == api.RestoreNewService {
		how = "into a new database"
		switch {
		case created != nil:
			how += fmt.Sprintf(" %s (%s)", created.Name, created.Slug)
		case r.TargetServiceID != nil:
			how += " " + *r.TargetServiceID
		}
		if env != nil {
			how += " in " + env.Name
		}
	}
	fmt.Fprintf(a.IO.Out, "%s Started restore %s of %s %s\n", a.IO.OutColor().Green("✓"), r.ID, r.BackupID, how)
	if r.SafetyBackupID != nil {
		fmt.Fprintf(a.IO.Out, "  Safety backup: %s\n", *r.SafetyBackupID)
	}
	if r.Mode == api.RestoreNewService {
		fmt.Fprintf(a.IO.Out, "  %s is not touched. The data is restored once the new database runs.\n", svc.Name)
	}
}

// -----------------------------------------------------------------------------
// backups download
// -----------------------------------------------------------------------------

// downloadResult is the --json output of `backups download`.
type downloadResult struct {
	BackupID string `json:"backup_id"`
	// Path is "-" for stdout.
	Path      string `json:"path"`
	Bytes     int64  `json:"bytes"`
	SHA256    string `json:"sha256"`
	Decrypted bool   `json:"decrypted"`
}

func (a *App) backupsDownloadCmd() *cobra.Command {
	var output string
	var decrypt, force bool
	cmd := &cobra.Command{
		Use:   "download BACKUP_ID",
		Short: "Download a backup, optionally decrypting it",
		Long: `Download a backup's object from object storage and check its SHA-256.

The object is encrypted to the project's backup key. With --decrypt the
key is fetched (this needs a recent sign-in and is audited) and the backup
is decrypted on this machine as it downloads; the key itself is never shown
or saved. The decrypted file is a zstd-compressed RHBK1 archive of the
database's dumps.

The file is written with owner-only permissions (0600) as -o, or under the
backup's own name in the current directory; -o - writes to stdout. An
existing file is only replaced with --force.`,
		Example: `  roundhouse db backups download bak_01J9Z6Y4M0V8
  roundhouse db backups download bak_01J9Z6Y4M0V8 --decrypt -o shop.rhbk.zst
  roundhouse db backups download bak_01J9Z6Y4M0V8 --decrypt -o - | zstd -d > shop.rhbk`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if output == "-" && a.jsonOut {
				return exitcode.New(exitcode.Usage, "--json cannot be combined with -o -")
			}
			ctx := cmd.Context()
			sess, err := a.connect()
			if err != nil {
				return err
			}
			c := sess.client
			var identity *age.X25519Identity
			if decrypt {
				key, err := c.BackupDecryptionKey(ctx, args[0])
				if err != nil {
					return a.reauthHint(err, "decrypting a backup")
				}
				if identity, err = age.ParseX25519Identity(key.Identity); err != nil {
					return exitcode.New(exitcode.Error, "the control plane returned an unusable backup key")
				}
			}
			dl, err := c.BackupDownload(ctx, args[0])
			if err != nil {
				return err
			}
			path, err := a.downloadPath(output, dl.Filename, decrypt)
			if err != nil {
				return err
			}
			if path != "-" && !force {
				if _, err := os.Lstat(path); err == nil {
					return exitcode.New(exitcode.Conflict, "%s already exists; pass --force to replace it, or -o to save elsewhere", path)
				}
			}
			res, err := a.download(ctx, c, dl, path, identity)
			if err != nil {
				return err
			}
			res.BackupID = args[0]
			if a.jsonOut {
				return a.printJSON(res)
			}
			if path == "-" {
				return nil
			}
			what := "encrypted"
			if decrypt {
				what = "decrypted"
			}
			fmt.Fprintf(a.IO.Out, "%s Saved %s to %s (%s, %s, SHA-256 verified)\n", a.IO.OutColor().Green("✓"), res.BackupID, path, formatBytes(float64(res.Bytes)), what)
			if decrypt {
				fmt.Fprintln(a.IO.Out, "  It is a zstd-compressed RHBK1 archive; `zstd -d` decompresses it.")
			} else {
				fmt.Fprintln(a.IO.Out, "  It is encrypted to the project's backup key; pass --decrypt to decrypt it as it downloads.")
			}
			return nil
		},
	}
	cmd.Flags().StringVarP(&output, "output", "o", "", "file to write, or - for stdout (default: the backup's file name)")
	cmd.Flags().BoolVar(&decrypt, "decrypt", false, "decrypt with the project's backup key (needs a recent sign-in)")
	cmd.Flags().BoolVar(&force, "force", false, "replace an existing file")
	return cmd
}

// downloadPath picks where a download goes: -o, else the API's file name
// (without .age once decrypted) in the working directory.
//
// SECURITY: the API's file name is reduced to a plain base name so it can
// never point outside the working directory.
func (a *App) downloadPath(output, filename string, decrypt bool) (string, error) {
	if output == "-" {
		return output, nil
	}
	if output == "" {
		name := filepath.Base(filepath.Clean("/" + strings.ReplaceAll(filename, `\`, "/")))
		if decrypt {
			name = strings.TrimSuffix(name, ".age")
		}
		if name == "" || name == "." || name == "/" || name == ".." || strings.HasPrefix(name, ".") {
			return "", exitcode.New(exitcode.Usage, "the backup has no usable file name; pass -o")
		}
		output = name
	}
	if !filepath.IsAbs(output) {
		output = filepath.Join(a.WorkDir, output)
	}
	return output, nil
}

// download streams the object to path (or stdout), decrypting it with
// identity when set, and checks the stored object's SHA-256. A file is
// written to a temporary name and renamed only once it checks out.
func (a *App) download(ctx context.Context, c *api.Client, dl *api.BackupDownload, path string, identity *age.X25519Identity) (*downloadResult, error) {
	body, _, err := c.OpenObject(ctx, dl.URL)
	if err != nil {
		return nil, err
	}
	defer body.Close()

	var out io.Writer = a.IO.Out
	var tmp *os.File
	if path != "-" {
		// NOTE: CreateTemp makes the file 0600 on Unix; the explicit Chmod
		// keeps that true whatever the umask or platform does.
		if tmp, err = os.CreateTemp(filepath.Dir(path), ".roundhouse-download-*"); err != nil {
			return nil, err
		}
		defer func() {
			if tmp != nil {
				tmp.Close()
				os.Remove(tmp.Name())
			}
		}()
		if err := tmp.Chmod(0o600); err != nil {
			return nil, err
		}
		out = tmp
	}

	hash := sha256.New()
	stored := io.TeeReader(body, hash)
	src := stored
	if identity != nil {
		if src, err = age.Decrypt(stored, identity); err != nil {
			return nil, exitcode.New(exitcode.Error, "cannot decrypt %s: %v", filepath.Base(dl.Filename), err)
		}
	}
	n, err := io.Copy(out, src)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, exitcode.New(exitcode.Error, "download failed: %v; nothing was saved", err)
	}
	// Decryption stops at the end of the age payload; hash whatever follows.
	if _, err := io.Copy(io.Discard, stored); err != nil {
		return nil, exitcode.New(exitcode.Error, "download failed: %v; nothing was saved", err)
	}
	sum := hex.EncodeToString(hash.Sum(nil))
	if dl.SHA256 != nil && !strings.EqualFold(*dl.SHA256, sum) {
		return nil, exitcode.New(exitcode.Error, "the download does not match the backup's SHA-256 (got %s, want %s); nothing was saved", sum, *dl.SHA256)
	}
	if tmp != nil {
		if err := tmp.Close(); err != nil {
			return nil, err
		}
		if err := replaceFile(tmp.Name(), path); err != nil {
			return nil, err
		}
		tmp = nil
	}
	return &downloadResult{Path: path, Bytes: n, SHA256: sum, Decrypted: identity != nil}, nil
}

// replaceFile renames src over dst.
//
// COMPAT: Windows refuses to rename over an existing file, so dst is
// removed first; --force has already allowed replacing it.
func replaceFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	if err := os.Remove(dst); err != nil && !os.IsNotExist(err) {
		return err
	}
	return os.Rename(src, dst)
}
