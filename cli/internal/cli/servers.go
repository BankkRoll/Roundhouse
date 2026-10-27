package cli

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// -----------------------------------------------------------------------------
// servers remove
// -----------------------------------------------------------------------------

func (a *App) serversRemoveCmd() *cobra.Command {
	var workspace string
	var keepServer, yes bool
	cmd := &cobra.Command{
		Use:     "remove SERVER",
		Aliases: []string{"rm", "delete"},
		Short:   "Remove a server from the workspace",
		Long: `Remove a server by name or ID. Its agent's credential is revoked and its
connection closed, so nothing more is scheduled on it.

For a server Roundhouse provisioned on a cloud provider, the cloud server is
deleted too, with everything on it, unless --keep-server is given; it then
keeps running (and billing) until you delete it in the provider's console.
A server joined by hand is never touched; uninstall the agent there yourself.

Asks for confirmation unless --yes is given; in scripts --yes is required.`,
		Example: `  roundhouse servers remove web-1
  roundhouse servers remove web-1 --keep-server
  roundhouse servers remove node_01J9Z6Y4M0V8 --yes --json`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.runServerRemove(cmd.Context(), workspace, args[0], keepServer, yes)
		},
	}
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "workspace ID, slug or name")
	cmd.Flags().BoolVar(&keepServer, "keep-server", false, "for a provisioned server, leave the cloud server running")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")
	return cmd
}

func (a *App) runServerRemove(ctx context.Context, workspace, ref string, keepServer, yes bool) error {
	if !yes && !a.IO.Interactive() {
		return exitcode.New(exitcode.Usage, "removing a server needs confirmation; pass --yes to remove %s without asking", ref)
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
	managed := n.ProviderServerID != nil
	deletes := managed && !keepServer
	if !yes {
		c := a.IO.ErrColor()
		switch {
		case deletes:
			fmt.Fprintf(a.IO.Err, "%s\n", c.Red(fmt.Sprintf(
				"%s was provisioned on %s: removing it also deletes cloud server %s and everything on it. Pass --keep-server to keep the cloud server.",
				n.Name, n.Provider, *n.ProviderServerID)))
		case managed:
			fmt.Fprintf(a.IO.Err, "Cloud server %s on %s keeps running, and billing, until you delete it in the %s console.\n",
				*n.ProviderServerID, n.Provider, n.Provider)
		default:
			fmt.Fprintf(a.IO.Err, "The machine itself is not touched; uninstall the agent on it yourself.\n")
		}
		ok, err := a.IO.Confirm(fmt.Sprintf("Remove server %s (%s) from %s?", n.Name, n.ID, ws.Name), false, "pass --yes")
		if err != nil {
			return err
		}
		if !ok {
			return exitcode.New(exitcode.Error, "remove aborted; nothing was changed")
		}
	}
	if err := sess.client.RemoveNode(ctx, ws.ID, n.ID, keepServer); err != nil {
		return removeHint(err, n)
	}
	if a.jsonOut {
		return a.printJSON(map[string]any{"removed": n.ID, "server_deleted": deletes})
	}
	ok := a.IO.OutColor().Green("✓")
	switch {
	case deletes:
		fmt.Fprintf(a.IO.Out, "%s Removed %s and deleted cloud server %s on %s\n", ok, n.Name, *n.ProviderServerID, n.Provider)
	case managed:
		fmt.Fprintf(a.IO.Out, "%s Removed %s; cloud server %s on %s is still running\n", ok, n.Name, *n.ProviderServerID, n.Provider)
	default:
		fmt.Fprintf(a.IO.Out, "%s Removed %s\n", ok, n.Name)
	}
	return nil
}

// findNode picks a server by ID, else by name (names are unique per workspace).
func findNode(nodes []api.Node, ref string) *api.Node {
	if i := slices.IndexFunc(nodes, func(n api.Node) bool { return n.ID == ref }); i >= 0 {
		return &nodes[i]
	}
	if i := slices.IndexFunc(nodes, func(n api.Node) bool { return n.Name == ref }); i >= 0 {
		return &nodes[i]
	}
	return nil
}

// removeHint words the next step for a refused remove: the API deletes the
// cloud server first and keeps the node when that fails, so the way out is
// fixing the provider connection or keeping the server.
func removeHint(err error, n *api.Node) error {
	var apiErr *api.Error
	if !errors.As(err, &apiErr) || n.ProviderServerID == nil {
		return err
	}
	keep := fmt.Sprintf("or pass --keep-server to remove %s and delete the cloud server yourself", n.Name)
	switch {
	case apiErr.Code == "provider_not_connected":
		return withHint(err, "the cloud server can only be deleted with the workspace's "+n.Provider+" token; reconnect it in the dashboard (Servers → Add server → Cloud provider), "+keep)
	case apiErr.Code == "provider_token_invalid" || apiErr.Code == "provider_read_only":
		return withHint(err, "the stored "+n.Provider+" token cannot delete servers; connect a read-write one in the dashboard, "+keep)
	case apiErr.Code == "conflict":
		return withHint(err, keep)
	case apiErr.Status == http.StatusTooManyRequests || apiErr.Status >= 500:
		return withHint(err, "the server is still listed; retry in a minute, "+keep)
	}
	return err
}

// -----------------------------------------------------------------------------
// servers cancel
// -----------------------------------------------------------------------------

func (a *App) serversCancelCmd() *cobra.Command {
	var workspace string
	var noWait bool
	cmd := &cobra.Command{
		Use:   "cancel PROVISION_ID",
		Short: "Cancel a cloud server that is still being provisioned",
		Long: `Cancel a provisioning run started with "servers add --provider" (its ID is
printed when it starts, e.g. prov_01J9Z6Y4M0V8). The run's join token is
revoked and any server it created is deleted.

A server that is still being created is deleted as soon as the provider
reports it; the command waits for that unless --no-wait is given. A server
that already joined is a normal server now: use "servers remove" instead.`,
		Example: `  roundhouse servers cancel prov_01J9Z6Y4M0V8
  roundhouse servers cancel prov_01J9Z6Y4M0V8 --no-wait --json`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			sess, err := a.connect()
			if err != nil {
				return err
			}
			ws, err := a.findWorkspace(ctx, sess.client, workspace)
			if err != nil {
				return err
			}
			p, err := sess.client.CancelNodeProvision(ctx, ws.ID, args[0])
			if err != nil {
				var apiErr *api.Error
				if errors.As(err, &apiErr) && apiErr.Status == http.StatusConflict {
					return withHint(err, "a server that joined is removed with `roundhouse servers remove NAME`")
				}
				return err
			}
			if !api.IsProvisionFinished(p.Status) && !noWait {
				if p, err = a.watchProvision(ctx, sess.client, ws.ID, p); err != nil {
					return err
				}
			}
			return a.reportCancel(p)
		},
	}
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "workspace ID, slug or name")
	cmd.Flags().BoolVar(&noWait, "no-wait", false, "return once the cancel is requested, without waiting for the server to be deleted")
	return cmd
}

