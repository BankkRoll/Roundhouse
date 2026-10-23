package builder

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"slices"
	"strings"
	"sync"
	"time"

	bkclient "github.com/moby/buildkit/client"
)

// Pinned images. Tags are informative; the digest (of the multi-platform
// index) is what the engine resolves.
const (
	// BuildKitImage is the rootless BuildKit daemon image.
	BuildKitImage = "moby/buildkit:v0.34.1-rootless@sha256:f68752a5a94acfcdad2d07867b7075601a421638e17fc5f28efc1c814d0c4f89"
	// RailpackVersion is the Railpack release whose CLI install.sh installs
	// and whose frontend builds the plans it prepares; the two must match.
	RailpackVersion = "0.43.0"
	// RailpackFrontendImage is Railpack's BuildKit frontend for RailpackVersion.
	RailpackFrontendImage = "ghcr.io/railwayapp/railpack-frontend:v0.43.0@sha256:355ef61fae6f2551103cd8b10c710cb07167dd353d561f15c69b8d7ac1c676cc"
)

// Docker objects the builder owns. They are labelled roundhouse.system rather
// than roundhouse.managed, so the workload reconciler never removes them.
const (
	// WorkloadID is the system workload ID of the BuildKit daemons.
	WorkloadID = "sys_buildkitd"
	// ContainerName prefixes each project's BuildKit daemon container; see
	// [DaemonName]. Before per-project daemons it was the one shared daemon.
	ContainerName = "sys_buildkitd"
	// NetworkName is the bridge network every daemon, and therefore every
	// RUN step, is confined to.
	NetworkName = "roundhouse-build"
	// BridgeInterface is the host interface of NetworkName.
	BridgeInterface = "roundhouse-bk0"
	// CacheVolumeName prefixes each project's volume holding BuildKit's
	// state and cache across restarts. Before per-project daemons it was the
	// one shared cache.
	CacheVolumeName = "roundhouse-buildkit"
	// DefaultRegistryProxyPort is where the per-build registry proxy listens
	// on the build network's gateway.
	DefaultRegistryProxyPort = 5001
)

// Defaults of the per-project daemons (ADR 0014 H3, H4).
const (
	// DefaultMaxDaemons is how many daemons run at once; starting another
	// stops the least recently used.
	DefaultMaxDaemons = 2
	// DefaultDaemonIdle is how long a daemon runs after its last build.
	DefaultDaemonIdle = 10 * time.Minute
	// DefaultDaemonMemoryBytes limits each daemon, its build steps included.
	DefaultDaemonMemoryBytes = 4 << 30
	// DefaultDaemonCPUs limits each daemon, in cores.
	DefaultDaemonCPUs = 2
	// DaemonPidsLimit bounds each daemon's processes, so a fork bomb in a
	// RUN step can't exhaust the host's PIDs.
	DaemonPidsLimit = 4096
)

const (
	labelSystem     = "roundhouse.system"
	labelConfigHash = "roundhouse.config-hash"
	labelProject    = "roundhouse.project_id"

	// registryProxyHost is the name the daemons use for the agent's
	// per-build registry proxy; /etc/hosts in each container maps it to the
	// build network's gateway.
	registryProxyHost = "roundhouse-registry.internal"

	buildkitStateDir   = "/home/user/.local/share/buildkit"
	buildkitConfigDir  = "/home/user"
	buildkitConfigFile = "buildkitd.toml"
	// rootlessUID owns the files of the rootless image's user.
	rootlessUID = 1000

	daemonReadyTimeout = 90 * time.Second
	daemonStopGrace    = 5 * time.Second
)

// DaemonName returns the container of a project's BuildKit daemon.
func DaemonName(projectID string) string { return ContainerName + "-" + strings.ToLower(projectID) }

// daemonVolume returns the volume holding a project's BuildKit state.
//
// NOTE: ADR 0014 places the state in /var/lib/roundhouse/buildkit/<project>
// on the host. A named volume is used instead: rootless BuildKit needs its
// state owned by UID 1000, which a fresh volume inherits from the image,
// while the agent's systemd sandbox has no CAP_CHOWN to hand a host
// directory over. The isolation is the same: one cache per project.
func daemonVolume(projectID string) string {
	return CacheVolumeName + "-" + strings.ToLower(projectID)
}

