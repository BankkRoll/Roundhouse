package cli

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
	"github.com/BankkRoll/Roundhouse/cli/internal/ui"
)

// -----------------------------------------------------------------------------
// db volume move
// -----------------------------------------------------------------------------

// migrationPhases describe each phase of a volume migration.
var migrationPhases = map[string]string{
	"queued":           "waiting to start",
	"preparing_target": "creating the volume on the target server",
	"stopping":         "stopping the service",
	"copying_out":      "copying the data out of the source server",
	"copying_in":       "copying the data into the target server",
	"starting":         "starting the service on the target server",
	"done":             "the service runs on the target server",
	"rolling_back":     "putting the service back on the source server",
}

func migrationDone(m *api.VolumeMigration) bool {
	return m.Status == api.MigrationSucceeded || m.Status == api.MigrationFailed
}

func (a *App) dbVolumeMoveCmd() *cobra.Command {
	var f targetFlags
	var to, confirm string
	var list, yes, wait bool
	var timeout time.Duration
	cmd := &cobra.Command{
		Use:     "move --to SERVER",
		Aliases: []string{"migrate"},
		Short:   "Move a volume to another server (the service is down during the copy)",
		Long: `Move the volume of a database (or of --service) in the environment to
another server. The service stops, a consistent snapshot of the volume is
copied through the backup bucket into a new volume on --to (a server name
or ID), checked against its SHA-256, and the service is redeployed there.
A failure before the redeploy puts the service back where it was. The
leftover copy and the snapshot are kept for 72 hours.

The service is down for the whole copy. --list-targets shows every server,
why it cannot take the volume when it cannot, and the estimated downtime.

You are asked to type the service's slug; in scripts pass it with
--confirm, or pass --yes. Moving needs a recent sign-in, so API tokens
cannot move volumes. With --wait, follow the move phase by phase until it
succeeds (exit 0) or fails (exit 1).`,
		Example: `  roundhouse db volume move --list-targets
  roundhouse db volume move --to edge-2 --wait
  roundhouse db volume move --service cache --to edge-2 --confirm cache`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if list && to != "" {
				return exitcode.New(exitcode.Usage, "pass either --to or --list-targets, not both")
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
				return exitcode.New(exitcode.Conflict, "the volume of %s in %s is on no server yet; its first deployment places it", t.service.Name, t.env.Name)
			}
			c := t.sess.client
			targets, err := c.MigrationTargets(ctx, v.ID)
			if err != nil {
				return err
			}
			if list {
				if a.jsonOut {
					return a.printJSON(targets)
				}
				a.printMigrationTargets(t, v, targets)
				return nil
			}
			showTargets := func() {
				if !a.jsonOut {
					a.printMigrationTargets(t, v, targets)
				}
			}
			if to == "" {
				showTargets()
				return exitcode.New(exitcode.Usage, "pass --to with an eligible server")
			}
			source := orDash(deref(v.NodeName))
			if to == *v.NodeID || strings.EqualFold(to, source) {
				return exitcode.New(exitcode.Conflict, "the volume of %s is already on %s", t.service.Name, source)
			}
			i := slices.IndexFunc(targets.Targets, func(x api.MigrationTarget) bool {
				return x.NodeID == to || strings.EqualFold(x.Name, to)
			})
			if i < 0 {
				showTargets()
				return exitcode.New(exitcode.NotFound, "no server %q in the workspace", to)
			}
			target := targets.Targets[i]
			if !target.Eligible {
				showTargets()
				return exitcode.New(exitcode.Invalid, "%s cannot take the volume: %s", target.Name, cmp.Or(deref(target.Reason), "not eligible"))
			}
			downtime := formatDuration(time.Duration(targets.EstimatedDowntimeMS) * time.Millisecond)
			warning := fmt.Sprintf("This moves the volume of %s in %s from %s to %s. %s is down for the whole copy, about %s.",
				t.service.Name, t.env.Name, source, target.Name, t.service.Name, downtime)
			confirmed := confirm
			if yes {
				confirmed = t.service.Slug
				a.IO.Warn("%s is down for the whole copy, about %s", t.service.Name, downtime)
			}
			if err := a.IO.ConfirmTyped(warning, t.service.Slug, confirmed); err != nil {
				return err
			}
			m, err := c.MigrateVolume(ctx, v.ID, api.MigrateVolumeInput{TargetNodeID: target.NodeID, Confirm: t.service.Slug})
			if err != nil {
				return a.reauthHint(err, "moving a volume")
			}
			if !wait {
				if a.jsonOut {
					return a.printJSON(m)
				}
				fmt.Fprintf(a.IO.Out, "%s Started moving the volume of %s in %s to %s (%s)\n", a.IO.OutColor().Green("✓"), t.service.Name, t.env.Name, target.Name, m.ID)
				fmt.Fprintf(a.IO.Out, "  Follow it with `roundhouse db volume migrations`, or pass --wait next time.\n")
				return nil
			}
			if !a.jsonOut {
				fmt.Fprintf(a.IO.Out, "Started moving the volume of %s in %s to %s (%s)\n", t.service.Name, t.env.Name, target.Name, m.ID)
			}
			wctx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()
			phase := ""
			err = a.pollSpinning(wctx, "Moving "+t.service.Name, func(spin *ui.Spinner) (bool, string, error) {
				cur, err := c.GetVolumeMigration(wctx, m.ID)
				if err != nil {
					return false, "", err
				}
				m = cur
				if m.Phase != phase && !a.jsonOut {
					phase = m.Phase
					spin.Println(a.IO.Out, fmt.Sprintf("  %-16s %s", m.Phase, migrationPhases[m.Phase]))
				}
				return migrationDone(m), m.Phase, nil
			})
			if err != nil {
				return a.waitErr(err, timeout, m.ID)
			}
			if a.jsonOut {
				a.printJSON(m)
			}
			if m.Status != api.MigrationSucceeded {
				if a.jsonOut {
					return exitcode.Silent(exitcode.Error)
				}
				return exitcode.New(exitcode.Error, "volume migration %s failed: %s", m.ID, cmp.Or(deref(m.Error), "unknown error"))
			}
			if !a.jsonOut {
				took := ""
				if m.StartedAt != nil && m.FinishedAt != nil {
					took = " in " + formatDuration(time.Duration(*m.FinishedAt-*m.StartedAt)*time.Millisecond)
				}
				fmt.Fprintf(a.IO.Out, "%s Moved the volume of %s in %s to %s%s\n", a.IO.OutColor().Green("✓"), t.service.Name, t.env.Name, target.Name, took)
			}
			return nil
		},
	}
	f.register(cmd, true)
	cmd.Flags().StringVar(&to, "to", "", "server name or ID to move the volume to")
	cmd.Flags().BoolVar(&list, "list-targets", false, "list the servers the volume can move to, and the estimated downtime")
	cmd.Flags().StringVar(&confirm, "confirm", "", "the service's slug, to skip the prompt")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")
	cmd.Flags().BoolVarP(&wait, "wait", "w", false, "wait until the move finishes, printing each phase")
	cmd.Flags().DurationVar(&timeout, "timeout", 2*time.Hour, "with --wait, give up after this long")
	return cmd
}

