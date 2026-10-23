package cli

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Open-Rail/cli/internal/api"
	"github.com/BankkRoll/Open-Rail/cli/internal/exitcode"
)

func (a *App) runCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:   "run -- COMMAND [ARGS...]",
		Short: "Run a local command with the service's variables",
		Long: `Run a command on this machine with the linked service's variables in its
environment, exactly as a deployment would get them: the control plane
resolves references to other services and shared variables and adds the
built-ins such as PORT and OPENRAIL_PRIVATE_DOMAIN (and
OPENRAIL_DEPLOYMENT_ID and OPENRAIL_GIT_COMMIT_SHA of the live deployment,
when there is one).

Resolving reveals secrets, so it needs the variables:reveal permission and is
recorded in the audit log. The values are passed to the child process alone:
they are never written to disk. The exit code is the command's own.`,
		Example: `  roundhouse run -- npm run dev
  roundhouse run --service worker -- python manage.py migrate
  roundhouse run --environment staging -- env`,
		Args: minArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if dash := cmd.ArgsLenAtDash(); dash > 0 {
				return exitcode.New(exitcode.Usage, "put the command after --, e.g. `roundhouse run -- %s`", strings.Join(args, " "))
			}
			ctx := cmd.Context()
			t, err := a.resolve(ctx, f, serviceRequired)
			if err != nil {
				return err
			}
			vars, err := a.resolveServiceEnv(ctx, t)
			if err != nil {
				return err
			}
			a.IO.Warn("injecting %s from %s (%s) into `%s`; resolved by the control plane (audited), passed only to this process, never written to disk",
				plural(len(vars), "variable", "variables"), t.service.Name, t.env.Name, args[0])
			env := slices.Clone(a.Environ())
			for _, v := range vars {
				env = append(env, v.Key+"="+v.Value)
			}
			code, err := a.Exec(ctx, args, env, a.IO)
			if err != nil {
				return err
			}
			if code != 0 {
				return exitcode.Silent(code)
			}
			return nil
		},
	}
	f.register(cmd, true)
	// Flags after the command name belong to the command: `run npm --version`.
	cmd.Flags().SetInterspersed(false)
	return cmd
}

// resolveServiceEnv returns the target service's environment, resolved by
// the control plane.
//
// NOTE: there is deliberately no local fallback for a control plane without
// the resolve route. Reproducing its resolver here drifted from the real one
// (built-ins, limits, error rules) and needed every secret revealed to the
// CLI; an older control plane gets a clear "upgrade" error instead.
func (a *App) resolveServiceEnv(ctx context.Context, t *target) ([]api.ResolvedVariable, error) {
	vars, err := t.sess.client.ResolveVariables(ctx, t.service.ID, t.env.ID)
	var apiErr *api.Error
	switch {
	case err == nil:
		return vars, nil
	case errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound && apiErr.Message == routeNotFoundMessage:
		return nil, exitcode.New(exitcode.Unavailable,
			"%s cannot resolve variables for `roundhouse run` (no %s route); upgrade the control plane", t.sess.url, api.RouteResolveVars)
	case errors.As(err, &apiErr) && apiErr.Code == "invalid_reference" && len(apiErr.Details) > 0:
		// Each detail names a variable and its problem; they are printed below.
		apiErr.Message = "cannot resolve the variables of " + t.service.Name + " in " + t.env.Name
	}
	return nil, err
}

// routeNotFoundMessage is how the API answers a route it does not have
// (app.notFound in apps/api/src/index.ts), as opposed to a missing resource.
const routeNotFoundMessage = "No such endpoint"