// daemon manages the BuildKit daemons, one per project, and connects to
// them.
//
// SECURITY: BuildKit's cache mounts (RUN --mount=type=cache) and layer cache
// can't be scoped to a tenant inside one daemon, so a shared daemon would
// let one project read or poison another's cache. Each project gets its own
// daemon and state volume instead, started on demand; at most maxRunning
// run, the least recently used stopping first, and each stops after
// idleAfter without builds (ADR 0014 H3).
//
// BuildKit runs rootless (as UID 1000 in a user namespace) and listens only
// on a unix socket inside its container; clients reach it by running
// `buildctl dial-stdio` through the Docker exec API. Rootless BuildKit runs
// every RUN step in the daemon's own network namespace, so the containers
// sit on their own bridge network instead of the host's: RUN steps reach
// the internet but none of the host's loopback services (Caddy's admin API,
// the registry, the agent).
//
// NOTE: rootless BuildKit needs seccomp and the /proc masks relaxed so it
// can create its own user, mount and PID namespaces: Docker's default
// seccomp profile refuses unshare(CLONE_NEWUSER) and mount without
// CAP_SYS_ADMIN, which is what BuildKit documents for containerised
// rootless use and is far narrower than the --privileged a rootful daemon
// needs. AppArmor stays on wherever the engine uses it: where AppArmor
// restricts unprivileged user namespaces the daemons run under
// [AppArmorProfile], which adds only that permission (see apparmor.go).
// Every daemon is bounded in memory, CPU and PIDs.
type daemon struct {
	docker *dockerAPI
	log    *slog.Logger
	image  string

	proxyPort     int
	cacheMaxBytes int64
	minFreeBytes  int64
	memoryBytes   int64
	nanoCPUs      int64
	// apparmorOverride is [Options.AppArmorProfile]; empty resolves it.
	apparmorOverride string
	maxRunning       int
	idleAfter        time.Duration

	mu sync.Mutex
	// gateway is the build network's gateway, where the registry proxy
	// listens; set by ensure.
	gateway string
	// apparmor is the resolved AppArmor profile; empty until ensure
	// resolves it, and again after a user namespace denial.
	apparmor string
	// instances are the daemons known to this process, by container name.
	instances map[string]*instance
	// adopted is set once the daemons an earlier agent process left running
	// were found, and the shared daemon of older agents removed.
	adopted bool
}

// instance is one project's daemon.
type instance struct {
	name    string
	running bool
	// inUse is set from ensure until release: a build is using it.
	inUse    bool
	lastUsed time.Time
	idle     *time.Timer
}

// daemonConfig renders buildkitd.toml.
func (d *daemon) daemonConfig() string {
	reserved := min(d.cacheMaxBytes/10, 2<<30)
	return fmt.Sprintf(`# Managed by roundhouse-agent; changes are overwritten.
[log]
  format = "text"

[history]
  maxAge = 86400
  maxEntries = 20

[worker.oci]
  enabled = true
  gc = true
  reservedSpace = %d
  maxUsedSpace = %d
  minFreeSpace = %d

[worker.containerd]
  enabled = false

[registry."%s:%d"]
  http = true
`, reserved, d.cacheMaxBytes, d.minFreeBytes, registryProxyHost, d.proxyPort)
}

// limits returns the daemon's memory (bytes), CPU (billionths of a core)
// and PIDs limits, defaulted.
func (d *daemon) limits() (memory, nanoCPUs, pids int64) {
	memory, nanoCPUs = d.memoryBytes, d.nanoCPUs
	if memory <= 0 {
		memory = DefaultDaemonMemoryBytes
	}
	if nanoCPUs <= 0 {
		nanoCPUs = DefaultDaemonCPUs * 1e9
	}
	return memory, nanoCPUs, DaemonPidsLimit
}

