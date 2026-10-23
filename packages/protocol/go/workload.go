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

// Workload kinds. The control plane only sends [WorkloadService]; the agent
// builds [WorkloadSystem] specs itself (registry, BuildKit) and reports
// their statuses with a nil deployment ID.
const (
	WorkloadService WorkloadKind = "service"
	WorkloadSystem  WorkloadKind = "system"
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
const (
	HealthcheckHTTP HealthcheckType = "http"
	HealthcheckTCP  HealthcheckType = "tcp"
	HealthcheckNone HealthcheckType = "none"
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
// Caddy's local CA, or plain HTTP.
const (
	TLSACME     TLSMode = "acme"
	TLSInternal TLSMode = "internal"
	TLSOff      TLSMode = "off"
)

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
}

// WorkloadRoute is a Caddy route to a replica's HTTP port.
type WorkloadRoute struct {
	Hostname      string `json:"hostname"`
	ContainerPort int    `json:"container_port"`
	// PathPrefix defaults to "/" when empty.
	PathPrefix string `json:"path_prefix,omitempty"`
}

// Healthcheck is the probe the agent runs before a replica counts as healthy.
type Healthcheck struct {
	Type HealthcheckType `json:"type"`
	// Path is the request path, set exactly for HTTP probes.
	Path      string `json:"path,omitempty"`
	Port      int    `json:"port"`
	IntervalS int    `json:"interval_s"`
	TimeoutS  int    `json:"timeout_s"`
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

// RegistryConfig configures the registry system workload on a builder node.
type RegistryConfig struct {
	// Listen is always [RegistryListen].
	Listen  string          `json:"listen"`
	Storage RegistryStorage `json:"storage"`
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
func ProjectNetworkName(projectID string) string { return "openrail-" + projectID }

// MaxNetworkNameLength is the longest network name the protocol accepts.
const MaxNetworkNameLength = 128

// HashedNetworkPrefix starts the hashed form of [EnvironmentNetworkName].
const HashedNetworkPrefix = "openrail-env-"

// EnvironmentNetworkName returns the Docker network one environment of a
// project joins: "openrail-<project_id>-<environment_id>" when that fits
// [MaxNetworkNameLength], else "openrail-env-" and the hex SHA-256 of
// "<project_id>/<environment_id>". Environments never share a network, so a
// container in one cannot reach another environment by IP or by name.
// Mirrors environmentNetworkName in TypeScript.
func EnvironmentNetworkName(projectID, environmentID string) string {
	readable := "openrail-" + projectID + "-" + environmentID
	if len(readable) <= MaxNetworkNameLength {
		return readable
	}
	sum := sha256.Sum256([]byte(projectID + "/" + environmentID))
	return HashedNetworkPrefix + hex.EncodeToString(sum[:])
}

// ReservedNetworks are networks a service workload may never join: Docker's
// built-ins and the agent's own.
var ReservedNetworks = []string{"host", "bridge", "none", "openrail-system", "openrail-build"}

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
	return strings.ReplaceAll(strings.ToLower(serviceID), "_", "-") + ".openrail.internal"
}

// BuildCacheKey returns the BuildKit cache scope of a service's builds.
// Mirrors buildCacheKey in TypeScript.
func BuildCacheKey(projectID, serviceID string) string { return projectID + "." + serviceID }

// Validate checks w against the constraints of the zod WorkloadSpecSchema.
func (w *WorkloadSpec) Validate() error {
	if !idRE.MatchString(w.ID) {
		return fmt.Errorf("id: invalid %q", w.ID)
	}
	owned := []*string{w.ProjectID, w.EnvironmentID, w.ServiceID, w.DeploymentID}
	switch w.Kind {
	case WorkloadService:
		for _, id := range owned {
			if id == nil || !idRE.MatchString(*id) {
				return errors.New("service workloads need every ownership id")
			}
		}
		if w.EnvSealed == nil {
			return errors.New("env_sealed: required for service workloads")
		}
		if err := w.EnvSealed.validate(); err != nil {
			return fmt.Errorf("env_sealed: %w", err)
		}
		if !ServiceNetworkAllowed(w.Network, *w.ProjectID, *w.EnvironmentID) {
			return fmt.Errorf("network: service workloads must join %s", EnvironmentNetworkName(*w.ProjectID, *w.EnvironmentID))
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
			return errors.New("env_sealed: forbidden for system workloads")
		}
	default:
		return fmt.Errorf("kind: invalid %q", w.Kind)
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
		if !IsHostname(r.Hostname) {
			return fmt.Errorf("routes: invalid hostname %q", r.Hostname)
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
	case HealthcheckHTTP, HealthcheckTCP, HealthcheckNone:
	default:
		return fmt.Errorf("invalid type %q", h.Type)
	}
	if (h.Type == HealthcheckHTTP) != (h.Path != "") {
		return errors.New("path is required for http probes and only allowed for them")
	}
	if h.Path != "" && (len(h.Path) > 1024 || !pathPrefixRE.MatchString(h.Path)) {
		return fmt.Errorf("invalid path %q", h.Path)
	}
	if !validPort(h.Port) || h.IntervalS < 1 || h.IntervalS > 3600 || h.TimeoutS < 1 ||
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
		return nil
	case StorageS3:
		if len(s.Endpoint) > 2048 || !s3EndpointRE.MatchString(s.Endpoint) || !bucketRE.MatchString(s.Bucket) ||
			!regionRE.MatchString(s.Region) || s.AccessKeyID == "" || len(s.AccessKeyID) > 256 ||
			s.SecretAccessKey == "" || len(s.SecretAccessKey) > 256 {
			return errors.New("registry.storage: invalid s3 settings")
		}
		return nil
	default:
		return fmt.Errorf("registry.storage.type: invalid %q", s.Type)
	}
}

func validPort(p int) bool { return p >= 1 && p <= 65535 }
