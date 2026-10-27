//go:build linux

package mesh

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"strings"
	"sync"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
	"github.com/vishvananda/netlink"
	wgconn "golang.zx2c4.com/wireguard/conn"
	wgdevice "golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/ipc"
	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/wgctrl"
)

// ipForwardPath is the IPv4 forwarding sysctl.
const ipForwardPath = "/proc/sys/net/ipv4/ip_forward"

// probeInterface is the throwaway link the kernel probe creates.
const probeInterface = "rh-wgprobe"

type linuxPlatform struct {
	log *slog.Logger
}

func newPlatform(log *slog.Logger) platform { return &linuxPlatform{log: log} }

func (p *linuxPlatform) Probe(mode string) protocol.MeshMode {
	if mode != ModeUserspace && kernelAvailable() {
		return protocol.MeshKernel
	}
	if mode != ModeKernel && tunAvailable() {
		return protocol.MeshUserspace
	}
	return protocol.MeshUnavailable
}

// kernelAvailable reports whether the kernel can create WireGuard links.
func kernelAvailable() bool {
	if l, err := netlink.LinkByName(WGInterface); err == nil && l.Type() == "wireguard" {
		return true
	}
	_ = netlink.LinkDel(&netlink.Wireguard{LinkAttrs: netlink.LinkAttrs{Name: probeInterface}})
	if err := netlink.LinkAdd(&netlink.Wireguard{LinkAttrs: netlink.LinkAttrs{Name: probeInterface}}); err != nil {
		return false
	}
	_ = netlink.LinkDel(&netlink.Wireguard{LinkAttrs: netlink.LinkAttrs{Name: probeInterface}})
	return true
}

// tunAvailable reports whether a TUN device can be opened.
func tunAvailable() bool {
	f, err := os.OpenFile("/dev/net/tun", os.O_RDWR, 0)
	if err != nil {
		return false
	}
	f.Close()
	return true
}

func (p *linuxPlatform) Up(mode string, mtu int) (device, error) {
	if l, err := netlink.LinkByName(WGInterface); err == nil {
		switch {
		case l.Type() == "wireguard" && mode != ModeUserspace:
			return &kernelDevice{}, nil
		case l.Type() == "wireguard":
			if err := netlink.LinkDel(l); err != nil {
				return nil, fmt.Errorf("remove the kernel %s for userspace mode: %w", WGInterface, err)
			}
		default:
			return nil, fmt.Errorf("%s exists and is a %s interface, not WireGuard; remove it or set mesh.mode: off",
				WGInterface, l.Type())
		}
	}
	var kernelErr error
	if mode != ModeUserspace {
		kernelErr = netlink.LinkAdd(&netlink.Wireguard{LinkAttrs: netlink.LinkAttrs{Name: WGInterface, MTU: mtu}})
		if kernelErr == nil {
			return &kernelDevice{}, nil
		}
		if mode == ModeKernel {
			return nil, fmt.Errorf("create kernel WireGuard interface (is the wireguard module available?): %w", kernelErr)
		}
		p.log.Info("kernel WireGuard unavailable; using the userspace implementation", "err", kernelErr)
	}
	d, err := newUserspaceDevice(mtu, p.log)
	if err != nil {
		if kernelErr != nil {
			return nil, fmt.Errorf("no WireGuard implementation works: kernel: %v; userspace: %w", kernelErr, err)
		}
		return nil, fmt.Errorf("userspace WireGuard: %w", err)
	}
	return d, nil
}

func (p *linuxPlatform) EnsureDummy(name string, addr netip.Addr) error {
	l, err := netlink.LinkByName(name)
	if err != nil {
		var nf netlink.LinkNotFoundError
		if !errors.As(err, &nf) {
			return err
		}
		if err := netlink.LinkAdd(&netlink.Dummy{LinkAttrs: netlink.LinkAttrs{Name: name}}); err != nil {
			return fmt.Errorf("create %s (is the dummy module available?): %w", name, err)
		}
		if l, err = netlink.LinkByName(name); err != nil {
			return err
		}
	}
	if err := setOnlyAddress(l, netip.PrefixFrom(addr, 32)); err != nil {
		return err
	}
	return netlink.LinkSetUp(l)
}

func (p *linuxPlatform) RemoveLink(name string) error {
	l, err := netlink.LinkByName(name)
	if err != nil {
		var nf netlink.LinkNotFoundError
		if errors.As(err, &nf) {
			return nil
		}
		return err
	}
	return netlink.LinkDel(l)
}

