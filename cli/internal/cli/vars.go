package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/dotenv"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// maxVariablesPerRequest is the API's limit on set and delete lists.
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

Every variable is plain or secret. Secrets are write-only: no command, API
route or dashboard page can show their value again, so listings show a
fingerprint instead (equal values have equal fingerprints). The control
plane picks a new variable's tier from its name and value; --secret and
--plain override it. Values may reference other variables with
${{service.NAME}}, ${{shared.NAME}} or ${{NAME}}; references are stored as
written and resolved at deploy time.`,
		Example: `  roundhouse vars
  roundhouse vars set NODE_ENV=production PORT=8080
  roundhouse vars set --secret STRIPE_KEY=-  < stripe.key
  roundhouse vars set 'DATABASE_URL=${{db.DATABASE_URL}}'
  roundhouse vars import .env.production --secret
  roundhouse vars export > .env.example`,
		Args: noArgs,
	}
	var v varsFlags
	cmd.RunE = func(cmd *cobra.Command, _ []string) error { return a.runVarsGet(cmd.Context(), nil, v) }
	v.register(cmd)
	cmd.AddCommand(a.varsGetCmd(), a.varsSetCmd(), a.varsUnsetCmd(), a.varsImportCmd(), a.varsExportCmd())
	return cmd
}

func (a *App) varsGetCmd() *cobra.Command {
	var v varsFlags
	cmd := &cobra.Command{
		Use:   "get [KEY]",
		Short: "List variables, or print one",
		Long: `List the scope's variables, or print one variable's value. A secret prints
