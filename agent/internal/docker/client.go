// Package docker is a small Docker Engine API client covering only what the
// agent needs: ping and version, images, containers, networks, volumes,
// archives, exec, logs and events.
//
// It speaks the raw HTTP API instead of importing github.com/docker/docker,
// whose client drags in hundreds of packages (and their CVE churn) for the
// couple of dozen endpoints used here. Requests are pinned to [APIVersion],
// the oldest version Docker 29 still accepts, which every engine since 25.0
// serves.
//
// Every call takes a context. Request/response calls are additionally bounded
// by [DefaultTimeout] when the context has no earlier deadline; streaming
// calls (pull progress, logs, events) last as long as their context.
package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// APIVersion is the Engine API version every request is pinned to.
const APIVersion = "v1.44"

// DefaultHost is used when neither the constructor nor DOCKER_HOST names one.
const DefaultHost = "unix:///var/run/docker.sock"

// DefaultTimeout bounds request/response calls whose context has no earlier
// deadline.
const DefaultTimeout = 30 * time.Second

// maxErrorBody caps how much of an error response is read into memory.
const maxErrorBody = 64 << 10

// Client is a Docker Engine API client. It is safe for concurrent use.
type Client struct {
	base string
	// rpc serves request/response calls over a small keep-alive pool.
	rpc *http.Client
	// stream serves long-lived streams. Each stream owns its connection for
	// its whole life, so pooling would only keep idle sockets around after
	// it ends.
	stream *http.Client
	// dial opens a raw connection to the engine, for hijacked exec streams.
	dial func(ctx context.Context, network, addr string) (net.Conn, error)
	// hostAddr is the address dial is called with.
	hostAddr string
}

// FromEnv returns a client for DOCKER_HOST, or [DefaultHost] when it is unset.
func FromEnv() (*Client, error) {
	return New(os.Getenv("DOCKER_HOST"))
}

// New returns a client for host, a unix:// socket path or a tcp:// / http://
// address (plaintext, for tests and local development). An empty host means
// [DefaultHost].
func New(host string) (*Client, error) {
	if host == "" {
		host = DefaultHost
	}
	u, err := url.Parse(host)
	if err != nil {
		return nil, fmt.Errorf("docker host %q: %w", host, err)
	}
	var dial func(ctx context.Context, network, addr string) (net.Conn, error)
	base := ""
	d := &net.Dialer{Timeout: 10 * time.Second}
	switch u.Scheme {
	case "unix":
		sock := u.Path
		if sock == "" {
			return nil, fmt.Errorf("docker host %q: missing socket path", host)
		}
		dial = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return d.DialContext(ctx, "unix", sock)
		}
		// NOTE: the host part is ignored by the socket dialer but must be a
		// valid name.
		base = "http://docker"
	case "tcp", "http":
		if u.Host == "" {
			return nil, fmt.Errorf("docker host %q: missing address", host)
		}
		dial = d.DialContext
		base = "http://" + u.Host
	default:
		return nil, fmt.Errorf("docker host %q: unsupported scheme %q (use unix:// or tcp://)", host, u.Scheme)
	}
	rpcTransport := &http.Transport{
		DialContext:         dial,
		MaxIdleConns:        8,
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     30 * time.Second,
	}
	streamTransport := &http.Transport{DialContext: dial, DisableKeepAlives: true}
	hostAddr := "docker:80"
	if u.Scheme != "unix" {
		hostAddr = u.Host
	}
	return &Client{
		base:     base + "/" + APIVersion,
		rpc:      &http.Client{Transport: rpcTransport},
		stream:   &http.Client{Transport: streamTransport},
		dial:     dial,
		hostAddr: hostAddr,
	}, nil
}

// Close releases idle connections.
func (c *Client) Close() {
	c.rpc.CloseIdleConnections()
}

// Error is a non-2xx response from the Engine API.
type Error struct {
	// Status is the HTTP status code.
	Status int
	// Message is the engine's error message.
	Message string
}

// Error implements error.
func (e *Error) Error() string {
	return fmt.Sprintf("docker: %s (HTTP %d)", e.Message, e.Status)
}

