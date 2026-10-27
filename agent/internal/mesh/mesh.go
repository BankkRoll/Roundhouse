// Package mesh runs the node's side of the WireGuard mesh (ADR 0005).
//
// Responsibilities:
//   - keep the node's WireGuard key in <data dir>/wireguard.key and run
//     the rotation protocol (rotate_key, mesh_key, activate_epoch);
//   - create wg0 (kernel module through netlink, else embedded wireguard-go
//     on /dev/net/tun) and configure it only through wgctrl from each
//     desired_state.mesh, with the preshared keys opened from its sealed box;
//   - keep the rh-dns0 dummy interface carrying the node's private DNS
//     address, and the private DNS zone and listener on it;
//   - apply the nftables isolation table ([netpol]) and Docker's mark
//     acceptance, and verify both every 30 s;
//   - report hello.mesh (public key, implementation, reachability, Docker
//     firewall) and mesh_status every 30 s and on change;
//   - tear all of it down when desired_state.mesh is null, keeping the key.
//
// Mesh failures are never fatal: local workloads keep running, and
// mesh_status says ready false with the reason.
package mesh

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/ingress"
	"github.com/BankkRoll/Roundhouse/agent/internal/netpol"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// Defaults of the agent config's mesh block.
const (
	DefaultListenPort = 51820
	// DefaultMark is the mark the control plane sends as accept_fwmark;
	// hello's accept_fwmark is checked against it before any desired state.
	DefaultMark = 0x2000000
)

// DefaultInterval is how often the mesh is verified and mesh_status sent.
const DefaultInterval = 30 * time.Second

// minStatusGap rate-limits mesh_status to 4 per second.
const minStatusGap = 250 * time.Millisecond

// sendTimeout bounds one mesh_status or mesh_key send.
const sendTimeout = 10 * time.Second

// resolveTimeout bounds resolving one peer endpoint's hostname.
const resolveTimeout = 5 * time.Second

// Replica is a local container with a mesh IP, as the runtime reports it.
type Replica struct {
	MeshIP netip.Addr
	// BridgeIP is its address on its environment network.
	BridgeIP netip.Addr
	Healthy  bool
}

// DNS is the private DNS server; *ingress.PrivateDNS implements it.
type DNS interface {
	SetZone(z ingress.PrivateZone)
	Listen(addr string) error
	Addr() string
	Close()
}

// Firewall applies the isolation table and Docker's mark acceptance;
// *netpol.Firewall implements it.
type Firewall interface {
	Apply(ctx context.Context, script string) error
	Remove(ctx context.Context) error
	CheckDockerUser(ctx context.Context) error
	EnsureMarkRule(ctx context.Context, mark uint32) error
	RemoveMarkRule(ctx context.Context, mark uint32)
}

// Options configures a [Manager].
type Options struct {
	// NodeID is this node's ID: mesh addresses with it are local.
	NodeID string
	// KeyPath is the key store; see [KeyFileName].
	KeyPath string
	// Mode is the agent config's mesh.mode: auto, kernel, userspace or off.
	Mode string
	// ListenPort is reported in hello; desired_state.mesh.listen_port is
	// what wg0 uses.
	ListenPort int
	// Endpoint is mesh.endpoint ("host:port"); set, it makes the node public
	// and is reported as its endpoint override.
	Endpoint string
	// OpenPSKs opens a desired state's preshared keys for its generation
	// ([protocol.OpenMeshPSKs] with the node's key).
	OpenPSKs func(generation int64, m *protocol.MeshConfig) (map[string][]byte, error)
	// Send sends mesh_status and mesh_key.
	Send func(ctx context.Context, msg protocol.AgentMessage) error
	// Enabled reports whether the control plane speaks
	// [protocol.MeshProtocolVersion]; nothing is sent until it does.
	Enabled func() bool
	DNS     DNS
	// Firewall nil uses a [netpol.Firewall] running the host binaries.
	Firewall Firewall
	// DockerFirewall returns the engine's /info FirewallBackend.Driver.
	DockerFirewall func(ctx context.Context) (string, error)
	// DaemonConfig reads /etc/docker/daemon.json; nil reads the file. It
	// returns nil, nil when there is none.
	DaemonConfig func() ([]byte, error)
	// Cmdlines lists running processes' argv; nil reads /proc.
	Cmdlines func() [][]string
	// Interfaces lists host interfaces for NAT inference; nil reads them.
	Interfaces func() ([]Interface, error)
	Logger     *slog.Logger
	// Interval is the verify and mesh_status period; default
	// [DefaultInterval].
	Interval time.Duration

	// platform replaces the host networking in tests.
	platform platform
}

