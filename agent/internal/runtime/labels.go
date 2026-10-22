package runtime

import (
	"encoding/json"
	"strconv"

	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
)

// Labels the agent puts on every container it manages. Everything needed to
// route, drain and report a container is recoverable from them, so an agent
// restart in the middle of a rollout loses nothing.
const (
	LabelManaged       = "openrail.managed"
	LabelWorkloadID    = "openrail.workload_id"
	LabelKind          = "openrail.kind"
	LabelDeploymentID  = "openrail.deployment_id"
	LabelServiceID     = "openrail.service_id"
	LabelProjectID     = "openrail.project_id"
	LabelEnvironmentID = "openrail.environment_id"
	LabelSpecHash      = "openrail.spec_hash"
	LabelGeneration    = "openrail.generation"
	LabelNetwork       = "openrail.network"
	LabelRoutes        = "openrail.routes"
	LabelDrainS        = "openrail.drain_s"
	LabelNamespace     = "openrail.namespace"
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
	_ = json.Unmarshal([]byte(l[LabelRoutes]), &m.routes)
	return m
}