func (a *App) printMigrationTargets(t *target, v *api.Volume, mt *api.MigrationTargets) {
	fmt.Fprintf(a.IO.Out, "Servers the volume of %s in %s can move to (now on %s)\n", a.IO.OutColor().Bold(t.service.Name), t.env.Name, orDash(deref(v.NodeName)))
	if len(mt.Targets) == 0 {
		fmt.Fprintln(a.IO.Out, "No other servers; add one with `roundhouse servers add`.")
		return
	}
	tb := a.newTable("server", "id", "eligible", "quota", "reason")
	for _, x := range mt.Targets {
		eligible := "yes"
		if !x.Eligible {
			eligible = "no"
		}
		tb.row(x.Name, x.NodeID, eligible, orDash(deref(x.QuotaMode)), orDash(deref(x.Reason)))
	}
	tb.flush()
	fmt.Fprintf(a.IO.Out, "Estimated downtime: about %s; the service is down for the whole copy.\n",
		formatDuration(time.Duration(mt.EstimatedDowntimeMS)*time.Millisecond))
}

// -----------------------------------------------------------------------------
// db volume migrations
// -----------------------------------------------------------------------------

func (a *App) dbVolumeMigrationsCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:   "migrations",
		Short: "List a volume's recent moves between servers",
		Example: `  roundhouse db volume migrations
  roundhouse db volume migrations --service cache --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, true)
			if err != nil {
				return err
			}
			v, err := requireVolume(ctx, t)
			if err != nil {
				return err
			}
			c := t.sess.client
			list, err := c.VolumeMigrations(ctx, v.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(list)
			}
			if len(list.Migrations) == 0 {
				fmt.Fprintf(a.IO.Out, "The volume of %s in %s has never moved. Move it with `roundhouse db volume move --to SERVER`.\n", t.service.Name, t.env.Name)
				return nil
			}
			names := map[string]string{}
			if v.NodeID != nil && v.NodeName != nil {
				names[*v.NodeID] = *v.NodeName
			}
			// NOTE: only to name servers; without the list, IDs are shown.
			if targets, err := c.MigrationTargets(ctx, v.ID); err == nil {
				for _, x := range targets.Targets {
					names[x.NodeID] = x.Name
				}
			}
			node := func(id *string) string {
				if id == nil {
					return "-"
				}
				return cmp.Or(names[*id], *id)
			}
			pal := a.IO.OutColor()
			tb := a.newTable("id", "status", "phase", "from", "to", "copied", "created")
			var failed []api.VolumeMigration
			for _, m := range list.Migrations {
				copied := "-"
				if m.CopiedBytes != nil {
					copied = formatBytes(*m.CopiedBytes)
				}
				tb.row(m.ID, m.Status, m.Phase, node(m.SourceNodeID), node(m.TargetNodeID), copied, ago(a.Now(), m.CreatedAt))
				if m.Status == api.MigrationFailed && m.Error != nil {
					failed = append(failed, m)
				}
			}
			tb.flush()
			for _, m := range failed {
				fmt.Fprintf(a.IO.Out, "%s %s: %s\n", pal.Red("failed"), m.ID, *m.Error)
			}
			return nil
		},
	}
	f.register(cmd, true)
	return cmd
}

// -----------------------------------------------------------------------------
// db tcp-proxy
// -----------------------------------------------------------------------------

func (a *App) dbTCPProxyCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:     "tcp-proxy",
		Aliases: []string{"tcp"},
		Short:   "Show, publish or stop publishing a database's TCP port",
		Long: `Show the TCP proxy of a database (or of --service) in the environment:
its public endpoint, status and source allowlist. "enable" publishes the
service's port on its server behind an allowlist; every other source is
dropped on the server. "disable" stops publishing it. Off by default.`,
		Example: `  roundhouse db tcp-proxy
  roundhouse db tcp-proxy enable --allow 203.0.113.7 --allow 198.51.100.0/24
  roundhouse db tcp-proxy disable --environment staging --yes`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error { return a.showTCPProxy(cmd.Context(), f) },
	}
	f.register(cmd, true)
	cmd.AddCommand(a.dbTCPProxyShowCmd(), a.dbTCPProxyEnableCmd(), a.dbTCPProxyDisableCmd())
	return cmd
}

func (a *App) dbTCPProxyShowCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:     "show",
		Short:   "Show a database's TCP proxy",
		Example: `  roundhouse db tcp-proxy show --service cache --json`,
		Args:    noArgs,
		RunE:    func(cmd *cobra.Command, _ []string) error { return a.showTCPProxy(cmd.Context(), f) },
	}
	f.register(cmd, true)
	return cmd
}

// tcpProxyOf returns the target's TCP proxy, or nil when it has none.
func tcpProxyOf(ctx context.Context, t *target) (*api.TCPProxy, error) {
	p, err := t.sess.client.TCPProxy(ctx, t.service.ID, t.env.ID)
	if api.IsStatus(err, http.StatusNotFound) {
		return nil, nil
	}
	return p, err
}

func (a *App) showTCPProxy(ctx context.Context, f targetFlags) error {
	t, err := a.resolveDatabase(ctx, f, true)
	if err != nil {
		return err
	}
	p, err := tcpProxyOf(ctx, t)
	if err != nil {
		return err
	}
	if a.jsonOut {
		return a.printJSON(p)
	}
	if p == nil {
		fmt.Fprintf(a.IO.Out, "%s publishes no TCP port in %s; it is reachable on the private network only.\n", t.service.Name, t.env.Name)
		fmt.Fprintln(a.IO.Out, "  Publish it with `roundhouse db tcp-proxy enable --allow ADDRESS`.")
		return nil
	}
	fmt.Fprintf(a.IO.Out, "TCP proxy of %s in %s\n", a.IO.OutColor().Bold(t.service.Name), t.env.Name)
	a.printTCPProxyRows(p)
	return nil
}

func (a *App) printTCPProxyRows(p *api.TCPProxy) {
	pal := a.IO.OutColor()
	row := func(k, v string) { fmt.Fprintf(a.IO.Out, "  %-10s %s\n", k, v) }
	if p.Host != nil {
		row("Endpoint", net.JoinHostPort(*p.Host, strconv.Itoa(p.PublicPort)))
	} else {
		row("Endpoint", fmt.Sprintf("port %d on the service's server, once it is placed", p.PublicPort))
	}
	switch p.Status {
	case api.TCPProxyActive:
		row("Status", pal.Green(p.Status))
	case api.TCPProxyPending:
		row("Status", pal.Yellow(p.Status)+"; published once the service is placed and deployed")
	case api.TCPProxyUnsupported:
		row("Status", pal.Red(p.Status)+"; the server's agent cannot enforce an allowlist, so nothing is published until it is upgraded")
	default:
		row("Status", p.Status)
	}
	row("Forwards", fmt.Sprintf("%d → container port %d", p.PublicPort, p.ContainerPort))
	row("Allowed", strings.Join(p.AllowedCIDRs, ", "))
	if p.OpenToAll {
		row("Warning", pal.Red("open to every address on the internet, and unencrypted unless the client and the database negotiate TLS"))
	}
}

// parseAllowlist checks --allow entries: IPv4 or IPv6 addresses or CIDR
// blocks. open reports an entry that admits every address.
func parseAllowlist(entries []string) (cidrs []string, open bool, err error) {
	for _, raw := range entries {
		e := strings.TrimSpace(raw)
		if _, err := netip.ParseAddr(e); err == nil {
			cidrs = append(cidrs, e)
			continue
		}
		p, err := netip.ParsePrefix(e)
		if err != nil {
			return nil, false, exitcode.New(exitcode.Usage, "--allow %q is not an IP address or CIDR block, e.g. 203.0.113.7 or 198.51.100.0/24", raw)
		}
		open = open || p.Bits() == 0
		cidrs = append(cidrs, e)
	}
	return cidrs, open, nil
}

func (a *App) dbTCPProxyEnableCmd() *cobra.Command {
	var f targetFlags
	var allow []string
	var allowOpen bool
	var port int
	cmd := &cobra.Command{
		Use:     "enable --allow ADDRESS",
		Aliases: []string{"set", "publish"},
		Short:   "Publish a database's TCP port behind a source allowlist",
		Long: `Publish the service's TCP port on its server, reachable from the sources