// Manager runs the node's mesh. Create it with [New], call
// [Manager.Prepare] before the first hello, feed it with [Manager.Apply]
// and [Manager.SetReplicas], and run it with [Manager.Run].
type Manager struct {
	opts Options
	log  *slog.Logger
	keys *KeyStore
	plat platform
	fw   Firewall
	wake chan struct{}

	mu sync.Mutex
	// applied is set by the first desired state: until then nothing is
	// changed, so a restarted agent keeps the mesh it left running.
	applied    bool
	desired    *protocol.MeshConfig
	generation int64
	psks       map[string][]byte
	pskErr     error
	replicas   map[netip.Addr]Replica
	// settled is false from a desired state turning the mesh on until the
	// first reconcile of it finished; [Manager.PrivateDNS] reports pending
	// meanwhile.
	settled bool
	// keyDue is a mesh_key still to be sent; keyFor is the desired state it
	// answers, so each rotate_key state (and each reconnect) sends it once.
	keyDue *protocol.MeshKey
	keyFor *protocol.MeshConfig
	// mode is the implementation in use, else the probed one.
	mode       protocol.MeshMode
	backend    netpol.Backend
	accept     bool
	ready      bool
	errText    string
	statusPoke bool

	// Owned by the Run goroutine.
	dev        device
	client     wgClient
	wgHash     string
	installed  bool
	markRule   uint32
	lastSig    string
	lastSentAt time.Time
}

// New opens the key store, creating the key on first use, and returns a
// manager. Nothing on the host changes until a desired state arrives.
func New(opts Options) (*Manager, error) {
	opts.Mode = cmp.Or(opts.Mode, ModeAuto)
	switch opts.Mode {
	case ModeAuto, ModeKernel, ModeUserspace, ModeOff:
	default:
		return nil, fmt.Errorf("mesh.mode %q: want auto, kernel, userspace or off", opts.Mode)
	}
	opts.ListenPort = cmp.Or(opts.ListenPort, DefaultListenPort)
	opts.Interval = cmp.Or(opts.Interval, DefaultInterval)
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	if opts.platform == nil {
		opts.platform = newPlatform(log)
	}
	if opts.Interfaces == nil {
		opts.Interfaces = HostInterfaces
	}
	if opts.DaemonConfig == nil {
		opts.DaemonConfig = readDaemonConfig
	}
	if opts.Cmdlines == nil {
		opts.Cmdlines = procCmdlines
	}
	if opts.Enabled == nil {
		opts.Enabled = func() bool { return true }
	}
	m := &Manager{
		opts: opts, log: log, plat: opts.platform, fw: opts.Firewall,
		wake: make(chan struct{}, 1), replicas: map[netip.Addr]Replica{},
		mode: protocol.MeshUnavailable, backend: netpol.BackendIPTables,
		// NOTE: an earlier agent process may have left wg0, rh-dns0 and the
		// table behind; a first "mesh off" removes them.
		installed: true, markRule: DefaultMark,
	}
	if m.fw == nil {
		m.fw = netpol.NewFirewall(nil, log)
	}
	keys, created, err := OpenKeyStore(opts.KeyPath)
	if err != nil {
		return nil, fmt.Errorf("mesh key: %w", err)
	}
	if created {
		log.Info("created this node's WireGuard key", "path", opts.KeyPath, "public_key", keys.PublicKey())
	}
	m.keys = keys
	return m, nil
}

// Off reports whether the agent config turned the mesh off.
func (m *Manager) Off() bool { return m.opts.Mode == ModeOff }