as <secret fp:…>, its fingerprint: secret values are write-only.`,
		Example: `  roundhouse vars get
  roundhouse vars get DATABASE_URL
  roundhouse vars get --shared --json`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error { return a.runVarsGet(cmd.Context(), args, v) },
	}
	v.register(cmd)
	return cmd
}

// runVarsGet lists a scope's variables, or prints the one named in args.
func (a *App) runVarsGet(ctx context.Context, args []string, flags varsFlags) error {
	vt, err := a.resolveVars(ctx, flags)
	if err != nil {
		return err
	}
	vars, err := vt.sess.client.ListVariables(ctx, vt.scope, vt.env.ID)
	if err != nil {
		return err
	}
	if len(args) == 1 {
		return a.printOneVariable(vt, vars, args[0])
	}
	if a.jsonOut {
		return a.printJSON(vars)
	}
	if len(vars) == 0 {
		fmt.Fprintf(a.IO.Out, "No variables on %s\n", vt.label)
		return nil
	}
	c := a.IO.OutColor()
	t := a.newTable("key", "tier", "value")
	for _, v := range vars {
		value := deref(v.Value)
		switch {
		case v.Withheld:
			value = c.Dim(withheldValue)
		case v.Secret() || v.Value == nil:
			value = c.Dim(maskedValue(v))
		case strings.ContainsAny(value, "\n\r"):
			value = strings.NewReplacer("\r", `\r`, "\n", `\n`).Replace(value)
		}
		t.row(v.Key, tierLabel(v), value)
	}
	t.flush()
	return nil
}

// tierLabel is a variable's tier followed by its settings, e.g.
// "secret (build, file)".
func tierLabel(v api.Variable) string {
	var notes []string
	if v.AvailableAtBuild {
		notes = append(notes, "build")
	}
	if v.MountAsFile {
		notes = append(notes, "file")
	}
	if v.Locked {
		notes = append(notes, "locked")
	}
	if len(notes) == 0 {
		return v.Tier
	}
	return v.Tier + " (" + strings.Join(notes, ", ") + ")"
}

// withheldValue stands in for a preview placeholder's empty value.
const withheldValue = "<withheld from preview>"

// maskedValue stands in for a value the caller can't read: <secret fp:…>
// for a secret, <hidden fp:…> for a plain value without
// variables:read_plain.
func maskedValue(v api.Variable) string {
	kind := "hidden"
	if v.Secret() {
		kind = "secret"
	}
	if v.Fingerprint == nil {
		return "<" + kind + ">"
	}
	return "<" + kind + " fp:" + *v.Fingerprint + ">"
}

func (a *App) printOneVariable(vt *varsTarget, vars []api.Variable, key string) error {
	i := slices.IndexFunc(vars, func(v api.Variable) bool { return v.Key == key })
	if i < 0 {
		return exitcode.New(exitcode.NotFound, "no variable %s on %s", key, vt.label)
	}
	v := vars[i]
	if a.jsonOut {
		return a.printJSON(v)
	}
	switch {
	case v.Withheld:
		fmt.Fprintln(a.IO.Out, withheldValue)
		a.IO.Info("%s was withheld from this preview: its value in the base environment is a secret or derived from one, so the preview got an empty value.", key)
		return nil
	case v.Secret():
		fmt.Fprintln(a.IO.Out, maskedValue(v))
		a.IO.Info("%s is a secret: its value is write-only and can't be shown.", key)
		return nil
	case v.Value == nil:
		return exitcode.New(exitcode.Forbidden, "%s's value is hidden: reading plain values needs the variables:read_plain permission", key)
	}
	fmt.Fprintln(a.IO.Out, *v.Value)
	return nil
}

// writeFlags are the tier and setting options of `vars set` and
// `vars import`.
type writeFlags struct {
	cmd       *cobra.Command
	secret    bool
	plain     bool
	build     bool
	file      bool
	yes       bool
	ackPublic bool
}

func (w *writeFlags) register(cmd *cobra.Command, what string) {
	w.cmd = cmd
	f := cmd.Flags()
	f.BoolVar(&w.secret, "secret", false, "store "+what+" as write-only secrets")
	f.BoolVar(&w.plain, "plain", false, "store "+what+" as plain, readable values")
	f.BoolVar(&w.build, "build", false, "pass "+what+" to builds (secrets as BuildKit secrets); --build=false stops")
	f.BoolVar(&w.file, "mount-as-file", false, "deliver "+what+" as /run/secrets/KEY files instead of environment variables")
	f.BoolVarP(&w.yes, "yes", "y", false, "confirm without asking when the control plane makes a value secret")
	f.BoolVar(&w.ackPublic, "acknowledge-public", false, "store public-prefix variables (VITE_, NEXT_PUBLIC_, …) whose values look like credentials")
}

func (w *writeFlags) validate() error {
	if w.secret && w.plain {
		return exitcode.New(exitcode.Usage, "--secret and --plain can't be combined")
	}
	return nil
}

// tier is the tier to request, or "" to let the control plane decide.
func (w *writeFlags) tier() string {
	switch {
	case w.secret:
		return api.TierSecret
	case w.plain:
		return api.TierPlain
	}
	return ""
}

// changesSettings reports whether a key without a value still changes
// something.
func (w *writeFlags) changesSettings() bool {
	return w.secret || w.plain || w.cmd.Flags().Changed("build") || w.cmd.Flags().Changed("mount-as-file")
}

func (w *writeFlags) entry(key string, value *string) api.VariableSet {
	s := api.VariableSet{Key: key, Value: value, Tier: w.tier()}
	if w.cmd.Flags().Changed("build") {
		s.AvailableAtBuild = &w.build
	}
	if w.cmd.Flags().Changed("mount-as-file") {
		s.MountAsFile = &w.file
	}
	return s
}

func (a *App) varsSetCmd() *cobra.Command {
	var v varsFlags
	var w writeFlags
	cmd := &cobra.Command{
		Use:   "set KEY=VALUE...",
		Short: "Set variables",
		Long: `Create or overwrite variables. A value of "-" is read from stdin (one
trailing newline is removed), which keeps secrets out of shell history and
the process list. References like ${{db.DATABASE_URL}} are stored as written;
quote them so the shell leaves them alone.

Without --secret or --plain, an existing secret stays secret and anything
else gets the tier the control plane picks from the name and value: names
like API_KEY and values like known credential formats become secrets. A
value becoming secret is write-only from then on, so the CLI asks first;
--yes (or --secret) confirms. Some tiers are locked: public-prefix
variables (VITE_, NEXT_PUBLIC_, …) are always plain, recognised credentials
always secret.

