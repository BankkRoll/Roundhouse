package cli

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// -----------------------------------------------------------------------------
// open and domain
// -----------------------------------------------------------------------------

func (a *App) openCmd() *cobra.Command {
	var f targetFlags
	var dashboard bool
	cmd := &cobra.Command{
		Use:   "open",
		Short: "Open the service's URL or the dashboard in a browser",
		Long: `Open the linked service's public URL, or with --dashboard its page in
the web dashboard (the project's page when no service is linked).`,
		Example: `  roundhouse open
  roundhouse open --dashboard
  roundhouse open --service web --environment staging`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolve(ctx, f, serviceOptional)
			if err != nil {
				return err
			}
			serviceID := ""
			if t.service != nil {
				serviceID = t.service.ID
			}
			url := dashboardURL(t.sess.url, t.project.WorkspaceID, t.project.ID, serviceID)
			if !dashboard {
				if t.service == nil {
					if t.service, err = a.chooseService(t.project); err != nil {
						return err
					}
				}
				domains, err := t.sess.client.ListDomains(ctx, t.service.ID, t.env.ID)
				if err != nil {
					return err
				}
				if len(domains) == 0 {
					return exitcode.New(exitcode.NotFound, "%s has no domain in %s; enable a generated domain in its settings, or use --dashboard", t.service.Name, t.env.Name)
				}
				url = domains[0].URL
			}
			if a.jsonOut {
				return a.printJSON(map[string]string{"url": url})
			}
			fmt.Fprintln(a.IO.Out, url)
			if !a.IO.StdoutTTY() {
				return nil
			}
			if err := a.OpenURL(url); err != nil {
				a.IO.Warn("could not open a browser: %v", err)
			}
			return nil
		},
	}
	f.register(cmd, true)
	cmd.Flags().BoolVar(&dashboard, "dashboard", false, "open the dashboard instead of the service URL")
	return cmd
}

func (a *App) domainCmd() *cobra.Command {
	var f targetFlags
	var all bool
	cmd := &cobra.Command{
		Use:     "domain",
		Aliases: []string{"domains"},
		Short:   "List and manage the service's domains",
		Long: `List the domains routed to the linked service in its environment, or in
every environment with --all. The subcommands add your own hostnames, check
their DNS, set their HSTS policy and remove them.`,
		Example: `  roundhouse domain
  roundhouse domain --all --json
  roundhouse domain add shop.example.com
  roundhouse domain verify shop.example.com --wait
  roundhouse domain hsts shop.example.com --max-age 2y`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return a.runDomainList(cmd.Context(), f, all)
		},
	}
	f.register(cmd, true)
	cmd.Flags().BoolVar(&all, "all", false, "list domains in every environment")
	cmd.AddCommand(a.domainListCmd(), a.domainAddCmd(), a.domainVerifyCmd(), a.domainHSTSCmd(), a.domainRemoveCmd())
	return cmd
}

// -----------------------------------------------------------------------------
// servers
// -----------------------------------------------------------------------------

