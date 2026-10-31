package cli

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// testZone is the harness's local time zone: fixed, and not UTC, so local
// and UTC renderings differ in golden files.
var testZone = time.FixedZone("PDT", -7*3600)

const hour = int64(3600 * 1000)

// pitrWindows are two restorable ranges of the db service: an older one
// that ends in a gap, and one up to two minutes ago.
var pitrWindows = []api.PitrRange{
	{From: apitest.Now - 48*hour, To: apitest.Now - 30*hour},
	{From: apitest.Now - 24*hour, To: apitest.Now - 2*60000},
}

// seedPitr seeds Postgres with PITR on and pitrWindows archived.
func seedPitr(h *harness) {
	h.t.Helper()
	seedPostgres(h)
	h.ok("", "db", "backups", "policy", "set", "--pitr", "on")
	h.fake.SetPitrWindows(apitest.DBServiceID, apitest.ProductionID, pitrWindows...)
}

func TestPitrStatus(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)

	r := h.ok("", "db", "pitr", "status")
	contains(t, r.stdout, "Point-in-time recovery of Postgres in production")
	contains(t, r.stdout, "PITR          off; turn it on with `roundhouse db backups policy set --pitr on`")
	contains(t, r.stdout, "Nothing is restorable to a point in time yet")

	h.ok("", "db", "backups", "policy", "set", "--pitr", "on")
	h.fake.SetPitrWindows(apitest.DBServiceID, apitest.ProductionID, pitrWindows...)
	r = h.ok("", "db", "pitr", "status")
	h.golden("pitr-status.txt", r.stdout)
	r = h.ok("", "db", "pitr", "status", "db", "--json")
	h.golden("pitr-status.json", r.stdout)
	var st api.PitrStatus
	if err := json.Unmarshal([]byte(r.stdout), &st); err != nil || !st.Enabled || len(st.Windows) != 2 || st.BaseBackups != 2 {
		t.Errorf("--json = %s", r.stdout)
	}

	h.fake.SetPitrUnavailable(apitest.DBServiceID, apitest.ProductionID, "edge-1 runs an agent without WAL archiving; upgrade it")
	r = h.ok("", "db", "pitr", "status")
	contains(t, r.stdout, "PITR          on, but not archiving: edge-1 runs an agent without WAL archiving; upgrade it")

	r = h.ok("", "db", "pitr", "status", "api")
	contains(t, r.stdout, "Point-in-time recovery of API in production")
	contains(t, r.stdout, "PITR          unavailable: Point-in-time recovery is available for Postgres databases only")
	r = h.expect(exitcode.Usage, "", "db", "pitr", "status", "api", "--service", "db")
	contains(t, r.stderr, `the service is given twice: "api" and --service "db"`)
}

func TestPitrStatusUTC(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPitr(h)
	h.zone = time.UTC
	r := h.ok("", "db", "pitr", "status")
	contains(t, r.stdout, "Restorable windows, in UTC (the end of each is exclusive):")
	contains(t, r.stdout, "  2. 2026-10-21T12:00:00Z → 2026-10-22T11:58:00Z\n")
	notContains(t, r.stdout, "PDT")
}

