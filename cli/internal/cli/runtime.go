package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// providerLabels name the providers in prose.
var providerLabels = map[string]string{
	api.ProviderNodes:      "your servers",
	api.ProviderCloudflare: "Cloudflare Containers",
}

func providerLabel(p string) string {
	if l, ok := providerLabels[p]; ok {
		return l
	}
	return p
}

func (a *App) runtimeCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:   "runtime [SERVICE]",
		Short: "Show where a service runs, or move it to Cloudflare Containers",
		Long: `Show whether the service runs on your servers or on Cloudflare
Containers in the environment, whether it is eligible for Cloudflare and
why not, and on Cloudflare its Worker, instances and recent rollouts.

The service is SERVICE, --service or the linked one. "runtime set" moves it
between the two; the next deployment applies the change.`,
		Example: `  roundhouse runtime
  roundhouse runtime web --environment staging --json
  roundhouse runtime set cloudflare --max-instances 5 --sleep-after 30m
  roundhouse runtime set nodes --yes`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := serviceArg(&f, args); err != nil {
				return err
			}
			ctx := cmd.Context()
			t, err := a.resolve(ctx, f, serviceRequired)
			if err != nil {
				return err
			}
			st, err := t.sess.client.ServiceCloudflare(ctx, t.service.ID, t.env.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(st)
			}
			a.printRuntime(t, st)
			return nil
		},
	}
	f.register(cmd, true)
	cmd.AddCommand(a.runtimeSetCmd())
	return cmd
}

func (a *App) printRuntime(t *target, st *api.CloudflareStatus) {
	pal := a.IO.OutColor()
	fmt.Fprintf(a.IO.Out, "%s in %s runs on %s\n", pal.Bold(t.service.Name), t.env.Name, providerLabel(st.Provider))
	row := func(k, v string) { fmt.Fprintf(a.IO.Out, "  %-12s %s\n", k, v) }
	if st.Configured {
		row("Cloudflare", pal.Green("set up"))
	} else {
		row("Cloudflare", pal.Yellow("not set up")+"; an instance admin connects an account in the dashboard")
	}
	if len(st.Eligibility) == 0 {
		row("Eligible", pal.Green("yes"))
	} else {
		row("Eligible", pal.Red("no"))
		for _, e := range st.Eligibility {
			fmt.Fprintf(a.IO.Out, "    %s %s: %s\n", pal.Red("✗"), e.Rule, e.Message)
		}
	}
	for _, w := range st.Warnings {
		row("Warning", pal.Yellow(w))
	}
	if r := st.Runtime; r != nil {
		fmt.Fprintln(a.IO.Out)
		fmt.Fprintln(a.IO.Out, pal.Bold("Worker"))
		row("Script", r.ScriptName)
		row("Status", pal.Status(r.Status))
		row("Generation", strconv.Itoa(r.Generation))
		if r.ApplicationID != nil {
			row("Application", *r.ApplicationID)
		}
		if len(r.Routes) > 0 {
			row("Routes", strings.Join(r.Routes, ", "))
		}
		if r.WorkersDevURL != nil {
			row("workers.dev", *r.WorkersDevURL)
		}
		if n := r.Instances; n != nil {
			row("Instances", fmt.Sprintf("%d running of %d", n.Running, n.Total))
		}
	}
	if len(st.Deployments) > 0 {
		fmt.Fprintln(a.IO.Out)
		fmt.Fprintln(a.IO.Out, pal.Bold("Recent rollouts"))
		tbl := a.newTable("deployment", "status", "instance", "max", "image", "created")
		for _, d := range st.Deployments {
			image := deref(d.ImageDigest)
			if image == "" {
				image = d.ImageRef
			}
			tbl.row(d.DeploymentID, d.Status, d.InstanceType, strconv.Itoa(d.MaxInstances), orDash(shortDigest(image)), ago(a.Now(), d.CreatedAt))
		}
		tbl.flush()
		for _, d := range st.Deployments {
			if d.Error != nil && *d.Error != "" {
				fmt.Fprintf(a.IO.Out, "  %s %s: %s\n", pal.Red("✗"), d.DeploymentID, *d.Error)
			}
		}
	}
}

// shortDigest shortens "sha256:<hex>" to 12 hex digits.
func shortDigest(s string) string {
	if hex, ok := strings.CutPrefix(s, "sha256:"); ok && len(hex) > 12 {
		return "sha256:" + hex[:12]
	}
	return s
}

// runtimeSetOptions are the flags of `runtime set`.
type runtimeSetOptions struct {
	instanceType string
	maxInstances int
	sleepAfter   string
	regions      []string
	yes          bool
}

