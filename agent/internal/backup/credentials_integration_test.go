//go:build integration

package backup

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"filippo.io/age"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/dockertest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// Images as pinned in packages/shared/src/database-images.json.
const (
	mysqlImage = "mysql:8.4@sha256:76f0358884cb92d9a086d24e5671c38048d3fef40f2588703d73eb55392d6b69"
	mongoImage = "mongo:8.0@sha256:4a4ab5d4834207389e0d7270fac988e21ffedccecba77991a552f755df229907"
)

// The source's passwords (A) and the restore target's (B).
const (
	adminA = "admin-A-0123456789abcdef"
	roA    = "ro-A-0123456789abcdefghi"
	appA   = "app-A-0123456789abcdefgh"
	adminB = "admin-B-0123456789abcdef"
	roB    = "ro-B-0123456789abcdefghi"
	appB   = "app-B-0123456789abcdefgh"
)

// start runs a database container for workload and waits until it is ready.
func (h *pgHarness) start(workload, image string, env ...string) string {
	h.t.Helper()
	dockertest.Pull(h.t, h.c, image)
	id := dockertest.Run(h.t, h.c, dockertest.Unique("rh-backup-cred-"), docker.ContainerCreate{Image: image, Env: env})
	h.wl.set(workload, id)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	if err := h.wl.WaitHealthy(ctx, workload); err != nil {
		h.t.Fatalf("%s never became ready: %v", image, err)
	}
	return id
}

// exec runs cmd in container with env and returns its trimmed stdout and
// whether it exited 0. A failure's output includes stderr, where the
// clients write why.
func (h *pgHarness) exec(container string, env []string, cmd ...string) (string, bool) {
	h.t.Helper()
	var out, errb bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	code, err := h.c.RunExec(ctx, container, docker.ExecRun{Cmd: cmd, Env: env, Stdout: &out, Stderr: &errb})
	if err != nil {
		h.t.Fatalf("exec %q: %v", cmd, err)
	}
	if code != 0 {
		return strings.TrimSpace(out.String() + "\n" + errb.String()), false
	}
	return strings.TrimSpace(out.String()), true
}

// login checks that user signs in over TCP with good and reads want, and
// that bad is refused.
func (h *pgHarness) login(user, good, bad, want string, run func(user, password string) (string, bool)) {
	h.t.Helper()
	if got, ok := run(user, good); !ok || got != want {
		h.t.Fatalf("%s with the target's password: ok=%v, got %q, want %q", user, ok, got, want)
	}
	if got, ok := run(user, bad); ok {
		h.t.Fatalf("%s with the source's password still signs in (%q)", user, got)
	}
}

// dumpAndRestore backs up src's workload with a dump and restores it into
// dst's workload.
func (h *pgHarness) dumpAndRestore(engine protocol.DatabaseEngine, src, dst string) {
	h.t.Helper()
	identity, _ := age.GenerateX25519Identity()
	job := &protocol.BackupJob{
		Type: protocol.TypeBackupJob, ControlHeader: header("bak_1"), BackupID: "bak_1",
		BackupSource: protocol.BackupSource{Method: protocol.BackupDump, Engine: engine, WorkloadID: src, VolumeID: "vol_src"},
		Quiesce:      "none", AgeRecipient: identity.Recipient().String(), PartSizeBytes: protocol.MinBackupPartBytes,
		PartsSealed: *h.sealParts("bak_1", []protocol.BackupPartURL{{PartNumber: 1, URL: h.s3.partURL(1)}}),
		TimeoutS:    900,
	}
	if err := job.Validate(); err != nil {
		h.t.Fatal(err)
	}
	h.r.StartBackup(job)
	res := h.backupResult("bak_1")
	if !res.OK {
		h.t.Fatalf("backup: %s", res.Error)
	}
	rr := h.restoreFrom(res, "rst_1", protocol.BackupSource{
		Method: protocol.BackupDump, Engine: engine, WorkloadID: dst, VolumeID: "vol_dst",
	}, identity)
	if !rr.OK {
		h.t.Fatalf("restore: %s", rr.Error)
	}
}

func TestIntegrationPostgresRestoreKeepsTheTargetsCredentials(t *testing.T) {
	h := newPGHarness(t)
	src := h.start("wl_src", postgresImage, "POSTGRES_USER=postgres", "POSTGRES_PASSWORD="+adminA, "POSTGRES_DB=app",
		"ROUNDHOUSE_RO_PASSWORD="+roA)
	h.seed(src)
	h.psql(src, "postgres", "CREATE ROLE roundhouse_ro LOGIN PASSWORD '"+roA+"'; GRANT pg_read_all_data TO roundhouse_ro")
	dst := h.start("wl_dst", postgresImage, "POSTGRES_USER=postgres", "POSTGRES_PASSWORD="+adminB, "POSTGRES_DB=app",
		"ROUNDHOUSE_RO_PASSWORD="+roB)
	h.psql(dst, "postgres", "CREATE ROLE roundhouse_ro LOGIN PASSWORD '"+roB+"'; GRANT pg_read_all_data TO roundhouse_ro")

	h.dumpAndRestore(protocol.EnginePostgres, "wl_src", "wl_dst")

	// NOTE: the image trusts connections from 127.0.0.1, so the check signs
	// in on the container's bridge address, where passwords are checked.
	count := func(user, password string) (string, bool) {
		return h.exec(dst, []string{"PGPASSWORD=" + password, "RH_USER=" + user}, "sh", "-c",
			`exec psql -X -h "$(hostname -i | cut -d" " -f1)" -U "$RH_USER" -d app -Atc "SELECT count(*) FROM items"`)
	}
	h.login("postgres", adminB, adminA, "5000", count)
	h.login("roundhouse_ro", roB, roA, "5000", count)
}

