package apitest

import (
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
)

// Seeded cron service, added by [Fake.SeedCron].
const (
	CronServiceID = "svc_cron"
	// CronDeployID is the armed deployment of the cron service in production.
	CronDeployID = "dep_cron"
	// CronNextRun is the seeded schedule's next slot: 2026-10-23T03:00:00Z.
	CronNextRun = Now + 15*3600000
)

// cronState is the fake's cron schedule states and runs.
type cronState struct {
	states map[string]*api.CronState
	runs   []*api.CronRun
	// onGetRun runs on every GET of a run, under the lock, so tests can
	// advance it between polls.
	onGetRun func(r *api.CronRun)
}

func (f *Fake) cronState() *cronState {
	if f.cron == nil {
		f.cron = &cronState{states: map[string]*api.CronState{}}
	}
	return f.cron
}

// SeedCron adds a cron service "Nightly report" (slug nightly) armed in
// production with "0 3 * * *" in UTC; staging is not deployed.
func (f *Fake) SeedCron() {
	f.mu.Lock()
	defer f.mu.Unlock()
	p := f.projects[ProjectID]
	p.Services = append(p.Services, api.Service{ID: CronServiceID, ProjectID: ProjectID, Name: "Nightly report", Slug: "nightly",
		Kind: api.ServiceKindCron, CreatedAt: Now - 86400000, UpdatedAt: Now - 86400000})
	c := f.cronState()
	c.states[CronServiceID+"/"+ProductionID] = &api.CronState{ServiceID: CronServiceID, EnvironmentID: ProductionID,
		NextRunAt: i64(CronNextRun), LastScheduledFor: i64(CronNextRun - 86400000), ArmedDeploymentID: str(CronDeployID),
		Schedule: str("0 3 * * *"), Timezone: str("UTC"), NextRuns: dailySlots(CronNextRun, 3)}
}

func dailySlots(from int64, n int) []int64 {
	out := make([]int64, n)
	for i := range out {
		out[i] = from + int64(i)*86400000
	}
	return out
}

// AddCronRun stores a run of the cron service and its output; ID, project
// and timestamps are filled in when empty.
func (f *Fake) AddCronRun(r api.CronRun, logs []api.LogEntry) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.ID == "" {
		r.ID = f.nextID("crn")
	}
	r.ProjectID = ProjectID
	if r.ServiceID == "" {
		r.ServiceID = CronServiceID
	}
	if r.EnvironmentID == "" {
		r.EnvironmentID = ProductionID
	}
	if r.Trigger == "" {
		r.Trigger = "schedule"
	}
	if r.Attempt == 0 {
		r.Attempt = 1
	}
	if r.CreatedAt == 0 {
		r.CreatedAt = r.ScheduledFor
	}
	r.UpdatedAt = max(r.UpdatedAt, r.CreatedAt)
	f.cronState().runs = append(f.cronState().runs, &r)
	if logs != nil {
		f.logs["crn:"+r.ID] = logs
	}
	return r.ID
}

// AppendCronLogs adds output lines to a run, as its node would report them.
// Call it from an [Fake.OnGetCronRun] hook, which already holds the lock.
func (f *Fake) AppendCronLogs(runID string, lines ...api.LogEntry) {
	f.logs["crn:"+runID] = append(f.logs["crn:"+runID], lines...)
}

// OnGetCronRun runs h on every GET of a run, under the lock.
func (f *Fake) OnGetCronRun(h func(r *api.CronRun)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cronState().onGetRun = h
}

// CronRuns returns the stored runs, oldest first.
func (f *Fake) CronRuns() []api.CronRun {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []api.CronRun
	for _, r := range f.cronState().runs {
		out = append(out, *r)
	}
	return out
}