func (a *App) runtimeSetCmd() *cobra.Command {
	var f targetFlags
	var o runtimeSetOptions
	cmd := &cobra.Command{
		Use:   "set nodes|cloudflare [SERVICE]",
		Short: "Run a service on your servers or on Cloudflare Containers",
		Long: `Choose where the service runs in the environment: "nodes" (your
servers) or "cloudflare" (Cloudflare Containers, which the instance must
have set up). The change is saved as a new config version and applied by
the next deployment.

For cloudflare, --instance-type picks the size (lite, basic, standard-1 to
standard-4; by default the smallest that fits the service's resources),
--max-instances the pool size (1 to 100; deploy.replicas no longer
applies), --sleep-after how long an idle instance stays up (1m to 24h,
default 10m) and --region where instances may run (repeat it). Settings
left out keep their saved values.

Only app services with a port, no volume, no TCP proxy and only generated
or Cloudflare for SaaS domains can run on Cloudflare; "roundhouse runtime"
lists the rules a service fails. Switching provider asks first; --yes
confirms.`,
		Example: `  roundhouse runtime set cloudflare
  roundhouse runtime set cloudflare web --instance-type standard-1 --max-instances 5
  roundhouse runtime set cloudflare --sleep-after 30m --region enam --region weur
  roundhouse runtime set nodes --yes`,
		Args: func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 || len(args) > 2 {
				return exitcode.New(exitcode.Usage, "%s takes nodes or cloudflare and an optional service\n\n%s", cmd.CommandPath(), cmd.UseLine())
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			provider := args[0]
			if !slices.Contains(api.ServiceProviders, provider) {
				return exitcode.New(exitcode.Usage, "unknown provider %q; use %s", provider, strings.Join(api.ServiceProviders, " or "))
			}
			if err := serviceArg(&f, args[1:]); err != nil {
				return err
			}
			changed := cmd.Flags().Changed
			if err := o.validate(provider, changed); err != nil {
				return err
			}
			return a.runRuntimeSet(cmd.Context(), f, provider, o, changed)
		},
	}
	f.register(cmd, true)
	fl := cmd.Flags()
	fl.StringVar(&o.instanceType, "instance-type", "", "Cloudflare instance type: "+strings.Join(api.CloudflareInstanceTypes, ", "))
	fl.IntVar(&o.maxInstances, "max-instances", 0, fmt.Sprintf("most instances to run (1-%d)", api.MaxCloudflareInstances))
	fl.StringVar(&o.sleepAfter, "sleep-after", "", "idle time before an instance sleeps, 1m to 24h (e.g. 10m)")
	fl.StringArrayVar(&o.regions, "region", nil, "region an instance may run in (repeatable)")
	fl.BoolVarP(&o.yes, "yes", "y", false, "switch provider without asking")
	return cmd
}

// cloudflareFlags are the `runtime set` flags that only cloudflare takes.
var cloudflareFlags = []string{"instance-type", "max-instances", "sleep-after", "region"}

// validate checks the flags with the API's rules, before anything is sent.
func (o *runtimeSetOptions) validate(provider string, changed func(string) bool) error {
	if provider != api.ProviderCloudflare {
		for _, name := range cloudflareFlags {
			if changed(name) {
				return exitcode.New(exitcode.Usage, "--%s is only for cloudflare", name)
			}
		}
		return nil
	}
	if changed("instance-type") && !slices.Contains(api.CloudflareInstanceTypes, o.instanceType) {
		return exitcode.New(exitcode.Usage, "unknown instance type %q; use one of %s", o.instanceType, strings.Join(api.CloudflareInstanceTypes, ", "))
	}
	if changed("max-instances") && (o.maxInstances < 1 || o.maxInstances > api.MaxCloudflareInstances) {
		return exitcode.New(exitcode.Usage, "--max-instances must be between 1 and %d", api.MaxCloudflareInstances)
	}
	if changed("sleep-after") {
		if _, err := api.ParseSleepAfter(o.sleepAfter); err != nil {
			return exitcode.New(exitcode.Usage, "--sleep-after: %v", err)
		}
	}
	for _, r := range o.regions {
		if !api.CloudflareRegionRE.MatchString(r) {
			return exitcode.New(exitcode.Usage, "--region %q is not a region code (2 to 16 letters, digits or dashes)", r)
		}
	}
	if len(o.regions) > api.MaxCloudflareRegions {
		return exitcode.New(exitcode.Usage, "at most %d --region flags", api.MaxCloudflareRegions)
	}
	return nil
}

