package protocol

import (
	"errors"
	"fmt"
	"strings"
)

// Validator is implemented by every message type. Validate checks the value
// constraints of the matching zod schema (ranges, formats, sizes and
// cross-field rules); the decoders call it after decoding.
type Validator interface {
	Validate() error
}

// CarriesCredentials reports whether msg carries a git token, a registry
// password, object-storage keys or a sealed box. Such frames must expire within
// [CredentialFrameTTLMS] of issue. Mirrors carriesCredentials in TypeScript.
func CarriesCredentials(msg ControlMessage) bool {
	switch m := msg.(type) {
	case *DesiredState:
		if m.Registry != nil && m.Registry.Storage.Type == StorageS3 {
			return true
		}
		for i := range m.Workloads {
			if m.Workloads[i].RegistryAuth != nil || m.Workloads[i].EnvSealed != nil {
				return true
			}
		}
	case *BuildJob:
		return m.Source.Token != "" || m.BuildSecretsSealed != nil
	}
	return false
}

func (h ControlHeader) validate() error {
	if h.IssuedAt < 0 || h.ExpiresAt < 0 {
		return errors.New("iat and exp must be non-negative")
	}
	return nil
}

func validateShortLived(msg ControlMessage) error {
	h := msg.Header()
	if CarriesCredentials(msg) && h.ExpiresAt-h.IssuedAt > CredentialFrameTTLMS {
		return fmt.Errorf("frames carrying credentials must expire within %d ms", CredentialFrameTTLMS)
	}
	return nil
}

// Validate implements [Validator].
func (m *Welcome) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if m.HeartbeatIntervalMS <= 0 {
		return errors.New("heartbeat_interval_ms must be positive")
	}
	return nil
}

// Validate implements [Validator].
func (m *DesiredState) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if m.Generation < 0 {
		return errors.New("generation must be non-negative")
	}
	if len(m.Workloads) > MaxWorkloadsPerNode {
		return fmt.Errorf("workloads: at most %d", MaxWorkloadsPerNode)
	}
	seen := map[string]bool{}
	for i := range m.Workloads {
		w := &m.Workloads[i]
		if err := w.Validate(); err != nil {
			return fmt.Errorf("workloads[%d]: %w", i, err)
		}
		if w.Kind != WorkloadService {
			return fmt.Errorf("workloads[%d]: only service workloads are sent", i)
		}
		if seen[w.ID] {
			return fmt.Errorf("workloads[%d]: duplicate workload %s", i, w.ID)
		}
		seen[w.ID] = true
	}
	switch m.TLSMode {
	case TLSACME, TLSInternal, TLSOff:
	default:
		return fmt.Errorf("tls_mode: invalid %q", m.TLSMode)
	}
	if m.AppsDomain != nil && !IsHostname(*m.AppsDomain) {
		return fmt.Errorf("apps_domain: invalid %q", *m.AppsDomain)
	}
	if m.Registry != nil {
		if err := m.Registry.validate(); err != nil {
			return err
		}
	}
	return validateShortLived(m)
}

// Validate implements [Validator].
func (m *BuildJob) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if !idRE.MatchString(m.BuildID) || !idRE.MatchString(m.DeploymentID) || !idRE.MatchString(m.ProjectID) ||
		!idRE.MatchString(m.ServiceID) {
		return errors.New("build_id, deployment_id, project_id and service_id must be ids")
	}
	s := m.Source
	if s.Type != "git" || len(s.URL) > 2048 || !gitURLRE.MatchString(s.URL) || !commitSHARE.MatchString(s.CommitSHA) ||
		len(s.Token) > 4096 {
		return errors.New("source: invalid git source")
	}
	if s.Ref != "" && !IsSafeGitRef(s.Ref) {
		return fmt.Errorf("source.ref: unsafe ref %q", s.Ref)
	}
	if m.BuildSecretsSealed != nil {
		if err := m.BuildSecretsSealed.validate(); err != nil {
			return fmt.Errorf("build_secrets_sealed: %w", err)
		}
	}
	switch m.Builder {
	case BuilderRailpack:
		if m.DockerfilePath != "" {
			return errors.New("dockerfile_path is only allowed with the dockerfile builder")
		}
	case BuilderDockerfile:
		if m.DockerfilePath != "" && !IsSafeRelativePath(m.DockerfilePath) {
			return fmt.Errorf("dockerfile_path: unsafe path %q", m.DockerfilePath)
		}
	default:
		return fmt.Errorf("builder: invalid %q", m.Builder)
	}
	if !IsSafeRelativePath(m.ContextDir) {
		return fmt.Errorf("context_dir: unsafe path %q", m.ContextDir)
	}
	if len(m.BuildArgs) > MaxBuildArgs {
		return fmt.Errorf("build_args: at most %d", MaxBuildArgs)
	}
	for k, v := range m.BuildArgs {
		if len(k) > 256 || !envKeyRE.MatchString(k) || len(v) > MaxBuildArgValueBytes {
			return fmt.Errorf("build_args: invalid %q", k)
		}
	}
	if len(m.ImageRepository) > maxImageRepository || !imageRepositoryRE.MatchString(m.ImageRepository) ||
		!strings.HasPrefix(m.ImageRepository, RegistryListen+"/") {
		return fmt.Errorf("image_repository: must be in the local registry, got %q", m.ImageRepository)
	}
	if m.ImageRepository != LocalImageRepository(m.ProjectID, m.ServiceID) {
		return errors.New("image_repository: must be the service's local repository")
	}
	if !cacheKeyRE.MatchString(m.CacheKey) || m.CacheKey != BuildCacheKey(m.ProjectID, m.ServiceID) {
		return fmt.Errorf("cache_key: must be %s", BuildCacheKey(m.ProjectID, m.ServiceID))
	}
	if m.TimeoutS < 60 || m.TimeoutS > 7200 {
		return errors.New("timeout_s: out of range")
	}
	return validateShortLived(m)
}

