package runtime

import (
	"fmt"
	"slices"
	"strings"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// routeKey is what one Caddy route matches: a hostname and a path prefix,
// "/" standing for the whole host.
type routeKey struct{ host, prefix string }

func keyOf(host, prefix string) routeKey {
	if prefix == "" {
		prefix = "/"
	}
	return routeKey{host, prefix}
}

// markRouteConflicts finds routes that workloads of more than one project
// claim, notes the conflict on each workload claiming one, logs each new
// conflict once, and returns the conflicting keys, which the ingress
// config leaves out entirely (ADR 0014 M3). Caller holds r.mu.
//
// SECURITY: serving such a route would mix two tenants' replicas behind one
// URL, or let one project take over another's traffic. The control plane's
// unique hostnames should make this unreachable; the agent doesn't rely on
// it.
func (r *Runtime) markRouteConflicts(specs []*wantSpec) map[routeKey]bool {
	projects := map[routeKey][]string{}
	for _, s := range specs {
		if s.ProjectID == nil || s.blocked != "" {
			continue
		}
		for _, rt := range s.Routes {
			k := keyOf(rt.Hostname, rt.PathPrefix)
			if !slices.Contains(projects[k], *s.ProjectID) {
				projects[k] = append(projects[k], *s.ProjectID)
			}
		}
	}
	conflicts := map[routeKey]bool{}
	for k, ps := range projects {
		if len(ps) > 1 {
			conflicts[k] = true
		}
	}
	for _, s := range specs {
		for _, rt := range s.Routes {
			k := keyOf(rt.Hostname, rt.PathPrefix)
			if conflicts[k] && s.blocked == "" {
				s.note = appendNote(s.note, fmt.Sprintf("route %s%s is not served: another project claims it on this node", k.host, k.prefix))
			}
		}
	}
	for k := range conflicts {
		if r.conflictsLogged[k] {
			continue
		}
		ps := slices.Sorted(slices.Values(projects[k]))
		r.log.Error("conflicting routes; serving none of them", "host", k.host, "path_prefix", k.prefix,
			"projects", strings.Join(ps, ","))
		// NOTE: tenants' logs never name the other project.
		msg := fmt.Sprintf("Route %s%s is not served: another project claims it on this node", k.host, k.prefix)
		if r.opts.SystemLog != nil {
			for _, s := range specs {
				if s.DeploymentID != nil && slices.ContainsFunc(s.Routes, func(rt protocol.WorkloadRoute) bool {
					return keyOf(rt.Hostname, rt.PathPrefix) == k
				}) {
					r.opts.SystemLog(s.ID, *s.DeploymentID, msg)
				}
			}
		}
	}
	r.conflictsLogged = conflicts
	return conflicts
}
