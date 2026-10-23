package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"filippo.io/age"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// dumpPayload stands in for a backup's decrypted content.
var dumpPayload = []byte("RHBK1\n" + strings.Repeat("pg_custom dump bytes ", 4000))

// seedBackups adds three production backups of the db service, newest
// last: a scheduled success, a failure and a pinned manual success.
func seedBackups(h *harness) (scheduled, failed, manual string) {
	seedPostgres(h)
	base := api.Backup{ServiceID: apitest.DBServiceID, EnvironmentID: apitest.ProductionID}
	b := base
	b.StartedAt, b.FinishedAt, b.CreatedAt = i64p(apitest.Now-7200000), i64p(apitest.Now-7200000+65000), apitest.Now-7200000
	scheduled = h.fake.AddBackup(b, dumpPayload)
	b = base
	b.Status, b.Error, b.CreatedAt = api.BackupFailed, strp("node_offline: edge-1 is offline"), apitest.Now-3600000
	failed = h.fake.AddBackup(b, nil)
	b = base
	b.Trigger, b.Pinned, b.CreatedAt = "manual", true, apitest.Now-600000
	b.StartedAt, b.FinishedAt = i64p(apitest.Now-600000), i64p(apitest.Now-600000+4000)
	manual = h.fake.AddBackup(b, dumpPayload)
	return scheduled, failed, manual
}

func i64p(n int64) *int64   { return &n }
func strp(s string) *string { return &s }

func TestBackupsList(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.expect(exitcode.NotFound, "", "db", "backups", "list")
	contains(t, r.stderr, "has no databases")

	seedPostgres(h)
	r = h.ok("", "db", "backups", "list")
	contains(t, r.stdout, "No backups of Postgres in production. Take one with `roundhouse db backups run`.")

	scheduled, failed, manual := seedBackups(h)
	r = h.ok("", "db", "backups", "list")
	lines := strings.Split(strings.TrimSpace(r.stdout), "\n")
	if len(lines) != 5 || strings.Join(strings.Fields(lines[0]), " ") != "ID STATUS TRIGGER SIZE TOOK CREATED" {
		t.Fatalf("list:\n%s", r.stdout)
	}
	if !strings.HasPrefix(lines[1], manual) || !strings.HasPrefix(lines[2], failed) || !strings.HasPrefix(lines[3], scheduled) {
		t.Errorf("not newest first:\n%s", r.stdout)
	}
	for _, want := range []string{"manual (pinned)", "4s", "10m ago", "1m 05s", "2h ago", "KiB"} {
		contains(t, r.stdout, want)
	}
	contains(t, lines[4], "failed "+failed+": node_offline: edge-1 is offline")

	r = h.ok("", "db", "backups", "list", "--limit", "1")
	contains(t, r.stderr, "note: more backups: pass --cursor "+manual)
	r = h.ok("", "db", "backups", "list", "--limit", "1", "--cursor", manual, "--json")
	var page api.BackupPage
	if err := json.Unmarshal([]byte(r.stdout), &page); err != nil || len(page.Backups) != 1 || page.Backups[0].ID != failed || page.NextCursor == nil {
		t.Errorf("page = %s", r.stdout)
	}
	h.expect(exitcode.Usage, "", "db", "backups", "list", "--limit", "101")
}

