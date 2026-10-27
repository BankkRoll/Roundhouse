package apitest

import (
	"bytes"
	"cmp"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"filippo.io/age"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
)

// dataState is the fake's databases, volumes, backups and restores.
type dataState struct {
	volumes  []*api.Volume
	backups  []*api.Backup
	policies map[string]*api.BackupPolicy
	restores []*api.Restore
	// objects holds each backup's stored (encrypted) bytes.
	objects map[string][]byte
	// identity is the project's backup key.
	identity *age.X25519Identity
	// storageMissing makes backup routes answer 409
	// backup_storage_not_configured.
	storageMissing bool
	// staleSession makes fresh-session routes answer 403 reauth_required
	// for a session, as after REAUTH_WINDOW_MS.
	staleSession bool
	// query answers data-browser operations; see [Fake.OnQuery].
	query func(serviceID string, in api.DatabaseQueryInput) api.DatabaseQueryResult

	// OnGetBackup and OnGetRestore run on every GET, under the lock, so
	// tests can advance them between polls.
	onGetBackup  func(b *api.Backup)
	onGetRestore func(r *api.Restore)

	// ops holds volume migrations, TCP proxies and credential rotations; see
	// [Fake.opsState].
	ops *opsState
}

func (f *Fake) dataState() *dataState {
	if f.data == nil {
		id, err := age.GenerateX25519Identity()
		if err != nil {
			panic(err)
		}
		f.data = &dataState{policies: map[string]*api.BackupPolicy{}, objects: map[string][]byte{}, identity: id}
	}
	return f.data
}

// engineSpec mirrors DATABASE_ENGINE_SPECS in packages/shared/src/databases.ts.
type engineSpec struct {
	name     string
	port     int
	versions []string
	mount    string
}

var engineSpecs = map[string]engineSpec{
	"postgres": {"PostgreSQL", 5432, []string{"18", "17", "16"}, "/var/lib/postgresql"},
	"mysql":    {"MySQL", 3306, []string{"9.7", "8.4"}, "/var/lib/mysql"},
	"redis":    {"Valkey", 6379, []string{"valkey-9", "valkey-8", "redis-8"}, "/data"},
	"mongodb":  {"MongoDB", 27017, []string{"9.0", "8.0"}, "/data/db"},
}

// connectionVariables mirrors engineVariables: plain ones first, then
// secrets, with reference-valued connection strings.
func connectionVariables(engine string) map[string]*variable {
	host := "${{ROUNDHOUSE_PRIVATE_DOMAIN}}"
	plain := func(v string) *variable { return &variable{value: v, version: 1} }
	secret := func(v string) *variable { return &variable{value: v, secret: true, version: 1} }
	vars := map[string]*variable{"ROUNDHOUSE_RO_PASSWORD": secret("ro-" + SecretValue)}
	switch engine {
	case "postgres":
		vars["POSTGRES_USER"], vars["POSTGRES_DB"] = plain("postgres"), plain("app")
		vars["POSTGRES_PASSWORD"] = secret("pg-" + SecretValue)
		vars["DATABASE_URL"] = secret("postgresql://${{POSTGRES_USER}}:${{POSTGRES_PASSWORD}}@" + host + ":5432/${{POSTGRES_DB}}")
		vars["PGHOST"], vars["PGPORT"] = plain(host), plain("5432")
		vars["PGUSER"], vars["PGDATABASE"] = plain("${{POSTGRES_USER}}"), plain("${{POSTGRES_DB}}")
		vars["PGPASSWORD"] = secret("${{POSTGRES_PASSWORD}}")
	case "mysql":
		url := "mysql://${{MYSQL_USER}}:${{MYSQL_PASSWORD}}@" + host + ":3306/${{MYSQL_DATABASE}}"
		vars["MYSQL_USER"], vars["MYSQL_DATABASE"] = plain("app"), plain("app")
		vars["MYSQL_ROOT_PASSWORD"], vars["MYSQL_PASSWORD"] = secret("root-"+SecretValue), secret("my-"+SecretValue)
		vars["DATABASE_URL"], vars["MYSQL_URL"] = secret(url), secret(url)
	case "redis":
		vars["REDIS_PASSWORD"] = secret("redis-" + SecretValue)
		vars["REDIS_URL"] = secret("redis://default:${{REDIS_PASSWORD}}@" + host + ":6379")
	case "mongodb":
		url := "mongodb://${{MONGO_INITDB_ROOT_USERNAME}}:${{MONGO_INITDB_ROOT_PASSWORD}}@" + host + ":27017/?authSource=admin"
		vars["MONGO_INITDB_ROOT_USERNAME"] = plain("root")
		vars["MONGO_INITDB_ROOT_PASSWORD"] = secret("mongo-" + SecretValue)
		vars["MONGO_URL"], vars["DATABASE_URL"] = secret(url), secret(url)
	}
	return vars
}

