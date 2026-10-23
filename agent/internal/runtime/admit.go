package runtime

import (
	"errors"
	"fmt"
	"strings"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// admit checks a service workload against the runtime's own rules, which
// repeat the protocol's validation so a bug or a gap there can't place a
// workload where it doesn't belong, and returns why it may not run ("" when
// it may).
//
// SECURITY: these are the agent-side halves of ADR 0014 H1 and H2. The
// network is never rewritten, only refused (ADR 0003): a workload whose
// network isn't its own environment's, or its project's legacy network,
// could otherwise reach the Caddy admin API and the local registry on the
// host network, or another tenant's containers.
func admit(w *protocol.WorkloadSpec) string {
	if w.Kind != protocol.WorkloadService {
		return fmt.Sprintf("refusing workload of kind %q: only service workloads are accepted", w.Kind)
	}
	if w.ProjectID == nil || w.EnvironmentID == nil || w.ServiceID == nil || w.DeploymentID == nil {
		return "refusing workload without project, environment, service and deployment"
	}
	if !protocol.ServiceNetworkAllowed(w.Network, *w.ProjectID, *w.EnvironmentID) {
		return fmt.Sprintf("refusing network %q: service workloads may only join %s",
			w.Network, protocol.EnvironmentNetworkName(*w.ProjectID, *w.EnvironmentID))
	}
	if strings.HasPrefix(w.Image, protocol.RegistryListen+"/") && !isOwnLocalImage(w.Image, *w.ProjectID, *w.ServiceID) {
		return fmt.Sprintf("refusing image %q: local registry images must be %s@sha256:<digest>",
			w.Image, protocol.LocalImageRepository(*w.ProjectID, *w.ServiceID))
	}
	return ""
}

// isOwnLocalImage reports whether image is exactly the service's local
// repository pinned by digest, so one project can't run another's build
// from the shared registry.
func isOwnLocalImage(image, projectID, serviceID string) bool {
	digest, ok := strings.CutPrefix(image, protocol.LocalImageRepository(projectID, serviceID)+"@sha256:")
	if !ok || len(digest) != 64 {
		return false
	}
	for _, c := range digest {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// envFailure is the status message of a workload whose sealed environment
// can't be opened. A box for another key gets its own message: it means the
// node's key changed after it registered, which only a re-join fixes.
func envFailure(err error) string {
	if errors.Is(err, protocol.ErrBoxWrongKey) {
		return "cannot open the environment: it is sealed to an encryption key this node does not hold " +
			"(the node's key changed after it registered); re-join the node with `roundhouse-agent join --force`"
	}
	return "cannot open the environment: " + err.Error()
}
