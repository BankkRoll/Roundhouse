package cli

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// addServers adds edge-2 (online) and edge-3 (offline) next to the seeded
// edge-1.
func addServers(h *harness) {
	h.fake.AddNode(api.Node{ID: "node_0002", Name: "edge-2", Status: "online", Provider: "manual", PublicIP: strp("203.0.113.20"), CreatedAt: apitest.Now})
	h.fake.AddNode(api.Node{ID: "node_0003", Name: "edge-3", Status: "offline", Provider: "manual", CreatedAt: apitest.Now})
}

func TestDBVolumeMove(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)
	addServers(h)

	r := h.ok("", "db", "volume", "move", "--list-targets")
	for _, want := range []string{"Servers the volume of Postgres in production can move to (now on edge-1)", "edge-2", "node_0002", "xfs_project",
		"the server is offline", "Estimated downtime: about 4m 10s; the service is down for the whole copy."} {
		contains(t, r.stdout, want)
	}
	notContains(t, r.stdout, "edge-1   ")
	r = h.ok("", "db", "volume", "move", "--list-targets", "--json")
	var mt api.MigrationTargets
	if err := json.Unmarshal([]byte(r.stdout), &mt); err != nil || len(mt.Targets) != 2 || mt.EstimatedDowntimeMS != apitest.EstimatedDowntimeMS {
		t.Errorf("--json = %s", r.stdout)
	}

	r = h.expect(exitcode.Usage, "", "db", "volume", "move")
	contains(t, r.stdout, "the server is offline")
	contains(t, r.stderr, "pass --to with an eligible server")
	h.expect(exitcode.Usage, "", "db", "volume", "move", "--to", "edge-2", "--list-targets")
	r = h.expect(exitcode.Conflict, "", "db", "volume", "move", "--to", "edge-1")
	contains(t, r.stderr, "the volume of Postgres is already on edge-1")
	r = h.expect(exitcode.NotFound, "", "db", "volume", "move", "--to", "edge-9")
	contains(t, r.stderr, `no server "edge-9"`)
	r = h.expect(exitcode.Invalid, "", "db", "volume", "move", "--to", "edge-3")
	contains(t, r.stderr, "edge-3 cannot take the volume: the server is offline")
	contains(t, r.stdout, "Estimated downtime")
	r = h.expect(exitcode.InputRequired, "", "db", "volume", "move", "--to", "edge-2")
	contains(t, r.stderr, "pass --confirm db")
	r = h.expect(exitcode.Usage, "", "db", "volume", "move", "--to", "edge-2", "--confirm", "api")
	contains(t, r.stderr, `--confirm "api" does not match "db"`)
	r = h.interactive("postgres\n", "db", "volume", "move", "--to", "edge-2")
	if r.code != exitcode.Error || !strings.Contains(r.stderr, "confirmation did not match") {
		t.Errorf("mistyped confirmation: exit %d, %s", r.code, r.stderr)
	}
	if n := len(h.fake.VolumeMigrations()); n != 0 {
		t.Fatalf("%d migrations started", n)
	}

	r = h.interactive("db\n", "db", "volume", "move", "--to", "EDGE-2")
	if r.code != 0 {
		t.Fatalf("move: exit %d, %s", r.code, r.stderr)
	}
	contains(t, r.stderr, "This moves the volume of Postgres in production from edge-1 to edge-2. Postgres is down for the whole copy, about 4m 10s.")
	contains(t, r.stdout, "✓ Started moving the volume of Postgres in production to edge-2 (vmg_")
	contains(t, r.stdout, "roundhouse db volume migrations")
	body := lastBody(t, h, api.RouteMigrateVolume.String())
	if body["target_node_id"] != "node_0002" || body["confirm"] != "db" {
		t.Errorf("body = %v", body)
	}
	r = h.expect(exitcode.Conflict, "", "db", "volume", "move", "--to", "edge-2", "--yes")
	contains(t, r.stderr, "The volume is migrating")

	r = h.ok("", "db", "volume", "migrations")
	contains(t, r.stdout, "queued")
	contains(t, r.stdout, "edge-1")
	contains(t, r.stdout, "edge-2")
}