// -----------------------------------------------------------------------------
// Test controls
// -----------------------------------------------------------------------------

// SeedDatabase makes a seeded service a database running engine and
// version, with a volume in every environment: ready on the seeded server
// in production with usedBytes used, pending elsewhere. It replaces the
// service's variables with the engine's generated ones.
func (f *Fake) SeedDatabase(serviceID, engine, version string, sizeMB int64, usedBytes float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, s := f.serviceOf(serviceID)
	if s == nil {
		panic("apitest: no service " + serviceID)
	}
	s.Kind, s.Database = "database", &api.ServiceDatabase{Engine: engine, Version: version}
	for _, e := range p.Environments {
		v := f.newVolume(p.ID, e.ID, s.ID, engineSpecs[engine].mount, sizeMB)
		if e.Kind == "production" {
			v.Status, v.NodeID, v.NodeName = api.VolumeReady, str(NodeID), str("edge-1")
			v.QuotaMode, v.UsedBytes, v.ReportedAt = str("xfs_project"), &usedBytes, i64(Now-60000)
		}
		f.vars[varKey(s.ID, e.ID)] = connectionVariables(engine)
	}
}

// Volume returns a service's volume in an environment, or nil.
func (f *Fake) Volume(serviceID, envID string) *api.Volume {
	f.mu.Lock()
	defer f.mu.Unlock()
	if v := f.volumeOf(serviceID, envID); v != nil {
		c := *v
		return &c
	}
	return nil
}

// SetBackupStorage configures or removes the instance's backup bucket; it
// is configured in the seed.
func (f *Fake) SetBackupStorage(configured bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.dataState().storageMissing = !configured
}

// SetSessionStale makes routes that need a fresh session refuse the
// seeded session with 403 reauth_required.
func (f *Fake) SetSessionStale(stale bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.dataState().staleSession = stale
}

// OnQuery sets how data-browser operations are answered. By default
// list_namespaces and list_tables answer a canned Postgres schema and raw
// echoes its statement.
func (f *Fake) OnQuery(h func(serviceID string, in api.DatabaseQueryInput) api.DatabaseQueryResult) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.dataState().query = h
}

// OnGetBackup runs h on every GET of a backup, under the lock.
func (f *Fake) OnGetBackup(h func(b *api.Backup)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.dataState().onGetBackup = h
}

// OnGetRestore runs h on every GET of a restore, under the lock.
func (f *Fake) OnGetRestore(h func(r *api.Restore)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.dataState().onGetRestore = h
}

// AddBackup stores a backup whose object is payload encrypted to the
// project's backup key; ID, project, sizes and digest are filled in.
func (f *Fake) AddBackup(b api.Backup, payload []byte) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	d := f.dataState()
	if b.ID == "" {
		b.ID = f.nextID("bak")
	}
	b.ProjectID = ProjectID
	if b.Status == "" {
		b.Status = api.BackupSucceeded
	}
	if b.Method == "" {
		b.Method = "dump"
	}
	if b.Trigger == "" {
		b.Trigger = "schedule"
	}
	if b.CreatedAt == 0 {
		b.CreatedAt = Now - 3600000
	}
	if payload != nil {
		var buf bytes.Buffer
		w, err := age.Encrypt(&buf, d.identity.Recipient())
		if err != nil {
			panic(err)
		}
		_, _ = w.Write(payload)
		if err := w.Close(); err != nil {
			panic(err)
		}
		d.objects[b.ID] = buf.Bytes()
		sum := sha256.Sum256(buf.Bytes())
		raw, stored := int64(len(payload)), int64(buf.Len())
		b.SHA256, b.BytesRaw, b.BytesStored = str(hex.EncodeToString(sum[:])), &raw, &stored
	}
	d.backups = append(d.backups, &b)
	return b.ID
}

// CorruptBackup flips a byte of a backup's stored object, so its digest no
// longer matches.
func (f *Fake) CorruptBackup(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	obj := f.dataState().objects[id]
	obj[len(obj)/2] ^= 0xff
}

// Backups returns the stored backups, oldest first.
func (f *Fake) Backups() []api.Backup {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []api.Backup
	for _, b := range f.dataState().backups {
		out = append(out, *b)
	}
	return out
}

// Restores returns the started restores, oldest first.
func (f *Fake) Restores() []api.Restore {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []api.Restore
	for _, r := range f.dataState().restores {
		out = append(out, *r)
	}
	return out
}

// BackupPolicy returns the stored policy of a service in an environment.
func (f *Fake) BackupPolicy(serviceID, envID string) *api.BackupPolicy {
	f.mu.Lock()
	defer f.mu.Unlock()
	if p := f.dataState().policies[serviceID+"/"+envID]; p != nil {
		c := *p
		return &c
	}
	return nil
}