// Prepare probes the WireGuard implementation and Docker's firewall
// backend for hello. It changes nothing on the host.
func (m *Manager) Prepare(ctx context.Context) {
	if m.Off() {
		return
	}
	mode := m.plat.Probe(m.opts.Mode)
	backend, accept, why := m.dockerFirewall(ctx, DefaultMark, false)
	m.mu.Lock()
	m.mode, m.backend, m.accept = mode, backend, accept
	m.mu.Unlock()
	m.log.Info("mesh prerequisites", "wireguard", mode, "docker_firewall", backend, "accept_fwmark", accept, "reason", why)
}

// Hello returns hello.mesh, or nil when the mesh is off in the agent
// config.
func (m *Manager) Hello() *protocol.HelloMesh {
	if m.Off() {
		return nil
	}
	h := &protocol.HelloMesh{
		PublicKey:  m.keys.PublicKey(),
		ListenPort: m.opts.ListenPort,
		NAT:        NATBehind,
	}
	if m.opts.Endpoint != "" {
		h.NAT = NATPublic
		ep := m.opts.Endpoint
		h.EndpointOverride = &ep
	} else if ifaces, err := m.opts.Interfaces(); err == nil {
		h.NAT = InferNAT(ifaces)
	}
	m.mu.Lock()
	h.Mode, h.DockerFirewall, h.AcceptFwmark = m.mode, string(m.backend), m.accept
	m.mu.Unlock()
	return h
}

// Apply takes desired_state.mesh of generation (nil: mesh off). It opens
// the preshared keys here, while the frame's generation is known, and
// leaves the work to [Manager.Run]; it never blocks on the host.
func (m *Manager) Apply(generation int64, cfg *protocol.MeshConfig) {
	if m.Off() {
		cfg = nil
	}
	var psks map[string][]byte
	var pskErr error
	if cfg != nil && cfg.PSKsSealed != nil {
		if m.opts.OpenPSKs == nil {
			pskErr = errors.New("no key to open the preshared keys with")
		} else {
			psks, pskErr = m.opts.OpenPSKs(generation, cfg)
		}
	}
	m.mu.Lock()
	if (m.desired == nil) != (cfg == nil) || !m.applied {
		m.settled = cfg == nil
	}
	m.applied = true
	m.desired, m.generation, m.psks, m.pskErr = cfg, generation, psks, pskErr
	if cfg == nil || !cfg.RotateKey {
		m.keyDue = nil
	}
	m.mu.Unlock()
	m.poke()
}

// SetReplicas replaces the local replicas that have a mesh IP. The table
// and the DNS zone follow at once.
func (m *Manager) SetReplicas(rs []Replica) {
	next := make(map[netip.Addr]Replica, len(rs))
	for _, r := range rs {
		next[r.MeshIP] = r
	}
	m.mu.Lock()
	same := len(next) == len(m.replicas)
	for k, v := range next {
		if m.replicas[k] != v {
			same = false
		}
	}
	m.replicas = next
	m.mu.Unlock()
	if !same {
		m.poke()
	}
}

// PrivateDNS returns the private DNS address containers should use, ""
// when none is listening; pending is true while a mesh just turned on is
// still being set up, so the runtime waits briefly instead of creating a
// container without it.
func (m *Manager) PrivateDNS() (addr string, pending bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.desired == nil {
		return "", false
	}
	if a := m.opts.DNS.Addr(); a != "" {
		host, _, err := net.SplitHostPort(a)
		if err == nil {
			return host, false
		}
	}
	return "", !m.settled
}

// Connected tells the manager the control plane now accepts mesh frames,
// so the current status and any pending mesh_key go out at once.
func (m *Manager) Connected() {
	m.mu.Lock()
	m.statusPoke = true
	m.keyFor = nil
	m.mu.Unlock()
	m.poke()
}

