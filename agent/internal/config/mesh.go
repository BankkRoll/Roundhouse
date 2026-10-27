package config

import (
	"errors"
	"fmt"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// Mesh modes of [MeshConfig].Mode.
const (
	MeshAuto      = "auto"
	MeshKernel    = "kernel"
	MeshUserspace = "userspace"
	MeshOff       = "off"
)

// DefaultMeshListenPort is the WireGuard port when mesh.listen_port is unset.
const DefaultMeshListenPort = 51820

// MeshConfig is the mesh section of the config (ADR 0005).
type MeshConfig struct {
	// Mode picks the WireGuard implementation: auto (the kernel module,
	// else embedded wireguard-go), kernel, userspace, or off (no mesh; any
	// mesh this node had is torn down). Empty means auto.
	Mode string `yaml:"mode,omitempty"`
	// ListenPort is wg0's UDP port; zero means [DefaultMeshListenPort].
	ListenPort int `yaml:"listen_port,omitempty"`
	// Endpoint is "host:port" where other nodes reach this one, for a node
	// reachable only through a port forward. Setting it marks the node
	// public.
	Endpoint string `yaml:"endpoint,omitempty"`
}

// MeshMode returns mesh.mode, or auto when unset.
func (c Config) MeshMode() string {
	if c.Mesh.Mode == "" {
		return MeshAuto
	}
	return c.Mesh.Mode
}

// MeshListenPort returns mesh.listen_port, or its default when unset.
func (c Config) MeshListenPort() int {
	if c.Mesh.ListenPort == 0 {
		return DefaultMeshListenPort
	}
	return c.Mesh.ListenPort
}

// validate checks the mesh section.
func (m MeshConfig) validate() error {
	var errs []error
	switch m.Mode {
	case "", MeshAuto, MeshKernel, MeshUserspace, MeshOff:
	default:
		errs = append(errs, fmt.Errorf("mesh.mode must be auto, kernel, userspace or off, got %q", m.Mode))
	}
	if m.ListenPort < 0 || m.ListenPort > 65535 {
		errs = append(errs, errors.New("mesh.listen_port must be 1 to 65535 (0 or absent means 51820)"))
	}
	if m.Endpoint != "" && !protocol.IsHostPort(m.Endpoint) {
		errs = append(errs, fmt.Errorf("mesh.endpoint must be host:port with a lowercase hostname or an IP, got %q", m.Endpoint))
	}
	return errors.Join(errs...)
}
