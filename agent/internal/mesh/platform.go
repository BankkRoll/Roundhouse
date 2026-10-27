package mesh

import (
	"net/netip"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// Interface names the mesh owns on the host.
const (
	WGInterface  = "wg0"
	DNSInterface = "rh-dns0"
)

// Config modes (agent config mesh.mode).
const (
	ModeAuto      = "auto"
	ModeKernel    = "kernel"
	ModeUserspace = "userspace"
	ModeOff       = "off"
)

// platform is the host networking the manager drives: Linux netlink and
// WireGuard in platform_linux.go, an error stub elsewhere. Tests substitute
// a fake.
type platform interface {
	// Probe reports which WireGuard implementation mode would get, without
	// leaving anything behind: [protocol.MeshUnavailable] when none works.
	Probe(mode string) protocol.MeshMode
	// Up creates wg0, or adopts an existing one this agent made, in mode.
	Up(mode string, mtu int) (device, error)
	// EnsureDummy creates the dummy interface name carrying exactly addr/32,
	// up.
	EnsureDummy(name string, addr netip.Addr) error
	// RemoveLink deletes an interface; a missing one is not an error.
	RemoveLink(name string) error
	// EnsureForwarding turns IPv4 forwarding on, or says why it is off.
	EnsureForwarding() error
	// Client opens a wgctrl client.
	Client() (wgClient, error)
}

// device is a running wg0.
type device interface {
	// Mode is the WireGuard implementation in use.
	Mode() protocol.MeshMode
	// Configure gives wg0 exactly addr, sets its MTU and brings it up.
	Configure(addr netip.Prefix, mtu int) error
	// Close removes wg0.
	Close() error
}

// wgClient is the part of *wgctrl.Client the manager uses.
type wgClient interface {
	ConfigureDevice(name string, cfg wgtypes.Config) error
	Device(name string) (*wgtypes.Device, error)
	Close() error
}