func (a *App) serversCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "servers",
		Aliases: []string{"server", "nodes"},
		Short:   "List, add, label and remove servers, and show their usage",
		Example: `  roundhouse servers list
  roundhouse servers add
  roundhouse servers remove web-1`,
		Args: noArgs,
	}
	var workspace string
	list := &cobra.Command{
		Use:   "list",
		Short: "List the workspace's servers",
		Example: `  roundhouse servers list
  roundhouse servers list --workspace acme --json`,
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
			nodes, err := sess.client.ListNodes(ctx, ws.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(nodes)
			}
			if len(nodes) == 0 {
				fmt.Fprintf(a.IO.Out, "No servers in %s. Add one with `roundhouse servers add`.\n", ws.Name)
				return nil
			}
			t := a.newTable("name", "id", "provider", "ip", "arch", "agent", "labels", "est. cost", "last seen", "status")
			for _, n := range nodes {
				seen := "-"
				if n.LastHeartbeatAt != nil {
					seen = ago(a.Now(), *n.LastHeartbeatAt)
				}
				t.row(n.Name, n.ID, orDash(n.Provider), orDash(deref(n.PublicIP)), orDash(deref(n.Arch)), orDash(deref(n.AgentVersion)), orDash(formatLabels(n.Labels)), estimateLabel(n.EstimatedMonthlyCost), seen, a.IO.OutColor().Status(n.Status))
			}
			t.flush()
			if totals := estimateTotals(nodes); len(totals) > 0 {
				fmt.Fprintf(a.IO.Out, "\nEstimated total: %s (provider catalogue prices; your bill may differ)\n", strings.Join(totals, " + "))
			}
			return nil
		},
	}
	list.Flags().StringVarP(&workspace, "workspace", "w", "", "workspace ID, slug or name")

	var addWorkspace string
	var pf provisionFlags
	add := &cobra.Command{
		Use:   "add",
		Short: "Add a server: print an install command, or provision one in the cloud",
		Long: `Without --provider, create a single-use join token and print the
one-line command that installs the agent on a new server and joins it to the
workspace. Run the command on the server as root. The token expires if unused.

With --provider, create a cloud server on a provider connected to the
workspace; it installs the agent and joins on first boot. Without --plan or
--region the provider's recommended offer is used. The command waits until
the server joins unless --no-wait is given. Connect a provider in the
dashboard first (Servers → Add server → Cloud provider): the CLI never
handles provider tokens. Provisioning needs a recent "roundhouse login";
API tokens cannot provision.`,
		Example: `  roundhouse servers add
  roundhouse servers add --workspace acme --json | jq -r .install_command
  roundhouse servers add --provider hetzner
  roundhouse servers add --provider hetzner --plan cx23 --region fsn1 --name web-1
  roundhouse servers add --provider digitalocean --builder --no-wait --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if pf.provider == "" {
				for _, name := range []string{"plan", "region", "name", "builder", "no-wait"} {
					if cmd.Flags().Changed(name) {
						return exitcode.New(exitcode.Usage, "--%s needs --provider", name)
					}
				}
			} else if err := pf.validate(); err != nil {
				return err
			}
			ctx := cmd.Context()
			sess, err := a.connect()
			if err != nil {
				return err
			}
			ws, err := a.findWorkspace(ctx, sess.client, addWorkspace)
			if err != nil {
				return err
			}
			if pf.provider != "" {
				return a.provisionServer(ctx, sess.client, ws, pf)
			}
			tok, err := sess.client.CreateJoinToken(ctx, ws.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(tok)
			}
			c := a.IO.OutColor()
			expires := millis(tok.ExpiresAt).Sub(a.Now()).Round(time.Minute)
			fmt.Fprintf(a.IO.Err, "Run this on the new server as root (the token is single-use and expires in %s):\n\n", expires)
			fmt.Fprintln(a.IO.Out, c.Bold(tok.InstallCommand))
			return nil
		},
	}
	add.Flags().StringVarP(&addWorkspace, "workspace", "w", "", "workspace ID, slug or name")
	pf.register(add)
	cmd.AddCommand(list, add, a.serversMetricsCmd(), a.serversRemoveCmd(), a.serversCancelCmd(), a.serversLabelCmd())
	return cmd
}

// provisionFlags are the `servers add` flags that provision a cloud server.
type provisionFlags struct {
	provider, plan, region, name string
	builder, noWait              bool
}

func (f *provisionFlags) register(cmd *cobra.Command) {
	cmd.Flags().StringVar(&f.provider, "provider", "", "provision on this connected cloud provider: "+strings.Join(api.ProviderIDs, ", "))
	cmd.Flags().StringVar(&f.plan, "plan", "", "with --provider, the provider's plan, e.g. cx23 (default: the recommended one)")
	cmd.Flags().StringVar(&f.region, "region", "", "with --provider, the provider's region, e.g. fsn1 (default: the recommended one)")
	cmd.Flags().StringVar(&f.name, "name", "", "with --provider, the server's name, a lowercase DNS label (default: server-<random>)")
	cmd.Flags().BoolVar(&f.builder, "builder", false, "with --provider, size and use the server for builds")
	cmd.Flags().BoolVar(&f.noWait, "no-wait", false, "with --provider, return once provisioning starts instead of waiting for the server to join")
}

var (
	serverNameRE   = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	planOrRegionRE = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
)

// validate checks the flags as the API would, so a typo fails before any
// request, and fills in a generated name when none was given.
func (f *provisionFlags) validate() error {
	if !slices.Contains(api.ProviderIDs, f.provider) {
		return exitcode.New(exitcode.Usage, "unknown provider %q; use one of %s", f.provider, strings.Join(api.ProviderIDs, ", "))
	}
	if f.plan != "" && !planOrRegionRE.MatchString(f.plan) {
		return exitcode.New(exitcode.Usage, "invalid --plan %q", f.plan)
	}
	if f.region != "" && !planOrRegionRE.MatchString(f.region) {
		return exitcode.New(exitcode.Usage, "invalid --region %q", f.region)
	}
	if f.name == "" {
		f.name = randomServerName()
	} else if !serverNameRE.MatchString(f.name) {
		return exitcode.New(exitcode.Usage, "invalid --name %q: use 1-63 lowercase letters, digits or hyphens, not starting or ending with a hyphen", f.name)
	}
	return nil
}

// randomServerName returns "server-" and four random lowercase letters or
// digits.
func randomServerName() string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return "server-" + string(b)
}

// provisionServer runs `servers add --provider`: it checks the provider is
// connected, picks an offer when --plan or --region is missing, starts the
// run and, unless --no-wait, waits for the server to join.
func (a *App) provisionServer(ctx context.Context, c *api.Client, ws *api.Membership, f provisionFlags) error {
	integrations, err := c.ListIntegrations(ctx, ws.ID)
	if err != nil {
		return err
	}
	display, connected := f.provider, false
	for _, in := range integrations {
		if in.Provider == f.provider {
			display, connected = in.DisplayName, in.Connected
		}
	}
	if !connected {
		// Shaped like the API's own 409 so --json and the hint match the
		// error a later call would get.
		return &api.Error{Status: http.StatusConflict, Code: "provider_not_connected",
			Message: fmt.Sprintf("%s is not connected to workspace %s", display, ws.Name)}
	}

	if f.plan == "" || f.region == "" {
		role := "node"
		if f.builder {
			role = "builder"
		}
		offers, err := c.ProviderOffers(ctx, ws.ID, f.provider, role, f.region)
		if err != nil {
			return err
		}
		o, reason := pickOffer(offers, f.plan, f.region)
		if o == nil {
			return exitcode.New(exitcode.NotFound, "%s has no %s offer%s", display, role, offerFilter(f.plan, f.region))
		}
		f.plan, f.region = o.Plan, o.Region
		fmt.Fprintf(a.IO.Err, "Using %s\n", describeOffer(o, reason))
	}

	p, err := c.ProvisionNode(ctx, ws.ID, api.ProvisionNodeInput{
		Provider: f.provider, Plan: f.plan, Region: f.region, Name: f.name, Builder: f.builder,
	})
	if err != nil {
		return err
	}
	fmt.Fprintf(a.IO.Err, "Provisioning %s (%s in %s) on %s\n", p.Name, p.Plan, p.Region, display)
	if f.noWait {
		if a.jsonOut {
			return a.printJSON(p)
		}
		fmt.Fprintf(a.IO.Out, "Started %s; %s joins %s on first boot\n", p.ID, p.Name, ws.Name)
		a.IO.Info("Cancel it with: roundhouse servers cancel %s", p.ID)
		return nil
	}
	id := p.ID
	if p, err = a.watchProvision(ctx, c, ws.ID, p); err != nil {
		if errors.Is(err, context.Canceled) {
			// NOTE: Ctrl-C only stops watching; the server is still being
			// created, and bills, until it is cancelled or removed.
			a.IO.Info("\nProvisioning continues in the background. To cancel it and delete the server:\n  roundhouse servers cancel %s", id)
		}
		return err
	}
	return a.reportProvision(p)
}

// pickOffer returns the first recommended offer matching plan and region
// (each ignored when empty) with the recommendation's reason, or else the
// first matching offer that is not deprecated.
func pickOffer(offers *api.ProviderOffers, plan, region string) (*api.ProviderOffer, string) {
	matches := func(o *api.ProviderOffer) bool {
		return o != nil && (plan == "" || o.Plan == plan) && (region == "" || o.Region == region)
	}
	for _, r := range offers.Recommendations {
		if o := offers.Offer(r.OfferID); matches(o) {
			return o, r.Reason
		}
	}
	for i := range offers.Offers {
		if o := &offers.Offers[i]; matches(o) && !o.Deprecated {
			return o, ""
		}
	}
	return nil, ""
}

func offerFilter(plan, region string) string {
	switch {
	case plan != "" && region != "":
		return fmt.Sprintf(" for plan %s in %s", plan, region)
	case plan != "":
		return " for plan " + plan
	case region != "":
		return " in " + region
	}
	return ""
}

func describeOffer(o *api.ProviderOffer, reason string) string {
	s := fmt.Sprintf("%s in %s (%s): %d vCPU, %s GiB RAM, %d GB disk, %s, %.2f %s/month",
		o.Plan, o.Region, o.RegionName, o.VCPUs, strconv.FormatFloat(float64(o.MemoryMiB)/1024, 'f', -1, 64),
		o.DiskGB, o.Arch, float64(o.MonthlyCents)/100, o.Currency)
	if reason != "" {
		s += " — " + reason
	}
	return s
}

// watchProvision polls a provisioning run until it finishes, printing each
// status or step change to stderr.
func (a *App) watchProvision(ctx context.Context, c *api.Client, workspaceID string, p *api.NodeProvision) (*api.NodeProvision, error) {
	spin := a.IO.StartSpinner("Waiting for " + p.Name)
	defer spin.Stop()
	pal := a.IO.ErrColor()
	last := ""
	failures := 0
	for {
		if key := p.Status + "/" + deref(p.Step); key != last {
			last = key
			line := p.Status
			if p.Step != nil {
				line += " (" + *p.Step + ")"
			}
			spin.Println(a.IO.Err, fmt.Sprintf("  %s  %s", pal.Dim(millis(p.UpdatedAt).Local().Format("15:04:05")), line))
			spin.Update(fmt.Sprintf("%s is %s", p.Name, p.Status))
		}
		if api.IsProvisionFinished(p.Status) {
			return p, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(a.PollInterval):
		}
		next, err := c.GetNodeProvision(ctx, workspaceID, p.ID)
		switch {
		case err == nil:
			failures = 0
			p = next
		case ctx.Err() != nil:
			return nil, ctx.Err()
		default:
			var netErr *api.NetworkError
			if !errors.As(err, &netErr) || failures >= maxPollFailures {
				return nil, err
			}
			failures++
		}
	}
}

// reportProvision prints a finished run and returns
// [exitcode.ProvisionFailed] unless the server joined.
func (a *App) reportProvision(p *api.NodeProvision) error {
	if a.jsonOut {
		writeJSON(a.IO.Out, p)
	} else if p.Status == api.ProvisionJoined {
		fmt.Fprintf(a.IO.Out, "%s %s joined as %s", a.IO.OutColor().Green("✓"), p.Name, deref(p.NodeID))
		if p.IPv4 != nil {
			fmt.Fprintf(a.IO.Out, " (%s)", *p.IPv4)
		}
		fmt.Fprintln(a.IO.Out)
	}
	if p.Status == api.ProvisionJoined {
		return nil
	}
	reason := deref(p.FailureMessage)
	if code := deref(p.FailureReason); code != "" && reason != "" {
		reason = code + ": " + reason
	} else if reason == "" {
		reason = code
	}
	if reason == "" {
		reason = "no reason recorded"
	}
	if p.Status == api.ProvisionCleanupFailed {
		server := "the server"
		if p.ServerID != nil {
			server = "server " + *p.ServerID
		}
		a.IO.Warn("%s could not be deleted and may still exist and bill; delete it in the %s console", server, p.Provider)
	}
	return exitcode.New(exitcode.ProvisionFailed, "provisioning %s %s: %s", p.Name, p.Status, reason)
}

// -----------------------------------------------------------------------------
// projects
// -----------------------------------------------------------------------------

func (a *App) projectsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "projects",
		Aliases: []string{"project"},
		Short:   "List, create and delete projects",
		Example: `  roundhouse projects list
  roundhouse projects create shop
  roundhouse projects delete shop`,
		Args: noArgs,
	}

	var listWorkspace string
	list := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List projects in your workspaces",
		Example: `  roundhouse projects list
  roundhouse projects list --workspace acme --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			sess, err := a.connect()
			if err != nil {
				return err
			}
			me, err := sess.client.Me(ctx)
			if err != nil {
				return err
			}
			projects := []api.Project{}
			wsName := map[string]string{}
			for _, ws := range me.Workspaces {
				if listWorkspace != "" && !matchRef(listWorkspace, ws.ID, ws.Slug, ws.Name) {
					continue
				}
				wsName[ws.ID] = ws.Name
				ps, err := sess.client.ListProjects(ctx, ws.ID)
				if err != nil {
					return err
				}
				projects = append(projects, ps...)
			}
			if listWorkspace != "" && len(wsName) == 0 {
				return exitcode.New(exitcode.NotFound, "no workspace %q among yours", listWorkspace)
			}
			if a.jsonOut {
				return a.printJSON(projects)
			}
			if len(projects) == 0 {
				fmt.Fprintln(a.IO.Out, "No projects. Create one with `roundhouse init`.")
				return nil
			}
			linked := ""
			if l, _ := a.loadLink(); l != nil {
				linked = l.ProjectID
			}
			t := a.newTable("", "name", "slug", "workspace", "id")
			for _, p := range projects {
				mark := " "
				if p.ID == linked {
					mark = "*"
				}
				t.row(mark, p.Name, p.Slug, wsName[p.WorkspaceID], p.ID)
			}
			t.flush()
			return nil
		},
	}
	list.Flags().StringVarP(&listWorkspace, "workspace", "w", "", "only this workspace (ID, slug or name)")

	var createWorkspace, slug, description string
	create := &cobra.Command{
		Use:   "create NAME",
		Short: "Create a project",
		Long:  `Create a project with a production environment. To also link the current directory, use "roundhouse init".`,
		Example: `  roundhouse projects create shop
  roundhouse projects create "Internal tools" --slug tools --workspace acme`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			sess, err := a.connect()
			if err != nil {
				return err
			}
			ws, err := a.findWorkspace(ctx, sess.client, createWorkspace)
			if err != nil {
				return err
			}
			p, err := sess.client.CreateProject(ctx, ws.ID, api.CreateProjectInput{Name: args[0], Slug: slug, Description: description})
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(p)
			}
			fmt.Fprintf(a.IO.Out, "%s Created project %s (slug %s, %s) in %s\n", a.IO.OutColor().Green("✓"), p.Name, p.Slug, p.ID, ws.Name)
			return nil
		},
	}
	create.Flags().StringVarP(&createWorkspace, "workspace", "w", "", "workspace ID, slug or name")
	create.Flags().StringVar(&slug, "slug", "", "URL slug (default: derived from the name; -2, -3… is added when taken)")
	create.Flags().StringVar(&description, "description", "", "project description")

	var confirm string
	del := &cobra.Command{
		Use:     "delete PROJECT",
		Aliases: []string{"rm"},
		Short:   "Delete a project and all its services",
		Long: `Delete a project: every service's workloads are removed from your
servers. You are asked to type the project's slug; in scripts pass it with
--confirm.`,
		Example: `  roundhouse projects delete shop
  roundhouse projects delete prj_01J9Z6Y4M0V8 --confirm shop`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			sess, err := a.connect()
			if err != nil {
				return err
			}
			p, err := a.findProject(ctx, sess.client, args[0])
			if err != nil {
				return err
			}
			warning := fmt.Sprintf("This deletes project %s and removes %s from your servers.", p.Name, plural(len(p.Services), "service", "services"))
			if err := a.IO.ConfirmTyped(warning, p.Slug, confirm); err != nil {
				return err
			}
			if err := sess.client.DeleteProject(ctx, p.ID); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(map[string]string{"deleted": p.ID})
			}
			fmt.Fprintf(a.IO.Out, "Deleted project %s\n", p.Name)
			return nil
		},
	}
	del.Flags().StringVar(&confirm, "confirm", "", "the project's slug, to skip the prompt")

	cmd.AddCommand(list, create, del)
	return cmd
}

