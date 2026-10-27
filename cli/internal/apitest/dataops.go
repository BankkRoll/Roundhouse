package apitest

import (
	"net/http"
	"net/netip"
	"slices"
	"strings"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
)

// EstimatedDowntimeMS is the downtime the fake estimates for every volume
// migration.
const EstimatedDowntimeMS = 250_000

// opsState is the fake's volume migrations, TCP proxies and credential
// rotations.
type opsState struct {
	migrations []*api.VolumeMigration
	// ineligible maps a node ID to why no volume can move there.
	ineligible map[string]string
	proxies    map[string]*api.TCPProxy
	rotations  []*api.CredentialRotation
	nextPort   int

	onGetMigration func(m *api.VolumeMigration)
	onRotate       func(r *api.CredentialRotation)
}

func (f *Fake) opsState() *opsState {
	d := f.dataState()
	if d.ops == nil {
		d.ops = &opsState{ineligible: map[string]string{}, proxies: map[string]*api.TCPProxy{}, nextPort: 20001}
	}
	return d.ops
}

// -----------------------------------------------------------------------------
// Test controls
// -----------------------------------------------------------------------------

// SetNodeIneligible makes a server refuse volume migrations with reason;
// an empty reason makes it eligible again.
func (f *Fake) SetNodeIneligible(nodeID, reason string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if reason == "" {
		delete(f.opsState().ineligible, nodeID)
		return
	}
	f.opsState().ineligible[nodeID] = reason
}

// OnGetVolumeMigration runs h on every GET of a volume migration, under
// the lock, so tests can advance it between polls.
func (f *Fake) OnGetVolumeMigration(h func(m *api.VolumeMigration)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.opsState().onGetMigration = h
}

// VolumeMigrations returns the started volume migrations, oldest first.
func (f *Fake) VolumeMigrations() []api.VolumeMigration {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []api.VolumeMigration
	for _, m := range f.opsState().migrations {
		out = append(out, *m)
	}
	return out
}

// TCPProxy returns a service's TCP proxy in an environment, or nil.
func (f *Fake) TCPProxy(serviceID, envID string) *api.TCPProxy {
	f.mu.Lock()
	defer f.mu.Unlock()
	if p := f.opsState().proxies[serviceID+"/"+envID]; p != nil {
		c := *p
		return &c
	}
	return nil
}

// OnRotateCredentials runs h on the rotation a rotate-credentials call is
// about to return, under the lock, so tests can make it fail or stall.
func (f *Fake) OnRotateCredentials(h func(r *api.CredentialRotation)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.opsState().onRotate = h
}

// CredentialRotations returns the stored rotations, oldest first.
func (f *Fake) CredentialRotations() []api.CredentialRotation {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []api.CredentialRotation
	for _, r := range f.opsState().rotations {
		out = append(out, *r)
	}
	return out
}

// -----------------------------------------------------------------------------
// Routing
// -----------------------------------------------------------------------------

// opsRoutes adds the volume migration, TCP proxy and credential rotation
// routes.
func (f *Fake) opsRoutes(handlers map[api.Route]guarded) {
	for r, g := range map[api.Route]guarded{
		api.RouteMigrationTargets:    {"services:read", f.migrationTargets},
		api.RouteMigrateVolume:       {"services:manage", f.migrateVolume},
		api.RouteVolumeMigrations:    {"services:read", f.listVolumeMigrations},
		api.RouteGetVolumeMigration:  {"services:read", f.getVolumeMigration},
		api.RouteGetTCPProxy:         {"services:read", f.getTCPProxy},
		api.RoutePutTCPProxy:         {"services:manage", f.putTCPProxy},
		api.RouteDeleteTCPProxy:      {"services:manage", f.deleteTCPProxy},
		api.RouteRotateCredentials:   {"data:write", f.rotateCredentials},
		api.RouteCredentialRotations: {"services:read", f.listCredentialRotations},
	} {
		handlers[r] = g
	}
}

// migrationServiceOf returns the service a volume migration belongs to, or
// "". Must hold f.mu.
func (f *Fake) migrationServiceOf(id string) string {
	for _, m := range f.opsState().migrations {
		if m.ID == id {
			return m.ServiceID
		}
	}
	return ""
}

// -----------------------------------------------------------------------------
// Volume migration
// -----------------------------------------------------------------------------

