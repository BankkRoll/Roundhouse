//go:build !windows

package ui

import "os"

// enableVT reports true: Unix terminals interpret ANSI escapes natively.
func enableVT(*os.File) bool { return true }