// -----------------------------------------------------------------------------
// Routing
// -----------------------------------------------------------------------------

// dataRoutes adds the database, volume, data-browser and backup routes.
func (f *Fake) dataRoutes(mux *http.ServeMux, handlers map[api.Route]guarded) {
	for r, g := range map[api.Route]guarded{
		api.RouteCreateDatabase:  {"services:manage", f.createDatabase},
		api.RouteServiceVolume:   {"services:read", f.getServiceVolume},
		api.RouteResizeVolume:    {"services:manage", f.resizeVolume},
		api.RouteDeleteVolume:    {"services:manage", f.deleteVolume},
		api.RouteUndeleteVolume:  {"services:manage", f.undeleteVolume},
		api.RouteDatabaseQuery:   {"data:read", f.databaseQuery},
		api.RouteDatabaseSchema:  {"data:read", f.databaseSchema},
		api.RouteBackupPolicy:    {"services:read", f.getBackupPolicy},
		api.RoutePutBackupPolicy: {"backups:manage", f.putBackupPolicy},
		api.RouteListBackups:     {"services:read", f.listBackups},
		api.RouteCreateBackup:    {"backups:manage", f.createBackup},
		api.RouteGetBackup:       {"services:read", f.getBackup},
		api.RouteBackupDownload:  {"backups:restore", f.backupDownload},
		api.RouteBackupKey:       {"backups:restore", f.backupKey},
		api.RouteRestoreBackup:   {"backups:restore", f.restoreBackup},
		api.RouteGetRestore:      {"services:read", f.getRestore},
	} {
		handlers[r] = g
	}
	f.opsRoutes(handlers)
	mux.HandleFunc("GET /_objects/{backupId}", f.serveObject)
}

// dataServiceOf returns the service a volume, backup or restore route acts
// on, for the API token workspace check; "" when there is none. Must hold
// f.mu.
func (f *Fake) dataServiceOf(r *http.Request) string {
	d := f.dataState()
	if id := r.PathValue("volumeId"); id != "" {
		if i := slices.IndexFunc(d.volumes, func(v *api.Volume) bool { return v.ID == id }); i >= 0 {
			return d.volumes[i].ServiceID
		}
	}
	if id := f.migrationServiceOf(r.PathValue("migrationId")); id != "" {
		return id
	}
	backupID := r.PathValue("backupId")
	if id := r.PathValue("restoreId"); id != "" {
		if i := slices.IndexFunc(d.restores, func(x *api.Restore) bool { return x.ID == id }); i >= 0 {
			backupID = d.restores[i].BackupID
		}
	}
	if b := d.backup(backupID); b != nil {
		return b.ServiceID
	}
	return ""
}

func (d *dataState) backup(id string) *api.Backup {
	if i := slices.IndexFunc(d.backups, func(b *api.Backup) bool { return b.ID == id }); i >= 0 {
		return d.backups[i]
	}
	return nil
}

func (f *Fake) newVolume(projectID, envID, serviceID, mount string, sizeMB int64) *api.Volume {
	v := &api.Volume{ID: f.nextID("vol"), ProjectID: projectID, EnvironmentID: envID, ServiceID: serviceID, MountPath: mount,
		SizeMB: sizeMB, Status: api.VolumePending, CreatedAt: Now - 86400000, UpdatedAt: Now - 86400000}
	d := f.dataState()
	d.volumes = slices.DeleteFunc(d.volumes, func(x *api.Volume) bool { return x.ServiceID == serviceID && x.EnvironmentID == envID })
	d.volumes = append(d.volumes, v)
	return v
}

// volumeOf finds a service's volume in an environment that has not been
// removed. Must hold f.mu.
func (f *Fake) volumeOf(serviceID, envID string) *api.Volume {
	for _, v := range f.dataState().volumes {
		if v.ServiceID == serviceID && v.EnvironmentID == envID && v.Status != "deleted" {
			return v
		}
	}
	return nil
}

func (f *Fake) findVolume(w http.ResponseWriter, id string) *api.Volume {
	for _, v := range f.dataState().volumes {
		if v.ID == id {
			return v
		}
	}
	apiError(w, http.StatusNotFound, "not_found", "Volume not found")
	return nil
}

// freshSession mirrors requireFreshSession: an API token is never fresh.
func (f *Fake) freshSession(w http.ResponseWriter, r *http.Request) bool {
	if callerOf(r).token != nil || f.dataState().staleSession {
		apiError(w, http.StatusForbidden, "reauth_required", "Confirm your password to continue")
		return false
	}
	return true
}

func (f *Fake) storageConfigured(w http.ResponseWriter) bool {
	if f.dataState().storageMissing {
		apiError(w, http.StatusConflict, "backup_storage_not_configured",
			"Backup storage is not configured; an instance admin sets it under Settings → Backups")
		return false
	}
	return true
}

