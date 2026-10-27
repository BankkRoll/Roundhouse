package certs

import (
	"log/slog"
	"os"
)

// prepareDir creates dir. Windows is a development platform only, where
// Caddy runs as the same user and file modes mean little.
func prepareDir(dir, _ string, _ *slog.Logger) error {
	return os.MkdirAll(dir, 0o700)
}