// mongo runs js with c, a connection signed in as user, and returns its
// output.
func (h *pgHarness) mongo(container, user, password, js string) (string, bool) {
	h.t.Helper()
	return h.exec(container, []string{"RH_USER=" + user, "RH_PW=" + password}, "mongosh", "--quiet", "--norc", "--nodb", "--eval",
		`const c = new Mongo("mongodb://" + process.env.RH_USER + ":" + process.env.RH_PW + "@127.0.0.1:27017/?authSource=admin");`+js)
}

func TestIntegrationMongoRestoreKeepsTheTargetsCredentials(t *testing.T) {
	h := newPGHarness(t)
	src := h.start("wl_src", mongoImage, "MONGO_INITDB_ROOT_USERNAME=root", "MONGO_INITDB_ROOT_PASSWORD="+adminA,
		"ROUNDHOUSE_RO_PASSWORD="+roA)
	if out, ok := h.mongo(src, "root", adminA, `const a = c.getDB("admin");
a.createUser({user: "roundhouse_ro", pwd: "`+roA+`", roles: [{role: "readAnyDatabase", db: "admin"}]});
a.createUser({user: "app", pwd: "`+appA+`", roles: [{role: "readWrite", db: "app"}]});
c.getDB("app").items.insertMany(Array.from({length: 500}, (_, i) => ({_id: i})));`); !ok {
		t.Fatalf("seed: %s", out)
	}
	dst := h.start("wl_dst", mongoImage, "MONGO_INITDB_ROOT_USERNAME=root", "MONGO_INITDB_ROOT_PASSWORD="+adminB,
		"ROUNDHOUSE_RO_PASSWORD="+roB)
	if out, ok := h.mongo(dst, "root", adminB,
		`c.getDB("admin").createUser({user: "roundhouse_ro", pwd: "`+roB+`", roles: [{role: "readAnyDatabase", db: "admin"}]});`); !ok {
		t.Fatalf("provision: %s", out)
	}

	h.dumpAndRestore(protocol.EngineMongoDB, "wl_src", "wl_dst")

	count := func(user, password string) (string, bool) {
		return h.mongo(dst, user, password, `print(c.getDB("app").items.countDocuments());`)
	}
	h.login("root", adminB, adminA, "500", count)
	h.login("roundhouse_ro", roB, roA, "500", count)
	// The dump's other users come back with it.
	if got, ok := count("app", appA); !ok || got != "500" {
		t.Fatalf("restored app user: ok=%v %q", ok, got)
	}
}

func TestIntegrationMySQLRestoreKeepsTheTargetsCredentials(t *testing.T) {
	h := newPGHarness(t)
	sql := func(container, password, stmt string) {
		t.Helper()
		if out, ok := h.exec(container, []string{"MYSQL_PWD=" + password}, "mysql", "-uroot", "-e", stmt); !ok {
			t.Fatalf("mysql %q: %s", stmt, out)
		}
	}
	src := h.start("wl_src", mysqlImage, "MYSQL_ROOT_PASSWORD="+adminA, "MYSQL_DATABASE=app", "MYSQL_USER=app",
		"MYSQL_PASSWORD="+appA, "ROUNDHOUSE_RO_PASSWORD="+roA)
	sql(src, adminA, "CREATE TABLE app.items (id INT PRIMARY KEY); INSERT INTO app.items VALUES (1), (2), (3);"+
		"CREATE USER roundhouse_ro@'%' IDENTIFIED BY '"+roA+"'; GRANT SELECT ON *.* TO roundhouse_ro@'%'")
	dst := h.start("wl_dst", mysqlImage, "MYSQL_ROOT_PASSWORD="+adminB, "MYSQL_DATABASE=app", "MYSQL_USER=app",
		"MYSQL_PASSWORD="+appB, "ROUNDHOUSE_RO_PASSWORD="+roB)
	sql(dst, adminB, "CREATE USER roundhouse_ro@'%' IDENTIFIED BY '"+roB+"'; GRANT SELECT ON *.* TO roundhouse_ro@'%'")

	h.dumpAndRestore(protocol.EngineMySQL, "wl_src", "wl_dst")

	count := func(user, password string) (string, bool) {
		return h.exec(dst, []string{"MYSQL_PWD=" + password},
			"mysql", "-h", "127.0.0.1", "-u"+user, "-N", "-B", "-e", "SELECT COUNT(*) FROM app.items")
	}
	h.login("root", adminB, adminA, "3", count)
	h.login("app", appB, appA, "3", count)
	h.login("roundhouse_ro", roB, roA, "3", count)
}