// -----------------------------------------------------------------------------
// Databases and volumes
// -----------------------------------------------------------------------------

func (f *Fake) createDatabase(w http.ResponseWriter, r *http.Request) {
	p := f.project(w, r.PathValue("projectId"))
	if p == nil {
		return
	}
	var in api.CreateDatabaseInput
	if decode(r, &in) != nil {
		apiError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}
	spec, ok := engineSpecs[in.Engine]
	if !ok {
		apiError(w, http.StatusBadRequest, "invalid_request", "engine: Invalid enum value")
		return
	}
	if in.SizeMB == 0 {
		in.SizeMB = api.DefaultVolumeMB
	}
	if in.SizeMB < api.MinVolumeMB || in.SizeMB > api.MaxVolumeMB {
		apiError(w, http.StatusBadRequest, "invalid_request", "size_mb: Number must be between 256 and 1048576")
		return
	}
	if !slices.ContainsFunc(p.Environments, func(e api.Environment) bool { return e.ID == in.EnvironmentID }) {
		apiError(w, http.StatusNotFound, "not_found", "Environment not found")
		return
	}
	version := in.Version
	if version == "" {
		version = spec.versions[0]
	}
	if !slices.Contains(spec.versions, version) {
		apiError(w, http.StatusNotFound, "not_found", spec.name+" "+version+" is not available")
		return
	}
	name := in.Name
	if name == "" {
		name = spec.name
	}
	slug := in.Slug
	if slug == "" {
		slug = slugify(in.Engine)
	}
	slug = uniqueSlug(slug, func(s string) bool {
		return s == sharedNamespace || slices.ContainsFunc(p.Services, func(x api.Service) bool { return x.Slug == s })
	})
	svc := api.Service{ID: f.nextID("svc"), ProjectID: p.ID, Name: name, Slug: slug, Kind: "database",
		Database: &api.ServiceDatabase{Engine: in.Engine, Version: version}, CreatedAt: Now, UpdatedAt: Now}
	p.Services = append(p.Services, svc)
	out := api.CreatedDatabase{ChangeSetID: f.nextID("chs"), Service: svc, Engine: in.Engine, Version: version,
		Volumes: []api.Volume{}, Variables: []api.CreatedVariable{}, DeploymentIDs: []string{}, Skipped: []api.SkippedDeployment{}}
	port := spec.port
	for _, e := range p.Environments {
		f.configs[svc.ID+"/"+e.ID] = config(svc.ID, e.ID, api.ServiceSource{Type: "image", Image: in.Engine + ":" + version}, &port)
		out.Volumes = append(out.Volumes, *f.newVolume(p.ID, e.ID, svc.ID, spec.mount, int64(in.SizeMB)))
		f.vars[varKey(svc.ID, e.ID)] = connectionVariables(in.Engine)
	}
	vars := f.vars[varKey(svc.ID, in.EnvironmentID)]
	for _, k := range slices.Sorted(mapKeys(vars)) {
		out.Variables = append(out.Variables, api.CreatedVariable{Key: k, Secret: vars[k].secret})
	}
	if in.Deploy {
		d := f.deployment(f.nextID("dep"), "queued", Now, nil)
		d.ProjectID, d.ServiceID, d.EnvironmentID = p.ID, svc.ID, in.EnvironmentID
		f.deployments = append(f.deployments, d)
		out.DeploymentIDs = append(out.DeploymentIDs, d.ID)
	}
	writeJSON(w, http.StatusCreated, out)
}

