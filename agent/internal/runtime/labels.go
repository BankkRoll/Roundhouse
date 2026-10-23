package runtime

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// Labels the agent puts on every container it manages. Everything needed to
// route, drain and report a container is recoverable from them, so an agent
// restart in the middle of a rollout loses nothing.
const (
	LabelManaged       = "roundhouse.managed"
	LabelWorkloadID    = "roundhouse.workload_id"
	LabelKind          = "roundhouse.kind"
	LabelDeploymentID  = "roundhouse.deployment_id"
	LabelServiceID     = "roundhouse.service_id"
	LabelProjectID     = "roundhouse.project_id"
	LabelEnvironmentID = "roundhouse.environment_id"
	LabelSpecHash      = "roundhouse.spec_hash"
	LabelGeneration    = "roundhouse.generation"
	LabelNetwork       = "roundhouse.network"
	LabelRoutes        = "roundhouse.routes"
	LabelDrainS        = "roundhouse.drain_s"
	LabelNamespace     = "roundhouse.namespace"
	// LabelVolumes lists the volume IDs a container mounts, comma-separated.
	LabelVolumes = "roundhouse.volumes"
	// LabelStopGrace is the container's SIGTERM → SIGKILL grace in seconds.
	LabelStopGrace = "roundhouse.stop_grace_s"
)

// ManagedFilter selects the agent's containers and networks.
const ManagedFilter = LabelManaged + "=true"

// meta is what the labels of a managed container say about it.
type meta struct {
	workloadID    string
	kind          protocol.WorkloadKind
	deploymentID  string
	serviceID     string
	projectID     string
	environmentID string
	specHash      string
	generation    int64
	network       string
	routes        []protocol.WorkloadRoute
	drainS        int
	volumes       []string
	// stopGraceS is -1 for containers created before the label existed.
	stopGraceS int
}

// containerLabels returns spec's labels with the agent's own on top, so a
// user label can never spoof ownership or the spec hash.
func containerLabels(s *wantSpec) map[string]string {
	l := make(map[string]string, len(s.Labels)+12)
	for k, v := range s.Labels {
		l[k] = v
	}
	routes, _ := json.Marshal(s.Routes)
	l[LabelManaged] = "true"
	l[LabelWorkloadID] = s.ID
	l[LabelKind] = string(s.Kind)
	l[LabelSpecHash] = s.SpecHash
	l[LabelGeneration] = strconv.FormatInt(s.generation, 10)
	l[LabelNetwork] = s.Network
	l[LabelRoutes] = string(routes)
	l[LabelDrainS] = strconv.Itoa(s.DrainS)
	l[LabelStopGrace] = strconv.Itoa(s.StopGrace())
	if ids := mountedVolumes(&s.WorkloadSpec); len(ids) > 0 {
		l[LabelVolumes] = strings.Join(ids, ",")
	} else {
		delete(l, LabelVolumes)
	}
	for k, v := range map[string]*string{
		LabelDeploymentID:  s.DeploymentID,
		LabelServiceID:     s.ServiceID,
		LabelProjectID:     s.ProjectID,
		LabelEnvironmentID: s.EnvironmentID,
	} {
		if v != nil {
			l[k] = *v
		} else {
			delete(l, k)
		}
	}
	return l
}

// parseMeta reads a container's labels. Malformed optional labels decode to
// zero values rather than failing: the container is still ours to manage.
func parseMeta(l map[string]string) meta {
	m := meta{
		workloadID:    l[LabelWorkloadID],
		kind:          protocol.WorkloadKind(l[LabelKind]),
		deploymentID:  l[LabelDeploymentID],
		serviceID:     l[LabelServiceID],
		projectID:     l[LabelProjectID],
		environmentID: l[LabelEnvironmentID],
		specHash:      l[LabelSpecHash],
		network:       l[LabelNetwork],
	}
	m.generation, _ = strconv.ParseInt(l[LabelGeneration], 10, 64)
	m.drainS, _ = strconv.Atoi(l[LabelDrainS])
	m.stopGraceS = -1
	if g, err := strconv.Atoi(l[LabelStopGrace]); err == nil && g >= 0 {
		m.stopGraceS = g
	}
	if v := l[LabelVolumes]; v != "" {
		m.volumes = strings.Split(v, ",")
	}
	_ = json.Unmarshal([]byte(l[LabelRoutes]), &m.routes)
	return m
}

// mountedVolumes returns the IDs of the volumes w mounts.
func mountedVolumes(w *protocol.WorkloadSpec) []string {
	ids := make([]string, 0, len(w.Mounts))
	for _, m := range w.Mounts {
		ids = append(ids, m.VolumeID)
	}
	return ids
}

// stopGrace is how long to give the container between SIGTERM and SIGKILL.
func (m meta) stopGrace() time.Duration {
	if m.stopGraceS < 0 {
		return defaultStopGrace * time.Second
	}
	return time.Duration(m.stopGraceS) * time.Second
}
