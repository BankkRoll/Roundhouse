package cli

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

func intp(n int) *int { return &n }

// seedCronRuns adds three production runs of the cron service, oldest
// first: a scheduled success with output, a failure and a missed record.
func seedCronRuns(h *harness) (ok, failed, missed string) {
	slot := apitest.CronNextRun - 3*86400000
	ok = h.fake.AddCronRun(api.CronRun{ScheduledFor: slot, Status: api.CronSucceeded, NodeID: strp(apitest.NodeID),
		ExitCode: intp(0), StartedAt: i64p(slot + 2000), FinishedAt: i64p(slot + 67000)},
		[]api.LogEntry{{TS: slot + 3000, Stream: "stdout", Text: "report sent"}})
	slot += 86400000
	failed = h.fake.AddCronRun(api.CronRun{ScheduledFor: slot, Status: api.CronFailed, NodeID: strp(apitest.NodeID),
		ExitCode: intp(3), Error: strp("exited with code 3"), StartedAt: i64p(slot + 1000), FinishedAt: i64p(slot + 5000)}, nil)
	slot += 86400000
	missed = h.fake.AddCronRun(api.CronRun{ScheduledFor: slot, Status: api.CronMissed, MissedCount: intp(2)}, nil)
	return ok, failed, missed
}

func TestCronNoService(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.expect(exitcode.NotFound, "", "cron", "status")
	contains(t, r.stderr, "has no cron services")
	h.fake.SeedCron()
	r = h.expect(exitcode.Conflict, "", "cron", "status", "--service", "api")
	contains(t, r.stderr, "API is not a cron service")
}

func TestCronStatus(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.SeedCron()
	r := h.ok("", "cron", "status")
	for _, want := range []string{"Nightly report in production", "Schedule   0 3 * * * (UTC)", "State      active",
		"Deployment " + apitest.CronDeployID, "Next runs  2026-10-23 03:00 UTC, 2026-10-24 03:00 UTC, 2026-10-25 03:00 UTC",
		"Last slot  2026-10-22 03:00 UTC"} {
		contains(t, r.stdout, want)
	}
	r = h.ok("", "cron", "status", "--environment", "staging")
	contains(t, r.stdout, "not deployed; run `roundhouse deploy` to arm it")

	r = h.ok("", "cron", "status", "--json")
	var st api.CronState
	if err := json.Unmarshal([]byte(r.stdout), &st); err != nil || st.ArmedDeploymentID == nil || len(st.NextRuns) != 3 {
		t.Errorf("--json = %s", r.stdout)
	}
}

func TestCronRuns(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.SeedCron()
	r := h.ok("", "cron", "runs")
	contains(t, r.stdout, "No runs of Nightly report in production")

	ok, failed, missed := seedCronRuns(h)
	r = h.ok("", "cron", "runs")
	lines := strings.Split(strings.TrimSpace(r.stdout), "\n")
	if len(lines) != 5 || strings.Join(strings.Fields(lines[0]), " ") != "ID STATUS TRIGGER SLOT STARTED DURATION EXIT NODE" {
		t.Fatalf("runs:\n%s", r.stdout)
	}
	if !strings.HasPrefix(lines[1], missed) || !strings.HasPrefix(lines[2], failed) || !strings.HasPrefix(lines[3], ok) {
		t.Errorf("not newest first:\n%s", r.stdout)
	}
	for _, want := range []string{"missed (2)", "2026-10-20 03:00 UTC", "1m 05s", apitest.NodeID} {
		contains(t, r.stdout, want)
	}
	contains(t, lines[2], "failed")
	contains(t, lines[4], "failed "+failed+": exited with code 3")

	r = h.ok("", "cron", "runs", "--status", "failed", "--json")
	var page api.CronRunPage
	if err := json.Unmarshal([]byte(r.stdout), &page); err != nil || len(page.Runs) != 1 || page.Runs[0].ID != failed {
		t.Errorf("--status failed = %s", r.stdout)
	}
	r = h.ok("", "cron", "runs", "--limit", "1")
	contains(t, r.stderr, "note: more runs: pass --cursor "+missed)
	r = h.ok("", "cron", "runs", "--limit", "1", "--cursor", missed, "--json")
	if err := json.Unmarshal([]byte(r.stdout), &page); err != nil || len(page.Runs) != 1 || page.Runs[0].ID != failed {
		t.Errorf("page 2 = %s", r.stdout)
	}
	h.expect(exitcode.Usage, "", "cron", "runs", "--limit", "101")
	r = h.expect(exitcode.Usage, "", "cron", "runs", "--status", "exploded")
	contains(t, r.stderr, "--status must be one of queued")
}