func TestDBVolumeMoveWait(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)
	addServers(h)

	h.fake.OnGetVolumeMigration(func(m *api.VolumeMigration) {
		i := slices.Index(api.VolumeMigrationPhases, m.Phase)
		m.Phase, m.Status = api.VolumeMigrationPhases[i+1], api.MigrationRunning
		if m.Phase == "copying_in" {
			copied := 1.2 * gib
			m.CopiedBytes = &copied
		}
		if m.Phase == "done" {
			m.Status, m.StartedAt, m.FinishedAt = api.MigrationSucceeded, i64p(apitest.Now), i64p(apitest.Now+200000)
		}
	})
	r := h.ok("", "db", "volume", "move", "--to", "edge-2", "--yes", "--wait")
	contains(t, r.stderr, "warning: Postgres is down for the whole copy, about 4m 10s")
	for _, want := range []string{"preparing_target", "stopping         stopping the service", "copying_out", "copying_in",
		"starting", "done", "✓ Moved the volume of Postgres in production to edge-2 in 3m 20s"} {
		contains(t, r.stdout, want)
	}
	notContains(t, r.stdout, "rolling_back")
	r = h.ok("", "db", "volume")
	contains(t, r.stdout, "ready on edge-2")

	h.fake.OnGetVolumeMigration(func(m *api.VolumeMigration) {
		m.Status, m.Phase, m.Error = api.MigrationFailed, "rolling_back", strp("sha256 mismatch on edge-1")
	})
	r = h.expect(exitcode.Error, "", "db", "volume", "move", "--to", "edge-1", "--confirm", "db", "--wait")
	contains(t, r.stdout, "rolling_back")
	contains(t, r.stderr, "error: volume migration vmg_")
	contains(t, r.stderr, "failed: sha256 mismatch on edge-1")

	r = h.expect(exitcode.Error, "", "db", "volume", "move", "--to", "edge-1", "--confirm", "db", "--wait", "--json")
	var m api.VolumeMigration
	if err := json.Unmarshal([]byte(r.stdout), &m); err != nil || m.Status != api.MigrationFailed {
		t.Errorf("--json = %s", r.stdout)
	}

	r = h.ok("", "db", "volume", "migrations")
	contains(t, r.stdout, "succeeded")
	contains(t, r.stdout, "1.2 GiB")
	contains(t, r.stdout, "failed vmg_")
	r = h.ok("", "db", "volume", "migrations", "--json")
	var list api.VolumeMigrationList
	if err := json.Unmarshal([]byte(r.stdout), &list); err != nil || len(list.Migrations) != 3 || list.Migrations[2].Status != api.MigrationSucceeded {
		t.Errorf("--json = %s", r.stdout)
	}
}

func TestDBVolumeMigrationsEmpty(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)
	r := h.ok("", "db", "volume", "migrations")
	contains(t, r.stdout, "The volume of Postgres in production has never moved.")
	r = h.expect(exitcode.Conflict, "", "db", "volume", "move", "--to", "edge-2", "--environment", "staging", "--yes")
	contains(t, r.stderr, "is on no server yet")
}

