package protocol

// ProtocolVersion is the wire protocol version agents send in [Hello].
// Version 2 adds workloads, builds, statuses and logs; see PROTOCOL_VERSION
// in messages.ts for why an additive change bumps it.
const ProtocolVersion = 2

// MinProtocolVersion is the oldest version the control plane accepts.
const MinProtocolVersion = 1

// Message type discriminators carried in every frame's "type" field.
const (
	TypeHello          = "hello"
	TypeHeartbeat      = "heartbeat"
	TypeWorkloadStatus = "workload_status"
	TypeLogs           = "logs"
	TypeBuildResult    = "build_result"
	TypeWelcome        = "welcome"
	TypeDesiredState   = "desired_state"
	TypeBuildJob       = "build_job"
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
	Docker bool `json:"docker"`
	GVisor bool `json:"gvisor"`
	// Builder means the node runs BuildKit and the local registry and
	// accepts [BuildJob].
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

// -----------------------------------------------------------------------------
// Agent → control
// -----------------------------------------------------------------------------

// AgentMessage is any frame an agent may send. It is implemented only by
// [*Hello], [*Heartbeat], [*WorkloadStatus], [*Logs] and [*BuildResult].
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
	// Statuses reports every workload the agent manages, so the control
	// plane can resynchronise after a reconnect. Version 1 agents omit it.
	Statuses []WorkloadStatusReport `json:"statuses,omitempty"`
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

// WorkloadState is the lifecycle state of a workload on a node.
type WorkloadState string

// Workload states. Running means the process is up but health is not yet
// established; Healthy means the probe passes, or the replica is up and has
// no probe. Exited means exit code 0 or stopped by policy; Crashed means a
// non-zero exit or an OOM kill.
const (
	StatePending   WorkloadState = "pending"
	StatePulling   WorkloadState = "pulling"
	StateStarting  WorkloadState = "starting"
	StateRunning   WorkloadState = "running"
	StateHealthy   WorkloadState = "healthy"
	StateUnhealthy WorkloadState = "unhealthy"
	StateExited    WorkloadState = "exited"
	StateCrashed   WorkloadState = "crashed"
	StateRemoved   WorkloadState = "removed"
)

// Valid reports whether s is a known workload state.
func (s WorkloadState) Valid() bool {
	switch s {
	case StatePending, StatePulling, StateStarting, StateRunning, StateHealthy,
		StateUnhealthy, StateExited, StateCrashed, StateRemoved:
		return true
	}
	return false
}

// WorkloadStatusReport is one workload's current status, sent in
// [WorkloadStatus] and in [Hello].Statuses.
type WorkloadStatusReport struct {
	WorkloadID string `json:"workload_id"`
	// DeploymentID is nil for system workloads.
	DeploymentID *string       `json:"deployment_id"`
	State        WorkloadState `json:"state"`
	// ContainerID is the Docker container ID, once one exists.
	ContainerID string `json:"container_id,omitempty"`
	// ExitCode is the last exit code, for exited and crashed workloads.
	ExitCode *int `json:"exit_code,omitempty"`
	// Message is a short explanation, e.g. a pull or probe error.
	Message string `json:"message,omitempty"`
	// Restarts counts restarts since the container was created.
	Restarts int `json:"restarts"`
	// TS is when the agent observed this state, unix ms.
	TS int64 `json:"ts"`
}

// WorkloadStatus is sent whenever a workload changes state. Type must be
// [TypeWorkloadStatus].
type WorkloadStatus struct {
	Type string `json:"type"`
	WorkloadStatusReport
}

func (*WorkloadStatus) agentMessage() {}

// Log source types.
const (
	LogSourceRuntime = "runtime"
	LogSourceBuild   = "build"
)

// LogSource says what a [Logs] frame belongs to: a running replica
// (WorkloadID and DeploymentID set) or a build (BuildID set).
type LogSource struct {
	Type         string `json:"type"`
	WorkloadID   string `json:"workload_id,omitempty"`
	DeploymentID string `json:"deployment_id,omitempty"`
	BuildID      string `json:"build_id,omitempty"`
}

// LogStream is the output stream a log line came from.
type LogStream string

// Log streams. [StreamSystem] lines are written by the agent itself.
const (
	StreamStdout LogStream = "stdout"
	StreamStderr LogStream = "stderr"
	StreamSystem LogStream = "system"
)

// LogLine is one log line.
type LogLine struct {
	// TS is when the line was written, unix ms.
	TS     int64     `json:"ts"`
	Stream LogStream `json:"stream"`
	// Text has no trailing newline and is cut with [TruncateLogLine].
	Text string `json:"text"`
}

// Logs is a batch of log lines from one source, flushed at least every
// second: at most [MaxLogLinesPerFrame] lines and [MaxLogFrameTextBytes] of
// text. Type must be [TypeLogs].
type Logs struct {
	Type   string    `json:"type"`
	Source LogSource `json:"source"`
	Lines  []LogLine `json:"lines"`
}

func (*Logs) agentMessage() {}

// BuiltImage is an image pushed to the builder's local registry.
type BuiltImage struct {
	Repository string `json:"repository"`
	Digest     string `json:"digest"`
}

// BuildResult answers a [BuildJob]. Exactly one of Image (when OK) and Error
// (when not) is set. Type must be [TypeBuildResult].
type BuildResult struct {
	Type       string      `json:"type"`
	BuildID    string      `json:"build_id"`
	OK         bool        `json:"ok"`
	Image      *BuiltImage `json:"image,omitempty"`
	Error      string      `json:"error,omitempty"`
	DurationMS int64       `json:"duration_ms"`
}

func (*BuildResult) agentMessage() {}

// -----------------------------------------------------------------------------
// Control → agent
// -----------------------------------------------------------------------------

// ControlHeader holds the fields every signed control payload carries to
// prevent replay and misrouting.
type ControlHeader struct {
	// ID uniquely identifies the message.
	ID string `json:"id"`
	// NodeID is the target node; agents reject payloads addressed elsewhere.
	NodeID string `json:"node_id"`
	// IssuedAt is unix ms.
	IssuedAt int64 `json:"iat"`
	// ExpiresAt is unix ms; agents reject payloads past it. It is at most
	// [CredentialFrameTTLMS] after IssuedAt when the frame carries a
	// credential.
	ExpiresAt int64 `json:"exp"`
}

// Header returns the routing and replay-protection fields of a control message.
func (h ControlHeader) Header() ControlHeader { return h }

// ControlMessage is any payload the control plane may sign and send. It is
// implemented only by [*Welcome], [*DesiredState] and [*BuildJob]; use a type
// switch to handle each.
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

// DesiredState is the complete desired state of a node. The agent converges
// Docker and Caddy to it and removes managed containers no longer listed.
// Type must be [TypeDesiredState].
type DesiredState struct {
	Type string `json:"type"`
	ControlHeader
	// Generation is monotonic; agents ignore anything not newer than what
	// they have applied.
	Generation int64 `json:"generation"`
	// Workloads lists every service workload; system workloads never appear.
	Workloads []WorkloadSpec `json:"workloads"`
	TLSMode   TLSMode        `json:"tls_mode"`
	// AppsDomain is the parent domain of generated hostnames, nil until an
	// operator sets one.
	AppsDomain *string `json:"apps_domain"`
	// Registry is set only for builder nodes.
	Registry *RegistryConfig `json:"registry"`
}

func (*DesiredState) controlMessage() {}

// GitBuildSource is the repository and commit a build checks out.
type GitBuildSource struct {
	// Type is always "git".
	Type string `json:"type"`
	// URL is an https clone URL without credentials.
	URL       string `json:"url"`
	CommitSHA string `json:"commit_sha"`
	Ref       string `json:"ref,omitempty"`
	// Token is a short-lived installation token for private repositories.
	// Its presence caps the frame's lifetime at [CredentialFrameTTLMS].
	Token string `json:"token,omitempty"`
}

// Builder selects how an image is built.
type Builder string

// Builders: Railpack detects the stack; Dockerfile uses the repository's.
const (
	BuilderRailpack   Builder = "railpack"
	BuilderDockerfile Builder = "dockerfile"
)

// BuildJob asks a builder node to build an image and push it to its local
// registry; the node answers with [BuildResult]. Type must be [TypeBuildJob].
type BuildJob struct {
	Type string `json:"type"`
	ControlHeader
	BuildID      string         `json:"build_id"`
	DeploymentID string         `json:"deployment_id"`
	Source       GitBuildSource `json:"source"`
	Builder      Builder        `json:"builder"`
	// DockerfilePath is relative to ContextDir and defaults to "Dockerfile".
	// Only set with [BuilderDockerfile].
	DockerfilePath string `json:"dockerfile_path,omitempty"`
	// ContextDir is the build context inside the repository; "." for the root.
	ContextDir string            `json:"context_dir"`
	BuildArgs  map[string]string `json:"build_args"`
	// ImageRepository is the local-registry repository to push to; see
	// [LocalImageRepository].
	ImageRepository string `json:"image_repository"`
	// CacheKey scopes the BuildKit cache; builds sharing a key share layers.
	CacheKey string `json:"cache_key"`
	// TimeoutS is when the builder cancels and fails the build.
	TimeoutS int `json:"timeout_s"`
}

func (*BuildJob) controlMessage() {}
