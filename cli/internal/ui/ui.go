// Package ui is the CLI's terminal layer: stream and TTY detection, colour,
// prompts and spinners.
//
// Rules it enforces:
//   - colour only on a TTY, never with NO_COLOR set or TERM=dumb;
//   - spinners only when stderr is a TTY;
//   - prompts only when stdin and stderr are TTYs and input is allowed;
//     otherwise they fail at once with [exitcode.InputRequired] and a hint
//     naming the flag to use instead. A prompt never blocks a script.
package ui

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"golang.org/x/term"

	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// IO bundles the process's streams with what is known about them.
type IO struct {
	In  io.Reader
	Out io.Writer
	Err io.Writer

	inFile      *os.File
	inTTY       bool
	outTTY      bool
	errTTY      bool
	outColor    bool
	errColor    bool
	noInput     bool
	reader      *bufio.Reader
	interactive *bool
}

// System returns an IO over the process's standard streams.
func System(getenv func(string) string) *IO {
	u := &IO{In: os.Stdin, Out: os.Stdout, Err: os.Stderr, inFile: os.Stdin}
	u.inTTY = term.IsTerminal(int(os.Stdin.Fd()))
	u.outTTY = term.IsTerminal(int(os.Stdout.Fd()))
	u.errTTY = term.IsTerminal(int(os.Stderr.Fd()))
	colorOK := getenv("NO_COLOR") == "" && getenv("TERM") != "dumb"
	u.outColor = colorOK && u.outTTY && enableVT(os.Stdout)
	u.errColor = colorOK && u.errTTY && enableVT(os.Stderr)
	// CI systems allocate no TTY, but some fake one; never prompt there.
	if getenv("CI") != "" {
		u.noInput = true
	}
	return u
}

// Test returns an IO over in-memory streams. Nothing is a TTY, so there is
// no colour and prompts fail unless [IO.ForceInteractive] is called.
func Test(stdin string, stdout, stderr io.Writer) *IO {
	return &IO{In: strings.NewReader(stdin), Out: stdout, Err: stderr}
}

// ForceInteractive makes prompts read lines from In, for tests. Passwords
// are read as plain lines.
func (u *IO) ForceInteractive() {
	t := true
	u.interactive = &t
}

// ForceStdoutTTY makes stdout behave as a terminal, with colour when color
// is set, for tests.
func (u *IO) ForceStdoutTTY(color bool) {
	u.outTTY, u.outColor = true, color
}

// DisableInput makes every prompt fail, as --no-input requests.
func (u *IO) DisableInput() { u.noInput = true }

// DisableColor turns colour off, as --no-color requests.
func (u *IO) DisableColor() { u.outColor, u.errColor = false, false }

// Interactive reports whether prompts may be shown.
func (u *IO) Interactive() bool {
	if u.noInput {
		return false
	}
	if u.interactive != nil {
		return *u.interactive
	}
	return u.inTTY && u.errTTY
}

// StdoutTTY reports whether stdout is a terminal.
func (u *IO) StdoutTTY() bool { return u.outTTY }

// StderrTTY reports whether stderr is a terminal.
func (u *IO) StderrTTY() bool { return u.errTTY }

// StdinTTY reports whether stdin is a terminal.
func (u *IO) StdinTTY() bool { return u.inTTY }

// OutColor returns a palette for stdout.
func (u *IO) OutColor() Palette { return Palette{on: u.outColor} }

// ErrColor returns a palette for stderr.
func (u *IO) ErrColor() Palette { return Palette{on: u.errColor} }

// Warn prints a warning to stderr.
func (u *IO) Warn(format string, args ...any) {
	fmt.Fprintf(u.Err, "%s %s\n", u.ErrColor().Yellow("warning:"), fmt.Sprintf(format, args...))
}

// Info prints a progress note to stderr, keeping stdout for results.
func (u *IO) Info(format string, args ...any) {
	fmt.Fprintf(u.Err, format+"\n", args...)
}

// ReadAll reads stdin to EOF, for values piped in with `-`.
func (u *IO) ReadAll() (string, error) {
	data, err := u.ReadAllBytes()
	return string(data), err
}

// ReadAllBytes reads stdin to EOF.
func (u *IO) ReadAllBytes() ([]byte, error) {
	return io.ReadAll(u.lineReader())
}

// -----------------------------------------------------------------------------
// Prompts
// -----------------------------------------------------------------------------