func TestBackupsRun(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)
	r := h.ok("", "db", "backups", "run")
	contains(t, r.stdout, "✓ Queued backup bak_")
	contains(t, r.stdout, "of Postgres in production")
	body := lastBody(t, h, api.RouteCreateBackup.String())
	if body["environment_id"] != apitest.ProductionID {
		t.Errorf("body = %v", body)
	}

	polls := 0
	h.fake.OnGetBackup(func(b *api.Backup) {
		polls++
		switch polls {
		case 1:
			b.Status = api.BackupRunning
		case 2:
			n := int64(3 * mib)
			b.Status, b.BytesStored, b.StartedAt, b.FinishedAt = api.BackupSucceeded, &n, i64p(apitest.Now), i64p(apitest.Now+42000)
		}
	})
	r = h.ok("", "db", "backups", "run", "--wait")
	contains(t, r.stdout, "succeeded: 3.0 MiB stored in 42s")

	polls = 0
	h.fake.OnGetBackup(func(b *api.Backup) { b.Status, b.Error = api.BackupFailed, strp("dump exited 1") })
	r = h.expect(exitcode.Error, "", "db", "backups", "run", "--wait")
	contains(t, r.stderr, "failed: dump exited 1")
	r = h.expect(exitcode.Error, "", "db", "backups", "run", "--wait", "--json")
	var b api.Backup
	if err := json.Unmarshal([]byte(r.stdout), &b); err != nil || b.Status != api.BackupFailed {
		t.Errorf("--json = %s", r.stdout)
	}

	h.fake.OnGetBackup(func(*api.Backup) {})
	r = h.expect(exitcode.Error, "", "db", "backups", "run", "--wait", "--timeout", "20ms")
	contains(t, r.stderr, "timed out after 20ms waiting for bak_")

	h.fake.SetBackupStorage(false)
	r = h.expect(exitcode.Conflict, "", "db", "backups", "run")
	contains(t, r.stderr, "Backup storage is not configured; an instance admin sets it under Settings → Backups")
	r = h.expect(exitcode.Conflict, "", "db", "backups", "run", "--json")
	contains(t, r.stderr, `"code": "backup_storage_not_configured"`)

	h.env[EnvToken] = h.fake.AddToken("ro", "workspace:read", "projects:read", "services:read")
	r = h.expect(exitcode.Forbidden, "", "db", "backups", "run")
	contains(t, r.stderr, "lacks the backups:manage scope")
}

func TestBackupsPolicy(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)
	r := h.ok("", "db", "backups", "policy")
	for _, want := range []string{"Backups of Postgres in production (defaults; not saved yet)", "Scheduled  on (dump)",
		"0 3 * * * (UTC)", "Next runs  2026-10-23 03:00 UTC", "the last 7 scheduled backups", "Max age    none"} {
		contains(t, r.stdout, want)
	}

	r = h.ok("", "db", "backups", "policy", "set", "--schedule", "0  2 * * *", "--keep-last", "14", "--max-age-days", "30")
	contains(t, r.stdout, "✓ Saved the backup policy")
	contains(t, r.stdout, "0 2 * * * (UTC)")
	contains(t, r.stdout, "the last 14 scheduled backups")
	contains(t, r.stdout, "Max age    30 days")
	body := lastBody(t, h, api.RoutePutBackupPolicy.String())
	if body["environment_id"] != apitest.ProductionID || body["schedule"] != "0 2 * * *" || body["keep_last"] != float64(14) ||
		body["max_age_days"] != float64(30) || len(body) != 4 {
		t.Errorf("body = %v", body)
	}

	h.ok("", "db", "backups", "policy", "set", "--no-max-age", "--disable")
	body = lastBody(t, h, api.RoutePutBackupPolicy.String())
	if v, ok := body["max_age_days"]; !ok || v != nil || body["enabled"] != false || len(body) != 3 {
		t.Errorf("body = %v", body)
	}
	p := h.fake.BackupPolicy(apitest.DBServiceID, apitest.ProductionID)
	if p == nil || p.Enabled || p.MaxAgeDays != nil || p.KeepLast != 14 {
		t.Errorf("policy = %+v", p)
	}
	r = h.ok("", "db", "backups", "policy", "--json")
	var got api.BackupPolicy
	if err := json.Unmarshal([]byte(r.stdout), &got); err != nil || got.ID == nil || got.Enabled {
		t.Errorf("--json = %s", r.stdout)
	}

	for _, c := range []struct {
		args []string
		want string
	}{
		{nil, "nothing to change"},
		{[]string{"--schedule", "daily"}, "five-field cron expression"},
		{[]string{"--keep-last", "0"}, "--keep-last must be between 1 and 365"},
		{[]string{"--max-age-days", "4000"}, "--max-age-days must be between 1 and 3650"},
		{[]string{"--max-age-days", "3", "--no-max-age"}, "not both"},
		{[]string{"--enable", "--disable"}, "not both"},
	} {
		r := h.expect(exitcode.Usage, "", append([]string{"db", "backups", "policy", "set"}, c.args...)...)
		contains(t, r.stderr, c.want)
	}

	h.fake.SetBackupStorage(false)
	r = h.expect(exitcode.Conflict, "", "db", "backups", "policy", "set", "--enable")
	contains(t, r.stderr, "Backup storage is not configured")
}