func TestBackupsPolicyPitr(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)
	r := h.ok("", "db", "backups", "policy")
	contains(t, r.stdout, "PITR       off; turn it on with --pitr on")

	r = h.ok("", "db", "backups", "policy", "set", "--pitr", "on")
	contains(t, r.stdout, "Scheduled  on (base)")
	contains(t, r.stdout, "PITR       on; WAL is archived continuously (`roundhouse db pitr status`)")
	body := lastBody(t, h, api.RoutePutBackupPolicy.String())
	if body["pitr"] != true || len(body) != 2 {
		t.Errorf("body = %v", body)
	}
	if p := h.fake.BackupPolicy(apitest.DBServiceID, apitest.ProductionID); p == nil || !p.Pitr || p.Method != "base" {
		t.Errorf("policy = %+v", p)
	}

	r = h.expect(exitcode.Invalid, "", "db", "backups", "policy", "set", "--disable")
	contains(t, r.stderr, "Point-in-time recovery needs scheduled backups")
	r = h.ok("", "db", "backups", "policy", "set", "--pitr", "OFF", "--json")
	var p api.BackupPolicy
	if err := json.Unmarshal([]byte(r.stdout), &p); err != nil || p.Pitr || p.Method != "dump" {
		t.Errorf("--json = %s", r.stdout)
	}
	if body := lastBody(t, h, api.RoutePutBackupPolicy.String()); body["pitr"] != false {
		t.Errorf("body = %v", body)
	}

	r = h.expect(exitcode.Usage, "", "db", "backups", "policy", "set", "--pitr", "maybe")
	contains(t, r.stderr, "--pitr must be on or off")
	r = h.expect(exitcode.Usage, "", "db", "backups", "policy", "set", "--pitr", "on", "--disable")
	contains(t, r.stderr, "point-in-time recovery needs scheduled backups: drop --disable")

	h.fake.SetPitrUnavailable(apitest.DBServiceID, apitest.ProductionID, "The database has a custom start command; point-in-time recovery sets its own")
	r = h.expect(exitcode.Conflict, "", "db", "backups", "policy", "set", "--pitr", "on")
	contains(t, r.stderr, "The database has a custom start command")
}

func TestPitrRestoreValidation(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)

	for _, c := range []struct {
		code int
		args []string
		want string
	}{
		{exitcode.Usage, nil, "pass --to"},
		{exitcode.Usage, []string{"--to", "2026-10-22 11:50"}, `--to "2026-10-22 11:50" is not an RFC 3339 time with a zone`},
		{exitcode.Usage, []string{"--to", "2026-10-22T11:50:00"}, "is not an RFC 3339 time with a zone"},
		{exitcode.Invalid, []string{"--to", "2026-10-22T12:00:01Z"}, "--to 2026-10-22 05:00:01 PDT (2026-10-22T12:00:01Z) is in the future"},
		{exitcode.Usage, []string{"--to", "2026-10-22T11:50:00Z", "--into-new", "Not A Slug"}, `--into-new "Not A Slug" is not a slug`},
		{exitcode.Usage, []string{"--to", "2026-10-22T11:50:00Z", "--into-new", "copy", "--skip-safety-backup"}, "--skip-safety-backup applies to in-place restores only"},
	} {
		r := h.expect(c.code, "", append([]string{"db", "pitr", "restore"}, c.args...)...)
		contains(t, r.stderr, c.want)
	}

	r := h.expect(exitcode.Invalid, "", "db", "pitr", "restore", "--to", "2026-10-22T11:50:00Z", "--confirm", "db")
	contains(t, r.stderr, "error: nothing of Postgres in production is restorable to a point in time yet")
	contains(t, r.stderr, "hint: turn point-in-time recovery on with `roundhouse db backups policy set --pitr on`")

	h.ok("", "db", "backups", "policy", "set", "--pitr", "on")
	h.fake.SetPitrWindows(apitest.DBServiceID, apitest.ProductionID, pitrWindows...)
	for _, c := range []struct{ to, want, hint string }{
		{"2026-10-22T11:59:00Z", "2026-10-22 04:59:00 PDT (2026-10-22T11:59:00Z) is outside the restorable windows: 2026-10-20T12:00:00Z to 2026-10-21T06:00:00Z, 2026-10-21T12:00:00Z to 2026-10-22T11:58:00Z",
			"hint: the newest restorable point is just before 2026-10-22 04:58:00 PDT (2026-10-22T11:58:00Z); WAL newer than that is not archived yet"},
		{"2026-10-22T11:58:00Z", "is outside the restorable windows", "the newest restorable point is just before"},
		{"2026-10-19T00:00:00Z", "is outside the restorable windows", "hint: the oldest restorable point is 2026-10-20 05:00:00 PDT (2026-10-20T12:00:00Z); older WAL is no longer kept"},
		{"2026-10-21T09:00:00+02:00", "2026-10-21 00:00:00 PDT (2026-10-21T07:00:00Z) is outside", "falls in a gap with no base backup and gapless WAL"},
	} {
		r := h.expect(exitcode.Invalid, "", "db", "pitr", "restore", "--to", c.to, "--confirm", "db")
		contains(t, r.stderr, c.want)
		contains(t, r.stderr, c.hint)
	}

	r = h.expect(exitcode.InputRequired, "", "db", "pitr", "restore", "--to", "2026-10-22T11:50:00Z")
	contains(t, r.stderr, "pass --confirm db")
	r = h.expect(exitcode.Usage, "", "db", "pitr", "restore", "--to", "2026-10-22T11:50:00Z", "--confirm", "api")
	contains(t, r.stderr, `--confirm "api" does not match "db"`)
	r = h.interactive("api\n", "db", "pitr", "restore", "--to", "2026-10-22T11:50:00Z")
	if r.code != exitcode.Error {
		t.Fatalf("wrong typed slug: exit %d, %s", r.code, r.stderr)
	}
	contains(t, r.stderr, "confirmation did not match; nothing was changed")
	if n := len(h.fake.Restores()); n != 0 {
		t.Fatalf("%d restores started", n)
	}
}

