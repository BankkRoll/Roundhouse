// Package cli implements the roundhouse commands.
//
// Responsibilities:
//   - the cobra command tree, global flags and help text;
//   - choosing a profile, control plane URL and credential (flags, env, the
//     credentials file, the directory link);
//   - resolving the project, environment and service a command acts on;
//   - rendering results as text or stable --json, and errors with exit codes.
//
// Every command reaches the control plane through [api.Client] only.
package cli

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/browser"
	"github.com/BankkRoll/Roundhouse/cli/internal/config"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
	"github.com/BankkRoll/Roundhouse/cli/internal/ui"
)

// Environment variables the CLI reads.
const (
	EnvURL       = "ROUNDHOUSE_URL"
	EnvToken     = "ROUNDHOUSE_TOKEN"
	EnvProfile   = "ROUNDHOUSE_PROFILE"
	EnvConfigDir = "ROUNDHOUSE_CONFIG_DIR"
)

// Env is everything the CLI takes from its process. Tests substitute each
// part; [SystemEnv] returns the real one.
type Env struct {
	IO *ui.IO
	// Getenv reads an environment variable.
	Getenv func(string) string
	// Environ lists the process environment, for `run`.
	Environ func() []string
	// WorkDir is where the link file is looked up and written.
	WorkDir string
	// Version and Commit describe the build.
	Version string
	Commit  string
	// OpenURL opens a URL in a browser.
	OpenURL func(string) error
	// Now returns the current time.
	Now func() time.Time
	// PollInterval is how often `deploy --wait` polls the deployment.
	PollInterval time.Duration
	// Exec runs a child process for `run` and returns its exit code.
	Exec func(ctx context.Context, argv []string, env []string, io *ui.IO) (int, error)
	// Transport overrides the HTTP transport, for tests.
	Transport http.RoundTripper
}

// SystemEnv returns the real process environment.
func SystemEnv(version, commit string) Env {
	wd, _ := os.Getwd()
	return Env{
		IO:           ui.System(os.Getenv),
		Getenv:       os.Getenv,
		Environ:      os.Environ,
		WorkDir:      wd,
		Version:      version,
		Commit:       commit,
		OpenURL:      browser.Open,
		Now:          time.Now,
		PollInterval: 2 * time.Second,
		Exec:         execChild,
	}
}

// App is one CLI invocation.
type App struct {
	Env

	profileFlag string
	jsonOut     bool
	debug       bool
	insecure    bool
	noInput     bool
	noColor     bool

	logger *slog.Logger

	creds     *config.Credentials
	credsPath string

	link       *config.Link
	linkPath   string
	linkLoaded bool

	// relinking skips the check that the link matches the profile, so a
	// directory can be re-linked to another control plane.
	relinking bool

	// submitted holds values sent in the current request, so an
	// invalid_reference error can show where in the value it points.
	submitted map[string]submittedValue
}

type submittedValue struct {
	value  string
	secret bool
}

// Run executes the CLI with args (without the program name) and returns the
// process exit code.
func Run(ctx context.Context, args []string, env Env) int {
	a := &App{Env: env}
	root := a.rootCommand()
	root.SetArgs(args)
	root.SetIn(env.IO.In)
	root.SetOut(env.IO.Out)
	root.SetErr(env.IO.Err)
	err := root.ExecuteContext(ctx)
	if err == nil {
		return exitcode.OK
	}
	err = classify(err)
	if !exitcode.IsSilent(err) {
		a.printError(err)
	}
	return exitcode.Of(err)
}

// classify gives cobra's own errors (unknown command, bad arguments) the
// usage exit code.
func classify(err error) error {
	var c exitcode.Coder
	if errors.As(err, &c) || errors.Is(err, context.Canceled) {
		return err
	}
	msg := err.Error()
	for _, prefix := range []string{"unknown command", "unknown flag", "unknown shorthand flag", "accepts ", "requires at least", "invalid argument", "flag needs an argument", "required flag"} {
		if strings.HasPrefix(msg, prefix) {
			return exitcode.Wrap(exitcode.Usage, err)
		}
	}
	return err
}

