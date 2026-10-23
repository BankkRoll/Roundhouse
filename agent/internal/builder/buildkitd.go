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
	// WorkloadID is the system workload ID of the BuildKit daemon.
	WorkloadID = "sys_buildkitd"
	// ContainerName is the BuildKit daemon's container.
	ContainerName = "sys_buildkitd"
	// NetworkName is the bridge network the daemon, and therefore every RUN
	// step, is confined to.
	NetworkName = "roundhouse-build"
	// BridgeInterface is the host interface of NetworkName.
	BridgeInterface = "roundhouse-bk0"
	// CacheVolumeName holds BuildKit's state and cache across restarts.
	CacheVolumeName = "roundhouse-buildkit"
	// DefaultRegistryProxyPort is where the per-build registry proxy listens
	// on the build network's gateway.
	DefaultRegistryProxyPort = 5001
)

const (
	labelSystem     = "roundhouse.system"
	labelConfigHash = "roundhouse.config-hash"

	// registryProxyHost is the name sys_buildkitd uses for the agent's
	// per-build registry proxy; /etc/hosts in the container maps it to the
	// build network's gateway.
	registryProxyHost = "roundhouse-registry.internal"

	buildkitStateDir   = "/home/user/.local/share/buildkit"
	buildkitConfigDir  = "/home/user"
	buildkitConfigFile = "buildkitd.toml"
	// rootlessUID owns the files of the rootless image's user.
	rootlessUID = 1000

	daemonReadyTimeout = 90 * time.Second
)

