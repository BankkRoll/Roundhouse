package runtime

import (
	"fmt"
	"strings"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// SystemWorkloadPrefix starts the ID of every system workload the agent
// runs (the registry, and any later infrastructure).
const SystemWorkloadPrefix = "sys_"

// ShellContainer returns the container a web shell (ADR 0012) may exec into
// for workloadID: the current container of a service workload of the
// desired state, running and not held. Anything else fails with a message
// fit for the person who opened the shell.
//
// SECURITY: system workloads, route-only and job workloads, containers being
// replaced by a newer spec, and workloads a backup or restore holds stopped
// are never shell targets (ADR 0014 §15). The caller still re-checks the
// container's labels against the engine before it execs.
func (r *Runtime) ShellContainer(workloadID string) (string, error) {
	if strings.HasPrefix(workloadID, SystemWorkloadPrefix) {
		return "", fmt.Errorf("workload %s is a system workload", workloadID)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.desired == nil {
		return "", fmt.Errorf("workload %s is not running on this node", workloadID)
	}
	for i := range r.desired.Workloads {
		w := &r.desired.Workloads[i]
		if w.ID != workloadID {
			continue
		}
		if w.Kind != protocol.WorkloadService {
			return "", fmt.Errorf("workload %s is not a service workload", workloadID)
		}
		cur := r.current(&wantSpec{WorkloadSpec: *w})
		if cur == nil {
			return "", fmt.Errorf("workload %s has no container yet", workloadID)
		}
		if why := r.heldReason(w.ID, cur.meta.volumes); why != "" {
			return "", fmt.Errorf("workload %s is stopped: %s", workloadID, why)
		}
		if !cur.running || cur.busy {
			return "", fmt.Errorf("workload %s is not running", workloadID)
		}
		return cur.id, nil
	}
	return "", fmt.Errorf("workload %s is not running on this node", workloadID)
}