func (m *Manager) poke() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// Run reconciles until ctx ends. The mesh stays up when it returns: a
// kernel wg0 and the table outlive the agent process.
func (m *Manager) Run(ctx context.Context) error {
	if m.Off() {
		// Tear down whatever an earlier configuration left once the first
		// desired state says so, then idle.
		m.opts.Interval = time.Hour
	}
	verify := time.NewTicker(m.opts.Interval)
	defer verify.Stop()
	retry := time.NewTimer(time.Hour)
	retry.Stop()
	defer retry.Stop()
	defer func() {
		if m.client != nil {
			m.client.Close()
		}
	}()
	periodic := false
	for {
		m.reconcile(ctx)
		if d := m.report(ctx, periodic); d > 0 {
			retry.Reset(d)
		}
		periodic = false
		select {
		case <-ctx.Done():
			return nil
		case <-m.wake:
		case <-retry.C:
		case <-verify.C:
			periodic = true
		}
	}
}

// snapshot is the inputs of one reconcile.
type snapshot struct {
	applied    bool
	cfg        *protocol.MeshConfig
	generation int64
	psks       map[string][]byte
	pskErr     error
	replicas   map[netip.Addr]Replica
}

func (m *Manager) snapshot() snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	return snapshot{m.applied, m.desired, m.generation, m.psks, m.pskErr, m.replicas}
}

// reconcile converges the host to the latest desired state and records
// readiness and the error text.
func (m *Manager) reconcile(ctx context.Context) {
	s := m.snapshot()
	if !s.applied {
		return
	}
	if s.cfg == nil {
		m.teardown(ctx)
		return
	}
	var errs []string
	fail := func(err error) {
		if err != nil {
			errs = append(errs, err.Error())
		}
	}
	cfg := s.cfg

	if cfg.RotateKey {
		pub, epoch, err := m.keys.Rotate()
		fail(err)
		if err == nil {
			m.mu.Lock()
			if m.desired == cfg && m.keyFor != cfg {
				m.keyFor = cfg
				m.keyDue = &protocol.MeshKey{Type: protocol.TypeMeshKey, PublicKey: pub, Epoch: epoch}
			}
			m.mu.Unlock()
		}
	}
	if cfg.ActivateEpoch != nil {
		changed, err := m.keys.Activate(*cfg.ActivateEpoch)
		fail(err)
		if changed {
			m.log.Info("activated the rotated WireGuard key", "epoch", *cfg.ActivateEpoch, "public_key", m.keys.PublicKey())
		}
	}

	fail(m.plat.EnsureForwarding())
	wgUp := m.ensureDevice(cfg, &errs)
	if wgUp {
		fail(m.configureWG(ctx, cfg, s))
	}
	m.installed = true

	dnsAddr, _ := netip.ParseAddr(cfg.DNSAddress)
	dnsUp := false
	if err := m.plat.EnsureDummy(DNSInterface, dnsAddr); err != nil {
		fail(err)
	} else {
		m.opts.DNS.SetZone(buildZone(cfg, m.opts.NodeID, s.replicas))
		if err := m.opts.DNS.Listen(net.JoinHostPort(cfg.DNSAddress, "53")); err != nil {
			fail(fmt.Errorf("private DNS on %s: %w", cfg.DNSAddress, err))
		} else {
			dnsUp = true
		}
	}

	nftUp := false
	bridges := make(map[netip.Addr]netip.Addr, len(s.replicas))
	for ip, r := range s.replicas {
		bridges[ip] = r.BridgeIP
	}
	if rs, err := netpol.Build(cfg, m.opts.NodeID, bridges); err != nil {
		fail(err)
	} else if err := m.fw.Apply(ctx, netpol.Render(rs)); err != nil {
		fail(err)
	} else {
		nftUp = true
	}

	backend, accept, why := m.dockerFirewall(ctx, uint32(cfg.AcceptFwmark), true)
	if !accept {
		errs = append(errs, why)
	}

	m.mu.Lock()
	if m.dev != nil {
		m.mode = m.dev.Mode()
	}
	m.backend, m.accept = backend, accept
	m.ready = wgUp && dnsUp && nftUp && accept && len(errs) == 0
	m.errText = strings.Join(errs, "; ")
	if m.desired == cfg {
		m.settled = true
	}
	m.mu.Unlock()
}

