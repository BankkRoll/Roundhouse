package facts

import "net/http"

// dockerClient returns nil on Windows: nodes are Linux-only and the Windows
// build exists for local development, so Docker Desktop's named pipe is not
// probed.
func dockerClient() *http.Client {
	return nil
}