// targetsOf lists every server but the volume's own; offline servers and
// those marked with SetNodeIneligible are ineligible. Must hold f.mu.
func (f *Fake) targetsOf(v *api.Volume) []api.MigrationTarget {
	out := []api.MigrationTarget{}
	for _, n := range f.nodes {
		if v.NodeID != nil && n.ID == *v.NodeID {
			continue
		}
		t := api.MigrationTarget{NodeID: n.ID, Name: n.Name, Eligible: true, QuotaMode: str("xfs_project")}
		reason := f.opsState().ineligible[n.ID]
		if reason == "" && n.Status != "online" {
			reason = "the server is " + n.Status
		}
		if reason != "" {
			t.Eligible, t.Reason, t.QuotaMode = false, str(reason), nil
		}
		out = append(out, t)
	}
	return out
}

func (f *Fake) migrationTargets(w http.ResponseWriter, r *http.Request) {
	v := f.findVolume(w, r.PathValue("volumeId"))
	if v == nil {
		return
	}
	writeJSON(w, http.StatusOK, api.MigrationTargets{VolumeID: v.ID, SourceNodeID: v.NodeID,
		EstimatedDowntimeMS: EstimatedDowntimeMS, Targets: f.targetsOf(v)})
}

func (f *Fake) migrateVolume(w http.ResponseWriter, r *http.Request) {
	v := f.findVolume(w, r.PathValue("volumeId"))
	if v == nil || !f.freshSession(w, r) {
		return
	}
	var in api.MigrateVolumeInput
	if decode(r, &in) != nil || in.TargetNodeID == "" {
		apiError(w, http.StatusBadRequest, "invalid_request", "target_node_id: Required")
		return
	}
	_, s := f.serviceOf(v.ServiceID)
	if s == nil || in.Confirm != s.Slug {
		apiError(w, http.StatusBadRequest, "invalid_request", "confirm must equal the service's slug")
		return
	}
	if !f.storageConfigured(w) {
		return
	}
	if v.Status != api.VolumeReady || v.NodeID == nil {
		apiError(w, http.StatusConflict, "conflict", "The volume is "+strings.ReplaceAll(v.Status, "_", " ")+"; only a ready volume moves")
		return
	}
	i := slices.IndexFunc(f.nodes, func(n api.Node) bool { return n.ID == in.TargetNodeID })
	if i < 0 {
		apiError(w, http.StatusNotFound, "not_found", "Node not found")
		return
	}
	target := f.nodes[i]
	if target.ID == *v.NodeID {
		apiError(w, http.StatusUnprocessableEntity, "migration_target_ineligible", target.Name+": the volume is already there")
		return
	}
	for _, t := range f.targetsOf(v) {
		if t.NodeID == target.ID && !t.Eligible {
			apiError(w, http.StatusUnprocessableEntity, "migration_target_ineligible", target.Name+": "+*t.Reason)
			return
		}
	}
	o := f.opsState()
	for _, m := range o.migrations {
		if m.VolumeID == v.ID && (m.Status == api.MigrationQueued || m.Status == api.MigrationRunning) {
			apiError(w, http.StatusConflict, "conflict", "This volume is already moving")
			return
		}
	}
	m := &api.VolumeMigration{ID: f.nextID("vmg"), VolumeID: v.ID, ServiceID: v.ServiceID, EnvironmentID: v.EnvironmentID,
		SourceNodeID: v.NodeID, TargetNodeID: &target.ID, Status: api.MigrationQueued, Phase: "queued",
		RequestedBy: str(f.user.ID), CreatedAt: Now}
	o.migrations = append(o.migrations, m)
	v.Status, v.UpdatedAt = "migrating", Now
	writeJSON(w, http.StatusAccepted, m)
}

