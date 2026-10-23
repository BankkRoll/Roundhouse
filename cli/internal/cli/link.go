package cli

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Open-Rail/cli/internal/api"
	"github.com/BankkRoll/Open-Rail/cli/internal/config"
	"github.com/BankkRoll/Open-Rail/cli/internal/exitcode"
)

// linkResult is the --json output of init and link.
type linkResult struct {
	Path string       `json:"path"`
	Link *config.Link `json:"link"`
	// Gitignore is "added", "present" or "skipped".
	Gitignore string `json:"gitignore"`
}

// gitignoreFlag records whether --gitignore was given and its value.
type gitignoreFlag struct {
	value bool
	cmd   *cobra.Command
}

func (g *gitignoreFlag) register(cmd *cobra.Command) {
	g.cmd = cmd
	cmd.Flags().BoolVar(&g.value, "gitignore", true, "add .roundhouse/ to .gitignore (asked when omitted on a terminal)")
}

func (a *App) initCmd() *cobra.Command {
	var workspace, name, description string
	var gi gitignoreFlag
	cmd := &cobra.Command{
		Use:   "init",
		Short: "Create a project and link this directory to it",
		Long: `Create a project (with a production environment) in a workspace and link
the current directory to it. Add services with "roundhouse services create".`,
		Example: `  roundhouse init
  roundhouse init --name shop --workspace acme --gitignore=false`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			a.relinking = true
			sess, err := a.connect()
			if err != nil {
				return err
			}
			ws, err := a.findWorkspace(ctx, sess.client, workspace)
			if err != nil {
				return err
			}
			if name == "" {
				if name, err = a.IO.Prompt("Project name:", filepath.Base(a.WorkDir), "pass --name"); err != nil {
					return err
				}
			}
			p, err := sess.client.CreateProject(ctx, ws.ID, api.CreateProjectInput{Name: name, Description: description})
			if err != nil {
				return err
			}
			env, err := pickEnvironment(p, "")
			if err != nil {
				return err
			}
			if !a.jsonOut {
				fmt.Fprintf(a.IO.Out, "%s Created project %s (slug %s) in workspace %s\n", a.IO.OutColor().Green("✓"), p.Name, p.Slug, ws.Name)
			}
			return a.writeLink(sess, ws.ID, p, env, nil, &gi)
		},
	}
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "workspace ID, slug or name")
	cmd.Flags().StringVar(&name, "name", "", "project name (default: directory name)")
	cmd.Flags().StringVar(&description, "description", "", "project description")
	gi.register(cmd)
	return cmd
}

func (a *App) linkCmd() *cobra.Command {
	var workspace string
	var f targetFlags
	var gi gitignoreFlag
	cmd := &cobra.Command{
		Use:   "link",
		Short: "Link this directory to a project, environment and service",
		Long: `Write .roundhouse/config.json in the current directory, so later commands
know which project, environment and service to act on. Missing choices are
asked interactively; in scripts pass them as flags.

The link file holds IDs only, never credentials.`,
		Example: `  roundhouse link
  roundhouse link --project shop --environment production --service api
  roundhouse link -p prj_01J9Z6Y4M0V8 -s web --gitignore=false`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			a.relinking = true
			sess, err := a.connect()
			if err != nil {
				return err
			}
			var p *api.ProjectDetail
			if f.project != "" {
				if p, err = a.findProject(ctx, sess.client, f.project); err != nil {
					return err
				}
			} else if p, err = a.chooseProject(ctx, sess.client, workspace); err != nil {
				return err
			}
			env, err := a.chooseEnvironment(p, f.environment)
			if err != nil {
				return err
			}
			svc, err := a.chooseLinkService(p, f.service)
			if err != nil {
				return err
			}
			return a.writeLink(sess, p.WorkspaceID, p, env, svc, &gi)
		},
	}
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "workspace ID, slug or name (to pick a project from)")
	f.register(cmd, true)
	gi.register(cmd)
	return cmd
}

func (a *App) chooseProject(ctx context.Context, c *api.Client, workspace string) (*api.ProjectDetail, error) {
	if !a.IO.Interactive() {
		return nil, exitcode.New(exitcode.InputRequired, "no project given and input is not interactive; pass --project")
	}
	ws, err := a.findWorkspace(ctx, c, workspace)
	if err != nil {
		return nil, err
	}
	projects, err := c.ListProjects(ctx, ws.ID)
	if err != nil {
		return nil, err
	}
	if len(projects) == 0 {
		return nil, exitcode.New(exitcode.NotFound, "workspace %s has no projects; create one with `roundhouse init`", ws.Name)
	}
	names := make([]string, len(projects))
	for i, p := range projects {
		names[i] = fmt.Sprintf("%s (%s)", p.Name, p.Slug)
	}
	i, err := a.IO.Select("Which project?", names, "pass --project")
	if err != nil {
		return nil, err
	}
	return c.GetProject(ctx, projects[i].ID)
}

