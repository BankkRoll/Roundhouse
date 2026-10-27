package cli

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

func (a *App) envCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "environments",
		Aliases: []string{"environment", "envs"},
		Short:   "Create, compare, promote and delete environments",
		Long: `Work with a project's environments (ADR 0007). A clone copies configs and
variables from another environment; every database starts empty with
credentials of its own. diff compares two environments without showing any
value: secrets are compared by fingerprint. promote proposes a change set in
the target environment, deploying the source's exact images without a
rebuild; review and apply it with roundhouse changes. Production can never
be deleted.

Environments are named by slug or ID.`,
		Example: `  roundhouse environments list
  roundhouse environments create staging --from production --variables non_secret
  roundhouse environments diff production staging
  roundhouse environments promote --from staging --into production
  roundhouse environments delete staging --yes`,
		Args: noArgs,
	}
	cmd.AddCommand(a.envListCmd(), a.envCreateCmd(), a.envDiffCmd(), a.envPromoteCmd(), a.envDeleteCmd())
	return cmd
}

// environmentByRef finds a project's environment by slug or ID.
func environmentByRef(p *api.ProjectDetail, ref string) (*api.Environment, error) {
	for i := range p.Environments {
		e := &p.Environments[i]
		if e.ID == ref || e.Slug == ref {
			return e, nil
		}
	}
	return nil, exitcode.New(exitcode.NotFound, "project %s has no environment %q; list them with `roundhouse environments list`", p.Name, ref)
}

