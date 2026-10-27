package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// shellEscape is the byte that starts a local command: Ctrl-], as in telnet.
const shellEscape = 0x1d

// shellEOT is the terminal's end-of-file character, Ctrl-D.
const shellEOT = 0x04

// shellDetachGrace is how long a detach waits for the relay to confirm the
// session ended before dropping the socket.
const shellDetachGrace = 2 * time.Second

// defaultShellTerm is TERM for an interactive session when the local one is
// unset, as it usually is on Windows.
const defaultShellTerm = "xterm-256color"

// Limits of the agent's exec, from packages/protocol/src/limits.ts.
const (
	maxShellArgs         = 32
	maxShellCommandBytes = 4096
	maxShellCols         = 1000
	maxShellRows         = 500
)

// termNameRE is the TERM values the relay accepts.
var termNameRE = regexp.MustCompile(`^[A-Za-z0-9._+-]{1,64}$`)

// runningStates are workload states whose container runs.
var runningStates = []string{"running", "healthy", "unhealthy"}

func (a *App) shellCmd() *cobra.Command {
	var f targetFlags
	var replica int
	cmd := &cobra.Command{
		Use:   "shell [SERVICE] [-- COMMAND [ARGS...]]",
		Short: "Open a shell in a running replica",
		Long: `Open a shell inside one of the service's running containers, through the
control plane and the server's agent. With a command after --, run that
instead of a login shell; its arguments are passed as they are, never
through a shell.

The service is SERVICE, --service or the linked one. --replica picks the
replica; by default it is the lowest-numbered running one.

On a terminal the session is interactive: keys go to the remote program
as typed (Ctrl-C included) and window size changes follow. Exit the shell
to end the session, or press Ctrl-] then q to disconnect; Ctrl-] twice
sends one Ctrl-]. With stdin piped, it is sent to the program as input, and
at its end the CLI sends Ctrl-D, which ends a shell or cat reading it as
on a terminal.

The exit code is the remote program's own. Opening a shell needs the
shell:open permission (workspace owners and admins), two-factor
authentication, and a sign-in within the last 10 minutes; an API token
works too, outside protected environments. Sessions are recorded in the
audit log; what you type and see is never written to the CLI's --debug
output.`,
		Example: `  roundhouse shell
  roundhouse shell api --replica 1
  roundhouse shell --environment staging -- rails console
  roundhouse shell worker -- ls -la /app
  echo 'SELECT 1;' | roundhouse shell db -- psql -U postgres`,
		Args: func(cmd *cobra.Command, args []string) error {
			if before, _ := splitAtDash(cmd, args); len(before) > 1 {
				return exitcode.New(exitcode.Usage, "put the command after --, e.g. `roundhouse shell %s -- %s`", before[0], strings.Join(before[1:], " "))
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			before, command := splitAtDash(cmd, args)
			if err := serviceArg(&f, before); err != nil {
				return err
			}
			if cmd.Flags().Changed("replica") && replica < 0 {
				return exitcode.New(exitcode.Usage, "--replica must not be negative")
			}
			if err := checkShellCommand(command); err != nil {
				return err
			}
			return a.runShell(cmd.Context(), f, replica, cmd.Flags().Changed("replica"), command)
		},
	}
	f.register(cmd, true)
	cmd.Flags().IntVar(&replica, "replica", 0, "replica number (default: the lowest running one)")
	return cmd
}

// splitAtDash splits positional arguments at `--`.
func splitAtDash(cmd *cobra.Command, args []string) (before, after []string) {
	if dash := cmd.ArgsLenAtDash(); dash >= 0 {
		return args[:dash], args[dash:]
	}
	return args, nil
}

// serviceArg takes an optional positional SERVICE into f.service.
func serviceArg(f *targetFlags, args []string) error {
	if len(args) == 0 {
		return nil
	}
	if f.service != "" && f.service != args[0] {
		return exitcode.New(exitcode.Usage, "the service is given twice: %q and --service %q", args[0], f.service)
	}
	f.service = args[0]
	return nil
}

func (a *App) runShell(ctx context.Context, f targetFlags, replica int, haveReplica bool, command []string) error {
	t, err := a.resolve(ctx, f, serviceRequired)
	if err != nil {
		return err
	}
	c := t.sess.client
	st, err := c.ShellTargets(ctx, t.service.ID, t.env.ID)
	if err != nil {
		return err
	}
	if !st.Gate.Allowed {
		return a.shellDenied(deref(st.Gate.Reason), t)
	}
	target, err := pickShellTarget(st.Targets, replica, haveReplica, t)
	if err != nil {
		return err
	}

	tty := a.Terminal != nil && a.Terminal.IsTerminal()
	opts := api.ShellOptions{Command: command}
	if termName := a.Getenv("TERM"); termNameRE.MatchString(termName) {
		opts.Term = termName
	}
	if tty {
		opts.Cols, opts.Rows = 80, 24
		if cols, rows, err := a.Terminal.Size(); err == nil {
			opts.Cols, opts.Rows = clampSize(cols, rows)
		}
		if opts.Term == "" {
			opts.Term = defaultShellTerm
		}
	}
	sh, err := c.DialShell(ctx, target.WorkloadID, opts)
	if err != nil {
		return err
	}
	defer sh.CloseNow()
	s := &shellSession{app: a, sh: sh, tty: tty, service: t.service.Name, target: target}
	err = s.run(ctx)
	return a.shellError(err, t, target)
}

// pickShellTarget chooses the replica to open a shell in: the one asked
// for, else the lowest-numbered running one whose agent supports shells.
func pickShellTarget(targets []api.ShellTarget, replica int, haveReplica bool, t *target) (*api.ShellTarget, error) {
	if len(targets) == 0 {
		return nil, exitcode.New(exitcode.NotFound, "%s has no replicas in %s; deploy it first", t.service.Name, t.env.Name)
	}
	targets = slices.Clone(targets)
	slices.SortStableFunc(targets, func(x, y api.ShellTarget) int { return x.Replica - y.Replica })
	candidates := targets
	if haveReplica {
		candidates = slices.DeleteFunc(slices.Clone(targets), func(x api.ShellTarget) bool { return x.Replica != replica })
		if len(candidates) == 0 {
			var have []string
			for _, x := range targets {
				if s := strconv.Itoa(x.Replica); !slices.Contains(have, s) {
					have = append(have, s)
				}
			}
			return nil, exitcode.New(exitcode.NotFound, "%s has no replica %d in %s; its replicas are %s", t.service.Name, replica, t.env.Name, strings.Join(have, ", "))
		}
	}
	running := slices.DeleteFunc(slices.Clone(candidates), func(x api.ShellTarget) bool { return !slices.Contains(runningStates, x.State) })
	for i := range running {
		if running[i].ShellSupported {
			return &running[i], nil
		}
	}
	if len(running) > 0 {
		err := exitcode.New(exitcode.Unavailable, "the agent on %s is too old for shells", nodeLabel(running[0]))
		return nil, withHint(err, "upgrade the agent on that server (`roundhouse servers list` shows its version), then retry")
	}
	if haveReplica {
		return nil, exitcode.New(exitcode.Conflict, "replica %d of %s is %s, not running", replica, t.service.Name, candidates[0].State)
	}
	return nil, withHint(exitcode.New(exitcode.Conflict, "%s has no running replica in %s", t.service.Name, t.env.Name),
		"check its deployment with `roundhouse status`")
}

func nodeLabel(x api.ShellTarget) string {
	if x.NodeName != "" {
		return x.NodeName
	}
	return x.NodeID
}

// shellDenied explains a refusal of the shell gate, with the step that
// lifts it.
func (a *App) shellDenied(reason string, t *target) error {
	switch reason {
	case api.ShellDenialReauthRequired:
		return withHint(exitcode.New(exitcode.Unauthenticated, "opening a shell needs a recent sign-in"),
			"run `roundhouse login` again (a shell needs a sign-in within 10 minutes), then retry")
	case api.ShellDenialProtectedEnvironment:
		return withHint(exitcode.New(exitcode.Forbidden, "API tokens can't open shells in protected environments, and %s is protected", t.env.Name),
			"API tokens can't open shells in protected environments; unset "+EnvToken+" and sign in with `roundhouse login`")
	case api.ShellDenialTwoFactorRequired:
		hint := "turn on two-factor authentication in the dashboard's account settings, then run `roundhouse login` again"
		if a.apiToken {
			hint = "the token's creator must turn on two-factor authentication in the dashboard's account settings"
		}
		return withHint(exitcode.New(exitcode.Forbidden, "opening a shell needs two-factor authentication"), hint)
	case api.ShellDenialOAuthToken:
		return exitcode.New(exitcode.Forbidden, "OAuth tokens can't open shells")
	case api.ShellDenialForbidden:
		return withHint(exitcode.New(exitcode.Forbidden, "you may not open shells in %s of %s", t.env.Name, t.project.Name), a.shellForbiddenHint())
	}
	return exitcode.New(exitcode.Forbidden, "the control plane refused a shell (%s)", orDash(reason))
}

func (a *App) shellForbiddenHint() string {
	if a.apiToken {
		return "the API token needs the shell:open scope, and its creator's role must still grant it"
	}
	return "shells need the shell:open permission, which workspace owners and admins hold"
}

// shellError adds the next step to a refused or dropped shell socket.
func (a *App) shellError(err error, t *target, x *api.ShellTarget) error {
	var closed *api.ShellClosedError
	if !errors.As(err, &closed) {
		return err
	}
	switch closed.Code {
	case api.ShellCloseReauthRequired:
		return a.shellDenied(api.ShellDenialReauthRequired, t)
	case api.ShellCloseTwoFactorRequired:
		return a.shellDenied(api.ShellDenialTwoFactorRequired, t)
	case api.ShellCloseProtectedEnvironment:
		return a.shellDenied(api.ShellDenialProtectedEnvironment, t)
	case api.CloseForbidden:
		return withHint(err, a.shellForbiddenHint())
	case api.CloseNotFound:
		return withHint(err, "a new deployment may have replaced the replica; run the command again")
	case api.ShellCloseBusy:
		return withHint(err, fmt.Sprintf("%s runs its maximum number of shell sessions; end one or retry later", nodeLabel(*x)))
	case api.ShellCloseAgentOutdated:
		return withHint(err, fmt.Sprintf("upgrade the agent on %s (`roundhouse servers list` shows its version), then retry", nodeLabel(*x)))
	case api.ShellCloseNodeUnavailable:
		return withHint(err, fmt.Sprintf("the agent on %s is not connected; check `roundhouse servers list`, then retry", nodeLabel(*x)))
	}
	return err
}

// -----------------------------------------------------------------------------
// Session
// -----------------------------------------------------------------------------

// shellSession relays one open shell between the local streams and the
// socket.
//
// SECURITY: input and output bytes go only to the socket and stdout; they
// are never logged, at any verbosity.
type shellSession struct {
	app     *App
	sh      *api.Shell
	tty     bool
	service string
	target  *api.ShellTarget

	// detached is set once the user pressed the escape sequence.
	detached atomic.Bool
}

// run relays until the session ends and returns the exit to report: nil, a
// silent error carrying the remote exit code, or why it ended.
func (s *shellSession) run(ctx context.Context) error {
	a := s.app
	first, err := s.sh.Read(ctx)
	if err != nil {
		return err
	}
	restore := func() {}
	if s.tty {
		if m := first.Message; m != nil && m.Type == "opened" {
			s.printOpened(m)
		}
		if restore, err = a.Terminal.MakeRaw(); err != nil {
			return fmt.Errorf("could not switch the terminal to raw mode: %w", err)
		}
	}
	defer restore()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if s.tty {
		go s.followResize(ctx)
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				restore()
				panic(r)
			}
		}()
		s.pumpInput(ctx)
	}()

	var exit *api.ShellMessage
	frame := first
	for {
		switch {
		case frame.Output != nil:
			if _, err := a.IO.Out.Write(frame.Output); err != nil {
				return err
			}
		case frame.Message != nil && frame.Message.Type == "exit":
			exit = frame.Message
		}
		frame, err = s.sh.Read(ctx)
		if err != nil {
			break
		}
	}
	restore()
	switch {
	case exit != nil:
		if s.detached.Load() {
			fmt.Fprintln(a.IO.Err, "Disconnected.")
		}
		return shellExit(exit)
	case s.detached.Load():
		fmt.Fprintln(a.IO.Err, "Disconnected.")
		return nil
	case errors.Is(err, api.ErrShellEnded):
		return exitcode.New(exitcode.Network, "the shell ended without an exit status")
	}
	return err
}