// -----------------------------------------------------------------------------
// services
// -----------------------------------------------------------------------------

func (a *App) servicesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "services",
		Aliases: []string{"service"},
		Short:   "List, create and delete services",
		Example: `  roundhouse services list
  roundhouse services create web --image nginx:1.27
  roundhouse services delete web`,
		Args: noArgs,
	}

	var lf targetFlags
	list := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the project's services",
		Example: `  roundhouse services list
  roundhouse services list --project shop --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			t, err := a.resolve(cmd.Context(), lf, serviceOptional)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(t.project.Services)
			}
			if len(t.project.Services) == 0 {
				fmt.Fprintf(a.IO.Out, "No services in %s. Create one with `roundhouse services create`.\n", t.project.Name)
				return nil
			}
			tb := a.newTable("", "name", "slug", "kind", "id")
			for _, s := range t.project.Services {
				mark := " "
				if t.service != nil && s.ID == t.service.ID {
					mark = "*"
				}
				tb.row(mark, s.Name, s.Slug, s.Kind, s.ID)
			}
			tb.flush()
			return nil
		},
	}
	lf.register(list, false)

	var cf targetFlags
	var image, repo, branch, rootDir, kind, slug, schedule, timezone string
	var port int
	create := &cobra.Command{
		Use:   "create NAME (--image IMAGE | --repo URL)",
		Short: "Create a service from an image or a git repository",
		Long: `Create a service in the linked project, in every environment. It is not
