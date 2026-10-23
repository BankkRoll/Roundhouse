package protocol

import (
	"errors"
	"fmt"
)

// MetricsSource says where a [Metrics] frame's numbers come from.
type MetricsSource string

// Metrics sources: cgroup v2 files, or Docker's one-shot stats on cgroup v1
// hosts, which the dashboard marks approximate.
const (
	MetricsCgroupV2    MetricsSource = "cgroup_v2"
	MetricsDockerStats MetricsSource = "docker_stats"
)

// ContainerSample is one container's sample (ADR 0008). Rates and counters
// are deltas over the interval; the first sample after a start carries 0.
type ContainerSample struct {
	WorkloadID string `json:"workload_id"`
	// CPUMillis is average millicores over the interval.
	CPUMillis int64 `json:"cpu_millis"`
	// MemBytes is the working set: memory.current − inactive_file.
	MemBytes      int64 `json:"mem_bytes"`
	MemLimitBytes int64 `json:"mem_limit_bytes"`
	NetRxBytes    int64 `json:"net_rx_bytes"`
	NetTxBytes    int64 `json:"net_tx_bytes"`
	DiskReadBytes int64 `json:"disk_read_bytes"`
	// DiskWriteBytes is io.stat wbytes summed over devices.
	DiskWriteBytes int64 `json:"disk_write_bytes"`
	PIDs           int64 `json:"pids"`
	Restarts       int64 `json:"restarts"`
}

// Metrics is one sampling pass over every managed container, sent only when
// [Welcome].MetricsIntervalMS asked for it. Type must be [TypeMetrics].
type Metrics struct {
	Type string `json:"type"`
	// TS is the sample time, unix ms.
	TS         int64             `json:"ts"`
	IntervalMS int64             `json:"interval_ms"`
	Source     MetricsSource     `json:"source"`
	Samples    []ContainerSample `json:"samples"`
}

func (*Metrics) agentMessage() {}

// Validate implements [Validator].
func (m *Metrics) Validate() error {
	if m.TS < 0 || m.IntervalMS < MinMetricsIntervalMS || m.IntervalMS > MaxMetricsIntervalMS {
		return errors.New("ts or interval_ms: out of range")
	}
	if m.Source != MetricsCgroupV2 && m.Source != MetricsDockerStats {
		return fmt.Errorf("source: invalid %q", m.Source)
	}
	if len(m.Samples) == 0 || len(m.Samples) > MaxMetricSamples {
		return fmt.Errorf("samples: must have 1 to %d", MaxMetricSamples)
	}
	seen := map[string]bool{}
	for _, s := range m.Samples {
		if !idRE.MatchString(s.WorkloadID) || seen[s.WorkloadID] {
			return fmt.Errorf("samples: invalid or duplicate %q", s.WorkloadID)
		}
		seen[s.WorkloadID] = true
		for _, v := range []int64{s.CPUMillis, s.MemBytes, s.MemLimitBytes, s.NetRxBytes, s.NetTxBytes,
			s.DiskReadBytes, s.DiskWriteBytes, s.PIDs, s.Restarts} {
			if v < 0 {
				return fmt.Errorf("samples: %s has a negative value", s.WorkloadID)
			}
		}
	}
	return nil
}
