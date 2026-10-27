//go:build integration

package backup

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"filippo.io/age"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/dockertest"
	"github.com/BankkRoll/Roundhouse/agent/internal/sealtest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// postgresImage is the template's pinned Postgres 18
// (packages/shared/src/database-images.json).
const postgresImage = "postgres:18-bookworm@sha256:bbf83594798e144bff365a9c191c5d779f181fb3135902064ab8ff11918020fc"

// hostScratch is a directory with the same path on the daemon's host and in
// the test container (agent/test/integration.sh mounts it), so it can be a
// bind-mount source.
const hostScratch = "/var/lib/roundhouse-it"

// dockerWorkloads maps workload IDs to real containers.
type dockerWorkloads struct {
	c  *docker.Client
	mu sync.Mutex
	m  map[string]string
}

func (w *dockerWorkloads) set(workload, container string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.m[workload] = container
}

func (w *dockerWorkloads) Container(id string) (string, bool, bool) {
	w.mu.Lock()
	cid, ok := w.m[id]
	w.mu.Unlock()
	if !ok {
		return "", false, false
	}
	info, err := w.c.InspectContainer(context.Background(), cid)
	return cid, err == nil && info.State.Running, err == nil
}

func (w *dockerWorkloads) Hold(ctx context.Context, id, _ string) (func(), error) {
	cid, _, ok := w.Container(id)
	if !ok {
		return nil, errors.New("no container")
	}
	if err := w.c.StopContainer(ctx, cid, 30*time.Second); err != nil {
		return nil, err
	}
	return sync.OnceFunc(func() { _ = w.c.StartContainer(context.Background(), cid) }), nil
}

func (w *dockerWorkloads) WaitHealthy(ctx context.Context, id string) error {
	for {
		cid, running, _ := w.Container(id)
		if running {
			code, err := w.c.RunExec(ctx, cid, docker.ExecRun{Cmd: []string{"sh", "-c", readyProbe}})
			if err == nil && code == 0 {
				return nil
			}
		}
		if !sleepCtx(ctx, 500*time.Millisecond) {
			return ctx.Err()
		}
	}
}

// readyProbe succeeds once the engine's real server answers. The images'
// init-time servers listen only on a socket (Postgres, MySQL) or run
// without access control (MongoDB), so neither passes. Only MongoDB's
// Unauthorized (13) means the real server: the init-time one, shutting
// down, fails the command too (ShutdownInProgress), and the server that
// replaces it is not listening yet.
const readyProbe = `if command -v pg_isready >/dev/null; then exec pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
elif command -v mysqladmin >/dev/null; then exec mysqladmin ping -h 127.0.0.1 --silent
else mongosh --quiet --norc --eval 'try { db.adminCommand({listDatabases: 1}); print("open") } catch (e) { print(e.code === 13 ? "auth" : "other") }' | grep -qx auth
fi`

// dirVolumes serves volumes as directories under root.
type dirVolumes struct{ root string }

func (v dirVolumes) Use(id string) (string, func(), error) {
	p := filepath.Join(v.root, "mnt", id, "data")
	return p, func() {}, os.MkdirAll(p, 0o755)
}

func (v dirVolumes) TempDir() (string, error) {
	p := filepath.Join(v.root, "tmp")
	return p, os.MkdirAll(p, 0o700)
}

type pgHarness struct {
	*harness
	c   *docker.Client
	wl  *dockerWorkloads
	vol dirVolumes
}

