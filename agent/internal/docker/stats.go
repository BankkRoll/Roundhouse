package docker

import (
	"context"
	"net/http"
	"net/url"
	"time"
)

// Stats is the subset of GET /containers/{id}/stats the agent reads.
// Counters are cumulative since the container started.
type Stats struct {
	Read      time.Time      `json:"read"`
	CPUStats  CPUStats       `json:"cpu_stats"`
	Memory    MemoryStats    `json:"memory_stats"`
	PIDs      PIDsStats      `json:"pids_stats"`
	Networks  map[string]Net `json:"networks"`
	BlkioStat BlkioStats     `json:"blkio_stats"`
}

// CPUStats holds a container's CPU counters.
type CPUStats struct {
	Usage struct {
		// TotalUsage is CPU time consumed, in nanoseconds.
		TotalUsage uint64 `json:"total_usage"`
	} `json:"cpu_usage"`
}

// MemoryStats holds a container's memory use.
type MemoryStats struct {
	Usage uint64 `json:"usage"`
	// Limit is the container's limit, or the host's memory without one.
	Limit uint64 `json:"limit"`
	// Stats is the cgroup's memory.stat: inactive_file on cgroup v2,
	// total_inactive_file on v1.
	Stats map[string]uint64 `json:"stats"`
}

// PIDsStats holds a container's process count.
type PIDsStats struct {
	Current uint64 `json:"current"`
}

// Net holds one interface's counters.
type Net struct {
	RxBytes uint64 `json:"rx_bytes"`
	TxBytes uint64 `json:"tx_bytes"`
}

// BlkioStats holds a container's block I/O counters.
type BlkioStats struct {
	IOServiceBytesRecursive []BlkioEntry `json:"io_service_bytes_recursive"`
}

// BlkioEntry is one device and operation's byte count. Op is "read" or
// "write" on cgroup v2 and "Read", "Write", "Sync", "Async", "Discard" or
// "Total" on v1.
type BlkioEntry struct {
	Major uint64 `json:"major"`
	Minor uint64 `json:"minor"`
	Op    string `json:"op"`
	Value uint64 `json:"value"`
}

// ContainerStats returns one stats sample for a running container without
// opening a stream. one-shot skips the engine's second read for the
// "precpu" fields, which callers that keep their own previous sample do
// not need, so it answers at once instead of after about a second.
func (c *Client) ContainerStats(ctx context.Context, id string) (Stats, error) {
	var s Stats
	err := c.do(ctx, request{
		method: http.MethodGet,
		path:   "/containers/" + url.PathEscape(id) + "/stats",
		query:  url.Values{"stream": {"false"}, "one-shot": {"true"}},
	}, &s)
	return s, err
}
