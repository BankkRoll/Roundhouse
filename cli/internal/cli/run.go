package cli

import (
	"context"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
	"github.com/BankkRoll/Roundhouse/cli/internal/varref"
)

// Built-in variable names, from BUILTIN_VARIABLES in packages/shared. The
// deployment and commit built-ins are left out: `run` involves neither.
const (
	builtinPort          = "PORT"
	builtinPublicDomain  = "ROUNDHOUSE_PUBLIC_DOMAIN"
	builtinPrivateDomain = "ROUNDHOUSE_PRIVATE_DOMAIN"
	builtinEnvironment   = "ROUNDHOUSE_ENVIRONMENT"
	builtinServiceName   = "ROUNDHOUSE_SERVICE_NAME"
)

// privateDomainTemplate mirrors privateDomain() in
// apps/api/src/lib/desired-state.ts: `<service>.<environment>.internal`.
const privateDomainTemplate = "%s.%s.internal"

func (a *App) runCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:   "run -- COMMAND [ARGS...]",
		Short: "Run a local command with the service's variables",
		Long: `Run a command on this machine with the linked service's variables in its
environment, resolved as a deployment would resolve them: references to other
services and shared variables are followed, and built-ins such as PORT and
ROUNDHOUSE_PRIVATE_DOMAIN are set. ROUNDHOUSE_DEPLOYMENT_ID and
ROUNDHOUSE_GIT_COMMIT_SHA are not, since no deployment is involved.

Secret values are revealed through the audited reveal route (only those the
service's variables need) and are passed to the child process alone: they are
never written to disk. The exit code is the command's own.`,
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
			env, revealed, err := a.resolveServiceEnv(ctx, t)
			if err != nil {
				return err
			}
			a.IO.Warn("injecting %s from %s (%s) into `%s`; %s revealed (audited) and passed only to this process, never written to disk",
				plural(len(env), "variable", "variables"), t.service.Name, t.env.Name, args[0], plural(revealed, "secret was", "secrets were"))
			merged := slices.Clone(a.Environ())
			keys := make([]string, 0, len(env))
			for k := range env {
				keys = append(keys, k)
			}
			slices.Sort(keys)
			for _, k := range keys {
				merged = append(merged, k+"="+env[k])
			}
			code, err := a.Exec(ctx, args, merged, a.IO)
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

// envResolver gathers exactly the values a service's environment needs:
// its own variables, then whatever they reference, transitively. Secrets
// are revealed only when reached.
type envResolver struct {
	a        *App
	ctx      context.Context
	t        *target
	bySlug   map[string]*api.Service
	scopes   map[string]*scopeVars
	builtins map[string]map[string]string
	pending  map[string][]string
	revealed int
}

// scopeVars is one namespace's variables: listed metadata and the plaintext
// known so far.
type scopeVars struct {
	scope api.VariableScope
	meta  map[string]api.Variable
	raw   map[string]string
	// needed marks keys already queued, so each is scanned once.
	needed map[string]bool
}

// resolveServiceEnv returns the target service's resolved environment and
// how many secrets were revealed to build it.
func (a *App) resolveServiceEnv(ctx context.Context, t *target) (map[string]string, int, error) {
	r := &envResolver{
		a: a, ctx: ctx, t: t,
		bySlug:   map[string]*api.Service{},
		scopes:   map[string]*scopeVars{},
		builtins: map[string]map[string]string{},
		pending:  map[string][]string{},
	}
	for i := range t.project.Services {
		s := &t.project.Services[i]
		r.bySlug[s.Slug] = s
	}
	self := t.service.Slug
	own, err := r.load(self)
	if err != nil {
		return nil, 0, err
	}
	if err := r.loadBuiltins(self); err != nil {
		return nil, 0, err
	}
	for _, k := range slices.Sorted(maps.Keys(own.meta)) {
		if err := r.need(self, k); err != nil {
			return nil, 0, err
		}
	}
	if err := r.drain(); err != nil {
		return nil, 0, err
	}

	in := varref.Input{Service: self, Services: map[string]map[string]string{}, Builtins: r.builtins}
	for ns, sv := range r.scopes {
		if ns == varref.SharedNamespace {
			in.Shared = sv.raw
		} else {
			in.Services[ns] = sv.raw
		}
	}
	env, errs := varref.Resolve(in)
	if len(errs) > 0 {
		var b strings.Builder
		for _, e := range errs {
			fmt.Fprintf(&b, "\n  %s", e.Error())
		}
		return nil, 0, exitcode.New(exitcode.Invalid, "cannot resolve the variables of %s:%s", t.service.Name, b.String())
	}
	return env, r.revealed, nil
}