func newPGHarness(t *testing.T) *pgHarness {
	c := dockertest.Client(t)
	dockertest.Pull(t, c, postgresImage)
	root := filepath.Join(hostScratch, dockertest.Unique("backup-"))
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Skipf("%s is not available (run through agent/test/integration.sh): %v", hostScratch, err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	h := &pgHarness{harness: &harness{t: t, s3: newFakeS3(t), done: make(chan struct{}), answer: true},
		c: c, wl: &dockerWorkloads{c: c, m: map[string]string{}}, vol: dirVolumes{root: root}}
	h.r = New(Options{
		Docker: c, Workloads: h.wl, Volumes: h.vol, Key: sealtest.Key(), NodeID: testNode, Send: h.send,
		Log: func(task string, _ protocol.LogStream, text string) { t.Logf("[%s] %s", task, text) },
	})
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		_ = h.r.Run(ctx)
		close(h.done)
	}()
	t.Cleanup(func() {
		cancel()
		<-h.done
	})
	return h
}

// postgres starts a database container; with volume set, its data lives in
// that volume's directory.
func (h *pgHarness) postgres(workload, volume string) string {
	h.t.Helper()
	spec := docker.ContainerCreate{
		Image: postgresImage,
		Env:   []string{"POSTGRES_USER=postgres", "POSTGRES_PASSWORD=s3cret-" + workload, "POSTGRES_DB=app"},
	}
	if volume != "" {
		p, _, _ := h.vol.Use(volume)
		spec.HostConfig.Mounts = []docker.Mount{{Type: docker.MountBind, Source: p, Target: "/var/lib/postgresql"}}
	}
	id := dockertest.Run(h.t, h.c, dockertest.Unique("rh-backup-pg-"), spec)
	h.wl.set(workload, id)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := h.wl.WaitHealthy(ctx, workload); err != nil {
		h.t.Fatalf("postgres never became ready: %v", err)
	}
	return id
}

func (h *pgHarness) psql(container, db, sql string) string {
	h.t.Helper()
	var out, errb bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	code, err := h.c.RunExec(ctx, container, docker.ExecRun{
		Cmd:    []string{"psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", db, "-Atc", sql},
		Stdout: &out, Stderr: &errb,
	})
	if err != nil || code != 0 {
		h.t.Fatalf("psql %q: code %d err %v: %s", sql, code, err, errb.String())
	}
	return strings.TrimSpace(out.String())
}

func (h *pgHarness) seed(container string) {
	h.psql(container, "app", "CREATE TABLE items (id int PRIMARY KEY, name text, blob bytea)")
	h.psql(container, "app", "INSERT INTO items SELECT g, 'item '||g, decode(md5(g::text), 'hex') FROM generate_series(1, 5000) g")
	h.psql(container, "postgres", "CREATE DATABASE second")
	h.psql(container, "second", "CREATE TABLE t (v text); INSERT INTO t VALUES ('hello')")
}

const rowsQuery = "SELECT count(*)||':'||md5(string_agg(id||name||encode(blob,'hex'), ',' ORDER BY id)) FROM items"

func (h *pgHarness) restoreFrom(res *protocol.BackupResult, id string, src protocol.BackupSource, identity *age.X25519Identity) *protocol.RestoreResult {
	h.t.Helper()
	h.s3.complete(h.uploaded())
	job := &protocol.RestoreJob{
		Type: protocol.TypeRestoreJob, ControlHeader: header(id), RestoreID: id, BackupSource: src,
		RestoreTarget: protocol.RestoreTarget{
			BackupID: res.BackupID, SHA256: res.SHA256, SizeBytes: *res.BytesStored, TimeoutS: 900,
			SecretsSealed: *h.sealRestore(id, h.s3.objectURL(), identity.String()),
		},
	}
	if err := job.Validate(); err != nil {
		h.t.Fatal(err)
	}
	h.r.StartRestore(job)
	return h.restoreResult(id)
}

