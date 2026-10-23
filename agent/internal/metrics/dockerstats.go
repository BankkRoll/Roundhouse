package metrics

import (
	"strings"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// fromDockerStats converts Docker's stats to a reading. Docker reports the
// host's memory as the limit of an unlimited container, and the node total
// is used only when it reports none.
func fromDockerStats(s docker.Stats, memTotal func() int64) reading {
	r := reading{source: protocol.MetricsDockerStats}
	r.counters.cpuUsec = s.CPUStats.Usage.TotalUsage / 1000
	inactive, ok := s.Memory.Stats["total_inactive_file"]
	if !ok {
		inactive = s.Memory.Stats["inactive_file"]
	}
	r.mem = int64(sub(s.Memory.Usage, inactive))
	r.memLimit = int64(min(s.Memory.Limit, 1<<63-1))
	if r.memLimit == 0 {
		r.memLimit = memTotal()
	}
	r.pids = int64(min(s.PIDs.Current, 1<<63-1))
	for name, n := range s.Networks {
		if name == "lo" {
			continue
		}
		r.counters.netRx += n.RxBytes
		r.counters.netTx += n.TxBytes
	}
	for _, e := range s.BlkioStat.IOServiceBytesRecursive {
		switch strings.ToLower(e.Op) {
		case "read":
			r.counters.diskRead += e.Value
		case "write":
			r.counters.diskWrite += e.Value
		}
	}
	return r
}