// ensureDevice creates or adopts wg0 and gives it its address, reporting
// whether it is up.
func (m *Manager) ensureDevice(cfg *protocol.MeshConfig, errs *[]string) bool {
	addr, err := wgAddress(cfg)
	if err != nil {
		*errs = append(*errs, err.Error())
		return false
	}
	if m.dev == nil {
		dev, err := m.plat.Up(m.opts.Mode, cfg.MTU)
		if err != nil {
			*errs = append(*errs, err.Error())
			m.mu.Lock()
			m.mode = protocol.MeshUnavailable
			m.mu.Unlock()
			return false
		}
		m.dev, m.wgHash = dev, ""
		m.log.Info("wg0 is up", "mode", dev.Mode())
	}
	if err := m.dev.Configure(addr, cfg.MTU); err != nil {
		*errs = append(*errs, fmt.Sprintf("configure %s: %v", WGInterface, err))
		return false
	}
	return true
}

// wgAddress is wg0's address: the node's .1 with the supernet's length, so
// the whole supernet routes through wg0.
func wgAddress(cfg *protocol.MeshConfig) (netip.Prefix, error) {
	supernet, err1 := netip.ParsePrefix(cfg.Supernet)
	addr, err2 := netip.ParseAddr(cfg.Address)
	if err := errors.Join(err1, err2); err != nil {
		return netip.Prefix{}, fmt.Errorf("mesh address: %w", err)
	}
	return netip.PrefixFrom(addr, supernet.Bits()), nil
}

// configureWG pushes the key, port and peers to wg0 when they changed, or
// when the device drifted from them (verified on every pass).
//
// NOTE: peers are replaced by difference (removing the ones no longer
// listed) rather than with ReplacePeers, which would drop every session and
// roaming-learned endpoint on each desired state; the result is the same
// peer set.
func (m *Manager) configureWG(ctx context.Context, cfg *protocol.MeshConfig, s snapshot) error {
	if m.client == nil {
		c, err := m.plat.Client()
		if err != nil {
			return fmt.Errorf("wgctrl: %w", err)
		}
		m.client = c
	}
	key, _ := m.keys.Current()
	want, hash, peerErrs := m.wantPeers(cfg, s)
	if s.pskErr != nil {
		peerErrs = append(peerErrs, "preshared keys: "+s.pskErr.Error())
	}
	cur, err := m.client.Device(WGInterface)
	if err != nil {
		return fmt.Errorf("read %s: %w", WGInterface, err)
	}
	if hash == m.wgHash && !drifted(cur, key, cfg.ListenPort, want) {
		return joinErrs(peerErrs)
	}
	peers := slices.Clone(want)
	m.resolveEndpoints(ctx, cfg, peers, &peerErrs)
	keep := map[wgtypes.Key]bool{}
	for _, p := range want {
		keep[p.PublicKey] = true
	}
	for _, p := range cur.Peers {
		if !keep[p.PublicKey] {
			peers = append(peers, wgtypes.PeerConfig{PublicKey: p.PublicKey, Remove: true})
		}
	}
	port, mark := cfg.ListenPort, 0
	if err := m.client.ConfigureDevice(WGInterface, wgtypes.Config{
		PrivateKey: &key, ListenPort: &port, FirewallMark: &mark, Peers: peers,
	}); err != nil {
		m.wgHash = ""
		return fmt.Errorf("configure %s: %w", WGInterface, err)
	}
	m.wgHash = hash
	return joinErrs(peerErrs)
}

