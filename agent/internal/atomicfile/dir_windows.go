package atomicfile

// syncDir is a no-op on Windows, which cannot open a directory for fsync;
// NTFS journals the rename itself.
func syncDir(string) error { return nil }
