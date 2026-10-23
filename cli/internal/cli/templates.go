package cli

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// templateWriteOnlyHint is the advice for a template deploy refused with
// confirmation_required: templates have no --plain.
const templateWriteOnlyHint = "the template's secrets and generated values are write-only; pass --yes to store them anyway"

func (a *App) templatesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "templates",
		Aliases: []string{"template"},
		Short:   "Browse and deploy templates",
		Long: `Templates are ready-made sets of services and variables built into the
control plane. Deploy one as a new project, or add its services to an
existing project.`,
		Example: `  roundhouse templates list
  roundhouse templates show n8n
  roundhouse templates deploy n8n --input WEBHOOK_URL=https://n8n.example.com`,
		Args: noArgs,
	}

	var listWorkspace string
	list := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the built-in templates",
		Example: `  roundhouse templates list
  roundhouse templates list --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			sess, err := a.connect()
			if err != nil {
				return err
			}
			ws, err := a.findWorkspace(ctx, sess.client, listWorkspace)
			if err != nil {
				return err
			}
			templates, err := sess.client.ListTemplates(ctx, ws.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(templates)
			}
			if len(templates) == 0 {
				fmt.Fprintln(a.IO.Out, "No templates on this control plane.")
				return nil
			}
			c := a.IO.OutColor()
			t := a.newTable("id", "name", "category", "services", "notes")
			for _, tpl := range templates {
				note := "-"
				if !tpl.Supported {
					note = c.Dim("not supported here: needs " + strings.Join(tpl.Requirements, ", "))
				}
				t.row(tpl.ID, tpl.Name, tpl.Category, fmt.Sprint(tpl.ServiceCount), note)
			}
			t.flush()
			return nil
		},
	}
	list.Flags().StringVarP(&listWorkspace, "workspace", "w", "", "workspace ID, slug or name")

	var showWorkspace string
	show := &cobra.Command{
		Use:   "show TEMPLATE",
		Short: "Show a template's inputs, services and variables",
		Long: `Show what a template creates. Secret and generated variables are listed
by name only: their values are entered or minted at deploy time and are
write-only from then on.`,
		Example: `  roundhouse templates show n8n
  roundhouse templates show n8n --json`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			sess, err := a.connect()
			if err != nil {
				return err
			}
			ws, err := a.findWorkspace(ctx, sess.client, showWorkspace)
			if err != nil {
				return err
			}
			d, err := sess.client.GetTemplate(ctx, ws.ID, args[0])
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(d)
			}
			a.printTemplate(d)
			return nil
		},
	}
	show.Flags().StringVarP(&showWorkspace, "workspace", "w", "", "workspace ID, slug or name")

	cmd.AddCommand(list, show, a.templatesDeployCmd())
	return cmd
}

// printTemplate renders a template's detail as text.
func (a *App) printTemplate(d *api.TemplateDetail) {
	c := a.IO.OutColor()
	out := a.IO.Out
	fmt.Fprintf(out, "%s (%s, version %d, %s)\n", c.Bold(d.Name), d.ID, d.Version, d.Category)
	fmt.Fprintln(out, d.Description)
	if d.DocsURL != nil {
		fmt.Fprintf(out, "Docs: %s\n", *d.DocsURL)
	}
	if !d.Supported {
		fmt.Fprintf(out, "%s needs %s, which this control plane doesn't support yet\n", c.Yellow("Not deployable here:"), strings.Join(d.Requirements, " and "))
	}

	fmt.Fprintln(out)
	if len(d.Inputs) == 0 {
		fmt.Fprintln(out, "Inputs: none")
	} else {
		fmt.Fprintln(out, c.Bold("Inputs:"))
		t := a.newTable()
		for _, in := range d.Inputs {
			req := "optional"
			if in.Required {
				req = "required"
			}
			typ := in.Type
			if in.Type == api.InputSelect && len(in.Options) > 0 {
				typ += " (" + strings.Join(in.Options, "|") + ")"
			}
			def := ""
			if in.Default != nil {
				def = "default " + *in.Default
			}
			t.row("  "+in.Key, typ, req, orDash(def), in.Label)
		}
		t.flush()
	}

	fmt.Fprintln(out)
	fmt.Fprintln(out, c.Bold("Services:"))
	for _, s := range d.Services {
		fmt.Fprintf(out, "  %s (%s): %s\n", s.Name, s.Ref, describeTemplateService(s))
		if s.StartCommand != nil {
			fmt.Fprintf(out, "    start: %s\n", *s.StartCommand)
		}
		a.printTemplateVariables("    ", s.Variables)
	}
	if len(d.SharedVariables) > 0 {
		fmt.Fprintln(out)
		fmt.Fprintln(out, c.Bold("Shared variables:"))
		a.printTemplateVariables("  ", d.SharedVariables)
	}
}

func describeTemplateService(s api.TemplateService) string {
	var parts []string
	parts = append(parts, s.Kind)
	switch src := s.Source; src.Type {
	case "image":
		parts = append(parts, "image "+src.Image)
	case "git":
		repo := src.RepoURL + "@" + src.Branch
		if src.RootDir != "" && src.RootDir != "." {
			repo += " (" + src.RootDir + ")"
		}
		parts = append(parts, "git "+repo)
	case "database":
		engine := src.Engine
		if src.Version != nil {
			engine += " " + *src.Version
		}
		parts = append(parts, "database "+engine)
	}
	if s.Port != nil {
		parts = append(parts, fmt.Sprintf("port %d", *s.Port))
	}
	if s.Public {
		parts = append(parts, "public")
	}
	return strings.Join(parts, ", ")
}

// printTemplateVariables lists variables; secret and generated ones show
// only their kind, never a value.
func (a *App) printTemplateVariables(indent string, vars []api.TemplateVariable) {
	if len(vars) == 0 {
		return
	}
	c := a.IO.OutColor()
	t := a.newTable()
	for _, v := range vars {
		var value string
		switch {
		case v.Generated:
			value = c.Dim("(generated)")
		case v.Secret || v.Value == nil:
			value = c.Dim("(secret)")
		default:
			value = *v.Value
		}
		t.row(indent+v.Key, value)
	}
	t.flush()
}

// templateFlags are the deploy options `templates deploy` and
// `init --template` share.
type templateFlags struct {
	inputs    []string
	noDeploy  bool
	yes       bool
	ackPublic bool
}

func (f *templateFlags) register(cmd *cobra.Command) {
	fl := cmd.Flags()
	fl.StringArrayVarP(&f.inputs, "input", "i", nil, "set a template input, KEY=VALUE (repeatable; VALUE \"-\" reads stdin)")
	fl.BoolVar(&f.noDeploy, "no-deploy", false, "create the services without starting their first deployments")
	fl.BoolVarP(&f.yes, "yes", "y", false, "confirm without asking that the template's secrets become write-only")
	fl.BoolVar(&f.ackPublic, "acknowledge-public", false, "store public-prefix variables (VITE_, NEXT_PUBLIC_, …) whose values look like credentials")
}

func (a *App) templatesDeployCmd() *cobra.Command {
	var tf templateFlags
	var target targetFlags
	var workspace, name, slug, description string
	var linked bool
	cmd := &cobra.Command{
		Use:   "deploy TEMPLATE",
		Short: "Deploy a template as a new project, or into an existing one",
		Long: `Create a project (with a production environment) from a template and start