func TestCronRun(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.SeedCron()
	r := h.ok("", "cron", "run")
	contains(t, r.stdout, "✓ Started run crn_")
	contains(t, r.stdout, "of Nightly report in production")
	body := lastBody(t, h, api.RouteTriggerCron.String())
	if body["environment_id"] != apitest.ProductionID || body["force"] != nil {
		t.Errorf("body = %v", body)
	}

	r = h.expect(exitcode.Conflict, "", "cron", "run")
	contains(t, r.stderr, "is already in progress")
	contains(t, r.stderr, "hint: pass --force to cancel it and start a new run")
	r = h.expect(exitcode.Conflict, "", "cron", "run", "--json")
	contains(t, r.stderr, `"code": "run_in_progress"`)

	r = h.ok("", "cron", "run", "--force", "--json")
	var run api.CronRun
	if err := json.Unmarshal([]byte(r.stdout), &run); err != nil || run.Trigger != "manual" || run.Status != api.CronQueued {
		t.Errorf("--json = %s", r.stdout)
	}
	if body := lastBody(t, h, api.RouteTriggerCron.String()); body["force"] != true {
		t.Errorf("body = %v", body)
	}
	if runs := h.fake.CronRuns(); len(runs) != 2 || runs[0].Status != api.CronCancelled {
		t.Errorf("runs = %+v", runs)
	}

	r = h.expect(exitcode.Conflict, "", "cron", "run", "--environment", "staging")
	contains(t, r.stderr, "is not deployed in this environment")
	contains(t, r.stderr, "hint: deploy it first")
}

func TestCronRunWait(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.SeedCron()
	polls := 0
	h.fake.OnGetCronRun(func(r *api.CronRun) {
		polls++
		switch polls {
		case 1:
			r.Status, r.StartedAt = api.CronRunning, i64p(apitest.Now)
			h.fake.AppendCronLogs(r.ID, api.LogEntry{TS: apitest.Now + 1000, Stream: "stdout", Text: "building report"})
		case 2:
			h.fake.AppendCronLogs(r.ID, api.LogEntry{TS: apitest.Now + 2000, Stream: "stderr", Text: "slow query"})
		case 3:
			r.Status, r.ExitCode, r.FinishedAt = api.CronSucceeded, intp(0), i64p(apitest.Now+42000)
			h.fake.AppendCronLogs(r.ID, api.LogEntry{TS: apitest.Now + 41000, Stream: "stdout", Text: "report sent"})
		}
	})
	r := h.ok("", "cron", "run", "--wait")
	out := r.stdout
	if strings.Count(out, "building report") != 1 || strings.Count(out, "slow query") != 1 || strings.Count(out, "report sent") != 1 ||
		strings.Index(out, "building report") > strings.Index(out, "report sent") {
		t.Errorf("logs:\n%s", out)
	}
	contains(t, r.stderr, "succeeded in 42s")

	polls = 0
	h.fake.OnGetCronRun(func(r *api.CronRun) {
		r.Status, r.ExitCode, r.Error = api.CronFailed, intp(3), strp("exited with code 3")
	})
	r = h.expect(exitcode.Error, "", "cron", "run", "--wait")
	contains(t, r.stderr, "failed (exit 3): exited with code 3")
	r = h.expect(exitcode.Error, "", "cron", "run", "--wait", "--json")
	var run api.CronRun
	if err := json.Unmarshal([]byte(r.stdout), &run); err != nil || run.Status != api.CronFailed {
		t.Errorf("--json = %s", r.stdout)
	}

	h.fake.OnGetCronRun(func(*api.CronRun) {})
	r = h.expect(exitcode.Error, "", "cron", "run", "--wait", "--force", "--timeout", "20ms")
	contains(t, r.stderr, "timed out after 20ms waiting for crn_")
}

