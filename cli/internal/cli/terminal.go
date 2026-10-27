package cli

import (
	"context"
	"errors"
	"os"
	"sync"

	"golang.org/x/term"
)

// Terminal is the console `shell` runs an interactive session on. Tests
// substitute a fake; [SystemEnv] returns the process's console.
type Terminal interface {
	// IsTerminal reports whether stdin is an interactive terminal.
	IsTerminal() bool
	// Size returns the window size in columns and rows.
	Size() (cols, rows int, err error)
	// MakeRaw switches the terminal to raw mode. restore returns it to the
	// mode it had and is safe to call more than once.
	MakeRaw() (restore func(), err error)
	// WatchResize signals after each change of the window size until ctx
	// ends.
	WatchResize(ctx context.Context) <-chan struct{}
}

// systemTerminal is the process's console: stdin for input and raw mode,
// stdout (else stderr) for the window size.
type systemTerminal struct{}

func (systemTerminal) IsTerminal() bool {
	return term.IsTerminal(int(os.Stdin.Fd()))
}

func (systemTerminal) Size() (int, int, error) {
	// COMPAT: on Windows only a console output handle has a size, so stdin
	// can't be asked.
	for _, f := range []*os.File{os.Stdout, os.Stderr, os.Stdin} {
		if cols, rows, err := term.GetSize(int(f.Fd())); err == nil && cols > 0 && rows > 0 {
			return cols, rows, nil
		}
	}
	return 0, 0, errors.New("terminal size unknown")
}

func (systemTerminal) MakeRaw() (func(), error) {
	state, err := term.MakeRaw(int(os.Stdin.Fd()))
	if err != nil {
		return nil, err
	}
	restoreOutput := prepareOutput()
	var once sync.Once
	return func() {
		once.Do(func() {
			restoreOutput()
			_ = term.Restore(int(os.Stdin.Fd()), state)
		})
	}, nil
}

func (t systemTerminal) WatchResize(ctx context.Context) <-chan struct{} {
	return watchResize(ctx, t)
}
