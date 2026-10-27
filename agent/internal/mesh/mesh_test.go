package mesh

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/ingress"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// -----------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------

type fakeClient struct {
	mu         sync.Mutex
	dev        wgtypes.Device
	configures int
	last       wgtypes.Config
}

func (c *fakeClient) ConfigureDevice(name string, cfg wgtypes.Config) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.configures++
	c.last = cfg
	if cfg.PrivateKey != nil {
		c.dev.PrivateKey = *cfg.PrivateKey
		c.dev.PublicKey = cfg.PrivateKey.PublicKey()
	}
	if cfg.ListenPort != nil {
		c.dev.ListenPort = *cfg.ListenPort
	}
	if cfg.ReplacePeers {
		c.dev.Peers = nil
	}
	for _, pc := range cfg.Peers {
		i := -1
		for j, p := range c.dev.Peers {
			if p.PublicKey == pc.PublicKey {
				i = j
			}
		}
		if pc.Remove {
			if i >= 0 {
				c.dev.Peers = append(c.dev.Peers[:i], c.dev.Peers[i+1:]...)
			}
			continue
		}
		p := wgtypes.Peer{PublicKey: pc.PublicKey}
		if i >= 0 {
			p = c.dev.Peers[i]
		}
		if pc.PresharedKey != nil {
			p.PresharedKey = *pc.PresharedKey
		}
		if pc.Endpoint != nil {
			p.Endpoint = pc.Endpoint
		}
		if pc.PersistentKeepaliveInterval != nil {
			p.PersistentKeepaliveInterval = *pc.PersistentKeepaliveInterval
		}
		if pc.ReplaceAllowedIPs {
			p.AllowedIPs = pc.AllowedIPs
		}
		if i >= 0 {
			c.dev.Peers[i] = p
		} else {
			c.dev.Peers = append(c.dev.Peers, p)
		}
	}
	return nil
}

func (c *fakeClient) Device(string) (*wgtypes.Device, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	d := c.dev
	d.Peers = append([]wgtypes.Peer(nil), c.dev.Peers...)
	return &d, nil
}

func (c *fakeClient) Close() error { return nil }

type fakeDevice struct {
	closed bool
	addr   netip.Prefix
	mtu    int
}

func (d *fakeDevice) Mode() protocol.MeshMode { return protocol.MeshKernel }
func (d *fakeDevice) Configure(addr netip.Prefix, mtu int) error {
	d.addr, d.mtu = addr, mtu
	return nil
}
func (d *fakeDevice) Close() error { d.closed = true; return nil }

type fakePlatform struct {
	client   *fakeClient
	dev      *fakeDevice
	upErr    error
	dummies  map[string]netip.Addr
	removed  []string
	ipFwdErr error
}

func (p *fakePlatform) Probe(string) protocol.MeshMode { return protocol.MeshKernel }
func (p *fakePlatform) Up(string, int) (device, error) {
	if p.upErr != nil {
		return nil, p.upErr
	}
	p.dev = &fakeDevice{}
	return p.dev, nil
}
func (p *fakePlatform) EnsureDummy(name string, addr netip.Addr) error {
	p.dummies[name] = addr
	return nil
}
func (p *fakePlatform) RemoveLink(name string) error {
	p.removed = append(p.removed, name)
	return nil
}
func (p *fakePlatform) EnsureForwarding() error   { return p.ipFwdErr }
func (p *fakePlatform) Client() (wgClient, error) { return p.client, nil }

type fakeFirewall struct {
	mu       sync.Mutex
	script   string
	applies  int
	removed  bool
	marks    []uint32
	unmarked []uint32
	markErr  error
}

func (f *fakeFirewall) Apply(_ context.Context, s string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if s != f.script {
		f.applies++
	}
	f.script, f.removed = s, false
	return nil
}
func (f *fakeFirewall) Remove(context.Context) error { f.removed, f.script = true, ""; return nil }
func (f *fakeFirewall) CheckDockerUser(context.Context) error {
	return f.markErr
}
func (f *fakeFirewall) EnsureMarkRule(_ context.Context, mark uint32) error {
	f.marks = append(f.marks, mark)
	return f.markErr
}
func (f *fakeFirewall) RemoveMarkRule(_ context.Context, mark uint32) {
	f.unmarked = append(f.unmarked, mark)
}

