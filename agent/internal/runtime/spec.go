package runtime

import (
	"maps"
	"slices"
	"strconv"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// DefaultCapAdd are the capabilities added back after dropping all of them.
//
// They are the ones ordinary images need to start as root and then step down
// to an unprivileged user (SETUID, SETGID), fix ownership of their data
// directories (CHOWN, FOWNER, DAC_OVERRIDE), bind ports below 1024
// (NET_BIND_SERVICE) and signal their own children (KILL). Docker's default
// set also grants NET_RAW (raw sockets, ARP/DNS spoofing on the bridge),
// MKNOD, AUDIT_WRITE, SETFCAP, SETPCAP, FSETID and SYS_CHROOT, which a web
// service has no business using.
var DefaultCapAdd = []string{"CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "NET_BIND_SERVICE", "SETGID", "SETUID"}

// Container log rotation: at most 3 × 10 MB of json-file logs per container.
const (
	logMaxSize  = "10m"
	logMaxFiles = "3"
)

// stopGrace is how long a container gets between SIGTERM and SIGKILL.
const stopGrace = 10

// wantSpec is a workload the node should run: a service workload from the
// desired state, or a system workload the agent derived itself.
type wantSpec struct {
	protocol.WorkloadSpec
	// generation is the desired-state generation the spec arrived in.
	generation int64
	// hostPorts publishes ports on the host; system workloads only.
	hostPorts map[string][]docker.PortBinding
	// binds are host bind mounts; system workloads only.
	binds []string
	// exclusive means old and new containers cannot run side by side (they
	// would fight over a host port), so the old one is removed before the
	// new one is created.
	exclusive bool
}

// containerName is unique per workload and spec, so a replacement can be
// created while the container it replaces still runs.
func containerName(s *wantSpec) string {
	return "roundhouse-" + s.ID + "-" + s.SpecHash[:12]
}

// containerCreate translates a spec into the engine's create request, with
// the agent's hardening applied.
func containerCreate(s *wantSpec) docker.ContainerCreate {
	env := make([]string, 0, len(s.Env))
	for _, k := range slices.Sorted(maps.Keys(s.Env)) {
		env = append(env, k+"="+s.Env[k])
	}
	var exposed map[string]struct{}
	if len(s.Ports) > 0 {
		exposed = make(map[string]struct{}, len(s.Ports))
		for _, p := range s.Ports {
			exposed[strconv.Itoa(p.ContainerPort)+"/tcp"] = struct{}{}
		}
	}
	mem := int64(s.Resources.MemoryMB) << 20
	pids := int64(s.Resources.PIDs)
	grace := stopGrace
	return docker.ContainerCreate{
		Image:        s.Image,
		Cmd:          s.Command,
		Entrypoint:   s.Entrypoint,
		Env:          env,
		Labels:       containerLabels(s),
		ExposedPorts: exposed,
		StopTimeout:  &grace,
		HostConfig: docker.HostConfig{
			NetworkMode:  s.Network,
			PortBindings: s.hostPorts,
			// NOTE: the agent restarts containers itself so it sees every
			// crash, reports it and applies its own backoff.
			RestartPolicy: docker.RestartPolicy{Name: "no"},
			Binds:         s.binds,
			SecurityOpt:   []string{"no-new-privileges:true"},
			CapDrop:       []string{"ALL"},
			CapAdd:        DefaultCapAdd,
			LogConfig: docker.LogConfig{Type: "json-file", Config: map[string]string{
				"max-size": logMaxSize,
				"max-file": logMaxFiles,
			}},
			Memory:     mem,
			MemorySwap: mem,
			NanoCPUs:   int64(s.Resources.CPUMillis) * 1_000_000,
			PidsLimit:  &pids,
		},
		NetworkingConfig: &docker.NetworkingConfig{EndpointsConfig: map[string]docker.EndpointSettings{
			s.Network: {Aliases: networkAliases(s)},
		}},
	}
}

// pullAuth returns the credential to pull s.Image with, or nil.
//
// SECURITY: the engine sends X-Registry-Auth to whichever registry the image
// names, so a credential for one registry is never attached to a pull from
// another.
func pullAuth(s *wantSpec) (*docker.AuthConfig, bool) {
	a := s.RegistryAuth
	if a == nil {
		return nil, true
	}
	if !docker.SameRegistry(docker.ParseReference(s.Image).Domain, a.Server) {
		return nil, false
	}
	return &docker.AuthConfig{Username: a.Username, Password: a.Password, ServerAddress: a.Server}, true
}

// LabelPrivateDomain carries a service replica's private hostname,
// "<service>.<environment>.internal", which the agent registers as a network
// alias so other containers of the same environment resolve it.
const LabelPrivateDomain = "roundhouse.private_domain"

// networkAliases returns the DNS aliases s answers to on its network.
//
// Aliases live on the replica's environment network only, so Docker's
// embedded DNS answers them only to containers of that environment: a
// staging container asking for "api.production.internal" gets NXDOMAIN, and
// has no route to production's addresses either.
func networkAliases(s *wantSpec) []string {
	d := s.Labels[LabelPrivateDomain]
	if s.Kind != protocol.WorkloadService || !protocol.IsHostname(d) {
		return nil
	}
	return []string{d}
}