the first deployment of each of its services. With --linked, --project or
--environment, the template's services are added to that project instead,
with their variables in the environment; slugs already taken there are
suffixed -2, -3, … and references follow them.

Inputs are passed with --input KEY=VALUE. Required inputs left out are asked
for on a terminal (secret inputs without echo); in scripts the command fails
and names them. Generated and secret variables are write-only once stored,
so the CLI asks first; --yes confirms.

The directory is not linked; use ` + "`roundhouse init --template`" + ` for that.`,
		Example: `  roundhouse templates deploy whoami
  roundhouse templates deploy n8n --name automations --input WEBHOOK_URL=https://n8n.example.com --yes
  roundhouse templates deploy n8n --input ADMIN_PASSWORD=- < password.txt
  roundhouse templates deploy whoami --linked --environment staging --no-deploy`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			existing := linked || target.project != "" || target.environment != ""
			if existing {
				for _, f := range []string{"workspace", "name", "slug", "description"} {
					if cmd.Flags().Changed(f) {
						return exitcode.New(exitcode.Usage, "--%s names a new project; it can't be combined with --linked, --project or --environment", f)
					}
				}
			}
			inputs, err := a.parseTemplateInputs(tf.inputs)
			if err != nil {
				return err
			}
			if existing {
				t, err := a.resolve(ctx, target, serviceOptional)
				if err != nil {
					return err
				}
				d, err := t.sess.client.GetTemplate(ctx, t.project.WorkspaceID, args[0])
				if err != nil {
					return err
				}
				opts, err := a.templateOptions(d, inputs, tf)
				if err != nil {
					return err
				}
				res, err := a.sendTemplate(&opts, func() (*api.TemplateDeployment, error) {
					return t.sess.client.DeployTemplate(ctx, t.project.ID, api.DeployTemplateInput{
						TemplateID: d.ID, EnvironmentID: t.env.ID, TemplateDeployOptions: opts})
				})
				if err != nil {
					return err
				}
				if a.jsonOut {
					writeJSON(a.IO.Out, res)
				} else {
					fmt.Fprintf(a.IO.Out, "%s Deployed template %s into %s / %s\n", a.IO.OutColor().Green("✓"), d.Name, res.Project.Name, res.Environment.Name)
				}
				return a.reportTemplateDeployment(d, res, false)
			}

			sess, err := a.connect()
			if err != nil {
				return err
			}
			ws, err := a.findWorkspace(ctx, sess.client, workspace)
			if err != nil {
				return err
			}
			res, d, err := a.createFromTemplate(ctx, sess.client, ws.ID, args[0], name, slug, description, inputs, tf)
			if err != nil {
				return err
			}
			if a.jsonOut {
				writeJSON(a.IO.Out, res)
			} else {
				fmt.Fprintf(a.IO.Out, "%s Created project %s (slug %s) from template %s in workspace %s\n",
					a.IO.OutColor().Green("✓"), res.Project.Name, res.Project.Slug, d.Name, ws.Name)
			}
			return a.reportTemplateDeployment(d, res, true)
		},
	}
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "workspace for the new project (ID, slug or name)")
	cmd.Flags().StringVar(&name, "name", "", "new project's name (default: the template's name)")
	cmd.Flags().StringVar(&slug, "slug", "", "new project's slug (default: derived from the name; -2, -3… is added when taken)")
	cmd.Flags().StringVar(&description, "description", "", "new project's description")
	cmd.Flags().BoolVar(&linked, "linked", false, "add the services to the linked project instead of creating one")
	target.register(cmd, false)
	tf.register(cmd)
	return cmd
}

// createFromTemplate fetches a template, completes its inputs and creates a
// project from it.
func (a *App) createFromTemplate(ctx context.Context, c *api.Client, workspaceID, templateID, name, slug, description string,
	inputs map[string]string, tf templateFlags) (*api.TemplateDeployment, *api.TemplateDetail, error) {
	d, err := c.GetTemplate(ctx, workspaceID, templateID)
	if err != nil {
		return nil, nil, err
	}
	opts, err := a.templateOptions(d, inputs, tf)
	if err != nil {
		return nil, nil, err
	}
	res, err := a.sendTemplate(&opts, func() (*api.TemplateDeployment, error) {
		return c.CreateProjectFromTemplate(ctx, workspaceID, api.CreateProjectFromTemplateInput{
			TemplateID: d.ID, Name: name, Slug: slug, Description: description, TemplateDeployOptions: opts})
	})
	return res, d, err
}

// parseTemplateInputs parses --input KEY=VALUE flags, reading at most one
// "-" value from stdin.
func (a *App) parseTemplateInputs(args []string) (map[string]string, error) {
	out := map[string]string{}
	stdinUsed := false
	for _, arg := range args {
		key, value, ok := strings.Cut(arg, "=")
		if !ok || key == "" {
			return nil, exitcode.New(exitcode.Usage, "expected --input KEY=VALUE, got %q", arg)
		}
		if _, dup := out[key]; dup {
			return nil, exitcode.New(exitcode.Usage, "--input %s given twice", key)
		}
		if value == "-" {
			if stdinUsed {
				return nil, exitcode.New(exitcode.Usage, "only one input can be read from stdin")
			}
			stdinUsed = true
			data, err := a.IO.ReadAll()
			if err != nil {
				return nil, err
			}
			value = strings.TrimSuffix(strings.TrimSuffix(data, "\n"), "\r")
		}
		out[key] = value
	}
	return out, nil
}

// templateOptions completes the inputs and builds the deploy options. A
// template this control plane can't deploy is sent as is, so the API's 409
// explains why rather than a prompt for inputs that would go unused.
func (a *App) templateOptions(d *api.TemplateDetail, inputs map[string]string, tf templateFlags) (api.TemplateDeployOptions, error) {
	opts := api.TemplateDeployOptions{Inputs: inputs, Deploy: !tf.noDeploy, ConfirmWriteOnly: tf.yes}
	if d.Supported {
		if err := a.completeInputs(d, inputs); err != nil {
			return opts, err
		}
	}
	if tf.ackPublic {
		for _, v := range templateVariables(d) {
			if !v.Secret && !slices.Contains(opts.AcknowledgePublic, v.Key) {
				opts.AcknowledgePublic = append(opts.AcknowledgePublic, v.Key)
			}
		}
	}
	return opts, nil
}

func templateVariables(d *api.TemplateDetail) []api.TemplateVariable {
	vars := slices.Clone(d.SharedVariables)
	for _, s := range d.Services {
		vars = append(vars, s.Variables...)
	}
	return vars
}

// completeInputs asks for each required input that has no value and no
// default; without a terminal it fails naming all of them.
func (a *App) completeInputs(d *api.TemplateDetail, inputs map[string]string) error {
	var missing []api.TemplateInput
	for _, in := range d.Inputs {
		if in.Required && inputs[in.Key] == "" && deref(in.Default) == "" {
			missing = append(missing, in)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	if !a.IO.Interactive() {
		names := make([]string, len(missing))
		flags := make([]string, len(missing))
		for i, in := range missing {
			names[i] = in.Key + " (" + in.Label + ")"
			flags[i] = "--input " + in.Key + "=…"
		}
		return exitcode.New(exitcode.InputRequired, "template %s needs %s, but input is not interactive; pass %s",
			d.ID, strings.Join(names, ", "), strings.Join(flags, " "))
	}
	for _, in := range missing {
		v, err := a.promptInput(in)
		if err != nil {
			return err
		}
		inputs[in.Key] = v
	}
	return nil
}

// promptInput asks for one required input until it gets a value.
func (a *App) promptInput(in api.TemplateInput) (string, error) {
	label := in.Label + " (" + in.Key + "):"
	if in.Description != nil {
		a.IO.Info("%s", *in.Description)
	}
	hint := "pass --input " + in.Key + "=…"
	for {
		var v string
		var err error
		switch in.Type {
		case api.InputSecret:
			v, err = a.IO.Password(label, hint)
		case api.InputSelect:
			var i int
			if i, err = a.IO.Select(label, in.Options, hint); err == nil {
				v = in.Options[i]
			}
		case api.InputBoolean:
			var yes bool
			if yes, err = a.IO.Confirm(strings.TrimSuffix(label, ":")+"?", false, hint); err == nil {
				v = fmt.Sprint(yes)
			}
		default:
			v, err = a.IO.Prompt(label, "", hint)
		}
		if err != nil || v != "" {
			return v, err
		}
	}
}

// sendTemplate sends a deploy request; when the control plane asks to
// confirm that secrets become write-only, it asks on a terminal and resends
// with confirm_write_only, as `vars set` does.
func (a *App) sendTemplate(opts *api.TemplateDeployOptions, send func() (*api.TemplateDeployment, error)) (*api.TemplateDeployment, error) {
	a.writeOnlyHint = templateWriteOnlyHint
	for {
		res, err := send()
		if err == nil {
			return res, nil
		}
		retry, cerr := a.confirmWriteOnly(err, opts.ConfirmWriteOnly, "nothing created; the template's secrets can only be stored write-only")
		if cerr != nil {
			return nil, cerr
		}
		if !retry {
			return nil, err
		}
		opts.ConfirmWriteOnly = true
	}
}

// reportTemplateDeployment prints what a deploy created after the headline
// (nothing more with --json), and fails when a first deployment did not
// start: the services exist regardless.
func (a *App) reportTemplateDeployment(d *api.TemplateDetail, res *api.TemplateDeployment, newProject bool) error {
	failed := map[string]string{}
	for _, e := range res.DeployErrors {
		failed[e.ServiceID] = e.Message
	}
	if !a.jsonOut {
		c := a.IO.OutColor()
		deployment := map[string]api.Deployment{}
		for _, dep := range res.Deployments {
			deployment[dep.ServiceID] = dep
		}
		t := a.newTable()
		for _, s := range res.Services {
			state := c.Dim("not deployed")
			if dep, ok := deployment[s.ID]; ok {
				state = "deployment " + dep.ID + " " + c.Status(dep.Status)
			} else if msg, ok := failed[s.ID]; ok {
				state = c.Red("deployment did not start: " + msg)
			}
			t.row("  + "+s.Name, s.Slug, s.ID, state)
		}
		t.flush()
		for _, w := range res.Warnings {
			a.IO.Warn("%s: %s", w.Key, w.Message)
		}
		var secrets []string
		for _, v := range templateVariables(d) {
			if v.Secret && !slices.Contains(secrets, v.Key) {
				secrets = append(secrets, v.Key)
			}
		}
		if len(secrets) > 0 {
			a.IO.Info("Write-only, never shown again: %s.", strings.Join(secrets, ", "))
		}
		switch {
		case len(res.Deployments) == 0 && len(failed) == 0 && newProject:
			fmt.Fprintf(a.IO.Out, "  Deploy with: roundhouse deploy --project %s --service <slug>\n", res.Project.Slug)
		case len(res.Deployments) == 0 && len(failed) == 0:
			fmt.Fprintln(a.IO.Out, "  Deploy with: roundhouse deploy --service <slug>")
		}
	}
	if len(failed) == 0 {
		return nil
	}
	var names []string
	for _, s := range res.Services {
		if _, ok := failed[s.ID]; ok {
			names = append(names, s.Slug)
		}
	}
	return exitcode.New(exitcode.Error, "the first deployment of %s did not start; the services were created, so fix the cause and run `roundhouse deploy`",
		strings.Join(names, ", "))
}
