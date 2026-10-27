package protocol

import "slices"

// ProtocolVersion is the wire protocol version agents send in [Hello].
// Version 2 adds workloads, builds, statuses and logs; version 3 adds
// [BuildCancel], [BuildJob].SecretBuildArgs and [BuildResult].Cancelled;
// version 4 seals workload environments and build secrets to the node
// (ADR 0014); version 5 is Phase 2 (mesh, volumes, backups, queries,
// signing-key rollover) and version 6 Phase 3 (jobs, metrics,
// certificates); version 7 is Phase 4 (web shell exec frames, image push).
// ADR 0015 records why phases sit one above ADR 0013's plan. See
// PROTOCOL_VERSION in versions.ts.
const ProtocolVersion = 7

// MinProtocolVersion is the oldest version the control plane accepts. ADR
// 0013 raises it with each phase's release, not with its contracts.
const MinProtocolVersion = 3

// WorkloadsProtocolVersion is the first version that receives workloads and
// builds. Every accepted agent is past it; [SealedEnvProtocolVersion] is the
// placement gate now. Mirrors WORKLOADS_PROTOCOL_VERSION in TypeScript.
const WorkloadsProtocolVersion = 2

// BuildCancelProtocolVersion is the first version that understands
// [BuildCancel]. Mirrors BUILD_CANCEL_PROTOCOL_VERSION in TypeScript.
const BuildCancelProtocolVersion = 3

// SecretBuildArgsProtocolVersion is the first version that honours
// [BuildJob].SecretBuildArgs; a build with secret args never goes to an
// older agent. Mirrors SECRET_BUILD_ARGS_PROTOCOL_VERSION in TypeScript.
const SecretBuildArgsProtocolVersion = 3

// SealedEnvProtocolVersion is the first version that opens sealed boxes
// (env_sealed, build_secrets_sealed, hello.encryption_key and the join
// request's encryption key); no workload or build goes to an older agent.
// Mirrors SEALED_ENV_PROTOCOL_VERSION in TypeScript.
const SealedEnvProtocolVersion = 4

// MeshProtocolVersion gates the WireGuard mesh (ADR 0005): [Hello].Mesh,
// [DesiredState].Mesh, [MeshStatus], [MeshKey], route workloads, MeshIP,
// PrivateDNS, Capabilities.Ingress and the registry's mode fields.
// Mirrors MESH_PROTOCOL_VERSION in TypeScript.
const MeshProtocolVersion = 5

// VolumesProtocolVersion gates volumes (ADR 0004): [DesiredState].Volumes,
// mounts, rollout, stop grace, exec probes, published ports,
// [VolumeStatus], [VolumeDelete] and [Hello].VolumeQuota. Mirrors
// VOLUMES_PROTOCOL_VERSION in TypeScript.
const VolumesProtocolVersion = 5

// BackupsProtocolVersion gates backup, restore and volume copy frames and
// task log sources (ADR 0004). Mirrors BACKUPS_PROTOCOL_VERSION.
const BackupsProtocolVersion = 5

// DBQueryProtocolVersion gates [DBQuery] (ADR 0004). Mirrors
// DB_QUERY_PROTOCOL_VERSION.
const DBQueryProtocolVersion = 5

// KeyRolloverProtocolVersion gates [Welcome].NextKeys, [KeyAnnounce] and
// [Hello].PinnedKIDs (ADR 0014 §13). Mirrors KEY_ROLLOVER_PROTOCOL_VERSION.
const KeyRolloverProtocolVersion = 5

// JobsProtocolVersion gates [JobRun], [JobCancel], [JobStatus], job log
// sources and job workloads (ADR 0010). Mirrors JOBS_PROTOCOL_VERSION.
const JobsProtocolVersion = 6

// MetricsProtocolVersion gates [Metrics] (ADR 0008); such an agent sends
// them only when [Welcome].MetricsIntervalMS is set. Mirrors
// METRICS_PROTOCOL_VERSION.
const MetricsProtocolVersion = 6

