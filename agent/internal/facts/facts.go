// Package facts collects the host information an agent reports to the
// control plane: static facts sent at join and in hello, and usage samples
// sent with every heartbeat.
//
// Collection is best-effort wherever the protocol allows it. Only facts the
// control plane cannot schedule without (architecture, CPU count) are fatal.
package facts

import (
	"context"
	"fmt"
	"math"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
)

// Static holds facts that do not change while the agent runs.
type Static struct {
	Hostname string
	// OS is the distribution name and version, e.g. "ubuntu 24.04".
	OS     string
	Kernel string
	Arch   protocol.Arch
	// DockerVersion is nil when the Docker Engine API is unreachable.
	DockerVersion *string
	// PublicIP is the host's own globally routable address, or nil when it
	// sits behind NAT; the control plane falls back to the request source.
	PublicIP     *string
	Hardware     protocol.Hardware
	Capabilities protocol.Capabilities
}

// Collect gathers [Static] facts. It fails if the architecture is not one the
// protocol supports.
func Collect(ctx context.Context) (Static, error) {
	arch := protocol.Arch(runtime.GOARCH)
	if !arch.Valid() {
		return Static{}, fmt.Errorf("unsupported architecture %q: OpenRail nodes must be amd64 or arm64", runtime.GOARCH)
	}

	hostname, err := os.Hostname()
	if err != nil {
		return Static{}, fmt.Errorf("hostname: %w", err)
	}

	s := Static{Hostname: hostname, Arch: arch, OS: runtime.GOOS}
	if info, err := host.InfoWithContext(ctx); err == nil {
		s.OS = strings.TrimSpace(info.Platform + " " + info.PlatformVersion)
		s.Kernel = info.KernelVersion
	}

	cores, err := cpu.CountsWithContext(ctx, true)
	if err != nil {
		return Static{}, fmt.Errorf("count CPUs: %w", err)
	}
	if cores < 1 {
		return Static{}, fmt.Errorf("count CPUs: got %d", cores)
	}
	s.Hardware.CPUCores = cores
	if vm, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		s.Hardware.MemBytes = clampInt(vm.Total)
	}
	if du, err := disk.UsageWithContext(ctx, RootPath()); err == nil {
		s.Hardware.DiskBytes = clampInt(du.Total)
	}

	s.DockerVersion = dockerVersion(ctx)
	_, runscErr := exec.LookPath("runsc")
	s.Capabilities = protocol.Capabilities{
		Docker: s.DockerVersion != nil,
		GVisor: runscErr == nil,
		// NOTE: builder is an operator choice (join --builder), not a fact;
		// callers set it from the config.
		Builder: false,
	}
	s.PublicIP = publicIP()
	return s, nil
}

// RootPath returns the filesystem root whose capacity is reported as the
// node's disk.
func RootPath() string {
	if runtime.GOOS == "windows" {
		if d := os.Getenv("SystemDrive"); d != "" {
			return d + `\`
		}
		return `C:\`
	}
	return string(filepath.Separator)
}

// publicIP returns the source address the kernel would use to reach the
// internet, if that address is itself public.
func publicIP() *string {
	// NOTE: dialing UDP only consults the routing table; no packet is sent.
	c, err := net.Dial("udp", "1.1.1.1:53")
	if err != nil {
		return nil
	}
	defer c.Close()
	addr, ok := c.LocalAddr().(*net.UDPAddr)
	if !ok || !isPublic(addr.IP) {
		return nil
	}
	ip := addr.IP.String()
	return &ip
}

// cgnat is the RFC 6598 shared address space carriers use behind NAT; it is
// not reachable from the internet even though it is not RFC 1918 private.
var cgnat = &net.IPNet{IP: net.IPv4(100, 64, 0, 0).To4(), Mask: net.CIDRMask(10, 32)}

func isPublic(ip net.IP) bool {
	return ip.IsGlobalUnicast() && !ip.IsPrivate() && !cgnat.Contains(ip)
}

// Sampler produces [protocol.NodeUsage] samples.
type Sampler struct {
	diskPath string
}

// NewSampler returns a sampler for the root filesystem. It primes the CPU
// counters so the first heartbeat reports a real percentage.
func NewSampler(ctx context.Context) *Sampler {
	// NOTE: gopsutil computes non-blocking CPU percent against the previous
	// call and errors on the first one.
	_, _ = cpu.PercentWithContext(ctx, 0, false)
	return &Sampler{diskPath: RootPath()}
}

// Sample returns current usage. Metrics that cannot be read are reported as 0
// rather than failing the heartbeat; load average is unavailable on some
// platforms.
func (s *Sampler) Sample(ctx context.Context) protocol.NodeUsage {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var u protocol.NodeUsage
	if p, err := cpu.PercentWithContext(ctx, 0, false); err == nil && len(p) > 0 {
		u.CPUPercent = clampFloat(p[0], 100)
	}
	if vm, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		u.MemUsedBytes = clampInt(vm.Used)
		u.MemTotalBytes = clampInt(vm.Total)
	}
	if du, err := disk.UsageWithContext(ctx, s.diskPath); err == nil {
		u.DiskUsedBytes = clampInt(du.Used)
		u.DiskTotalBytes = clampInt(du.Total)
	}
	if avg, err := load.AvgWithContext(ctx); err == nil {
		u.Load1 = clampFloat(avg.Load1, math.MaxFloat64)
	}
	return u
}

func clampInt(v uint64) int64 {
	if v > math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(v)
}

// clampFloat keeps v inside the range the protocol schema accepts, since a
// single out-of-range sample would get the whole heartbeat rejected.
func clampFloat(v, maxV float64) float64 {
	if math.IsNaN(v) || v < 0 {
		return 0
	}
	return math.Min(v, maxV)
}

// Hello builds the hello frame for this host. Docker is probed again on each
// call because it may have been installed, upgraded or stopped since the
// agent started.
func (s Static) Hello(ctx context.Context, nodeID, agentVersion string, observedGeneration int64) protocol.Hello {
	s.DockerVersion = dockerVersion(ctx)
	s.Capabilities.Docker = s.DockerVersion != nil
	return protocol.Hello{
		Type:               protocol.TypeHello,
		ProtocolVersion:    protocol.ProtocolVersion,
		NodeID:             nodeID,
		AgentVersion:       agentVersion,
		OS:                 s.OS,
		Arch:               s.Arch,
		Kernel:             s.Kernel,
		DockerVersion:      s.DockerVersion,
		Hardware:           s.Hardware,
		Capabilities:       s.Capabilities,
		ObservedGeneration: observedGeneration,
	}
}