func (a *App) envListCmd() *cobra.Command {
	var project string
	cmd := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the project's environments",
		Example: `  roundhouse environments list
  roundhouse environments list --project shop --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			_, proj, err := a.resolveProject(cmd.Context(), project)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(proj.Environments)
			}
			tb := a.newTable("slug", "name", "kind", "protected", "id")
			for _, e := range proj.Environments {
				protected := "-"
				if e.Protected {
					protected = "yes"
				}
				tb.row(sanitizeCell(e.Slug, 64), sanitizeCell(e.Name, 64), e.Kind, protected, e.ID)
			}
			tb.flush()
			return nil
		},
	}
	registerProjectFlag(cmd, &project)
	return cmd
}

func (a *App) envCreateCmd() *cobra.Command {
	var project, from, variables, slug string
	var restore bool
	cmd := &cobra.Command{
		Use:   "create NAME",
		Short: "Create a staging environment, blank or cloned",
		Long: `Create a staging environment. With --from it clones that environment:
configs, variables per --variables (all, non_secret or none), and empty
volumes; with --restore-latest-backup each database is restored from the
source's latest dump, which needs the backups:restore permission. Database
credentials are always fresh.`,
		Example: `  roundhouse environments create staging --from production
  roundhouse environments create qa --from production --variables none`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			sess, proj, err := a.resolveProject(ctx, project)
			if err != nil {
				return err
			}
			in := api.CreateEnvironmentInput{Name: args[0], Slug: slug, Kind: "staging"}
			if from == "" && (variables != "" || restore) {
				return exitcode.New(exitcode.Usage, "--variables and --restore-latest-backup need --from")
			}
			if from != "" {
				src, err := environmentByRef(proj, from)
				if err != nil {
					return err
				}
				switch variables {
				case "", "all", "non_secret", "none":
				default:
					return exitcode.New(exitcode.Usage, "--variables must be all, non_secret or none")
				}
				in.Clone = &api.CloneInput{FromEnvironmentID: src.ID, Variables: variables}
				if restore {
					in.Clone.Volumes = "latest_backup"
				}
			}
			env, err := sess.client.CreateEnvironment(ctx, proj.ID, in)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(env)
			}
			fmt.Fprintf(a.IO.Out, "%s Created %s (%s)\n", a.IO.OutColor().Green("✓"), sanitizeCell(env.Name, 64), env.Slug)
			return nil
		},
	}
	registerProjectFlag(cmd, &project)
	cmd.Flags().StringVar(&from, "from", "", "environment to clone (slug or ID)")
	cmd.Flags().StringVar(&variables, "variables", "", "variables to copy: all (default), non_secret or none")
	cmd.Flags().BoolVar(&restore, "restore-latest-backup", false, "restore each database from the source's latest dump")
	cmd.Flags().StringVar(&slug, "slug", "", "slug (default: derived from NAME)")
	return cmd
}

func (a *App) envDiffCmd() *cobra.Command {
	var project string
	cmd := &cobra.Command{
		Use:   "diff BASE TARGET",
		Short: "Show what differs between two environments",
		Long: `Show what differs between two environments: config paths, variables
(secrets compared by fingerprint, never shown) and the images their active
deployments run.`,
		Example: `  roundhouse environments diff production staging`,
		Args:    exactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			sess, proj, err := a.resolveProject(ctx, project)
			if err != nil {
				return err
			}
			base, err := environmentByRef(proj, args[0])
			if err != nil {
				return err
			}
			target, err := environmentByRef(proj, args[1])
			if err != nil {
				return err
			}
			diff, err := sess.client.DiffEnvironments(ctx, proj.ID, base.ID, target.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(diff)
			}
			tb := a.newTable("service", "presence", "config", "variables", "image")
			for _, s := range diff.Services {
				var paths []string
				for _, c := range s.Config {
					paths = append(paths, c.Path)
				}
				image := "same"
				if !samePtr(s.Image.Base, s.Image.Target) {
					image = "differs"
				}
				tb.row(sanitizeCell(s.Slug, 64), s.Presence, orDash(strings.Join(paths, ", ")),
					orDash(describeComparisons(s.Variables)), image)
			}
			tb.flush()
			if shared := describeComparisons(diff.SharedVariables); shared != "" {
				fmt.Fprintf(a.IO.Out, "shared: %s\n", shared)
			}
			return nil
		},
	}
	registerProjectFlag(cmd, &project)
	return cmd
}

func samePtr(a, b *string) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

// describeComparisons lists the variables that differ, e.g. "API_KEY changed (secret)".
func describeComparisons(vars []api.VariableComparison) string {
	var out []string
	for _, v := range vars {
		if v.Change == "same" {
			continue
		}
		s := sanitizeCell(v.Key, 64) + " " + v.Change
		if v.Secret {
			s += " (secret)"
		}
		out = append(out, s)
	}
	return strings.Join(out, ", ")
}

func (a *App) envPromoteCmd() *cobra.Command {
	var project, from, into, variables string
	var noConfig, noImage bool
	cmd := &cobra.Command{
		Use:   "promote",
		Short: "Propose promoting one environment into another",
		Long: `Propose promoting --from into --into as a change set: config
differences, variables per --variables (non_secret by default, all or
none), and the source's active images, deployed by digest without a
rebuild. Nothing changes until the change set is applied; review it with
roundhouse changes. Protected targets need their approval as usual.`,
		Example: `  roundhouse environments promote --from staging --into production
  roundhouse environments promote --from staging --into production --variables all --no-image`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			if from == "" || into == "" {
				return exitcode.New(exitcode.Usage, "--from and --into are required")
			}
			switch variables {
			case "all", "non_secret", "none":
			default:
				return exitcode.New(exitcode.Usage, "--variables must be all, non_secret or none")
			}
			sess, proj, err := a.resolveProject(ctx, project)
			if err != nil {
				return err
			}
			src, err := environmentByRef(proj, from)
			if err != nil {
				return err
			}
			dst, err := environmentByRef(proj, into)
			if err != nil {
				return err
			}
			set, err := sess.client.PromoteEnvironment(ctx, dst.ID, api.PromoteInput{
				FromEnvironmentID: src.ID,
				Services:          "all",
				Include:           api.PromoteInclude{Config: !noConfig, Variables: variables, Image: !noImage},
			})
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(set)
			}
			fmt.Fprintf(a.IO.Out, "%s Proposed %d changes to %s in change set %s; review and apply it with `roundhouse changes`\n",
				a.IO.OutColor().Green("✓"), set.OpCount, sanitizeCell(dst.Name, 64), set.ID)
			return nil
		},
	}
	registerProjectFlag(cmd, &project)
	cmd.Flags().StringVar(&from, "from", "", "source environment (slug or ID)")
	cmd.Flags().StringVar(&into, "into", "", "target environment (slug or ID)")
	cmd.Flags().StringVar(&variables, "variables", "non_secret", "variables to carry over: non_secret, all or none")
	cmd.Flags().BoolVar(&noConfig, "no-config", false, "leave config as it is")
	cmd.Flags().BoolVar(&noImage, "no-image", false, "don't deploy the source's images")
	return cmd
}

func (a *App) envDeleteCmd() *cobra.Command {
	var project string
	var yes bool
	cmd := &cobra.Command{
		Use:     "delete ENVIRONMENT",
		Aliases: []string{"rm"},
		Short:   "Delete an environment",
		Long: `Delete an environment: its deployments stop, its domains go, and its
volumes are deleted after a 72-hour grace period. Production can never be
deleted. Asks you to type the slug unless --yes is given; in scripts --yes
is required.`,
		Example: `  roundhouse environments delete staging
  roundhouse environments delete qa --yes`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if !yes && !a.IO.Interactive() {
				return exitcode.New(exitcode.Usage, "deleting an environment needs confirmation; pass --yes to delete %s without asking", args[0])
			}
			sess, proj, err := a.resolveProject(ctx, project)
			if err != nil {
				return err
			}
			env, err := environmentByRef(proj, args[0])
			if err != nil {
				return err
			}
			if env.Kind == "production" {
				return exitcode.New(exitcode.Conflict, "a production environment can never be deleted")
			}
			if !yes {
				typed, err := a.IO.Prompt(fmt.Sprintf("Type %s to delete it", env.Slug), "", "pass --yes")
				if err != nil {
					return err
				}
				if typed != env.Slug {
					return exitcode.New(exitcode.Error, "delete aborted; nothing was changed")
				}
			}
			if err := sess.client.DeleteEnvironment(ctx, env.ID, env.Slug); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(map[string]string{"deleted": env.ID})
			}
			fmt.Fprintf(a.IO.Out, "%s Deleted %s; its volumes go after a 72-hour grace period\n", a.IO.OutColor().Green("✓"), sanitizeCell(env.Name, 64))
			return nil
		},
	}
	registerProjectFlag(cmd, &project)
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")
	return cmd
}