const rootLong = `Roundhouse deploys and runs your services on your own servers.

Sign in once with "roundhouse login", link a directory to a project with
"roundhouse link", then deploy, follow logs and manage variables from there.

Environment:
  ROUNDHOUSE_URL         control plane URL, overriding the profile's
  ROUNDHOUSE_TOKEN       credential for CI, overriding the profile's session
  ROUNDHOUSE_PROFILE     profile to use when --profile is not given
  ROUNDHOUSE_CONFIG_DIR  where credentials are stored
  NO_COLOR               disable colour

Exit codes:
  0 ok, 1 error, 2 usage, 3 not signed in, 4 forbidden, 5 not found,
  6 conflict, 7 invalid input, 8 deployment failed, 9 not linked,
  10 not available on this control plane yet, 11 network or server error,
  12 input required in non-interactive mode, 130 interrupted`

func (a *App) rootCommand() *cobra.Command {
	root := &cobra.Command{
		Use:           "roundhouse",
		Short:         "Deploy and manage services on a Roundhouse control plane",
		Long:          rootLong,
		Version:       a.versionString(),
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
			if a.noInput {
				a.IO.DisableInput()
			}
			if a.noColor {
				a.IO.DisableColor()
			}
			if a.debug {
				a.logger = slog.New(slog.NewTextHandler(a.IO.Err, &slog.HandlerOptions{Level: slog.LevelDebug}))
			}
			return nil
		},
	}
	root.SetVersionTemplate("roundhouse {{.Version}}\n")
	root.SetFlagErrorFunc(func(_ *cobra.Command, err error) error {
		return exitcode.Wrap(exitcode.Usage, err)
	})
	pf := root.PersistentFlags()
	pf.StringVar(&a.profileFlag, "profile", "", "credentials profile to use (default \"default\", or $ROUNDHOUSE_PROFILE)")
	pf.BoolVar(&a.jsonOut, "json", false, "print machine-readable JSON")
	pf.BoolVar(&a.debug, "debug", false, "trace HTTP requests to stderr (credentials redacted)")
	pf.BoolVar(&a.insecure, "insecure", false, "allow plain http:// to a loopback control plane (development only)")
	pf.BoolVar(&a.noInput, "no-input", false, "never prompt; fail when input would be needed")
	pf.BoolVar(&a.noColor, "no-color", false, "disable colour (also NO_COLOR)")

	root.AddGroup(
		&cobra.Group{ID: "auth", Title: "Account:"},
		&cobra.Group{ID: "project", Title: "Project:"},
		&cobra.Group{ID: "deploy", Title: "Deploy and observe:"},
		&cobra.Group{ID: "manage", Title: "Manage:"},
	)
	add := func(group string, cmds ...*cobra.Command) {
		for _, c := range cmds {
			c.GroupID = group
			root.AddCommand(c)
		}
	}
	add("auth", a.loginCmd(), a.logoutCmd(), a.whoamiCmd())
	add("project", a.initCmd(), a.linkCmd(), a.unlinkCmd(), a.statusCmd(), a.openCmd())
	add("deploy", a.deployCmd(), a.logsCmd(), a.rollbackCmd(), a.cancelCmd(), a.upCmd())
	add("manage", a.varsCmd(), a.runCmd(), a.projectsCmd(), a.servicesCmd(), a.domainCmd(), a.serversCmd(), a.shellCmd(), a.dbCmd())
	root.AddCommand(a.versionCmd())
	return root
}

func (a *App) versionString() string {
	b := buildInfo(a.Version, a.Commit)
	if b.Commit != "" {
		return b.Version + " (" + b.Commit + ")"
	}
	return b.Version
}

func (a *App) userAgent() string {
	return fmt.Sprintf("roundhouse-cli/%s (%s; %s)", buildInfo(a.Version, "").Version, runtime.GOOS, runtime.GOARCH)
}

// -----------------------------------------------------------------------------
// Profiles and credentials
// -----------------------------------------------------------------------------

func (a *App) profileName() string {
	if a.profileFlag != "" {
		return a.profileFlag
	}
	if p := a.Getenv(EnvProfile); p != "" {
		return p
	}
	if l, _ := a.loadLink(); l != nil && l.Profile != "" {
		return l.Profile
	}
	return config.DefaultProfile
}