// wantPeers builds the peer configs of cfg, without endpoints, and a hash
// of everything configured (keys included, so a rotation re-pushes).
func (m *Manager) wantPeers(cfg *protocol.MeshConfig, s snapshot) ([]wgtypes.PeerConfig, string, []string) {
	key, epoch := m.keys.Current()
	h := sha256.New()
	fmt.Fprintf(h, "%s|%d|%d\n", key.PublicKey(), epoch, cfg.ListenPort)
	var out []wgtypes.PeerConfig
	var errs []string
	for _, p := range cfg.Peers {
		pub, err := wgtypes.ParseKey(p.PublicKey)
		if err != nil {
			errs = append(errs, fmt.Sprintf("peer %s: invalid public key", p.NodeID))
			continue
		}
		raw, ok := s.psks[p.NodeID]
		if !ok {
			if s.pskErr == nil {
				errs = append(errs, fmt.Sprintf("peer %s: no preshared key", p.NodeID))
			}
			continue
		}
		psk, err := wgtypes.NewKey(raw)
		if err != nil {
			errs = append(errs, fmt.Sprintf("peer %s: invalid preshared key", p.NodeID))
			continue
		}
		var allowed []net.IPNet
		for _, c := range p.AllowedIPs {
			_, n, err := net.ParseCIDR(c)
			if err != nil {
				errs = append(errs, fmt.Sprintf("peer %s: invalid allowed ip %q", p.NodeID, c))
				continue
			}
			allowed = append(allowed, *n)
		}
		keepalive := time.Duration(p.KeepaliveS) * time.Second
		pc := wgtypes.PeerConfig{
			PublicKey: pub, PresharedKey: &psk, ReplaceAllowedIPs: true, AllowedIPs: allowed,
			PersistentKeepaliveInterval: &keepalive,
		}
		if p.Endpoint != nil {
			// A placeholder; resolveEndpoints fills in the address.
			pc.Endpoint = &net.UDPAddr{}
		}
		out = append(out, pc)
		endpoint := ""
		if p.Endpoint != nil {
			endpoint = *p.Endpoint
		}
		pskSum := sha256.Sum256(raw)
		fmt.Fprintf(h, "%s|%s|%s|%d|%s\n", pub, hex.EncodeToString(pskSum[:]), endpoint, p.KeepaliveS, strings.Join(p.AllowedIPs, ","))
	}
	return out, hex.EncodeToString(h.Sum(nil)), errs
}

// resolveEndpoints fills in each peer's endpoint address; a peer whose
// endpoint doesn't resolve keeps whatever endpoint wg0 has for it.
func (m *Manager) resolveEndpoints(ctx context.Context, cfg *protocol.MeshConfig, peers []wgtypes.PeerConfig, errs *[]string) {
	byKey := map[string]*string{}
	for _, p := range cfg.Peers {
		byKey[p.PublicKey] = p.Endpoint
	}
	for i := range peers {
		if peers[i].Endpoint == nil {
			continue
		}
		ep := byKey[peers[i].PublicKey.String()]
		addr, err := resolveUDP(ctx, *ep)
		if err != nil {
			*errs = append(*errs, fmt.Sprintf("resolve endpoint %s: %v", *ep, err))
			peers[i].Endpoint = nil
			continue
		}
		peers[i].Endpoint = addr
	}
}

func resolveUDP(ctx context.Context, hostport string) (*net.UDPAddr, error) {
	host, portText, err := net.SplitHostPort(hostport)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		return nil, err
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		return net.UDPAddrFromAddrPort(netip.AddrPortFrom(ip, uint16(port))), nil
	}
	ctx, cancel := context.WithTimeout(ctx, resolveTimeout)
	defer cancel()
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("%s has no address", host)
	}
	return net.UDPAddrFromAddrPort(netip.AddrPortFrom(ips[0].Unmap(), uint16(port))), nil
}

// drifted reports whether wg0 no longer has the key, port or peer set it
// was configured with (a restart, an operator's `wg set`).
func drifted(cur *wgtypes.Device, key wgtypes.Key, port int, want []wgtypes.PeerConfig) bool {
	if cur.PrivateKey != key || cur.ListenPort != port || len(cur.Peers) != len(want) {
		return true
	}
	have := map[wgtypes.Key]bool{}
	for _, p := range cur.Peers {
		have[p.PublicKey] = true
	}
	for _, p := range want {
		if !have[p.PublicKey] {
			return true
		}
	}
	return false
}

func joinErrs(errs []string) error {
	if len(errs) == 0 {
		return nil
	}
	return errors.New(strings.Join(errs, "; "))
}

