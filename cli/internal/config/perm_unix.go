//go:build !windows

package config

import "io/fs"

// tooOpen reports whether group or others have any access to the file.
func tooOpen(mode fs.FileMode) bool {
	return mode.Perm()&0o077 != 0
}