func (s *shellSession) printOpened(m *api.ShellMessage) {
	node := m.NodeName
	if node == "" {
		node = nodeLabel(*s.target)
	}
	user := m.User
	if user == "" {
		user = "the image's user"
	}
	fmt.Fprintf(s.app.IO.Err, "Connected to %s replica %d on %s as %s. Exit the shell or press Ctrl-] then q to disconnect.\n",
		s.service, m.Replica, node, user)
}

// followResize sends the window size after each change.
func (s *shellSession) followResize(ctx context.Context) {
	changes := s.app.Terminal.WatchResize(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-changes:
			if cols, rows, err := s.app.Terminal.Size(); err == nil {
				cols, rows = clampSize(cols, rows)
				_ = s.sh.Resize(ctx, cols, rows)
			}
		}
	}
}

// pumpInput sends stdin as binary frames of at most
// [api.MaxShellInputFrame] bytes, watching for the escape sequence on a
// terminal.
func (s *shellSession) pumpInput(ctx context.Context) {
	// One byte of room: a held-back Ctrl-] is sent with the next read.
	buf := make([]byte, api.MaxShellInputFrame-1)
	var esc escapeFilter
	for {
		n, err := s.app.IO.In.Read(buf)
		if n > 0 {
			data := buf[:n]
			detach := false
			if s.tty {
				data, detach = esc.filter(data)
			}
			if len(data) > 0 {
				if s.sh.Input(ctx, data) != nil {
					return
				}
			}
			if detach {
				s.detach(ctx)
				return
			}
		}
		if err != nil {
			// NOTE: the remote side always has a terminal, so piped input
			// ends the way it would when typed: with Ctrl-D. A TTY's own
			// EOF just stops reading.
			if errors.Is(err, io.EOF) && !s.tty {
				_ = s.sh.Input(ctx, []byte{shellEOT})
			}
			return
		}
	}
}

