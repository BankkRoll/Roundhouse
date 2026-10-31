package apitest

import (
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
)

// AbandonedCopyGraceMS is how long after a recovery the fake lets an
// abandoned copy be deleted, as VOLUME_DELETE_GRACE_MS.
const AbandonedCopyGraceMS = 72 * 3600 * 1000

// recoveryState is the fake's point-in-time recovery, automatic recovery
// policies and abandoned copies, keyed by service and environment.
type recoveryState struct {
	// windows are each service's restorable ranges; see [Fake.SetPitrWindows].
	windows map[string][]api.PitrRange
	streams map[string]*api.PitrStream
	// unavailable overrides why PITR cannot be turned on.
	unavailable map[string]string
	policies    map[string]*api.RecoveryPolicy
	copies      map[string][]api.AbandonedCopy

	// onGetStatus runs on every GET of PITR status, under the lock.
	onGetStatus func(st *api.PitrStatus)
}

func (f *Fake) recoveryState() *recoveryState {
	d := f.dataState()
	if d.recovery == nil {
		d.recovery = &recoveryState{windows: map[string][]api.PitrRange{}, streams: map[string]*api.PitrStream{},
			unavailable: map[string]string{}, policies: map[string]*api.RecoveryPolicy{}, copies: map[string][]api.AbandonedCopy{}}
	}
	return d.recovery
}

// -----------------------------------------------------------------------------
// Test controls
// -----------------------------------------------------------------------------

// SetPitrWindows makes a service's archived WAL cover windows in an
// environment: each window gets a succeeded base backup finished at its
// start, and an active stream is reported. Turning PITR on is separate
// (`db backups policy set --pitr on`).
func (f *Fake) SetPitrWindows(serviceID, envID string, windows ...api.PitrRange) {
	f.mu.Lock()
	defer f.mu.Unlock()
	rs, d := f.recoveryState(), f.dataState()
	key := serviceID + "/" + envID
	rs.windows[key] = slices.Clone(windows)
	var segments int64
	for _, w := range windows {
		b := &api.Backup{ID: f.nextID("bak"), ProjectID: ProjectID, ServiceID: serviceID, EnvironmentID: envID, Trigger: "schedule",
			Method: "base", Engine: str("postgres"), Status: api.BackupSucceeded, StartedAt: i64(w.From - 30000),
			FinishedAt: i64(w.From), CreatedAt: w.From - 30000}
		d.backups = append(d.backups, b)
		segments += (w.To - w.From) / 60000
	}
	if len(windows) == 0 {
		delete(rs.streams, key)
		return
	}
	first, last := windows[0].From, windows[len(windows)-1].To
	rs.streams[key] = &api.PitrStream{ID: f.nextID("wal"), Status: "active", SegmentCount: segments, BytesStored: segments * 16 << 20,
		FirstArchivedAt: &first, LastArchivedAt: &last, CreatedAt: first}
}

// SetPitrUnavailable makes PITR report reason as why it cannot be turned
// on for a service in an environment; "" clears it.
func (f *Fake) SetPitrUnavailable(serviceID, envID, reason string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if reason == "" {
		delete(f.recoveryState().unavailable, serviceID+"/"+envID)
		return
	}
	f.recoveryState().unavailable[serviceID+"/"+envID] = reason
}

// AddAbandonedCopy records a copy a recovery left of a service's volume in
// an environment; the newest is listed first.
func (f *Fake) AddAbandonedCopy(serviceID, envID string, c api.AbandonedCopy) {
	f.mu.Lock()
	defer f.mu.Unlock()
	rs := f.recoveryState()
	key := serviceID + "/" + envID
	rs.copies[key] = append([]api.AbandonedCopy{c}, rs.copies[key]...)
}

// OnGetPitrStatus runs h on every PITR status the fake answers, under the
// lock, so tests can report windows the restore planner does not share.
func (f *Fake) OnGetPitrStatus(h func(st *api.PitrStatus)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.recoveryState().onGetStatus = h
}

// RecoveryPolicy returns the saved recovery policy of a service in an
// environment, or nil.
func (f *Fake) RecoveryPolicy(serviceID, envID string) *api.RecoveryPolicy {
	f.mu.Lock()
	defer f.mu.Unlock()
	if p := f.recoveryState().policies[serviceID+"/"+envID]; p != nil {
		c := *p
		return &c
	}
	return nil
}

// SetRecoveryPolicy stores a recovery policy as the control plane would
// report it, e.g. while it watches a lost server.
func (f *Fake) SetRecoveryPolicy(p api.RecoveryPolicy) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.recoveryState().policies[p.ServiceID+"/"+p.EnvironmentID] = &p
}

// -----------------------------------------------------------------------------
// Routing
// -----------------------------------------------------------------------------

