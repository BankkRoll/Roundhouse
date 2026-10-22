package facts

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// dockerVersion queries the Docker Engine API's /version endpoint and
// returns the engine version, or nil if Docker is not reachable.
func dockerVersion(ctx context.Context) *string {
	client := dockerClient()
	if client == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	// NOTE: the host is ignored by the socket dialer but must be a valid name.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/version", nil)
	if err != nil {
		return nil
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var body struct {
		Version string `json:"Version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.Version == "" {
		return nil
	}
	return &body.Version
}
