package cli

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
	"github.com/spf13/cobra"
)

// serversDrainCmd is `servers drain SERVER`: move a server's replicas off it
// and leave it in maintenance (ADR 0005, "Node lifecycle").
func (a *App) serversDrainCmd() *cobra.Command {
	var workspace string
	var force, yes, status bool
	cmd := &cobra.Command{
		Use:   "drain SERVER",
		Short: "Move a server's replicas elsewhere and put it in maintenance",
		Long: `Drain a server, by name or ID: it takes no new replicas, its stateless
replicas move to other servers (each removed here only once its replacement
is healthy), and it ends in maintenance, safe to reboot. Services with a
volume keep their data on the server and block the drain unless --force
stops them for the maintenance.

--status shows the server's latest drain without starting one. Asks for
confirmation unless --yes is given; in scripts --yes is required.`,
		Example: `  roundhouse servers drain web-1
  roundhouse servers drain web-1 --force --yes
  roundhouse servers drain web-1 --status --json`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.runServerDrain(cmd.Context(), workspace, args[0], force, yes, status)
		},
	}
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "workspace ID, slug or name")
	cmd.Flags().BoolVar(&force, "force", false, "stop services with volumes instead of stopping at them")
	cmd.Flags().BoolVar(&status, "status", false, "show the latest drain instead of starting one")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")
	return cmd
}

// serversResumeCmd is `servers resume SERVER`.
func (a *App) serversResumeCmd() *cobra.Command {
	var workspace string
	cmd := &cobra.Command{
		Use:   "resume SERVER",
		Short: "Take a drained server back into service",
		Long: `Take a draining or maintenance server back into service: it may get new
replicas again (nothing moves back on its own), a running drain stops, and
services a forced drain stopped start again.`,
		Example: `  roundhouse servers resume web-1`,
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.runServerResume(cmd.Context(), workspace, args[0])
		},
	}
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "workspace ID, slug or name")
	return cmd
}

func (a *App) runServerDrain(ctx context.Context, workspace, ref string, force, yes, statusOnly bool) error {
	if !statusOnly && !yes && !a.IO.Interactive() {
		return exitcode.New(exitcode.Usage, "draining a server needs confirmation; pass --yes to drain %s without asking", ref)
	}
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
	n := findNode(nodes, ref)
	if n == nil {
		return exitcode.New(exitcode.NotFound, "no server %q in %s; list them with `roundhouse servers list`", ref, ws.Name)
	}
	if statusOnly {
		d, err := sess.client.GetNodeDrain(ctx, ws.ID, n.ID)
		if err != nil {
			return err
		}
		if a.jsonOut {
			return a.printJSON(d)
		}
		if d == nil {
			fmt.Fprintf(a.IO.Out, "%s has never been drained.\n", n.Name)
			return nil
		}
		a.printDrain(n.Name, d)
		return nil
	}
	if !yes {
		fmt.Fprintf(a.IO.Err, "%s stops taking new replicas; its replicas move to other servers and it ends in maintenance.\n", n.Name)
		ok, err := a.IO.Confirm(fmt.Sprintf("Drain %s (%s)?", n.Name, n.ID), false, "pass --yes")
		if err != nil {
			return err
		}
		if !ok {
			return exitcode.New(exitcode.Error, "drain aborted; nothing was changed")
		}
	}
	d, err := sess.client.DrainNode(ctx, ws.ID, n.ID, force)
	if err != nil {
		return drainHint(err, n.Name)
	}
	if a.jsonOut {
		return a.printJSON(d)
	}
	a.printDrain(n.Name, d)
	if d.Status == api.DrainRunning {
		fmt.Fprintf(a.IO.Err, "Follow it with `roundhouse servers drain %s --status`.\n", n.Name)
	}
	return nil
}

func (a *App) runServerResume(ctx context.Context, workspace, ref string) error {
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
	n := findNode(nodes, ref)
	if n == nil {
		return exitcode.New(exitcode.NotFound, "no server %q in %s; list them with `roundhouse servers list`", ref, ws.Name)
	}
	node, err := sess.client.ResumeNode(ctx, ws.ID, n.ID)
	if err != nil {
		return drainHint(err, n.Name)
	}
	if a.jsonOut {
		return a.printJSON(node)
	}
	fmt.Fprintf(a.IO.Out, "%s %s is back in service\n", a.IO.OutColor().Green("✓"), node.Name)
	return nil
}

// printDrain prints a drain's status, its moves and what blocks it.
func (a *App) printDrain(name string, d *api.NodeDrain) {
	c := a.IO.OutColor()
	status := d.Status
	switch d.Status {
	case api.DrainCompleted:
		status = c.Green("drained: in maintenance, safe to reboot")
	case api.DrainBlocked, api.DrainFailed:
		status = c.Red(d.Status)
	}
	fmt.Fprintf(a.IO.Out, "Drain of %s: %s\n", name, status)
	if d.Error != nil {
		fmt.Fprintf(a.IO.Out, "  %s\n", *d.Error)
	}
	if len(d.Blocked) > 0 {
		names := make([]string, len(d.Blocked))
		for i, b := range d.Blocked {
			names[i] = b.ServiceName
		}
		fmt.Fprintf(a.IO.Out, "Blocked by services with volumes: %s\n", strings.Join(names, ", "))
		fmt.Fprintln(a.IO.Out, "Move each volume to another server, or drain again with --force to stop them.")
	}
	if len(d.Moves) == 0 {
		fmt.Fprintln(a.IO.Out, "No replicas had to move.")
		return
	}
	t := a.newTable("service", "replica", "state", "to", "note")
	for _, m := range d.Moves {
		to, note := "-", ""
		if m.ToNodeID != nil {
			to = *m.ToNodeID
		}
		if m.Error != nil {
			note = *m.Error
		}
		t.row(m.ServiceID, fmt.Sprint(m.Replica), m.State, to, note)
	}
	t.flush()
}

// drainHint words the next step for a refused drain or resume.
func drainHint(err error, name string) error {
	var apiErr *api.Error
	if !errors.As(err, &apiErr) {
		return err
	}
	switch apiErr.Code {
	case api.ErrDrainInProgress:
		return withHint(err, fmt.Sprintf("follow it with `roundhouse servers drain %s --status`", name))
	case api.ErrNodeNotDrainable:
		return withHint(err, "the server has not connected yet; there is nothing to drain")
	case api.ErrNodeNotDraining:
		return withHint(err, fmt.Sprintf("%s is in service; drain it first", name))
	}
	return err
}