// containerSpec is the create body for project's daemon, running under the
// AppArmor profile apparmor.
func (d *daemon) containerSpec(project, gateway, apparmor, configHash string) map[string]any {
	memory, nanoCPUs, pids := d.limits()
	host := map[string]any{
		"NetworkMode": NetworkName,
		"SecurityOpt": []string{"seccomp=unconfined", "apparmor=" + apparmor},
		// Empty lists are the API form of --security-opt systempaths=unconfined.
		"MaskedPaths":   []string{},
		"ReadonlyPaths": []string{},
		"Mounts": []map[string]any{{
			"Type":   "volume",
			"Source": daemonVolume(project),
			"Target": buildkitStateDir,
		}},
		"ExtraHosts": []string{registryProxyHost + ":" + gateway},
		// NOTE: the agent starts daemons on demand and stops idle ones, so
		// the engine must not restart a stopped one behind its back.
		"RestartPolicy": map[string]any{"Name": "no"},
		"Memory":        memory,
		"MemorySwap":    memory,
		"NanoCpus":      nanoCPUs,
		"PidsLimit":     pids,
		"LogConfig": map[string]any{
			"Type":   "json-file",
			"Config": map[string]string{"max-size": "10m", "max-file": "3"},
		},
	}
	return map[string]any{
		"Image": d.image,
		// The image's entrypoint is `rootlesskit buildkitd`.
		"Cmd": []string{"--config", buildkitConfigDir + "/" + buildkitConfigFile},
		"Labels": map[string]string{
			labelSystem:     "buildkitd",
			labelProject:    project,
			labelConfigHash: configHash,
		},
		"HostConfig": host,
	}
}

// ensure makes project's daemon exist, match the current configuration and
// run, stopping the least recently used other daemon if too many run, and
// marks it in use until [daemon.release]. It returns the daemon's container
// name and is cheap when everything is already in place.
func (d *daemon) ensure(ctx context.Context, project string) (string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	name := DaemonName(project)
	inst := d.instance(name)
	inst.inUse = true
	if inst.idle != nil {
		inst.idle.Stop()
	}
	if !d.adopted {
		if err := d.adopt(ctx); err != nil {
			return "", err
		}
		d.adopted = true
	}

	gateway, err := d.ensureNetwork(ctx)
	if err != nil {
		return "", fmt.Errorf("build network: %w", err)
	}
	if err := d.docker.createVolume(ctx, daemonVolume(project), map[string]string{labelSystem: "buildkitd", labelProject: project}); err != nil {
		return "", fmt.Errorf("cache volume: %w", err)
	}
	apparmor, err := d.appArmorProfile(ctx)
	if err != nil {
		return "", fmt.Errorf("AppArmor profile: %w", err)
	}
	if err := d.makeRoom(ctx, name); err != nil {
		return "", err
	}

	cfg := d.daemonConfig()
	memory, nanoCPUs, pids := d.limits()
	sum := sha256.Sum256([]byte(d.image + "\x00" + gateway + "\x00" + apparmor + "\x00" + cfg + "\x00" +
		fmt.Sprint(memory, nanoCPUs, pids)))
	hash := hex.EncodeToString(sum[:12])

	info, err := d.docker.inspectContainer(ctx, name)
	switch {
	case err == nil && info.Config.Labels[labelConfigHash] == hash:
		if !info.State.Running {
			d.log.Info("starting BuildKit daemon", "container", name)
			if err := d.docker.startContainer(ctx, info.ID); err != nil {
				return "", fmt.Errorf("start %s: %w", name, err)
			}
		}
		inst.running = true
		d.gateway = gateway
		return name, nil
	case err == nil:
		d.log.Info("recreating BuildKit daemon with new configuration", "container", name)
		if err := d.docker.removeContainer(ctx, info.ID); err != nil {
			return "", fmt.Errorf("remove %s: %w", name, err)
		}
	case !isNotFound(err):
		return "", fmt.Errorf("inspect %s: %w", name, err)
	}

	if err := d.ensureImage(ctx); err != nil {
		return "", err
	}
	id, err := d.docker.createContainer(ctx, name, d.containerSpec(project, gateway, apparmor, hash))
	if err != nil {
		return "", fmt.Errorf("create %s: %w", name, err)
	}
	tarball, err := singleFileTar(buildkitConfigFile, []byte(cfg), rootlessUID)
	if err != nil {
		return "", err
	}
	if err := d.docker.putArchive(ctx, id, buildkitConfigDir, tarball); err != nil {
		_ = d.docker.removeContainer(context.WithoutCancel(ctx), id)
		return "", fmt.Errorf("configure %s: %w", name, err)
	}
	if err := d.docker.startContainer(ctx, id); err != nil {
		return "", fmt.Errorf("start %s: %w", name, err)
	}
	inst.running = true
	d.log.Info("started BuildKit daemon", "container", name, "image", d.image, "apparmor_profile", apparmor)
	d.gateway = gateway
	return name, nil
}

