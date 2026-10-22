package facts

import (
	"context"
	"net"
	"testing"
)

func TestCollectAndSample(t *testing.T) {
	ctx := context.Background()
	s, err := Collect(ctx)
	if err != nil {
		t.Skipf("unsupported test host: %v", err)
	}
	if s.Hostname == "" || s.OS == "" || s.Hardware.CPUCores < 1 || s.Hardware.MemBytes <= 0 {
		t.Fatalf("incomplete facts: %+v", s)
	}
	if s.Capabilities.Docker != (s.DockerVersion != nil) {
		t.Fatalf("docker capability %v disagrees with version %v", s.Capabilities.Docker, s.DockerVersion)
	}

	u := NewSampler(ctx).Sample(ctx)
	if u.CPUPercent < 0 || u.CPUPercent > 100 || u.Load1 < 0 {
		t.Fatalf("usage out of protocol range: %+v", u)
	}
	if u.MemTotalBytes <= 0 || u.MemUsedBytes > u.MemTotalBytes {
		t.Fatalf("implausible memory usage: %+v", u)
	}
}

func TestIsPublic(t *testing.T) {
	for ip, want := range map[string]bool{
		"203.0.113.10":  true,
		"8.8.8.8":       true,
		"10.0.0.1":      false,
		"192.168.1.1":   false,
		"172.16.0.1":    false,
		"100.64.0.1":    false,
		"100.127.255.1": false,
		"100.128.0.1":   true,
		"127.0.0.1":     false,
		"2001:db8::1":   true,
		"fd00::1":       false,
	} {
		if got := isPublic(net.ParseIP(ip)); got != want {
			t.Errorf("isPublic(%s) = %v, want %v", ip, got, want)
		}
	}
}
