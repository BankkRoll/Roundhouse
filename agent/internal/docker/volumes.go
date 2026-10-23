package docker

import (
	"context"
	"net/http"
	"net/url"
	"time"
)

// Volume is a named volume.
type Volume struct {
	Name   string            `json:"Name"`
	Driver string            `json:"Driver"`
	Labels map[string]string `json:"Labels"`
	// Mountpoint is the host path of the volume's data.
	Mountpoint string `json:"Mountpoint"`
	// CreatedAt is RFC 3339.
	CreatedAt time.Time `json:"CreatedAt"`
}

// VolumeCreate is the body of POST /volumes/create.
type VolumeCreate struct {
	Name   string            `json:"Name"`
	Driver string            `json:"Driver,omitempty"`
	Labels map[string]string `json:"Labels,omitempty"`
}

// CreateVolume creates a named volume. Creating a volume that exists returns
// the existing one, as the engine does.
func (c *Client) CreateVolume(ctx context.Context, spec VolumeCreate) (Volume, error) {
	var v Volume
	err := c.do(ctx, request{method: http.MethodPost, path: "/volumes/create", body: spec}, &v)
	return v, err
}

// InspectVolume returns a volume. It fails with an error satisfying
// [IsNotFound] when the volume does not exist.
func (c *Client) InspectVolume(ctx context.Context, name string) (Volume, error) {
	var v Volume
	err := c.do(ctx, request{method: http.MethodGet, path: "/volumes/" + url.PathEscape(name)}, &v)
	return v, err
}

// ListVolumes returns the volumes carrying every label in labels ("key" or
// "key=value").
func (c *Client) ListVolumes(ctx context.Context, labels ...string) ([]Volume, error) {
	q := url.Values{}
	if len(labels) > 0 {
		q.Set("filters", labelFilters(map[string][]string{"label": labels}))
	}
	var out struct {
		Volumes []Volume `json:"Volumes"`
	}
	err := c.do(ctx, request{method: http.MethodGet, path: "/volumes", query: q}, &out)
	return out.Volumes, err
}

// RemoveVolume removes a volume and its data. It is never forced: the
// engine refuses, with an error satisfying [IsConflict], while any container
// uses the volume. Removing a missing volume is not an error.
func (c *Client) RemoveVolume(ctx context.Context, name string) error {
	err := c.do(ctx, request{method: http.MethodDelete, path: "/volumes/" + url.PathEscape(name)}, nil)
	if IsNotFound(err) {
		return nil
	}
	return err
}

// VolumeUsage returns the bytes each volume uses on disk, by name, from
// GET /system/df. Volumes the engine could not size are left out.
func (c *Client) VolumeUsage(ctx context.Context) (map[string]int64, error) {
	var out struct {
		Volumes []struct {
			Name      string `json:"Name"`
			UsageData *struct {
				Size     int64 `json:"Size"`
				RefCount int64 `json:"RefCount"`
			} `json:"UsageData"`
		} `json:"Volumes"`
	}
	// NOTE: sizing walks every volume, so the call can take a while on a big
	// node; it gets more than the default request timeout.
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	err := c.do(ctx, request{method: http.MethodGet, path: "/system/df", query: url.Values{"type": {"volume"}}}, &out)
	if err != nil {
		return nil, err
	}
	usage := make(map[string]int64, len(out.Volumes))
	for _, v := range out.Volumes {
		if v.UsageData != nil && v.UsageData.Size >= 0 {
			usage[v.Name] = v.UsageData.Size
		}
	}
	return usage, nil
}