// recoveryRoutes adds the point-in-time recovery, recovery policy and
// abandoned-copy routes.
func (f *Fake) recoveryRoutes(handlers map[api.Route]guarded) {
	for r, g := range map[api.Route]guarded{
		api.RoutePitrStatus:        {"services:read", f.getPitrStatus},
		api.RoutePitrRestore:       {"backups:restore", f.pitrRestore},
		api.RouteRecoveryPolicy:    {"services:read", f.getRecoveryPolicy},
		api.RoutePutRecoveryPolicy: {"backups:restore", f.putRecoveryPolicy},
		api.RouteAbandonedCopies:   {"services:read", f.listAbandonedCopies},
	} {
		handlers[r] = g
	}
}

// -----------------------------------------------------------------------------
// Point-in-time recovery
// -----------------------------------------------------------------------------

// pitrIneligibility mirrors pitrIneligibility in lib/backups/pitr.ts; ""
// when PITR can be turned on. Must hold f.mu.
func (f *Fake) pitrIneligibility(s *api.Service, envID string) string {
	if s.Database == nil || s.Database.Engine != "postgres" {
		return "Point-in-time recovery is available for Postgres databases only"
	}
	return f.recoveryState().unavailable[s.ID+"/"+envID]
}

// applyPitr applies a backup policy's requested pitr to pol, mirroring
// putBackupPolicy: on needs scheduled backups and an eligible database,
// and makes scheduled backups base backups. It answers a refusal itself.
// Must hold f.mu.
func (f *Fake) applyPitr(w http.ResponseWriter, s *api.Service, envID string, pol *api.BackupPolicy, pitr *bool) bool {
	was := pol.Pitr
	if pitr != nil {
		pol.Pitr = *pitr
	}
	if pol.Pitr && !pol.Enabled {
		apiError(w, http.StatusUnprocessableEntity, "invalid_request", "Point-in-time recovery needs scheduled backups: its base backups follow the schedule")
		return false
	}
	if pol.Pitr && !was {
		if reason := f.pitrIneligibility(s, envID); reason != "" {
			apiError(w, http.StatusConflict, "conflict", reason)
			return false
		}
	}
	switch {
	case pol.Pitr:
		pol.Method = "base"
	case pol.Method == "base":
		pol.Method = "dump"
	}
	return true
}

func (f *Fake) getPitrStatus(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	env, ok := environment(w, r, p, true)
	if !ok {
		return
	}
	rs := f.recoveryState()
	key := s.ID + "/" + env
	out := api.PitrStatus{ServiceID: s.ID, EnvironmentID: env, Enabled: f.policyOf(s.ID, env).Pitr,
		Stream: rs.streams[key], Windows: rs.windows[key]}
	if out.Windows == nil {
		out.Windows = []api.PitrRange{}
	}
	if reason := f.pitrIneligibility(s, env); reason != "" {
		out.UnavailableReason = &reason
	}
	for _, b := range f.dataState().backups {
		if b.ServiceID == s.ID && b.EnvironmentID == env && b.Method == "base" && b.Status == api.BackupSucceeded {
			out.BaseBackups++
		}
	}
	if rs.onGetStatus != nil {
		rs.onGetStatus(&out)
	}
	writeJSON(w, http.StatusOK, out)
}

// pitrRestore mirrors restorePitr: a fresh session, the typed slug, a
// target that is not in the future and that a base backup and WAL cover.
func (f *Fake) pitrRestore(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	var in api.PitrRestoreInput
	if decode(r, &in) != nil || !slices.Contains(api.RestoreModes, in.Mode) {
		apiError(w, http.StatusBadRequest, "invalid_request", "mode: Invalid enum value")
		return
	}
	if !slices.ContainsFunc(p.Environments, func(e api.Environment) bool { return e.ID == in.EnvironmentID }) {
		apiError(w, http.StatusNotFound, "not_found", "Environment not found")
		return
	}
	if !f.freshSession(w, r) {
		return
	}
	if in.Confirm != s.Slug {
		apiError(w, http.StatusBadRequest, "invalid_request", "confirm must equal the service's slug")
		return
	}
	if in.TargetTime > Now {
		apiError(w, http.StatusBadRequest, "invalid_request", "target_time is in the future")
		return
	}
	windows := f.recoveryState().windows[s.ID+"/"+in.EnvironmentID]
	base := f.pitrBase(s.ID, in.EnvironmentID, in.TargetTime)
	if base == nil {
		msg := "Nothing is restorable to a point in time yet: point-in-time recovery needs a base backup and WAL archived after it"
		if len(windows) > 0 {
			ranges := make([]string, len(windows))
			for i, x := range windows {
				ranges[i] = iso(x.From) + " to " + iso(x.To)
			}
			msg = "No base backup and archived WAL cover that time; restorable: " + strings.Join(ranges, ", ")
		}
		apiError(w, http.StatusUnprocessableEntity, "pitr_target_unavailable", msg)
		return
	}
	target := in.TargetTime
	if in.Mode == api.RestoreNewService {
		f.startNewServiceRestore(w, base, s, s.Database.Engine, in.TargetEnvironmentID, in.Slug, &target)
		return
	}
	if in.TargetEnvironmentID != "" && in.TargetEnvironmentID != in.EnvironmentID {
		apiError(w, http.StatusBadRequest, "invalid_request", "in_place restores into the backup's environment")
		return
	}
	f.startInPlaceRestore(w, base, s, "", in.SkipSafetyBackup, &target)
}

