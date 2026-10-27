//go:build !linux

package walship

import "io/fs"

// COMPAT: volumes live on Linux nodes only; elsewhere (development and unit
// tests) the spool keeps the agent's own owner.

func lchown(string, int, int) error { return nil }

func ownerOf(fs.FileInfo) (int, int, bool) { return 0, 0, true }
