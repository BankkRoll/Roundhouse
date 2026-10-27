//go:build integration

package backup

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"filippo.io/age"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/dockertest"
	"github.com/BankkRoll/Roundhouse/agent/internal/sealtest"
	"github.com/BankkRoll/Roundhouse/agent/internal/walship"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// walArchive plays the control plane's side of WAL archiving: it records
// every file the shipper reports, acks it, and hands out upload URLs to a
// fake bucket that keeps the objects.
type walArchive struct {
	t       *testing.T
	srv     *httptest.Server
	shipper *walship.Shipper

	mu       sync.Mutex
	objects  map[string][]byte
	recorded map[string]protocol.ArchivedWALFile
}

func newWALArchive(t *testing.T, vol dirVolumes) *walArchive {
	a := &walArchive{t: t, objects: map[string][]byte{}, recorded: map[string]protocol.ArchivedWALFile{}}
	a.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		defer a.mu.Unlock()
		switch r.Method {
		case http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			a.objects[r.URL.Path] = body
		case http.MethodGet:
			body, ok := a.objects[r.URL.Path]
			if !ok {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write(body)
		}
	}))
	t.Cleanup(a.srv.Close)
	a.shipper = walship.New(walship.Options{
		NodeID: testNode, Key: sealtest.Key(), Volumes: vol, Send: a.onReport,
		Interval: 200 * time.Millisecond, Resend: 2 * time.Second,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_ = a.shipper.Run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return a
}

func (a *walArchive) url(name string) string {
	return a.srv.URL + "/wal/" + name + "?X-Amz-Signature=test-only"
}

func (a *walArchive) onReport(_ context.Context, m protocol.AgentMessage) error {
	raw, _ := json.Marshal(m)
	if _, err := protocol.DecodeAgentMessage(raw); err != nil {
		a.t.Errorf("invalid wal_archive: %v", err)
	}
	r := m.(*protocol.WALArchive)
	ack := &protocol.WALArchiveAck{Type: protocol.TypeWALArchiveAck, VolumeID: r.VolumeID, StreamID: r.StreamID, Acked: []string{}}
	a.mu.Lock()
	for _, f := range r.Archived {
		a.recorded[f.Name] = f
		ack.Acked = append(ack.Acked, f.Name)
	}
	a.mu.Unlock()
	if len(r.Pending) > 0 {
		var ups []protocol.WALUpload
		for _, n := range r.Pending {
			ups = append(ups, protocol.WALUpload{Name: n, URL: a.url(n)})
		}
		pt, _ := json.Marshal(protocol.SealedWALUploads{Uploads: ups})
		box, err := protocol.SealBox(sealtest.Key().PublicKey(), pt, protocol.BoxPurposeWALUpload, protocol.WALUploadAAD(testNode, r.StreamID))
		if err != nil {
			a.t.Fatal(err)
		}
		ack.UploadsSealed = box
	}
	go a.shipper.Ack(ack)
	return nil
}

// waitArchivedAfter waits until a segment finished after at is recorded.
func (a *walArchive) waitArchivedAfter(at int64) {
	a.t.Helper()
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		for _, f := range a.recorded {
			if protocol.ValidWALSegmentName(f.Name) && f.ArchivedAt > at {
				a.mu.Unlock()
				return
			}
		}
		a.mu.Unlock()
		time.Sleep(200 * time.Millisecond)
	}
	a.t.Fatal("no WAL segment was archived after the mark")
}

// files is the restore's WAL list as the control plane builds it: the
// history files, then the base's timeline from wal_start through the first
// segment finished after target (all of them for a nil target).
func (a *walArchive) files(walStart string, target *int64) []protocol.ArchivedWALFile {
	a.t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	var hist, segs []protocol.ArchivedWALFile
	for _, f := range a.recorded {
		switch {
		case strings.HasSuffix(f.Name, ".history"):
			hist = append(hist, f)
		case protocol.ValidWALSegmentName(f.Name) && protocol.WALTimeline(f.Name) == protocol.WALTimeline(walStart) && f.Name >= walStart:
			segs = append(segs, f)
		}
	}
	byName := func(x, y protocol.ArchivedWALFile) int { return strings.Compare(x.Name, y.Name) }
	slices.SortFunc(hist, byName)
	slices.SortFunc(segs, byName)
	var out []protocol.ArchivedWALFile
	want := walStart
	for _, s := range segs {
		if s.Name != want {
			a.t.Fatalf("archive gap: %s after %s", s.Name, want)
		}
		out = append(out, s)
		if target != nil && s.ArchivedAt > *target {
			break
		}
		want, _ = protocol.NextWALSegment(s.Name)
	}
	if target != nil && out[len(out)-1].ArchivedAt <= *target {
		a.t.Fatal("the archive does not reach the target yet")
	}
	return append(hist, out...)
}