// reportCancel prints a cancelled run. A run whose server could not be
// deleted is [exitcode.ProvisionFailed], since it may still bill.
func (a *App) reportCancel(p *api.NodeProvision) error {
	if a.jsonOut {
		writeJSON(a.IO.Out, p)
	}
	server := "its server"
	if p.ServerID != nil {
		server = "server " + *p.ServerID
	}
	switch p.Status {
	case api.ProvisionCancelled:
		if !a.jsonOut {
			fmt.Fprintf(a.IO.Out, "%s Cancelled %s (%s)", a.IO.OutColor().Green("✓"), p.Name, p.ID)
			if p.ServerID != nil {
				fmt.Fprintf(a.IO.Out, "; deleted %s", server)
			}
			fmt.Fprintln(a.IO.Out)
		}
		return nil
	case api.ProvisionCleanupFailed:
		a.IO.Warn("%s could not be deleted and may still exist and bill; delete it in the %s console", server, p.Provider)
		return exitcode.New(exitcode.ProvisionFailed, "cancelled %s, but deleting %s failed: %s", p.Name, server, deref(p.FailureMessage))
	case api.ProvisionJoined, api.ProvisionFailed:
		return exitcode.New(exitcode.Conflict, "%s %s before it could be cancelled", p.Name, p.Status)
	}
	if !a.jsonOut {
		fmt.Fprintf(a.IO.Out, "Cancelling %s (%s): %s is deleted as soon as the provider has created it\n", p.Name, p.ID, server)
	}
	return nil
}

// -----------------------------------------------------------------------------
// Cost estimates
// -----------------------------------------------------------------------------

var currencySymbols = map[string]string{"EUR": "€", "USD": "$", "GBP": "£"}

// formatMoney renders minor units with the currency's symbol when it has a
// common one, e.g. "€4.51", else its code, e.g. "4.51 CHF".
func formatMoney(cents int, currency string) string {
	amount := fmt.Sprintf("%d.%02d", cents/100, cents%100)
	if sym, ok := currencySymbols[strings.ToUpper(currency)]; ok {
		return sym + amount
	}
	return amount + " " + currency
}

// estimateLabel is a node's monthly estimate, e.g. "≈ €4.51/mo", or "-".
func estimateLabel(c *api.CostEstimate) string {
	if c == nil {
		return "-"
	}
	return "≈ " + formatMoney(c.MonthlyCents, c.Currency) + "/mo"
}

// estimateTotals sums the estimates per currency, in first-seen order.
func estimateTotals(nodes []api.Node) []string {
	var order []string
	sums := map[string]int{}
	for _, n := range nodes {
		if c := n.EstimatedMonthlyCost; c != nil {
			if _, ok := sums[c.Currency]; !ok {
				order = append(order, c.Currency)
			}
			sums[c.Currency] += c.MonthlyCents
		}
	}
	out := make([]string, len(order))
	for i, cur := range order {
		out[i] = estimateLabel(&api.CostEstimate{MonthlyCents: sums[cur], Currency: cur})
	}
	return out
}

// -----------------------------------------------------------------------------
// Hints
// -----------------------------------------------------------------------------