func TestCronLogs(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.SeedCron()
	var lines []api.LogEntry
	for i := range 1500 {
		lines = append(lines, api.LogEntry{TS: apitest.Now + int64(i), Stream: "stdout", Text: "line " + strings.Repeat("x", i%3) + string(rune('a'+i%26))})
	}
	id := h.fake.AddCronRun(api.CronRun{ScheduledFor: apitest.Now, Status: api.CronSucceeded}, lines)
	r := h.ok("", "cron", "logs", id)
	if n := strings.Count(r.stdout, "\n"); n != 1500 {
		t.Errorf("printed %d lines, want 1500", n)
	}
	r = h.ok("", "cron", "logs", id, "-f", "--json")
	var first api.LogEntry
	if err := json.Unmarshal([]byte(strings.SplitN(r.stdout, "\n", 2)[0]), &first); err != nil || first.TS != apitest.Now {
		t.Errorf("first line = %s", strings.SplitN(r.stdout, "\n", 2)[0])
	}
	contains(t, r.stderr, "is succeeded; not following")

	running := h.fake.AddCronRun(api.CronRun{ScheduledFor: apitest.Now, Status: api.CronRunning}, []api.LogEntry{{TS: apitest.Now, Stream: "stdout", Text: "started"}})
	polls := 0
	h.fake.OnGetCronRun(func(r *api.CronRun) {
		polls++
		if polls == 3 {
			r.Status = api.CronTimedOut
			h.fake.AppendCronLogs(r.ID, api.LogEntry{TS: apitest.Now + 1, Stream: "system", Text: "killed after timeout"})
		}
	})
	r = h.ok("", "cron", "logs", running, "-f")
	if strings.Count(r.stdout, "started") != 1 || !strings.Contains(r.stdout, "killed after timeout") {
		t.Errorf("follow:\n%s", r.stdout)
	}
	contains(t, r.stderr, "Run "+running+" timed_out.")
	h.expect(exitcode.NotFound, "", "cron", "logs", "crn_nope")
}

func TestCronCancel(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.SeedCron()
	queued := h.fake.AddCronRun(api.CronRun{ScheduledFor: apitest.Now, Status: api.CronQueued}, nil)
	running := h.fake.AddCronRun(api.CronRun{ScheduledFor: apitest.Now, Status: api.CronRunning}, nil)
	r := h.ok("", "cron", "cancel", queued)
	contains(t, r.stdout, "✓ Cancelled run "+queued)
	r = h.ok("", "cron", "cancel", running)
	contains(t, r.stdout, "Cancelling run "+running+"; its server stops it")
	r = h.expect(exitcode.Conflict, "", "cron", "cancel", queued)
	contains(t, r.stderr, "already finished")
	contains(t, r.stderr, "hint: only a queued or running run can be cancelled")
	h.expect(exitcode.Usage, "", "cron", "cancel")
}

func TestCronPauseResume(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.SeedCron()
	r := h.ok("", "cron", "pause")
	contains(t, r.stdout, "✓ Paused Nightly report in production")
	if body := lastBody(t, h, api.RoutePauseCron.String()); body["environment_id"] != apitest.ProductionID {
		t.Errorf("body = %v", body)
	}
	if st := h.fake.CronSchedule(apitest.CronServiceID, apitest.ProductionID); !st.Paused || st.NextRunAt != nil {
		t.Errorf("state = %+v", st)
	}
	r = h.ok("", "cron", "status")
	contains(t, r.stdout, "State      paused")

	r = h.ok("", "cron", "resume")
	contains(t, r.stdout, "✓ Resumed Nightly report in production; next run 2026-10-23 03:00 UTC")
	r = h.ok("", "cron", "resume", "--json")
	var st api.CronState
	if err := json.Unmarshal([]byte(r.stdout), &st); err != nil || st.Paused || st.NextRunAt == nil {
		t.Errorf("--json = %s", r.stdout)
	}

	h.env[EnvToken] = h.fake.AddToken("ro", "workspace:read", "projects:read", "services:read")
	r = h.expect(exitcode.Forbidden, "", "cron", "pause")
	contains(t, r.stderr, "lacks the services:manage scope")
}

