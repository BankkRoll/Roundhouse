package protocol

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// WorkloadKind distinguishes deployment replicas from infrastructure the
// agent runs for itself.
type WorkloadKind string

// Workload kinds. The control plane sends [WorkloadService] and, from
// [MeshProtocolVersion], [WorkloadRouteOnly] in desired_state, and
// [WorkloadJob] only inside [JobRun] (from [JobsProtocolVersion]). The
// agent builds [WorkloadSystem] specs itself (registry, BuildKit) and
// reports their statuses with a nil deployment ID. A route workload has no
// container: its routes proxy to Upstreams over the mesh.
const (
	WorkloadService   WorkloadKind = "service"
	WorkloadSystem    WorkloadKind = "system"
	WorkloadRouteOnly WorkloadKind = "route"
	WorkloadJob       WorkloadKind = "job"
)

// PortProtocol says how a container port is exposed. Only HTTP ports can
// carry routes.
type PortProtocol string

// Port protocols.
const (
	PortHTTP PortProtocol = "http"
	PortTCP  PortProtocol = "tcp"
)

// HealthcheckType selects the probe the agent runs against a replica.
type HealthcheckType string

// Health probe types. [HealthcheckNone] (or a nil Healthcheck) reports a
// replica healthy as soon as it is running.
// [HealthcheckExec] (from [VolumesProtocolVersion]) runs Command inside the
// container and passes on exit code 0; it has no port.
const (
	HealthcheckHTTP HealthcheckType = "http"
	HealthcheckTCP  HealthcheckType = "tcp"
	HealthcheckNone HealthcheckType = "none"
	HealthcheckExec HealthcheckType = "exec"
)

// RestartPolicy is a container restart policy, as Docker understands it.
type RestartPolicy string

// Restart policies.
const (
	RestartAlways    RestartPolicy = "always"
	RestartOnFailure RestartPolicy = "on_failure"
	RestartNever     RestartPolicy = "never"
)

// TLSMode is the install-wide ingress TLS mode.
type TLSMode string

// TLS modes: on-demand public certificates gated by the agent's ask endpoint,
// Caddy's local CA, plain HTTP, or (from [CertsProtocolVersion])
// certificates the control plane issues and ships in [CertSync].
const (
	TLSACME     TLSMode = "acme"
	TLSInternal TLSMode = "internal"
	TLSOff      TLSMode = "off"
	TLSManaged  TLSMode = "managed"
)

// RolloutStrategy is the order in which the agent replaces a replica.
type RolloutStrategy string

// Rollout strategies. Empty means [RolloutStartFirst]. [RolloutStopFirst]
// stops the old container, and every holder of its volume, first.
const (
	RolloutStartFirst RolloutStrategy = "start_first"
	RolloutStopFirst  RolloutStrategy = "stop_first"
)

// RegistryMode is the registry's role on a node (ADR 0005).
type RegistryMode string

// Registry modes. Empty means [RegistryPrimary].
const (
	RegistryPrimary RegistryMode = "primary"
	RegistryReplica RegistryMode = "replica"
	RegistryProxy   RegistryMode = "proxy"
)

// PortPublish publishes a container port on the node (TCP proxy, ADR
// 0004). Sources outside [WorkloadSpec].PublishAllowedCIDRs are dropped.
type PortPublish struct {
	HostPort int `json:"host_port"`
	// HostIP is "0.0.0.0" (IPv4 only) or "::" (dual stack: bound on both
	// 0.0.0.0 and ::, with the allowlist in iptables and ip6tables).
	HostIP string `json:"host_ip"`
}

// RouteHSTS is the Strict-Transport-Security header of a route, sent on the
// HTTPS server only.
type RouteHSTS struct {
	MaxAge            int  `json:"max_age"`
	IncludeSubdomains bool `json:"include_subdomains"`
	Preload           bool `json:"preload"`
}

// WorkloadMount binds a volume listed in [DesiredState].Volumes into the
// container at Path.
type WorkloadMount struct {
	VolumeID string `json:"volume_id"`
	// Path passes [IsSafeMountPath].
	Path     string `json:"path"`
	ReadOnly bool   `json:"read_only"`
}

// Upstream is a remote replica a route workload proxies to: its mesh IP and
// container port.
type Upstream struct {
	IP   string `json:"ip"`
	Port int    `json:"port"`
}