// answerFetches makes the harness answer the restore's wal_fetch_requests
// from files.
func (h *pgHarness) answerFetches(a *walArchive, restoreID string, files []protocol.ArchivedWALFile) {
	h.mu.Lock()
	h.onWALFetch = func(req *protocol.WALFetchRequest) {
		if req.RestoreID != restoreID {
			return
		}
		var out []protocol.WALFetchFile
		for i := req.From; i < min(req.From+req.Count, len(files)); i++ {
			f := files[i]
			out = append(out, protocol.WALFetchFile{Index: i, Name: f.Name, URL: a.url(f.Name), SHA256: f.SHA256, Size: f.SizeStored})
		}
		pt, _ := json.Marshal(protocol.SealedWALFiles{Files: out})
		box, err := protocol.SealBox(sealtest.Key().PublicKey(), pt, protocol.BoxPurposeWALFetch, protocol.WALFetchAAD(testNode, restoreID))
		if err != nil {
			h.t.Error(err)
			return
		}
		h.r.AddWALFiles(&protocol.WALFetch{Type: protocol.TypeWALFetch, ControlHeader: header(restoreID), RestoreID: restoreID, FilesSealed: *box})
	}
	h.mu.Unlock()
}

// archivingPostgres starts a database on a volume with the archive command
// the control plane gives a database with point-in-time recovery on.
func (h *pgHarness) archivingPostgres(workload, volume, password string) string {
	h.t.Helper()
	p, _, _ := h.vol.Use(volume)
	id := dockertest.Run(h.t, h.c, dockertest.Unique("rh-pitr-pg-"), docker.ContainerCreate{
		Image: postgresImage,
		Cmd:   append([]string{"postgres"}, protocol.PostgresArchiveArgs("/var/lib/postgresql")...),
		Env:   []string{"POSTGRES_USER=postgres", "POSTGRES_PASSWORD=" + password, "POSTGRES_DB=app"},
		HostConfig: docker.HostConfig{
			Mounts: []docker.Mount{{Type: docker.MountBind, Source: p, Target: "/var/lib/postgresql"}},
		},
	})
	h.wl.set(workload, id)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := h.wl.WaitHealthy(ctx, workload); err != nil {
		h.t.Fatalf("postgres never became ready: %v", err)
	}
	return id
}

func (h *pgHarness) waitRestore(id string) *protocol.RestoreResult {
	h.t.Helper()
	deadline := time.Now().Add(8 * time.Minute)
	for time.Now().Before(deadline) {
		h.mu.Lock()
		for _, m := range h.sent {
			if r, ok := m.(*protocol.RestoreResult); ok && r.RestoreID == id {
				h.mu.Unlock()
				return r
			}
		}
		h.mu.Unlock()
		time.Sleep(250 * time.Millisecond)
	}
	h.t.Fatalf("restore %s never answered", id)
	return nil
}

