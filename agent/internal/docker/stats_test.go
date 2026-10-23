package docker

import (
	"context"
	"net/http"
	"testing"
)

func TestContainerStats(t *testing.T) {
	f, c := newFakeEngine(t)
	f.handle("GET /containers/abc/stats", func(w http.ResponseWriter, r *http.Request) {
		if q := r.URL.Query(); q.Get("stream") != "false" || q.Get("one-shot") != "true" {
			t.Errorf("query = %v, want stream=false&one-shot=true", q)
		}
		_, _ = w.Write([]byte(`{"read":"2026-10-23T05:36:21Z","cpu_stats":{"cpu_usage":{"total_usage":31373000}},
			"memory_stats":{"usage":7561216,"limit":268435456,"stats":{"inactive_file":5246976}},
			"pids_stats":{"current":2},"networks":{"eth0":{"rx_bytes":2530,"tx_bytes":788}},
			"blkio_stats":{"io_service_bytes_recursive":[{"major":8,"minor":48,"op":"read","value":4096}]}}`))
	})
	s, err := c.ContainerStats(context.Background(), "abc")
	if err != nil {
		t.Fatal(err)
	}
	if s.CPUStats.Usage.TotalUsage != 31373000 || s.Memory.Usage != 7561216 || s.Memory.Limit != 268435456 ||
		s.Memory.Stats["inactive_file"] != 5246976 || s.PIDs.Current != 2 || s.Networks["eth0"].RxBytes != 2530 ||
		len(s.BlkioStat.IOServiceBytesRecursive) != 1 || s.BlkioStat.IOServiceBytesRecursive[0].Value != 4096 {
		t.Fatalf("stats = %+v", s)
	}
	if _, err := c.ContainerStats(context.Background(), "missing"); !IsNotFound(err) {
		t.Fatalf("missing container: %v", err)
	}
}
