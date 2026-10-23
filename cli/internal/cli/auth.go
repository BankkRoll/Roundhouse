package cli

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Open-Rail/cli/internal/api"
	"github.com/BankkRoll/Open-Rail/cli/internal/config"
	"github.com/BankkRoll/Open-Rail/cli/internal/exitcode"
)

// loginResult is the --json output of login.
type loginResult struct {
	Profile string   `json:"profile"`
	URL     string   `json:"url"`
	User    api.User `json:"user"`
}

func (a *App) loginCmd() *cobra.Command {
	var urlFlag, email string
	var passwordStdin bool
	cmd := &cobra.Command{
		Use:   "login",
		Short: "Sign in to a control plane",
		Long: `Sign in with your email and password. The session cookie is stored in
the credentials file of the selected profile (mode 0600), in your OS config
directory. Use --profile to keep sessions for several control planes.

The password is read without echo. In scripts, pipe it in with
--password-stdin; for CI prefer ROUNDHOUSE_URL and an API token in
ROUNDHOUSE_TOKEN (see "roundhouse tokens create").`,
		Example: `  roundhouse login --url https://roundhouse.example.com
  roundhouse login --url https://staging.example.com --profile staging
  printf '%s' "$PASSWORD" | roundhouse login --url https://cp.example.com --email me@example.com --password-stdin
  roundhouse login --url http://127.0.0.1:8787 --insecure   # local development`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return a.runLogin(cmd.Context(), urlFlag, email, passwordStdin)
		},
	}
	cmd.Flags().StringVar(&urlFlag, "url", "", "control plane URL, e.g. https://roundhouse.example.com")
	cmd.Flags().StringVar(&email, "email", "", "account email (prompted when omitted)")
	cmd.Flags().BoolVar(&passwordStdin, "password-stdin", false, "read the password from stdin")
	return cmd
}

func (a *App) runLogin(ctx context.Context, rawURL, email string, passwordStdin bool) error {
	creds, err := a.loadCreds()
	if err != nil {
		return err
	}
	name := a.profileName()
	prof := creds.Profiles[name]
	if rawURL == "" {
		rawURL = a.Getenv(EnvURL)
	}
	if rawURL == "" && prof != nil {
		rawURL = prof.URL
	}
	if rawURL == "" {
		if rawURL, err = a.IO.Prompt("Control plane URL:", "", "pass --url"); err != nil {
			return err
		}
	}
	insecure := a.insecure || (prof != nil && prof.Insecure && strings.EqualFold(prof.URL, rawURL))
	base, err := api.ParseBaseURL(rawURL, insecure)
	if err != nil {
		return exitcode.Wrap(exitcode.Usage, err)
	}
	if email == "" {
		def := ""
		if prof != nil && prof.User != nil {
			def = prof.User.Email
		}
		if email, err = a.IO.Prompt("Email:", def, "pass --email"); err != nil {
			return err
		}
	}
	var password string
	if passwordStdin {
		data, err := a.IO.ReadAll()
		if err != nil {
			return err
		}
		password = strings.TrimRight(data, "\r\n")
	} else if password, err = a.IO.Password("Password:", "pipe it with --password-stdin"); err != nil {
		return err
	}
	if password == "" {
		return exitcode.New(exitcode.Usage, "empty password")
	}

	client, err := api.New(api.Options{BaseURL: base.String(), Insecure: insecure, UserAgent: a.userAgent(), Logger: a.logger, Transport: a.Transport})
	if err != nil {
		return err
	}
	spin := a.IO.StartSpinner("Signing in to " + base.Host)
	res, err := client.SignIn(ctx, email, password)
	spin.Stop()
	if err != nil {
		if api.IsStatus(err, http.StatusUnauthorized) {
			return exitcode.New(exitcode.Unauthenticated, "invalid email or password")
		}
		return err
	}

	creds.Profiles[name] = &config.Profile{
		URL:      base.String(),
		Insecure: base.Scheme == "http",
		Session: &config.Session{
			CookieName: res.Session.Name,
			Value:      res.Session.Value,
			ExpiresAt:  cookieExpiry(res.Session, a.Now()),
		},
		User: &config.ProfileUser{ID: res.User.ID, Name: res.User.Name, Email: res.User.Email},
	}
	if err := a.saveCreds(); err != nil {
		return fmt.Errorf("save credentials: %w", err)
	}
	if a.jsonOut {
		return a.printJSON(loginResult{Profile: name, URL: base.String(), User: res.User})
	}
	c := a.IO.OutColor()
	fmt.Fprintf(a.IO.Out, "%s Logged in to %s as %s <%s> (profile %s)\n",
		c.Green("✓"), c.Bold(base.String()), res.User.Name, res.User.Email, name)
	return nil
}