// CronSchedule returns a cron service's stored state in an environment.
func (f *Fake) CronSchedule(serviceID, envID string) *api.CronState {
	f.mu.Lock()
	defer f.mu.Unlock()
	if s := f.cronState().states[serviceID+"/"+envID]; s != nil {
		c := *s
		return &c
	}
	return nil
}

// -----------------------------------------------------------------------------
// Routing
// -----------------------------------------------------------------------------

// cronRoutes adds the cron routes, with the RBAC actions of
// apps/api/src/contracts/cron.ts.
func (f *Fake) cronRoutes(handlers map[api.Route]guarded) {
	for r, g := range map[api.Route]guarded{
		api.RouteCronState:     {"services:read", f.getCronState},
		api.RouteListCronRuns:  {"services:read", f.listCronRuns},
		api.RouteTriggerCron:   {"deployments:create", f.triggerCronRun},
		api.RouteGetCronRun:    {"services:read", f.getCronRun},
		api.RouteCronRunLogs:   {"services:read", f.cronRunLogs},
		api.RouteCancelCronRun: {"deployments:create", f.cancelCronRun},
		api.RoutePauseCron:     {"services:manage", f.pauseCron},
		api.RouteResumeCron:    {"services:manage", f.resumeCron},
		api.RouteCronPreview:   {"projects:read", f.previewCron},
	} {
		handlers[r] = g
	}
}

// cronServiceOf returns the service a run route acts on, for the API token
// workspace check; "" when there is none. Must hold f.mu.
func (f *Fake) cronServiceOf(r *http.Request) string {
	if run := f.cronState().run(r.PathValue("runId")); run != nil {
		return run.ServiceID
	}
	return ""
}

func (c *cronState) run(id string) *api.CronRun {
	if i := slices.IndexFunc(c.runs, func(r *api.CronRun) bool { return r.ID == id }); i >= 0 {
		return c.runs[i]
	}
	return nil
}

// cronService finds a cron service, answering 404 when it does not exist
// and 409 when it is another kind.
func (f *Fake) cronService(w http.ResponseWriter, id string) (*api.ProjectDetail, *api.Service) {
	p, s := f.service(w, id)
	if s == nil {
		return nil, nil
	}
	if s.Kind != api.ServiceKindCron {
		apiError(w, http.StatusConflict, "conflict", s.Name+" is not a cron service")
		return nil, nil
	}
	return p, s
}

// stateOf returns the stored state, or an unarmed one.
func (f *Fake) stateOf(serviceID, envID string) *api.CronState {
	if s := f.cronState().states[serviceID+"/"+envID]; s != nil {
		return s
	}
	return &api.CronState{ServiceID: serviceID, EnvironmentID: envID, NextRuns: []int64{}}
}

func (f *Fake) getCronState(w http.ResponseWriter, r *http.Request) {
	p, s := f.cronService(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	env, ok := environment(w, r, p, true)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, f.stateOf(s.ID, env))
}