// IsNotFound reports whether err is a 404 from the engine.
func IsNotFound(err error) bool { return statusIs(err, http.StatusNotFound) }

// IsConflict reports whether err is a 409 from the engine, such as a
// container name already in use.
func IsConflict(err error) bool { return statusIs(err, http.StatusConflict) }

func statusIs(err error, status int) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == status
}

// request describes one API call.
type request struct {
	method string
	path   string
	query  url.Values
	body   any
	header http.Header
}

func (c *Client) newRequest(ctx context.Context, r request) (*http.Request, error) {
	var body io.Reader
	if r.body != nil {
		data, err := json.Marshal(r.body)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(data)
	}
	u := c.base + r.path
	if len(r.query) > 0 {
		u += "?" + r.query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, r.method, u, body)
	if err != nil {
		return nil, err
	}
	for k, v := range r.header {
		req.Header[k] = v
	}
	if r.body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

// do performs a request/response call and decodes a JSON body into out when
// out is non-nil. 304 Not Modified counts as success, since the engine uses
// it for "already started" and "already stopped".
func (c *Client) do(ctx context.Context, r request, out any) error {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, DefaultTimeout)
		defer cancel()
	}
	req, err := c.newRequest(ctx, r)
	if err != nil {
		return err
	}
	resp, err := c.rpc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := checkStatus(resp); err != nil {
		return err
	}
	if out == nil || resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotModified {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxErrorBody))
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// openStream performs a call whose response body is consumed incrementally.
// The caller must close the returned body.
func (c *Client) openStream(ctx context.Context, r request) (io.ReadCloser, error) {
	req, err := c.newRequest(ctx, r)
	if err != nil {
		return nil, err
	}
	resp, err := c.stream.Do(req)
	if err != nil {
		return nil, err
	}
	if err := checkStatus(resp); err != nil {
		resp.Body.Close()
		return nil, err
	}
	return resp.Body, nil
}

func checkStatus(resp *http.Response) error {
	if resp.StatusCode < 400 {
		return nil
	}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
	var body struct {
		Message string `json:"message"`
	}
	msg := strings.TrimSpace(string(data))
	if json.Unmarshal(data, &body) == nil && body.Message != "" {
		msg = body.Message
	}
	if msg == "" {
		msg = http.StatusText(resp.StatusCode)
	}
	return &Error{Status: resp.StatusCode, Message: msg}
}

// labelFilters encodes the engine's filters query parameter.
func labelFilters(filters map[string][]string) string {
	data, _ := json.Marshal(filters)
	return string(data)
}

// Ping checks that the engine answers.
func (c *Client) Ping(ctx context.Context) error {
	return c.do(ctx, request{method: http.MethodGet, path: "/_ping"}, nil)
}

// Version is the subset of GET /version the agent reports.
type Version struct {
	Version    string `json:"Version"`
	APIVersion string `json:"ApiVersion"`
	Os         string `json:"Os"`
	Arch       string `json:"Arch"`
}

// Version returns the engine version.
func (c *Client) Version(ctx context.Context) (Version, error) {
	var v Version
	err := c.do(ctx, request{method: http.MethodGet, path: "/version"}, &v)
	return v, err
}

// Info is the subset of GET /info the agent uses.
type Info struct {
	// DockerRootDir is where the engine keeps images and containers.
	DockerRootDir string `json:"DockerRootDir"`
	OSType        string `json:"OSType"`
	// FirewallBackend is nil before Docker 28.
	FirewallBackend *FirewallBackend `json:"FirewallBackend,omitempty"`
}

// FirewallBackend is how the engine programs the host firewall.
type FirewallBackend struct {
	// Driver is e.g. "iptables", "iptables+firewalld" or "nftables".
	Driver string `json:"Driver"`
}

// Info returns engine-wide information.
func (c *Client) Info(ctx context.Context) (Info, error) {
	var i Info
	err := c.do(ctx, request{method: http.MethodGet, path: "/info"}, &i)
	return i, err
}
