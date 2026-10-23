package cli

import (
	"context"
	"errors"
	"io/fs"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/dotenv"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// defaultEnvFile is where `run` looks for local values of secret keys when
// --env-file is not given.
const defaultEnvFile = ".env"

func (a *App) runCmd() *cobra.Command {
	var f targetFlags
	var envFile string
	cmd := &cobra.Command{
		Use:   "run -- COMMAND [ARGS...]",
		Short: "Run a local command with the service's variables",
		Long: `Run a command on this machine with the linked service's variables in its
environment, as a deployment would get them: the control plane resolves
references to other services and shared variables and adds the built-ins
such as PORT and ROUNDHOUSE_PRIVATE_DOMAIN (and ROUNDHOUSE_DEPLOYMENT_ID and
ROUNDHOUSE_GIT_COMMIT_SHA of the live deployment, when there is one).

Secret values never leave the control plane. Secrets, and variables whose
value references a secret, are taken from a local env file instead
(--env-file, default .env); a warning names any the file does not set. Only
those keys are read from the file: every other variable keeps the control
plane's value.

Resolving needs the variables:read_plain permission and is recorded in the
audit log. The values are passed to the child process alone: they are never
written to disk. The exit code is the command's own.`,
		Example: `  roundhouse run -- npm run dev
  roundhouse run --env-file .env.local -- npm test
  roundhouse run --service worker -- python manage.py migrate
  roundhouse run --environment staging -- env`,
		Args: minArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if dash := cmd.ArgsLenAtDash(); dash > 0 {
				return exitcode.New(exitcode.Usage, "put the command after --, e.g. `roundhouse run -- %s`", strings.Join(args, " "))
			}
			local, err := a.readEnvFile(envFile, cmd.Flags().Changed("env-file"))
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			t, err := a.resolve(ctx, f, serviceRequired)
			if err != nil {
				return err
			}
			resolved, err := a.resolveServiceEnv(ctx, t)
			if err != nil {
				return err
			}
			vars := make(map[string]string, len(resolved.Variables)+len(resolved.LocalKeys))
			for k, v := range resolved.Variables {
				vars[k] = v
			}
			var fromFile int
			var missing []string
			for _, k := range resolved.LocalKeys {
				if v, ok := local[k]; ok {
					vars[k] = v
					fromFile++
				} else {
					missing = append(missing, k)
				}
			}
			if len(missing) > 0 {
				a.IO.Warn("%s does not set %s, which the control plane never sends: %s",
					envFile, plural(len(missing), "secret variable", "secret variables"), strings.Join(missing, ", "))
			}
			source := ""
			if fromFile > 0 {
				source = " (" + plural(fromFile, "secret", "secrets") + " from " + envFile + ")"
			}
			a.IO.Warn("injecting %s from %s (%s)%s into `%s`; resolved by the control plane (audited), passed only to this process, never written to disk",
				plural(len(vars), "variable", "variables"), t.service.Name, t.env.Name, source, args[0])
			env := slices.Clone(a.Environ())
			for _, k := range slices.Sorted(maps.Keys(vars)) {
				env = append(env, k+"="+vars[k])
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
	cmd.Flags().StringVar(&envFile, "env-file", defaultEnvFile, "local env file supplying secret variables")
	// Flags after the command name belong to the command: `run npm --version`.
	cmd.Flags().SetInterspersed(false)
	return cmd
}

// readEnvFile parses the env file at path, relative to the working
// directory. A missing file is an error only when the user named it.
func (a *App) readEnvFile(path string, explicit bool) (map[string]string, error) {
	full := path
	if !filepath.IsAbs(full) {
		full = filepath.Join(a.WorkDir, full)
	}
	data, err := os.ReadFile(full)
	switch {
	case errors.Is(err, fs.ErrNotExist) && !explicit:
		return map[string]string{}, nil
	case err != nil:
		return nil, exitcode.Wrap(exitcode.Usage, err)
	}
	entries, err := dotenv.Parse(string(data))
	if err != nil {
		return nil, exitcode.New(exitcode.Usage, "%s: %v", path, err)
	}
	out := make(map[string]string, len(entries))
	for _, e := range entries {
		out[e.Key] = e.Value
	}
	return out, nil
}

// resolveServiceEnv returns the target service's plain environment,
// resolved by the control plane, and the secret keys it leaves to the
// caller.
//
// NOTE: there is deliberately no local fallback for a control plane without
// the resolved route. Reproducing its resolver here drifted from the real one
// (built-ins, limits, error rules) and needed every secret revealed to the
// CLI; an older control plane gets a clear "upgrade" error instead.
func (a *App) resolveServiceEnv(ctx context.Context, t *target) (*api.ResolvedVariables, error) {
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