func TestPitrRestoreInPlace(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPitr(h)

	r := h.interactive("db\n", "db", "pitr", "restore", "--to", "2026-10-22T04:50:00.250-07:00")
	if r.code != 0 {
		t.Fatalf("restore: exit %d, %s", r.code, r.stderr)
	}
	contains(t, r.stderr, "This restores Postgres in production to 2026-10-22 04:50:00 PDT (2026-10-22T11:50:00.25Z), replacing its current data: everything written after that moment is lost. A safety backup of the current data is taken first.")
	h.golden("pitr-restore.txt", r.stdout)
	body := lastBody(t, h, api.RoutePitrRestore.String())
	want := float64(apitest.Now - 10*60000 + 250)
	if body["target_time"] != want || body["mode"] != "in_place" || body["confirm"] != "db" ||
		body["environment_id"] != apitest.ProductionID || body["slug"] != nil || body["skip_safety_backup"] != nil {
		t.Errorf("body = %v", body)
	}
	rst := h.fake.Restores()[0]
	if rst.TargetTime == nil || *rst.TargetTime != int64(want) || rst.SafetyBackupID == nil || rst.Trigger != "manual" {
		t.Errorf("restore = %+v", rst)
	}

	r = h.expect(exitcode.Conflict, "", "db", "pitr", "restore", "db", "--to", "2026-10-22T11:50:00Z", "--confirm", "db", "--skip-safety-backup")
	contains(t, r.stderr, "is already running for this service")
}

func TestPitrRestoreWait(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPitr(h)

	polls := 0
	h.fake.OnGetRestore(func(x *api.Restore) {
		polls++
		x.Status = "running"
		if polls == 2 {
			x.Status = "succeeded"
		}
	})
	r := h.ok("", "db", "pitr", "restore", "--to", "2026-10-21T18:00:00Z", "--confirm", "db", "--skip-safety-backup", "--wait")
	contains(t, r.stdout, "✓ Restored Postgres to 2026-10-21 11:00:00 PDT (2026-10-21T18:00:00Z)")
	notContains(t, r.stdout, "Safety backup")
	if body := lastBody(t, h, api.RoutePitrRestore.String()); body["skip_safety_backup"] != true {
		t.Errorf("body = %v", body)
	}
	// The restore picks the newest base backup at or before the target.
	base := h.fake.Restores()[0].BackupID
	for _, b := range h.fake.Backups() {
		if b.ID == base && *b.FinishedAt != pitrWindows[1].From {
			t.Errorf("restored from %s finished %d, want the second window's base", base, *b.FinishedAt)
		}
	}

	h.fake.OnGetRestore(func(x *api.Restore) { x.Status, x.Error = "failed", strp("recovery target not reached") })
	r = h.expect(exitcode.Error, "", "db", "pitr", "restore", "--to", "2026-10-21T18:00:00Z", "--confirm", "db", "--wait")
	contains(t, r.stderr, "error: restore rst_")
	contains(t, r.stderr, "failed: recovery target not reached")
	r = h.expect(exitcode.Error, "", "db", "pitr", "restore", "--to", "2026-10-21T18:00:00Z", "--confirm", "db", "--wait", "--json")
	var out api.Restore
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil || out.Status != "failed" || out.TargetTime == nil {
		t.Errorf("--json = %s", r.stdout)
	}
}