// instance returns the record of the daemon named name, creating it.
// Caller holds d.mu.
func (d *daemon) instance(name string) *instance {
	if d.instances == nil {
		d.instances = map[string]*instance{}
	}
	inst := d.instances[name]
	if inst == nil {
		inst = &instance{name: name}
		d.instances[name] = inst
	}
	return inst
}

// release marks project's daemon idle after a build; it stops after
// idleAfter unless another build uses it first.
func (d *daemon) release(project string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	inst := d.instance(DaemonName(project))
	inst.inUse = false
	inst.lastUsed = time.Now()
	d.scheduleIdleStop(inst)
}

// scheduleIdleStop arms inst's idle timer. Caller holds d.mu.
func (d *daemon) scheduleIdleStop(inst *instance) {
	if inst.idle != nil {
		inst.idle.Stop()
	}
	idle := d.idleAfter
	if idle <= 0 {
		idle = DefaultDaemonIdle
	}
	inst.idle = time.AfterFunc(idle, func() { d.stopIdle(inst.name, idle) })
}

// stopIdle stops a daemon unused for idle.
func (d *daemon) stopIdle(name string, idle time.Duration) {
	d.mu.Lock()
	defer d.mu.Unlock()
	inst := d.instances[name]
	if inst == nil || inst.inUse || !inst.running || time.Since(inst.lastUsed) < idle {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), daemonStopGrace+30*time.Second)
	defer cancel()
	d.stop(ctx, inst, "idle")
}

// makeRoom stops the least recently used running daemons other than keep
// until starting keep stays within maxRunning. Caller holds d.mu.
func (d *daemon) makeRoom(ctx context.Context, keep string) error {
	limit := d.maxRunning
	if limit <= 0 {
		limit = DefaultMaxDaemons
	}
	var others []*instance
	for _, inst := range d.instances {
		if inst.running && inst.name != keep {
			others = append(others, inst)
		}
	}
	slices.SortFunc(others, func(a, b *instance) int { return a.lastUsed.Compare(b.lastUsed) })
	n := len(others)
	for _, inst := range others {
		if n < limit {
			break
		}
		if inst.inUse {
			continue
		}
		if err := d.stop(ctx, inst, "too many BuildKit daemons running"); err != nil {
			return err
		}
		n--
	}
	return nil
}

// stop stops inst's container, keeping it and its cache for the next
// build. Caller holds d.mu.
func (d *daemon) stop(ctx context.Context, inst *instance, why string) error {
	if inst.idle != nil {
		inst.idle.Stop()
	}
	if err := d.docker.stopContainer(ctx, inst.name, daemonStopGrace); err != nil {
		d.log.Warn("could not stop BuildKit daemon", "container", inst.name, "reason", why, "error", err)
		return fmt.Errorf("stop %s: %w", inst.name, err)
	}
	inst.running = false
	d.log.Info("stopped BuildKit daemon", "container", inst.name, "reason", why)
	return nil
}

// adopt records the daemons an earlier agent process left behind, so they
// count towards maxRunning and stop when idle, and removes the single
// daemon and cache all projects shared before per-project daemons, since
// that cache mixes every project's layers. Caller holds d.mu.
func (d *daemon) adopt(ctx context.Context) error {
	list, err := d.docker.listContainers(ctx, labelSystem+"=buildkitd")
	if err != nil {
		return fmt.Errorf("list BuildKit daemons: %w", err)
	}
	for _, c := range list {
		name := c.name()
		if c.Labels[labelProject] == "" || name == ContainerName {
			d.log.Info("removing the BuildKit daemon shared by every project; each project now gets its own", "container", name)
			if err := d.docker.removeContainer(ctx, c.ID); err != nil {
				return fmt.Errorf("remove %s: %w", name, err)
			}
			continue
		}
		inst := d.instance(name)
		inst.running = c.State == "running"
		if inst.running && !inst.inUse {
			inst.lastUsed = time.Now()
			d.scheduleIdleStop(inst)
		}
	}
	if err := d.docker.removeVolume(ctx, CacheVolumeName); err != nil && !isConflict(err) {
		d.log.Warn("could not remove the shared BuildKit cache volume", "volume", CacheVolumeName, "error", err)
	}
	return nil
}

