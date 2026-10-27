package docker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// ContainerCreate is the body of POST /containers/create: the container
// config with its host and networking config.
type ContainerCreate struct {
	Image        string              `json:"Image"`
	Cmd          []string            `json:"Cmd,omitempty"`
	Entrypoint   []string            `json:"Entrypoint,omitempty"`
	Env          []string            `json:"Env,omitempty"`
	Labels       map[string]string   `json:"Labels,omitempty"`
	ExposedPorts map[string]struct{} `json:"ExposedPorts,omitempty"`
	Hostname     string              `json:"Hostname,omitempty"`
	// User overrides the image's user ("uid:gid" or a name).
	User string `json:"User,omitempty"`
	// StopTimeout is seconds between SIGTERM and SIGKILL on stop.
	StopTimeout      *int              `json:"StopTimeout,omitempty"`
	HostConfig       HostConfig        `json:"HostConfig"`
	NetworkingConfig *NetworkingConfig `json:"NetworkingConfig,omitempty"`
}

// HostConfig is the subset of a container's host config the agent sets.
type HostConfig struct {
	NetworkMode string `json:"NetworkMode,omitempty"`
	// DNS replaces the upstream servers of Docker's embedded resolver
	// (user-defined networks); nil keeps the daemon's.
	DNS           []string                 `json:"Dns,omitempty"`
	PortBindings  map[string][]PortBinding `json:"PortBindings,omitempty"`
	RestartPolicy RestartPolicy            `json:"RestartPolicy"`
	Binds         []string                 `json:"Binds,omitempty"`
	SecurityOpt   []string                 `json:"SecurityOpt,omitempty"`
	CapDrop       []string                 `json:"CapDrop,omitempty"`
	CapAdd        []string                 `json:"CapAdd,omitempty"`
	// ReadonlyRootfs mounts the image's filesystem read-only.
	ReadonlyRootfs bool      `json:"ReadonlyRootfs"`
	LogConfig      LogConfig `json:"LogConfig"`
	// Memory is the hard limit in bytes.
	Memory int64 `json:"Memory,omitempty"`
	// MemorySwap is memory plus swap in bytes; equal to Memory disables swap.
	MemorySwap int64 `json:"MemorySwap,omitempty"`
	// NanoCPUs is CPU quota in billionths of a core.
	NanoCPUs  int64  `json:"NanoCpus,omitempty"`
	PidsLimit *int64 `json:"PidsLimit,omitempty"`
	Init      *bool  `json:"Init,omitempty"`
	// Mounts are volume (and other) mounts, beside Binds.
	Mounts []Mount `json:"Mounts,omitempty"`
	// Privileged grants every capability and host device. The agent never
	// sets it for workloads; integration tests use it for netfilter and
	// filesystem checks.
	Privileged bool `json:"Privileged,omitempty"`
	// PidMode "host" shares the host's PID namespace. The agent never sets
	// it for workloads; integration tests use it to signal engine processes
	// by host PID, as an agent on the host does.
	PidMode string `json:"PidMode,omitempty"`
}

// Mount types.
const (
	MountVolume = "volume"
	MountBind   = "bind"
)

// Mount is one entry of HostConfig.Mounts.
type Mount struct {
	// Type is [MountVolume] or [MountBind].
	Type string `json:"Type"`
	// Source is the volume name or host path.
	Source   string `json:"Source"`
	Target   string `json:"Target"`
	ReadOnly bool   `json:"ReadOnly,omitempty"`
}

// PortBinding publishes a container port on the host.
type PortBinding struct {
	HostIP   string `json:"HostIp"`
	HostPort string `json:"HostPort"`
}

// RestartPolicy is the engine's restart policy. The agent always sets "no"
// and restarts containers itself.
type RestartPolicy struct {
	Name              string `json:"Name"`
	MaximumRetryCount int    `json:"MaximumRetryCount,omitempty"`
}

// LogConfig selects a container's log driver.
type LogConfig struct {
	Type   string            `json:"Type"`
	Config map[string]string `json:"Config,omitempty"`
}

// NetworkingConfig attaches a container to networks at creation.
type NetworkingConfig struct {
	EndpointsConfig map[string]EndpointSettings `json:"EndpointsConfig"`
}

// EndpointSettings configures one network attachment.
type EndpointSettings struct {
	Aliases []string `json:"Aliases,omitempty"`
}

