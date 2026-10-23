package protocol

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// MeshMode is how the agent runs wg0.
type MeshMode string

// Mesh modes.
const (
	MeshKernel      MeshMode = "kernel"
	MeshUserspace   MeshMode = "userspace"
	MeshUnavailable MeshMode = "unavailable"
)

// HelloMesh is the mesh part of [Hello]. The private key never leaves the
// node.
type HelloMesh struct {
	// PublicKey is standard base64 of the 32-byte WireGuard public key.
	PublicKey  string   `json:"public_key"`
	ListenPort int      `json:"listen_port"`
	Mode       MeshMode `json:"mode"`
	// NAT is "public" or "nat".
	NAT string `json:"nat"`
	// EndpointOverride is agent config mesh.endpoint ("host:port"), or nil.
	EndpointOverride *string `json:"endpoint_override"`
	// DockerFirewall is "iptables" or "nftables".
	DockerFirewall string `json:"docker_firewall"`
	// AcceptFwmark reports that Docker accepts packets carrying the mesh mark.
	AcceptFwmark bool `json:"accept_fwmark"`
}

func (h *HelloMesh) validate() error {
	if !isKey32(h.PublicKey) {
		return errors.New("mesh.public_key: expected a base64 32-byte key")
	}
	if !validPort(h.ListenPort) {
		return errors.New("mesh.listen_port: out of range")
	}
	switch h.Mode {
	case MeshKernel, MeshUserspace, MeshUnavailable:
	default:
		return fmt.Errorf("mesh.mode: invalid %q", h.Mode)
	}
	if h.NAT != "public" && h.NAT != "nat" {
		return fmt.Errorf("mesh.nat: invalid %q", h.NAT)
	}
	if h.EndpointOverride != nil && !IsHostPort(*h.EndpointOverride) {
		return fmt.Errorf("mesh.endpoint_override: invalid %q", *h.EndpointOverride)
	}
	if h.DockerFirewall != "iptables" && h.DockerFirewall != "nftables" {
		return fmt.Errorf("mesh.docker_firewall: invalid %q", h.DockerFirewall)
	}
	return nil
}

// MeshPeer is one WireGuard peer; its preshared key is in
// [MeshConfig].PSKsSealed.
type MeshPeer struct {
	NodeID    string `json:"node_id"`
	PublicKey string `json:"public_key"`
	// Endpoint is nil on the public side of a direct pair (roaming).
	Endpoint *string `json:"endpoint"`
	// AllowedIPs are the peer's /24 plus the /24s it relays for this node.
	AllowedIPs []string `json:"allowed_ips"`
	// KeepaliveS is 0 or 25.
	KeepaliveS int `json:"keepalive_s"`
}

// MeshAddress is a mesh IP this node must know for NAT and isolation.
type MeshAddress struct {
	IP string `json:"ip"`
	// EnvTag is environments.net_tag, keying the nftables sets.
	EnvTag int    `json:"env_tag"`
	NodeID string `json:"node_id"`
	// RoutedPorts have an ingress route and are admitted from node addresses.
	RoutedPorts []int `json:"routed_ports"`
}

// MeshConfig is [DesiredState].Mesh (ADR 0005).
type MeshConfig struct {
	// Supernet is e.g. "10.200.0.0/16", at most a /16.
	Supernet   string `json:"supernet"`
	NodeIndex  int    `json:"node_index"`
	Address    string `json:"address"`
	DNSAddress string `json:"dns_address"`
	ListenPort int    `json:"listen_port"`
	MTU        int    `json:"mtu"`
	// AcceptFwmark is the mark Docker accepts, e.g. 0x2000000.
	AcceptFwmark int64 `json:"accept_fwmark"`
	// RotateKey asks for a new key, reported in [MeshKey].
	RotateKey bool `json:"rotate_key"`
	// ActivateEpoch swaps to the key of that [MeshKey].Epoch.
	ActivateEpoch *int64     `json:"activate_epoch"`
	Peers         []MeshPeer `json:"peers"`
	// PSKsSealed opens with [OpenMeshPSKs]; non-nil exactly with peers.
	PSKsSealed *SealedBox `json:"psks_sealed"`
	// ForwardPairs are [2]CIDR pairs this node relays wg0 → wg0.
	ForwardPairs [][]string `json:"forward_pairs"`
	// NodeAddresses is every node's .1 address.
	NodeAddresses []string      `json:"node_addresses"`
	Addresses     []MeshAddress `json:"addresses"`
}

