package runtime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/BankkRoll/Roundhouse/agent/internal/atomicfile"
	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// RegistryWorkloadID is the ID of the node's registry on
// [protocol.RegistryListen]: a builder's primary, or another node's replica
// or proxy (ADR 0005, "Registry over the mesh").
const RegistryWorkloadID = "sys_registry"

// RegistryMeshWorkloadID is a filesystem primary's second registry: read
// only, behind htpasswd, published on the node's mesh address for the
// other nodes' proxies.
const RegistryMeshWorkloadID = "sys_registry_mesh"

// SystemNetwork is the bridge network system workloads join.
const SystemNetwork = "roundhouse-system"

// RegistryImage is the CNCF distribution registry the builder node runs.
//
// It is pinned by the digest of the multi-arch index, so every node runs
// byte-identical code whatever the tag later points to, and a compromised
// or re-pushed tag cannot change what runs next to the build cache.
// Bumping it is a deliberate change: update both the tag and the digest
// (docker buildx imagetools inspect registry:<version>).
const RegistryImage = "registry:3.1.2@sha256:01cd312e67026f06f5d89c3e133a4a9adc7cb9eeb9b1194e0b2954dfd770efd2"

const registryPort = 5000

// Directories under the data directory: a primary's blobs, a proxy's
// cache, and the mesh listener's htpasswd.
const (
	registryDataDir  = "registry"
	registryCacheDir = "registry-cache"
	registryAuthDir  = "registry-auth"
)

// registryAuthMount is where the mesh listener sees [registryAuthDir].
const registryAuthMount = "/auth"

// registryReadOnly turns on distribution's read-only maintenance mode, in
// which every write (push, delete) is refused.
const registryReadOnly = `{"enabled":true}`

// registryPlan is a desired state's registry config, checked and with the
// proxy's password opened. [Runtime.Apply] derives it once per desired
// state, so the specs built from it on every pass agree.
type registryPlan struct {
	cfg *protocol.RegistryConfig
	// password is a proxy's upstream password; upstream its upstream's
	// mesh address.
	password string
	upstream netip.AddrPort
	// meshAddr is the address a primary's mesh listener is published on.
	meshAddr netip.Addr
	// blocked says why the registry may not run; meshBlocked why its mesh
	// listener may not.
	blocked, meshBlocked string
}

// mode returns the plan's registry mode, empty meaning primary.
func (p *registryPlan) mode() protocol.RegistryMode {
	if p.cfg.Mode == "" {
		return protocol.RegistryPrimary
	}
	return p.cfg.Mode
}

// planRegistry checks ds's registry config against its mesh config and
// opens a proxy's upstream password with open (nil refuses proxies).
//
// SECURITY: the mesh listener may only be published on this node's own
// mesh address, and a proxy may only pull from another node's registry
// port over the mesh: an upstream elsewhere would make the registry, and
// the table rule that lets it out, a way into any address.
func planRegistry(ds *protocol.DesiredState, open func(int64, *protocol.RegistryUpstream) (string, error)) *registryPlan {
	cfg := ds.Registry
	if cfg == nil {
		return nil
	}
	p := &registryPlan{cfg: cfg}
	if cfg.MeshListen != "" {
		addr, err := netip.ParseAddrPort(cfg.MeshListen)
		switch {
		case ds.Mesh == nil:
			p.meshBlocked = "refusing the registry's mesh listener: this node is not in the mesh"
		case err != nil || addr.Port() != registryPort || addr.Addr().String() != ds.Mesh.Address:
			p.meshBlocked = fmt.Sprintf("refusing the registry's mesh listener on %s: not this node's mesh address", cfg.MeshListen)
		default:
			p.meshAddr = addr.Addr()
		}
	}
	if p.mode() != protocol.RegistryProxy || cfg.Upstream == nil {
		return p
	}
	upstream, err := meshUpstream(cfg.Upstream.URL, ds.Mesh)
	if err != nil {
		p.blocked = "refusing the registry proxy: " + err.Error()
		return p
	}
	if open == nil {
		p.blocked = "refusing the registry proxy: no key to open its upstream password"
		return p
	}
	password, err := open(ds.Generation, cfg.Upstream)
	if err != nil {
		p.blocked = "cannot open the registry proxy's upstream password: " + err.Error()
		return p
	}
	p.password, p.upstream = password, upstream
	return p
}