// CertsProtocolVersion gates [CertSync], [CertAck], [CertRequest],
// [CertStatus], [DesiredState].Certificates and Ingress, [TLSManaged],
// wildcard route hostnames and route HSTS (ADR 0009). Mirrors
// CERTS_PROTOCOL_VERSION.
const CertsProtocolVersion = 6

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
	TypeBuildCancel    = "build_cancel"

	TypeMeshStatus         = "mesh_status"
	TypeMeshKey            = "mesh_key"
	TypeVolumeStatus       = "volume_status"
	TypeBackupPartsRequest = "backup_parts_request"
	TypeBackupProgress     = "backup_progress"
	TypeBackupResult       = "backup_result"
	TypeRestoreResult      = "restore_result"
	TypeDBQueryResult      = "db_query_result"
	TypeJobStatus          = "job_status"
	TypeMetrics            = "metrics"
	TypeCertAck            = "cert_ack"
	TypeCertRequest        = "cert_request"
	TypeCertStatus         = "cert_status"

	TypeKeyAnnounce   = "key_announce"
	TypeVolumeDelete  = "volume_delete"
	TypeBackupJob     = "backup_job"
	TypeBackupParts   = "backup_parts"
	TypeRestoreJob    = "restore_job"
	TypeVolumeCopyOut = "volume_copy_out"
	TypeVolumeCopyIn  = "volume_copy_in"
	TypeDBQuery       = "db_query"
	TypeJobRun        = "job_run"
	TypeJobCancel     = "job_cancel"
	TypeCertSync      = "cert_sync"
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
	// Ingress nil means true: the node runs Caddy for every route.
	Ingress *bool `json:"ingress,omitempty"`
	// TCPProxy means the node enforces publish_allowed_cidrs with a firewall
	// rule installed before a port is published, so it runs workloads with
	// ports[].publish (ADR 0004, "TCP proxy").
	TCPProxy bool `json:"tcp_proxy,omitempty"`
	// DBSetPassword means the query runner accepts the set_password op.
	DBSetPassword bool `json:"db_set_password,omitempty"`
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

// AgentMessage is any frame an agent may send: [*Hello], [*Heartbeat],
// [*WorkloadStatus], [*Logs], [*BuildResult], and from protocol 5–6 the
// mesh, volume, backup, query, job, metrics and certificate reports.
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
	// EncryptionKey registers the agent's X25519 key for nodes that joined
	// without one. The control plane stores it only when the node has none.
	EncryptionKey *NodeEncryptionKey `json:"encryption_key,omitempty"`
	// Mesh reports the WireGuard public key and reachability when the
	// agent's mesh is enabled.
	Mesh *HelloMesh `json:"mesh,omitempty"`
	// VolumeQuota is how this node enforces volume quotas.
	VolumeQuota VolumeQuotaMode `json:"volume_quota,omitempty"`
	// PinnedKIDs are the control-plane signing kids the agent accepts,
	// current first.
	PinnedKIDs []string `json:"pinned_kids,omitempty"`
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

// Log source types. [LogSourceJob] needs [JobsProtocolVersion];
// [LogSourceTask] needs [BackupsProtocolVersion].
const (
	LogSourceRuntime = "runtime"
	LogSourceBuild   = "build"
	LogSourceJob     = "job"
	LogSourceTask    = "task"
)