func TestPitrRestoreIntoNew(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPitr(h)

	r := h.ok("", "db", "pitr", "restore", "--to", "2026-10-22T11:50:00Z", "--into-new", "db-before", "--confirm", "db")
	contains(t, r.stdout, "of Postgres in production to 2026-10-22 04:50:00 PDT (2026-10-22T11:50:00Z), into a new database Postgres restore 2026-10-22 (db-before)")
	contains(t, r.stdout, "Postgres is not touched. The data is restored once the new database runs.")
	notContains(t, r.stdout, "Safety backup")
	body := lastBody(t, h, api.RoutePitrRestore.String())
	if body["mode"] != "new_service" || body["slug"] != "db-before" {
		t.Errorf("body = %v", body)
	}

	r = h.ok("", "db", "pitr", "restore", "db", "--to", "2026-10-22T11:50:00Z", "--into-new", "db-before-2", "--confirm", "db", "--json")
	var out api.Restore
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil || out.Mode != "new_service" || out.TargetServiceID == nil ||
		out.TargetTime == nil || *out.TargetTime != apitest.Now-10*60000 {
		t.Errorf("--json = %s", r.stdout)
	}
	r = h.expect(exitcode.Conflict, "", "db", "pitr", "restore", "--service", "db", "--to", "2026-10-22T11:50:00Z", "--into-new", "db-before", "--confirm", "db")
	contains(t, r.stderr, "db-before already exists")
}