// pitrBase mirrors planPitrRestore: the newest base backup finished by
// target, inside a window that covers target. Must hold f.mu.
func (f *Fake) pitrBase(serviceID, envID string, target int64) *api.Backup {
	windows := f.recoveryState().windows[serviceID+"/"+envID]
	if !slices.ContainsFunc(windows, func(x api.PitrRange) bool { return x.Contains(target) }) {
		return nil
	}
	var best *api.Backup
	for _, b := range f.dataState().backups {
		if b.ServiceID != serviceID || b.EnvironmentID != envID || b.Method != "base" || b.Status != api.BackupSucceeded ||
			b.FinishedAt == nil || *b.FinishedAt > target {
			continue
		}
		if best == nil || *b.FinishedAt > *best.FinishedAt {
			best = b
		}
	}
	return best
}

func iso(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

// -----------------------------------------------------------------------------
// Recovery policies
// -----------------------------------------------------------------------------

func (f *Fake) recoveryPolicyOf(serviceID, envID string) *api.RecoveryPolicy {
	if p := f.recoveryState().policies[serviceID+"/"+envID]; p != nil {
		return p
	}
	return &api.RecoveryPolicy{ServiceID: serviceID, EnvironmentID: envID, GraceMinutes: api.DefaultRecoveryGraceMinutes, Status: "idle"}
}

func (f *Fake) getRecoveryPolicy(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	env, ok := environment(w, r, p, true)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, f.recoveryPolicyOf(s.ID, env))
}

// putRecoveryPolicy mirrors putRecoveryPolicy: a fresh session, a volume
// to recover, backup storage to turn it on, and the grace bounds.
func (f *Fake) putRecoveryPolicy(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	var in api.PutRecoveryPolicyInput
	if decode(r, &in) != nil {
		apiError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}
	if in.GraceMinutes != nil && (*in.GraceMinutes < api.MinRecoveryGraceMinutes || *in.GraceMinutes > api.MaxRecoveryGraceMinutes) {
		apiError(w, http.StatusBadRequest, "invalid_request", "grace_minutes: Number must be between 5 and 10080")
		return
	}
	if !slices.ContainsFunc(p.Environments, func(e api.Environment) bool { return e.ID == in.EnvironmentID }) {
		apiError(w, http.StatusNotFound, "not_found", "Environment not found")
		return
	}
	if !f.freshSession(w, r) {
		return
	}
	if f.volumeOf(s.ID, in.EnvironmentID) == nil {
		apiError(w, http.StatusConflict, "conflict", "The service has no volume in this environment to recover")
		return
	}
	pol := *f.recoveryPolicyOf(s.ID, in.EnvironmentID)
	turnedOn := in.Enabled != nil && *in.Enabled && !pol.Enabled
	if in.Enabled != nil {
		pol.Enabled = *in.Enabled
	}
	if pol.Enabled && !f.storageConfigured(w) {
		return
	}
	if in.GraceMinutes != nil {
		pol.GraceMinutes = *in.GraceMinutes
	}
	if pol.Enabled {
		pol.EnabledBy = str(f.user.ID)
	}
	if turnedOn || !pol.Enabled {
		pol.Status, pol.Message, pol.LostNodeID = "idle", nil, nil
	}
	if pol.ID == nil {
		pol.ID = str(f.nextID("rcp"))
	}
	pol.UpdatedAt = i64(Now)
	f.recoveryState().policies[s.ID+"/"+in.EnvironmentID] = &pol
	writeJSON(w, http.StatusOK, pol)
}

// -----------------------------------------------------------------------------
// Abandoned copies
// -----------------------------------------------------------------------------

func (f *Fake) listAbandonedCopies(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	env, ok := environment(w, r, p, true)
	if !ok {
		return
	}
	copies := f.recoveryState().copies[s.ID+"/"+env]
	if copies == nil {
		copies = []api.AbandonedCopy{}
	}
	writeJSON(w, http.StatusOK, api.AbandonedCopyList{Copies: copies})
}

// abandon records the copy a recovery leaves of v, waiting for its server
// to come back. Must hold f.mu.
func (f *Fake) abandon(v *api.Volume) {
	used := int64(0)
	if v.UsedBytes != nil {
		used = int64(*v.UsedBytes)
	}
	rs := f.recoveryState()
	key := v.ServiceID + "/" + v.EnvironmentID
	c := api.AbandonedCopy{VolumeID: v.ID, NodeID: v.NodeID, NodeName: v.NodeName, State: "waiting_for_server",
		Message: str("The server is offline; the copy is deleted once it returns"), SizeMB: v.SizeMB, UsedBytes: &used,
		AbandonedAt: i64(Now), DeleteAfter: i64(Now + AbandonedCopyGraceMS)}
	rs.copies[key] = append([]api.AbandonedCopy{c}, rs.copies[key]...)
}