func TestDBTCPProxy(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)

	r := h.ok("", "db", "tcp-proxy")
	contains(t, r.stdout, "Postgres publishes no TCP port in production; it is reachable on the private network only.")
	r = h.ok("", "db", "tcp-proxy", "show", "--json")
	if strings.TrimSpace(r.stdout) != "null" {
		t.Errorf("--json without a proxy = %q", r.stdout)
	}

	r = h.expect(exitcode.Usage, "", "db", "tcp-proxy", "enable")
	contains(t, r.stderr, "pass --allow")
	r = h.expect(exitcode.Usage, "", "db", "tcp-proxy", "enable", "--allow", "my-laptop")
	contains(t, r.stderr, `--allow "my-laptop" is not an IP address or CIDR block`)
	for _, open := range []string{"0.0.0.0/0", "::/0"} {
		r = h.expect(exitcode.Usage, "", "db", "tcp-proxy", "enable", "--allow", "203.0.113.7", "--allow", open)
		contains(t, r.stderr, "admits every address on the internet; pass --allow-open")
	}
	r = h.expect(exitcode.Usage, "", "db", "tcp-proxy", "enable", "--allow-open", "--allow", "203.0.113.7")
	contains(t, r.stderr, "--allow-open admits every address")
	h.expect(exitcode.Usage, "", "db", "tcp-proxy", "enable", "--allow", "203.0.113.7", "--port", "70000")
	if p := h.fake.TCPProxy(apitest.DBServiceID, apitest.ProductionID); p != nil {
		t.Fatalf("published: %+v", p)
	}

	r = h.ok("", "db", "tcp-proxy", "enable", "--allow", "203.0.113.7", "--allow", "198.51.100.0/24")
	notContains(t, r.stderr, "warning")
	for _, want := range []string{"✓ Published the TCP port of Postgres in production", "Endpoint   203.0.113.10:20001", "Status     active",
		"Forwards   20001 → container port 5432", "Allowed    203.0.113.7/32, 198.51.100.0/24"} {
		contains(t, r.stdout, want)
	}
	notContains(t, r.stdout, "Warning")
	body := lastBody(t, h, api.RoutePutTCPProxy.String())
	if body["environment_id"] != apitest.ProductionID || body["acknowledge_open"] != nil || body["container_port"] != nil ||
		len(body["allowed_cidrs"].([]any)) != 2 {
		t.Errorf("body = %v", body)
	}
	r = h.ok("", "db", "tcp-proxy")
	contains(t, r.stdout, "TCP proxy of Postgres in production")
	contains(t, r.stdout, "Endpoint   203.0.113.10:20001")

	r = h.ok("", "db", "tcp-proxy", "enable", "--allow-open", "--port", "5433")
	contains(t, r.stderr, "warning: Postgres's port in production will be reachable from the entire internet. The connection is unencrypted unless the client and the database negotiate TLS")
	contains(t, r.stdout, "Warning    open to every address on the internet, and unencrypted unless the client and the database negotiate TLS")
	contains(t, r.stdout, "container port 5433")
	body = lastBody(t, h, api.RoutePutTCPProxy.String())
	if body["acknowledge_open"] != true || body["container_port"] != float64(5433) || body["allowed_cidrs"].([]any)[0] != "0.0.0.0/0" {
		t.Errorf("body = %v", body)
	}
	r = h.ok("", "db", "tcp-proxy", "enable", "--allow", "0.0.0.0/0", "--allow-open", "--json")
	var p api.TCPProxy
	if err := json.Unmarshal([]byte(r.stdout), &p); err != nil || !p.OpenToAll || p.PublicPort != 20001 {
		t.Errorf("--json = %s", r.stdout)
	}
	contains(t, r.stderr, "warning: Postgres's port in production will be reachable from the entire internet")

	r = h.expect(exitcode.Invalid, "", "db", "tcp-proxy", "enable", "--allow", "::ffff:10.0.0.0/104")
	contains(t, r.stderr, "IPv4-mapped block admits no one")
	h.ok("", "db", "tcp-proxy", "enable", "--allow", "2001:DB8::1/32")
	body = lastBody(t, h, api.RoutePutTCPProxy.String())
	if body["allowed_cidrs"].([]any)[0] != "2001:DB8::1/32" {
		t.Errorf("IPv6 body = %v", body)
	}

	r = h.ok("", "db", "tcp-proxy", "enable", "--environment", "staging", "--allow", "10.0.0.0/8")
	contains(t, r.stdout, "Endpoint   port 20002 on the service's server, once it is placed")
	contains(t, r.stdout, "Status     pending; published once the service is placed and deployed")

	r = h.expect(exitcode.InputRequired, "", "db", "tcp-proxy", "disable")
	contains(t, r.stderr, "pass --yes")
	r = h.interactive("n\n", "db", "tcp-proxy", "disable")
	if r.code != exitcode.Error || !strings.Contains(r.stderr, "disable aborted") {
		t.Errorf("declined disable: exit %d, %s", r.code, r.stderr)
	}
	r = h.interactive("y\n", "db", "tcp-proxy", "disable")
	if r.code != 0 {
		t.Fatalf("disable: exit %d, %s", r.code, r.stderr)
	}
	contains(t, r.stderr, "Stop publishing port 20001 of Postgres in production?")
	contains(t, r.stdout, "✓ Stopped publishing the TCP port of Postgres in production")
	if p := h.fake.TCPProxy(apitest.DBServiceID, apitest.ProductionID); p != nil {
		t.Errorf("still published: %+v", p)
	}
	r = h.expect(exitcode.NotFound, "", "db", "tcp-proxy", "disable", "--yes")
	contains(t, r.stderr, "Postgres publishes no TCP port in production")

	r = h.ok("", "db", "tcp-proxy", "disable", "--environment", "staging", "--yes", "--json")
	var out map[string]string
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil || !strings.HasPrefix(out["disabled"], "tcp_") || out["environment_id"] != apitest.StagingID {
		t.Errorf("--json = %s", r.stdout)
	}
}