func (a *App) runRuntimeSet(ctx context.Context, f targetFlags, provider string, o runtimeSetOptions, changed func(string) bool) error {
	t, err := a.resolve(ctx, f, serviceRequired)
	if err != nil {
		return err
	}
	c := t.sess.client
	cfg, err := c.ServiceConfig(ctx, t.service.ID, t.env.ID)
	if err != nil {
		return err
	}
	var current api.PlacementConfig
	if len(cfg.Placement) > 0 {
		_ = json.Unmarshal(cfg.Placement, &current)
	}
	if current.Provider == "" {
		current.Provider = api.ProviderNodes
	}
	settingsChanged := slices.ContainsFunc(cloudflareFlags, changed)
	if provider == current.Provider && !settingsChanged {
		if a.jsonOut {
			return a.printJSON(api.UpdatedService{Service: *t.service, Config: nil})
		}
		fmt.Fprintf(a.IO.Out, "%s in %s already runs on %s; nothing to change\n", t.service.Name, t.env.Name, providerLabel(provider))
		return nil
	}

	patch := &api.PlacementPatch{Provider: provider}
	if provider == api.ProviderCloudflare {
		st, err := c.ServiceCloudflare(ctx, t.service.ID, t.env.ID)
		if err != nil {
			return err
		}
		if !st.Configured {
			return withHint(exitcode.New(exitcode.Unavailable, "Cloudflare Containers are not set up on this control plane"),
				"an instance admin connects a Cloudflare account in the dashboard's instance settings")
		}
		patch.Cloudflare = mergeCloudflare(current.Cloudflare, cfg.Deploy, o, changed)
	}

	if provider != current.Provider && !o.yes {
		q := fmt.Sprintf("Run %s in %s on Cloudflare Containers? Its next deployment starts there and stops its replicas on your servers.", t.service.Name, t.env.Name)
		if provider == api.ProviderNodes {
			q = fmt.Sprintf("Run %s in %s on your servers? Its next deployment starts there and stops it on Cloudflare.", t.service.Name, t.env.Name)
		}
		ok, err := a.IO.Confirm(q, false, "pass --yes")
		if err != nil {
			return err
		}
		if !ok {
			return exitcode.New(exitcode.Error, "aborted; nothing was changed")
		}
	}

	updated, err := c.UpdateService(ctx, t.service.ID, api.UpdateServiceInput{
		EnvironmentID: t.env.ID, ExpectedVersion: cfg.Version, Placement: patch,
	})
	if err != nil {
		return err
	}
	if a.jsonOut {
		return a.printJSON(updated)
	}
	version := ""
	if updated.Config != nil {
		version = fmt.Sprintf(" (config version %d)", updated.Config.Version)
	}
	fmt.Fprintf(a.IO.Out, "%s %s in %s will run on %s%s\n", a.IO.OutColor().Green("✓"), t.service.Name, t.env.Name, providerLabel(provider), version)
	if cf := patch.Cloudflare; cf != nil {
		row := func(k, v string) { fmt.Fprintf(a.IO.Out, "  %-14s %s\n", k, v) }
		row("Instance type", orDefault(cf.InstanceType, "fits the service's resources"))
		row("Max instances", strconv.Itoa(cf.MaxInstances))
		row("Sleep after", cf.SleepAfter)
		if len(cf.Regions) > 0 {
			row("Regions", strings.Join(cf.Regions, ", "))
		}
	}
	fmt.Fprintf(a.IO.Out, "  Deploy to apply it: roundhouse deploy --service %s --environment %s\n", t.service.Slug, t.env.Slug)
	return nil
}

// mergeCloudflare applies the flags to the saved Cloudflare settings. The
// API replaces `placement.cloudflare` whole, so every field is sent; a
// first switch starts from the service's replica count and the default
// sleep time.
func mergeCloudflare(saved *api.CloudflarePlacement, deploy json.RawMessage, o runtimeSetOptions, changed func(string) bool) *api.CloudflarePlacement {
	cf := api.CloudflarePlacement{MaxInstances: 1, SleepAfter: api.DefaultCloudflareSleepAfter}
	if saved != nil {
		cf = *saved
		cf.Regions = slices.Clone(saved.Regions)
	} else {
		var d struct {
			Replicas int `json:"replicas"`
		}
		if json.Unmarshal(deploy, &d) == nil && d.Replicas > 0 {
			cf.MaxInstances = min(d.Replicas, api.MaxCloudflareInstances)
		}
	}
	if changed("instance-type") {
		cf.InstanceType = o.instanceType
	}
	if changed("max-instances") {
		cf.MaxInstances = o.maxInstances
	}
	if changed("sleep-after") {
		cf.SleepAfter = o.sleepAfter
	}
	if changed("region") {
		cf.Regions = o.regions
	}
	if cf.MaxInstances < 1 {
		cf.MaxInstances = 1
	}
	if cf.SleepAfter == "" {
		cf.SleepAfter = api.DefaultCloudflareSleepAfter
	}
	return &cf
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