// CreateContainer creates a container named name and returns its ID.
func (c *Client) CreateContainer(ctx context.Context, name string, spec ContainerCreate) (string, error) {
	var out struct {
		ID string `json:"Id"`
	}
	err := c.do(ctx, request{
		method: http.MethodPost,
		path:   "/containers/create",
		query:  url.Values{"name": {name}},
		body:   spec,
	}, &out)
	return out.ID, err
}

// StartContainer starts a created or stopped container. Starting a running
// container is not an error.
func (c *Client) StartContainer(ctx context.Context, id string) error {
	return c.do(ctx, request{method: http.MethodPost, path: "/containers/" + url.PathEscape(id) + "/start"}, nil)
}

// StopContainer sends SIGTERM, then SIGKILL after timeout. Stopping a stopped
// container is not an error.
func (c *Client) StopContainer(ctx context.Context, id string, timeout time.Duration) error {
	secs := int(timeout / time.Second)
	// The engine holds the request open for the whole grace period.
	ctx, cancel := context.WithTimeout(ctx, timeout+DefaultTimeout)
	defer cancel()
	return c.do(ctx, request{
		method: http.MethodPost,
		path:   "/containers/" + url.PathEscape(id) + "/stop",
		query:  url.Values{"t": {strconv.Itoa(secs)}},
	}, nil)
}

// RemoveContainer force-removes a container and its anonymous volumes.
// Removing a missing container is not an error.
func (c *Client) RemoveContainer(ctx context.Context, id string) error {
	err := c.do(ctx, request{
		method: http.MethodDelete,
		path:   "/containers/" + url.PathEscape(id),
		query:  url.Values{"force": {"1"}, "v": {"1"}},
	}, nil)
	if IsNotFound(err) {
		return nil
	}
	return err
}

// ContainerState is a container's run state.
type ContainerState struct {
	// Status is "created", "running", "paused", "restarting", "removing",
	// "exited" or "dead".
	Status     string `json:"Status"`
	Running    bool   `json:"Running"`
	Restarting bool   `json:"Restarting"`
	OOMKilled  bool   `json:"OOMKilled"`
	Dead       bool   `json:"Dead"`
	Pid        int    `json:"Pid"`
	ExitCode   int    `json:"ExitCode"`
	Error      string `json:"Error"`
	// StartedAt and FinishedAt are RFC 3339; the zero time is
	// "0001-01-01T00:00:00Z".
	StartedAt  time.Time `json:"StartedAt"`
	FinishedAt time.Time `json:"FinishedAt"`
}

// ContainerConfig is the subset of a container's config the agent reads.
type ContainerConfig struct {
	Image  string            `json:"Image"`
	Labels map[string]string `json:"Labels"`
	// Env is the container's environment as KEY=value entries.
	Env []string `json:"Env"`
	// User is the user the container runs as, "" for the image default.
	User string `json:"User"`
}

// InspectHostConfig is the subset of an inspected container's host config
// the agent checks before it execs into the container.
type InspectHostConfig struct {
	Privileged bool `json:"Privileged"`
}

// MountPoint is one mount of an inspected container.
type MountPoint struct {
	Type string `json:"Type"`
	// Name is the volume name, for volume mounts.
	Name        string `json:"Name"`
	Source      string `json:"Source"`
	Destination string `json:"Destination"`
	RW          bool   `json:"RW"`
}

// EndpointInfo is a container's attachment to one network.
type EndpointInfo struct {
	NetworkID string `json:"NetworkID"`
	IPAddress string `json:"IPAddress"`
}

// NetworkSettings lists a container's network attachments by network name.
type NetworkSettings struct {
	Networks map[string]EndpointInfo `json:"Networks"`
}

// ContainerInfo is the subset of GET /containers/{id}/json the agent uses.
type ContainerInfo struct {
	ID string `json:"Id"`
	// Name has a leading "/".
	Name            string            `json:"Name"`
	Created         time.Time         `json:"Created"`
	Image           string            `json:"Image"`
	State           ContainerState    `json:"State"`
	Config          ContainerConfig   `json:"Config"`
	HostConfig      InspectHostConfig `json:"HostConfig"`
	NetworkSettings NetworkSettings   `json:"NetworkSettings"`
	Mounts          []MountPoint      `json:"Mounts"`
}

// InspectContainer returns a container's details. It fails with an error
// satisfying [IsNotFound] when the container does not exist.
func (c *Client) InspectContainer(ctx context.Context, id string) (ContainerInfo, error) {
	var info ContainerInfo
	err := c.do(ctx, request{method: http.MethodGet, path: "/containers/" + url.PathEscape(id) + "/json"}, &info)
	return info, err
}