// load lists a namespace's variables once. It returns nil for a slug that
// is not a live service (an unknown reference, reported by Resolve).
func (r *envResolver) load(ns string) (*scopeVars, error) {
	if sv, ok := r.scopes[ns]; ok {
		return sv, nil
	}
	var scope api.VariableScope
	if ns == varref.SharedNamespace {
		scope.ProjectID = r.t.project.ID
	} else if svc, ok := r.bySlug[ns]; ok {
		scope.ServiceID = svc.ID
	} else {
		return nil, nil
	}
	vars, err := r.t.sess.client.ListVariables(r.ctx, scope, r.t.env.ID)
	if err != nil {
		return nil, err
	}
	sv := &scopeVars{scope: scope, meta: map[string]api.Variable{}, raw: map[string]string{}, needed: map[string]bool{}}
	for _, v := range vars {
		sv.meta[v.Key] = v
		if v.Value != nil {
			sv.raw[v.Key] = *v.Value
		}
	}
	r.scopes[ns] = sv
	return sv, nil
}

// loadBuiltins computes a service's built-ins the way the deploy workflow
// does: PORT from its config, the public domain from its oldest domain.
func (r *envResolver) loadBuiltins(slug string) error {
	if _, ok := r.builtins[slug]; ok {
		return nil
	}
	svc, ok := r.bySlug[slug]
	if !ok {
		return nil
	}
	c := r.t.sess.client
	b := map[string]string{
		builtinPrivateDomain: fmt.Sprintf(privateDomainTemplate, slug, r.t.env.Slug),
		builtinEnvironment:   r.t.env.Slug,
		builtinServiceName:   svc.Name,
	}
	cfg, err := c.ServiceConfig(r.ctx, svc.ID, r.t.env.ID)
	if err != nil && !api.IsStatus(err, http.StatusNotFound) {
		return err
	}
	if cfg != nil && cfg.Networking.Port != nil {
		b[builtinPort] = fmt.Sprint(*cfg.Networking.Port)
	}
	domains, err := c.ListDomains(r.ctx, svc.ID, r.t.env.ID)
	if err != nil {
		return err
	}
	// The workflow picks the first domain by ID; IDs sort by creation time.
	slices.SortFunc(domains, func(x, y api.Domain) int { return strings.Compare(x.ID, y.ID) })
	if len(domains) > 0 {
		b[builtinPublicDomain] = domains[0].Hostname
	}
	r.builtins[slug] = b
	return nil
}

// need queues a variable: scanned now if its plaintext is known, revealed
// later if it is secret.
func (r *envResolver) need(ns, key string) error {
	sv, err := r.load(ns)
	if err != nil || sv == nil {
		return err
	}
	if sv.needed[key] {
		return nil
	}
	if _, ok := sv.meta[key]; !ok {
		if ns != varref.SharedNamespace {
			return r.loadBuiltins(ns)
		}
		return nil
	}
	sv.needed[key] = true
	if raw, ok := sv.raw[key]; ok {
		return r.scan(ns, raw)
	}
	r.pending[ns] = append(r.pending[ns], key)
	return nil
}

// scan queues every variable a value references.
func (r *envResolver) scan(ns, value string) error {
	refs, _ := varref.Parse(value)
	for _, ref := range refs {
		target := ref.Namespace
		if target == "" {
			target = ns
		}
		if err := r.need(target, ref.Name); err != nil {
			return err
		}
	}
	return nil
}

// drain reveals queued secrets, scanning each for further references, until
// nothing is pending.
func (r *envResolver) drain() error {
	for len(r.pending) > 0 {
		ns := slices.Sorted(maps.Keys(r.pending))[0]
		keys := r.pending[ns]
		delete(r.pending, ns)
		sv := r.scopes[ns]
		values, err := r.a.reveal(r.ctx, r.t.sess.client, sv.scope, r.t.env.ID, keys)
		if err != nil {
			return err
		}
		r.revealed += len(values)
		for _, k := range keys {
			v, ok := values[k]
			if !ok {
				continue
			}
			sv.raw[k] = v
			if err := r.scan(ns, v); err != nil {
				return err
			}
		}
	}
	return nil
}
