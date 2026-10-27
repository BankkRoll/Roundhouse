package cli

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
	"github.com/BankkRoll/Roundhouse/cli/internal/ui"
)

// meshTurnOn says where the mesh is switched on. It is an instance setting,
// which the CLI deliberately does not change: it affects every workspace.
const meshTurnOn = "an instance admin turns it on in the dashboard (Settings → Platform → Network) " +
	"or with PATCH /v1/instance/settings {\"mesh_enabled\": true}"

// -----------------------------------------------------------------------------
// servers mesh
// -----------------------------------------------------------------------------

func (a *App) serversMeshCmd() *cobra.Command {
	var workspace string
	cmd := &cobra.Command{
		Use:     "mesh",
		Aliases: []string{"network"},
		Short:   "Show the private network between servers",
		Long: `Show the WireGuard mesh that links the workspace's servers: each server's
mesh address, how it runs WireGuard, whether it is reachable directly or
behind NAT, and whether it is ready; then every pair of servers, whether
they talk directly, through a relay server, or not at all, and when their
tunnel last completed a handshake.

The mesh is an instance setting: ` + meshTurnOn + `.
Servers whose agent predates the mesh are listed as unsupported and stay
single-server hosts until the agent is upgraded.`,
		Example: `  roundhouse servers mesh
  roundhouse servers mesh --json | jq '.pairs[] | select(.path == "down")'
  roundhouse servers mesh rotate-key web-1`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			sess, err := a.connect()
			if err != nil {
				return err
			}
			ws, err := a.findWorkspace(ctx, sess.client, workspace)
			if err != nil {
				return err
			}
			m, err := sess.client.GetMesh(ctx, ws.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(m)
			}
			a.printMesh(ws.Name, m)
			return nil
		},
	}
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "workspace ID, slug or name")
	cmd.AddCommand(a.meshRotateKeyCmd())
	return cmd
}

func (a *App) printMesh(workspace string, m *api.Mesh) {
	c := a.IO.OutColor()
	if !m.Enabled {
		fmt.Fprintf(a.IO.Out, "The private network between servers is off (supernet %s).\n", m.Supernet)
		fmt.Fprintf(a.IO.Out, "To use it, %s.\n", meshTurnOn)
		return
	}
	fmt.Fprintf(a.IO.Out, "Private network: %s, supernet %s\n\n", c.Green("on"), m.Supernet)
	if len(m.Nodes) == 0 {
		fmt.Fprintf(a.IO.Out, "No servers in %s. Add one with `roundhouse servers add`.\n", workspace)
		return
	}

	// Colour codes would skew tabwriter's widths, so the coloured column is
	// always the last one.
	t := a.newTable("name", "address", "mode", "nat", "endpoint", "notes", "ready")
	unsupported := 0
	for _, n := range m.Nodes {
		if !n.Supported {
			unsupported++
		}
		t.row(n.Name, orDash(deref(n.Address)), orDash(deref(n.Mode)), orDash(deref(n.NAT)),
			orDash(deref(n.Endpoint)), meshNotes(n), meshReadiness(c, n))
	}
	t.flush()
	if unsupported > 0 {
		fmt.Fprintf(a.IO.Out, "\n%s an agent without mesh support; upgrade the agent to join the network.\n",
			plural(unsupported, "server runs", "servers run"))
	}

	fmt.Fprintln(a.IO.Out)
	if len(m.Pairs) == 0 {
		fmt.Fprintln(a.IO.Out, "No tunnels yet: they appear once two servers have joined.")
		return
	}
	names := make(map[string]string, len(m.Nodes))
	for _, n := range m.Nodes {
		names[n.ID] = n.Name
	}
	name := func(id string) string { return cmp.Or(names[id], id) }
	t = a.newTable("servers", "last handshake", "path")
	for _, p := range m.Pairs {
		handshake := "never"
		if p.LastHandshakeAt != nil {
			handshake = ago(a.Now(), *p.LastHandshakeAt)
		}
		t.row(name(p.Nodes[0])+" <-> "+name(p.Nodes[1]), handshake, meshPath(c, p, name))
	}
	t.flush()
}

// meshNotes lists what else matters about a server: that it relays for
// others, is mid-rotation, or is not online.
func meshNotes(n api.MeshNode) string {
	var notes []string
	if n.Relay {
		notes = append(notes, "relay")
	}
	if n.Rotating {
		notes = append(notes, "rotating key")
	}
	if n.Status != "online" {
		notes = append(notes, n.Status)
	}
	return orDash(strings.Join(notes, ", "))
}

func meshReadiness(c ui.Palette, n api.MeshNode) string {
	switch {
	case !n.Supported:
		return c.Dim("unsupported agent")
	case n.MeshIndex == nil:
		return c.Yellow("not joined")
	case n.Ready:
		return c.Green("ready")
	case n.Error != nil && *n.Error != "":
		return c.Red("not ready: " + *n.Error)
	default:
		return c.Red("not ready")
	}
}