// hintedError carries a hint worded for one command, ahead of the generic
// ones in [App.errorHint].
type hintedError struct {
	error
	hint string
}

func (e *hintedError) Unwrap() error { return e.error }

func withHint(err error, hint string) error { return &hintedError{error: err, hint: hint} }

// -----------------------------------------------------------------------------
// servers label
// -----------------------------------------------------------------------------

// maxNodeLabels is the most labels a server may carry, as the API enforces.
const maxNodeLabels = 16

// nodeLabelKey and nodeLabelValue mirror LabelKey and LabelValue in
// apps/api/src/routes/nodes.ts, so a bad label fails before any request.
var (
	nodeLabelKey   = regexp.MustCompile(`^[a-z0-9]([a-z0-9._/-]{0,61}[a-z0-9])?$`)
	nodeLabelValue = regexp.MustCompile(`^([A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)?$`)
)

// formatLabels renders labels as sorted key=value pairs, e.g.
// "builder=fork, zone=eu".
func formatLabels(labels map[string]string) string {
	pairs := make([]string, 0, len(labels))
	for _, k := range slices.Sorted(maps.Keys(labels)) {
		pairs = append(pairs, sanitizeCell(k, 63)+"="+sanitizeCell(labels[k], 63))
	}
	return strings.Join(pairs, ", ")
}

// applyLabelChanges returns current with sets (key=value arguments) applied
// and removes deleted, or a usage error naming the first bad argument.
func applyLabelChanges(current map[string]string, sets, removes []string) (map[string]string, error) {
	next := maps.Clone(current)
	if next == nil {
		next = map[string]string{}
	}
	setKeys := map[string]bool{}
	for _, arg := range sets {
		k, v, ok := strings.Cut(arg, "=")
		switch {
		case !ok:
			return nil, exitcode.New(exitcode.Usage, "invalid label %q: expected key=value; remove a label with --remove key", arg)
		case !nodeLabelKey.MatchString(k):
			return nil, exitcode.New(exitcode.Usage, "invalid label key %q: up to 63 lowercase letters, digits, '.', '_', '-' and '/', starting and ending with a letter or digit", k)
		case !nodeLabelValue.MatchString(v):
			return nil, exitcode.New(exitcode.Usage, "invalid value for label %s: up to 63 letters, digits, '.', '_' and '-', starting and ending with a letter or digit, or empty", k)
		case setKeys[k]:
			return nil, exitcode.New(exitcode.Usage, "label %s is given twice", k)
		}
		setKeys[k] = true
		next[k] = v
	}
	for _, k := range removes {
		if setKeys[k] {
			return nil, exitcode.New(exitcode.Usage, "label %s is both set and removed", k)
		}
		delete(next, k)
	}
	if len(next) > maxNodeLabels {
		return nil, exitcode.New(exitcode.Usage, "a server can have at most %d labels; this would leave %d", maxNodeLabels, len(next))
	}
	return next, nil
}

func (a *App) serversLabelCmd() *cobra.Command {
	var workspace string
	var removes []string
	cmd := &cobra.Command{
		Use:   "label SERVER [KEY=VALUE ...]",
		Short: "Show or change a server's labels",
		Long: `Show a server's labels, or set and remove some. Labels are what placement
selectors and a project's preview build node selector match, e.g.
builder=fork for the servers that may build pull requests from forks.

KEY=VALUE adds or changes a label; --remove KEY (repeatable) drops one.
Other labels are kept. Changing labels never moves running workloads; new
placements and builds match the new set. Keys are lowercase letters, digits,
'.', '_', '-' and '/'; values letters, digits, '.', '_' and '-', or empty.
A server has at most 16 labels.`,
		Example: `  roundhouse servers label web-1
  roundhouse servers label build-1 builder=fork zone=eu
  roundhouse servers label build-1 --remove builder --json`,
		Args: minArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
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
			if len(args) > 1 || len(removes) > 0 {
				next, err := applyLabelChanges(n.Labels, args[1:], removes)
				if err != nil {
					return err
				}
				for _, k := range removes {
					if _, ok := n.Labels[k]; !ok {
						a.IO.Warn("%s has no label %s", n.Name, k)
					}
				}
				if !maps.Equal(next, n.Labels) {
					if n, err = sess.client.SetNodeLabels(ctx, ws.ID, n.ID, next); err != nil {
						return err
					}
				}
			}
			if a.jsonOut {
				return a.printJSON(n)
			}
			if len(n.Labels) == 0 {
				fmt.Fprintf(a.IO.Out, "%s has no labels\n", n.Name)
				return nil
			}
			tb := a.newTable("key", "value")
			for _, k := range slices.Sorted(maps.Keys(n.Labels)) {
				tb.row(sanitizeCell(k, 63), orDash(sanitizeCell(n.Labels[k], 63)))
			}
			tb.flush()
			return nil
		},
	}
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "workspace ID, slug or name")
	cmd.Flags().StringSliceVar(&removes, "remove", nil, "remove the label with this key (repeatable)")
	return cmd
}