// detach asks the relay to end the session, then drops the socket if it
// does not answer in time, so a hung session can always be left.
func (s *shellSession) detach(ctx context.Context) {
	s.detached.Store(true)
	_ = s.sh.End(ctx)
	select {
	case <-ctx.Done():
	case <-time.After(shellDetachGrace):
		_ = s.sh.CloseNow()
	}
}

// escapeFilter strips the local escape sequence from typed input: Ctrl-]
// then q detaches, Ctrl-] twice sends one Ctrl-], and Ctrl-] then any other
// byte sends both. The state carries across reads.
type escapeFilter struct {
	pending bool
}

func (e *escapeFilter) filter(p []byte) ([]byte, bool) {
	out := make([]byte, 0, len(p)+1)
	for _, b := range p {
		if e.pending {
			e.pending = false
			switch b {
			case 'q', 'Q':
				return out, true
			case shellEscape:
				out = append(out, shellEscape)
			default:
				out = append(out, shellEscape, b)
			}
			continue
		}
		if b == shellEscape {
			e.pending = true
			continue
		}
		out = append(out, b)
	}
	return out, false
}

// shellExit turns the relay's `exit` message into the CLI's result.
func shellExit(m *api.ShellMessage) error {
	if m.Code != nil {
		if *m.Code == 0 {
			return nil
		}
		return exitcode.Silent(*m.Code)
	}
	detail := ""
	if m.Message != nil && *m.Message != "" {
		detail = ": " + *m.Message
	}
	switch m.Reason {
	case "exited", "closed":
		return nil
	case "idle_timeout":
		return exitcode.New(exitcode.Error, "the shell was closed after being idle too long%s", detail)
	case "max_duration":
		return exitcode.New(exitcode.Error, "the shell reached its maximum duration%s", detail)
	case "revoked":
		return exitcode.New(exitcode.Forbidden, "the shell was closed because your access changed%s", detail)
	case "node_disconnected":
		return exitcode.New(exitcode.Network, "the server's agent disconnected%s", detail)
	case "timeout":
		return exitcode.New(exitcode.Network, "the server's agent did not start the shell in time%s", detail)
	}
	return exitcode.New(exitcode.Error, "the shell ended with an error (%s)%s", orDash(m.Reason), detail)
}

// checkShellCommand applies the agent's rules for an exec command, so a bad
// one fails before a session is opened.
func checkShellCommand(argv []string) error {
	if len(argv) == 0 {
		return nil
	}
	if argv[0] == "" {
		return exitcode.New(exitcode.Usage, "the command after -- must not start with an empty argument")
	}
	if len(argv) > maxShellArgs {
		return exitcode.New(exitcode.Usage, "the command has %d arguments; at most %d are allowed", len(argv), maxShellArgs)
	}
	total := 0
	for _, a := range argv {
		if strings.ContainsRune(a, 0) {
			return exitcode.New(exitcode.Usage, "the command's arguments must not contain NUL bytes")
		}
		total += len(a)
	}
	if total > maxShellCommandBytes {
		return exitcode.New(exitcode.Usage, "the command is %d bytes long; at most %d are allowed", total, maxShellCommandBytes)
	}
	return nil
}

// clampSize keeps a window size within what the agent accepts.
func clampSize(cols, rows int) (int, int) {
	return min(max(cols, 1), maxShellCols), min(max(rows, 1), maxShellRows)
}