// ErrNoInput reports a prompt that could not be shown. hint tells the user
// how to provide the value non-interactively.
func ErrNoInput(what, hint string) error {
	msg := what + " is required, but input is not interactive"
	if hint != "" {
		msg += "; " + hint
	}
	return exitcode.New(exitcode.InputRequired, "%s", msg)
}

func (u *IO) lineReader() *bufio.Reader {
	if u.reader == nil {
		u.reader = bufio.NewReader(u.In)
	}
	return u.reader
}

func (u *IO) readLine() (string, error) {
	line, err := u.lineReader().ReadString('\n')
	if err != nil && (line == "" || !errors.Is(err, io.EOF)) {
		if errors.Is(err, io.EOF) {
			return "", exitcode.New(exitcode.InputRequired, "no input (end of file)")
		}
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// Prompt asks for a line of text. def is returned for an empty answer.
func (u *IO) Prompt(label, def, hint string) (string, error) {
	if !u.Interactive() {
		if def != "" {
			return def, nil
		}
		return "", ErrNoInput(label, hint)
	}
	c := u.ErrColor()
	if def != "" {
		fmt.Fprintf(u.Err, "%s %s ", c.Bold(label), c.Dim("("+def+")"))
	} else {
		fmt.Fprintf(u.Err, "%s ", c.Bold(label))
	}
	line, err := u.readLine()
	if err != nil {
		return "", err
	}
	if line = strings.TrimSpace(line); line == "" {
		return def, nil
	}
	return line, nil
}

// Password asks for a secret without echoing it.
func (u *IO) Password(label, hint string) (string, error) {
	if !u.Interactive() {
		return "", ErrNoInput(label, hint)
	}
	fmt.Fprintf(u.Err, "%s ", u.ErrColor().Bold(label))
	if u.interactive == nil && u.inFile != nil {
		data, err := term.ReadPassword(int(u.inFile.Fd()))
		fmt.Fprintln(u.Err)
		return string(data), err
	}
	return u.readLine()
}

// Confirm asks a yes/no question. In non-interactive mode it fails rather
// than assume an answer.
func (u *IO) Confirm(label string, def bool, hint string) (bool, error) {
	if !u.Interactive() {
		return false, ErrNoInput("confirmation", hint)
	}
	choices := "[y/N]"
	if def {
		choices = "[Y/n]"
	}
	for {
		fmt.Fprintf(u.Err, "%s %s ", u.ErrColor().Bold(label), choices)
		line, err := u.readLine()
		if err != nil {
			return false, err
		}
		switch strings.ToLower(strings.TrimSpace(line)) {
		case "":
			return def, nil
		case "y", "yes":
			return true, nil
		case "n", "no":
			return false, nil
		}
	}
}

// Select asks the user to pick one of items by number.
func (u *IO) Select(label string, items []string, hint string) (int, error) {
	if len(items) == 0 {
		return -1, errors.New("nothing to choose from")
	}
	if !u.Interactive() {
		return -1, ErrNoInput(label, hint)
	}
	c := u.ErrColor()
	fmt.Fprintln(u.Err, c.Bold(label))
	for i, it := range items {
		fmt.Fprintf(u.Err, "  %s %s\n", c.Cyan(fmt.Sprintf("%2d)", i+1)), it)
	}
	for {
		fmt.Fprintf(u.Err, "Enter a number (1-%d): ", len(items))
		line, err := u.readLine()
		if err != nil {
			return -1, err
		}
		n, err := strconv.Atoi(strings.TrimSpace(line))
		if err == nil && n >= 1 && n <= len(items) {
			return n - 1, nil
		}
	}
}

// ConfirmTyped asks the user to type expected exactly, for destructive
// actions. confirmed is the value of a --confirm flag, which skips the prompt
// when it matches.
func (u *IO) ConfirmTyped(action, expected, confirmed string) error {
	if confirmed != "" {
		if confirmed != expected {
			return exitcode.New(exitcode.Usage, "--confirm %q does not match %q", confirmed, expected)
		}
		return nil
	}
	if !u.Interactive() {
		return ErrNoInput("confirmation", fmt.Sprintf("pass --confirm %s", expected))
	}
	c := u.ErrColor()
	fmt.Fprintf(u.Err, "%s\nType %s to confirm: ", c.Red(action), c.Bold(expected))
	line, err := u.readLine()
	if err != nil {
		return err
	}
	if strings.TrimSpace(line) != expected {
		return exitcode.New(exitcode.Error, "confirmation did not match; nothing was changed")
	}
	return nil
}
