package cli

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/dotenv"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// maxVariablesPerRequest is the API's limit on set, delete and reveal lists.
const maxVariablesPerRequest = 256

// varsFlags select the variable scope.
type varsFlags struct {
	targetFlags
	shared bool
}

func (v *varsFlags) register(cmd *cobra.Command) {
	v.targetFlags.register(cmd, true)
	cmd.Flags().BoolVar(&v.shared, "shared", false, "act on the environment's shared variables instead of the service's")
}

// varsTarget is a resolved variable scope.
type varsTarget struct {
	*target
	scope api.VariableScope
	label string
}

func (a *App) resolveVars(ctx context.Context, v varsFlags) (*varsTarget, error) {
	need := serviceRequired
	if v.shared {
		need = serviceOptional
	}
	t, err := a.resolve(ctx, v.targetFlags, need)
	if err != nil {
		return nil, err
	}
	if v.shared {
		return &varsTarget{target: t, scope: api.VariableScope{ProjectID: t.project.ID}, label: "shared (" + t.env.Name + ")"}, nil
	}
	return &varsTarget{target: t, scope: api.VariableScope{ServiceID: t.service.ID}, label: t.service.Name + " (" + t.env.Name + ")"}, nil
}

func (a *App) varsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "vars",
		Aliases: []string{"variables", "env"},
		Short:   "Manage a service's variables",
		Long: `List, set and remove the variables of the linked service, or with
--shared the environment's shared variables. Changes take effect on the next
deployment.

Secret values are never shown unless --reveal is given; every reveal is
recorded in the workspace audit log. Values may reference other variables
with ${{service.NAME}}, ${{shared.NAME}} or ${{NAME}}; references are stored
as written and resolved at deploy time.`,
		Example: `  roundhouse vars
  roundhouse vars set NODE_ENV=production PORT=8080
  roundhouse vars set --secret STRIPE_KEY=-  < stripe.key
  roundhouse vars set 'DATABASE_URL=${{db.DATABASE_URL}}'
  roundhouse vars import .env.production --secret
  roundhouse vars export --reveal > .env.local`,
		Args: noArgs,
	}
	var v varsFlags
	var reveal bool
	cmd.RunE = func(cmd *cobra.Command, _ []string) error { return a.runVarsGet(cmd.Context(), nil, v, reveal) }
	v.register(cmd)
	cmd.Flags().BoolVar(&reveal, "reveal", false, "print secret values (audited)")
	cmd.AddCommand(a.varsGetCmd(), a.varsSetCmd(), a.varsUnsetCmd(), a.varsImportCmd(), a.varsExportCmd())
	return cmd
}

func (a *App) varsGetCmd() *cobra.Command {
	var v varsFlags
	var reveal bool
	cmd := &cobra.Command{
		Use:   "get [KEY]",
		Short: "List variables, or print one",
		Example: `  roundhouse vars get
  roundhouse vars get DATABASE_URL --reveal
  roundhouse vars get --shared --json`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error { return a.runVarsGet(cmd.Context(), args, v, reveal) },
	}
	v.register(cmd)
	cmd.Flags().BoolVar(&reveal, "reveal", false, "print secret values (audited)")
	return cmd
}

// runVarsGet lists a scope's variables, or prints the one named in args.
func (a *App) runVarsGet(ctx context.Context, args []string, flags varsFlags, reveal bool) error {
	vt, err := a.resolveVars(ctx, flags)
	if err != nil {
		return err
	}
	vars, err := vt.sess.client.ListVariables(ctx, vt.scope, vt.env.ID)
	if err != nil {
		return err
	}
	if len(args) == 1 {
		return a.printOneVariable(ctx, vt, vars, args[0], reveal)
	}
	if reveal {
		if vars, err = a.revealAll(ctx, vt, vars); err != nil {
			return err
		}
	}
	if a.jsonOut {
		return a.printJSON(vars)
	}
	if len(vars) == 0 {
		fmt.Fprintf(a.IO.Out, "No variables on %s\n", vt.label)
		return nil
	}
	c := a.IO.OutColor()
	t := a.newTable("key", "value")
	for _, v := range vars {
		value := deref(v.Value)
		if v.Value == nil {
			value = c.Dim("•••••••• (secret)")
		} else if strings.ContainsAny(value, "\n\r") {
			value = strings.NewReplacer("\r", `\r`, "\n", `\n`).Replace(value)
		}
		t.row(v.Key, value)
	}
	t.flush()
	return nil
}

func (a *App) printOneVariable(ctx context.Context, vt *varsTarget, vars []api.Variable, key string, reveal bool) error {
	i := slices.IndexFunc(vars, func(v api.Variable) bool { return v.Key == key })
	if i < 0 {
		return exitcode.New(exitcode.NotFound, "no variable %s on %s", key, vt.label)
	}
	v := vars[i]
	if v.Value == nil {
		if !reveal {
			return exitcode.New(exitcode.Usage, "%s is secret; pass --reveal to print it (the reveal is audited)", key)
		}
		revealed, err := vt.sess.client.RevealVariables(ctx, vt.scope, vt.env.ID, []string{key})
		if err != nil {
			return err
		}
		if len(revealed) == 0 {
			return exitcode.New(exitcode.NotFound, "no variable %s on %s", key, vt.label)
		}
		v.Value = &revealed[0].Value
	}
	if a.jsonOut {
		return a.printJSON(v)
	}
	fmt.Fprintln(a.IO.Out, *v.Value)
	return nil
}