// RegistryListen is the fixed address of the builder node's registry.
const RegistryListen = "127.0.0.1:5000"

// RegistryAuth holds credentials for pulling a private image.
type RegistryAuth struct {
	// Server is the registry host, optionally with a port.
	Server   string `json:"server"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// WorkloadPort is a container port the replica listens on.
type WorkloadPort struct {
	ContainerPort int          `json:"container_port"`
	Protocol      PortProtocol `json:"protocol"`
	// Publish is hashed: publishing recreates the container once.
	Publish *PortPublish `json:"publish,omitempty"`
}

// WorkloadRoute is a Caddy route to a replica's HTTP port.
type WorkloadRoute struct {
	// Hostname passes [IsRouteHostname]; a "*." label only from
	// [CertsProtocolVersion].
	Hostname      string `json:"hostname"`
	ContainerPort int    `json:"container_port"`
	// PathPrefix defaults to "/" when empty.
	PathPrefix string `json:"path_prefix,omitempty"`
	// HSTS nil sends no header.
	HSTS *RouteHSTS `json:"hsts,omitempty"`
}

// Healthcheck is the probe the agent runs before a replica counts as healthy.
type Healthcheck struct {
	Type HealthcheckType `json:"type"`
	// Path is the request path, set exactly for HTTP probes.
	Path string `json:"path,omitempty"`
	// Port is set for every type except [HealthcheckExec].
	Port int `json:"port,omitempty"`
	// Command is the argument vector of an exec probe, set exactly for it.
	Command   []string `json:"command,omitempty"`
	IntervalS int      `json:"interval_s"`
	TimeoutS  int      `json:"timeout_s"`
	// Retries is the number of consecutive failures before the replica is
	// unhealthy.
	Retries int `json:"retries"`
	// StartPeriodS is a grace period after start during which failures don't
	// count.
	StartPeriodS int `json:"start_period_s"`
}

// Resources are hard limits applied to the container.
type Resources struct {
	// CPUMillis is thousandths of a core.
	CPUMillis int `json:"cpu_millis"`
	MemoryMB  int `json:"memory_mb"`
	PIDs      int `json:"pids"`
}

// Restart is what Docker does when the container exits.
type Restart struct {
	Policy RestartPolicy `json:"policy"`
	// MaxRetries applies to [RestartOnFailure] only.
	MaxRetries int `json:"max_retries"`
}

// WorkloadSpec is one container a node should run: a replica of a deployment
// or a system workload. The agent recreates the container when SpecHash
// changes; see [ComputeSpecHash] for what it covers.
type WorkloadSpec struct {
	ID   string       `json:"id"`
	Kind WorkloadKind `json:"kind"`
	// ProjectID, EnvironmentID, ServiceID and DeploymentID are nil exactly
	// for system workloads.
	ProjectID     *string `json:"project_id"`
	EnvironmentID *string `json:"environment_id"`
	ServiceID     *string `json:"service_id"`
	DeploymentID  *string `json:"deployment_id"`
	Replica       int     `json:"replica"`
	// Image is a digest reference for git-built services, or a tag for image
	// sources and system workloads.
	Image        string        `json:"image"`
	RegistryAuth *RegistryAuth `json:"registry_auth,omitempty"`
	// Command overrides the image's CMD when non-empty.
	Command []string `json:"command,omitempty"`
	// Entrypoint overrides the image's ENTRYPOINT when non-empty.
	Entrypoint []string `json:"entrypoint,omitempty"`
	// EnvSealed is the environment and secret files sealed to this node; open
	// it with [OpenWorkloadEnv]. Nil exactly for system workloads. Excluded
	// from the spec hash: a workload ID's environment never changes.
	EnvSealed *SealedBox `json:"env_sealed"`
	// Env is the opened environment. Never on the wire: [OpenWorkloadEnv]
	// fills it for service workloads; the agent sets it for system ones.
	Env map[string]string `json:"-"`
	// SecretFiles are values to mount at /run/secrets/<KEY> instead of the
	// environment. Never on the wire; filled by [OpenWorkloadEnv].
	SecretFiles map[string]string `json:"-"`
	Ports       []WorkloadPort    `json:"ports"`
	Routes      []WorkloadRoute   `json:"routes"`
	// Healthcheck nil behaves like a [HealthcheckNone] probe.
	Healthcheck *Healthcheck      `json:"healthcheck"`
	Resources   Resources         `json:"resources"`
	Restart     Restart           `json:"restart"`
	Network     string            `json:"network"`
	Labels      map[string]string `json:"labels"`
	// DrainS is how long the old replica keeps serving after its route moves.
	DrainS   int    `json:"drain_s"`
	SpecHash string `json:"spec_hash"`

	// Phase 2 (protocol 5): volumes, rollout, TCP proxy, mesh.

	// Mounts are volumes bound into a service container. Hashed.
	Mounts []WorkloadMount `json:"mounts,omitempty"`
	// Rollout empty means [RolloutStartFirst]. Not hashed.
	Rollout RolloutStrategy `json:"rollout,omitempty"`
	// StopGraceS is the SIGTERM → SIGKILL grace; nil means 10. Not hashed.
	StopGraceS *int `json:"stop_grace_s,omitempty"`
	// PublishAllowedCIDRs are the sources admitted to published ports, set
	// exactly when a port is published. Not hashed.
	PublishAllowedCIDRs []string `json:"publish_allowed_cidrs,omitempty"`
	// MeshIP is the replica's mesh IP, NATed 1:1 to its bridge IP. Not hashed.
	MeshIP string `json:"mesh_ip,omitempty"`
	// PrivateDNS makes the container resolve through the node's private DNS.
	// A pointer so an explicit false hashes as TypeScript hashes it.
	PrivateDNS *bool `json:"private_dns,omitempty"`
	// Upstreams are the remote replicas of a [WorkloadRouteOnly]. Not hashed.
	Upstreams []Upstream `json:"upstreams,omitempty"`
}

// StopGrace returns the stop grace in seconds, defaulting to 10.
func (w *WorkloadSpec) StopGrace() int {
	if w.StopGraceS == nil {
		return 10
	}
	return *w.StopGraceS
}

// VolumeSpec is a volume the node holds ([DesiredState].Volumes). A volume
// missing from the list is never deleted; only [VolumeDelete] removes data.
type VolumeSpec struct {
	ID string `json:"id"`
	// SizeMB is the quota, grow-only.
	SizeMB        int    `json:"size_mb"`
	ProjectID     string `json:"project_id"`
	EnvironmentID string `json:"environment_id"`
	ServiceID     string `json:"service_id"`
	// Owner is "uid:gid" for a fresh data directory; nil uses the image's user.
	Owner *string `json:"owner"`
}

func (v *VolumeSpec) validate() error {
	if !idRE.MatchString(v.ID) || !idRE.MatchString(v.ProjectID) || !idRE.MatchString(v.EnvironmentID) ||
		!idRE.MatchString(v.ServiceID) {
		return errors.New("ids must be ids")
	}
	if v.SizeMB < MinVolumeSizeMB || v.SizeMB > MaxVolumeSizeMB {
		return errors.New("size_mb: out of range")
	}
	if v.Owner != nil && !uidGidRE.MatchString(*v.Owner) {
		return errors.New("owner: expected uid:gid")
	}
	return nil
}

// Workload is the Phase 0 name of [WorkloadSpec].
//
// Deprecated: Use [WorkloadSpec].
type Workload = WorkloadSpec

// RegistryStorage is where the builder's registry keeps blobs. Type is
// "filesystem" or "s3"; the remaining fields are set only for "s3".
type RegistryStorage struct {
	Type            string `json:"type"`
	Endpoint        string `json:"endpoint,omitempty"`
	Bucket          string `json:"bucket,omitempty"`
	Region          string `json:"region,omitempty"`
	AccessKeyID     string `json:"access_key_id,omitempty"`
	SecretAccessKey string `json:"secret_access_key,omitempty"`
}

// Registry storage types.
const (
	StorageFilesystem = "filesystem"
	StorageS3         = "s3"
)

// RegistryPullUser is a node allowed to pull from a primary over the mesh.
type RegistryPullUser struct {
	Username string `json:"username"`
	// Bcrypt is the htpasswd hash; the password goes to that node only.
	Bcrypt string `json:"bcrypt"`
}

// RegistryUpstream is the primary a [RegistryProxy] pulls through.
type RegistryUpstream struct {
	// URL is e.g. "http://10.200.3.1:5000"; plain HTTP inside WireGuard.
	URL      string `json:"url"`
	Username string `json:"username"`
	// PasswordSealed opens with [OpenRegistryUpstream].
	PasswordSealed SealedBox `json:"password_sealed"`
}

// RegistryConfig configures the registry system workload: builders run a
// primary; from [MeshProtocolVersion] other meshed nodes run a replica (S3
// storage) or a proxy (filesystem cache of a primary's MeshListen).
type RegistryConfig struct {
	// Listen is always [RegistryListen].
	Listen  string          `json:"listen"`
	Storage RegistryStorage `json:"storage"`
	// Mode empty means [RegistryPrimary].
	Mode RegistryMode `json:"mode,omitempty"`
	// MeshListen is "<mesh .1>:5000" on a filesystem primary.
	MeshListen string `json:"mesh_listen,omitempty"`
	// Upstream is set exactly for proxies.
	Upstream *RegistryUpstream `json:"upstream,omitempty"`
	// PullUsers go with MeshListen.
	PullUsers []RegistryPullUser `json:"pull_users,omitempty"`
}

// LocalImageRepository returns the local-registry repository for a service's
// images, lowercasing the IDs as repository paths require. Mirrors
// localImageRepository in TypeScript.
func LocalImageRepository(projectID, serviceID string) string {
	return RegistryListen + "/" + strings.ToLower(projectID) + "/" + strings.ToLower(serviceID)
}

// ProjectNetworkName returns Phase 1's per-project network name. Workloads no
// longer use it, since one network per project let every environment reach
// every other one ([EnvironmentNetworkName] replaced it); agents use it to
// recognise, and remove, the networks Phase 1 left behind.
func ProjectNetworkName(projectID string) string { return "roundhouse-" + projectID }

// MaxNetworkNameLength is the longest network name the protocol accepts.
const MaxNetworkNameLength = 128

// HashedNetworkPrefix starts the hashed form of [EnvironmentNetworkName].
const HashedNetworkPrefix = "roundhouse-env-"

// EnvironmentNetworkName returns the Docker network one environment of a
// project joins: "roundhouse-<project_id>-<environment_id>" when that fits
// [MaxNetworkNameLength], else "roundhouse-env-" and the hex SHA-256 of
// "<project_id>/<environment_id>". Environments never share a network, so a
// container in one cannot reach another environment by IP or by name.
// Mirrors environmentNetworkName in TypeScript.
func EnvironmentNetworkName(projectID, environmentID string) string {
	readable := "roundhouse-" + projectID + "-" + environmentID
	if len(readable) <= MaxNetworkNameLength {
		return readable
	}
	sum := sha256.Sum256([]byte(projectID + "/" + environmentID))
	return HashedNetworkPrefix + hex.EncodeToString(sum[:])
}

// ReservedNetworks are networks a service workload may never join: Docker's
// built-ins and the agent's own.
var ReservedNetworks = []string{"host", "bridge", "none", "roundhouse-system", "roundhouse-build"}

// ServiceNetworkAllowed reports whether a service workload of projectID and
// environmentID may join network (ADR 0014, H1): only its own environment
// network or, while Phase 1 replicas migrate, its own project's legacy
// [ProjectNetworkName]. Never a [ReservedNetworks] entry or another
// project's network. Mirrors isServiceNetworkAllowed in TypeScript.
func ServiceNetworkAllowed(network, projectID, environmentID string) bool {
	for _, r := range ReservedNetworks {
		if network == r {
			return false
		}
	}
	return network == ProjectNetworkName(projectID) || network == EnvironmentNetworkName(projectID, environmentID)
}

// PrivateServiceAlias returns the DNS alias every replica of a service
// answers to on its environment network, derived from the service ID so it
// can't collide with another service. Mirrors privateServiceAlias in
// TypeScript.
func PrivateServiceAlias(serviceID string) string {
	return strings.ReplaceAll(strings.ToLower(serviceID), "_", "-") + ".roundhouse.internal"
}

// BuildCacheKey returns the BuildKit cache scope of a service's builds.
// Mirrors buildCacheKey in TypeScript.
func BuildCacheKey(projectID, serviceID string) string { return projectID + "." + serviceID }

// BuildIsolationPreview marks a pull request build (ADR 0014 section 14):
// built in the project's preview BuildKit daemon with its own cache.
// Mirrors BUILD_ISOLATIONS in TypeScript.
const BuildIsolationPreview = "preview"

// BuildCacheKeyFor returns the cache scope of a build with an isolation
// class: [BuildCacheKey] for "", and a separate scope for
// [BuildIsolationPreview]. Mirrors buildCacheKey(project, service, isolation).
func BuildCacheKeyFor(projectID, serviceID, isolation string) string {
	if isolation == "" {
		return BuildCacheKey(projectID, serviceID)
	}
	return BuildCacheKey(projectID, serviceID) + "." + isolation
}

// Validate checks w against the constraints of the zod WorkloadSpecSchema.
func (w *WorkloadSpec) Validate() error {
	if !idRE.MatchString(w.ID) {
		return fmt.Errorf("id: invalid %q", w.ID)
	}
	owned := []*string{w.ProjectID, w.EnvironmentID, w.ServiceID, w.DeploymentID}
	switch w.Kind {
	case WorkloadService, WorkloadRouteOnly, WorkloadJob:
		for _, id := range owned {
			if id == nil || !idRE.MatchString(*id) {
				return fmt.Errorf("%s workloads need every ownership id", w.Kind)
			}
		}
		if (w.Kind == WorkloadRouteOnly) != (w.EnvSealed == nil) {
			return errors.New("env_sealed: required for service and job workloads and forbidden otherwise")
		}
		if w.EnvSealed != nil {
			if err := w.EnvSealed.validate(); err != nil {
				return fmt.Errorf("env_sealed: %w", err)
			}
		}
		if !ServiceNetworkAllowed(w.Network, *w.ProjectID, *w.EnvironmentID) {
			return fmt.Errorf("network: %s workloads must join %s", w.Kind, EnvironmentNetworkName(*w.ProjectID, *w.EnvironmentID))
		}
		if strings.HasPrefix(w.Image, RegistryListen+"/") {
			repo := LocalImageRepository(*w.ProjectID, *w.ServiceID)
			digest, ok := strings.CutPrefix(w.Image, repo+"@sha256:")
			if !ok || !specHashRE.MatchString(digest) {
				return fmt.Errorf("image: local registry images must be %s@sha256:…", repo)
			}
		}
	case WorkloadSystem:
		for _, id := range owned {
			if id != nil {
				return errors.New("system workloads have no ownership ids")
			}
		}
		if w.EnvSealed != nil {
			return errors.New("env_sealed: required for service and job workloads and forbidden otherwise")
		}
	default:
		return fmt.Errorf("kind: invalid %q", w.Kind)
	}
	if err := w.validatePhase2(); err != nil {
		return err
	}
	if w.Replica < 0 || w.Replica > 999 {
		return errors.New("replica: out of range")
	}
	if len(w.Image) > maxImageReference || !imageReferenceRE.MatchString(w.Image) {
		return fmt.Errorf("image: invalid reference %q", w.Image)
	}
	if a := w.RegistryAuth; a != nil {
		if len(a.Server) > maxRegistryAuthServer || !registryServerRE.MatchString(a.Server) ||
			a.Username == "" || len(a.Username) > 256 || a.Password == "" || len(a.Password) > 4096 {
			return errors.New("registry_auth: invalid")
		}
	}
	for name, args := range map[string][]string{"command": w.Command, "entrypoint": w.Entrypoint} {
		if args == nil {
			continue
		}
		if len(args) == 0 || len(args) > MaxArgs {
			return fmt.Errorf("%s: must have 1 to %d arguments", name, MaxArgs)
		}
		for _, a := range args {
			if len(a) > MaxArgBytes || strings.ContainsRune(a, 0) {
				return fmt.Errorf("%s: invalid argument", name)
			}
		}
	}
	if err := validateEnv(w.Env); err != nil {
		return err
	}
	if err := validatePortsAndRoutes(w.Ports, w.Routes); err != nil {
		return err
	}
	if h := w.Healthcheck; h != nil {
		if err := h.validate(); err != nil {
			return fmt.Errorf("healthcheck: %w", err)
		}
	}
	r := w.Resources
	if r.CPUMillis < 10 || r.CPUMillis > 512_000 || r.MemoryMB < 16 || r.MemoryMB > 2_097_152 ||
		r.PIDs < 16 || r.PIDs > 65_536 {
		return errors.New("resources: out of range")
	}
	switch w.Restart.Policy {
	case RestartAlways, RestartOnFailure, RestartNever:
	default:
		return fmt.Errorf("restart.policy: invalid %q", w.Restart.Policy)
	}
	if w.Restart.MaxRetries < 0 || w.Restart.MaxRetries > 1000 {
		return errors.New("restart.max_retries: out of range")
	}
	if !networkRE.MatchString(w.Network) {
		return fmt.Errorf("network: invalid %q", w.Network)
	}
	if len(w.Labels) > MaxLabels {
		return fmt.Errorf("labels: at most %d", MaxLabels)
	}
	for k, v := range w.Labels {
		if len(k) > MaxLabelKeyBytes || !labelKeyRE.MatchString(k) || len(v) > MaxLabelValueBytes {
			return fmt.Errorf("labels: invalid label %q", k)
		}
	}
	if w.DrainS < 0 || w.DrainS > 3600 {
		return errors.New("drain_s: out of range")
	}
	if !specHashRE.MatchString(w.SpecHash) {
		return errors.New("spec_hash: expected lowercase hex sha256")
	}
	return nil
}

// validatePhase2 checks the per-kind rules of the protocol 5–6 fields,
// mirroring the superRefine of the zod WorkloadSpecSchema.
func (w *WorkloadSpec) validatePhase2() error {
	if w.Mounts != nil {
		if w.Kind != WorkloadService {
			return errors.New("mounts: only service workloads mount volumes")
		}
		if len(w.Mounts) == 0 || len(w.Mounts) > MaxMountsPerWorkload {
			return fmt.Errorf("mounts: must have 1 to %d", MaxMountsPerWorkload)
		}
		ids, paths := map[string]bool{}, map[string]bool{}
		for _, m := range w.Mounts {
			if !idRE.MatchString(m.VolumeID) || !IsSafeMountPath(m.Path) {
				return fmt.Errorf("mounts: invalid mount %q at %q", m.VolumeID, m.Path)
			}
			if ids[m.VolumeID] || paths[m.Path] {
				return errors.New("mounts must name distinct volumes and paths")
			}
			ids[m.VolumeID], paths[m.Path] = true, true
		}
	}
	switch w.Rollout {
	case "", RolloutStartFirst, RolloutStopFirst:
	default:
		return fmt.Errorf("rollout: invalid %q", w.Rollout)
	}
	if w.StopGraceS != nil && (*w.StopGraceS < 0 || *w.StopGraceS > 600) {
		return errors.New("stop_grace_s: out of range")
	}
	published := map[int]bool{}
	for _, p := range w.Ports {
		if p.Publish == nil {
			continue
		}
		if p.Publish.HostPort < 1024 || p.Publish.HostPort > 65535 ||
			(p.Publish.HostIP != "0.0.0.0" && p.Publish.HostIP != "::") {
			return fmt.Errorf("ports: invalid publish of %d", p.ContainerPort)
		}
		if published[p.Publish.HostPort] {
			return errors.New("ports: duplicate published host port")
		}
		published[p.Publish.HostPort] = true
	}
	if len(published) > 0 && w.Kind != WorkloadService {
		return errors.New("ports: only service workloads publish ports")
	}
	if (len(published) > 0) != (w.PublishAllowedCIDRs != nil) {
		return errors.New("publish_allowed_cidrs: required exactly when a port is published")
	}
	if w.PublishAllowedCIDRs != nil {
		if len(w.PublishAllowedCIDRs) == 0 || len(w.PublishAllowedCIDRs) > MaxPublishCIDRs {
			return fmt.Errorf("publish_allowed_cidrs: must have 1 to %d", MaxPublishCIDRs)
		}
		for _, c := range w.PublishAllowedCIDRs {
			if !IsCIDR(c) {
				return fmt.Errorf("publish_allowed_cidrs: invalid %q", c)
			}
		}
	}
	if w.MeshIP != "" && !IsIPv4(w.MeshIP) {
		return fmt.Errorf("mesh_ip: invalid %q", w.MeshIP)
	}
	if w.Upstreams != nil {
		if w.Kind != WorkloadRouteOnly {
			return errors.New("upstreams: only route workloads have upstreams")
		}
		if len(w.Upstreams) == 0 || len(w.Upstreams) > MaxUpstreams {
			return fmt.Errorf("upstreams: must have 1 to %d", MaxUpstreams)
		}
		for _, u := range w.Upstreams {
			if !IsIPv4(u.IP) || !validPort(u.Port) {
				return fmt.Errorf("upstreams: invalid %s:%d", u.IP, u.Port)
			}
		}
	}
	switch w.Kind {
	case WorkloadRouteOnly:
		if w.Upstreams == nil || len(w.Routes) == 0 {
			return errors.New("route workloads need upstreams and routes")
		}
		if w.Healthcheck != nil || w.MeshIP != "" {
			return errors.New("route workloads have no healthcheck or mesh ip")
		}
	case WorkloadJob:
		if len(w.Routes) > 0 || len(w.Ports) > 0 {
			return errors.New("job workloads have no ports or routes")
		}
		if w.Healthcheck != nil {
			return errors.New("job workloads have no healthcheck")
		}
		if w.Restart.Policy != RestartNever || w.Restart.MaxRetries != 0 {
			return errors.New("job workloads never restart")
		}
	}
	return nil
}

func validateEnv(env map[string]string) error {
	if len(env) > MaxEnvVars {
		return fmt.Errorf("env: at most %d variables", MaxEnvVars)
	}
	total := 0
	for k, v := range env {
		if len(k) > MaxEnvKeyBytes || !envKeyRE.MatchString(k) {
			return fmt.Errorf("env: invalid name %q", k)
		}
		if len(v) > MaxEnvValueBytes || strings.ContainsRune(v, 0) {
			return fmt.Errorf("env: invalid value for %q", k)
		}
		total += len(k) + len(v)
	}
	if total > MaxEnvTotalBytes {
		return fmt.Errorf("env: at most %d bytes", MaxEnvTotalBytes)
	}
	return nil
}

func validatePortsAndRoutes(ports []WorkloadPort, routes []WorkloadRoute) error {
	if len(ports) > MaxPorts {
		return fmt.Errorf("ports: at most %d", MaxPorts)
	}
	seen := map[int]bool{}
	http := map[int]bool{}
	for _, p := range ports {
		if !validPort(p.ContainerPort) {
			return fmt.Errorf("ports: invalid port %d", p.ContainerPort)
		}
		if p.Protocol != PortHTTP && p.Protocol != PortTCP {
			return fmt.Errorf("ports: invalid protocol %q", p.Protocol)
		}
		if seen[p.ContainerPort] {
			return fmt.Errorf("ports: duplicate port %d", p.ContainerPort)
		}
		seen[p.ContainerPort] = true
		http[p.ContainerPort] = p.Protocol == PortHTTP
	}
	if len(routes) > MaxRoutes {
		return fmt.Errorf("routes: at most %d", MaxRoutes)
	}
	keys := map[string]bool{}
	for _, r := range routes {
		if !IsRouteHostname(r.Hostname) {
			return fmt.Errorf("routes: invalid hostname %q", r.Hostname)
		}
		if h := r.HSTS; h != nil {
			if h.MaxAge < 0 || h.MaxAge > MaxHSTSMaxAgeS {
				return errors.New("routes: hsts.max_age out of range")
			}
			if h.Preload && (!h.IncludeSubdomains || h.MaxAge < 31_536_000) {
				return errors.New("routes: preload needs include_subdomains and max_age >= 31536000")
			}
		}
		if !http[r.ContainerPort] {
			return fmt.Errorf("routes: port %d is not an http port", r.ContainerPort)
		}
		prefix := r.PathPrefix
		if prefix != "" && (len(prefix) > 256 || !pathPrefixRE.MatchString(prefix)) {
			return fmt.Errorf("routes: invalid path_prefix %q", prefix)
		}
		if prefix == "" {
			prefix = "/"
		}
		if keys[r.Hostname+prefix] {
			return fmt.Errorf("routes: duplicate route %s%s", r.Hostname, prefix)
		}
		keys[r.Hostname+prefix] = true
	}
	return nil
}

func (h *Healthcheck) validate() error {
	switch h.Type {
	case HealthcheckHTTP, HealthcheckTCP, HealthcheckNone, HealthcheckExec:
	default:
		return fmt.Errorf("invalid type %q", h.Type)
	}
	if (h.Type == HealthcheckHTTP) != (h.Path != "") {
		return errors.New("path is required for http probes and only allowed for them")
	}
	if h.Path != "" && (len(h.Path) > 1024 || !pathPrefixRE.MatchString(h.Path)) {
		return fmt.Errorf("invalid path %q", h.Path)
	}
	exec := h.Type == HealthcheckExec
	if exec != (h.Command != nil) {
		return errors.New("command is required for exec probes and only allowed for them")
	}
	if exec {
		if len(h.Command) == 0 || len(h.Command) > MaxArgs {
			return fmt.Errorf("command: must have 1 to %d arguments", MaxArgs)
		}
		for _, a := range h.Command {
			if len(a) > MaxArgBytes || strings.ContainsRune(a, 0) {
				return errors.New("command: invalid argument")
			}
		}
	}
	if exec == (h.Port != 0) {
		return errors.New("port is required for every probe except exec, which has none")
	}
	if (!exec && !validPort(h.Port)) || h.IntervalS < 1 || h.IntervalS > 3600 || h.TimeoutS < 1 ||
		h.TimeoutS > 300 || h.Retries < 0 || h.Retries > 100 || h.StartPeriodS < 0 || h.StartPeriodS > 3600 {
		return errors.New("out of range")
	}
	return nil
}

func (c *RegistryConfig) validate() error {
	if c.Listen != RegistryListen {
		return fmt.Errorf("registry.listen: must be %s", RegistryListen)
	}
	s := c.Storage
	switch s.Type {
	case StorageFilesystem:
	case StorageS3:
		if len(s.Endpoint) > 2048 || !s3EndpointRE.MatchString(s.Endpoint) || !bucketRE.MatchString(s.Bucket) ||
			!regionRE.MatchString(s.Region) || s.AccessKeyID == "" || len(s.AccessKeyID) > 256 ||
			s.SecretAccessKey == "" || len(s.SecretAccessKey) > 256 {
			return errors.New("registry.storage: invalid s3 settings")
		}
	default:
		return fmt.Errorf("registry.storage.type: invalid %q", s.Type)
	}
	mode := c.Mode
	switch mode {
	case "":
		mode = RegistryPrimary
	case RegistryPrimary, RegistryReplica, RegistryProxy:
	default:
		return fmt.Errorf("registry.mode: invalid %q", c.Mode)
	}
	if mode == RegistryReplica && s.Type != StorageS3 {
		return errors.New("registry: replicas need s3 storage")
	}
	if mode == RegistryProxy && s.Type != StorageFilesystem {
		return errors.New("registry: proxies cache on the filesystem")
	}
	if (mode == RegistryProxy) != (c.Upstream != nil) {
		return errors.New("registry.upstream: required for proxies and only allowed for them")
	}
	if u := c.Upstream; u != nil {
		if len(u.URL) > 2048 || !registryURLRE.MatchString(u.URL) || !registryUserRE.MatchString(u.Username) {
			return errors.New("registry.upstream: invalid")
		}
		if err := u.PasswordSealed.validate(); err != nil {
			return fmt.Errorf("registry.upstream.password_sealed: %w", err)
		}
	}
	if c.MeshListen != "" {
		if mode != RegistryPrimary || s.Type != StorageFilesystem {
			return errors.New("registry.mesh_listen: only for filesystem primaries")
		}
		if !meshListenRE.MatchString(c.MeshListen) || !IsIPv4(strings.TrimSuffix(c.MeshListen, ":5000")) {
			return fmt.Errorf("registry.mesh_listen: invalid %q", c.MeshListen)
		}
	}
	if c.PullUsers != nil {
		if c.MeshListen == "" {
			return errors.New("registry.pull_users: need mesh_listen")
		}
		if len(c.PullUsers) == 0 || len(c.PullUsers) > MaxRegistryPullUsers {
			return fmt.Errorf("registry.pull_users: must have 1 to %d", MaxRegistryPullUsers)
		}
		seen := map[string]bool{}
		for _, u := range c.PullUsers {
			if !registryUserRE.MatchString(u.Username) || !bcryptRE.MatchString(u.Bcrypt) || seen[u.Username] {
				return fmt.Errorf("registry.pull_users: invalid or duplicate %q", u.Username)
			}
			seen[u.Username] = true
		}
	}
	return nil
}

func validPort(p int) bool { return p >= 1 && p <= 65535 }