deployed until you run "roundhouse deploy". A cron service (--kind cron) needs
--schedule; it runs its image to completion on that schedule once deployed.`,
		Example: `  roundhouse services create web --image nginx:1.27 --port 80
  roundhouse services create api --repo https://github.com/acme/api --branch main
  roundhouse services create worker --repo https://github.com/acme/mono --root-dir apps/worker
  roundhouse services create nightly --kind cron --image ghcr.io/acme/report:1 --schedule "0 3 * * *" --timezone Europe/Berlin`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var src api.ServiceSource
			switch {
			case image != "" && repo != "":
				return exitcode.New(exitcode.Usage, "pass either --image or --repo, not both")
			case image != "":
				src = api.ServiceSource{Type: "image", Image: image}
			case repo != "":
				src = api.ServiceSource{Type: "git", RepoURL: repo, Branch: branch, RootDir: rootDir}
			default:
				return exitcode.New(exitcode.Usage, "pass --image or --repo")
			}
			isCron := kind == api.ServiceKindCron
			switch {
			case isCron && schedule == "":
				return exitcode.New(exitcode.Usage, "a cron service needs --schedule, e.g. --schedule \"0 3 * * *\"")
			case !isCron && (cmd.Flags().Changed("schedule") || cmd.Flags().Changed("timezone")):
				return exitcode.New(exitcode.Usage, "--schedule and --timezone are only for --kind cron")
			}
			ctx := cmd.Context()
			t, err := a.resolve(ctx, cf, serviceOptional)
			if err != nil {
				return err
			}
			in := api.CreateServiceInput{Name: args[0], Slug: slug, Kind: kind, Source: src}
			setConfig := func(part string, v any) {
				if in.Config == nil {
					in.Config = map[string]any{}
				}
				in.Config[part] = v
			}
			if port > 0 {
				setConfig("networking", map[string]any{"port": port})
			}
			var cronPatch api.CronConfigPatch
			if isCron {
				cronPatch.Schedule = &schedule
				if timezone != "" {
					cronPatch.Timezone = &timezone
				}
				setConfig("cron", cronPatch)
			}
			created, err := t.sess.client.CreateService(ctx, t.project.ID, in)
			if err != nil {
				return a.cronConfigErr(err, cronPatch.Schedule, cronPatch.Timezone)
			}
			if a.jsonOut {
				return a.printJSON(created)
			}
			fmt.Fprintf(a.IO.Out, "%s Created service %s (%s) in %s\n", a.IO.OutColor().Green("✓"), created.Service.Name, created.Service.Slug, t.project.Name)
			if len(created.Configs) > 0 && created.Configs[0].Cron != nil {
				c := created.Configs[0].Cron
				fmt.Fprintf(a.IO.Out, "  Runs on %s (%s) once deployed; change it with `roundhouse cron set`\n", c.Schedule, c.Timezone)
			}
			fmt.Fprintf(a.IO.Out, "  Deploy it with: roundhouse deploy --service %s\n", created.Service.Slug)
			return nil
		},
	}
	cf.register(create, false)
	create.Flags().StringVar(&image, "image", "", "run this image, e.g. nginx:1.27")
	create.Flags().StringVar(&repo, "repo", "", "build from this https git URL")
	create.Flags().StringVar(&branch, "branch", "main", "with --repo, the branch to build")
	create.Flags().StringVar(&rootDir, "root-dir", ".", "with --repo, the directory to build")
	create.Flags().StringVar(&kind, "kind", "app", "service kind: app, database or cron")
	create.Flags().StringVar(&slug, "slug", "", "slug, also its ${{slug.VAR}} reference namespace (default: derived from the name; -2, -3… is added when taken or reserved)")
	create.Flags().IntVar(&port, "port", 0, "port the service listens on (default 8080)")
	create.Flags().StringVar(&schedule, "schedule", "", "with --kind cron, the five-field cron expression or macro (@daily) it runs on")
	create.Flags().StringVar(&timezone, "timezone", "", "with --kind cron, the IANA time zone the schedule is read in (default UTC)")

	var df targetFlags
	var confirm string
	del := &cobra.Command{
		Use:     "delete SERVICE",
		Aliases: []string{"rm"},
		Short:   "Delete a service",
		Long: `Delete a service from the project; its workloads are removed from your