// revealAll fills in every secret value through the audited reveal route.
func (a *App) revealAll(ctx context.Context, vt *varsTarget, vars []api.Variable) ([]api.Variable, error) {
	var keys []string
	for _, v := range vars {
		if v.Value == nil {
			keys = append(keys, v.Key)
		}
	}
	values, err := a.reveal(ctx, vt.sess.client, vt.scope, vt.env.ID, keys)
	if err != nil {
		return nil, err
	}
	out := slices.Clone(vars)
	for i, v := range out {
		if val, ok := values[v.Key]; ok && v.Value == nil {
			out[i].Value = &val
		}
	}
	if len(keys) > 0 {
		a.IO.Info("Revealed %s (recorded in the audit log).", plural(len(keys), "secret", "secrets"))
	}
	return out, nil
}

// reveal returns plaintext for keys, in batches the API accepts.
func (a *App) reveal(ctx context.Context, c *api.Client, scope api.VariableScope, envID string, keys []string) (map[string]string, error) {
	out := map[string]string{}
	for batch := range slices.Chunk(keys, maxVariablesPerRequest) {
		revealed, err := c.RevealVariables(ctx, scope, envID, batch)
		if err != nil {
			return nil, err
		}
		for _, r := range revealed {
			out[r.Key] = r.Value
		}
	}
	return out, nil
}

func (a *App) varsSetCmd() *cobra.Command {
	var v varsFlags
	var secret bool
	cmd := &cobra.Command{
		Use:   "set KEY=VALUE...",
		Short: "Set variables",
		Long: `Create or overwrite variables. A value of "-" is read from stdin (one
trailing newline is removed), which keeps secrets out of shell history and
the process list. References like ${{db.DATABASE_URL}} are stored as written;
quote them so the shell leaves them alone.

Without --secret an existing variable keeps its secret flag; new ones are
plain. Changes take effect on the next deployment.`,
		Example: `  roundhouse vars set NODE_ENV=production LOG_LEVEL=info
  roundhouse vars set --secret API_KEY=-  < key.txt
  roundhouse vars set 'DATABASE_URL=${{db.DATABASE_URL}}'
  roundhouse vars set --shared REGION=eu-west`,
		Args: minArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			entries, err := a.parseAssignments(args)
			if err != nil {
				return err
			}
			label, err := a.putVariables(cmd.Context(), v, entries, nil, secret)
			if err != nil || a.jsonOut {
				return err
			}
			keys := make([]string, len(entries))
			for i, e := range entries {
				keys[i] = e.Key
			}
			fmt.Fprintf(a.IO.Out, "Set %s on %s. Run `roundhouse deploy` to apply.\n", strings.Join(keys, ", "), label)
			return nil
		},
	}
	v.register(cmd)
	cmd.Flags().BoolVar(&secret, "secret", false, "mark the variables secret (masked in listings and logs)")
	return cmd
}

// parseAssignments parses KEY=VALUE arguments, reading at most one "-"
// value from stdin.
func (a *App) parseAssignments(args []string) ([]dotenv.Entry, error) {
	var out []dotenv.Entry
	stdinUsed := false
	for _, arg := range args {
		key, value, ok := strings.Cut(arg, "=")
		if !ok {
			return nil, exitcode.New(exitcode.Usage, "expected KEY=VALUE, got %q", arg)
		}
		if !dotenv.KeyPattern.MatchString(key) {
			return nil, exitcode.New(exitcode.Usage, "invalid variable name %q: use letters, digits and _, not starting with a digit", key)
		}
		if value == "-" {
			if stdinUsed {
				return nil, exitcode.New(exitcode.Usage, "only one value can be read from stdin")
			}
			stdinUsed = true
			data, err := a.IO.ReadAll()
			if err != nil {
				return nil, err
			}
			value = strings.TrimSuffix(strings.TrimSuffix(data, "\n"), "\r")
		}
		out = append(out, dotenv.Entry{Key: key, Value: value})
	}
	return out, nil
}

// putVariables sends sets and deletes in batches and reports the result.
func (a *App) putVariables(ctx context.Context, v varsFlags, set []dotenv.Entry, del []string, secret bool) (string, error) {
	vt, err := a.resolveVars(ctx, v)
	if err != nil {
		return "", err
	}
	a.submitted = map[string]submittedValue{}
	var sets []api.VariableSet
	for _, e := range set {
		s := api.VariableSet{Key: e.Key, Value: e.Value}
		if secret {
			t := true
			s.IsSecret = &t
		}
		sets = append(sets, s)
		a.submitted[e.Key] = submittedValue{value: e.Value, secret: secret}
	}
	var result []api.Variable
	for len(sets) > 0 || len(del) > 0 {
		n := min(len(sets), maxVariablesPerRequest)
		m := min(len(del), maxVariablesPerRequest-n)
		body := api.VariablesPut{Set: sets[:n], Delete: del[:m]}
		sets, del = sets[n:], del[m:]
		if result, err = vt.sess.client.PutVariables(ctx, vt.scope, vt.env.ID, body); err != nil {
			// Error details may quote a value; hide those that are secret on the server.
			if current, lerr := vt.sess.client.ListVariables(ctx, vt.scope, vt.env.ID); lerr == nil {
				a.markSecretSubmissions(current)
			}
			return "", err
		}
	}
	if a.jsonOut {
		return vt.label, a.printJSON(result)
	}
	return vt.label, nil
}

