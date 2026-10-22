package config

import "io/fs"

// tooOpen always reports false: Windows has no Unix mode bits (Go reports
// 0666 for any writable file). Access is governed by the ACL of the user's
// %AppData% directory instead.
func tooOpen(fs.FileMode) bool {
	return false
}
