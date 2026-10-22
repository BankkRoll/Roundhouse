package protocol

// ProtocolVersion is the wire protocol version agents send in [Hello].
const ProtocolVersion = 1

// Message type discriminators carried in every frame's "type" field.
const (
	TypeHello        = "hello"
	TypeHeartbeat    = "heartbeat"
	TypeWelcome      = "welcome"
	TypeDesiredState = "desired_state"
)

// Arch is a CPU architecture the control plane can schedule onto.
type Arch string

// Supported architectures, named as in Go's GOARCH.
const (
	ArchAMD64 Arch = "amd64"
	ArchARM64 Arch = "arm64"
)

// Valid reports whether a is an architecture the protocol accepts.
func (a Arch) Valid() bool {
	return a == ArchAMD64 || a == ArchARM64
}

// Hardware holds static hardware facts collected once at agent start.
type Hardware struct {
	CPUCores  int   `json:"cpu_cores"`
	MemBytes  int64 `json:"mem_bytes"`
	DiskBytes int64 `json:"disk_bytes"`
}

// Capabilities lists optional features a node offers to the scheduler.
type Capabilities struct {
	Docker  bool `json:"docker"`
	GVisor  bool `json:"gvisor"`
	Builder bool `json:"builder"`
}

// NodeUsage is a point-in-time resource usage sample for the whole node.
type NodeUsage struct {
	// CPUPercent is in the range [0, 100] across all cores.
	CPUPercent     float64 `json:"cpu_percent"`
	MemUsedBytes   int64   `json:"mem_used_bytes"`
	MemTotalBytes  int64   `json:"mem_total_bytes"`
	DiskUsedBytes  int64   `json:"disk_used_bytes"`
	DiskTotalBytes int64   `json:"disk_total_bytes"`
	Load1          float64 `json:"load1"`
}

// AgentMessage is any frame an agent may send. It is implemented only by
// [*Hello] and [*Heartbeat].
type AgentMessage interface {
	agentMessage()
}

// Hello is the first frame on every connection and is re-sent after each
// reconnect. Type must be [TypeHello].
type Hello struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocol_version"`
	NodeID          string `json:"node_id"`
	AgentVersion    string `json:"agent_version"`
	OS              string `json:"os"`
	Arch            Arch   `json:"arch"`
	Kernel          string `json:"kernel"`
	// DockerVersion is nil when Docker is absent or unreachable.
	DockerVersion *string      `json:"docker_version"`
	Hardware      Hardware     `json:"hardware"`
	Capabilities  Capabilities `json:"capabilities"`
	// ObservedGeneration is the last desired_state generation applied; 0 on a
	// fresh node.
	ObservedGeneration int64 `json:"observed_generation"`
}

func (*Hello) agentMessage() {}

// Heartbeat is the periodic liveness and usage report. Type must be
// [TypeHeartbeat].
type Heartbeat struct {
	Type string `json:"type"`
	// Seq is a per-process counter that lets the control plane spot gaps.
	Seq int64 `json:"seq"`
	// TS is agent wall-clock time in unix ms, used only for skew diagnostics.
	TS                 int64     `json:"ts"`
	ObservedGeneration int64     `json:"observed_generation"`
	Usage              NodeUsage `json:"usage"`
}

func (*Heartbeat) agentMessage() {}

// ControlHeader holds the fields every signed control payload carries to
// prevent replay and misrouting.
type ControlHeader struct {
	// ID uniquely identifies the message.
	ID string `json:"id"`
	// NodeID is the target node; agents reject payloads addressed elsewhere.
	NodeID string `json:"node_id"`
	// IssuedAt is unix ms.
	IssuedAt int64 `json:"iat"`
	// ExpiresAt is unix ms; agents reject payloads past it.
	ExpiresAt int64 `json:"exp"`
}

// Header returns the routing and replay-protection fields of a control message.
func (h ControlHeader) Header() ControlHeader { return h }

// ControlMessage is any payload the control plane may sign and send. It is
// implemented only by [*Welcome] and [*DesiredState]; use a type switch to
// handle each.
type ControlMessage interface {
	// Header returns the message's routing and replay-protection fields.
	Header() ControlHeader
	controlMessage()
}

// Welcome acknowledges [Hello] and configures the connection. Type must be
// [TypeWelcome].
type Welcome struct {
	Type string `json:"type"`
	ControlHeader
	HeartbeatIntervalMS int64 `json:"heartbeat_interval_ms"`
}

func (*Welcome) controlMessage() {}

// Workload is one container the node should be running. It is deliberately
// minimal until Phase 1 defines builds and deployments.
type Workload struct {
	ID    string `json:"id"`
	Image string `json:"image"`
}

// DesiredState is the complete set of workloads for a node. Type must be
// [TypeDesiredState].
type DesiredState struct {
	Type string `json:"type"`
	ControlHeader
	// Generation is monotonic; agents ignore anything not newer than what
	// they have applied.
	Generation int64      `json:"generation"`
	Workloads  []Workload `json:"workloads"`
}

func (*DesiredState) controlMessage() {}