// markSecretSubmissions hides values of variables that are secret on the
// server from error output, even when --secret was not given.
func (a *App) markSecretSubmissions(current []api.Variable) {
	for _, v := range current {
		if sv, ok := a.submitted[v.Key]; ok && v.IsSecret {
			sv.secret = true
			a.submitted[v.Key] = sv
		}
	}
}

func (a *App) varsUnsetCmd() *cobra.Command {
	var v varsFlags
	cmd := &cobra.Command{
		Use:     "unset KEY...",
		Aliases: []string{"rm", "delete"},
		Short:   "Remove variables",
		Example: `  roundhouse vars unset OLD_FLAG LEGACY_URL
  roundhouse vars unset --shared REGION`,
		Args: minArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			for _, k := range args {
				if !dotenv.KeyPattern.MatchString(k) {
					return exitcode.New(exitcode.Usage, "invalid variable name %q", k)
				}
			}
			label, err := a.putVariables(cmd.Context(), v, nil, slices.Compact(slices.Sorted(slices.Values(args))), false)
			if err != nil {
				return err
			}
			if !a.jsonOut {
				fmt.Fprintf(a.IO.Out, "Removed %s from %s. Run `roundhouse deploy` to apply.\n", strings.Join(args, ", "), label)
			}
			return nil
		},
	}
	v.register(cmd)
	return cmd
}

func (a *App) varsImportCmd() *cobra.Command {
	var v varsFlags
	var secret bool
	cmd := &cobra.Command{
		Use:   "import FILE",
		Short: "Set variables from a .env file",
		Long: `Read KEY=VALUE lines from a .env file (or "-" for stdin) and set them all.
Values are taken literally: ${{…}} references pass through untouched and
there is no $VAR expansion.`,
		Example: `  roundhouse vars import .env
  roundhouse vars import .env.secrets --secret
  op inject -i .env.tpl | roundhouse vars import -`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var content string
			if args[0] == "-" {
				data, err := a.IO.ReadAll()
				if err != nil {
					return err
				}
				content = data
			} else {
				data, err := os.ReadFile(args[0])
				if err != nil {
					return exitcode.Wrap(exitcode.Usage, err)
				}
				content = string(data)
			}
			entries, err := dotenv.Parse(content)
			if err != nil {
				return exitcode.New(exitcode.Usage, "%s: %v", args[0], err)
			}
			if len(entries) == 0 {
				return exitcode.New(exitcode.Usage, "%s has no variables", args[0])
			}
			label, err := a.putVariables(cmd.Context(), v, entries, nil, secret)
			if err != nil {
				return err
			}
			if !a.jsonOut {
				fmt.Fprintf(a.IO.Out, "Imported %s into %s. Run `roundhouse deploy` to apply.\n", plural(len(entries), "variable", "variables"), label)
			}
			return nil
		},
	}
	v.register(cmd)
	cmd.Flags().BoolVar(&secret, "secret", false, "mark every imported variable secret")
	return cmd
}

func (a *App) varsExportCmd() *cobra.Command {
	var v varsFlags
	var reveal bool
	cmd := &cobra.Command{
		Use:   "export",
		Short: "Print variables in .env format",
		Long: `Print variables as a .env file on stdout. Secret values are left out (as
comments) unless --reveal is given, which calls the audited reveal route.
References are printed as written, not resolved.`,
		Example: `  roundhouse vars export > .env.example
  roundhouse vars export --reveal > .env.local
  roundhouse vars export --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			vt, err := a.resolveVars(ctx, v)
			if err != nil {
				return err
			}
			vars, err := vt.sess.client.ListVariables(ctx, vt.scope, vt.env.ID)
			if err != nil {
				return err
			}
			if reveal {
				if vars, err = a.revealAll(ctx, vt, vars); err != nil {
					return err
				}
			}
			if a.jsonOut {
				out := map[string]*string{}
				for _, v := range vars {
					out[v.Key] = v.Value
				}
				return a.printJSON(out)
			}
			var b strings.Builder
			for _, v := range vars {
				if v.Value == nil {
					fmt.Fprintf(&b, "# %s=<secret; export with --reveal>\n", v.Key)
					continue
				}
				b.WriteString(dotenv.Format([]dotenv.Entry{{Key: v.Key, Value: *v.Value}}))
			}
			fmt.Fprint(a.IO.Out, b.String())
			return nil
		},
	}
	v.register(cmd)
	cmd.Flags().BoolVar(&reveal, "reveal", false, "include secret values (audited)")
	return cmd
}