func (f *Fake) listVolumeMigrations(w http.ResponseWriter, r *http.Request) {
	v := f.findVolume(w, r.PathValue("volumeId"))
	if v == nil {
		return
	}
	out := api.VolumeMigrationList{Migrations: []api.VolumeMigration{}}
	ms := f.opsState().migrations
	for i := len(ms) - 1; i >= 0; i-- {
		if ms[i].VolumeID == v.ID {
			out.Migrations = append(out.Migrations, *ms[i])
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (f *Fake) getVolumeMigration(w http.ResponseWriter, r *http.Request) {
	o := f.opsState()
	i := slices.IndexFunc(o.migrations, func(m *api.VolumeMigration) bool { return m.ID == r.PathValue("migrationId") })
	if i < 0 {
		apiError(w, http.StatusNotFound, "not_found", "Volume migration not found")
		return
	}
	m := o.migrations[i]
	if o.onGetMigration != nil {
		o.onGetMigration(m)
	}
	if m.Status == api.MigrationSucceeded || m.Status == api.MigrationFailed {
		for _, v := range f.dataState().volumes {
			if v.ID != m.VolumeID || v.Status != "migrating" {
				continue
			}
			v.Status = api.VolumeReady
			if m.Status == api.MigrationSucceeded && m.TargetNodeID != nil {
				v.NodeID = m.TargetNodeID
				if j := slices.IndexFunc(f.nodes, func(n api.Node) bool { return n.ID == *m.TargetNodeID }); j >= 0 {
					v.NodeName = str(f.nodes[j].Name)
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, m)
}

// -----------------------------------------------------------------------------
// TCP proxy
// -----------------------------------------------------------------------------

func (f *Fake) getTCPProxy(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	env, ok := environment(w, r, p, true)
	if !ok {
		return
	}
	proxy := f.opsState().proxies[s.ID+"/"+env]
	if proxy == nil {
		apiError(w, http.StatusNotFound, "not_found", "TCP proxy not found")
		return
	}
	writeJSON(w, http.StatusOK, proxy)
}

// normalizeAllowlist mirrors normalizeAllowlist in apps/api/src/lib/tcp-proxies.ts.
func normalizeAllowlist(w http.ResponseWriter, in []string, acknowledgeOpen bool) ([]string, bool) {
	out := []string{}
	for _, raw := range in {
		entry := strings.TrimSpace(raw)
		if a, err := netip.ParseAddr(entry); err == nil {
			entry = a.String() + "/" + map[bool]string{true: "32", false: "128"}[a.Is4()]
		}
		prefix, err := netip.ParsePrefix(entry)
		if err != nil {
			apiError(w, http.StatusUnprocessableEntity, "invalid_request", "Not an IP address or CIDR block: "+raw)
			return nil, false
		}
		if prefix.Addr().Is4In6() && prefix.Bits() >= 96 {
			apiError(w, http.StatusUnprocessableEntity, "invalid_request", raw+": an IPv4-mapped block admits no one; list the IPv4 block instead")
			return nil, false
		}
		if n := prefix.Masked().String(); !slices.Contains(out, n) {
			out = append(out, n)
		}
	}
	if len(out) == 0 || len(out) > api.MaxTCPProxyCIDRs {
		apiError(w, http.StatusBadRequest, "invalid_request", "allowed_cidrs: between 1 and 64 sources")
		return nil, false
	}
	if slices.ContainsFunc(out, isOpenCIDR) && !acknowledgeOpen {
		apiError(w, http.StatusUnprocessableEntity, "confirmation_required",
			"0.0.0.0/0 opens the port to the whole internet, unencrypted unless the client and the database negotiate TLS; send acknowledge_open to continue")
		return nil, false
	}
	return out, true
}

func isOpenCIDR(cidr string) bool { return strings.HasSuffix(cidr, "/0") }

func (f *Fake) putTCPProxy(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil || !f.freshSession(w, r) {
		return
	}
	var in api.PutTCPProxyInput
	if decode(r, &in) != nil {
		apiError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}
	if !slices.ContainsFunc(p.Environments, func(e api.Environment) bool { return e.ID == in.EnvironmentID }) {
		apiError(w, http.StatusNotFound, "not_found", "Environment not found")
		return
	}
	allowed, ok := normalizeAllowlist(w, in.AllowedCIDRs, in.AcknowledgeOpen)
	if !ok {
		return
	}
	port := in.ContainerPort
	if port == 0 {
		if c := f.configs[s.ID+"/"+in.EnvironmentID]; c != nil && c.Networking.Port != nil {
			port = *c.Networking.Port
		} else if s.Database != nil {
			port = engineSpecs[s.Database.Engine].port
		}
	}
	if port < 1 || port > 65535 {
		apiError(w, http.StatusUnprocessableEntity, "invalid_request", "container_port: the service has no port; pass one")
		return
	}
	o := f.opsState()
	key := s.ID + "/" + in.EnvironmentID
	proxy := o.proxies[key]
	if proxy == nil {
		proxy = &api.TCPProxy{ID: f.nextID("tcp"), ServiceID: s.ID, EnvironmentID: in.EnvironmentID, PublicPort: o.nextPort,
			Status: api.TCPProxyPending, CreatedAt: Now}
		o.nextPort++
		o.proxies[key] = proxy
	}
	proxy.ContainerPort, proxy.AllowedCIDRs, proxy.UpdatedAt = port, allowed, Now
	proxy.OpenToAll = slices.ContainsFunc(allowed, isOpenCIDR)
	if v := f.volumeOf(s.ID, in.EnvironmentID); v != nil && v.NodeID != nil {
		proxy.NodeID, proxy.Status = v.NodeID, api.TCPProxyActive
		if i := slices.IndexFunc(f.nodes, func(n api.Node) bool { return n.ID == *v.NodeID }); i >= 0 {
			proxy.Host = f.nodes[i].PublicIP
		}
	}
	writeJSON(w, http.StatusOK, proxy)
}

func (f *Fake) deleteTCPProxy(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	env, ok := environment(w, r, p, true)
	if !ok {
		return
	}
	o := f.opsState()
	if o.proxies[s.ID+"/"+env] == nil {
		apiError(w, http.StatusNotFound, "not_found", "TCP proxy not found")
		return
	}
	delete(o.proxies, s.ID+"/"+env)
	w.WriteHeader(http.StatusNoContent)
}

// -----------------------------------------------------------------------------
// Credential rotation
// -----------------------------------------------------------------------------

// principalsOf lists the principals an engine has: MySQL's application user
// is the only "app" principal.
func principalsOf(engine string) []string {
	if engine == "mysql" {
		return []string{"admin", "app", "readonly"}
	}
	return []string{"admin", "readonly"}
}

func (f *Fake) rotateCredentials(w http.ResponseWriter, r *http.Request) {
	p, s := f.databaseService(w, r.PathValue("serviceId"))
	if s == nil || !f.freshSession(w, r) {
		return
	}
	var in api.RotateCredentialsInput
	if decode(r, &in) != nil {
		apiError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}
	if !slices.ContainsFunc(p.Environments, func(e api.Environment) bool { return e.ID == in.EnvironmentID }) {
		apiError(w, http.StatusNotFound, "not_found", "Environment not found")
		return
	}
	if in.Confirm != s.Slug {
		apiError(w, http.StatusBadRequest, "invalid_request", "confirm must equal the service's slug")
		return
	}
	has := principalsOf(s.Database.Engine)
	principals := in.Principals
	if len(principals) == 0 {
		principals = has
	}
	for _, pr := range principals {
		if !slices.Contains(has, pr) {
			apiError(w, http.StatusUnprocessableEntity, "invalid_request", engineSpecs[s.Database.Engine].name+" has no "+pr+" principal")
			return
		}
	}
	if v := f.volumeOf(s.ID, in.EnvironmentID); v == nil || v.NodeID == nil {
		apiError(w, http.StatusConflict, "conflict", "The database has no running replica in this environment")
		return
	}
	o := f.opsState()
	var rot *api.CredentialRotation
	for _, x := range o.rotations {
		if x.ServiceID == s.ID && x.EnvironmentID == in.EnvironmentID && x.Status == api.RotationRunning {
			rot = x
		}
	}
	if rot == nil {
		rot = &api.CredentialRotation{ID: f.nextID("rot"), ServiceID: s.ID, EnvironmentID: in.EnvironmentID,
			Principals: slices.Clone(principals), Applied: []string{}, DeploymentIDs: []string{}, RequestedBy: str(f.user.ID), CreatedAt: Now}
		o.rotations = append(o.rotations, rot)
	}
	rot.Status, rot.Applied, rot.ChangeSetID, rot.FinishedAt = api.RotationSucceeded, slices.Clone(rot.Principals), str(f.nextID("chs")), i64(Now)
	rot.DeploymentIDs = []string{}
	for _, svcID := range []string{s.ID, APIServiceID} {
		d := f.deployment(f.nextID("dep"), "queued", Now, nil)
		d.ProjectID, d.ServiceID, d.EnvironmentID = p.ID, svcID, in.EnvironmentID
		f.deployments = append(f.deployments, d)
		rot.DeploymentIDs = append(rot.DeploymentIDs, d.ID)
	}
	if o.onRotate != nil {
		o.onRotate(rot)
	}
	writeJSON(w, http.StatusOK, rot)
}

func (f *Fake) listCredentialRotations(w http.ResponseWriter, r *http.Request) {
	p, s := f.databaseService(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	env, ok := environment(w, r, p, true)
	if !ok {
		return
	}
	out := api.CredentialRotationList{Rotations: []api.CredentialRotation{}}
	rs := f.opsState().rotations
	for i := len(rs) - 1; i >= 0; i-- {
		if rs[i].ServiceID == s.ID && rs[i].EnvironmentID == env {
			out.Rotations = append(out.Rotations, *rs[i])
		}
	}
	writeJSON(w, http.StatusOK, out)
}
