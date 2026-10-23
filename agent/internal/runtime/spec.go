package runtime

import (
	"fmt"
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

// defaultStopGrace is the SIGTERM → SIGKILL grace, in seconds, of containers
// whose labels predate [LabelStopGrace].
const defaultStopGrace = 10

// wantSpec is a workload the node should run: a service workload from the
// desired state, or a system workload the agent derived itself.
type wantSpec struct {
	protocol.WorkloadSpec
	// generation is the desired-state generation the spec arrived in.
	generation int64
	// hostPorts publishes ports on the host: a system workload's own, or a
	// service workload's ports[].publish.
	hostPorts map[string][]docker.PortBinding
	// binds are host bind mounts; system workloads only.
	binds []string
	// mounts are the bind mounts of the workload's volumes, resolved just
	// before the container is created.
	mounts []docker.Mount
	// stopFirst means no container of the same service and environment may
	// run while this one is created: rollout stop_first, or a volume.
	stopFirst bool
	// exclusive means old and new containers cannot run side by side (they
	// would fight over a host port), so the old one is removed before the
	// new one is created.
	exclusive bool
	// blocked is why the workload may not start, "" when it may; see
	// [Runtime.Apply].
	blocked string
	// note explains, in the status message, something refused about a
	// running workload: a route or alias another project or service also
	// claims.
	note string
	// labelAlias grants the label's private domain as a network alias; see
	// [assignLabelAliases].
	labelAlias bool
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
	grace := s.StopGrace()
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
			Mounts:        s.mounts,
			// SECURITY: no seccomp or apparmor option, so the engine applies its
			// default seccomp profile and docker-default AppArmor profile wherever
			// the host supports them; workloads are never unconfined (ADR 0014 H4).
			SecurityOpt: []string{"no-new-privileges:true"},
			CapDrop:     []string{"ALL"},
			CapAdd:      DefaultCapAdd,
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

// networkAliases returns the DNS aliases s answers to on its network: the
// alias derived from its service ID and, when [assignLabelAliases] granted
// it, the private domain of its label.
//
// Aliases live on the replica's environment network only, so Docker's
// embedded DNS answers them only to containers of that environment: a
// staging container asking for "api.production.internal" gets NXDOMAIN, and
// has no route to production's addresses either.
func networkAliases(s *wantSpec) []string {
	if s.Kind != protocol.WorkloadService || s.ServiceID == nil {
		return nil
	}
	aliases := []string{protocol.PrivateServiceAlias(*s.ServiceID)}
	if s.labelAlias {
		aliases = append(aliases, s.Labels[LabelPrivateDomain])
	}
	return aliases
}

// assignLabelAliases decides which service workloads get their label's
// private domain as an alias (ADR 0014 M4). The label is free-form, so one
// service could name another's domain and take its traffic: a label alias
// is granted only when it passes [protocol.IsPrivateDomain] and no other
// service on the same network claims it. Of several, the service of the
// lowest workload ID keeps it; all replicas of that service share it.
func assignLabelAliases(specs []*wantSpec) {
	type claim struct{ network, alias string }
	owner := map[claim]*wantSpec{}
	contested := map[claim]bool{}
	for _, s := range specs {
		d := s.Labels[LabelPrivateDomain]
		if s.Kind != protocol.WorkloadService || s.ServiceID == nil || s.blocked != "" || !protocol.IsPrivateDomain(d) {
			continue
		}
		c := claim{s.Network, d}
		cur := owner[c]
		switch {
		case cur == nil:
			owner[c] = s
		case *cur.ServiceID != *s.ServiceID:
			contested[c] = true
			if s.ID < cur.ID {
				owner[c] = s
			}
		case s.ID < cur.ID:
			owner[c] = s
		}
	}
	for _, s := range specs {
		d := s.Labels[LabelPrivateDomain]
		if s.Kind != protocol.WorkloadService || s.ServiceID == nil || s.blocked != "" || !protocol.IsPrivateDomain(d) {
			continue
		}
		c := claim{s.Network, d}
		s.labelAlias = *owner[c].ServiceID == *s.ServiceID
		if contested[c] && !s.labelAlias {
			s.note = appendNote(s.note, fmt.Sprintf("private domain %s is claimed by another service on this network; "+
				"this service answers only at %s", d, protocol.PrivateServiceAlias(*s.ServiceID)))
		}
	}
}

// appendNote joins status notes with "; ".
func appendNote(note, more string) string {
	if note == "" {
		return more
	}
	return note + "; " + more
}