func (f *Fake) getServiceVolume(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	env, ok := environment(w, r, p, true)
	if !ok {
		return
	}
	v := f.volumeOf(s.ID, env)
	if v == nil {
		apiError(w, http.StatusNotFound, "not_found", "Volume not found")
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func liveVolume(status string) bool {
	return slices.Contains([]string{"pending", "ready", "migrating", "degraded", "error"}, status)
}

func (f *Fake) resizeVolume(w http.ResponseWriter, r *http.Request) {
	v := f.findVolume(w, r.PathValue("volumeId"))
	if v == nil {
		return
	}
	var in struct {
		SizeMB int64 `json:"size_mb"`
	}
	if decode(r, &in) != nil || in.SizeMB < api.MinVolumeMB || in.SizeMB > api.MaxVolumeMB {
		apiError(w, http.StatusBadRequest, "invalid_request", "size_mb: Number must be between 256 and 1048576")
		return
	}
	if !liveVolume(v.Status) {
		apiError(w, http.StatusConflict, "conflict", "The volume is "+strings.ReplaceAll(v.Status, "_", " "))
		return
	}
	if in.SizeMB < v.SizeMB {
		apiError(w, http.StatusUnprocessableEntity, "volume_shrink_unsupported", "Volumes only grow; it is "+strconv.FormatInt(v.SizeMB, 10)+" MiB")
		return
	}
	v.SizeMB, v.UpdatedAt = in.SizeMB, Now
	writeJSON(w, http.StatusOK, v)
}

func (f *Fake) deleteVolume(w http.ResponseWriter, r *http.Request) {
	v := f.findVolume(w, r.PathValue("volumeId"))
	if v == nil {
		return
	}
	if !liveVolume(v.Status) {
		apiError(w, http.StatusConflict, "conflict", "The volume is "+strings.ReplaceAll(v.Status, "_", " "))
		return
	}
	for _, d := range f.deployments {
		if d.ServiceID == v.ServiceID && d.EnvironmentID == v.EnvironmentID && d.Status == api.StatusActive {
			apiError(w, http.StatusConflict, "conflict", "The service still runs here; scale it to 0 or delete it first")
			return
		}
	}
	v.Status, v.DeleteAfter, v.UpdatedAt = api.VolumePendingDeletion, i64(Now+72*3600000), Now
	writeJSON(w, http.StatusOK, v)
}

func (f *Fake) undeleteVolume(w http.ResponseWriter, r *http.Request) {
	v := f.findVolume(w, r.PathValue("volumeId"))
	if v == nil {
		return
	}
	if v.Status != api.VolumePendingDeletion {
		apiError(w, http.StatusConflict, "conflict", "The volume is not deleted")
		return
	}
	v.Status, v.DeleteAfter, v.UpdatedAt = api.VolumeReady, nil, Now
	if v.NodeID == nil {
		v.Status = api.VolumePending
	}
	writeJSON(w, http.StatusOK, v)
}

// -----------------------------------------------------------------------------
// Data browser
// -----------------------------------------------------------------------------

// databaseService finds a database service, answering 409 for any other.
func (f *Fake) databaseService(w http.ResponseWriter, id string) (*api.ProjectDetail, *api.Service) {
	p, s := f.service(w, id)
	if s == nil {
		return nil, nil
	}
	if s.Database == nil {
		apiError(w, http.StatusConflict, "conflict", "This service is not a database")
		return nil, nil
	}
	return p, s
}

func defaultQuery(_ string, in api.DatabaseQueryInput) api.DatabaseQueryResult {
	res := api.DatabaseQueryResult{RequestID: "dbq_0001", OK: true, DurationMS: 7}
	cols := func(names ...string) []api.QueryColumn {
		out := make([]api.QueryColumn, len(names))
		for i, n := range names {
			out[i] = api.QueryColumn{Name: n, Type: "text"}
		}
		return out
	}
	switch in.Op.Type {
	case "list_namespaces":
		res.Columns, res.Rows = cols("name", "owner"), [][]any{{"public", "postgres"}, {"audit", "postgres"}}
	case "list_tables":
		res.Columns = cols("name", "type", "estimated_rows")
		res.Rows = [][]any{{"orders", "table", "1200"}, {"users", "table", "42"}, {"active_users", "view", "0"}}
	case "raw":
		res.Columns = cols("statement")
		res.Rows = [][]any{{in.Op.Statement}}
	}
	n := len(res.Rows)
	res.RowCount = &n
	return res
}

func (f *Fake) databaseQuery(w http.ResponseWriter, r *http.Request) {
	p, s := f.databaseService(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	var in api.DatabaseQueryInput
	if decode(r, &in) != nil {
		apiError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}
	if !slices.ContainsFunc(p.Environments, func(e api.Environment) bool { return e.ID == in.EnvironmentID }) {
		apiError(w, http.StatusNotFound, "not_found", "Environment not found")
		return
	}
	if in.Mode == api.QueryWrite && !f.freshSession(w, r) {
		return
	}
	if in.MaxRows != 0 && (in.MaxRows < 1 || in.MaxRows > api.MaxQueryRows) ||
		in.TimeoutMS != 0 && (in.TimeoutMS < api.MinQueryTimeoutMS || in.TimeoutMS > api.MaxQueryTimeoutMS) {
		apiError(w, http.StatusBadRequest, "invalid_request", "max_rows or timeout_ms out of range")
		return
	}
	if in.Op.Type == "raw" && (in.Op.Statement == "") == (len(in.Op.Argv) == 0) {
		apiError(w, http.StatusBadRequest, "invalid_request", "op: raw needs exactly one of statement and argv")
		return
	}
	if f.volumeOf(s.ID, in.EnvironmentID) == nil || f.volumeOf(s.ID, in.EnvironmentID).NodeID == nil {
		apiError(w, http.StatusConflict, "conflict", "The database has no running replica in this environment")
		return
	}
	h := f.queryHandler()
	writeJSON(w, http.StatusOK, h(s.ID, in))
}

// queryHandler answers data-browser operations. Must hold f.mu.
func (f *Fake) queryHandler() func(string, api.DatabaseQueryInput) api.DatabaseQueryResult {
	if h := f.dataState().query; h != nil {
		return h
	}
	return defaultQuery
}

func (f *Fake) databaseSchema(w http.ResponseWriter, r *http.Request) {
	p, s := f.databaseService(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	env, ok := environment(w, r, p, true)
	if !ok {
		return
	}
	if v := f.volumeOf(s.ID, env); v == nil || v.NodeID == nil {
		apiError(w, http.StatusConflict, "conflict", "The database has no running replica in this environment")
		return
	}
	h := f.queryHandler()
	ns := h(s.ID, api.DatabaseQueryInput{EnvironmentID: env, Mode: api.QueryRead, Op: api.QueryOp{Type: "list_namespaces"}})
	writeJSON(w, http.StatusOK, api.DatabaseSchema{Engine: s.Database.Engine, Version: str(s.Database.Version), Namespaces: ns})
}

// -----------------------------------------------------------------------------
// Backups
// -----------------------------------------------------------------------------

func (f *Fake) policyOf(serviceID, envID string) *api.BackupPolicy {
	if p := f.dataState().policies[serviceID+"/"+envID]; p != nil {
		return p
	}
	return &api.BackupPolicy{ServiceID: serviceID, EnvironmentID: envID, Enabled: true, Method: "dump", Schedule: "0 3 * * *",
		Timezone: "UTC", KeepLast: 7, Quiesce: "none", NextRunAt: i64(Now + 15*3600000),
		NextRuns: []int64{Now + 15*3600000, Now + 39*3600000, Now + 63*3600000}}
}

func (f *Fake) getBackupPolicy(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	env, ok := environment(w, r, p, true)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, f.policyOf(s.ID, env))
}

// validCron loosely checks a five-field cron expression.
func validCron(s string) bool {
	fields := strings.Fields(s)
	if len(fields) != 5 {
		return false
	}
	for _, x := range fields {
		if strings.Trim(x, "0123456789*/,-") != "" {
			return false
		}
	}
	return true
}

func (f *Fake) putBackupPolicy(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	var in struct {
		EnvironmentID string          `json:"environment_id"`
		Enabled       *bool           `json:"enabled"`
		Schedule      *string         `json:"schedule"`
		KeepLast      *int            `json:"keep_last"`
		MaxAgeDays    json.RawMessage `json:"max_age_days"`
	}
	if decode(r, &in) != nil {
		apiError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}
	if !slices.ContainsFunc(p.Environments, func(e api.Environment) bool { return e.ID == in.EnvironmentID }) {
		apiError(w, http.StatusNotFound, "not_found", "Environment not found")
		return
	}
	if in.Schedule != nil && !validCron(*in.Schedule) {
		apiError(w, http.StatusBadRequest, "invalid_request", "schedule: expected a five-field cron expression")
		return
	}
	if in.KeepLast != nil && (*in.KeepLast < 1 || *in.KeepLast > api.MaxKeepLast) {
		apiError(w, http.StatusBadRequest, "invalid_request", "keep_last: Number must be between 1 and 365")
		return
	}
	if f.volumeOf(s.ID, in.EnvironmentID) == nil {
		apiError(w, http.StatusConflict, "conflict", s.Name+" has no volume in this environment to back up")
		return
	}
	pol := *f.policyOf(s.ID, in.EnvironmentID)
	if in.Enabled != nil {
		pol.Enabled = *in.Enabled
	}
	if pol.Enabled && !f.storageConfigured(w) {
		return
	}
	if in.Schedule != nil {
		pol.Schedule = *in.Schedule
	}
	if in.KeepLast != nil {
		pol.KeepLast = *in.KeepLast
	}
	switch raw := strings.TrimSpace(string(in.MaxAgeDays)); raw {
	case "":
	case "null":
		pol.MaxAgeDays = nil
	default:
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > api.MaxMaxAgeDays {
			apiError(w, http.StatusBadRequest, "invalid_request", "max_age_days: Number must be between 1 and 3650")
			return
		}
		pol.MaxAgeDays = &n
	}
	if pol.ID == nil {
		pol.ID = str(f.nextID("bpl"))
	}
	f.dataState().policies[s.ID+"/"+in.EnvironmentID] = &pol
	writeJSON(w, http.StatusOK, pol)
}

func (f *Fake) listBackups(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	env, ok := environment(w, r, p, true)
	if !ok {
		return
	}
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		limit, _ = strconv.Atoi(l)
	}
	cursor := r.URL.Query().Get("cursor")
	var all []api.Backup
	bs := f.dataState().backups
	for i := len(bs) - 1; i >= 0; i-- {
		b := bs[i]
		if b.ServiceID == s.ID && b.EnvironmentID == env && b.Status != api.BackupDeleted && (cursor == "" || b.ID < cursor) {
			all = append(all, *b)
		}
	}
	page := api.BackupPage{Backups: all[:min(limit, len(all))]}
	if page.Backups == nil {
		page.Backups = []api.Backup{}
	}
	if len(all) > limit {
		page.NextCursor = str(page.Backups[limit-1].ID)
	}
	writeJSON(w, http.StatusOK, page)
}

func (f *Fake) createBackup(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	var in struct {
		EnvironmentID string `json:"environment_id"`
	}
	if decode(r, &in) != nil || !slices.ContainsFunc(p.Environments, func(e api.Environment) bool { return e.ID == in.EnvironmentID }) {
		apiError(w, http.StatusBadRequest, "invalid_request", "environment_id: Required")
		return
	}
	if !f.storageConfigured(w) {
		return
	}
	v := f.volumeOf(s.ID, in.EnvironmentID)
	if v == nil {
		apiError(w, http.StatusConflict, "conflict", s.Name+" has no volume in this environment to back up")
		return
	}
	b := &api.Backup{ID: f.nextID("bak"), ProjectID: p.ID, ServiceID: s.ID, EnvironmentID: in.EnvironmentID, VolumeID: &v.ID,
		Trigger: "manual", Method: "dump", Status: api.BackupQueued, Pinned: true, RequestedBy: str(f.user.ID), CreatedAt: Now}
	if s.Database != nil {
		b.Engine, b.EngineVersion = str(s.Database.Engine), str(s.Database.Version)
	}
	f.dataState().backups = append(f.dataState().backups, b)
	writeJSON(w, http.StatusAccepted, b)
}

func (f *Fake) findBackup(w http.ResponseWriter, id string) *api.Backup {
	if b := f.dataState().backup(id); b != nil && b.Status != api.BackupDeleted {
		return b
	}
	apiError(w, http.StatusNotFound, "not_found", "Backup not found")
	return nil
}

func (f *Fake) getBackup(w http.ResponseWriter, r *http.Request) {
	b := f.findBackup(w, r.PathValue("backupId"))
	if b == nil {
		return
	}
	if h := f.dataState().onGetBackup; h != nil {
		h(b)
	}
	writeJSON(w, http.StatusOK, b)
}

func (f *Fake) backupDownload(w http.ResponseWriter, r *http.Request) {
	b := f.findBackup(w, r.PathValue("backupId"))
	if b == nil || !f.storageConfigured(w) {
		return
	}
	if b.Status != api.BackupSucceeded {
		apiError(w, http.StatusConflict, "conflict", "Only a succeeded backup can be downloaded")
		return
	}
	writeJSON(w, http.StatusOK, api.BackupDownload{URL: f.URL + "/_objects/" + b.ID + "?X-Amz-Signature=presigned",
		ExpiresAt: Now + 15*60000, Filename: b.ID + ".rhbk.zst.age", SHA256: b.SHA256})
}

// serveObject plays object storage: no session, no API token.
func (f *Fake) serveObject(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	obj, ok := f.dataState().objects[r.PathValue("backupId")]
	f.mu.Unlock()
	if !ok || r.URL.Query().Get("X-Amz-Signature") != "presigned" || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(obj)))
	_, _ = io.Copy(w, bytes.NewReader(obj))
}

