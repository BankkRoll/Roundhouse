package api

import (
	"context"
	"net/http"
)

// WireGuard mesh routes (ADR 0005). Turning the mesh on and its supernet are
// instance settings, which the CLI does not change.
var (
	RouteGetMesh       = Route{http.MethodGet, "/v1/workspaces/{workspaceId}/mesh"}
	RouteRotateMeshKey = Route{http.MethodPost, "/v1/workspaces/{workspaceId}/nodes/{nodeId}/mesh/rotate-key"}
)

// How two servers reach each other, from MESH_PATH_VALUES in the API.
const (
	MeshPathDirect  = "direct"
	MeshPathRelayed = "relayed"
	MeshPathDown    = "down"
)

// MeshPaths lists every pair path, in the API's order.
var MeshPaths = []string{MeshPathDirect, MeshPathRelayed, MeshPathDown}

// How a server runs wg0, from MESH_MODE_VALUES in the API.
const (
	MeshModeKernel      = "kernel"
	MeshModeUserspace   = "userspace"
	MeshModeUnavailable = "unavailable"
)

// MeshModes lists every wg0 mode, in the API's order.
var MeshModes = []string{MeshModeKernel, MeshModeUserspace, MeshModeUnavailable}

// Reachability an agent reports, from MESH_NAT_VALUES in the API.
const (
	MeshNATPublic = "public"
	MeshNATBehind = "nat"
)

// MeshNATKinds lists every reachability kind, in the API's order.
var MeshNATKinds = []string{MeshNATPublic, MeshNATBehind}

// Error codes the mesh routes answer with.
const (
	// ErrMeshRotationInProgress is the 409 while another server rotates its
	// key; only one server rotates at a time.
	ErrMeshRotationInProgress = "mesh_rotation_in_progress"
	// ErrMeshNotJoined is the 409 for a server outside the mesh.
	ErrMeshNotJoined = "mesh_not_joined"
)

// Mesh is the private WireGuard network between a workspace's servers.
type Mesh struct {
	// Enabled is the instance setting mesh_enabled.
	Enabled bool `json:"enabled"`
	// Supernet is the instance setting mesh_supernet, e.g. "10.200.0.0/16".
	Supernet string     `json:"supernet"`
	Nodes    []MeshNode `json:"nodes"`
	Pairs    []MeshPair `json:"pairs"`
}

// MeshNode is one server as the mesh sees it. Fields the agent reports are
// nil until the server joined the mesh.
type MeshNode struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
	// Supported is false for an agent too old to speak the mesh protocol;
	// such a server stays a single-node host.
	Supported bool `json:"supported"`
	// MeshIndex is the server's /24 within the supernet.
	MeshIndex *int `json:"mesh_index"`
	// Address is the server's wg0 address.
	Address *string `json:"address"`
	// PublicKey is the current WireGuard public key, standard base64.
	PublicKey *string `json:"public_key"`
	// Mode is one of [MeshModes].
	Mode *string `json:"mode"`
	// NAT is one of [MeshNATKinds].
	NAT *string `json:"nat"`
	// Endpoint is where peers send packets ("host:port"); nil behind NAT.
	Endpoint   *string `json:"endpoint"`
	ListenPort *int    `json:"listen_port"`
	// DockerFirewall is "iptables" or "nftables".
	DockerFirewall *string `json:"docker_firewall"`
	// AcceptFwmark reports that Docker lets marked mesh packets past its
	// forward drop.
	AcceptFwmark *bool `json:"accept_fwmark"`
	// Ready means wg0 is up, firewall rules are applied and private DNS is
	// listening, as last reported.
	Ready bool `json:"ready"`
	// Error is why the server is not ready, as the agent reported it.
	Error *string `json:"error"`
	// KeyEpoch increases with every key rotation.
	KeyEpoch     int    `json:"key_epoch"`
	KeyRotatedAt *int64 `json:"key_rotated_at"`
	// Rotating is set while a key rotation is in progress.
	Rotating bool `json:"rotating"`
	// Relay is set when the server relays traffic for a pair behind NAT.
	Relay bool `json:"relay"`
	// StatusAt is when the agent last reported mesh health.
	StatusAt *int64 `json:"status_at"`
}

// MeshPeerView is one side's view of a tunnel.
type MeshPeerView struct {
	NodeID string `json:"node_id"`
	// Endpoint is the peer's address as this side last saw it.
	Endpoint        *string `json:"endpoint"`
	LastHandshakeAt *int64  `json:"last_handshake_at"`
	RxBytes         int64   `json:"rx_bytes"`
	TxBytes         int64   `json:"tx_bytes"`
}

// MeshPair is a pair of servers in the mesh and how they reach each other.
type MeshPair struct {
	// Nodes are the two server IDs, lower first.
	Nodes [2]string `json:"nodes"`
	// Path is one of [MeshPaths].
	Path string `json:"path"`
	// RelayNodeID is the server relaying a relayed pair.
	RelayNodeID *string `json:"relay_node_id"`
	// LastHandshakeAt is the latest handshake either side reported.
	LastHandshakeAt *int64 `json:"last_handshake_at"`
	// Sides are each side's report; empty for a relayed pair, whose tunnels
	// go to the relay.
	Sides []MeshPeerView `json:"sides"`
}

// GetMesh returns the workspace's mesh: whether it is on, every server's
// mesh state and every pair's path.
func (c *Client) GetMesh(ctx context.Context, workspaceID string) (*Mesh, error) {
	return fetch[Mesh](ctx, c, RouteGetMesh, nil, nil, workspaceID)
}

// RotateMeshKey starts a WireGuard key rotation for one server and returns
// it with Rotating set. Tunnels to the server pause for about two seconds.
// The API answers 409 [ErrMeshRotationInProgress] while another server
// rotates and 409 [ErrMeshNotJoined] for a server outside the mesh.
func (c *Client) RotateMeshKey(ctx context.Context, workspaceID, nodeID string) (*MeshNode, error) {
	return fetch[MeshNode](ctx, c, RouteRotateMeshKey, nil, nil, workspaceID, nodeID)
}
