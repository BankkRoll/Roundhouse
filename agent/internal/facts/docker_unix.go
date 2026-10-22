//go:build !windows

package facts

import (
	"context"
	"net"
	"net/http"
	"os"
	"strings"
)

const defaultDockerSocket = "/var/run/docker.sock"

func dockerClient() *http.Client {
	sock := defaultDockerSocket
	if h := os.Getenv("DOCKER_HOST"); strings.HasPrefix(h, "unix://") {
		sock = strings.TrimPrefix(h, "unix://")
	}
	var d net.Dialer
	return &http.Client{
		Transport: &http.Transport{
			DisableKeepAlives: true,
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return d.DialContext(ctx, "unix", sock)
			},
		},
	}
}
