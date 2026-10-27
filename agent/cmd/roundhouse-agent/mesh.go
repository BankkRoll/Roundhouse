package main

import (
	"context"
	"crypto/ecdh"
	"log/slog"
	"path/filepath"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/config"
	"github.com/BankkRoll/Roundhouse/agent/internal/conn"
	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/ingress"
	"github.com/BankkRoll/Roundhouse/agent/internal/mesh"
	agentruntime "github.com/BankkRoll/Roundhouse/agent/internal/runtime"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// newMesh builds the WireGuard mesh manager (ADR 0005) and probes its
// prerequisites for hello. A node whose config turns the mesh off still
// gets one: it tears down whatever an earlier configuration left.
func newMesh(cfg config.Config, client *conn.Client, dc *docker.Client, encryption *ecdh.PrivateKey, dataDir string,
	log *slog.Logger) (*mesh.Manager, error) {
	m, err := mesh.New(mesh.Options{
		NodeID:     cfg.NodeID,
		KeyPath:    filepath.Join(dataDir, mesh.KeyFileName),
		Mode:       cfg.MeshMode(),
		ListenPort: cfg.MeshListenPort(),
		Endpoint:   cfg.Mesh.Endpoint,
		OpenPSKs: func(generation int64, m *protocol.MeshConfig) (map[string][]byte, error) {
			return protocol.OpenMeshPSKs(encryption, cfg.NodeID, generation, m)
		},
		Send:    client.Send,
		Enabled: func() bool { return client.PeerProtocolVersion() >= protocol.MeshProtocolVersion },
		DNS:     ingress.NewPrivateDNS(ingress.PrivateDNSOptions{Logger: log.With("component", "private-dns")}),
		DockerFirewall: func(ctx context.Context) (string, error) {
			info, err := dc.Info(ctx)
			if err != nil || info.FirewallBackend == nil {
				return "", err
			}
			return info.FirewallBackend.Driver, nil
		},
		Logger: log.With("component", "mesh"),
	})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	m.Prepare(ctx)
	return m, nil
}

// meshHooks adapts the mesh manager to the runtime's view of it.
type meshHooks struct{ m *mesh.Manager }

// PrivateDNS returns the private DNS address and whether it is pending.
func (h meshHooks) PrivateDNS() (string, bool) { return h.m.PrivateDNS() }

// SetReplicas hands the local replicas with mesh IPs to the mesh.
func (h meshHooks) SetReplicas(rs []agentruntime.MeshReplica) {
	out := make([]mesh.Replica, len(rs))
	for i, r := range rs {
		out[i] = mesh.Replica{MeshIP: r.MeshIP, BridgeIP: r.BridgeIP, Healthy: r.Healthy}
	}
	h.m.SetReplicas(out)
}