// daemon manages the sys_buildkitd container and connects to it.
//
// BuildKit runs rootless (as UID 1000 in a user namespace) and listens only
// on a unix socket inside its container; clients reach it by running
// `buildctl dial-stdio` through the Docker exec API. Rootless BuildKit runs
// every RUN step in the daemon's own network namespace, so the container
// sits on its own bridge network instead of the host's: RUN steps reach the
// internet but none of the host's loopback services (Caddy's admin API, the
// registry, the agent).
//
// Rootless BuildKit needs seccomp, AppArmor and the /proc masks relaxed so
// it can create its own user, mount and PID namespaces; that is the
// configuration BuildKit documents for containerised rootless use and is far
// narrower than the --privileged a rootful daemon needs. Where AppArmor also
// restricts unprivileged user namespaces, "unconfined" is not enough and the
// daemon runs under [AppArmorProfile] instead; see apparmor.go.
type daemon struct {
	docker *dockerAPI
	log    *slog.Logger
	image  string

	proxyPort     int
	cacheMaxBytes int64
	minFreeBytes  int64
	memoryBytes   int64
	// apparmorOverride is [Options.AppArmorProfile]; empty resolves it.
	apparmorOverride string

	mu sync.Mutex
	// gateway is the build network's gateway, where the registry proxy
	// listens; set by ensure.
	gateway string
	// apparmor is the resolved AppArmor profile; empty until ensure
	// resolves it, and again after a user namespace denial.
	apparmor string
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

// containerSpec is the create body for sys_buildkitd, running under the
// AppArmor profile apparmor.
func (d *daemon) containerSpec(gateway, apparmor, configHash string) map[string]any {
	host := map[string]any{
		"NetworkMode": NetworkName,
		"SecurityOpt": []string{"seccomp=unconfined", "apparmor=" + apparmor},
		// Empty lists are the API form of --security-opt systempaths=unconfined.
		"MaskedPaths":   []string{},
		"ReadonlyPaths": []string{},
		"Mounts": []map[string]any{{
			"Type":   "volume",
			"Source": CacheVolumeName,
			"Target": buildkitStateDir,
		}},
		"ExtraHosts":    []string{registryProxyHost + ":" + gateway},
		"RestartPolicy": map[string]any{"Name": "unless-stopped"},
		"LogConfig": map[string]any{
			"Type":   "json-file",
			"Config": map[string]string{"max-size": "10m", "max-file": "3"},
		},
	}
	if d.memoryBytes > 0 {
		host["Memory"] = d.memoryBytes
	}
	return map[string]any{
		"Image": d.image,
		// The image's entrypoint is `rootlesskit buildkitd`.
		"Cmd": []string{"--config", buildkitConfigDir + "/" + buildkitConfigFile},
		"Labels": map[string]string{
			labelSystem:     "buildkitd",
			labelConfigHash: configHash,
		},
		"HostConfig": host,
	}
}

// ensure makes sys_buildkitd exist, match the current configuration, and
// run. It is cheap when everything is already in place.
func (d *daemon) ensure(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	gateway, err := d.ensureNetwork(ctx)
	if err != nil {
		return fmt.Errorf("build network: %w", err)
	}
	if err := d.docker.createVolume(ctx, CacheVolumeName, map[string]string{labelSystem: "buildkitd"}); err != nil {
		return fmt.Errorf("cache volume: %w", err)
	}

	apparmor, err := d.appArmorProfile(ctx)
	if err != nil {
		return fmt.Errorf("AppArmor profile: %w", err)
	}

	cfg := d.daemonConfig()
	sum := sha256.Sum256([]byte(d.image + "\x00" + gateway + "\x00" + apparmor + "\x00" + cfg + "\x00" + fmt.Sprint(d.memoryBytes)))
	hash := hex.EncodeToString(sum[:12])

	info, err := d.docker.inspectContainer(ctx, ContainerName)
	switch {
	case err == nil && info.Config.Labels[labelConfigHash] == hash:
		if !info.State.Running {
			d.log.Info("starting BuildKit daemon", "container", ContainerName)
			if err := d.docker.startContainer(ctx, info.ID); err != nil {
				return fmt.Errorf("start %s: %w", ContainerName, err)
			}
		}
		d.gateway = gateway
		return nil
	case err == nil:
		d.log.Info("recreating BuildKit daemon with new configuration", "container", ContainerName)
		if err := d.docker.removeContainer(ctx, info.ID); err != nil {
			return fmt.Errorf("remove %s: %w", ContainerName, err)
		}
	case !isNotFound(err):
		return fmt.Errorf("inspect %s: %w", ContainerName, err)
	}

	if err := d.ensureImage(ctx); err != nil {
		return err
	}
	id, err := d.docker.createContainer(ctx, ContainerName, d.containerSpec(gateway, apparmor, hash))
	if err != nil {
		return fmt.Errorf("create %s: %w", ContainerName, err)
	}
	tarball, err := singleFileTar(buildkitConfigFile, []byte(cfg), rootlessUID)
	if err != nil {
		return err
	}
	if err := d.docker.putArchive(ctx, id, buildkitConfigDir, tarball); err != nil {
		_ = d.docker.removeContainer(context.WithoutCancel(ctx), id)
		return fmt.Errorf("configure %s: %w", ContainerName, err)
	}
	if err := d.docker.startContainer(ctx, id); err != nil {
		return fmt.Errorf("start %s: %w", ContainerName, err)
	}
	d.log.Info("started BuildKit daemon", "container", ContainerName, "image", d.image, "apparmor_profile", apparmor)
	d.gateway = gateway
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

// connect returns a BuildKit client for the running daemon, waiting for it
// to answer if it has just started.
func (d *daemon) connect(ctx context.Context, errOut io.Writer) (*bkclient.Client, error) {
	c, err := bkclient.New(ctx, "", bkclient.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
		return d.docker.execStdio(ctx, ContainerName, []string{"buildctl", "dial-stdio"}, errOut)
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
			logs := strings.TrimSpace(d.docker.containerLogs(context.WithoutCancel(ctx), ContainerName, 20))
			if userNamespaceDenied(logs) {
				profile := d.currentAppArmorProfile()
				d.forgetAppArmorProfile()
				hint := userNamespaceHint(profile)
				d.log.Error("BuildKit daemon cannot start: "+hint, "container", ContainerName)
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

// prune trims the BuildKit cache to the configured cap. BuildKit also
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