// ContainerSummary is one entry of a container list.
type ContainerSummary struct {
	ID      string            `json:"Id"`
	Names   []string          `json:"Names"`
	Image   string            `json:"Image"`
	ImageID string            `json:"ImageID"`
	Labels  map[string]string `json:"Labels"`
	// State is the same vocabulary as [ContainerState].Status.
	State string `json:"State"`
	// Created is unix seconds.
	Created int64 `json:"Created"`
}

// ListContainers returns all containers, stopped ones included, that carry
// every label in labels ("key" or "key=value"). No labels lists everything.
func (c *Client) ListContainers(ctx context.Context, labels ...string) ([]ContainerSummary, error) {
	q := url.Values{"all": {"1"}}
	if len(labels) > 0 {
		q.Set("filters", labelFilters(map[string][]string{"label": labels}))
	}
	var out []ContainerSummary
	err := c.do(ctx, request{method: http.MethodGet, path: "/containers/json", query: q}, &out)
	return out, err
}

// LogsOptions selects which log lines [Client.ContainerLogs] returns.
type LogsOptions struct {
	Follow bool
	// Since returns only lines written at or after this instant; zero means
	// from the start.
	Since time.Time
	// Timestamps prefixes every line with its RFC 3339 nano timestamp and a
	// space.
	Timestamps bool
}

// ContainerLogs streams a container's stdout and stderr. For containers
// without a TTY (all of the agent's) the stream is multiplexed; split it with
// [NewDemuxer]. The caller must close the stream.
func (c *Client) ContainerLogs(ctx context.Context, id string, opts LogsOptions) (io.ReadCloser, error) {
	q := url.Values{"stdout": {"1"}, "stderr": {"1"}}
	if opts.Follow {
		q.Set("follow", "1")
	}
	if opts.Timestamps {
		q.Set("timestamps", "1")
	}
	if !opts.Since.IsZero() {
		q.Set("since", strconv.FormatInt(opts.Since.Unix(), 10)+"."+padNanos(opts.Since.Nanosecond()))
	}
	return c.openStream(ctx, request{method: http.MethodGet, path: "/containers/" + url.PathEscape(id) + "/logs", query: q})
}

func padNanos(n int) string {
	s := strconv.Itoa(n)
	for len(s) < 9 {
		s = "0" + s
	}
	return s
}

// ListContainersFiltered returns all containers, stopped ones included,
// matching the engine's filters, e.g. {"volume": ["name"]}.
func (c *Client) ListContainersFiltered(ctx context.Context, filters map[string][]string) ([]ContainerSummary, error) {
	q := url.Values{"all": {"1"}}
	if len(filters) > 0 {
		q.Set("filters", labelFilters(filters))
	}
	var out []ContainerSummary
	err := c.do(ctx, request{method: http.MethodGet, path: "/containers/json", query: q}, &out)
	return out, err
}

// WaitContainer blocks until the container is no longer running and returns
// its exit code. condition is "not-running" (the default when empty),
// "next-exit" or "removed".
func (c *Client) WaitContainer(ctx context.Context, id, condition string) (int, error) {
	if condition == "" {
		condition = "not-running"
	}
	var out struct {
		StatusCode int `json:"StatusCode"`
		Error      *struct {
			Message string `json:"Message"`
		} `json:"Error"`
	}
	req, err := c.newRequest(ctx, request{
		method: http.MethodPost,
		path:   "/containers/" + url.PathEscape(id) + "/wait",
		query:  url.Values{"condition": {condition}},
	})
	if err != nil {
		return 0, err
	}
	// NOTE: the engine holds the request open until the container exits, so
	// it goes over the stream client and lasts as long as ctx.
	resp, err := c.stream.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if err := checkStatus(resp); err != nil {
		return 0, err
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, err
	}
	if out.Error != nil && out.Error.Message != "" {
		return out.StatusCode, &Error{Status: http.StatusInternalServerError, Message: out.Error.Message}
	}
	return out.StatusCode, nil
}

// KillContainer sends signal (e.g. "SIGKILL") to a running container.
func (c *Client) KillContainer(ctx context.Context, id, signal string) error {
	return c.do(ctx, request{
		method: http.MethodPost,
		path:   "/containers/" + url.PathEscape(id) + "/kill",
		query:  url.Values{"signal": {signal}},
	}, nil)
}