func TestDBRotateCredentials(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)

	r := h.ok("", "db", "rotations")
	contains(t, r.stdout, "The credentials of Postgres in production were never rotated.")
	r = h.expect(exitcode.Usage, "", "db", "rotate-credentials", "--principal", "root")
	contains(t, r.stderr, `unknown --principal "root"`)
	r = h.expect(exitcode.InputRequired, "", "db", "rotate-credentials")
	contains(t, r.stderr, "pass --confirm db")
	r = h.expect(exitcode.Usage, "", "db", "rotate-credentials", "--confirm", "api")
	contains(t, r.stderr, `--confirm "api" does not match "db"`)
	r = h.expect(exitcode.Conflict, "", "db", "rotate-credentials", "--service", "api", "--yes")
	contains(t, r.stderr, "API is not a database service")
	if n := len(h.fake.CredentialRotations()); n != 0 {
		t.Fatalf("%d rotations", n)
	}

	r = h.interactive("db\n", "db", "rotate-credentials")
	if r.code != 0 {
		t.Fatalf("rotate: exit %d, %s", r.code, r.stderr)
	}
	contains(t, r.stderr, "This rotates every password of Postgres in production and redeploys Postgres and every service using them.")
	for _, want := range []string{"✓ Rotated the credentials of Postgres in production (rot_", "Principals   admin, readonly",
		"Applied      admin, readonly", "Change set   chs_", "Deploying    dep_", "roundhouse logs --deployment dep_"} {
		contains(t, r.stdout, want)
	}
	for _, secret := range []string{apitest.SecretValue, "PASSWORD"} {
		notContains(t, r.stdout+r.stderr, secret)
	}
	body := lastBody(t, h, api.RouteRotateCredentials.String())
	if body["environment_id"] != apitest.ProductionID || body["confirm"] != "db" || body["principals"] != nil {
		t.Errorf("body = %v", body)
	}

	r = h.ok("", "db", "rotate-credentials", "--principal", "readonly", "--principal", "READONLY", "--yes")
	contains(t, r.stdout, "Principals   readonly")
	body = lastBody(t, h, api.RouteRotateCredentials.String())
	if ps, _ := body["principals"].([]any); len(ps) != 1 || ps[0] != "readonly" {
		t.Errorf("body = %v", body)
	}
	r = h.expect(exitcode.Invalid, "", "db", "rotate-credentials", "--principal", "app", "--yes")
	contains(t, r.stderr, "PostgreSQL has no app principal")

	h.fake.OnRotateCredentials(func(x *api.CredentialRotation) {
		x.Status, x.Error, x.Applied, x.ChangeSetID, x.DeploymentIDs = api.RotationFailed, strp("node_offline: edge-1 is offline"), []string{}, nil, []string{}
	})
	r = h.expect(exitcode.Error, "", "db", "rotate-credentials", "--confirm", "db")
	contains(t, r.stdout, "is failed")
	contains(t, r.stderr, "failed: node_offline: edge-1 is offline")
	notContains(t, r.stderr, "hint:")

	h.fake.OnRotateCredentials(func(x *api.CredentialRotation) {
		x.Status, x.Error, x.Applied, x.ChangeSetID, x.DeploymentIDs, x.FinishedAt = api.RotationRunning, nil, []string{"admin"}, nil, []string{}, nil
	})
	r = h.expect(exitcode.Error, "", "db", "rotate-credentials", "--yes", "--json")
	var rot api.CredentialRotation
	if err := json.Unmarshal([]byte(r.stdout), &rot); err != nil || rot.Status != api.RotationRunning {
		t.Fatalf("--json = %s", r.stdout)
	}
	r = h.ok("", "db", "rotations")
	contains(t, r.stderr, "note: a rotation is unfinished; run `roundhouse db rotate-credentials` again to finish it")
	contains(t, r.stdout, "running")
	contains(t, r.stdout, "failed rot_")

	h.fake.OnRotateCredentials(func(x *api.CredentialRotation) {
		x.Status, x.Applied, x.FinishedAt = api.RotationRunning, []string{"admin"}, nil
	})
	r = h.expect(exitcode.Error, "", "db", "rotate-credentials", "--yes")
	contains(t, r.stderr, "hint: the database may already use new passwords; run `roundhouse db rotate-credentials` again to finish the rotation")

	h.fake.OnRotateCredentials(nil)
	r = h.ok("", "db", "rotate-credentials", "--yes")
	contains(t, r.stdout, "✓ Rotated the credentials of Postgres in production ("+rot.ID+")")

	r = h.ok("", "db", "rotations", "--json")
	var list api.CredentialRotationList
	if err := json.Unmarshal([]byte(r.stdout), &list); err != nil || len(list.Rotations) != 4 || list.Rotations[0].ID != rot.ID {
		t.Errorf("--json = %s", r.stdout)
	}
	r = h.ok("", "db", "rotations")
	notContains(t, r.stderr, "unfinished")
}