// buildZone derives the private DNS zone: local replicas answer with their
// bridge IP (no hairpin through the NAT), remote ones with their mesh IP.
func buildZone(cfg *protocol.MeshConfig, self string, replicas map[netip.Addr]Replica) ingress.PrivateZone {
	z := ingress.PrivateZone{Askers: map[netip.Addr]int{}}
	for _, a := range cfg.Addresses {
		ip, err := netip.ParseAddr(a.IP)
		if err != nil {
			continue
		}
		local := a.NodeID == self
		r, running := replicas[ip]
		if local && running {
			z.Askers[r.BridgeIP] = a.EnvTag
		}
		if a.PrivateDomain == "" {
			continue
		}
		switch {
		case local && running:
			z.Records = append(z.Records, ingress.PrivateRecord{Domain: a.PrivateDomain, EnvTag: a.EnvTag, Addr: r.BridgeIP, Healthy: r.Healthy})
		case !local:
			// NOTE: unknown health counts as healthy, so a control plane that
			// doesn't report it still gets every replica answered.
			healthy := a.Healthy == nil || *a.Healthy
			z.Records = append(z.Records, ingress.PrivateRecord{Domain: a.PrivateDomain, EnvTag: a.EnvTag, Addr: ip, Healthy: healthy})
		}
	}
	return z
}

// dockerFirewall finds Docker's firewall backend and whether it accepts
// mark. With install set, the iptables backend's DOCKER-USER rule is put
// in place; without, it is only checked that it could be. why explains a
// false accept.
func (m *Manager) dockerFirewall(ctx context.Context, mark uint32, install bool) (netpol.Backend, bool, string) {
	backend := netpol.BackendIPTables
	if m.opts.DockerFirewall != nil {
		driver, err := m.opts.DockerFirewall(ctx)
		if err != nil {
			return backend, false, "cannot read Docker's firewall backend: " + err.Error()
		}
		backend = netpol.ParseBackend(driver)
	}
	if backend == netpol.BackendNFTables {
		daemon, err := m.opts.DaemonConfig()
		if err != nil {
			return backend, false, err.Error() + "; " + netpol.MarkFix(mark)
		}
		ok, err := netpol.DaemonAcceptsMark(daemon, m.opts.Cmdlines(), mark)
		if err != nil || !ok {
			return backend, false, "Docker's nftables firewall does not accept the mesh mark: " + netpol.MarkFix(mark)
		}
		return backend, true, ""
	}
	if !install {
		if err := m.fw.CheckDockerUser(ctx); err != nil {
			return backend, false, err.Error()
		}
		return backend, true, ""
	}
	if m.markRule != mark {
		m.fw.RemoveMarkRule(ctx, m.markRule)
	}
	m.markRule = mark
	if err := m.fw.EnsureMarkRule(ctx, mark); err != nil {
		return backend, false, err.Error()
	}
	return backend, true, ""
}

// teardown removes everything the mesh put on the host, once per switch to
// mesh off. The key store stays.
func (m *Manager) teardown(ctx context.Context) {
	if !m.installed {
		return
	}
	var errs []error
	m.opts.DNS.Close()
	m.opts.DNS.SetZone(ingress.PrivateZone{})
	errs = append(errs, m.fw.Remove(ctx))
	m.mu.Lock()
	backend := m.backend
	m.mu.Unlock()
	if backend == netpol.BackendIPTables {
		m.fw.RemoveMarkRule(ctx, m.markRule)
	}
	if m.client != nil {
		m.client.Close()
		m.client = nil
	}
	if m.dev != nil {
		errs = append(errs, m.dev.Close())
		m.dev = nil
	}
	errs = append(errs, m.plat.RemoveLink(WGInterface), m.plat.RemoveLink(DNSInterface))
	m.wgHash = ""
	m.installed = false
	m.mu.Lock()
	m.ready, m.errText, m.keyDue = false, "", nil
	m.mu.Unlock()
	if err := errors.Join(errs...); err != nil {
		m.log.Warn("mesh teardown incomplete", "err", err)
		return
	}
	m.log.Info("mesh is off: removed wg0, rh-dns0 and the nftables table")
}