A bare KEY, without =VALUE, changes only the tier or settings of an existing
variable; making a secret plain needs the value again. Changes take effect
on the next deployment.`,
		Example: `  roundhouse vars set NODE_ENV=production LOG_LEVEL=info
  roundhouse vars set --secret API_KEY=-  < key.txt
  roundhouse vars set --secret --build NPM_TOKEN=-  < npm-token.txt
  roundhouse vars set --secret DATABASE_URL
  roundhouse vars set 'DATABASE_URL=${{db.DATABASE_URL}}'
  roundhouse vars set --shared REGION=eu-west`,
		Args: minArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := w.validate(); err != nil {
				return err
			}
			entries, err := a.parseAssignments(args, w.changesSettings())
			if err != nil {
				return err
			}
			label, err := a.putVariables(cmd.Context(), v, &w, entries, nil)
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
	w.register(cmd, "the variables")
	return cmd
}

// parseAssignments parses KEY=VALUE arguments, reading at most one "-"
// value from stdin. A bare KEY is accepted, with a nil value, only when
// bareKeys is set.
func (a *App) parseAssignments(args []string, bareKeys bool) ([]api.VariableSet, error) {
	var out []api.VariableSet
	stdinUsed := false
	for _, arg := range args {
		key, value, ok := strings.Cut(arg, "=")
		if !ok && !bareKeys {
			return nil, exitcode.New(exitcode.Usage, "expected KEY=VALUE, got %q", arg)
		}
		if !dotenv.KeyPattern.MatchString(key) {
			return nil, exitcode.New(exitcode.Usage, "invalid variable name %q: use letters, digits and _, not starting with a digit", key)
		}
		if !ok {
			out = append(out, api.VariableSet{Key: key})
			continue
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
		out = append(out, api.VariableSet{Key: key, Value: &value})
	}
	return out, nil
}

// putVariables sends sets and deletes in batches the API accepts and reports
// the result. When the control plane would make a value secret that the
// user didn't ask to be, it asks before resending with confirm_write_only.
//
// NOTE: batches commit one by one, so a refusal after the first leaves the
// earlier ones applied; only writes over 256 keys are affected.
func (a *App) putVariables(ctx context.Context, v varsFlags, w *writeFlags, set []api.VariableSet, del []string) (string, error) {
	vt, err := a.resolveVars(ctx, v)
	if err != nil {
		return "", err
	}
	a.submitted = map[string]submittedValue{}
	var sets []api.VariableSet
	for _, e := range set {
		s := e
		if w != nil {
			s = w.entry(e.Key, e.Value)
		}
		sets = append(sets, s)
		if e.Value != nil {
			a.submitted[e.Key] = submittedValue{value: *e.Value, secret: w != nil && w.secret}
		}
	}
	confirmed := w != nil && (w.secret || w.yes)
	result := &api.VariablesPutResult{}
	for len(sets) > 0 || len(del) > 0 {
		n := min(len(sets), maxVariablesPerRequest)
		m := min(len(del), maxVariablesPerRequest-n)
		body := api.VariablesPut{Set: sets[:n], Delete: del[:m], ConfirmWriteOnly: confirmed}
		if w != nil && w.ackPublic {
			for _, s := range body.Set {
				body.AcknowledgePublic = append(body.AcknowledgePublic, s.Key)
			}
		}
		res, err := vt.sess.client.PutVariables(ctx, vt.scope, vt.env.ID, body)
		if err != nil {
			retry, cerr := a.confirmWriteOnly(err, confirmed, "nothing stored; pass --plain to keep the values readable")
			if cerr != nil {
				return "", cerr
			}
			if retry {
				confirmed = true
				continue
			}
			// Error details may quote a value; hide those that are secret on the server.
			if current, lerr := vt.sess.client.ListVariables(ctx, vt.scope, vt.env.ID); lerr == nil {
				a.markSecretSubmissions(current)
			}
			return "", err
		}
		sets, del = sets[n:], del[m:]
		result.Variables = res.Variables
		result.Warnings = append(result.Warnings, res.Warnings...)
	}
	if result.Warnings == nil {
		result.Warnings = []api.VariableWarning{}
	}
	if a.jsonOut {
		return vt.label, a.printJSON(result)
	}
	for _, wn := range result.Warnings {
		a.IO.Warn("%s: %s", wn.Key, wn.Message)
	}
	var secrets []string
	for _, rv := range result.Variables {
		if rv.Secret() && slices.ContainsFunc(set, func(s api.VariableSet) bool { return s.Key == rv.Key }) {
			secrets = append(secrets, rv.Key)
		}
	}
	if len(secrets) > 0 {
		a.IO.Info("Write-only, never shown again: %s.", strings.Join(secrets, ", "))
	}
	return vt.label, nil
}

// confirmWriteOnly handles a confirmation_required refusal: on a terminal it
// asks whether the listed keys may become write-only and reports whether to
// resend; declined is the error message when the answer is no. Any other
// error, or no terminal, is left to the caller.
func (a *App) confirmWriteOnly(err error, confirmed bool, declined string) (retry bool, _ error) {
	var apiErr *api.Error
	if confirmed || !errors.As(err, &apiErr) || apiErr.Code != "confirmation_required" || !a.IO.Interactive() || a.jsonOut {
		return false, nil
	}
	keys := make([]string, 0, len(apiErr.Details))
	for _, d := range apiErr.Details {
		keys = append(keys, d.Field)
	}
	what := strings.Join(keys, ", ") + " looks secret and will be write-only"
	if len(keys) > 1 {
		what = strings.Join(keys, ", ") + " look secret and will be write-only"
	}
	ok, cerr := a.IO.Confirm(what+": nobody, you included, can read the value back. Store as secret?", false, "pass --yes")
	if cerr != nil {
		return false, cerr
	}
	if !ok {
		return false, exitcode.New(exitcode.Error, "%s", declined)
	}
	return true, nil
}

// markSecretSubmissions hides values of variables that are secret on the
// server from error output, even when --secret was not given.
func (a *App) markSecretSubmissions(current []api.Variable) {
	for _, v := range current {
		if sv, ok := a.submitted[v.Key]; ok && v.Secret() {
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
			label, err := a.putVariables(cmd.Context(), v, nil, nil, slices.Compact(slices.Sorted(slices.Values(args))))
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
	var w writeFlags
	cmd := &cobra.Command{
		Use:   "import FILE",
		Short: "Set variables from a .env file",
		Long: `Read KEY=VALUE lines from a .env file (or "-" for stdin) and set them all.