func TestCronPreview(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "cron", "preview", "0 3 * * *")
	contains(t, r.stdout, `Next runs of "0 3 * * *" (UTC):`)
	contains(t, r.stdout, "  2026-10-22 13:00 UTC")
	if n := strings.Count(r.stdout, " UTC\n"); n != 5 {
		t.Errorf("%d slots:\n%s", n, r.stdout)
	}
	r = h.ok("", "cron", "preview", "0", "3", "*", "*", "*", "--count", "2")
	contains(t, r.stdout, `Next runs of "0 3 * * *"`)
	if q := lastQuery(t, h, api.RouteCronPreview); q.Get("count") != "2" || q.Get("timezone") != "UTC" {
		t.Errorf("query = %v", q)
	}

	r = h.expect(exitcode.Invalid, "", "cron", "preview", "0 3 * * 8")
	contains(t, r.stderr, "error: 8 is out of range (max 7)")
	contains(t, r.stderr, "  0 3 * * 8\n          ^\n")
	r = h.expect(exitcode.Invalid, "", "cron", "preview", "0 3 * * *", "--timezone", "Mars/Olympus")
	contains(t, r.stderr, "Unknown time zone Mars/Olympus")
	contains(t, r.stderr, "  Mars/Olympus\n  ^^^^^^^^^^^^\n")

	r = h.expect(exitcode.Invalid, "", "cron", "preview", "0 3 * *", "--json")
	var pv api.CronPreview
	if err := json.Unmarshal([]byte(r.stdout), &pv); err != nil || pv.Valid || pv.Error == nil || pv.Error.Code != "invalid_schedule" {
		t.Errorf("--json = %s", r.stdout)
	}
	h.expect(exitcode.Usage, "", "cron", "preview", "@daily", "--count", "11")
}

// patchCount is how many PATCH /v1/services/{serviceId} requests were made.
func patchCount(h *harness) int {
	n := 0
	for _, req := range h.fake.Requests() {
		if req.Pattern == api.RouteUpdateService.String() {
			n++
		}
	}
	return n
}

func TestCronSet(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.SeedCron()
	r := h.ok("", "cron", "set", "--schedule", "30 4 * * *", "--timezone", "Europe/Berlin", "--timeout", "30m",
		"--retries", "2", "--retry-backoff", "90", "--starting-deadline", "0")
	for _, want := range []string{"✓ Saved the cron config of Nightly report in production (version 2)",
		"  Schedule   30 4 * * * (Europe/Berlin)\n", "  Timeout    30m\n", "  Retries    2, first after 1m 30s, doubling\n",
		"  Late start up to 0s, else missed\n", "  Overlap    forbid: a slot is skipped",
		"  Deploy to apply it: roundhouse deploy --service nightly --environment production\n"} {
		contains(t, r.stdout, want)
	}
	body := lastBody(t, h, api.RouteUpdateService.String())
	cron, _ := body["cron"].(map[string]any)
	want := map[string]any{"schedule": "30 4 * * *", "timezone": "Europe/Berlin", "timeout_s": float64(1800),
		"retries": float64(2), "retry_backoff_s": float64(90), "starting_deadline_s": float64(0)}
	if body["environment_id"] != apitest.ProductionID || len(cron) != len(want) {
		t.Errorf("body = %v", body)
	}
	for k, v := range want {
		if cron[k] != v {
			t.Errorf("cron.%s = %v, want %v", k, cron[k], v)
		}
	}

	// The armed schedule stays until a deploy; status shows both.
	r = h.ok("", "cron", "status")
	contains(t, r.stdout, "Schedule   0 3 * * * (UTC)\n")
	contains(t, r.stdout, "Saved      30 4 * * * (Europe/Berlin); deploy to apply it\n")
	contains(t, r.stdout, "History    100 runs kept\n")
	r = h.ok("", "cron", "status", "--environment", "staging")
	contains(t, r.stdout, "Schedule   0 3 * * * (UTC)\n")
	contains(t, r.stdout, "Retries    none\n")

	r = h.ok("", "cron", "set", "--concurrency", "replace", "--history-limit", "500", "--environment", "staging", "--json")
	h.golden("cron-set.json", r.stdout)
	var up api.UpdatedService
	if err := json.Unmarshal([]byte(r.stdout), &up); err != nil || up.Config == nil || up.Config.Cron == nil ||
		up.Config.Cron.Concurrency != "replace" || up.Config.Cron.Schedule != "0 3 * * *" || up.Config.EnvironmentID != apitest.StagingID {
		t.Errorf("--json = %s", r.stdout)
	}
	if body := lastBody(t, h, api.RouteUpdateService.String()); len(body["cron"].(map[string]any)) != 2 {
		t.Errorf("only the given flags are sent: %v", body)
	}
}