// meshUpstream parses a proxy's upstream URL, which must be
// http://<another node's mesh address>:5000 of mesh.
func meshUpstream(raw string, mesh *protocol.MeshConfig) (netip.AddrPort, error) {
	if mesh == nil {
		return netip.AddrPort{}, errors.New("this node is not in the mesh")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || strings.Trim(u.Path, "/") != "" || u.RawQuery != "" {
		return netip.AddrPort{}, fmt.Errorf("upstream %q is not http://<node mesh address>:%d", raw, registryPort)
	}
	addr, err := netip.ParseAddrPort(u.Host)
	if err != nil || addr.Port() != registryPort || !slices.Contains(mesh.NodeAddresses, addr.Addr().String()) ||
		addr.Addr().String() == mesh.Address {
		return netip.AddrPort{}, fmt.Errorf("upstream %q is not another node's registry on the mesh", raw)
	}
	return addr, nil
}

// registrySpecs derives the registry system workloads of plan: the
// registry on [protocol.RegistryListen] and, for a filesystem primary with
// mesh_listen, its read-only twin on the mesh address over the same blobs.
//
// SECURITY: credentials (S3 keys, a proxy's upstream password) travel
// only in the container's environment, never in a file the agent writes;
// the htpasswd file holds bcrypt hashes and is written 0600.
func registrySpecs(plan *registryPlan, dataDir string, generation int64) []*wantSpec {
	main := registrySpec(plan, dataDir, generation)
	if plan.cfg.MeshListen == "" || plan.mode() != protocol.RegistryPrimary || plan.cfg.Storage.Type != protocol.StorageFilesystem {
		return []*wantSpec{main}
	}
	return []*wantSpec{main, registryMeshSpec(plan, dataDir, generation)}
}

// registrySpec derives the registry on [protocol.RegistryListen].
func registrySpec(plan *registryPlan, dataDir string, generation int64) *wantSpec {
	cfg := plan.cfg
	env := registryEnv()
	var binds []string
	if cfg.Storage.Type == protocol.StorageS3 {
		s := cfg.Storage
		env["REGISTRY_STORAGE"] = "s3"
		env["REGISTRY_STORAGE_S3_REGIONENDPOINT"] = s.Endpoint
		env["REGISTRY_STORAGE_S3_BUCKET"] = s.Bucket
		env["REGISTRY_STORAGE_S3_REGION"] = s.Region
		env["REGISTRY_STORAGE_S3_ACCESSKEY"] = s.AccessKeyID
		env["REGISTRY_STORAGE_S3_SECRETKEY"] = s.SecretAccessKey
		env["REGISTRY_STORAGE_S3_FORCEPATHSTYLE"] = "true"
	} else {
		dir := registryDataDir
		if plan.mode() == protocol.RegistryProxy {
			// NOTE: a cache of its own, so a node that stops being a builder
			// never serves its old primary's blobs as cached ones.
			dir = registryCacheDir
		}
		binds = []string{hostPath(dataDir, dir) + ":/var/lib/registry"}
	}
	switch plan.mode() {
	case protocol.RegistryReplica:
		readOnly(env)
	case protocol.RegistryProxy:
		env["REGISTRY_STORAGE_DELETE_ENABLED"] = "false"
		if plan.blocked == "" {
			env["REGISTRY_PROXY_REMOTEURL"] = "http://" + plan.upstream.String()
			env["REGISTRY_PROXY_USERNAME"] = cfg.Upstream.Username
			env["REGISTRY_PROXY_PASSWORD"] = plan.password
		}
	}
	s := systemSpec(RegistryWorkloadID, env, "/v2/", generation)
	s.hostPorts = map[string][]docker.PortBinding{
		"5000/tcp": {{HostIP: "127.0.0.1", HostPort: strconv.Itoa(registryPort)}},
	}
	s.binds = binds
	s.blocked = plan.blocked
	s.SpecHash = systemHash(s)
	return s
}

// registryMeshSpec derives a filesystem primary's mesh listener.
func registryMeshSpec(plan *registryPlan, dataDir string, generation int64) *wantSpec {
	env := registryEnv()
	readOnly(env)
	env["REGISTRY_AUTH"] = "htpasswd"
	env["REGISTRY_AUTH_HTPASSWD_REALM"] = "roundhouse"
	env["REGISTRY_AUTH_HTPASSWD_PATH"] = registryAuthMount + "/htpasswd"
	// The root answers 200 without credentials; /v2/ wants them.
	s := systemSpec(RegistryMeshWorkloadID, env, "/", generation)
	s.binds = []string{
		hostPath(dataDir, registryDataDir) + ":/var/lib/registry:ro",
		hostPath(dataDir, registryAuthDir) + ":" + registryAuthMount + ":ro",
	}
	s.files = []hostFile{{path: filepath.Join(dataDir, registryAuthDir, "htpasswd"), data: htpasswd(plan.cfg.PullUsers)}}
	s.blocked = plan.meshBlocked
	if plan.meshAddr.IsValid() {
		s.bindAddr = plan.meshAddr
		s.hostPorts = map[string][]docker.PortBinding{
			"5000/tcp": {{HostIP: plan.meshAddr.String(), HostPort: strconv.Itoa(registryPort)}},
		}
	}
	s.SpecHash = systemHash(s)
	return s
}

// registryEnv is the environment every registry container starts from.
func registryEnv() map[string]string {
	return map[string]string{
		"REGISTRY_HTTP_ADDR":              ":5000",
		"REGISTRY_LOG_LEVEL":              "info",
		"REGISTRY_STORAGE_DELETE_ENABLED": "true",
		"OTEL_TRACES_EXPORTER":            "none",
	}
}

// readOnly makes a registry refuse every write and stop purging uploads.
func readOnly(env map[string]string) {
	env["REGISTRY_STORAGE_DELETE_ENABLED"] = "false"
	env["REGISTRY_STORAGE_MAINTENANCE_READONLY"] = registryReadOnly
	env["REGISTRY_STORAGE_MAINTENANCE_UPLOADPURGING"] = `{"enabled":false}`
}

// systemSpec is a registry container's spec without host extras.
func systemSpec(id string, env map[string]string, healthPath string, generation int64) *wantSpec {
	return &wantSpec{
		WorkloadSpec: protocol.WorkloadSpec{
			ID:    id,
			Kind:  protocol.WorkloadSystem,
			Image: RegistryImage,
			Env:   env,
			Ports: []protocol.WorkloadPort{{ContainerPort: registryPort, Protocol: protocol.PortHTTP}},
			Healthcheck: &protocol.Healthcheck{
				Type: protocol.HealthcheckHTTP, Path: healthPath, Port: registryPort,
				IntervalS: 5, TimeoutS: 3, Retries: 3, StartPeriodS: 10,
			},
			Resources: protocol.Resources{CPUMillis: 1000, MemoryMB: 512, PIDs: 1024},
			Restart:   protocol.Restart{Policy: protocol.RestartAlways},
			Network:   SystemNetwork,
			Labels:    map[string]string{},
		},
		generation: generation,
		exclusive:  true,
	}
}

// htpasswd renders pull users as an htpasswd file, sorted by name. The
// protocol's patterns keep ':' and newlines out of names and hashes.
func htpasswd(users []protocol.RegistryPullUser) []byte {
	sorted := slices.Clone(users)
	slices.SortFunc(sorted, func(a, b protocol.RegistryPullUser) int { return strings.Compare(a.Username, b.Username) })
	var b strings.Builder
	for _, u := range sorted {
		b.WriteString(u.Username + ":" + u.Bcrypt + "\n")
	}
	return []byte(b.String())
}

func hostPath(dataDir, dir string) string { return filepath.ToSlash(filepath.Join(dataDir, dir)) }

// hostFile is a file the agent writes on the host before creating a
// system container that binds it.
type hostFile struct {
	path string
	data []byte
}

// writeHostFiles writes files 0600 in directories 0700, each atomically.
func writeHostFiles(files []hostFile) error {
	for _, f := range files {
		if err := os.MkdirAll(filepath.Dir(f.path), 0o700); err != nil {
			return err
		}
		// NOTE: MkdirAll leaves an existing directory's mode alone.
		if err := os.Chmod(filepath.Dir(f.path), 0o700); err != nil {
			return err
		}
		if err := atomicfile.Write(f.path, f.data, 0o600); err != nil {
			return err
		}
	}
	return nil
}

// systemHash covers the spec and the host-level extras a [WorkloadSpec]
// cannot express, so a change to either recreates the container.
func systemHash(s *wantSpec) string {
	base, err := protocol.ComputeSpecHash(s.WorkloadSpec)
	if err != nil {
		// NOTE: only non-integer numbers fail canonicalisation, and system
		// specs contain none.
		panic("runtime: system spec hash: " + err.Error())
	}
	var files map[string]string
	for _, f := range s.files {
		if files == nil {
			files = map[string]string{}
		}
		sum := sha256.Sum256(f.data)
		files[filepath.ToSlash(f.path)] = hex.EncodeToString(sum[:])
	}
	// NOTE: Files is omitted when empty so the registries of earlier agents
	// keep their hash, and are not recreated by an upgrade.
	extras, _ := json.Marshal(struct {
		Ports map[string][]docker.PortBinding
		Binds []string
		Files map[string]string `json:",omitempty"`
	}{s.hostPorts, s.binds, files})
	sum := sha256.Sum256(append([]byte(base+"\n"), extras...))
	return hex.EncodeToString(sum[:])
}

// pruneRegistryAuth removes the mesh listener's htpasswd once the listener
// is neither wanted nor running, so the pull users' hashes don't outlive
// mesh_listen on disk.
func (r *Runtime) pruneRegistryAuth(specs []*wantSpec) {
	if r.opts.DataDir == "" || slices.ContainsFunc(specs, func(s *wantSpec) bool { return s.ID == RegistryMeshWorkloadID }) {
		return
	}
	r.mu.Lock()
	running := slices.ContainsFunc(slices.Collect(maps.Values(r.instances)), func(inst *instance) bool {
		return inst.meta.workloadID == RegistryMeshWorkloadID
	})
	r.mu.Unlock()
	if running {
		return
	}
	dir := filepath.Join(r.opts.DataDir, registryAuthDir)
	if _, err := os.Stat(dir); err != nil {
		return
	}
	if err := os.RemoveAll(dir); err != nil {
		r.log.Warn("remove the registry's htpasswd", "dir", dir, "err", err)
		return
	}
	r.log.Info("removed the registry mesh listener's htpasswd", "dir", dir)
}