func (a *App) loadCreds() (*config.Credentials, error) {
	if a.creds != nil {
		return a.creds, nil
	}
	dir, err := config.Dir(a.Getenv)
	if err != nil {
		return nil, err
	}
	a.credsPath = config.CredentialsPath(dir)
	creds, warning, err := config.LoadCredentials(a.credsPath)
	if warning != "" {
		a.IO.Warn("%s", warning)
	}
	if err != nil {
		return nil, err
	}
	a.creds = creds
	return creds, nil
}

func (a *App) saveCreds() error {
	return a.creds.Save(a.credsPath)
}

func (a *App) loadLink() (*config.Link, error) {
	if a.linkLoaded {
		return a.link, nil
	}
	a.linkLoaded = true
	l, path, err := config.FindLink(a.WorkDir)
	if err != nil {
		return nil, err
	}
	a.link, a.linkPath = l, path
	return l, nil
}

// session describes how a command reaches the control plane.
type session struct {
	client  *api.Client
	profile string
	url     string
	// fromEnv is set when ROUNDHOUSE_TOKEN supplied the credential.
	fromEnv bool
}

// connect builds a client for the active profile, honouring
// ROUNDHOUSE_URL and ROUNDHOUSE_TOKEN.
func (a *App) connect() (*session, error) {
	creds, err := a.loadCreds()
	if err != nil {
		return nil, err
	}
	name := a.profileName()
	prof := creds.Profiles[name]
	s := &session{profile: name}
	insecure := a.insecure
	if prof != nil {
		s.url = prof.URL
		insecure = insecure || prof.Insecure
	}
	if u := a.Getenv(EnvURL); u != "" {
		s.url = u
	}
	if s.url == "" {
		return nil, exitcode.New(exitcode.Unauthenticated, "not signed in (profile %q); run `roundhouse login --url <control-plane>`", name)
	}
	base, err := api.ParseBaseURL(s.url, insecure)
	if err != nil {
		return nil, exitcode.Wrap(exitcode.Usage, err)
	}
	s.url = base.String()
	if l, _ := a.loadLink(); l != nil && !a.relinking && l.URL != "" && !strings.EqualFold(l.URL, s.url) {
		return nil, exitcode.New(exitcode.NotLinked,
			"this directory is linked to a project on %s, but profile %q uses %s; pass --profile or re-link", l.URL, name, s.url)
	}

	opts := api.Options{BaseURL: s.url, Insecure: insecure, UserAgent: a.userAgent(), Logger: a.logger, Transport: a.Transport}
	switch token := a.Getenv(EnvToken); {
	case token != "":
		opts.Credential = tokenCredential(token, base.Scheme == "https")
		s.fromEnv = true
	case prof != nil && prof.Session != nil:
		if exp := prof.Session.ExpiresAt; exp != nil && exp.Before(a.Now()) {
			return nil, exitcode.New(exitcode.Unauthenticated, "the session for %s (profile %q) expired on %s; run `roundhouse login`",
				s.url, name, exp.Local().Format("2006-01-02 15:04"))
		}
		opts.Credential = api.SessionCookie{Name: prof.Session.CookieName, Value: prof.Session.Value}
		opts.OnSessionCookie = a.persistRotatedSession(name)
	default:
		return nil, exitcode.New(exitcode.Unauthenticated, "not signed in to %s (profile %q); run `roundhouse login`", s.url, name)
	}
	if s.client, err = api.New(opts); err != nil {
		return nil, err
	}
	return s, nil
}

// tokenCredential interprets ROUNDHOUSE_TOKEN.
//
// TODO(api-tokens): the API has no token routes yet, so today the value is a
// session token (the session cookie's value) and is sent as the session
// cookie. API tokens will carry the `tok_` ID prefix reserved in
// packages/shared/src/ids.ts and are sent as a bearer token; nothing outside
// this function changes when they ship.
func tokenCredential(token string, https bool) api.Credential {
	if strings.HasPrefix(token, "tok_") {
		return api.BearerToken(token)
	}
	return api.SessionCookie{Name: api.DefaultSessionCookieName(https), Value: token}
}

// persistRotatedSession stores a session cookie the server refreshed, so the
// profile keeps working past the original expiry.
func (a *App) persistRotatedSession(profile string) func(*http.Cookie) {
	return func(ck *http.Cookie) {
		prof := a.creds.Profiles[profile]
		if prof == nil || prof.Session == nil || ck.Value == "" || ck.MaxAge < 0 || ck.Value == prof.Session.Value {
			return
		}
		prof.Session.Value = ck.Value
		prof.Session.ExpiresAt = cookieExpiry(ck, a.Now())
		if err := a.saveCreds(); err != nil {
			a.IO.Warn("could not save the refreshed session: %v", err)
		}
	}
}

