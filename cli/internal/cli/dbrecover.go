package cli

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// -----------------------------------------------------------------------------
// db volume recover
// -----------------------------------------------------------------------------

func (a *App) dbVolumeRecoverCmd() *cobra.Command {
	var f targetFlags
	var to, backupID, confirm string
	var yes, wait bool
	var timeout time.Duration
	cmd := &cobra.Command{
		Use:   "recover --to SERVER",
		Short: "Rebuild a lost server's volume on another server from the latest backup",
		Long: `Recover the volume of a database (or of --service) in the environment
when its server is lost: offline or removed. The old volume is marked
abandoned, an empty one is created on --to (a server name or ID), the
service is redeployed there, and the latest succeeded backup (or --backup)
is restored into it once it runs.

Everything written after that backup is lost, and no safety backup can be
taken. While the volume's server is online, move the volume instead
(` + "`roundhouse db volume move`" + `), which copies every write.

You are asked to type the service's slug; in scripts pass it with
--confirm, or pass --yes. Recovering needs a recent sign-in, so API tokens
cannot recover volumes. With --wait, follow the restore until it succeeds
(exit 0) or fails (exit 1).`,
		Example: `  roundhouse db volume recover --to edge-2 --wait
  roundhouse db volume recover --service cache --to edge-2 --backup bak_01J9Z6Y4M0V8 --confirm cache`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if to == "" {
				return exitcode.New(exitcode.Usage, "pass --to with the server to recover onto")
			}
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, true)
			if err != nil {
				return err
			}
			v, err := requireVolume(ctx, t)
			if err != nil {
				return err
			}
			if v.NodeID == nil {
				return exitcode.New(exitcode.Conflict, "the volume of %s in %s is on no server yet; deploy the service instead", t.service.Name, t.env.Name)
			}
			c := t.sess.client
			b, err := a.recoveryBackup(ctx, t, backupID)
			if err != nil {
				return err
			}
			targets, err := c.MigrationTargets(ctx, v.ID)
			if err != nil {
				return err
			}
			i := slices.IndexFunc(targets.Targets, func(x api.MigrationTarget) bool {
				return x.NodeID == to || strings.EqualFold(x.Name, to)
			})
			if i < 0 {
				return exitcode.New(exitcode.NotFound, "no server %q in the workspace other than the volume's own", to)
			}
			target := targets.Targets[i]
			if !target.Eligible {
				return exitcode.New(exitcode.Invalid, "%s cannot take the volume: %s", target.Name, cmp.Or(deref(target.Reason), "not eligible"))
			}
			taken := formatInstant(millis(cmpInt64(b.FinishedAt, b.CreatedAt)))
			warning := fmt.Sprintf("This rebuilds the volume of %s in %s on %s from backup %s taken %s. The volume on %s is abandoned, and everything written after the backup is lost.",
				t.service.Name, t.env.Name, target.Name, b.ID, taken, orDash(deref(v.NodeName)))
			confirmed := confirm
			if yes {
				confirmed = t.service.Slug
				a.IO.Warn("everything %s wrote after %s is lost", t.service.Name, taken)
			}
			if err := a.IO.ConfirmTyped(warning, t.service.Slug, confirmed); err != nil {
				return err
			}
			r, err := c.RestoreBackup(ctx, b.ID, api.RestoreBackupInput{Mode: api.RestoreInPlace, Confirm: t.service.Slug, TargetNodeID: target.NodeID})
			if err != nil {
				var apiErr *api.Error
				if errors.As(err, &apiErr) && apiErr.Status == 409 && strings.Contains(apiErr.Message, "Move the volume") {
					return withHint(err, "the volume's server is reachable: `roundhouse db volume move --to "+target.Name+"` copies every write")
				}
				return a.reauthHint(err, "recovering a volume")
			}
			if !wait {
				if a.jsonOut {
					return a.printJSON(r)
				}
				fmt.Fprintf(a.IO.Out, "%s Started recovering the volume of %s in %s onto %s (%s)\n", a.IO.OutColor().Green("✓"), t.service.Name, t.env.Name, target.Name, r.ID)
				fmt.Fprintf(a.IO.Out, "  The backup is restored once %s runs there; pass --wait to follow it.\n", t.service.Name)
				return nil
			}
			wctx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()
			err = a.pollUntil(wctx, "Recovering "+t.service.Name, func() (bool, string, error) {
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
				return exitcode.New(exitcode.Error, "recovery %s failed: %s", r.ID, cmp.Or(deref(r.Error), "unknown error"))
			}
			if !a.jsonOut {
				fmt.Fprintf(a.IO.Out, "%s Recovered the volume of %s in %s onto %s from %s\n", a.IO.OutColor().Green("✓"), t.service.Name, t.env.Name, target.Name, b.ID)
			}
			return nil
		},
	}
	f.register(cmd, true)
	cmd.Flags().StringVar(&to, "to", "", "server name or ID to rebuild the volume on")
	cmd.Flags().StringVar(&backupID, "backup", "", "backup to restore (default the latest succeeded one)")
	cmd.Flags().StringVar(&confirm, "confirm", "", "the service's slug, to skip the prompt")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")
	cmd.Flags().BoolVarP(&wait, "wait", "w", false, "wait until the restore finishes")
	cmd.Flags().DurationVar(&timeout, "timeout", time.Hour, "with --wait, give up after this long")
	return cmd
}

// recoveryBackup returns the named backup, checked to belong to the
// target's service and environment, or the latest succeeded one.
func (a *App) recoveryBackup(ctx context.Context, t *target, id string) (*api.Backup, error) {
	c := t.sess.client
	if id != "" {
		b, err := c.GetBackup(ctx, id)
		if err != nil {
			return nil, err
		}
		if b.ServiceID != t.service.ID || b.EnvironmentID != t.env.ID {
			return nil, exitcode.New(exitcode.Invalid, "backup %s is not of %s in %s", b.ID, t.service.Name, t.env.Name)
		}
		if b.Status != api.BackupSucceeded {
			return nil, exitcode.New(exitcode.Conflict, "backup %s is %s; only a succeeded backup can be restored", b.ID, b.Status)
		}
		return b, nil
	}
	cursor := ""
	for {
		page, err := c.ListBackups(ctx, t.service.ID, t.env.ID, cursor, 100)
		if err != nil {
			return nil, err
		}
		for i := range page.Backups {
			if page.Backups[i].Status == api.BackupSucceeded {
				return &page.Backups[i], nil
			}
		}
		if page.NextCursor == nil {
			return nil, exitcode.New(exitcode.NotFound, "%s has no succeeded backup in %s to recover from", t.service.Name, t.env.Name)
		}
		cursor = *page.NextCursor
	}
}
