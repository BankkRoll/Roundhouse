package docker

import (
	"context"
	"net/http"
	"net/url"
)

// Network is the subset of a network inspect or list entry the agent uses.
type Network struct {
	ID     string            `json:"Id"`
	Name   string            `json:"Name"`
	Driver string            `json:"Driver"`
	Labels map[string]string `json:"Labels"`
}

// NetworkCreate is the body of POST /networks/create.
type NetworkCreate struct {
	Name   string            `json:"Name"`
	Driver string            `json:"Driver"`
	Labels map[string]string `json:"Labels,omitempty"`
	// Internal networks have no route to the outside world.
	Internal bool `json:"Internal,omitempty"`
}

// CreateNetwork creates a network and returns its ID. The engine answers
// 409 when the name is taken; see [IsConflict].
func (c *Client) CreateNetwork(ctx context.Context, spec NetworkCreate) (string, error) {
	var out struct {
		ID string `json:"Id"`
	}
	err := c.do(ctx, request{method: http.MethodPost, path: "/networks/create", body: spec}, &out)
	return out.ID, err
}

// InspectNetwork returns a network by name or ID. It fails with an error
// satisfying [IsNotFound] when it does not exist.
func (c *Client) InspectNetwork(ctx context.Context, nameOrID string) (Network, error) {
	var n Network
	err := c.do(ctx, request{method: http.MethodGet, path: "/networks/" + url.PathEscape(nameOrID)}, &n)
	return n, err
}

// ListNetworks returns networks carrying every label in labels ("key" or
// "key=value").
func (c *Client) ListNetworks(ctx context.Context, labels ...string) ([]Network, error) {
	q := url.Values{}
	if len(labels) > 0 {
		q.Set("filters", labelFilters(map[string][]string{"label": labels}))
	}
	var out []Network
	err := c.do(ctx, request{method: http.MethodGet, path: "/networks", query: q}, &out)
	return out, err
}

// ConnectNetwork attaches a container to a network.
func (c *Client) ConnectNetwork(ctx context.Context, network, container string) error {
	return c.do(ctx, request{
		method: http.MethodPost,
		path:   "/networks/" + url.PathEscape(network) + "/connect",
		body:   map[string]string{"Container": container},
	}, nil)
}

// DisconnectNetwork detaches a container from a network, forcibly.
func (c *Client) DisconnectNetwork(ctx context.Context, network, container string) error {
	return c.do(ctx, request{
		method: http.MethodPost,
		path:   "/networks/" + url.PathEscape(network) + "/disconnect",
		body:   map[string]any{"Container": container, "Force": true},
	}, nil)
}

// RemoveNetwork deletes a network. Removing a missing network is not an
// error.
func (c *Client) RemoveNetwork(ctx context.Context, nameOrID string) error {
	err := c.do(ctx, request{method: http.MethodDelete, path: "/networks/" + url.PathEscape(nameOrID)}, nil)
	if IsNotFound(err) {
		return nil
	}
	return err
}