func (f *Fake) backupKey(w http.ResponseWriter, r *http.Request) {
	b := f.findBackup(w, r.PathValue("backupId"))
	if b == nil || !f.freshSession(w, r) {
		return
	}
	id := f.dataState().identity
	writeJSON(w, http.StatusOK, api.BackupDecryptionKey{Identity: id.String(), Recipient: id.Recipient().String()})
}

// BackupIdentity is the project's backup key, for tests that check it is
// never printed.
func (f *Fake) BackupIdentity() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.dataState().identity.String()
}

func (f *Fake) restoreBackup(w http.ResponseWriter, r *http.Request) {
	b := f.findBackup(w, r.PathValue("backupId"))
	if b == nil || !f.freshSession(w, r) {
		return
	}
	var in api.RestoreBackupInput
	if decode(r, &in) != nil || !slices.Contains(api.RestoreModes, in.Mode) {
		apiError(w, http.StatusBadRequest, "invalid_request", "mode: Invalid enum value")
		return
	}
	_, s := f.serviceOf(b.ServiceID)
	if s == nil || in.Confirm != s.Slug {
		apiError(w, http.StatusBadRequest, "invalid_request", "confirm must equal the service's slug")
		return
	}
	if in.Mode == api.RestoreInPlace && (in.TargetEnvironmentID != "" || in.Slug != "") {
		apiError(w, http.StatusBadRequest, "invalid_request", "in_place restores into the backup's environment")
		return
	}
	if in.Mode == api.RestoreNewService {
		f.restoreNewService(w, b, s, in)
		return
	}
	if b.Status != api.BackupSucceeded {
		apiError(w, http.StatusConflict, "conflict", "Only a succeeded backup can be restored")
		return
	}
	if !f.storageConfigured(w) {
		return
	}
	d := f.dataState()
	for _, x := range d.restores {
		if x.TargetServiceID != nil && *x.TargetServiceID == s.ID && (x.Status == "queued" || x.Status == "running") {
			apiError(w, http.StatusConflict, "conflict", "Restore "+x.ID+" is already running for this service")
			return
		}
	}
	rst := &api.Restore{ID: f.nextID("rst"), BackupID: b.ID, Mode: in.Mode, TargetServiceID: &s.ID, TargetEnvironmentID: &b.EnvironmentID,
		Status: "queued", RequestedBy: str(f.user.ID), CreatedAt: Now}
	if !in.SkipSafetyBackup {
		safety := &api.Backup{ID: f.nextID("bak"), ProjectID: b.ProjectID, ServiceID: s.ID, EnvironmentID: b.EnvironmentID,
			Trigger: "pre_restore", Method: b.Method, Status: api.BackupQueued, CreatedAt: Now}
		d.backups = append(d.backups, safety)
		rst.SafetyBackupID = &safety.ID
	}
	d.restores = append(d.restores, rst)
	writeJSON(w, http.StatusAccepted, rst)
}