// LogSource says what a [Logs] frame belongs to: a running replica
// (WorkloadID and DeploymentID set), a build (BuildID), a job run (RunID
// and WorkloadID) or a backup, restore or copy task (TaskID). It stays
// comparable, since the agent keys log batches by it.
type LogSource struct {
	Type         string `json:"type"`
	WorkloadID   string `json:"workload_id,omitempty"`
	DeploymentID string `json:"deployment_id,omitempty"`
	BuildID      string `json:"build_id,omitempty"`
	RunID        string `json:"run_id,omitempty"`
	TaskID       string `json:"task_id,omitempty"`
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
	Type    string      `json:"type"`
	BuildID string      `json:"build_id"`
	OK      bool        `json:"ok"`
	Image   *BuiltImage `json:"image,omitempty"`
	Error   string      `json:"error,omitempty"`
	// Cancelled marks a failed result for a build stopped by [BuildCancel]
	// or by the agent shutting down, rather than one that failed.
	Cancelled  bool  `json:"cancelled,omitempty"`
	DurationMS int64 `json:"duration_ms"`
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

// ControlMessage is any payload the control plane may sign and send:
// [*Welcome], [*DesiredState], [*BuildJob], [*BuildCancel], and from
// protocol 5–6 [*KeyAnnounce], the volume, backup, restore, copy and query
// frames, [*JobRun], [*JobCancel] and [*CertSync]. Use a type switch.
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
	// NextKeys are successor signing keys to pin, signed by the current key;
	// never the envelope's own kid.
	NextKeys []SigningKeyAnnouncement `json:"next_keys,omitempty"`
	// MetricsIntervalMS asks for [Metrics] at this interval; nil means none.
	MetricsIntervalMS *int64 `json:"metrics_interval_ms,omitempty"`
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
	// Workloads lists every service and route workload; system workloads
	// and jobs never appear.
	Workloads []WorkloadSpec `json:"workloads"`
	TLSMode   TLSMode        `json:"tls_mode"`
	// AppsDomain is the parent domain of generated hostnames, nil until an
	// operator sets one.
	AppsDomain *string `json:"apps_domain"`
	// Registry is set for builder nodes and, from [MeshProtocolVersion], for
	// meshed replica and proxy nodes.
	Registry *RegistryConfig `json:"registry"`
	// Volumes lists every volume the node holds; nil from older control
	// planes. Never delete a volume because it is missing here.
	Volumes []VolumeSpec `json:"volumes,omitempty"`
	// Mesh nil (absent or null) means mesh off: tear wg0 and its table down.
	Mesh *MeshConfig `json:"mesh,omitempty"`
	// Ingress holds node-level Caddy settings.
	Ingress *IngressSettings `json:"ingress,omitempty"`
	// Certificates lists the certificates the node must hold; bodies arrive
	// in [CertSync].
	Certificates []CertificateRef `json:"certificates,omitempty"`
}

func (*DesiredState) controlMessage() {}

// GitBuildSource is the repository and commit a build checks out.
type GitBuildSource struct {
	// Type is always "git".
	Type string `json:"type"`
	// URL is an https clone URL without credentials.
	URL       string `json:"url"`
	CommitSHA string `json:"commit_sha"`
	// Ref is display-only and must pass [IsSafeGitRef]; fetch by CommitSHA,
	// with --end-of-options before any ref argument.
	Ref string `json:"ref,omitempty"`
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
	BuildID      string `json:"build_id"`
	DeploymentID string `json:"deployment_id"`
	// ProjectID selects the project's isolated BuildKit instance.
	ProjectID string         `json:"project_id"`
	ServiceID string         `json:"service_id"`
	Source    GitBuildSource `json:"source"`
	Builder   Builder        `json:"builder"`
	// DockerfilePath is relative to ContextDir and defaults to "Dockerfile".
	// Only set with [BuilderDockerfile].
	DockerfilePath string `json:"dockerfile_path,omitempty"`
	// ContextDir is the build context inside the repository; "." for the root.
	ContextDir string `json:"context_dir"`
	// BuildArgs are --build-arg values, except those named in
	// SecretBuildArgs.
	BuildArgs map[string]string `json:"build_args"`
	// SecretBuildArgs names the BuildArgs whose values are secret: they are
	// passed as BuildKit secrets, never as build args, and redacted from
	// build output.
	SecretBuildArgs []string `json:"secret_build_args,omitempty"`
	// BuildSecretsSealed carries BuildKit secrets sealed to this node; open
	// it with [OpenBuildSecrets]. Nil when the build uses none.
	BuildSecretsSealed *SealedBox `json:"build_secrets_sealed,omitempty"`
	// ImageRepository is exactly [LocalImageRepository](ProjectID, ServiceID).
	ImageRepository string `json:"image_repository"`
	// CacheKey is exactly [BuildCacheKey](ProjectID, ServiceID).
	CacheKey string `json:"cache_key"`
	// TimeoutS is when the builder cancels and fails the build.
	TimeoutS int `json:"timeout_s"`
}

func (*BuildJob) controlMessage() {}

// IsSecretArg reports whether the build arg name is listed in SecretBuildArgs.
func (j *BuildJob) IsSecretArg(name string) bool {
	return slices.Contains(j.SecretBuildArgs, name)
}

// BuildCancel stops a running build; the builder answers its [BuildJob] with
// a failed [BuildResult] whose Cancelled is set. Type must be
// [TypeBuildCancel].
type BuildCancel struct {
	Type string `json:"type"`
	ControlHeader
	BuildID string `json:"build_id"`
}

func (*BuildCancel) controlMessage() {}