func TestDBOpsReauth(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)
	addServers(h)
	h.ok("", "db", "tcp-proxy", "enable", "--allow", "203.0.113.7")
	h.fake.SetSessionStale(true)

	r := h.expect(exitcode.Forbidden, "", "db", "volume", "move", "--to", "edge-2", "--yes")
	contains(t, r.stderr, "hint: moving a volume needs a recent sign-in; run `roundhouse login` again, then retry")
	r = h.expect(exitcode.Forbidden, "", "db", "tcp-proxy", "enable", "--allow", "203.0.113.8")
	contains(t, r.stderr, "hint: publishing a TCP port needs a recent sign-in")
	r = h.expect(exitcode.Forbidden, "", "db", "rotate-credentials", "--yes")
	contains(t, r.stderr, "error: Confirm your password to continue")
	contains(t, r.stderr, "hint: rotating credentials needs a recent sign-in")
	if len(h.fake.VolumeMigrations())+len(h.fake.CredentialRotations()) != 0 {
		t.Error("a stale session changed something")
	}
	// Turning the proxy off needs no fresh session.
	h.ok("", "db", "tcp-proxy", "disable", "--yes")

	h.fake.SetSessionStale(false)
	h.env[EnvToken] = h.fake.AddToken("ci", "workspace:read", "projects:read", "services:read", "services:manage", "data:write", "variables:read")
	r = h.expect(exitcode.Forbidden, "", "db", "tcp-proxy", "enable", "--allow", "203.0.113.7")
	contains(t, r.stderr, "hint: API tokens never count as a recent sign-in, and publishing a TCP port needs one; unset ROUNDHOUSE_TOKEN")
	r = h.expect(exitcode.Forbidden, "", "db", "rotate-credentials", "--yes", "--json")
	var out struct {
		Error struct {
			Code string `json:"code"`
			Hint string `json:"hint"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(r.stderr), &out); err != nil || out.Error.Code != "reauth_required" || !strings.Contains(out.Error.Hint, "rotating credentials") {
		t.Errorf("--json error = %s", r.stderr)
	}
}