func TestBackupsRestore(t *testing.T) {
	h := newHarness(t)
	h.link()
	_, failed, manual := seedBackups(h)

	r := h.expect(exitcode.Usage, "", "db", "backups", "restore", manual)
	contains(t, r.stderr, `required flag(s) "mode" not set`)
	h.expect(exitcode.Usage, "", "db", "backups", "restore", manual, "--mode", "sideways")
	h.expect(exitcode.Usage, "", "db", "backups", "restore", manual, "--mode", "new_service", "--skip-safety-backup")
	r = h.expect(exitcode.InputRequired, "", "db", "backups", "restore", manual, "--mode", "in_place")
	contains(t, r.stderr, "pass --confirm db")
	r = h.expect(exitcode.Usage, "", "db", "backups", "restore", manual, "--mode", "in_place", "--confirm", "api")
	contains(t, r.stderr, `--confirm "api" does not match "db"`)
	r = h.expect(exitcode.Conflict, "", "db", "backups", "restore", failed, "--mode", "in_place", "--confirm", "db")
	contains(t, r.stderr, "only a succeeded backup can be restored")
	h.expect(exitcode.NotFound, "", "db", "backups", "restore", "bak_nope", "--mode", "in_place", "--confirm", "db")
	if n := len(h.fake.Restores()); n != 0 {
		t.Fatalf("%d restores started", n)
	}

	r = h.interactive("db\n", "db", "backups", "restore", manual, "--mode", "in_place")
	if r.code != 0 {
		t.Fatalf("restore: exit %d, %s", r.code, r.stderr)
	}
	contains(t, r.stderr, "This replaces the data of Postgres with backup "+manual+" from 2026-10-22 11:50 UTC. A safety backup of the current data is taken first.")
	contains(t, r.stdout, "✓ Started restore rst_")
	contains(t, r.stdout, "of "+manual+" in place into Postgres")
	contains(t, r.stdout, "Safety backup: bak_")
	body := lastBody(t, h, api.RouteRestoreBackup.String())
	if body["mode"] != "in_place" || body["confirm"] != "db" || body["skip_safety_backup"] != nil {
		t.Errorf("body = %v", body)
	}

	r = h.expect(exitcode.Unavailable, "", "db", "backups", "restore", manual, "--mode", "new_service", "--confirm", "db")
	contains(t, r.stderr, "Restoring into a new service isn't available yet")
	contains(t, r.stderr, "hint: restore in place instead: --mode in_place")
}

func TestBackupsRestoreWait(t *testing.T) {
	h := newHarness(t)
	h.link()
	_, _, manual := seedBackups(h)
	h.fake.OnGetRestore(func(x *api.Restore) { x.Status = "succeeded" })
	r := h.ok("", "db", "backups", "restore", manual, "--mode", "in_place", "--confirm", "db", "--wait")
	contains(t, r.stdout, "✓ Restore rst_")
	contains(t, r.stdout, "succeeded")

	h.fake.OnGetRestore(func(x *api.Restore) { x.Status, x.Error = "failed", strp("pg_restore exited 1") })
	r = h.ok("", "db", "backups", "restore", manual, "--mode", "in_place", "--confirm", "db", "--json")
	var rst api.Restore
	if err := json.Unmarshal([]byte(r.stdout), &rst); err != nil || rst.Mode != "in_place" || rst.SafetyBackupID == nil {
		t.Errorf("--json = %s", r.stdout)
	}
	// The fake refuses a second restore while one runs.
	r = h.expect(exitcode.Conflict, "", "db", "backups", "restore", manual, "--mode", "in_place", "--confirm", "db")
	contains(t, r.stderr, "is already running for this service")
}