type fakeDNS struct {
	mu   sync.Mutex
	addr string
	zone ingress.PrivateZone
}

func (d *fakeDNS) SetZone(z ingress.PrivateZone) { d.mu.Lock(); d.zone = z; d.mu.Unlock() }
func (d *fakeDNS) Listen(addr string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.addr = addr
	return nil
}
func (d *fakeDNS) Addr() string { d.mu.Lock(); defer d.mu.Unlock(); return d.addr }
func (d *fakeDNS) Close()       { d.mu.Lock(); d.addr = ""; d.mu.Unlock() }

type sent struct {
	mu   sync.Mutex
	msgs []protocol.AgentMessage
}

func (s *sent) send(_ context.Context, m protocol.AgentMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.msgs = append(s.msgs, m)
	return nil
}

func (s *sent) keys() []protocol.MeshKey {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []protocol.MeshKey
	for _, m := range s.msgs {
		if k, ok := m.(*protocol.MeshKey); ok {
			out = append(out, *k)
		}
	}
	return out
}

func (s *sent) statuses() []protocol.MeshStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []protocol.MeshStatus
	for _, m := range s.msgs {
		if st, ok := m.(*protocol.MeshStatus); ok {
			out = append(out, *st)
		}
	}
	return out
}

type harness struct {
	m       *Manager
	plat    *fakePlatform
	fw      *fakeFirewall
	dns     *fakeDNS
	sent    *sent
	enabled bool
	driver  string
	daemon  []byte
	keyPath string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{
		plat:    &fakePlatform{client: &fakeClient{}, dummies: map[string]netip.Addr{}},
		fw:      &fakeFirewall{},
		dns:     &fakeDNS{},
		sent:    &sent{},
		enabled: true,
		driver:  "iptables",
		keyPath: filepath.Join(t.TempDir(), KeyFileName),
	}
	m, err := New(Options{
		NodeID: "node_a", KeyPath: h.keyPath, platform: h.plat, Firewall: h.fw, DNS: h.dns,
		Send:    h.sent.send,
		Enabled: func() bool { return h.enabled },
		OpenPSKs: func(gen int64, cfg *protocol.MeshConfig) (map[string][]byte, error) {
			if cfg.PSKsSealed.CT == "bad" {
				return nil, errors.New("wrong key")
			}
			return map[string][]byte{"node_b": psk(7)}, nil
		},
		DockerFirewall: func(context.Context) (string, error) { return h.driver, nil },
		DaemonConfig:   func() ([]byte, error) { return h.daemon, nil },
		Cmdlines:       func() [][]string { return nil },
		Interfaces: func() ([]Interface, error) {
			return []Interface{{Name: "eth0", Up: true, Addrs: []netip.Prefix{netip.MustParsePrefix("10.0.0.5/24")}}}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	h.m = m
	return h
}

func psk(b byte) []byte {
	out := make([]byte, 32)
	for i := range out {
		out[i] = b
	}
	return out
}

func peerKey(t *testing.T) wgtypes.Key {
	t.Helper()
	k, err := wgtypes.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	return k.PublicKey()
}

func meshConfig(peer wgtypes.Key) *protocol.MeshConfig {
	ep := "192.0.2.10:51820"
	return &protocol.MeshConfig{
		Supernet: "10.200.0.0/16", NodeIndex: 1, Address: "10.200.1.1", DNSAddress: "10.200.1.2",
		ListenPort: 51820, MTU: 1420, AcceptFwmark: 0x2000000,
		Peers: []protocol.MeshPeer{{
			NodeID: "node_b", PublicKey: peer.String(), Endpoint: &ep,
			AllowedIPs: []string{"10.200.2.0/24"}, KeepaliveS: 25,
		}},
		PSKsSealed:    &protocol.SealedBox{CT: "ok"},
		NodeAddresses: []string{"10.200.1.1", "10.200.2.1"},
		Addresses: []protocol.MeshAddress{
			{IP: "10.200.1.10", EnvTag: 4, NodeID: "node_a", RoutedPorts: []int{80}, PrivateDomain: "web.production.shop.internal"},
			{IP: "10.200.2.10", EnvTag: 4, NodeID: "node_b", PrivateDomain: "api.production.shop.internal"},
		},
	}
}

func (h *harness) pass(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	h.m.reconcile(ctx)
	h.m.lastSentAt = time.Time{}
	h.m.report(ctx, false)
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

func TestApplyBringsMeshUp(t *testing.T) {
	h := newHarness(t)
	peer := peerKey(t)
	h.m.Apply(5, meshConfig(peer))
	if _, pending := h.m.PrivateDNS(); !pending {
		t.Error("PrivateDNS not pending before the first reconcile")
	}
	h.m.SetReplicas([]Replica{{MeshIP: netip.MustParseAddr("10.200.1.10"), BridgeIP: netip.MustParseAddr("172.18.0.2"), Healthy: true}})
	h.pass(t)

	if ok, why := h.m.Ready(); !ok {
		t.Fatalf("not ready: %s", why)
	}
	if addr, pending := h.m.PrivateDNS(); addr != "10.200.1.2" || pending {
		t.Errorf("PrivateDNS = %q, %v", addr, pending)
	}
	if h.plat.dev.addr.String() != "10.200.1.1/16" || h.plat.dev.mtu != 1420 {
		t.Errorf("wg0 = %s mtu %d", h.plat.dev.addr, h.plat.dev.mtu)
	}
	if h.plat.dummies[DNSInterface] != netip.MustParseAddr("10.200.1.2") || h.dns.Addr() != "10.200.1.2:53" {
		t.Errorf("dns: dummy %v listen %q", h.plat.dummies, h.dns.Addr())
	}
	dev, _ := h.plat.client.Device(WGInterface)
	key, _ := h.m.keys.Current()
	if dev.PrivateKey != key || dev.ListenPort != 51820 || len(dev.Peers) != 1 {
		t.Fatalf("device = %+v", dev)
	}
	p := dev.Peers[0]
	if p.PublicKey != peer || p.PresharedKey != wgtypes.Key(psk(7)) || p.Endpoint.String() != "192.0.2.10:51820" ||
		p.PersistentKeepaliveInterval != 25*time.Second || len(p.AllowedIPs) != 1 || p.AllowedIPs[0].String() != "10.200.2.0/24" {
		t.Errorf("peer = %+v", p)
	}
	if h.plat.client.last.ReplacePeers || h.plat.client.last.FirewallMark == nil || *h.plat.client.last.FirewallMark != 0 {
		t.Errorf("config = %+v", h.plat.client.last)
	}
	if !strings.Contains(h.fw.script, "10.200.1.10 : 172.18.0.2") || len(h.fw.marks) == 0 || h.fw.marks[0] != 0x2000000 {
		t.Errorf("firewall: marks %v script:\n%s", h.fw.marks, h.fw.script)
	}
	zone := h.dns.zone
	if zone.Askers[netip.MustParseAddr("172.18.0.2")] != 4 || len(zone.Records) != 2 {
		t.Errorf("zone = %+v", zone)
	}

	st := h.sent.statuses()
	if len(st) != 1 || !st[0].Ready || st[0].Epoch != 0 || len(st[0].Peers) != 1 || st[0].Peers[0].NodeID != "node_b" {
		t.Errorf("statuses = %+v", st)
	}
	if err := st[0].Validate(); err != nil {
		t.Errorf("status invalid: %v", err)
	}

	// The same config at a newer generation leaves wg0 alone, and an
	// unchanged status is not sent again before the periodic one.
	configures := h.plat.client.configures
	h.m.Apply(6, meshConfig(peer))
	h.pass(t)
	if h.plat.client.configures != configures {
		t.Error("an unchanged config was pushed to wg0 again")
	}
	if n := len(h.sent.statuses()); n != 1 {
		t.Errorf("%d statuses, want no new one", n)
	}
	h.m.report(context.Background(), true)
	if n := len(h.sent.statuses()); n != 2 {
		t.Errorf("%d statuses after the periodic report, want 2", n)
	}
}

func TestPeersReplacedByDifference(t *testing.T) {
	h := newHarness(t)
	a, b := peerKey(t), peerKey(t)
	h.m.Apply(1, meshConfig(a))
	h.pass(t)
	cfg := meshConfig(b)
	cfg.Peers[0].Endpoint = nil
	h.m.Apply(2, cfg)
	h.pass(t)
	dev, _ := h.plat.client.Device(WGInterface)
	if len(dev.Peers) != 1 || dev.Peers[0].PublicKey != b || dev.Peers[0].Endpoint != nil {
		t.Errorf("peers = %+v", dev.Peers)
	}

	// Drift: someone removed the peer by hand.
	h.plat.client.mu.Lock()
	h.plat.client.dev.Peers = nil
	h.plat.client.mu.Unlock()
	h.pass(t)
	if dev, _ := h.plat.client.Device(WGInterface); len(dev.Peers) != 1 {
		t.Error("drift was not repaired")
	}
}

func TestPSKFailureIsNotReady(t *testing.T) {
	h := newHarness(t)
	cfg := meshConfig(peerKey(t))
	cfg.PSKsSealed.CT = "bad"
	h.m.Apply(1, cfg)
	h.pass(t)
	ok, why := h.m.Ready()
	if ok || !strings.Contains(why, "preshared keys: wrong key") {
		t.Errorf("ready %v, %q", ok, why)
	}
	if dev, _ := h.plat.client.Device(WGInterface); len(dev.Peers) != 0 {
		t.Error("a peer was configured without its preshared key")
	}
	st := h.sent.statuses()
	if len(st) != 1 || st[0].Ready || st[0].Error == "" {
		t.Errorf("status = %+v", st)
	}
}

func TestDeviceFailureIsNotFatal(t *testing.T) {
	h := newHarness(t)
	h.plat.upErr = errors.New("no wireguard")
	h.m.Apply(1, meshConfig(peerKey(t)))
	h.pass(t)
	ok, why := h.m.Ready()
	if ok || !strings.Contains(why, "no wireguard") {
		t.Errorf("ready %v, %q", ok, why)
	}
	if h.m.Hello().Mode != protocol.MeshUnavailable {
		t.Errorf("hello mode = %s", h.m.Hello().Mode)
	}
	// DNS and isolation still come up, so local workloads are unaffected.
	if h.dns.Addr() == "" || h.fw.script == "" {
		t.Error("private DNS or the table were skipped")
	}
}

func TestRotation(t *testing.T) {
	h := newHarness(t)
	peer := peerKey(t)
	first := h.m.keys.PublicKey()

	cfg := meshConfig(peer)
	cfg.RotateKey = true
	h.m.Apply(1, cfg)
	h.pass(t)
	keys := h.sent.keys()
	if len(keys) != 1 || keys[0].Epoch != 1 || keys[0].PublicKey == first {
		t.Fatalf("mesh_key = %+v", keys)
	}
	if err := keys[0].Validate(); err != nil {
		t.Error(err)
	}
	if h.m.keys.PublicKey() != first {
		t.Error("the new key was used before activation")
	}

	// Still asked in the next desired state: the same key again, idempotently;
	// a pass without a new desired state sends nothing.
	cfg = meshConfig(peer)
	cfg.RotateKey = true
	h.m.Apply(2, cfg)
	h.pass(t)
	if keys := h.sent.keys(); len(keys) != 2 || keys[1] != keys[0] {
		t.Errorf("resent mesh_key = %+v", keys)
	}
	h.pass(t)
	if n := len(h.sent.keys()); n != 2 {
		t.Errorf("%d mesh_key frames after a pass with no new desired state, want 2", n)
	}
	// A restart keeps the pending key.
	reopened, _, err := OpenKeyStore(h.keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if pub, epoch, ok := reopened.Next(); !ok || pub != keys[0].PublicKey || epoch != 1 {
		t.Errorf("reopened next = %q %d %v", pub, epoch, ok)
	}

	// The control plane took it: no more mesh_key, then activation.
	cfg = meshConfig(peer)
	h.m.Apply(3, cfg)
	h.pass(t)
	if n := len(h.sent.keys()); n != 2 {
		t.Errorf("%d mesh_key frames after rotate_key cleared", n)
	}
	one := int64(1)
	cfg = meshConfig(peer)
	cfg.ActivateEpoch = &one
	h.m.Apply(4, cfg)
	h.pass(t)
	if h.m.keys.PublicKey() != keys[0].PublicKey {
		t.Fatal("not swapped to the new key")
	}
	dev, _ := h.plat.client.Device(WGInterface)
	if dev.PublicKey.String() != keys[0].PublicKey {
		t.Error("wg0 still uses the old key")
	}
	st := h.sent.statuses()
	if st[len(st)-1].Epoch != 1 {
		t.Errorf("status epoch = %d, want 1", st[len(st)-1].Epoch)
	}
	// Activating again, or an older epoch, changes nothing.
	h.m.Apply(5, cfg)
	h.pass(t)
	if ok, why := h.m.Ready(); !ok {
		t.Errorf("re-activation broke readiness: %s", why)
	}
	// An epoch the node never generated is an error, not a swap.
	five := int64(5)
	cfg = meshConfig(peer)
	cfg.ActivateEpoch = &five
	h.m.Apply(6, cfg)
	h.pass(t)
	if ok, why := h.m.Ready(); ok || !strings.Contains(why, "epoch 5") {
		t.Errorf("unknown epoch: ready %v, %q", ok, why)
	}
}

func TestNothingSentBeforeMeshProtocol(t *testing.T) {
	h := newHarness(t)
	h.enabled = false
	cfg := meshConfig(peerKey(t))
	cfg.RotateKey = true
	h.m.Apply(1, cfg)
	h.pass(t)
	if len(h.sent.msgs) != 0 {
		t.Fatalf("sent %d frames to an old control plane", len(h.sent.msgs))
	}
	h.enabled = true
	h.m.Connected()
	h.pass(t)
	if len(h.sent.keys()) != 1 || len(h.sent.statuses()) != 1 {
		t.Errorf("after Connected: %d keys, %d statuses", len(h.sent.keys()), len(h.sent.statuses()))
	}
}

func TestTeardown(t *testing.T) {
	h := newHarness(t)
	h.m.Apply(1, meshConfig(peerKey(t)))
	h.pass(t)
	dev := h.plat.dev
	h.m.Apply(2, nil)
	h.pass(t)
	if !dev.closed || h.dns.Addr() != "" || !h.fw.removed || len(h.fw.unmarked) == 0 {
		t.Errorf("teardown: dev closed %v dns %q table removed %v unmarked %v", dev.closed, h.dns.Addr(), h.fw.removed, h.fw.unmarked)
	}
	if !strings.Contains(strings.Join(h.plat.removed, ","), DNSInterface) {
		t.Errorf("removed links %v", h.plat.removed)
	}
	if _, err := os.Stat(h.keyPath); err != nil {
		t.Errorf("key file gone: %v", err)
	}
	if addr, pending := h.m.PrivateDNS(); addr != "" || pending {
		t.Errorf("PrivateDNS after teardown = %q %v", addr, pending)
	}
	// Once only.
	removed := len(h.plat.removed)
	h.m.Apply(3, nil)
	h.pass(t)
	if len(h.plat.removed) != removed {
		t.Error("teardown repeated")
	}
	n := len(h.sent.msgs)
	h.m.report(context.Background(), true)
	if len(h.sent.msgs) != n {
		t.Error("mesh_status sent with the mesh off")
	}
}

func TestNothingChangesBeforeFirstDesiredState(t *testing.T) {
	h := newHarness(t)
	h.pass(t)
	if len(h.plat.removed) != 0 || h.fw.removed || h.plat.dev != nil {
		t.Error("the host changed before any desired state")
	}
}

func TestOffModeOnlyTearsDown(t *testing.T) {
	h := newHarness(t)
	h.m.opts.Mode = ModeOff
	if h.m.Hello() != nil {
		t.Error("hello.mesh with the mesh off")
	}
	h.m.Apply(1, meshConfig(peerKey(t)))
	h.pass(t)
	if h.plat.dev != nil || !h.fw.removed {
		t.Error("off mode brought the mesh up or did not clean up")
	}
}

func TestNFTablesBackendMark(t *testing.T) {
	h := newHarness(t)
	h.driver = "nftables"
	h.m.Prepare(context.Background())
	hello := h.m.Hello()
	if hello.DockerFirewall != "nftables" || hello.AcceptFwmark {
		t.Errorf("hello = %+v", hello)
	}
	h.m.Apply(1, meshConfig(peerKey(t)))
	h.pass(t)
	ok, why := h.m.Ready()
	if ok || !strings.Contains(why, `"bridge-accept-fwmark": "0x2000000/0x2000000"`) {
		t.Errorf("ready %v, %q", ok, why)
	}
	h.daemon = []byte(`{"bridge-accept-fwmark": "0x2000000/0x2000000"}`)
	h.pass(t)
	if ok, why := h.m.Ready(); !ok {
		t.Errorf("not ready with the daemon setting: %s", why)
	}
	if len(h.fw.marks) != 0 {
		t.Error("DOCKER-USER touched on the nftables backend")
	}
}

func TestHello(t *testing.T) {
	h := newHarness(t)
	h.m.Prepare(context.Background())
	got := h.m.Hello()
	want := protocol.HelloMesh{
		PublicKey: h.m.keys.PublicKey(), ListenPort: 51820, Mode: protocol.MeshKernel,
		NAT: NATBehind, DockerFirewall: "iptables", AcceptFwmark: true,
	}
	if g, w := mustJSON(t, got), mustJSON(t, want); g != w {
		t.Errorf("hello = %s, want %s", g, w)
	}
	h.m.opts.Endpoint = "node.example.com:51820"
	if got := h.m.Hello(); got.NAT != NATPublic || got.EndpointOverride == nil || *got.EndpointOverride != "node.example.com:51820" {
		t.Errorf("hello with endpoint = %+v", got)
	}
	h.fw.markErr = errors.New("iptables: no chain DOCKER-USER")
	h.m.Prepare(context.Background())
	if h.m.Hello().AcceptFwmark {
		t.Error("accept_fwmark true without DOCKER-USER")
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestBuildZone(t *testing.T) {
	no := false
	cfg := &protocol.MeshConfig{Addresses: []protocol.MeshAddress{
		{IP: "10.200.1.10", EnvTag: 1, NodeID: "self", PrivateDomain: "web.prod.p.internal"},
		{IP: "10.200.1.11", EnvTag: 1, NodeID: "self", PrivateDomain: "web.prod.p.internal"}, // not running
		{IP: "10.200.2.10", EnvTag: 1, NodeID: "other", PrivateDomain: "web.prod.p.internal", Healthy: &no},
		{IP: "10.200.2.11", EnvTag: 2, NodeID: "other", PrivateDomain: "web.stage.p.internal"},
		{IP: "10.200.1.12", EnvTag: 2, NodeID: "self"}, // no name, still an asker
	}}
	z := buildZone(cfg, "self", map[netip.Addr]Replica{
		netip.MustParseAddr("10.200.1.10"): {BridgeIP: netip.MustParseAddr("172.18.0.2"), Healthy: true},
		netip.MustParseAddr("10.200.1.12"): {BridgeIP: netip.MustParseAddr("172.19.0.2")},
	})
	if len(z.Askers) != 2 || z.Askers[netip.MustParseAddr("172.18.0.2")] != 1 || z.Askers[netip.MustParseAddr("172.19.0.2")] != 2 {
		t.Errorf("askers = %v", z.Askers)
	}
	want := []ingress.PrivateRecord{
		{Domain: "web.prod.p.internal", EnvTag: 1, Addr: netip.MustParseAddr("172.18.0.2"), Healthy: true},
		{Domain: "web.prod.p.internal", EnvTag: 1, Addr: netip.MustParseAddr("10.200.2.10"), Healthy: false},
		{Domain: "web.stage.p.internal", EnvTag: 2, Addr: netip.MustParseAddr("10.200.2.11"), Healthy: true},
	}
	if mustJSON(t, z.Records) != mustJSON(t, want) {
		t.Errorf("records = %+v", z.Records)
	}
}

func TestInferNAT(t *testing.T) {
	iface := func(name string, up bool, addrs ...string) Interface {
		i := Interface{Name: name, Up: up}
		for _, a := range addrs {
			i.Addrs = append(i.Addrs, netip.MustParsePrefix(a))
		}
		return i
	}
	cases := []struct {
		name   string
		ifaces []Interface
		want   string
	}{
		{"public", []Interface{iface("eth0", true, "203.0.113.7/24")}, NATPublic},
		{"rfc1918", []Interface{iface("eth0", true, "192.168.1.5/24", "10.1.2.3/8", "172.16.0.9/12")}, NATBehind},
		{"cgnat", []Interface{iface("eth0", true, "100.72.1.1/10")}, NATBehind},
		{"link-local", []Interface{iface("eth0", true, "169.254.3.3/16")}, NATBehind},
		{"down", []Interface{iface("eth1", false, "203.0.113.7/24")}, NATBehind},
		{"docker bridge", []Interface{iface("docker0", true, "203.0.113.7/24"), iface("br-1234", true, "198.51.100.1/24")}, NATBehind},
		{"veth and own", []Interface{iface("veth9", true, "203.0.113.7/24"), iface("wg0", true, "198.51.100.1/16"), iface("rh-abc", true, "198.51.100.2/24")}, NATBehind},
		{"ipv6 only", []Interface{iface("eth0", true, "2001:db8::1/64")}, NATBehind},
		{"public among private", []Interface{iface("eth0", true, "10.0.0.2/24"), iface("eth1", true, "198.51.100.20/24")}, NATPublic},
		{"none", nil, NATBehind},
	}
	for _, tc := range cases {
		if got := InferNAT(tc.ifaces); got != tc.want {
			t.Errorf("%s: %s, want %s", tc.name, got, tc.want)
		}
	}
}

func TestKeyStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", KeyFileName)
	k, created, err := OpenKeyStore(path)
	if err != nil || !created {
		t.Fatalf("create: %v %v", created, err)
	}
	if runtime.GOOS != "windows" {
		fi, err := os.Stat(path)
		if err != nil || fi.Mode().Perm() != 0o600 {
			t.Errorf("mode = %v, %v; want 0600", fi.Mode(), err)
		}
	}
	data, _ := os.ReadFile(path)
	var f map[string]any
	if err := json.Unmarshal(data, &f); err != nil || f["epoch"] != 0.0 || f["next"] != nil {
		t.Errorf("file = %s (%v)", data, err)
	}
	if _, ok := f["private_key"].(string); !ok {
		t.Error("no private_key")
	}
	if strings.Contains(string(data), k.PublicKey()) {
		t.Error("the file stores the public key, not just the private one")
	}

	pub, epoch, err := k.Rotate()
	if err != nil || epoch != 1 {
		t.Fatal(epoch, err)
	}
	again, epoch2, _ := k.Rotate()
	if again != pub || epoch2 != 1 {
		t.Error("a second Rotate made another key")
	}
	k2, created, err := OpenKeyStore(path)
	if err != nil || created {
		t.Fatal(created, err)
	}
	if p, e, ok := k2.Next(); !ok || p != pub || e != 1 {
		t.Error("reopen lost the pending key")
	}
	if changed, err := k2.Activate(1); !changed || err != nil {
		t.Fatal(changed, err)
	}
	k3, _, _ := OpenKeyStore(path)
	if k3.PublicKey() != pub {
		t.Error("activation not persisted")
	}
	if _, e := k3.Current(); e != 1 {
		t.Errorf("epoch = %d", e)
	}
	if changed, err := k3.Activate(1); changed || err != nil {
		t.Error("re-activation is not a no-op")
	}
	if _, err := k3.Activate(2); err == nil {
		t.Error("activated an epoch with no key")
	}
	for _, bad := range []string{"{", `{"epoch":0,"private_key":"x"}`, `{"epoch":-1,"private_key":"` + k3.cur.String() + `"}`,
		`{"epoch":2,"private_key":"` + k3.cur.String() + `","next":{"epoch":2,"private_key":"` + k3.cur.String() + `"}}`} {
		if err := os.WriteFile(path, []byte(bad), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, _, err := OpenKeyStore(path); err == nil {
			t.Errorf("accepted corrupt key file %s", bad)
		}
	}
	// The private key never appears in an error.
	if err := os.WriteFile(path, []byte(`{"epoch":-1,"private_key":"`+k3.cur.String()+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := OpenKeyStore(path); err == nil || strings.Contains(err.Error(), k3.cur.String()) {
		t.Errorf("error leaks the key: %v", err)
	}
}

func TestResolveUDP(t *testing.T) {
	a, err := resolveUDP(context.Background(), "192.0.2.1:51820")
	if err != nil || a.String() != "192.0.2.1:51820" {
		t.Errorf("%v %v", a, err)
	}
	a, err = resolveUDP(context.Background(), "[2001:db8::1]:51820")
	if err != nil || !a.IP.Equal(net.ParseIP("2001:db8::1")) {
		t.Errorf("%v %v", a, err)
	}
	if _, err := resolveUDP(context.Background(), "nope"); err == nil {
		t.Error("accepted a bad endpoint")
	}
}
