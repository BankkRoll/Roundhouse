package builder

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// manifestAccept lists the manifest media types BuildKit pushes.
var manifestAccept = strings.Join([]string{
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
}, ", ")

// manifestDigest asks the registry at addr (host:port, plain HTTP) for the
// digest of repo:tag, confirming the push landed where the runtime will pull
// it from.
func manifestDigest(ctx context.Context, client *http.Client, addr, repo, tag string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, "http://"+addr+"/v2/"+repo+"/manifests/"+tag, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", manifestAccept)
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("registry %s: %w", addr, err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("registry %s: HEAD %s:%s: HTTP %d", addr, repo, tag, resp.StatusCode)
	}
	d := resp.Header.Get("Docker-Content-Digest")
	if !digestRE.MatchString(d) {
		return "", fmt.Errorf("registry %s returned no digest for %s:%s", addr, repo, tag)
	}
	return d, nil
}
