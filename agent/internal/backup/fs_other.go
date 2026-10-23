//go:build !linux

package backup

import "io/fs"

// COMPAT: volumes live on Linux nodes only; elsewhere (development and unit
// tests) owners, hard links and extended attributes are not carried.

type fileID struct{}

func fileIdentity(fs.FileInfo) (fileID, bool) { return fileID{}, false }

func linkCount(fs.FileInfo) uint64 { return 1 }

func lchown(string, int, int) error { return nil }

func listXattrs(string) (map[string]string, error) { return nil, nil }

func setXattr(string, string, string) error { return nil }