Values are taken literally: ${{…}} references pass through untouched and
there is no $VAR expansion. Tiers are picked as for ` + "`vars set`" + `.`,
		Example: `  roundhouse vars import .env
  roundhouse vars import .env.secrets --secret
  op inject -i .env.tpl | roundhouse vars import - --secret`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := w.validate(); err != nil {
				return err
			}
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
			set := make([]api.VariableSet, len(entries))
			for i, e := range entries {
				set[i] = api.VariableSet{Key: e.Key, Value: &e.Value}
			}
			label, err := a.putVariables(cmd.Context(), v, &w, set, nil)
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
	w.register(cmd, "every imported variable")
	return cmd
}

func (a *App) varsExportCmd() *cobra.Command {
	var v varsFlags
	cmd := &cobra.Command{
		Use:   "export",
		Short: "Print plain variables in .env format",
		Long: `Print the scope's plain variables as a .env file on stdout. References are
printed as written, not resolved.

Secrets are write-only, so they are never exported: they are left out and
their keys listed on stderr. ` + "`roundhouse run`" + ` reads them from a local .env.`,
		Example: `  roundhouse vars export > .env.example
  roundhouse vars export --shared
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
			var entries []dotenv.Entry
			var secrets, hidden, withheld []string
			for _, v := range vars {
				switch {
				case v.Withheld:
					withheld = append(withheld, v.Key)
				case v.Secret():
					secrets = append(secrets, v.Key)
				case v.Value == nil:
					hidden = append(hidden, v.Key)
				default:
					entries = append(entries, dotenv.Entry{Key: v.Key, Value: *v.Value})
				}
			}
			if a.jsonOut {
				out := map[string]string{}
				for _, e := range entries {
					out[e.Key] = e.Value
				}
				err = a.printJSON(out)
			} else {
				fmt.Fprint(a.IO.Out, dotenv.Format(entries))
			}
			if len(secrets) > 0 {
				a.IO.Info("Left out %s, which can't be read back: %s", plural(len(secrets), "secret", "secrets"), strings.Join(secrets, ", "))
			}
			if len(hidden) > 0 {
				a.IO.Info("Left out %s whose values need the variables:read_plain permission: %s",
					plural(len(hidden), "variable", "variables"), strings.Join(hidden, ", "))
			}
			if len(withheld) > 0 {
				a.IO.Info("Left out %s withheld from this preview: %s",
					plural(len(withheld), "variable", "variables"), strings.Join(withheld, ", "))
			}
			return err
		},
	}
	v.register(cmd)
	return cmd
}