func TestIntegrationPostgresPointInTimeRestore(t *testing.T) {
	h := newPGHarness(t)
	identity, _ := age.GenerateX25519Identity()
	wal := newWALArchive(t, h.vol)
	wal.shipper.Apply(1, []protocol.VolumeSpec{{ID: "vol_src", WALArchive: &protocol.WALArchiveSpec{
		StreamID: "wal_1", AgeRecipient: identity.Recipient().String(),
	}}})

	src := h.archivingPostgres("wl_src", "vol_src", adminA)
	h.psql(src, "app", "CREATE TABLE items (id int PRIMARY KEY); INSERT INTO items SELECT generate_series(1, 10)")

	job := &protocol.BackupJob{
		Type: protocol.TypeBackupJob, ControlHeader: header("bak_base"), BackupID: "bak_base",
		BackupSource: protocol.BackupSource{Method: protocol.BackupBase, Engine: protocol.EnginePostgres, WorkloadID: "wl_src", VolumeID: "vol_src"},
		Quiesce:      "none", AgeRecipient: identity.Recipient().String(), PartSizeBytes: protocol.MinBackupPartBytes,
		PartsSealed: *h.sealParts("bak_base", []protocol.BackupPartURL{{PartNumber: 1, URL: h.s3.partURL(1)}}),
		TimeoutS:    900,
	}
	if err := job.Validate(); err != nil {
		t.Fatal(err)
	}
	h.r.StartBackup(job)
	res := h.backupResult("bak_base")
	if !res.OK || !protocol.ValidWALSegmentName(res.WALStart) {
		t.Fatalf("base backup: ok=%v error=%q wal_start=%q", res.OK, res.Error, res.WALStart)
	}
	h.s3.complete(h.uploaded())

	// Two batches with a mark between them, then a mark after both; each
	// mark is covered by a segment finished after it.
	h.psql(src, "app", "INSERT INTO items SELECT generate_series(11, 110)")
	time.Sleep(1500 * time.Millisecond)
	between := time.Now().UnixMilli()
	time.Sleep(1500 * time.Millisecond)
	h.psql(src, "app", "INSERT INTO items SELECT generate_series(111, 210)")
	time.Sleep(1500 * time.Millisecond)
	after := time.Now().UnixMilli()
	time.Sleep(1500 * time.Millisecond)
	h.psql(src, "postgres", "CHECKPOINT")
	h.psql(src, "postgres", "SELECT pg_switch_wal()")
	wal.waitArchivedAfter(after)

	dst := h.archivingPostgres("wl_dst", "vol_dst", adminB)
	restore := func(id string, target *int64, want string) {
		t.Helper()
		var files []protocol.ArchivedWALFile
		if target != nil {
			files = wal.files(res.WALStart, target)
		}
		h.answerFetches(wal, id, files)
		pitr := &protocol.PITRRecovery{TargetTime: target, WALFiles: len(files)}
		if len(files) > 0 {
			end := files[len(files)-1].Name
			pitr.WALEnd = &end
		}
		rj := &protocol.RestoreJob{
			Type: protocol.TypeRestoreJob, ControlHeader: header(id), RestoreID: id,
			BackupSource: protocol.BackupSource{Method: protocol.BackupBase, Engine: protocol.EnginePostgres, WorkloadID: "wl_dst", VolumeID: "vol_dst"},
			RestoreTarget: protocol.RestoreTarget{
				BackupID: "bak_base", SHA256: res.SHA256, SizeBytes: *res.BytesStored, TimeoutS: 900,
				SecretsSealed: *h.sealRestore(id, h.s3.objectURL(), identity.String()),
			},
			PITR: pitr,
		}
		if err := rj.Validate(); err != nil {
			t.Fatal(err)
		}
		h.r.StartRestore(rj)
		if rr := h.waitRestore(id); !rr.OK {
			t.Fatalf("restore %s: %s", id, rr.Error)
		}
		if got := h.psql(dst, "app", "SELECT count(*) FROM items"); got != want {
			t.Fatalf("restore %s: %s rows, want %s", id, got, want)
		}
	}

	restore("rst_between", &between, "110")
	// No commit after this mark: recovery replays every fetched file.
	restore("rst_after", &after, "210")
	restore("rst_base", nil, "10")

	// The restored data directory came from the source, passwords and all;
	// the target's own ones are back.
	count := func(user, password string) (string, bool) {
		return h.exec(dst, []string{"PGPASSWORD=" + password, "RH_USER=" + user}, "sh", "-c",
			`exec psql -X -h "$(hostname -i | cut -d" " -f1)" -U "$RH_USER" -d app -Atc "SELECT count(*) FROM items"`)
	}
	h.login("postgres", adminB, adminA, "10", count)

	// The restored database archives again, into its own spool.
	if out, ok := h.exec(dst, nil, "sh", "-c", "psql -X -U postgres -d postgres -Atc 'SHOW archive_mode'"); !ok || out != "on" {
		t.Fatalf("archive_mode after restore: %q", out)
	}
	h.mu.Lock()
	var fetched int
	for _, m := range h.sent {
		if req, ok := m.(*protocol.WALFetchRequest); ok && req.RestoreID == "rst_between" {
			fetched += req.Count
		}
	}
	h.mu.Unlock()
	if fetched == 0 {
		t.Fatal("the restore fetched no WAL")
	}
	t.Logf("wal_start %s, %s files fetched for the first restore", res.WALStart, strconv.Itoa(fetched))
}
