package backup

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"filippo.io/age"

	"github.com/BankkRoll/Roundhouse/agent/internal/sealtest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

const testNode = "node_test1"

// fakeS3 accepts presigned UploadPart PUTs and serves the completed object,
// enforcing R2's multipart rules when the upload completes.
type fakeS3 struct {
	t   *testing.T
	srv *httptest.Server

	mu     sync.Mutex
	parts  map[int][]byte
	etags  map[int]string
	object []byte
	// failOnce makes the first PUT of each listed part answer 500.
	failOnce map[int]bool
	puts     int
}

func newFakeS3(t *testing.T) *fakeS3 {
	f := &fakeS3{t: t, parts: map[int][]byte{}, etags: map[int]string{}, failOnce: map[int]bool{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeS3) partURL(n int) string {
	return fmt.Sprintf("%s/bucket/backups/bak_1.rhbk.zst.age?partNumber=%d&uploadId=up1&X-Amz-Signature=secret", f.srv.URL, n)
}

func (f *fakeS3) objectURL() string {
	return f.srv.URL + "/bucket/backups/bak_1.rhbk.zst.age?X-Amz-Signature=secret"
}

func (f *fakeS3) serve(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPut:
		n, err := strconv.Atoi(r.URL.Query().Get("partNumber"))
		if err != nil || r.URL.Query().Get("uploadId") != "up1" {
			http.Error(w, "bad part", http.StatusBadRequest)
			return
		}
		if r.ContentLength < 0 {
			http.Error(w, "length required", http.StatusLengthRequired)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil || int64(len(body)) != r.ContentLength {
			http.Error(w, "short body", http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		f.puts++
		if f.failOnce[n] {
			delete(f.failOnce, n)
			f.mu.Unlock()
			http.Error(w, "try again", http.StatusInternalServerError)
			return
		}
		sum := md5.Sum(body)
		etag := `"` + hex.EncodeToString(sum[:]) + `"`
		f.parts[n], f.etags[n] = body, etag
		f.mu.Unlock()
		w.Header().Set("ETag", etag)
	case http.MethodGet:
		f.mu.Lock()
		obj := f.object
		f.mu.Unlock()
		if obj == nil {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(obj)
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

// complete assembles the object as CompleteMultipartUpload would, failing
// the test on any rule R2 enforces.
func (f *fakeS3) complete(reported []protocol.UploadedPart) []byte {
	f.t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	slices.SortFunc(reported, func(a, b protocol.UploadedPart) int { return a.PartNumber - b.PartNumber })
	if len(reported) == 0 || len(reported) > protocol.MaxBackupParts {
		f.t.Fatalf("%d parts", len(reported))
	}
	var obj []byte
	for i, p := range reported {
		if p.PartNumber != i+1 {
			f.t.Fatalf("part numbers not contiguous: %v", reported)
		}
		body := f.parts[p.PartNumber]
		if f.etags[p.PartNumber] != p.ETag || int64(len(body)) != p.Size {
			f.t.Fatalf("part %d: reported etag %s size %d, stored %s size %d", p.PartNumber, p.ETag, p.Size,
				f.etags[p.PartNumber], len(body))
		}
		if i < len(reported)-1 {
			if len(body) < protocol.MinBackupPartBytes {
				f.t.Fatalf("part %d is %d bytes, under R2's minimum", p.PartNumber, len(body))
			}
			if len(body) != len(f.parts[1]) {
				f.t.Fatalf("part %d is %d bytes, part 1 is %d: non-final parts must be equal", p.PartNumber,
					len(body), len(f.parts[1]))
			}
		}
		obj = append(obj, body...)
	}
	f.object = obj
	return obj
}

// fakeVolumes serves one directory per volume.
type fakeVolumes struct {
	root string
}

func (v fakeVolumes) Use(id string) (string, func(), error) {
	p := filepath.Join(v.root, "mnt", id, "data")
	if _, err := os.Stat(p); err != nil {
		return "", nil, fmt.Errorf("volume %s not ready", id)
	}
	return p, func() {}, nil
}

func (v fakeVolumes) TempDir() (string, error) {
	p := filepath.Join(v.root, "tmp")
	return p, os.MkdirAll(p, 0o700)
}

// fakeWorkloads records holds and answers health from a function.
type fakeWorkloads struct {
	mu      sync.Mutex
	held    map[string]bool
	events  []string
	healthy func() error
}

func (w *fakeWorkloads) Container(string) (string, bool, bool) { return "", false, false }

func (w *fakeWorkloads) Hold(_ context.Context, id, _ string) (func(), error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.held == nil {
		w.held = map[string]bool{}
	}
	if w.held[id] {
		return nil, errors.New("held twice")
	}
	w.held[id] = true
	w.events = append(w.events, "stop "+id)
	return sync.OnceFunc(func() {
		w.mu.Lock()
		defer w.mu.Unlock()
		w.held[id] = false
		w.events = append(w.events, "start "+id)
	}), nil
}

func (w *fakeWorkloads) WaitHealthy(context.Context, string) error {
	if w.healthy == nil {
		return nil
	}
	return w.healthy()
}

func (w *fakeWorkloads) log() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.events)
}

// harness wires a runner to the fakes and collects what it sends.
type harness struct {
	t   *testing.T
	s3  *fakeS3
	r   *Runner
	vol fakeVolumes
	wl  *fakeWorkloads

	mu       sync.Mutex
	sent     []protocol.AgentMessage
	requests []protocol.BackupPartsRequest
	// answer, when set, answers backup_parts_request frames.
	answer bool
	stop   context.CancelFunc
	done   chan struct{}
}

func newHarness(t *testing.T) *harness {
	h := &harness{t: t, s3: newFakeS3(t), vol: fakeVolumes{root: t.TempDir()}, wl: &fakeWorkloads{}, done: make(chan struct{})}
	h.r = New(Options{
		Workloads: h.wl, Volumes: h.vol, Key: sealtest.Key(), NodeID: testNode, Send: h.send,
		Log: func(string, protocol.LogStream, string) {},
	})
	ctx, cancel := context.WithCancel(context.Background())
	h.stop = cancel
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

func (h *harness) send(_ context.Context, m protocol.AgentMessage) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if _, err := protocol.DecodeAgentMessage(data); err != nil {
		h.t.Errorf("agent frame does not validate: %v: %s", err, data)
	}
	h.mu.Lock()
	h.sent = append(h.sent, m)
	answer := h.answer
	h.mu.Unlock()
	if req, ok := m.(*protocol.BackupPartsRequest); ok {
		h.mu.Lock()
		h.requests = append(h.requests, *req)
		h.mu.Unlock()
		if answer {
			var urls []protocol.BackupPartURL
			for n := req.FromPart; n < req.FromPart+req.Count; n++ {
				urls = append(urls, protocol.BackupPartURL{PartNumber: n, URL: h.s3.partURL(n)})
			}
			go h.r.AddParts(&protocol.BackupParts{
				Type: protocol.TypeBackupParts, BackupID: req.BackupID, PartsSealed: *h.sealParts(req.BackupID, urls),
			})
		}
	}
	return nil
}

func (h *harness) sealParts(backupID string, parts []protocol.BackupPartURL) *protocol.SealedBox {
	pt, _ := json.Marshal(protocol.SealedBackupParts{Parts: parts})
	box, err := protocol.SealBox(sealtest.Key().PublicKey(), pt, protocol.BoxPurposeBackupParts,
		protocol.BackupPartsAAD(testNode, backupID))
	if err != nil {
		h.t.Fatal(err)
	}
	return box
}

func (h *harness) sealRestore(id, url, identity string) *protocol.SealedBox {
	pt, _ := json.Marshal(protocol.SealedRestoreSecrets{DownloadURL: url, AgeIdentity: identity})
	box, err := protocol.SealBox(sealtest.Key().PublicKey(), pt, protocol.BoxPurposeRestore,
		protocol.RestoreSecretsAAD(testNode, id))
	if err != nil {
		h.t.Fatal(err)
	}
	return box
}

func (h *harness) waitFor(what string, pred func(m protocol.AgentMessage) bool) protocol.AgentMessage {
	h.t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		h.mu.Lock()
		for _, m := range h.sent {
			if pred(m) {
				h.mu.Unlock()
				return m
			}
		}
		h.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	h.t.Fatalf("timed out waiting for %s", what)
	return nil
}

func (h *harness) backupResult(id string) *protocol.BackupResult {
	h.t.Helper()
	return h.waitFor("backup_result", func(m protocol.AgentMessage) bool {
		r, ok := m.(*protocol.BackupResult)
		return ok && r.BackupID == id
	}).(*protocol.BackupResult)
}

func (h *harness) restoreResult(id string) *protocol.RestoreResult {
	h.t.Helper()
	return h.waitFor("restore_result", func(m protocol.AgentMessage) bool {
		r, ok := m.(*protocol.RestoreResult)
		return ok && r.RestoreID == id
	}).(*protocol.RestoreResult)
}

func (h *harness) uploaded() []protocol.UploadedPart {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []protocol.UploadedPart
	for _, m := range h.sent {
		if p, ok := m.(*protocol.BackupProgress); ok {
			out = append(out, p.Parts...)
		}
	}
	return out
}

func (h *harness) volume(id string) string {
	p := filepath.Join(h.vol.root, "mnt", id, "data")
	if err := os.MkdirAll(p, 0o755); err != nil {
		h.t.Fatal(err)
	}
	return p
}

func header(id string) protocol.ControlHeader {
	now := time.Now().UnixMilli()
	return protocol.ControlHeader{ID: "msg_" + id, NodeID: testNode, IssuedAt: now, ExpiresAt: now + 60_000}
}

// fill writes size random (incompressible) bytes to path.
func fill(t *testing.T, path string, size int) []byte {
	t.Helper()
	data := make([]byte, size)
	_, _ = rand.Read(data)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o640); err != nil {
		t.Fatal(err)
	}
	return data
}

func snapshotJob(h *harness, id string, recipient string, initial int, quiesce bool) *protocol.BackupJob {
	var urls []protocol.BackupPartURL
	for n := 1; n <= initial; n++ {
		urls = append(urls, protocol.BackupPartURL{PartNumber: n, URL: h.s3.partURL(n)})
	}
	j := &protocol.BackupJob{
		Type: protocol.TypeBackupJob, ControlHeader: header(id), BackupID: id,
		BackupSource:  protocol.BackupSource{Method: protocol.BackupSnapshot, VolumeID: "vol_1"},
		Quiesce:       "none",
		AgeRecipient:  recipient,
		PartSizeBytes: protocol.MinBackupPartBytes,
		PartsSealed:   *h.sealParts(id, urls),
		TimeoutS:      600,
	}
	if quiesce {
		j.Quiesce, j.WorkloadID = "stop", "wl_db"
	}
	if err := j.Validate(); err != nil {
		h.t.Fatal(err)
	}
	return j
}

func TestSnapshotBackupAndRestoreRoundTrip(t *testing.T) {
	h := newHarness(t)
	h.answer = true
	identity, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	data := h.volume("vol_1")
	big := fill(t, filepath.Join(data, "pgdata", "base", "16384"), 13<<20)
	small := fill(t, filepath.Join(data, "pgdata", "PG_VERSION"), 3)
	if err := os.WriteFile(filepath.Join(data, "empty"), nil, 0o600); err != nil {
		t.Fatal(err)
	}

	// Two URLs up front: the third part's comes from a backup_parts.
	h.r.StartBackup(snapshotJob(h, "bak_1", identity.Recipient().String(), 2, true))
	res := h.backupResult("bak_1")
	if !res.OK {
		t.Fatalf("backup failed: %s", res.Error)
	}
	parts := h.uploaded()
	if *res.PartCount != len(parts) || *res.PartCount < 3 {
		t.Fatalf("part_count %d, progress reported %d parts", *res.PartCount, len(parts))
	}
	obj := h.s3.complete(parts)
	sum := sha256.Sum256(obj)
	if *res.BytesStored != int64(len(obj)) || res.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("stored %d bytes sha %s; object is %d bytes sha %x", *res.BytesStored, res.SHA256, len(obj), sum)
	}
	if *res.BytesRaw < int64(len(big)) {
		t.Fatalf("bytes_raw %d", *res.BytesRaw)
	}
	if len(h.requests) == 0 || h.requests[0].FromPart != 3 {
		t.Fatalf("part URL requests %v", h.requests)
	}
	if got := h.wl.log(); !slices.Equal(got, []string{"stop wl_db", "start wl_db"}) {
		t.Fatalf("workload events %v", got)
	}

	// Restore into the volume, which has changed since.
	if err := os.WriteFile(filepath.Join(data, "pgdata", "PG_VERSION"), []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	fill(t, filepath.Join(data, "later"), 10)
	job := &protocol.RestoreJob{
		Type: protocol.TypeRestoreJob, ControlHeader: header("rst_1"), RestoreID: "rst_1",
		BackupSource: protocol.BackupSource{Method: protocol.BackupSnapshot, VolumeID: "vol_1", WorkloadID: "wl_db"},
		RestoreTarget: protocol.RestoreTarget{
			BackupID: "bak_1", SHA256: res.SHA256, SizeBytes: *res.BytesStored, TimeoutS: 600,
			SecretsSealed: *h.sealRestore("rst_1", h.s3.objectURL(), identity.String()),
		},
	}
	if err := job.Validate(); err != nil {
		t.Fatal(err)
	}
	h.r.StartRestore(job)
	rr := h.restoreResult("rst_1")
	if !rr.OK {
		t.Fatalf("restore failed: %s", rr.Error)
	}
	if got, _ := os.ReadFile(filepath.Join(data, "pgdata", "base", "16384")); !bytes.Equal(got, big) {
		t.Fatal("big file differs after restore")
	}
	if got, _ := os.ReadFile(filepath.Join(data, "pgdata", "PG_VERSION")); !bytes.Equal(got, small) {
		t.Fatalf("PG_VERSION is %q after restore", got)
	}
	if _, err := os.Stat(filepath.Join(data, "later")); !os.IsNotExist(err) {
		t.Fatalf("file written after the backup survived the restore: %v", err)
	}
	if _, err := os.Stat(data + ".pre-restore"); !os.IsNotExist(err) {
		t.Fatalf("pre-restore copy was kept: %v", err)
	}
	if got := h.wl.log(); !slices.Equal(got, []string{"stop wl_db", "start wl_db", "stop wl_db", "start wl_db"}) {
		t.Fatalf("workload events %v", got)
	}
}

func TestRestoreRollsBackWhenTheWorkloadStaysUnhealthy(t *testing.T) {
	h := newHarness(t)
	h.answer = true
	identity, _ := age.GenerateX25519Identity()
	data := h.volume("vol_1")
	fill(t, filepath.Join(data, "a"), 100)
	h.r.StartBackup(snapshotJob(h, "bak_1", identity.Recipient().String(), 1, false))
	res := h.backupResult("bak_1")
	if !res.OK {
		t.Fatal(res.Error)
	}
	h.s3.complete(h.uploaded())

	current := fill(t, filepath.Join(data, "a"), 50)
	h.wl.healthy = func() error { return errors.New("probe failing") }
	job := &protocol.RestoreJob{
		Type: protocol.TypeRestoreJob, ControlHeader: header("rst_2"), RestoreID: "rst_2",
		BackupSource: protocol.BackupSource{Method: protocol.BackupSnapshot, VolumeID: "vol_1", WorkloadID: "wl_db"},
		RestoreTarget: protocol.RestoreTarget{
			BackupID: "bak_1", SHA256: res.SHA256, SizeBytes: *res.BytesStored, TimeoutS: 600,
			SecretsSealed: *h.sealRestore("rst_2", h.s3.objectURL(), identity.String()),
		},
	}
	h.r.StartRestore(job)
	rr := h.restoreResult("rst_2")
	if rr.OK || !strings.Contains(rr.Error, "unhealthy") {
		t.Fatalf("restore result %+v", rr)
	}
	if got, _ := os.ReadFile(filepath.Join(data, "a")); !bytes.Equal(got, current) {
		t.Fatal("the previous data was not put back")
	}
	if got := h.wl.log(); !slices.Equal(got, []string{"stop wl_db", "start wl_db", "stop wl_db", "start wl_db"}) {
		t.Fatalf("workload events %v: the workload must end started", got)
	}
}

func TestRestoreRefusesATamperedObject(t *testing.T) {
	h := newHarness(t)
	h.answer = true
	identity, _ := age.GenerateX25519Identity()
	data := h.volume("vol_1")
	keep := fill(t, filepath.Join(data, "a"), 100)
	h.r.StartBackup(snapshotJob(h, "bak_1", identity.Recipient().String(), 1, false))
	res := h.backupResult("bak_1")
	obj := h.s3.complete(h.uploaded())
	obj[len(obj)-1] ^= 1

	job := &protocol.RestoreJob{
		Type: protocol.TypeRestoreJob, ControlHeader: header("rst_3"), RestoreID: "rst_3",
		BackupSource: protocol.BackupSource{Method: protocol.BackupSnapshot, VolumeID: "vol_1"},
		RestoreTarget: protocol.RestoreTarget{
			BackupID: "bak_1", SHA256: res.SHA256, SizeBytes: *res.BytesStored, TimeoutS: 600,
			SecretsSealed: *h.sealRestore("rst_3", h.s3.objectURL(), identity.String()),
		},
	}
	h.r.StartRestore(job)
	rr := h.restoreResult("rst_3")
	if rr.OK || !strings.Contains(rr.Error, "SHA-256") {
		t.Fatalf("restore result %+v", rr)
	}
	if got, _ := os.ReadFile(filepath.Join(data, "a")); !bytes.Equal(got, keep) {
		t.Fatal("data changed by a refused restore")
	}
}

func TestBackupJobSealedForAnotherBackupFails(t *testing.T) {
	h := newHarness(t)
	identity, _ := age.GenerateX25519Identity()
	h.volume("vol_1")
	j := snapshotJob(h, "bak_1", identity.Recipient().String(), 1, false)
	// The box is bound to bak_1; replayed under another backup ID it must
	// not open.
	j.BackupID, j.ID = "bak_2", "msg_bak_2"
	h.r.StartBackup(j)
	res := h.backupResult("bak_2")
	if res.OK || !strings.Contains(res.Error, "bak_2") {
		t.Fatalf("result %+v", res)
	}
	if h.s3.puts != 0 {
		t.Fatalf("%d PUTs for a job whose URLs did not open", h.s3.puts)
	}
}

func TestRestoreSecretsSealedToAnotherNodeFail(t *testing.T) {
	h := newHarness(t)
	h.volume("vol_1")
	identity, _ := age.GenerateX25519Identity()
	pt, _ := json.Marshal(protocol.SealedRestoreSecrets{DownloadURL: h.s3.objectURL(), AgeIdentity: identity.String()})
	box, _ := protocol.SealBox(sealtest.Key().PublicKey(), pt, protocol.BoxPurposeRestore,
		protocol.RestoreSecretsAAD("node_other", "rst_1"))
	h.r.StartRestore(&protocol.RestoreJob{
		Type: protocol.TypeRestoreJob, ControlHeader: header("rst_1"), RestoreID: "rst_1",
		BackupSource: protocol.BackupSource{Method: protocol.BackupSnapshot, VolumeID: "vol_1"},
		RestoreTarget: protocol.RestoreTarget{
			BackupID: "bak_1", SHA256: strings.Repeat("0", 64), SizeBytes: 10, TimeoutS: 600, SecretsSealed: *box,
		},
	})
	if rr := h.restoreResult("rst_1"); rr.OK {
		t.Fatal("a box for another node opened")
	}
}

func TestBackupFailsOnAMissingVolumeWithoutUploading(t *testing.T) {
	h := newHarness(t)
	identity, _ := age.GenerateX25519Identity()
	h.r.StartBackup(snapshotJob(h, "bak_1", identity.Recipient().String(), 1, false))
	if res := h.backupResult("bak_1"); res.OK || !strings.Contains(res.Error, "not ready") {
		t.Fatalf("result %+v", res)
	}
	if h.s3.puts != 0 {
		t.Fatalf("%d PUTs", h.s3.puts)
	}
}

func TestCopyOutAndCopyInAnswerAsBackupAndRestore(t *testing.T) {
	h := newHarness(t)
	h.answer = true
	identity, _ := age.GenerateX25519Identity()
	src := h.volume("vol_src")
	payload := fill(t, filepath.Join(src, "dir", "f"), 4096)
	out := &protocol.VolumeCopyOut{
		Type: protocol.TypeVolumeCopyOut, ControlHeader: header("cpo"), MigrationID: "mig_1", BackupID: "bak_1",
		VolumeID: "vol_src", WorkloadID: "wl_db", AgeRecipient: identity.Recipient().String(),
		PartSizeBytes: protocol.MinBackupPartBytes,
		PartsSealed:   *h.sealParts("bak_1", []protocol.BackupPartURL{{PartNumber: 1, URL: h.s3.partURL(1)}}),
		TimeoutS:      600,
	}
	if err := out.Validate(); err != nil {
		t.Fatal(err)
	}
	h.r.StartCopyOut(out)
	res := h.backupResult("bak_1")
	if !res.OK {
		t.Fatal(res.Error)
	}
	h.s3.complete(h.uploaded())

	dst := h.volume("vol_dst")
	in := &protocol.VolumeCopyIn{
		Type: protocol.TypeVolumeCopyIn, ControlHeader: header("cpi"), MigrationID: "mig_1", VolumeID: "vol_dst",
		RestoreTarget: protocol.RestoreTarget{
			BackupID: "bak_1", SHA256: res.SHA256, SizeBytes: *res.BytesStored, TimeoutS: 600,
			SecretsSealed: *h.sealRestore("mig_1", h.s3.objectURL(), identity.String()),
		},
	}
	if err := in.Validate(); err != nil {
		t.Fatal(err)
	}
	h.r.StartCopyIn(in)
	if rr := h.restoreResult("mig_1"); !rr.OK {
		t.Fatal(rr.Error)
	}
	if got, _ := os.ReadFile(filepath.Join(dst, "dir", "f")); !bytes.Equal(got, payload) {
		t.Fatal("copied data differs")
	}
	if got := h.wl.log(); !slices.Equal(got, []string{"stop wl_db", "start wl_db"}) {
		t.Fatalf("workload events %v", got)
	}
}