func cookieExpiry(ck *http.Cookie, now time.Time) *time.Time {
	switch {
	case ck.MaxAge > 0:
		t := now.Add(time.Duration(ck.MaxAge) * time.Second).UTC()
		return &t
	case !ck.Expires.IsZero():
		t := ck.Expires.UTC()
		return &t
	}
	return nil
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

func (a *App) printError(err error) {
	if errors.Is(err, context.Canceled) {
		fmt.Fprintln(a.IO.Err, "interrupted")
		return
	}
	var apiErr *api.Error
	isAPI := errors.As(err, &apiErr)
	hint := ""
	if isAPI && apiErr.Status == http.StatusUnauthorized && !strings.HasPrefix(apiErr.Code, "invalid_email") {
		hint = "your session expired or was revoked; run `roundhouse login`"
	}
	if a.jsonOut {
		body := map[string]any{"message": err.Error(), "exit_code": exitcode.Of(err)}
		if isAPI {
			body["code"], body["status"] = apiErr.Code, apiErr.Status
			if len(apiErr.Details) > 0 {
				body["details"] = apiErr.Details
			}
		}
		if hint != "" {
			body["hint"] = hint
		}
		writeJSON(a.IO.Err, map[string]any{"error": body})
		return
	}
	c := a.IO.ErrColor()
	msg := err.Error()
	if isAPI && apiErr.Code == "invalid_reference" && len(apiErr.Details) > 0 {
		msg = "invalid variable reference"
	}
	fmt.Fprintf(a.IO.Err, "%s %s\n", c.Red("error:"), msg)
	if isAPI {
		for _, d := range apiErr.Details {
			a.printDetail(d)
		}
	}
	if hint != "" {
		fmt.Fprintf(a.IO.Err, "%s %s\n", c.Dim("hint:"), hint)
	}
}

// printDetail shows one per-field problem; for a reference error with a
// span it underlines the reference within the submitted value. Secret
// values are never echoed: only the offending reference itself is shown.
func (a *App) printDetail(d api.ErrorDetail) {
	c := a.IO.ErrColor()
	fmt.Fprintf(a.IO.Err, "  %s: %s\n", c.Bold(d.Field), d.Message)
	sv, ok := a.submitted[d.Field]
	if !ok || d.Start == nil || d.End == nil {
		return
	}
	start, end := api.UTF16Span(sv.value, *d.Start, *d.End)
	if start >= end {
		return
	}
	shown, offset := sv.value, start
	if sv.secret || strings.ContainsAny(sv.value, "\n\r") || len(sv.value) > 120 {
		shown, offset = sv.value[start:end], 0
	}
	fmt.Fprintf(a.IO.Err, "      %s\n      %s%s\n", shown, strings.Repeat(" ", displayWidth(shown[:offset])),
		c.Red(strings.Repeat("^", max(1, displayWidth(sv.value[start:end])))))
}

func displayWidth(s string) int {
	return len([]rune(s))
}

// -----------------------------------------------------------------------------
// Child processes
// -----------------------------------------------------------------------------

// execChild runs argv with env, wired to the terminal, and returns its exit
// code.
//
// NOTE: Ctrl-C reaches the child straight from the terminal (same process
// group on Unix, same console on Windows), and main's signal handler keeps
// it from killing the CLI first, so the child's own exit status is
// reported. SIGTERM sent to the CLI alone is forwarded.
func execChild(_ context.Context, argv []string, env []string, io *ui.IO) (int, error) {
	path, err := exec.LookPath(argv[0])
	if err != nil {
		return 0, exitcode.Wrap(exitcode.Error, err)
	}
	cmd := exec.Command(path, argv[1:]...)
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = io.In, io.Out, io.Err
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM)
	go func() {
		for sig := range sigs {
			_ = cmd.Process.Signal(sig)
		}
	}()
	defer func() {
		signal.Stop(sigs)
		close(sigs)
	}()
	err = cmd.Wait()
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if code := exitErr.ExitCode(); code >= 0 {
			return code, nil
		}
		return exitcode.Interrupted, nil
	}
	return 0, err
}