// logoutResult is the --json output of logout.
type logoutResult struct {
	Profile   string `json:"profile"`
	URL       string `json:"url,omitempty"`
	SignedOut bool   `json:"signed_out"`
}

func (a *App) logoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Sign out and forget the session",
		Long: `Revoke the session on the control plane and remove it from the
credentials file. The profile's URL is kept, so "roundhouse login" needs no
--url next time. The local session is removed even when the control plane
cannot be reached.`,
		Example: `  roundhouse logout
  roundhouse logout --profile staging`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			creds, err := a.loadCreds()
			if err != nil {
				return err
			}
			name := a.profileName()
			prof := creds.Profiles[name]
			if prof == nil || prof.Session == nil {
				if a.jsonOut {
					return a.printJSON(logoutResult{Profile: name, SignedOut: false})
				}
				fmt.Fprintf(a.IO.Out, "Not logged in (profile %s)\n", name)
				return nil
			}
			client, err := api.New(api.Options{
				BaseURL: prof.URL, Insecure: prof.Insecure, UserAgent: a.userAgent(), Logger: a.logger, Transport: a.Transport,
				Credential: api.SessionCookie{Name: prof.Session.CookieName, Value: prof.Session.Value},
			})
			if err == nil {
				err = client.SignOut(cmd.Context())
			}
			if err != nil && !api.IsStatus(err, http.StatusUnauthorized) {
				a.IO.Warn("could not revoke the session on %s: %v", prof.URL, err)
			}
			prof.Session = nil
			if err := a.saveCreds(); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(logoutResult{Profile: name, URL: prof.URL, SignedOut: true})
			}
			fmt.Fprintf(a.IO.Out, "Logged out of %s (profile %s)\n", prof.URL, name)
			return nil
		},
	}
}

// whoamiResult is the --json output of whoami.
type whoamiResult struct {
	Profile    string           `json:"profile"`
	URL        string           `json:"url"`
	User       api.User         `json:"user"`
	Workspaces []api.Membership `json:"workspaces"`
	// Token is the API token in use; omitted for a session.
	Token *api.MeToken `json:"token,omitempty"`
}

func (a *App) whoamiCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: "Show the signed-in user and their workspaces",
		Example: `  roundhouse whoami
  roundhouse whoami --profile staging --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			sess, err := a.connect()
			if err != nil {
				return err
			}
			me, err := sess.client.Me(cmd.Context())
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(whoamiResult{Profile: sess.profile, URL: sess.url, User: me.User, Workspaces: me.Workspaces, Token: me.Token})
			}
			c := a.IO.OutColor()
			fmt.Fprintf(a.IO.Out, "%s <%s>\n", c.Bold(me.User.Name), me.User.Email)
			via := "profile " + sess.profile
			if sess.fromEnv {
				via = EnvToken
			}
			fmt.Fprintf(a.IO.Out, "Control plane: %s (%s)\n", sess.url, via)
			if tok := me.Token; tok != nil {
				fmt.Fprintf(a.IO.Out, "API token: %s (%s), scopes: %s\n", tok.Name, tok.ID, strings.Join(tok.Scopes, ", "))
			}
			if len(me.Workspaces) > 0 {
				fmt.Fprintln(a.IO.Out, "Workspaces:")
				t := a.newTable()
				for _, w := range me.Workspaces {
					t.row("  "+w.Name, w.Slug, w.Role, w.ID)
				}
				t.flush()
			}
			return nil
		},
	}
}

// noArgs rejects positional arguments with a usage error.
func noArgs(cmd *cobra.Command, args []string) error {
	if len(args) > 0 {
		return exitcode.New(exitcode.Usage, "%s takes no arguments, got %q", cmd.CommandPath(), args[0])
	}
	return nil
}

// maxArgs allows at most n positional arguments.
func maxArgs(n int) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if len(args) > n {
			return exitcode.New(exitcode.Usage, "%s takes at most %d argument(s), got %d", cmd.CommandPath(), n, len(args))
		}
		return nil
	}
}

// exactArgs requires exactly n positional arguments.
func exactArgs(n int) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if len(args) != n {
			return exitcode.New(exitcode.Usage, "%s takes %d argument(s), got %d\n\n%s", cmd.CommandPath(), n, len(args), cmd.UseLine())
		}
		return nil
	}
}

// minArgs requires at least n positional arguments.
func minArgs(n int) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if len(args) < n {
			return exitcode.New(exitcode.Usage, "%s needs at least %d argument(s)\n\n%s", cmd.CommandPath(), n, cmd.UseLine())
		}
		return nil
	}
}