func (a *App) chooseEnvironment(p *api.ProjectDetail, ref string) (*api.Environment, error) {
	if ref != "" || len(p.Environments) <= 1 || !a.IO.Interactive() {
		return pickEnvironment(p, ref)
	}
	names := make([]string, len(p.Environments))
	for i, e := range p.Environments {
		names[i] = fmt.Sprintf("%s (%s)", e.Name, e.Kind)
	}
	i, err := a.IO.Select("Which environment?", names, "pass --environment")
	if err != nil {
		return nil, err
	}
	return &p.Environments[i], nil
}

// chooseLinkService returns the named service, the only one, a choice, or
// nil: a link without a service is valid.
func (a *App) chooseLinkService(p *api.ProjectDetail, ref string) (*api.Service, error) {
	if ref != "" {
		svc := findService(p.Services, ref)
		if svc == nil {
			return nil, exitcode.New(exitcode.NotFound, "no service %q in project %s", ref, p.Name)
		}
		return svc, nil
	}
	switch {
	case len(p.Services) == 0:
		return nil, nil
	case len(p.Services) == 1:
		return &p.Services[0], nil
	case !a.IO.Interactive():
		return nil, nil
	}
	names := []string{"(none)"}
	for _, s := range p.Services {
		names = append(names, fmt.Sprintf("%s (%s)", s.Name, s.Slug))
	}
	i, err := a.IO.Select("Which service?", names, "pass --service")
	if err != nil || i == 0 {
		return nil, err
	}
	return &p.Services[i-1], nil
}

func (a *App) writeLink(sess *session, workspaceID string, p *api.ProjectDetail, env *api.Environment, svc *api.Service, gi *gitignoreFlag) error {
	l := &config.Link{
		URL:             sess.url,
		WorkspaceID:     workspaceID,
		ProjectID:       p.ID,
		EnvironmentID:   env.ID,
		ProjectName:     p.Name,
		EnvironmentName: env.Name,
	}
	if sess.profile != config.DefaultProfile {
		l.Profile = sess.profile
	}
	if svc != nil {
		l.ServiceID, l.ServiceName = svc.ID, svc.Name
	}
	path, err := config.WriteLink(a.WorkDir, l)
	if err != nil {
		return fmt.Errorf("write link: %w", err)
	}
	gitignore, err := a.updateGitignore(gi)
	if err != nil {
		a.IO.Warn("could not update .gitignore: %v", err)
	}
	if a.jsonOut {
		return a.printJSON(linkResult{Path: path, Link: l, Gitignore: gitignore})
	}
	c := a.IO.OutColor()
	target := p.Name + " / " + env.Name
	if svc != nil {
		target += " / " + svc.Name
	}
	fmt.Fprintf(a.IO.Out, "%s Linked %s to %s\n", c.Green("✓"), a.WorkDir, c.Bold(target))
	if svc == nil && len(p.Services) > 1 {
		fmt.Fprintln(a.IO.Out, "  No service linked; pass --service to commands or run `roundhouse link --service <name>`.")
	}
	return nil
}

// updateGitignore applies the --gitignore choice, asking on a terminal when
// the flag was not given. It returns "added", "present" or "skipped".
func (a *App) updateGitignore(gi *gitignoreFlag) (string, error) {
	path := config.GitignorePath(a.WorkDir)
	present, err := config.GitignoreHasEntry(path)
	if err != nil {
		return "skipped", err
	}
	if present {
		return "present", nil
	}
	add := gi.value
	if !gi.cmd.Flags().Changed("gitignore") {
		if !a.IO.Interactive() {
			if !a.jsonOut {
				a.IO.Info("Tip: add %s to %s (or pass --gitignore).", config.GitignoreEntry, path)
			}
			return "skipped", nil
		}
		if add, err = a.IO.Confirm(fmt.Sprintf("Add %s to %s?", config.GitignoreEntry, path), true, ""); err != nil {
			return "skipped", err
		}
	}
	if !add {
		return "skipped", nil
	}
	if err := config.AppendGitignore(path); err != nil {
		return "skipped", err
	}
	return "added", nil
}

func (a *App) unlinkCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "unlink",
		Short:   "Remove this directory's link",
		Example: `  roundhouse unlink`,
		Args:    noArgs,
		RunE: func(*cobra.Command, []string) error {
			l, err := a.loadLink()
			if err != nil {
				return err
			}
			if l == nil {
				return exitcode.New(exitcode.NotLinked, "this directory is not linked")
			}
			dir := filepath.Dir(filepath.Dir(a.linkPath))
			if err := config.RemoveLink(dir); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(map[string]string{"unlinked": a.linkPath})
			}
			fmt.Fprintf(a.IO.Out, "Unlinked %s from %s\n", dir, l.ProjectName)
			return nil
		},
	}
}