func TestCronSetUsage(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.SeedCron()
	for _, c := range []struct {
		args []string
		msg  string
	}{
		{nil, "nothing to change: pass --schedule"},
		{[]string{"--concurrency", "sometimes"}, "--concurrency must be one of forbid, replace, allow"},
		{[]string{"--timeout", "5s"}, "--timeout must be between 10s and 24h"},
		{[]string{"--timeout", "86401"}, "--timeout must be between 10s and 24h"},
		{[]string{"--timeout", "1.5m"}, ""},
		{[]string{"--timeout", "10.5s"}, "--timeout must be whole seconds"},
		{[]string{"--retry-backoff", "soon"}, `--retry-backoff: "soon" is not a number of seconds or a duration`},
		{[]string{"--starting-deadline", "2h"}, "--starting-deadline must be between 0s and 1h"},
		{[]string{"--retries", "6"}, "--retries must be between 0 and 5"},
		{[]string{"--history-limit", "5"}, "--history-limit must be between 10 and 1000"},
	} {
		args := append([]string{"cron", "set"}, c.args...)
		if c.msg == "" {
			h.ok("", args...)
			continue
		}
		r := h.expect(exitcode.Usage, "", args...)
		contains(t, r.stderr, c.msg)
	}
	if n := patchCount(h); n != 1 {
		t.Errorf("%d PATCH requests, want only the valid one", n)
	}
}

func TestCronSetErrors(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.SeedCron()
	r := h.expect(exitcode.Invalid, "", "cron", "set", "--schedule", "0 3 * * 8")
	contains(t, r.stderr, "error: 8 is out of range (max 7)")
	contains(t, r.stderr, "  0 3 * * 8\n          ^\n")
	r = h.expect(exitcode.Invalid, "", "cron", "set", "--timezone", "Mars/Olympus")
	contains(t, r.stderr, "Unknown time zone Mars/Olympus")
	contains(t, r.stderr, "  Mars/Olympus\n  ^^^^^^^^^^^^\n")
	r = h.expect(exitcode.Invalid, "", "cron", "set", "--schedule", "0 3 * *", "--json")
	contains(t, r.stderr, `"code": "invalid_schedule"`)
	if c := h.fake.CronSchedule(apitest.CronServiceID, apitest.ProductionID); c == nil || *c.Schedule != "0 3 * * *" {
		t.Errorf("state = %+v", c)
	}

	r = h.expect(exitcode.Conflict, "", "cron", "set", "--service", "api", "--retries", "1")
	contains(t, r.stderr, "API is not a cron service")
	h.env[EnvToken] = h.fake.AddToken("ro", "workspace:read", "projects:read", "services:read")
	r = h.expect(exitcode.Forbidden, "", "cron", "set", "--retries", "1")
	contains(t, r.stderr, "lacks the services:manage scope")
}
