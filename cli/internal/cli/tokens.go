package cli

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// defaultTokenExpiry is the lifetime of a token created without --expires.
const defaultTokenExpiry = "90d"

func (a *App) tokensCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "tokens",
		Aliases: []string{"token"},
		Short:   "Manage the workspace's API tokens",
		Long: `API tokens authenticate CI and scripts without a login. A token belongs to
one workspace and carries scopes (RBAC actions); a request outside its
workspace or scopes is refused. Use one by setting ROUNDHOUSE_TOKEN.

Managing tokens needs the tokens:manage permission in the workspace.`,
		Example: `  roundhouse tokens list
  roundhouse tokens create --name ci --preset deploy --expires 90d
  roundhouse tokens revoke ci`,
		Args: noArgs,
	}

	var listWorkspace string
	list := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the workspace's API tokens",
		Long:    `List the workspace's API tokens, newest first, revoked and expired ones included.`,
		Example: `  roundhouse tokens list
  roundhouse tokens list --workspace acme --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			sess, ws, err := a.tokenWorkspace(ctx, listWorkspace)
			if err != nil {
				return err
			}
			tokens, err := sess.client.ListAPITokens(ctx, ws.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(tokens)
			}
			if len(tokens) == 0 {
				fmt.Fprintf(a.IO.Out, "No API tokens in %s. Create one with `roundhouse tokens create`.\n", ws.Name)
				return nil
			}
			c := a.IO.OutColor()
			now := a.Now().UnixMilli()
			t := a.newTable("name", "id", "prefix", "scopes", "last used", "expires", "status")
			for _, tok := range tokens {
				lastUsed := "never"
				if tok.LastUsedAt != nil {
					lastUsed = ago(a.Now(), *tok.LastUsedAt)
				}
				expires := "never"
				if tok.ExpiresAt != nil {
					expires = millis(*tok.ExpiresAt).Format("2006-01-02")
				}
				state := tok.State(now)
				if state != "active" {
					state = c.Dim(state)
				}
				t.row(tok.Name, tok.ID, orDash(deref(tok.Prefix)), describeScopes(tok.Scopes), lastUsed, expires, state)
			}
			t.flush()
			return nil
		},
	}
	list.Flags().StringVarP(&listWorkspace, "workspace", "w", "", "workspace ID, slug or name")

	var o tokenCreateOptions
	create := &cobra.Command{
		Use:   "create",
		Short: "Create an API token and print its secret once",
		Long: `Create an API token in the workspace. Pick its scopes with --preset (read:
browse projects, services, logs and masked variables; deploy: read plus
deploying and changing services and variables) and/or --scope, which may be
repeated. You can only grant scopes your own role holds.

The secret is printed to stdout, alone, so it can be captured; it is shown
this once and cannot be retrieved later. Store it in your CI's secret store
as ROUNDHOUSE_TOKEN.`,
		Example: `  roundhouse tokens create --name ci --preset deploy
  roundhouse tokens create --name dashboards --preset read --expires never
  roundhouse tokens create --name audit --scope workspace:read --scope audit:read --expires 30d
  roundhouse tokens create --name ci --preset deploy --json | jq -r .secret`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return a.runTokenCreate(cmd.Context(), o)
		},
	}
	create.Flags().StringVarP(&o.workspace, "workspace", "w", "", "workspace ID, slug or name")
	create.Flags().StringVar(&o.name, "name", "", "token name, e.g. the CI system that uses it (prompted when omitted)")
	create.Flags().StringArrayVar(&o.scopes, "scope", nil, "scope to grant, e.g. services:read (repeatable)")
	create.Flags().StringVar(&o.preset, "preset", "", "scope preset: read or deploy")
	create.Flags().StringVar(&o.expires, "expires", defaultTokenExpiry, "lifetime in days (1d to 366d), or never")
	_ = create.RegisterFlagCompletionFunc("scope", func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
		return api.APITokenScopes, cobra.ShellCompDirectiveNoFileComp
	})
	_ = create.RegisterFlagCompletionFunc("preset", cobra.FixedCompletions([]string{"read", "deploy"}, cobra.ShellCompDirectiveNoFileComp))

	var revokeWorkspace string
	var yes bool
	revoke := &cobra.Command{
		Use:     "revoke TOKEN",
		Aliases: []string{"rm", "delete"},
		Short:   "Revoke an API token",
		Long: `Revoke a token by ID or name. Anything using it is refused from the next