--allow names: IPv4 or IPv6 addresses or CIDR blocks, repeatable. Every
other source is dropped on the server. Run it again to replace the
allowlist; that applies in place, while first publishing the port recreates
the container once. --port picks the container port (default the
service's port). The service must run one replica.

0.0.0.0/0 (or ::/0) would admit the whole internet, so it is refused unless
--allow-open is given; --allow-open alone admits every address. The
traffic is not encrypted unless the client and the database negotiate TLS.

Publishing needs a recent sign-in, so API tokens cannot publish ports.`,
		Example: `  roundhouse db tcp-proxy enable --allow 203.0.113.7
  roundhouse db tcp-proxy enable --allow 198.51.100.0/24 --allow 203.0.113.7 --environment staging
  roundhouse db tcp-proxy enable --allow-open`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cidrs, open, err := parseAllowlist(allow)
			if err != nil {
				return err
			}
			switch {
			case len(cidrs) == 0 && !allowOpen:
				return exitcode.New(exitcode.Usage, "pass --allow with each address or CIDR block that may connect, e.g. --allow 203.0.113.7")
			case open && !allowOpen:
				return exitcode.New(exitcode.Usage, "an allowlist with a /0 block admits every address on the internet; pass --allow-open as well to publish it anyway")
			case allowOpen && len(cidrs) == 0:
				cidrs, open = []string{"0.0.0.0/0"}, true
			case allowOpen && !open:
				return exitcode.New(exitcode.Usage, "--allow-open admits every address; pass it alone, or with --allow 0.0.0.0/0")
			case len(cidrs) > api.MaxTCPProxyCIDRs:
				return exitcode.New(exitcode.Usage, "at most %d --allow entries", api.MaxTCPProxyCIDRs)
			}
			if cmd.Flags().Changed("port") && (port < 1 || port > 65535) {
				return exitcode.New(exitcode.Usage, "--port must be between 1 and 65535")
			}
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, true)
			if err != nil {
				return err
			}
			if open {
				a.IO.Warn("%s's port in %s will be reachable from the entire internet. The connection is unencrypted unless the client and the database negotiate TLS, and its password is all that keeps others out.", t.service.Name, t.env.Name)
			}
			p, err := t.sess.client.PutTCPProxy(ctx, t.service.ID, api.PutTCPProxyInput{
				EnvironmentID: t.env.ID, ContainerPort: port, AllowedCIDRs: cidrs, AcknowledgeOpen: open,
			})
			if err != nil {
				var apiErr *api.Error
				if errors.As(err, &apiErr) && apiErr.Code == "confirmation_required" {
					return withHint(err, "pass --allow-open to admit every address")
				}
				return a.reauthHint(err, "publishing a TCP port")
			}
			if a.jsonOut {
				return a.printJSON(p)
			}
			fmt.Fprintf(a.IO.Out, "%s Published the TCP port of %s in %s\n", a.IO.OutColor().Green("✓"), t.service.Name, t.env.Name)
			a.printTCPProxyRows(p)
			return nil
		},
	}
	f.register(cmd, true)
	cmd.Flags().StringArrayVar(&allow, "allow", nil, "IP address or CIDR block that may connect, repeatable")
	cmd.Flags().BoolVar(&allowOpen, "allow-open", false, "admit every address on the internet (0.0.0.0/0)")
	cmd.Flags().IntVar(&port, "port", 0, "container port to publish (default: the service's port)")
	return cmd
}

func (a *App) dbTCPProxyDisableCmd() *cobra.Command {
	var f targetFlags
	var yes bool
	cmd := &cobra.Command{
		Use:     "disable",
		Aliases: []string{"rm", "remove"},
		Short:   "Stop publishing a database's TCP port",
		Example: `  roundhouse db tcp-proxy disable
  roundhouse db tcp-proxy disable --service cache --environment staging --yes`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, true)
			if err != nil {
				return err
			}
			p, err := tcpProxyOf(ctx, t)
			if err != nil {
				return err
			}
			if p == nil {
				return exitcode.New(exitcode.NotFound, "%s publishes no TCP port in %s", t.service.Name, t.env.Name)
			}
			if !yes {
				ok, err := a.IO.Confirm(fmt.Sprintf("Stop publishing port %d of %s in %s? Clients outside the private network lose access.", p.PublicPort, t.service.Name, t.env.Name), false, "pass --yes")
				if err != nil {
					return err
				}
				if !ok {
					return exitcode.New(exitcode.Error, "disable aborted; nothing was changed")
				}
			}
			if err := t.sess.client.DeleteTCPProxy(ctx, t.service.ID, t.env.ID); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(map[string]string{"disabled": p.ID, "service_id": t.service.ID, "environment_id": t.env.ID})
			}
			fmt.Fprintf(a.IO.Out, "%s Stopped publishing the TCP port of %s in %s\n", a.IO.OutColor().Green("✓"), t.service.Name, t.env.Name)
			return nil
		},
	}
	f.register(cmd, true)
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")
	return cmd
}

// -----------------------------------------------------------------------------
// db rotate-credentials
// -----------------------------------------------------------------------------

func (a *App) dbRotateCredentialsCmd() *cobra.Command {
	var f targetFlags
	var principals []string
	var confirm string
	var yes bool
	cmd := &cobra.Command{
		Use:   "rotate-credentials",
		Short: "Generate new database passwords and redeploy everything using them",
		Long: `Rotate a database's passwords in the environment: new ones are generated,
set in the database, stored as write-only secret variables in a change set,
and the database and every service using them are redeployed. Until those
deployments finish, connections that still use the old passwords fail.

--principal picks which to rotate (admin, app, readonly; repeatable);
every one the engine has by default. No password is ever shown.

You are asked to type the database's slug; in scripts pass it with
--confirm, or pass --yes. Rotating needs a recent sign-in, so API tokens
cannot rotate. A rotation that was interrupted (status running) is
finished by running the command again.`,
		Example: `  roundhouse db rotate-credentials
  roundhouse db rotate-credentials --principal app --principal readonly --yes
  roundhouse db rotate-credentials --service cache --environment staging --confirm cache`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var picked []string
			for _, p := range principals {
				p = strings.ToLower(strings.TrimSpace(p))
				if !slices.Contains(api.DatabasePrincipals, p) {
					return exitcode.New(exitcode.Usage, "unknown --principal %q; use admin, app or readonly", p)
				}
				if !slices.Contains(picked, p) {
					picked = append(picked, p)
				}
			}
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, false)
			if err != nil {
				return err
			}
			which := "every password"
			if len(picked) > 0 {
				which = "the " + strings.Join(picked, ", ") + " " + map[bool]string{true: "password", false: "passwords"}[len(picked) == 1]
			}
			warning := fmt.Sprintf("This rotates %s of %s in %s and redeploys %s and every service using them. Connections with the old passwords fail until those deployments finish.",
				which, t.service.Name, t.env.Name, t.service.Name)
			confirmed := confirm
			if yes {
				confirmed = t.service.Slug
			}
			if err := a.IO.ConfirmTyped(warning, t.service.Slug, confirmed); err != nil {
				return err
			}
			r, err := t.sess.client.RotateCredentials(ctx, t.service.ID, api.RotateCredentialsInput{
				EnvironmentID: t.env.ID, Principals: picked, Confirm: t.service.Slug,
			})
			if err != nil {
				var apiErr *api.Error
				if errors.As(err, &apiErr) && apiErr.Status >= http.StatusBadGateway {
					return withHint(err, "the rotation may be left unfinished; run the same command again to finish it")
				}
				return a.reauthHint(err, "rotating credentials")
			}
			if a.jsonOut {
				a.printJSON(r)
				if r.Status != api.RotationSucceeded {
					return exitcode.Silent(exitcode.Error)
				}
				return nil
			}
			return a.printRotation(t, r)
		},
	}
	f.register(cmd, true)
	cmd.Flags().StringArrayVar(&principals, "principal", nil, "admin, app or readonly, repeatable (default: every one the engine has)")
	cmd.Flags().StringVar(&confirm, "confirm", "", "the database's slug, to skip the prompt")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")
	return cmd
}

func (a *App) printRotation(t *target, r *api.CredentialRotation) error {
	pal := a.IO.OutColor()
	row := func(k, v string) { fmt.Fprintf(a.IO.Out, "  %-12s %s\n", k, v) }
	switch r.Status {
	case api.RotationSucceeded:
		fmt.Fprintf(a.IO.Out, "%s Rotated the credentials of %s in %s (%s)\n", pal.Green("✓"), t.service.Name, t.env.Name, r.ID)
	default:
		fmt.Fprintf(a.IO.Out, "Rotation %s of %s in %s is %s\n", r.ID, t.service.Name, t.env.Name, pal.Status(r.Status))
	}
	row("Principals", orDash(strings.Join(r.Principals, ", ")))
	row("Applied", orDash(strings.Join(r.Applied, ", ")))
	if r.ChangeSetID != nil {
		row("Change set", *r.ChangeSetID)
	}
	if len(r.DeploymentIDs) > 0 {
		row("Deploying", strings.Join(r.DeploymentIDs, ", "))
		fmt.Fprintf(a.IO.Out, "  Follow them with `roundhouse logs --deployment %s -f`.\n", r.DeploymentIDs[0])
	}
	if r.Status == api.RotationSucceeded {
		return nil
	}
	msg := "rotation " + r.ID + " " + r.Status
	if r.Error != nil {
		msg += ": " + *r.Error
	}
	err := exitcode.New(exitcode.Error, "%s", msg)
	if r.Status == api.RotationRunning || len(r.Applied) > 0 {
		return withHint(err, "the database may already use new passwords; run `roundhouse db rotate-credentials` again to finish the rotation")
	}
	return err
}

// -----------------------------------------------------------------------------
// db rotations
// -----------------------------------------------------------------------------

func (a *App) dbRotationsCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:   "rotations",
		Short: "List a database's recent credential rotations",
		Example: `  roundhouse db rotations
  roundhouse db rotations --service cache --environment staging --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, false)
			if err != nil {
				return err
			}
			list, err := t.sess.client.CredentialRotations(ctx, t.service.ID, t.env.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(list)
			}
			if len(list.Rotations) == 0 {
				fmt.Fprintf(a.IO.Out, "The credentials of %s in %s were never rotated. Rotate them with `roundhouse db rotate-credentials`.\n", t.service.Name, t.env.Name)
				return nil
			}
			pal := a.IO.OutColor()
			tb := a.newTable("id", "status", "principals", "applied", "deployments", "created")
			var failed []api.CredentialRotation
			running := false
			for _, r := range list.Rotations {
				tb.row(r.ID, r.Status, orDash(strings.Join(r.Principals, ",")), orDash(strings.Join(r.Applied, ",")),
					strconv.Itoa(len(r.DeploymentIDs)), ago(a.Now(), r.CreatedAt))
				if r.Status == api.RotationFailed && r.Error != nil {
					failed = append(failed, r)
				}
				running = running || r.Status == api.RotationRunning
			}
			tb.flush()
			for _, r := range failed {
				fmt.Fprintf(a.IO.Out, "%s %s: %s\n", pal.Red("failed"), r.ID, *r.Error)
			}
			if running {
				fmt.Fprintf(a.IO.Err, "%s a rotation is unfinished; run `roundhouse db rotate-credentials` again to finish it\n", a.IO.ErrColor().Dim("note:"))
			}
			return nil
		},
	}
	f.register(cmd, true)
	return cmd
}