func TestPitrRestoreRefused(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPitr(h)

	h.fake.SetSessionStale(true)
	r := h.expect(exitcode.Forbidden, "", "db", "pitr", "restore", "--to", "2026-10-22T11:50:00Z", "--confirm", "db")
	contains(t, r.stderr, "error: Confirm your password to continue")
	contains(t, r.stderr, "hint: a point-in-time restore needs a recent sign-in; run `roundhouse login` again, then retry")
	r = h.expect(exitcode.Forbidden, "", "db", "pitr", "restore", "--to", "2026-10-22T11:50:00Z", "--confirm", "db", "--json")
	var out struct {
		Error struct {
			Code string `json:"code"`
			Hint string `json:"hint"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(r.stderr), &out); err != nil || out.Error.Code != "reauth_required" || !strings.Contains(out.Error.Hint, "recent sign-in") {
		t.Errorf("--json error = %s", r.stderr)
	}
	h.fake.SetSessionStale(false)

	h.env[EnvToken] = h.fake.AddToken("ci", "workspace:read", "projects:read", "services:read", "backups:restore")
	r = h.expect(exitcode.Forbidden, "", "db", "pitr", "restore", "--to", "2026-10-22T11:50:00Z", "--confirm", "db")
	contains(t, r.stderr, "hint: API tokens never count as a recent sign-in, and a point-in-time restore needs one")
	delete(h.env, EnvToken)

	// The status reports a window the planner no longer has, as when
	// retention drops WAL between the check and the restore.
	h.fake.OnGetPitrStatus(func(st *api.PitrStatus) {
		st.Windows = []api.PitrRange{{From: apitest.Now - 72*hour, To: apitest.Now - 60000}}
	})
	r = h.expect(exitcode.Invalid, "", "db", "pitr", "restore", "--to", "2026-10-19T13:00:00Z", "--confirm", "db")
	contains(t, r.stderr, "error: No base backup and archived WAL cover that time; restorable: 2026-10-20T12:00:00.000Z to 2026-10-21T06:00:00.000Z")
	contains(t, r.stderr, "hint: the windows changed since they were checked; `roundhouse db pitr status` shows them now")
	r = h.expect(exitcode.Invalid, "", "db", "pitr", "restore", "--to", "2026-10-19T13:00:00Z", "--confirm", "db", "--json")
	contains(t, r.stderr, `"code": "pitr_target_unavailable"`)
	if n := len(h.fake.Restores()); n != 0 {
		t.Fatalf("%d restores started", n)
	}
}

func TestRecoveryPolicy(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)

	r := h.ok("", "db", "recovery", "policy")
	h.golden("recovery-policy.txt", r.stdout)
	r = h.ok("", "db", "recovery", "policy", "get", "db", "--json")
	var p api.RecoveryPolicy
	if err := json.Unmarshal([]byte(r.stdout), &p); err != nil || p.ID != nil || p.Enabled || p.GraceMinutes != 30 || p.Status != "idle" {
		t.Errorf("--json = %s", r.stdout)
	}

	r = h.ok("", "db", "recovery", "policy", "set", "--enable", "--grace", "1h30m")
	contains(t, r.stdout, "✓ Saved the recovery policy")
	contains(t, r.stdout, "Recovery     on; recoveries run with the access of usr_ada, checked each time")
	contains(t, r.stdout, "Grace        1h 30m offline before recovery starts")
	body := lastBody(t, h, api.RoutePutRecoveryPolicy.String())
	if body["enabled"] != true || body["grace_minutes"] != float64(90) || body["environment_id"] != apitest.ProductionID || len(body) != 3 {
		t.Errorf("body = %v", body)
	}

	h.ok("", "db", "recovery", "policy", "set", "db", "--grace", "7d")
	body = lastBody(t, h, api.RoutePutRecoveryPolicy.String())
	if body["grace_minutes"] != float64(10080) || body["enabled"] != nil {
		t.Errorf("body = %v", body)
	}
	h.ok("", "db", "recovery", "policy", "set", "--disable", "--environment", "staging")
	if p := h.fake.RecoveryPolicy(apitest.DBServiceID, apitest.StagingID); p == nil || p.Enabled {
		t.Errorf("staging policy = %+v", p)
	}
	if p := h.fake.RecoveryPolicy(apitest.DBServiceID, apitest.ProductionID); p == nil || !p.Enabled || p.GraceMinutes != 10080 {
		t.Errorf("production policy = %+v", p)
	}

	for _, c := range []struct {
		args []string
		want string
	}{
		{nil, "nothing to change; pass --enable, --disable or --grace"},
		{[]string{"--enable", "--disable"}, "not both"},
		{[]string{"--grace", "4m"}, "--grace must be whole minutes from 5m to 7d"},
		{[]string{"--grace", "8d"}, "--grace must be whole minutes from 5m to 7d"},
		{[]string{"--grace", "169h"}, "--grace must be whole minutes"},
		{[]string{"--grace", "5m30s"}, "--grace must be whole minutes"},
		{[]string{"--grace", "soon"}, "--grace must be whole minutes"},
	} {
		r := h.expect(exitcode.Usage, "", append([]string{"db", "recovery", "policy", "set"}, c.args...)...)
		contains(t, r.stderr, c.want)
	}
}

func TestRecoveryPolicyStatus(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)
	h.fake.SetRecoveryPolicy(api.RecoveryPolicy{ID: strp("rcp_1"), ServiceID: apitest.DBServiceID, EnvironmentID: apitest.ProductionID,
		Enabled: true, GraceMinutes: 30, EnabledBy: strp("usr_ada"), Status: "blocked",
		Message: strp("No server can take the volume: every other server is offline"), LostNodeID: strp(apitest.NodeID),
		RestoreID: strp("rst_0009"), TriggeredAt: i64p(apitest.Now - 5*60000), UpdatedAt: i64p(apitest.Now - 5*60000)})
	r := h.ok("", "db", "recovery", "policy", "get")
	h.golden("recovery-policy-blocked.txt", r.stdout)
}

func TestRecoveryPolicyRefused(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)

	h.fake.SetSessionStale(true)
	r := h.expect(exitcode.Forbidden, "", "db", "recovery", "policy", "set", "--enable")
	contains(t, r.stderr, "hint: changing automatic recovery needs a recent sign-in; run `roundhouse login` again, then retry")
	h.fake.SetSessionStale(false)

	h.fake.SetBackupStorage(false)
	r = h.expect(exitcode.Conflict, "", "db", "recovery", "policy", "set", "--enable")
	contains(t, r.stderr, "Backup storage is not configured")

	r = h.expect(exitcode.Conflict, "", "db", "recovery", "policy", "set", "api", "--grace", "10m")
	contains(t, r.stderr, "The service has no volume in this environment to recover")
}

func TestVolumeAbandoned(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedBackups(h)
	addServers(h)

	r := h.ok("", "db", "volume", "abandoned")
	contains(t, r.stdout, "No abandoned copies of Postgres's volume in production.")
	r = h.ok("", "db", "volume", "abandoned", "--json")
	if strings.TrimSpace(r.stdout) != "{\n  \"copies\": []\n}" {
		t.Errorf("--json = %s", r.stdout)
	}

	h.fake.AddAbandonedCopy(apitest.DBServiceID, apitest.ProductionID, api.AbandonedCopy{VolumeID: "vol_old1", NodeID: strp("node_0003"),
		NodeName: strp("edge-3"), State: "deleted", Message: strp("Deleted from edge-3"), SizeMB: 5120, UsedBytes: i64p(900 * mib),
		AbandonedAt: i64p(apitest.Now - 96*hour), DeleteAfter: i64p(apitest.Now - 24*hour),
		DeleteSentAt: i64p(apitest.Now - 23*hour), CleanedAt: i64p(apitest.Now - 22*hour)})
	h.fake.AddAbandonedCopy(apitest.DBServiceID, apitest.ProductionID, api.AbandonedCopy{VolumeID: "vol_old2", NodeID: strp("node_0002"),
		NodeName: strp("edge-2"), State: "kept", Message: strp("A restore of the service is running; the old copy is kept until it ends"),
		SizeMB: 5120, AbandonedAt: i64p(apitest.Now - 80*hour), DeleteAfter: i64p(apitest.Now - 8*hour)})
	h.fake.SetNodeStatus(apitest.NodeID, "offline")
	h.ok("", "db", "volume", "recover", "--to", "edge-2", "--yes")

	r = h.ok("", "db", "volume", "abandoned", "db")
	h.golden("volume-abandoned.txt", r.stdout)
	r = h.ok("", "db", "volume", "abandoned", "--json")
	h.golden("volume-abandoned.json", r.stdout)
	var list api.AbandonedCopyList
	if err := json.Unmarshal([]byte(r.stdout), &list); err != nil || len(list.Copies) != 3 || list.Copies[0].State != "waiting_for_server" {
		t.Errorf("--json = %s", r.stdout)
	}
}

func TestParseGrace(t *testing.T) {
	for in, want := range map[string]int{"5m": 5, "30m": 30, "1h": 60, "2h30m": 150, "7d": 10080, "168h": 10080, " 1d ": 1440} {
		if got, err := parseGrace(in); err != nil || got != want {
			t.Errorf("parseGrace(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, in := range []string{"", "4m", "8d", "-5m", "1.5d", "90s", "5m1s", "d"} {
		if _, err := parseGrace(in); exitcode.Of(err) != exitcode.Usage {
			t.Errorf("parseGrace(%q) = %v, want a usage error", in, err)
		}
	}
	for in, want := range map[int]string{5: "5m", 30: "30m", 60: "1h", 90: "1h 30m", 1440: "1d", 10080: "7d", 1501: "1d 1h 1m"} {
		if got := formatGrace(in); got != want {
			t.Errorf("formatGrace(%d) = %q, want %q", in, got, want)
		}
	}
}