func (f *Fake) listCronRuns(w http.ResponseWriter, r *http.Request) {
	p, s := f.cronService(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	env, ok := environment(w, r, p, true)
	if !ok {
		return
	}
	q := r.URL.Query()
	limit := 50
	if l := q.Get("limit"); l != "" {
		limit, _ = strconv.Atoi(l)
	}
	if limit < 1 || limit > api.CronRunPageLimit {
		apiError(w, http.StatusBadRequest, "invalid_request", "limit: Number must be between 1 and 100")
		return
	}
	status := q.Get("status")
	if status != "" && !slices.Contains(api.CronRunStatuses, status) {
		apiError(w, http.StatusBadRequest, "invalid_request", "status: Invalid enum value")
		return
	}
	cursor := q.Get("cursor")
	var all []api.CronRun
	runs := f.cronState().runs
	for i := len(runs) - 1; i >= 0; i-- {
		run := runs[i]
		if run.ServiceID == s.ID && run.EnvironmentID == env && (status == "" || run.Status == status) && (cursor == "" || run.ID < cursor) {
			all = append(all, *run)
		}
	}
	page := api.CronRunPage{Runs: all[:min(limit, len(all))]}
	if page.Runs == nil {
		page.Runs = []api.CronRun{}
	}
	if len(all) > limit {
		page.NextCursor = str(page.Runs[limit-1].ID)
	}
	writeJSON(w, http.StatusOK, page)
}

func (f *Fake) triggerCronRun(w http.ResponseWriter, r *http.Request) {
	p, s := f.cronService(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	var in api.TriggerCronRunInput
	if decode(r, &in) != nil || !slices.ContainsFunc(p.Environments, func(e api.Environment) bool { return e.ID == in.EnvironmentID }) {
		apiError(w, http.StatusBadRequest, "invalid_request", "environment_id: Required")
		return
	}
	st := f.stateOf(s.ID, in.EnvironmentID)
	if st.ArmedDeploymentID == nil {
		apiError(w, http.StatusConflict, "conflict", s.Name+" is not deployed in this environment")
		return
	}
	var active []*api.CronRun
	for _, run := range f.cronState().runs {
		if run.ServiceID == s.ID && run.EnvironmentID == in.EnvironmentID && !api.IsCronRunFinished(run.Status) {
			active = append(active, run)
		}
	}
	if len(active) > 0 && !in.Force {
		apiError(w, http.StatusConflict, "run_in_progress", "A run of "+s.Name+" is already in progress")
		return
	}
	for _, run := range active {
		run.Status, run.FinishedAt, run.UpdatedAt = api.CronCancelled, i64(Now), Now
	}
	run := &api.CronRun{ID: f.nextID("crn"), ProjectID: p.ID, ServiceID: s.ID, EnvironmentID: in.EnvironmentID,
		DeploymentID: st.ArmedDeploymentID, Trigger: "manual", ScheduledFor: Now, Attempt: 1, Status: api.CronQueued,
		TriggeredBy: str(f.user.ID), CreatedAt: Now, UpdatedAt: Now}
	f.cronState().runs = append(f.cronState().runs, run)
	writeJSON(w, http.StatusCreated, run)
}

func (f *Fake) findCronRun(w http.ResponseWriter, id string) *api.CronRun {
	if run := f.cronState().run(id); run != nil {
		return run
	}
	apiError(w, http.StatusNotFound, "not_found", "Cron run not found")
	return nil
}

func (f *Fake) getCronRun(w http.ResponseWriter, r *http.Request) {
	run := f.findCronRun(w, r.PathValue("runId"))
	if run == nil {
		return
	}
	if h := f.cronState().onGetRun; h != nil {
		h(run)
	}
	writeJSON(w, http.StatusOK, run)
}

func (f *Fake) cronRunLogs(w http.ResponseWriter, r *http.Request) {
	if f.findCronRun(w, r.PathValue("runId")) == nil {
		return
	}
	f.getLogs(w, r)
}

// cancelCronRun cancels a queued run at once; a running one stays running
// until its node reports, as on the real control plane.
func (f *Fake) cancelCronRun(w http.ResponseWriter, r *http.Request) {
	run := f.findCronRun(w, r.PathValue("runId"))
	if run == nil {
		return
	}
	if api.IsCronRunFinished(run.Status) {
		apiError(w, http.StatusConflict, "conflict", "This run already finished")
		return
	}
	if run.Status == api.CronQueued {
		run.Status, run.FinishedAt, run.UpdatedAt = api.CronCancelled, i64(Now), Now
	}
	writeJSON(w, http.StatusOK, run)
}

func (f *Fake) setPaused(w http.ResponseWriter, r *http.Request, paused bool) {
	p, s := f.cronService(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	var in api.CronEnvironmentInput
	if decode(r, &in) != nil || !slices.ContainsFunc(p.Environments, func(e api.Environment) bool { return e.ID == in.EnvironmentID }) {
		apiError(w, http.StatusBadRequest, "invalid_request", "environment_id: Required")
		return
	}
	st := f.stateOf(s.ID, in.EnvironmentID)
	f.cronState().states[s.ID+"/"+in.EnvironmentID] = st
	st.Paused = paused
	switch {
	case paused || st.ArmedDeploymentID == nil:
		st.NextRunAt, st.NextRuns = nil, []int64{}
	default:
		st.NextRunAt, st.NextRuns = i64(CronNextRun), dailySlots(CronNextRun, 3)
	}
	writeJSON(w, http.StatusOK, st)
}

func (f *Fake) pauseCron(w http.ResponseWriter, r *http.Request)  { f.setPaused(w, r, true) }
func (f *Fake) resumeCron(w http.ResponseWriter, r *http.Request) { f.setPaused(w, r, false) }

// fakeZones are the time zones the fake's preview knows.
var fakeZones = []string{"UTC", "Europe/Berlin", "America/New_York"}

// previewCron checks each field of a five-field schedule loosely and, when
// it passes, answers with hourly slots: enough for a client to render.
func (f *Fake) previewCron(w http.ResponseWriter, r *http.Request) {
	if f.project(w, r.PathValue("projectId")) == nil {
		return
	}
	q := r.URL.Query()
	schedule, tz := q.Get("schedule"), cmpOr(q.Get("timezone"), "UTC")
	count := 5
	if c := q.Get("count"); c != "" {
		count, _ = strconv.Atoi(c)
	}
	if schedule == "" || count < 1 || count > 10 {
		apiError(w, http.StatusBadRequest, "invalid_request", "Invalid query")
		return
	}
	fail := func(code, msg string, start, end int) {
		writeJSON(w, http.StatusOK, api.CronPreview{NextRuns: []int64{}, Error: &api.ScheduleError{Code: code, Message: msg, Start: start, End: end}})
	}
	if err, start, end := checkSchedule(schedule); err != "" {
		fail("invalid_schedule", err, start, end)
		return
	}
	if !slices.Contains(fakeZones, tz) {
		fail("invalid_timezone", "Unknown time zone "+tz, 0, len(tz))
		return
	}
	next := make([]int64, count)
	for i := range next {
		next[i] = Now + int64(i+1)*3600000
	}
	writeJSON(w, http.StatusOK, api.CronPreview{Valid: true, NextRuns: next})
}

func cmpOr(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// fieldMax are the upper bounds of the five fields.
var fieldMax = []int{59, 23, 31, 12, 7}

// checkSchedule returns the first problem in schedule and its byte span.
func checkSchedule(schedule string) (msg string, start, end int) {
	if strings.HasPrefix(schedule, "@") {
		if slices.Contains([]string{"@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly"}, schedule) {
			return "", 0, 0
		}
		return "Unknown macro " + schedule, 0, len(schedule)
	}
	var spans [][2]int
	for i := 0; i < len(schedule); {
		for i < len(schedule) && schedule[i] == ' ' {
			i++
		}
		j := i
		for j < len(schedule) && schedule[j] != ' ' {
			j++
		}
		if j > i {
			spans = append(spans, [2]int{i, j})
		}
		i = j
	}
	if len(spans) != 5 {
		return "Expected 5 fields, got " + strconv.Itoa(len(spans)), 0, len(schedule)
	}
	for k, sp := range spans {
		field := schedule[sp[0]:sp[1]]
		for _, part := range strings.FieldsFunc(field, func(r rune) bool { return r == ',' || r == '-' || r == '/' }) {
			if part == "*" {
				continue
			}
			n, err := strconv.Atoi(part)
			if err != nil {
				return "Unsupported value " + part, sp[0], sp[1]
			}
			if n > fieldMax[k] {
				return part + " is out of range (max " + strconv.Itoa(fieldMax[k]) + ")", sp[0], sp[1]
			}
		}
	}
	return "", 0, 0
}