servers in every environment. You are asked to type the service's slug; in
scripts pass it with --confirm.`,
		Example: `  roundhouse services delete worker
  roundhouse services delete svc_01J9Z6Y4M0V8 --confirm worker`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			t, err := a.resolve(ctx, df, serviceOptional)
			if err != nil {
				return err
			}
			svc := findService(t.project.Services, args[0])
			if svc == nil {
				return exitcode.New(exitcode.NotFound, "no service %q in project %s", args[0], t.project.Name)
			}
			warning := fmt.Sprintf("This deletes service %s from %s in every environment.", svc.Name, t.project.Name)
			if err := a.IO.ConfirmTyped(warning, svc.Slug, confirm); err != nil {
				return err
			}
			if err := t.sess.client.DeleteService(ctx, svc.ID); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(map[string]string{"deleted": svc.ID})
			}
			fmt.Fprintf(a.IO.Out, "Deleted service %s\n", svc.Name)
			if l, _ := a.loadLink(); l != nil && l.ServiceID == svc.ID {
				fmt.Fprintln(a.IO.Out, "  This directory was linked to it; run `roundhouse link` to pick another.")
			}
			return nil
		},
	}
	df.register(del, false)
	del.Flags().StringVar(&confirm, "confirm", "", "the service's slug, to skip the prompt")

	cmd.AddCommand(list, create, del)
	return cmd
}

// -----------------------------------------------------------------------------
// version and stubs
// -----------------------------------------------------------------------------

// versionResult is the --json output of version.
type versionResult struct {
	Version string `json:"version"`
	Commit  string `json:"commit,omitempty"`
	Go      string `json:"go"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
}

