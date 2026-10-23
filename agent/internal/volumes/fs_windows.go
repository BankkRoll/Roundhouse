package volumes

import "io/fs"

type fileID struct{}

func fileIdentity(fs.FileInfo) (fileID, bool) { return fileID{}, false }

func allocated(info fs.FileInfo) int64 { return info.Size() }

// chown is a no-op: Windows hosts only run the agent for local development,
// where volumes have no Unix owners.
func chown(string, int, int) error { return nil }
