package cli

import (
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Open-Rail/cli/internal/api"
	"github.com/BankkRoll/Open-Rail/cli/internal/exitcode"
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
		Short:   "List the service's domains",
		Long: `List the domains routed to the linked service in its environment, or in
every environment with --all.`,
		Example: `  roundhouse domain
  roundhouse domain --all --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolve(ctx, f, serviceRequired)
			if err != nil {
				return err
			}
			envID := t.env.ID
			if all {
				envID = ""
			}
			domains, err := t.sess.client.ListDomains(ctx, t.service.ID, envID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(domains)
			}
			if len(domains) == 0 {
				fmt.Fprintf(a.IO.Out, "%s has no domains in %s\n", t.service.Name, t.env.Name)
				return nil
			}
			envName := map[string]string{}
			for _, e := range t.project.Environments {
				envName[e.ID] = e.Name
			}
			tb := a.newTable("url", "environment", "type", "port", "tls")
			for _, d := range domains {
				tb.row(d.URL, orDash(envName[d.EnvironmentID]), d.Type, fmt.Sprint(d.TargetPort), d.TLSStatus)
			}
			tb.flush()
			return nil
		},
	}
	f.register(cmd, true)
	cmd.Flags().BoolVar(&all, "all", false, "list domains in every environment")
	return cmd
}

// -----------------------------------------------------------------------------
// servers
// -----------------------------------------------------------------------------

func (a *App) serversCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "servers",
		Aliases: []string{"server", "nodes"},
		Short:   "List servers and add new ones",
		Example: `  roundhouse servers list
  roundhouse servers add`,
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
			t := a.newTable("name", "id", "ip", "arch", "agent", "last seen", "status")
			for _, n := range nodes {
				seen := "-"
				if n.LastHeartbeatAt != nil {
					seen = ago(a.Now(), *n.LastHeartbeatAt)
				}
				t.row(n.Name, n.ID, orDash(deref(n.PublicIP)), orDash(deref(n.Arch)), orDash(deref(n.AgentVersion)), seen, a.IO.OutColor().Status(n.Status))
			}
			t.flush()
			return nil
		},
	}
	list.Flags().StringVarP(&workspace, "workspace", "w", "", "workspace ID, slug or name")

	var addWorkspace string
	add := &cobra.Command{
		Use:   "add",
		Short: "Mint a join token and print the install command",
		Long: `Create a single-use join token and print the one-line command that
installs the agent on a new server and joins it to the workspace. Run the
command on the server as root. The token expires if unused.`,
		Example: `  roundhouse servers add
  roundhouse servers add --workspace acme --json | jq -r .install_command`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			sess, err := a.connect()
			if err != nil {
				return err
			}
			ws, err := a.findWorkspace(ctx, sess.client, addWorkspace)
			if err != nil {
				return err
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
	cmd.AddCommand(list, add)
	return cmd
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
			fmt.Fprintf(a.IO.Out, "%s Created project %s (%s) in %s\n", a.IO.OutColor().Green("✓"), p.Name, p.ID, ws.Name)
			return nil
		},
	}
	create.Flags().StringVarP(&createWorkspace, "workspace", "w", "", "workspace ID, slug or name")
	create.Flags().StringVar(&slug, "slug", "", "URL slug (default: derived from the name)")
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
	var image, repo, branch, rootDir, kind, slug string
	var port int
	create := &cobra.Command{
		Use:   "create NAME (--image IMAGE | --repo URL)",
		Short: "Create a service from an image or a git repository",
		Long: `Create a service in the linked project, in every environment. It is not
deployed until you run "roundhouse deploy".`,
		Example: `  roundhouse services create web --image nginx:1.27 --port 80
  roundhouse services create api --repo https://github.com/acme/api --branch main
  roundhouse services create worker --repo https://github.com/acme/mono --root-dir apps/worker`,
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
			ctx := cmd.Context()
			t, err := a.resolve(ctx, cf, serviceOptional)
			if err != nil {
				return err
			}
			in := api.CreateServiceInput{Name: args[0], Slug: slug, Kind: kind, Source: src}
			if port > 0 {
				in.Config = map[string]any{"networking": map[string]any{"port": port}}
			}
			created, err := t.sess.client.CreateService(ctx, t.project.ID, in)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(created)
			}
			fmt.Fprintf(a.IO.Out, "%s Created service %s (%s) in %s\n", a.IO.OutColor().Green("✓"), created.Service.Name, created.Service.Slug, t.project.Name)
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
	create.Flags().StringVar(&slug, "slug", "", "slug, also its reference namespace (default: derived from the name)")
	create.Flags().IntVar(&port, "port", 0, "port the service listens on (default 8080)")

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

func (a *App) dbCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "db",
		Short:   "Work with database services (not available yet)",
		Example: "  roundhouse db connect postgres",
		Args:    noArgs,
	}
	// TODO(phase-4): needs managed database services and a tunnel endpoint
	// to reach their private address from this machine.
	cmd.AddCommand(a.stub("connect [SERVICE]", "Open a database client to a database service (not available yet)",
		`Connect psql, mysql or redis-cli to a database service through a tunnel.
This needs database tunnels the control plane does not offer yet.`,
		`  roundhouse db connect postgres`, maxArgs(1)))
	return cmd
}