func (a *App) versionCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "version",
		Short:   "Print the CLI version",
		Example: `  roundhouse version --json`,
		Args:    noArgs,
		RunE: func(*cobra.Command, []string) error {
			v := buildInfo(a.Version, a.Commit)
			if a.jsonOut {
				return a.printJSON(v)
			}
			fmt.Fprintf(a.IO.Out, "roundhouse %s (%s, %s/%s)\n", a.versionString(), v.Go, v.OS, v.Arch)
			return nil
		},
	}
}

// stub declares a command whose server side does not exist yet. It exits
// with [exitcode.Unavailable] so scripts can tell "not yet" from "failed".
func (a *App) stub(use, short, long, example string, args cobra.PositionalArgs) *cobra.Command {
	return &cobra.Command{
		Use:     use,
		Short:   short,
		Long:    long,
		Example: example,
		Args:    args,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return exitcode.New(exitcode.Unavailable, "`roundhouse %s` is not available on this control plane yet", strings.TrimPrefix(cmd.CommandPath(), "roundhouse "))
		},
	}
}

func (a *App) upCmd() *cobra.Command {
	// TODO(phase-2): needs a source upload endpoint (tarball of the working
	// directory, honouring .gitignore) that creates a build from it.
	return a.stub("up", "Deploy the current directory without git (not available yet)",
		`Upload the current directory and deploy it, without pushing to git.
This needs a source upload endpoint the control plane does not offer yet.`,
		`  roundhouse up`, noArgs)
}

func (a *App) shellCmd() *cobra.Command {
	// TODO(phase-3): needs an exec endpoint that relays a TTY to a replica
	// through its node agent.
	return a.stub("shell", "Open a shell in a running replica (not available yet)",
		`Open an interactive shell inside one of the service's running containers.
This needs an exec relay the control plane does not offer yet.`,
		`  roundhouse shell --service api`, noArgs)
}