// restoreNewService mirrors startNewServiceRestore: only a dump of a
// database restores into a new service, which is added next to the
// original as <slug>-restore-<yyyymmdd>.
func (f *Fake) restoreNewService(w http.ResponseWriter, b *api.Backup, s *api.Service, in api.RestoreBackupInput) {
	engine := deref(b.Engine)
	if engine == "" && s.Database != nil {
		engine = s.Database.Engine
	}
	if engine == "" || b.Method != "dump" {
		msg := "Only a database backup can be restored into a new service; restore this snapshot in place"
		if engine != "" {
			msg = "A snapshot of a database carries its passwords; restore it in place, or restore a dump into a new service"
		}
		apiError(w, http.StatusUnprocessableEntity, "restore_mode_unsupported", msg)
		return
	}
	if b.Status != api.BackupSucceeded {
		apiError(w, http.StatusConflict, "conflict", "Only a succeeded backup can be restored")
		return
	}
	if !f.storageConfigured(w) {
		return
	}
	p, _ := f.serviceOf(s.ID)
	envID := cmp.Or(in.TargetEnvironmentID, b.EnvironmentID)
	if !slices.ContainsFunc(p.Environments, func(e api.Environment) bool { return e.ID == envID }) {
		apiError(w, http.StatusNotFound, "not_found", "Environment not found")
		return
	}
	slug := cmp.Or(in.Slug, s.Slug+"-restore-"+time.UnixMilli(Now).UTC().Format("20060102"))
	taken := func(x string) bool {
		return slices.ContainsFunc(p.Services, func(y api.Service) bool { return y.Slug == x })
	}
	if in.Slug != "" && taken(slug) {
		apiError(w, http.StatusConflict, "conflict", "A service with slug "+slug+" already exists")
		return
	}
	slug = uniqueSlug(slug, taken)
	version := deref(b.EngineVersion)
	if version == "" && s.Database != nil {
		version = s.Database.Version
	}
	spec := engineSpecs[engine]
	svc := api.Service{ID: f.nextID("svc"), ProjectID: p.ID, Name: s.Name + " restore " + time.UnixMilli(Now).UTC().Format("2006-01-02"),
		Slug: slug, Kind: "database", Database: &api.ServiceDatabase{Engine: engine, Version: version}, CreatedAt: Now, UpdatedAt: Now}
	p.Services = append(p.Services, svc)
	port := spec.port
	for _, e := range p.Environments {
		f.configs[svc.ID+"/"+e.ID] = config(svc.ID, e.ID, api.ServiceSource{Type: "image", Image: engine + ":" + version}, &port)
		f.newVolume(p.ID, e.ID, svc.ID, spec.mount, api.DefaultVolumeMB)
		f.vars[varKey(svc.ID, e.ID)] = connectionVariables(engine)
	}
	rst := &api.Restore{ID: f.nextID("rst"), BackupID: b.ID, Mode: api.RestoreNewService, TargetServiceID: &svc.ID,
		TargetEnvironmentID: &envID, Status: "queued", RequestedBy: str(f.user.ID), CreatedAt: Now}
	d := f.dataState()
	d.restores = append(d.restores, rst)
	writeJSON(w, http.StatusAccepted, rst)
}

func (f *Fake) getRestore(w http.ResponseWriter, r *http.Request) {
	d := f.dataState()
	i := slices.IndexFunc(d.restores, func(x *api.Restore) bool { return x.ID == r.PathValue("restoreId") })
	if i < 0 {
		apiError(w, http.StatusNotFound, "not_found", "Restore not found")
		return
	}
	if d.onGetRestore != nil {
		d.onGetRestore(d.restores[i])
	}
	writeJSON(w, http.StatusOK, d.restores[i])
}