func (m *MeshConfig) validate() error {
	if !IsIPv4CIDR(m.Supernet) {
		return fmt.Errorf("mesh.supernet: invalid %q", m.Supernet)
	}
	if bits, _ := strconv.Atoi(m.Supernet[strings.IndexByte(m.Supernet, '/')+1:]); bits > 16 {
		return errors.New("mesh.supernet: must be a /16 or larger")
	}
	if m.NodeIndex < 1 || m.NodeIndex > 254 {
		return errors.New("mesh.node_index: out of range")
	}
	if !IPv4InCIDR(m.Address, m.Supernet) || !IPv4InCIDR(m.DNSAddress, m.Supernet) {
		return errors.New("mesh: address and dns_address must be inside the supernet")
	}
	if !validPort(m.ListenPort) || m.MTU < 1280 || m.MTU > 1500 || m.AcceptFwmark < 1 || m.AcceptFwmark > 0xffff_ffff {
		return errors.New("mesh: listen_port, mtu or accept_fwmark out of range")
	}
	if m.ActivateEpoch != nil && *m.ActivateEpoch < 1 {
		return errors.New("mesh.activate_epoch: must be positive")
	}
	if len(m.Peers) > MaxMeshPeers {
		return fmt.Errorf("mesh.peers: at most %d", MaxMeshPeers)
	}
	seen := map[string]bool{}
	for _, p := range m.Peers {
		if !nodeIDRE.MatchString(p.NodeID) || seen[p.NodeID] {
			return fmt.Errorf("mesh.peers: invalid or duplicate peer %q", p.NodeID)
		}
		seen[p.NodeID] = true
		if !isKey32(p.PublicKey) || (p.Endpoint != nil && !IsHostPort(*p.Endpoint)) ||
			(p.KeepaliveS != 0 && p.KeepaliveS != 25) {
			return fmt.Errorf("mesh.peers: invalid peer %s", p.NodeID)
		}
		if len(p.AllowedIPs) == 0 || len(p.AllowedIPs) > MaxMeshAllowedIPs {
			return fmt.Errorf("mesh.peers: %s needs 1 to %d allowed_ips", p.NodeID, MaxMeshAllowedIPs)
		}
		for _, c := range p.AllowedIPs {
			if !IsIPv4CIDR(c) {
				return fmt.Errorf("mesh.peers: %s: invalid allowed ip %q", p.NodeID, c)
			}
		}
	}
	if (len(m.Peers) > 0) != (m.PSKsSealed != nil) {
		return errors.New("mesh.psks_sealed: required exactly when there are peers")
	}
	if m.PSKsSealed != nil {
		if err := m.PSKsSealed.validate(); err != nil {
			return fmt.Errorf("mesh.psks_sealed: %w", err)
		}
	}
	if len(m.ForwardPairs) > MaxMeshForwardPairs {
		return fmt.Errorf("mesh.forward_pairs: at most %d", MaxMeshForwardPairs)
	}
	for _, pair := range m.ForwardPairs {
		if len(pair) != 2 || !IsIPv4CIDR(pair[0]) || !IsIPv4CIDR(pair[1]) {
			return errors.New("mesh.forward_pairs: each pair is two IPv4 CIDRs")
		}
	}
	if len(m.NodeAddresses) > MaxMeshPeers+1 {
		return fmt.Errorf("mesh.node_addresses: at most %d", MaxMeshPeers+1)
	}
	for _, a := range m.NodeAddresses {
		if !IsIPv4(a) {
			return fmt.Errorf("mesh.node_addresses: invalid %q", a)
		}
	}
	if len(m.Addresses) > MaxMeshAddresses {
		return fmt.Errorf("mesh.addresses: at most %d", MaxMeshAddresses)
	}
	ips := map[string]bool{}
	for _, a := range m.Addresses {
		if !IPv4InCIDR(a.IP, m.Supernet) || ips[a.IP] {
			return fmt.Errorf("mesh.addresses: %q is outside the supernet or duplicated", a.IP)
		}
		ips[a.IP] = true
		if a.EnvTag < 1 || a.EnvTag > 65_535 || !nodeIDRE.MatchString(a.NodeID) || len(a.RoutedPorts) > MaxPorts {
			return fmt.Errorf("mesh.addresses: invalid entry for %s", a.IP)
		}
		for _, p := range a.RoutedPorts {
			if !validPort(p) {
				return fmt.Errorf("mesh.addresses: invalid port %d", p)
			}
		}
	}
	return nil
}

// MeshPeerStatus is one peer as wg0 sees it.
type MeshPeerStatus struct {
	NodeID          string  `json:"node_id"`
	LastHandshakeMS *int64  `json:"last_handshake_ms"`
	Endpoint        *string `json:"endpoint"`
	RxBytes         int64   `json:"rx_bytes"`
	TxBytes         int64   `json:"tx_bytes"`
}

// MeshStatus reports mesh health every 30 s and on change. Type must be
// [TypeMeshStatus].
type MeshStatus struct {
	Type string `json:"type"`
	// Epoch of the key wg0 currently uses.
	Epoch int64            `json:"epoch"`
	Peers []MeshPeerStatus `json:"peers"`
	// Ready means wg0 is up, nftables applied and DNS listening.
	Ready bool `json:"ready"`
	// Error says why the mesh isn't ready.
	Error string `json:"error,omitempty"`
}

func (*MeshStatus) agentMessage() {}

// Validate implements [Validator].
func (m *MeshStatus) Validate() error {
	if m.Epoch < 0 || len(m.Peers) > MaxMeshPeers || len(m.Error) > MaxMessageBytes {
		return errors.New("mesh_status: out of range")
	}
	for _, p := range m.Peers {
		if !nodeIDRE.MatchString(p.NodeID) || (p.LastHandshakeMS != nil && *p.LastHandshakeMS < 0) ||
			(p.Endpoint != nil && !IsHostPort(*p.Endpoint)) || p.RxBytes < 0 || p.TxBytes < 0 {
			return fmt.Errorf("mesh_status: invalid peer %q", p.NodeID)
		}
	}
	return nil
}

// MeshKey reports the next WireGuard public key after
// [MeshConfig].RotateKey. Type must be [TypeMeshKey].
type MeshKey struct {
	Type      string `json:"type"`
	PublicKey string `json:"public_key"`
	// Epoch increases with every rotation.
	Epoch int64 `json:"epoch"`
}

func (*MeshKey) agentMessage() {}

// Validate implements [Validator].
func (m *MeshKey) Validate() error {
	if !isKey32(m.PublicKey) || m.Epoch < 1 {
		return errors.New("mesh_key: invalid public_key or epoch")
	}
	return nil
}

func isKey32(b64 string) bool {
	raw, err := base64.StdEncoding.DecodeString(b64)
	return err == nil && len(raw) == 32 && base64Key32RE.MatchString(b64)
}