func TestBackupsRestoreFailure(t *testing.T) {
	h := newHarness(t)
	h.link()
	_, _, manual := seedBackups(h)
	h.fake.OnGetRestore(func(x *api.Restore) { x.Status, x.Error = "failed", strp("pg_restore exited 1") })
	r := h.expect(exitcode.Error, "", "db", "backups", "restore", manual, "--mode", "in_place", "--confirm", "db", "--wait")
	contains(t, r.stderr, "error: restore rst_")
	contains(t, r.stderr, "failed: pg_restore exited 1")
}

func TestBackupsReauth(t *testing.T) {
	h := newHarness(t)
	h.link()
	_, _, manual := seedBackups(h)
	h.fake.SetSessionStale(true)

	r := h.expect(exitcode.Forbidden, "", "db", "backups", "restore", manual, "--mode", "in_place", "--confirm", "db")
	contains(t, r.stderr, "error: Confirm your password to continue")
	contains(t, r.stderr, "hint: restoring a backup needs a recent sign-in; run `roundhouse login` again, then retry")
	r = h.expect(exitcode.Forbidden, "", "db", "backups", "download", manual, "--decrypt")
	contains(t, r.stderr, "hint: decrypting a backup needs a recent sign-in")
	r = h.expect(exitcode.Forbidden, "", "db", "backups", "download", manual, "--decrypt", "--json")
	var out struct {
		Error struct {
			Code string `json:"code"`
			Hint string `json:"hint"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(r.stderr), &out); err != nil || out.Error.Code != "reauth_required" || !strings.Contains(out.Error.Hint, "recent sign-in") {
		t.Errorf("--json error = %s", r.stderr)
	}
	if entries, _ := os.ReadDir(h.dir); len(entries) > 1 {
		t.Errorf("files written: %v", entries)
	}

	h.fake.SetSessionStale(false)
	h.env[EnvToken] = h.fake.AddToken("ci", "workspace:read", "projects:read", "services:read", "backups:restore")
	r = h.expect(exitcode.Forbidden, "", "db", "backups", "restore", manual, "--mode", "in_place", "--confirm", "db")
	contains(t, r.stderr, "hint: API tokens never count as a recent sign-in, and restoring a backup needs one; unset ROUNDHOUSE_TOKEN")
}

func decryptWith(t *testing.T, identity string, data []byte) []byte {
	t.Helper()
	id, err := age.ParseX25519Identity(identity)
	if err != nil {
		t.Fatal(err)
	}
	r, err := age.Decrypt(bytes.NewReader(data), id)
	if err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func checkPrivate(t *testing.T, path string) {
	t.Helper()
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && st.Mode().Perm() != 0o600 {
		t.Errorf("%s mode = %v, want 0600", path, st.Mode().Perm())
	}
}

func TestBackupsDownload(t *testing.T) {
	h := newHarness(t)
	h.link()
	scheduled, failed, manual := seedBackups(h)
	identity := h.fake.BackupIdentity()

	r := h.ok("", "db", "backups", "download", manual)
	path := filepath.Join(h.dir, manual+".rhbk.zst.age")
	contains(t, h.normalize(r.stdout), "✓ Saved "+manual+" to {{DIR}}")
	contains(t, r.stdout, "encrypted, SHA-256 verified")
	contains(t, r.stdout, "pass --decrypt")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decryptWith(t, identity, data), dumpPayload) {
		t.Error("encrypted download does not decrypt to the payload")
	}
	checkPrivate(t, path)
	for _, req := range h.fake.Requests() {
		if strings.HasPrefix(req.Path, "/_objects/") && (req.Header.Get("Cookie") != "" || req.Header.Get("Authorization") != "") {
			t.Errorf("object request carried a credential: %v", req.Header)
		}
		if req.Pattern == api.RouteBackupKey.String() {
			t.Error("an encrypted download fetched the key")
		}
	}

	r = h.expect(exitcode.Conflict, "", "db", "backups", "download", manual)
	contains(t, r.stderr, "already exists; pass --force")
	h.ok("", "db", "backups", "download", manual, "--force")

	r = h.ok("", "db", "backups", "download", scheduled, "--decrypt", "-o", "out/../shop.rhbk.zst", "--json")
	var res struct {
		BackupID  string `json:"backup_id"`
		Path      string `json:"path"`
		Bytes     int64  `json:"bytes"`
		SHA256    string `json:"sha256"`
		Decrypted bool   `json:"decrypted"`
	}
	if err := json.Unmarshal([]byte(r.stdout), &res); err != nil || res.BackupID != scheduled || !res.Decrypted || res.Bytes != int64(len(dumpPayload)) || len(res.SHA256) != 64 {
		t.Errorf("--json = %s (%v)", r.stdout, err)
	}
	out := filepath.Join(h.dir, "shop.rhbk.zst")
	got, err := os.ReadFile(out)
	if err != nil || !bytes.Equal(got, dumpPayload) {
		t.Errorf("decrypted file differs (%v)", err)
	}
	checkPrivate(t, out)
	for _, s := range []string{r.stdout, r.stderr} {
		notContains(t, s, identity)
		notContains(t, s, "AGE-SECRET-KEY")
	}

	r = h.ok("", "db", "backups", "download", manual, "--decrypt")
	contains(t, r.stdout, "decrypted, SHA-256 verified")
	contains(t, r.stdout, "zstd-compressed RHBK1 archive")
	if got, err := os.ReadFile(filepath.Join(h.dir, manual+".rhbk.zst")); err != nil || !bytes.Equal(got, dumpPayload) {
		t.Errorf("default decrypted name: %v", err)
	}
	notContains(t, r.stdout+r.stderr, identity)

	r = h.ok("", "db", "backups", "download", manual, "--decrypt", "-o", "-")
	if r.stdout != string(dumpPayload) {
		t.Errorf("stdout download: %d bytes", len(r.stdout))
	}
	h.expect(exitcode.Usage, "", "db", "backups", "download", manual, "-o", "-", "--json")

	r = h.expect(exitcode.Conflict, "", "db", "backups", "download", failed)
	contains(t, r.stderr, "Only a succeeded backup can be downloaded")
	h.expect(exitcode.NotFound, "", "db", "backups", "download", "bak_nope")
	h.expect(exitcode.Usage, "", "db", "backups", "download")

	h.fake.SetBackupStorage(false)
	r = h.expect(exitcode.Conflict, "", "db", "backups", "download", manual, "-o", "x")
	contains(t, r.stderr, "Backup storage is not configured")
}

func TestBackupsDownloadCorrupt(t *testing.T) {
	h := newHarness(t)
	h.link()
	_, _, manual := seedBackups(h)
	h.fake.CorruptBackup(manual)
	before, _ := os.ReadDir(h.dir)

	r := h.expect(exitcode.Error, "", "db", "backups", "download", manual)
	contains(t, r.stderr, "does not match the backup's SHA-256")
	contains(t, r.stderr, "nothing was saved")
	r = h.expect(exitcode.Error, "", "db", "backups", "download", manual, "--decrypt")
	contains(t, r.stderr, "nothing was saved")

	after, _ := os.ReadDir(h.dir)
	if len(after) != len(before) {
		t.Errorf("files left behind: %v", after)
	}
}
