package jobs

import (
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/runtime"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// admit checks a job_run against the agent's own rules and returns why it
// may not run ("" when it may). refusal, when set, refuses every run.
//
// SECURITY: this repeats the protocol's validation, as the runtime's admit
// does for service workloads (ADR 0014 H1, H2), so a gap there can't put a
// job on another environment's network, the host network or the agent's
// own, or run another service's build from the shared local registry. A job
// is no more privileged than its service (ADR 0010, "Security").
func admit(m *protocol.JobRun, refusal string) string {
	w := &m.Workload
	switch {
	case refusal != "":
		return refusal
	case w.Kind != protocol.WorkloadJob:
		return fmt.Sprintf("refusing workload of kind %q: job_run only runs job workloads", w.Kind)
	case w.ProjectID == nil || w.EnvironmentID == nil || w.ServiceID == nil || w.DeploymentID == nil:
		return "refusing job without project, environment, service and deployment"
	case !plainID(m.RunID) || !plainID(w.ID):
		// The run ID names the container and the workload ID a directory.
		return "refusing job: run_id and workload id must be plain ids"
	}
	network := protocol.EnvironmentNetworkName(*w.ProjectID, *w.EnvironmentID)
	switch {
	case w.Network != network || !protocol.ServiceNetworkAllowed(w.Network, *w.ProjectID, *w.EnvironmentID):
		return fmt.Sprintf("refusing network %q: jobs may only join %s", w.Network, network)
	case strings.HasPrefix(w.Image, protocol.RegistryListen+"/") && !runtime.IsOwnLocalImage(w.Image, *w.ProjectID, *w.ServiceID):
		return fmt.Sprintf("refusing image %q: local registry images must be %s@sha256:<digest>",
			w.Image, protocol.LocalImageRepository(*w.ProjectID, *w.ServiceID))
	case len(w.Ports) > 0 || len(w.Routes) > 0 || len(w.Mounts) > 0 || w.Healthcheck != nil:
		return "refusing job with ports, routes, volumes or a health check"
	case m.TimeoutS <= 0 || m.KillGraceS < 0:
		return "refusing job: timeout_s and kill_grace_s out of range"
	}
	return ""
}

// plainID reports whether id is a non-empty run of letters, digits, '_' and
// '-', safe in a container name and a path.
func plainID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '_' && c != '-' {
			return false
		}
	}
	return true
}

// containerCreate translates a job workload into the engine's create
// request, with the same hardening as service containers: on its
// environment network, without aliases, ports or an engine restart policy,
// and kept after it exits until the agent removes it. secretsBind, when
// set, mounts the run's secret files.
func containerCreate(w *protocol.WorkloadSpec, runID, namespace, secretsBind string) docker.ContainerCreate {
	env := make([]string, 0, len(w.Env))
	for _, k := range slices.Sorted(maps.Keys(w.Env)) {
		env = append(env, k+"="+w.Env[k])
	}
	hc := runtime.HardenedHostConfig(w.Network, w.Resources)
	if secretsBind != "" {
		hc.Binds = []string{secretsBind}
	}
	return docker.ContainerCreate{
		Image:      w.Image,
		Cmd:        w.Command,
		Entrypoint: w.Entrypoint,
		Env:        env,
		Labels:     containerLabels(w, runID, namespace),
		HostConfig: hc,
		NetworkingConfig: &docker.NetworkingConfig{EndpointsConfig: map[string]docker.EndpointSettings{
			w.Network: {},
		}},
	}
}

// containerLabels returns w's labels with the agent's own on top.
//
// SECURITY: user labels in the roundhouse. namespace are dropped, so a job
// can't claim roundhouse.managed=true (and be garbage-collected, or
// mistaken for a replica, by the reconciler) or spoof another run.
func containerLabels(w *protocol.WorkloadSpec, runID, namespace string) map[string]string {
	l := make(map[string]string, len(w.Labels)+10)
	for k, v := range w.Labels {
		if !strings.HasPrefix(k, "roundhouse.") {
			l[k] = v
		}
	}
	l[LabelJob] = "true"
	l[runtime.LabelKind] = string(protocol.WorkloadJob)
	l[LabelRunID] = runID
	l[runtime.LabelWorkloadID] = w.ID
	if namespace != "" {
		l[runtime.LabelNamespace] = namespace
	}
	for k, v := range map[string]*string{
		runtime.LabelProjectID:     w.ProjectID,
		runtime.LabelEnvironmentID: w.EnvironmentID,
		runtime.LabelServiceID:     w.ServiceID,
		runtime.LabelDeploymentID:  w.DeploymentID,
	} {
		if v != nil {
			l[k] = *v
		}
	}
	return l
}