// report sends a pending mesh_key and the mesh_status when it changed, or
// when periodic. It returns how long to wait before a status held back by
// the rate limit may go, 0 for none.
func (m *Manager) report(ctx context.Context, periodic bool) time.Duration {
	m.mu.Lock()
	on := m.desired != nil && m.installed
	key := m.keyDue
	forced := m.statusPoke
	m.statusPoke = false
	m.mu.Unlock()
	if !on || !m.opts.Enabled() {
		return 0
	}
	if key != nil {
		sctx, cancel := context.WithTimeout(ctx, sendTimeout)
		err := m.opts.Send(sctx, key)
		cancel()
		if err == nil {
			m.log.Info("sent the rotated WireGuard public key", "epoch", key.Epoch, "public_key", key.PublicKey)
			m.mu.Lock()
			if m.keyDue == key {
				m.keyDue = nil
			}
			m.mu.Unlock()
		}
	}
	st := m.status()
	sig := statusSig(st)
	if !periodic && !forced && sig == m.lastSig {
		return 0
	}
	if wait := minStatusGap - time.Since(m.lastSentAt); wait > 0 {
		return wait
	}
	sctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	if err := m.opts.Send(sctx, &st); err != nil {
		return 0
	}
	m.lastSig, m.lastSentAt = sig, time.Now()
	return 0
}

// statusSig is what makes a mesh_status worth sending before the next
// periodic one: readiness, the error, the epoch, and each peer's presence
// and whether it ever handshook.
func statusSig(st protocol.MeshStatus) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%t|%d|%s", st.Ready, st.Epoch, st.Error)
	for _, p := range st.Peers {
		fmt.Fprintf(&b, "|%s:%t", p.NodeID, p.LastHandshakeMS != nil)
	}
	return b.String()
}

// status returns the current mesh_status. Only the Run goroutine calls it:
// it reads wg0 through the client that goroutine owns.
func (m *Manager) status() protocol.MeshStatus {
	_, epoch := m.keys.Current()
	m.mu.Lock()
	st := protocol.MeshStatus{Type: protocol.TypeMeshStatus, Epoch: epoch, Ready: m.ready, Error: m.errText, Peers: []protocol.MeshPeerStatus{}}
	cfg := m.desired
	m.mu.Unlock()
	if len(st.Error) > protocol.MaxMessageBytes {
		st.Error = st.Error[:protocol.MaxMessageBytes-3] + "..."
	}
	if cfg == nil || m.client == nil {
		return st
	}
	nodes := map[string]string{}
	for _, p := range cfg.Peers {
		nodes[p.PublicKey] = p.NodeID
	}
	dev, err := m.client.Device(WGInterface)
	if err != nil {
		return st
	}
	for _, p := range dev.Peers {
		node, ok := nodes[p.PublicKey.String()]
		if !ok {
			continue
		}
		ps := protocol.MeshPeerStatus{NodeID: node, RxBytes: p.ReceiveBytes, TxBytes: p.TransmitBytes}
		if !p.LastHandshakeTime.IsZero() {
			ms := p.LastHandshakeTime.UnixMilli()
			ps.LastHandshakeMS = &ms
		}
		if p.Endpoint != nil {
			if ap := p.Endpoint.AddrPort(); ap.IsValid() {
				ep := netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port()).String()
				if protocol.IsHostPort(ep) {
					ps.Endpoint = &ep
				}
			}
		}
		st.Peers = append(st.Peers, ps)
	}
	slices.SortFunc(st.Peers, func(a, b protocol.MeshPeerStatus) int { return strings.Compare(a.NodeID, b.NodeID) })
	return st
}

// Ready reports whether the mesh is fully up, and the error when it isn't.
func (m *Manager) Ready() (bool, string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.ready, m.errText
}

// readDaemonConfig reads Docker's daemon.json, nil when it doesn't exist.
func readDaemonConfig() ([]byte, error) {
	data, err := os.ReadFile("/etc/docker/daemon.json")
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

// procCmdlines returns every process's argv from /proc, nil where there is
// no /proc.
func procCmdlines() [][]string {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var out [][]string
	for _, e := range entries {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join("/proc", e.Name(), "cmdline"))
		if err != nil || len(data) == 0 {
			continue
		}
		out = append(out, strings.Split(strings.TrimRight(string(data), "\x00"), "\x00"))
	}
	return out
}