// ensureImage pulls the BuildKit image unless the engine already has it.
func (d *daemon) ensureImage(ctx context.Context) error {
	ok, err := d.docker.imageExists(ctx, d.image)
	if err != nil || ok {
		return err
	}
	d.log.Info("pulling BuildKit image", "image", d.image)
	return d.docker.pullImage(ctx, d.image)
}

// ensureNetwork creates the build network if needed and returns its IPv4
// gateway.
func (d *daemon) ensureNetwork(ctx context.Context) (string, error) {
	n, err := d.docker.inspectNetwork(ctx, NetworkName)
	if isNotFound(err) {
		if err := d.docker.createNetwork(ctx, NetworkName, map[string]string{labelSystem: "buildkitd"}); err != nil {
			return "", err
		}
		n, err = d.docker.inspectNetwork(ctx, NetworkName)
	}
	if err != nil {
		return "", err
	}
	for _, c := range n.IPAM.Config {
		if ip := net.ParseIP(c.Gateway); ip != nil && ip.To4() != nil {
			return ip.String(), nil
		}
	}
	return "", fmt.Errorf("network %s has no IPv4 gateway", NetworkName)
}

// connect returns a BuildKit client for the running daemon in container
// name, waiting for it to answer if it has just started.
func (d *daemon) connect(ctx context.Context, name string, errOut io.Writer) (*bkclient.Client, error) {
	c, err := bkclient.New(ctx, "", bkclient.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
		return d.docker.execStdio(ctx, name, []string{"buildctl", "dial-stdio"}, errOut)
	}))
	if err != nil {
		return nil, err
	}
	waitCtx, cancel := context.WithTimeout(ctx, daemonReadyTimeout)
	defer cancel()
	var lastErr error
	for {
		ws, err := c.ListWorkers(waitCtx)
		if err == nil && len(ws) > 0 {
			return c, nil
		}
		lastErr = err
		select {
		case <-waitCtx.Done():
			c.Close()
			if ctx.Err() != nil {
				return nil, context.Cause(ctx)
			}
			logs := strings.TrimSpace(d.docker.containerLogs(context.WithoutCancel(ctx), name, 20))
			if userNamespaceDenied(logs) {
				profile := d.currentAppArmorProfile()
				d.forgetAppArmorProfile()
				hint := userNamespaceHint(profile)
				d.log.Error("BuildKit daemon cannot start: "+hint, "container", name)
				return nil, fmt.Errorf("BuildKit daemon did not become ready: %s\n%s", hint, logs)
			}
			return nil, fmt.Errorf("BuildKit daemon did not become ready: %v\n%s", lastErr, logs)
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func (d *daemon) gatewayIP() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.gateway
}

// singleFileTar returns a tar stream holding one file owned by uid.
func singleFileTar(name string, content []byte, uid int) ([]byte, error) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	if err := tw.WriteHeader(&tar.Header{
		Name:    name,
		Mode:    0o644,
		Size:    int64(len(content)),
		Uid:     uid,
		Gid:     uid,
		ModTime: time.Unix(0, 0),
		Format:  tar.FormatPAX,
	}); err != nil {
		return nil, err
	}
	if _, err := tw.Write(content); err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// prune trims a daemon's cache to the configured cap. BuildKit also
// collects garbage on its own after builds; this bounds the cache when a
// burst of builds outpaces it.
func (d *daemon) prune(ctx context.Context, c *bkclient.Client) error {
	reserved := min(d.cacheMaxBytes/10, 2<<30)
	err := c.Prune(ctx, nil, bkclient.WithKeepOpt(0, reserved, d.cacheMaxBytes, d.minFreeBytes))
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}