request on. Asks for confirmation unless --yes is given.`,
		Example: `  roundhouse tokens revoke ci
  roundhouse tokens revoke tok_01J9Z6Y4M0V8 --yes`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.runTokenRevoke(cmd.Context(), revokeWorkspace, args[0], yes)
		},
	}
	revoke.Flags().StringVarP(&revokeWorkspace, "workspace", "w", "", "workspace ID, slug or name")
	revoke.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")

	cmd.AddCommand(list, create, revoke)
	return cmd
}

// tokenWorkspace connects and picks the workspace whose tokens are managed.
func (a *App) tokenWorkspace(ctx context.Context, ref string) (*session, *api.Membership, error) {
	sess, err := a.connect()
	if err != nil {
		return nil, nil, err
	}
	ws, err := a.findWorkspace(ctx, sess.client, ref)
	if err != nil {
		return nil, nil, err
	}
	return sess, ws, nil
}

type tokenCreateOptions struct {
	workspace string
	name      string
	scopes    []string
	preset    string
	expires   string
}

// tokenScopes combines a preset and individual scopes, preset first,
// without duplicates.
func tokenScopes(preset string, scopes []string) ([]string, error) {
	var out []string
	if preset != "" {
		p, ok := api.APITokenPresets[preset]
		if !ok {
			return nil, exitcode.New(exitcode.Usage, "unknown --preset %q: use read or deploy", preset)
		}
		out = slices.Clone(p)
	}
	for _, s := range scopes {
		if !slices.Contains(api.APITokenScopes, s) {
			return nil, exitcode.New(exitcode.Usage, "unknown --scope %q; scopes are: %s", s, strings.Join(api.APITokenScopes, ", "))
		}
		if !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	return out, nil
}

// parseTokenExpiry turns --expires into days; nil means never.
func parseTokenExpiry(s string) (*int, error) {
	if strings.EqualFold(s, "never") {
		return nil, nil
	}
	days, err := strconv.Atoi(strings.TrimSuffix(s, "d"))
	if err != nil || days < 1 || days > api.MaxAPITokenDays {
		return nil, exitcode.New(exitcode.Usage, "invalid --expires %q: use a number of days from 1d to %dd, or never", s, api.MaxAPITokenDays)
	}
	return &days, nil
}

func (a *App) runTokenCreate(ctx context.Context, o tokenCreateOptions) error {
	scopes, err := tokenScopes(o.preset, o.scopes)
	if err != nil {
		return err
	}
	expires, err := parseTokenExpiry(o.expires)
	if err != nil {
		return err
	}
	sess, ws, err := a.tokenWorkspace(ctx, o.workspace)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(o.name)
	if name == "" {
		if name, err = a.IO.Prompt("Token name:", "", "pass --name"); err != nil {
			return err
		}
		if name = strings.TrimSpace(name); name == "" {
			return exitcode.New(exitcode.Usage, "the token needs a name")
		}
	}
	if len(scopes) == 0 {
		presets := []string{"read", "deploy"}
		i, err := a.IO.Select("Which scopes?", []string{
			"read: browse projects, services, logs and masked variables",
			"deploy: read, plus deploy and change services and variables",
		}, "pass --preset read|deploy or --scope")
		if err != nil {
			return err
		}
		scopes = slices.Clone(api.APITokenPresets[presets[i]])
	}
	created, err := sess.client.CreateAPIToken(ctx, ws.ID, api.CreateAPITokenInput{Name: name, Scopes: scopes, ExpiresInDays: expires})
	if err != nil {
		return err
	}
	if a.jsonOut {
		writeJSON(a.IO.Out, created)
	} else {
		c := a.IO.ErrColor()
		until := "never expires"
		if created.Token.ExpiresAt != nil {
			until = "expires " + millis(*created.Token.ExpiresAt).Format("2006-01-02")
		}
		fmt.Fprintf(a.IO.Err, "%s Created token %s (%s) in %s; %s\n  Scopes: %s\n",
			c.Green("✓"), c.Bold(created.Token.Name), created.Token.ID, ws.Name, until, strings.Join(created.Token.Scopes, ", "))
		fmt.Fprintln(a.IO.Out, created.Secret)
	}
	a.IO.Warn("copy the secret now: it will not be shown again. Use it as %s=<secret>.", EnvToken)
	return nil
}

func (a *App) runTokenRevoke(ctx context.Context, workspace, ref string, yes bool) error {
	sess, ws, err := a.tokenWorkspace(ctx, workspace)
	if err != nil {
		return err
	}
	tokens, err := sess.client.ListAPITokens(ctx, ws.ID)
	if err != nil {
		return err
	}
	tok, err := findToken(tokens, ref, a.Now().UnixMilli())
	if err != nil {
		return err
	}
	if tok.RevokedAt != nil {
		if a.jsonOut {
			return a.printJSON(map[string]string{"revoked": tok.ID})
		}
		fmt.Fprintf(a.IO.Out, "Token %s (%s) was already revoked\n", tok.Name, tok.ID)
		return nil
	}
	if !yes {
		label := fmt.Sprintf("Revoke token %s (%s, %s)? Anything using it stops working at once.", tok.Name, tok.ID, orDash(deref(tok.Prefix)))
		ok, err := a.IO.Confirm(label, false, "pass --yes")
		if err != nil {
			return err
		}
		if !ok {
			return exitcode.New(exitcode.Error, "revoke aborted")
		}
	}
	if err := sess.client.RevokeAPIToken(ctx, ws.ID, tok.ID); err != nil {
		return err
	}
	if a.jsonOut {
		return a.printJSON(map[string]string{"revoked": tok.ID})
	}
	fmt.Fprintf(a.IO.Out, "Revoked token %s (%s)\n", tok.Name, tok.ID)
	return nil
}

// findToken picks a token by ID, else by name. Names need not be unique, so
// a name matching several tokens that are still usable is ambiguous; usable
// tokens win over revoked or expired ones of the same name.
func findToken(tokens []api.APIToken, ref string, now int64) (*api.APIToken, error) {
	var byName, usable []*api.APIToken
	for i := range tokens {
		t := &tokens[i]
		if t.ID == ref {
			return t, nil
		}
		if strings.EqualFold(t.Name, ref) {
			byName = append(byName, t)
			if t.State(now) == "active" {
				usable = append(usable, t)
			}
		}
	}
	candidates := usable
	if len(candidates) == 0 {
		candidates = byName
	}
	switch len(candidates) {
	case 0:
		return nil, exitcode.New(exitcode.NotFound, "no API token %q in this workspace", ref)
	case 1:
		return candidates[0], nil
	}
	return nil, exitcode.New(exitcode.Usage, "%d tokens are named %q; pass the token ID (see `roundhouse tokens list`)", len(candidates), ref)
}

// describeScopes names a scope set by its preset when it is exactly one.
func describeScopes(scopes []string) string {
	for _, name := range []string{"read", "deploy"} {
		p := api.APITokenPresets[name]
		if len(p) == len(scopes) && !slices.ContainsFunc(scopes, func(s string) bool { return !slices.Contains(p, s) }) {
			return name
		}
	}
	return plural(len(scopes), "scope", "scopes")
}