// Validate implements [Validator].
func (m *Hello) Validate() error {
	if !m.Arch.Valid() {
		return fmt.Errorf("arch: invalid %q", m.Arch)
	}
	if len(m.Statuses) > MaxStatusesPerHello {
		return fmt.Errorf("statuses: at most %d", MaxStatusesPerHello)
	}
	for i := range m.Statuses {
		if err := m.Statuses[i].Validate(); err != nil {
			return fmt.Errorf("statuses[%d]: %w", i, err)
		}
	}
	if m.EncryptionKey != nil {
		return m.EncryptionKey.validate()
	}
	return nil
}

// Validate implements [Validator].
func (m *Heartbeat) Validate() error {
	if m.Usage.CPUPercent < 0 || m.Usage.CPUPercent > 100 {
		return errors.New("usage.cpu_percent: out of range")
	}
	return nil
}

// Validate implements [Validator].
func (r *WorkloadStatusReport) Validate() error {
	if !idRE.MatchString(r.WorkloadID) {
		return fmt.Errorf("workload_id: invalid %q", r.WorkloadID)
	}
	if r.DeploymentID != nil && !idRE.MatchString(*r.DeploymentID) {
		return fmt.Errorf("deployment_id: invalid %q", *r.DeploymentID)
	}
	if !r.State.Valid() {
		return fmt.Errorf("state: invalid %q", r.State)
	}
	if r.ContainerID != "" && !containerIDRE.MatchString(r.ContainerID) {
		return fmt.Errorf("container_id: invalid %q", r.ContainerID)
	}
	if r.ExitCode != nil && (*r.ExitCode < -1 || *r.ExitCode > 255) {
		return errors.New("exit_code: out of range")
	}
	if len(r.Message) > MaxMessageBytes {
		return fmt.Errorf("message: at most %d bytes", MaxMessageBytes)
	}
	if r.Restarts < 0 || r.TS < 0 {
		return errors.New("restarts and ts must be non-negative")
	}
	return nil
}

// Validate implements [Validator].
func (m *WorkloadStatus) Validate() error { return m.WorkloadStatusReport.Validate() }

// Validate implements [Validator].
func (m *Logs) Validate() error {
	s := m.Source
	switch s.Type {
	case LogSourceRuntime:
		if !idRE.MatchString(s.WorkloadID) || !idRE.MatchString(s.DeploymentID) || s.BuildID != "" {
			return errors.New("source: runtime logs need workload_id and deployment_id")
		}
	case LogSourceBuild:
		if !idRE.MatchString(s.BuildID) || s.WorkloadID != "" || s.DeploymentID != "" {
			return errors.New("source: build logs need build_id only")
		}
	default:
		return fmt.Errorf("source.type: invalid %q", s.Type)
	}
	if len(m.Lines) == 0 || len(m.Lines) > MaxLogLinesPerFrame {
		return fmt.Errorf("lines: must have 1 to %d", MaxLogLinesPerFrame)
	}
	total := 0
	for i, l := range m.Lines {
		if l.Stream != StreamStdout && l.Stream != StreamStderr && l.Stream != StreamSystem {
			return fmt.Errorf("lines[%d].stream: invalid %q", i, l.Stream)
		}
		if l.TS < 0 || len(l.Text) > MaxLogLineBytes {
			return fmt.Errorf("lines[%d]: invalid", i)
		}
		total += len(l.Text)
	}
	if total > MaxLogFrameTextBytes {
		return fmt.Errorf("lines: at most %d bytes of text", MaxLogFrameTextBytes)
	}
	return nil
}

// Validate implements [Validator].
func (m *BuildResult) Validate() error {
	if !idRE.MatchString(m.BuildID) {
		return fmt.Errorf("build_id: invalid %q", m.BuildID)
	}
	if m.OK != (m.Image != nil) || m.OK == (m.Error != "") {
		return errors.New("a successful result has an image and no error; a failed one, the reverse")
	}
	if m.Image != nil && (len(m.Image.Repository) > maxImageRepository ||
		!imageRepositoryRE.MatchString(m.Image.Repository) || !digestRE.MatchString(m.Image.Digest)) {
		return errors.New("image: invalid")
	}
	if len(m.Error) > MaxMessageBytes {
		return fmt.Errorf("error: at most %d bytes", MaxMessageBytes)
	}
	if m.DurationMS < 0 {
		return errors.New("duration_ms must be non-negative")
	}
	return nil
}