func (p *linuxPlatform) EnsureForwarding() error {
	data, err := os.ReadFile(ipForwardPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", ipForwardPath, err)
	}
	if strings.TrimSpace(string(data)) == "1" {
		return nil
	}
	if err := os.WriteFile(ipForwardPath, []byte("1\n"), 0o644); err != nil {
		return fmt.Errorf("IPv4 forwarding is off and cannot be turned on (set net.ipv4.ip_forward=1 in /etc/sysctl.d/60-roundhouse.conf): %w", err)
	}
	p.log.Info("turned on IPv4 forwarding for the mesh")
	return nil
}

func (p *linuxPlatform) Client() (wgClient, error) { return wgctrl.New() }

// setOnlyAddress gives l exactly the IPv4 address want.
func setOnlyAddress(l netlink.Link, want netip.Prefix) error {
	addrs, err := netlink.AddrList(l, netlink.FAMILY_V4)
	if err != nil {
		return err
	}
	for _, a := range addrs {
		ones, _ := a.Mask.Size()
		got, ok := netip.AddrFromSlice(a.IP)
		if ok && netip.PrefixFrom(got.Unmap(), ones) == want {
			continue
		}
		if err := netlink.AddrDel(l, &a); err != nil {
			return fmt.Errorf("remove %s from %s: %w", a.IPNet, l.Attrs().Name, err)
		}
	}
	ipn := &net.IPNet{IP: want.Addr().AsSlice(), Mask: net.CIDRMask(want.Bits(), 32)}
	if err := netlink.AddrReplace(l, &netlink.Addr{IPNet: ipn}); err != nil {
		return fmt.Errorf("address %s on %s: %w", want, l.Attrs().Name, err)
	}
	return nil
}

// configureLink sets wg0's address and MTU and brings it up.
func configureLink(addr netip.Prefix, mtu int) error {
	l, err := netlink.LinkByName(WGInterface)
	if err != nil {
		return err
	}
	if l.Attrs().MTU != mtu {
		if err := netlink.LinkSetMTU(l, mtu); err != nil {
			return fmt.Errorf("set %s MTU: %w", WGInterface, err)
		}
	}
	if err := setOnlyAddress(l, addr); err != nil {
		return err
	}
	return netlink.LinkSetUp(l)
}

// kernelDevice is wg0 backed by the kernel module. It outlives the agent
// process, so the mesh keeps working across agent restarts.
type kernelDevice struct{}

func (*kernelDevice) Mode() protocol.MeshMode { return protocol.MeshKernel }

func (*kernelDevice) Configure(addr netip.Prefix, mtu int) error { return configureLink(addr, mtu) }

func (*kernelDevice) Close() error {
	l, err := netlink.LinkByName(WGInterface)
	if err != nil {
		return nil
	}
	return netlink.LinkDel(l)
}

// userspaceDevice is embedded wireguard-go on a TUN device, configured
// through its UAPI socket like the kernel one is through netlink. It lives
// as long as the agent process.
type userspaceDevice struct {
	dev  *wgdevice.Device
	uapi net.Listener
	once sync.Once
}

func newUserspaceDevice(mtu int, log *slog.Logger) (*userspaceDevice, error) {
	tdev, err := tun.CreateTUN(WGInterface, mtu)
	if err != nil {
		return nil, fmt.Errorf("create TUN %s: %w", WGInterface, err)
	}
	logger := &wgdevice.Logger{
		Verbosef: func(string, ...any) {},
		Errorf:   func(format string, args ...any) { log.Warn("wireguard-go: " + fmt.Sprintf(format, args...)) },
	}
	dev := wgdevice.NewDevice(tdev, wgconn.NewDefaultBind(), logger)
	file, err := ipc.UAPIOpen(WGInterface)
	if err != nil {
		dev.Close()
		return nil, fmt.Errorf("open UAPI socket: %w", err)
	}
	uapi, err := ipc.UAPIListen(WGInterface, file)
	if err != nil {
		file.Close()
		dev.Close()
		return nil, fmt.Errorf("listen on UAPI socket: %w", err)
	}
	go func() {
		for {
			c, err := uapi.Accept()
			if err != nil {
				return
			}
			go dev.IpcHandle(c)
		}
	}()
	if err := dev.Up(); err != nil {
		uapi.Close()
		dev.Close()
		return nil, err
	}
	return &userspaceDevice{dev: dev, uapi: uapi}, nil
}

func (*userspaceDevice) Mode() protocol.MeshMode { return protocol.MeshUserspace }

func (*userspaceDevice) Configure(addr netip.Prefix, mtu int) error { return configureLink(addr, mtu) }

func (d *userspaceDevice) Close() error {
	d.once.Do(func() {
		d.uapi.Close()
		d.dev.Close()
	})
	return nil
}
