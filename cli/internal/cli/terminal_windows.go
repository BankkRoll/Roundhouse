//go:build windows

package cli

import (
	"os"

	"golang.org/x/sys/windows"
)

// prepareOutput turns on escape sequence processing for the console the
// remote program draws on, and returns a func that restores the old mode.
//
// COMPAT: DISABLE_NEWLINE_AUTO_RETURN keeps a bare LF from also returning
// the cursor, as on a Unix terminal; full-screen programs rely on it.
func prepareOutput() func() {
	h := windows.Handle(os.Stdout.Fd())
	var mode uint32
	if err := windows.GetConsoleMode(h, &mode); err != nil {
		return func() {}
	}
	raw := mode | windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING | windows.DISABLE_NEWLINE_AUTO_RETURN
	if windows.SetConsoleMode(h, raw) != nil {
		return func() {}
	}
	return func() { _ = windows.SetConsoleMode(h, mode) }
}