func meshPath(c ui.Palette, p api.MeshPair, name func(string) string) string {
	switch p.Path {
	case api.MeshPathDirect:
		return c.Green(p.Path)
	case api.MeshPathRelayed:
		if p.RelayNodeID != nil {
			return c.Yellow("relayed via " + name(*p.RelayNodeID))
		}
		return c.Yellow(p.Path)
	default:
		return c.Red(p.Path)
	}
}

// -----------------------------------------------------------------------------
// servers mesh rotate-key
// -----------------------------------------------------------------------------

func (a *App) meshRotateKeyCmd() *cobra.Command {
	var workspace string
	var yes bool
	cmd := &cobra.Command{
		Use:   "rotate-key SERVER",
		Short: "Rotate a server's WireGuard key",
		Long: `Rotate the WireGuard key of a server, by name or ID. The server generates a
new key (the private key never leaves it), its peers switch to the new one,
then the server does. Tunnels to the server pause for about two seconds.

One server rotates at a time. Asks for confirmation unless --yes is given;
in scripts --yes is required.`,
		Example: `  roundhouse servers mesh rotate-key web-1
  roundhouse servers mesh rotate-key node_01J9Z6Y4M0V8 --yes --json`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.runMeshRotateKey(cmd.Context(), workspace, args[0], yes)
		},
	}
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "workspace ID, slug or name")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")
	return cmd
}

func (a *App) runMeshRotateKey(ctx context.Context, workspace, ref string, yes bool) error {
	if !yes && !a.IO.Interactive() {
		return exitcode.New(exitcode.Usage, "rotating a key needs confirmation; pass --yes to rotate the key of %s without asking", ref)
	}
	sess, err := a.connect()
	if err != nil {
		return err
	}
	ws, err := a.findWorkspace(ctx, sess.client, workspace)
	if err != nil {
		return err
	}
	m, err := sess.client.GetMesh(ctx, ws.ID)
	if err != nil {
		return err
	}
	n := findMeshNode(m.Nodes, ref)
	if n == nil {
		return exitcode.New(exitcode.NotFound, "no server %q in %s; list them with `roundhouse servers mesh`", ref, ws.Name)
	}
	if !yes {
		fmt.Fprintf(a.IO.Err, "%s gets a new WireGuard key; tunnels to it pause for about two seconds.\n", n.Name)
		ok, err := a.IO.Confirm(fmt.Sprintf("Rotate the WireGuard key of %s (%s)?", n.Name, n.ID), false, "pass --yes")
		if err != nil {
			return err
		}
		if !ok {
			return exitcode.New(exitcode.Error, "rotation aborted; nothing was changed")
		}
	}
	rotated, err := sess.client.RotateMeshKey(ctx, ws.ID, n.ID)
	if err != nil {
		return rotateHint(err, m, n)
	}
	if a.jsonOut {
		return a.printJSON(rotated)
	}
	fmt.Fprintf(a.IO.Out, "%s Started rotating the WireGuard key of %s; tunnels to it pause for about two seconds\n",
		a.IO.OutColor().Green("✓"), rotated.Name)
	fmt.Fprintln(a.IO.Err, "Follow it with `roundhouse servers mesh`; the server is marked \"rotating key\" until it finishes.")
	return nil
}

// findMeshNode picks a mesh server by ID, else by name (names are unique per
// workspace).
func findMeshNode(nodes []api.MeshNode, ref string) *api.MeshNode {
	if i := slices.IndexFunc(nodes, func(n api.MeshNode) bool { return n.ID == ref }); i >= 0 {
		return &nodes[i]
	}
	if i := slices.IndexFunc(nodes, func(n api.MeshNode) bool { return n.Name == ref }); i >= 0 {
		return &nodes[i]
	}
	return nil
}

// rotateHint words the next step for a refused rotation, using the mesh as
// it was read just before.
func rotateHint(err error, m *api.Mesh, n *api.MeshNode) error {
	var apiErr *api.Error
	if !errors.As(err, &apiErr) {
		return err
	}
	switch apiErr.Code {
	case api.ErrMeshRotationInProgress:
		return withHint(err, "one server rotates at a time; wait until `roundhouse servers mesh` no longer shows \"rotating key\", then retry")
	case api.ErrMeshNotJoined:
		switch {
		case !m.Enabled:
			return withHint(err, "the private network is off; "+meshTurnOn)
		case !n.Supported:
			return withHint(err, "the agent on "+n.Name+" predates the private network; upgrade it, then retry once the server has joined")
		default:
			return withHint(err, n.Name+" has not joined the private network yet; check its state with `roundhouse servers mesh`")
		}
	}
	return err
}