func TestIntegrationPostgresDumpBackupRestoresIntoAFreshContainer(t *testing.T) {
	h := newPGHarness(t)
	identity, _ := age.GenerateX25519Identity()
	src := h.postgres("wl_src", "")
	h.seed(src)
	want := h.psql(src, "app", rowsQuery)

	job := &protocol.BackupJob{
		Type: protocol.TypeBackupJob, ControlHeader: header("bak_1"), BackupID: "bak_1",
		BackupSource: protocol.BackupSource{
			Method: protocol.BackupDump, Engine: protocol.EnginePostgres, WorkloadID: "wl_src", VolumeID: "vol_src",
		},
		Quiesce: "none", AgeRecipient: identity.Recipient().String(), PartSizeBytes: protocol.MinBackupPartBytes,
		PartsSealed: *h.sealParts("bak_1", []protocol.BackupPartURL{{PartNumber: 1, URL: h.s3.partURL(1)}}),
		TimeoutS:    900,
	}
	if err := job.Validate(); err != nil {
		t.Fatal(err)
	}
	h.r.StartBackup(job)
	res := h.backupResult("bak_1")
	if !res.OK {
		t.Fatalf("backup: %s", res.Error)
	}

	dst := h.postgres("wl_dst", "")
	h.psql(dst, "app", "CREATE TABLE items (id int PRIMARY KEY, name text, blob bytea); INSERT INTO items VALUES (1, 'stale', NULL)")
	rr := h.restoreFrom(res, "rst_1", protocol.BackupSource{
		Method: protocol.BackupDump, Engine: protocol.EnginePostgres, WorkloadID: "wl_dst", VolumeID: "vol_dst",
	}, identity)
	if !rr.OK {
		t.Fatalf("restore: %s", rr.Error)
	}
	if got := h.psql(dst, "app", rowsQuery); got != want {
		t.Fatalf("restored rows %s, want %s", got, want)
	}
	if got := h.psql(dst, "second", "SELECT v FROM t"); got != "hello" {
		t.Fatalf("second database: %q", got)
	}
}

func TestIntegrationPostgresSnapshotRoundTrip(t *testing.T) {
	h := newPGHarness(t)
	identity, _ := age.GenerateX25519Identity()
	src := h.postgres("wl_snap", "vol_snap")
	h.seed(src)
	want := h.psql(src, "app", rowsQuery)

	job := &protocol.BackupJob{
		Type: protocol.TypeBackupJob, ControlHeader: header("bak_2"), BackupID: "bak_2",
		BackupSource: protocol.BackupSource{Method: protocol.BackupSnapshot, Engine: protocol.EnginePostgres,
			WorkloadID: "wl_snap", VolumeID: "vol_snap"},
		Quiesce: "stop", AgeRecipient: identity.Recipient().String(), PartSizeBytes: protocol.MinBackupPartBytes,
		PartsSealed: *h.sealParts("bak_2", []protocol.BackupPartURL{{PartNumber: 1, URL: h.s3.partURL(1)}}),
		TimeoutS:    900,
	}
	h.r.StartBackup(job)
	res := h.backupResult("bak_2")
	if !res.OK {
		t.Fatalf("backup: %s", res.Error)
	}
	// The quiesced workload is running again.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := h.wl.WaitHealthy(ctx, "wl_snap"); err != nil {
		t.Fatalf("workload not back after the backup: %v", err)
	}

	// Restore into a fresh volume and a fresh container: Postgres must
	// accept the data directory (owner and 0700 mode preserved).
	h.psql(src, "app", "DELETE FROM items WHERE id > 10")
	dst := h.postgres("wl_new", "vol_new")
	rr := h.restoreFrom(res, "rst_2", protocol.BackupSource{
		Method: protocol.BackupSnapshot, Engine: protocol.EnginePostgres, WorkloadID: "wl_new", VolumeID: "vol_new",
	}, identity)
	if !rr.OK {
		t.Fatalf("restore: %s", rr.Error)
	}
	if got := h.psql(dst, "app", rowsQuery); got != want {
		t.Fatalf("restored rows %s, want %s", got, want)
	}
	if _, err := os.Stat(filepath.Join(h.vol.root, "mnt", "vol_new", "data.pre-restore")); !os.IsNotExist(err) {
		t.Fatalf("pre-restore data kept: %v", err)
	}
}
