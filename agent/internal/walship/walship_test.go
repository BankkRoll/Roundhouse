package walship

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"filippo.io/age"
	"github.com/klauspost/compress/zstd"

	"github.com/BankkRoll/Roundhouse/agent/internal/sealtest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

const testNode = "node_test1"

// objects is a fake bucket that takes presigned PUTs.
type objects struct {
	srv *httptest.Server

	mu   sync.Mutex
	puts map[string][]byte
	fail bool
}

func newObjects(t *testing.T) *objects {
	o := &objects{puts: map[string][]byte{}}
	o.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		o.mu.Lock()
		defer o.mu.Unlock()
		if r.Method != http.MethodPut || r.ContentLength < 0 || o.fail {
			http.Error(w, "no", http.StatusBadRequest)
			return
		}
		body, _ := io.ReadAll(r.Body)
		o.puts[r.URL.Path] = body
	}))
	t.Cleanup(o.srv.Close)
	return o
}

func (o *objects) url(name string) string {
	return o.srv.URL + "/bucket/wal/" + name + "?X-Amz-Signature=test-only"
}

func (o *objects) get(name string) []byte {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.puts["/bucket/wal/"+name]
}

// dirVolumes serves one directory per volume.
type dirVolumes struct{ root string }

func (v dirVolumes) Use(id string) (string, func(), error) {
	p := filepath.Join(v.root, id, "data")
	if _, err := os.Stat(p); err != nil {
		return "", nil, errors.New("not ready")
	}
	return p, func() {}, nil
}

type harness struct {
	t    *testing.T
	s    *Shipper
	obj  *objects
	data string
	id   *age.X25519Identity

	mu   sync.Mutex
	sent []*protocol.WALArchive
}

func newHarness(t *testing.T) *harness {
	root := t.TempDir()
	data := filepath.Join(root, "vol_1", "data")
	// The database's data directory, whose owner the spool takes.
	if err := os.MkdirAll(filepath.Join(data, "18", "docker"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "18", "docker", "PG_VERSION"), []byte("18\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	id, _ := age.GenerateX25519Identity()
	h := &harness{t: t, obj: newObjects(t), data: data, id: id}
	h.s = New(Options{
		NodeID: testNode, Key: sealtest.Key(), Volumes: dirVolumes{root},
		Send: func(_ context.Context, m protocol.AgentMessage) error {
			raw, _ := json.Marshal(m)
			if _, err := protocol.DecodeAgentMessage(raw); err != nil {
				t.Errorf("invalid frame: %v: %s", err, raw)
			}
			h.mu.Lock()
			h.sent = append(h.sent, m.(*protocol.WALArchive))
			h.mu.Unlock()
			return nil
		},
		Interval: 20 * time.Millisecond, Resend: time.Hour,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_ = h.s.Run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	h.s.Apply(1, []protocol.VolumeSpec{{ID: "vol_1", WALArchive: &protocol.WALArchiveSpec{
		StreamID: "wal_1", AgeRecipient: id.Recipient().String(),
	}}})
	return h
}

func (h *harness) spool(name string) string {
	return filepath.Join(h.data, protocol.WALSpoolDir, name)
}

func (h *harness) write(name, content string, mtime time.Time) {
	h.t.Helper()
	// Written aside and renamed in, as archive_command does, so a scan never
	// sees it half-made.
	tmp := h.spool("." + name + ".tmp")
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		h.t.Fatal(err)
	}
	if err := os.Chtimes(tmp, mtime, mtime); err != nil {
		h.t.Fatal(err)
	}
	if err := os.Rename(tmp, h.spool(name)); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) waitFor(what string, ok func(*protocol.WALArchive) bool) *protocol.WALArchive {
	h.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		h.mu.Lock()
		for _, m := range h.sent {
			if ok(m) {
				h.mu.Unlock()
				return m
			}
		}
		h.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	h.t.Fatalf("no report with %s", what)
	return nil
}

func (h *harness) ack(acked []string, uploads ...string) {
	h.t.Helper()
	m := &protocol.WALArchiveAck{
		Type: protocol.TypeWALArchiveAck, VolumeID: "vol_1", StreamID: "wal_1", Acked: acked,
	}
	if len(uploads) > 0 {
		var us []protocol.WALUpload
		for _, n := range uploads {
			us = append(us, protocol.WALUpload{Name: n, URL: h.obj.url(n)})
		}
		pt, _ := json.Marshal(protocol.SealedWALUploads{Uploads: us})
		box, err := protocol.SealBox(sealtest.Key().PublicKey(), pt, protocol.BoxPurposeWALUpload, protocol.WALUploadAAD(testNode, "wal_1"))
		if err != nil {
			h.t.Fatal(err)
		}
		m.UploadsSealed = box
	}
	h.s.Ack(m)
}

func decrypt(t *testing.T, id *age.X25519Identity, stored []byte) []byte {
	t.Helper()
	dec, err := age.Decrypt(bytes.NewReader(stored), id)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zstd.NewReader(dec)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestShipsSpooledFilesAndForgetsThemOnlyOnceAcked(t *testing.T) {
	h := newHarness(t)
	const seg, hist = "000000010000000000000002", "00000002.history"
	waitDir(t, filepath.Join(h.data, protocol.WALSpoolDir))
	base := time.Now().Add(-time.Minute)
	h.write(hist, "2\t0/3000000\tno recovery target specified\n", base.Add(time.Second))
	h.write(seg, strings.Repeat("wal record ", 4000), base)
	h.write(".000000010000000000000003.tmp", "half", base)
	h.write("archive_status", "not wal", base)

	first := h.waitFor("pending files", func(m *protocol.WALArchive) bool { return len(m.Pending) == 2 })
	if first.Pending[0] != seg || first.Pending[1] != hist || len(first.Archived) != 0 {
		t.Fatalf("pending %v archived %v: oldest first, nothing else", first.Pending, first.Archived)
	}

	h.ack([]string{}, seg, hist)
	report := h.waitFor("archived files", func(m *protocol.WALArchive) bool { return len(m.Archived) == 2 })
	if len(report.Pending) != 0 {
		t.Fatalf("still pending: %v", report.Pending)
	}
	for _, a := range report.Archived {
		stored := h.obj.get(a.Name)
		sum := sha256.Sum256(stored)
		if int64(len(stored)) != a.SizeStored || hex.EncodeToString(sum[:]) != a.SHA256 {
			t.Fatalf("%s: record doesn't match the upload", a.Name)
		}
		if a.Name == seg {
			if got := decrypt(t, h.id, stored); string(got) != strings.Repeat("wal record ", 4000) || a.SizeRaw != int64(len(got)) {
				t.Fatal("the stored segment doesn't decrypt to the spooled one")
			}
			if a.ArchivedAt != base.UnixMilli() {
				t.Fatalf("archived_at %d, want the spool copy's mtime %d", a.ArchivedAt, base.UnixMilli())
			}
		}
	}
	// SECURITY: shipped files stay on the volume until the control plane
	// has recorded them.
	if _, err := os.Stat(h.spool(seg + doneSuffix)); err != nil {
		t.Fatalf("record gone before the ack: %v", err)
	}
	if _, err := os.Stat(h.spool(seg)); !os.IsNotExist(err) {
		t.Fatalf("spool copy kept after its upload: %v", err)
	}

	h.ack([]string{seg, hist})
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, e1 := os.Stat(h.spool(seg + doneSuffix))
		_, e2 := os.Stat(h.spool(hist + doneSuffix))
		if os.IsNotExist(e1) && os.IsNotExist(e2) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("acknowledged records were kept")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := os.Stat(h.spool("archive_status")); err != nil {
		t.Fatal("a file that isn't WAL was touched")
	}
}

func TestFailedUploadsAreRetriedAndForeignStreamsIgnored(t *testing.T) {
	h := newHarness(t)
	const seg = "000000010000000000000005"
	waitDir(t, filepath.Join(h.data, protocol.WALSpoolDir))
	h.write(seg, "segment", time.Now())
	h.waitFor("the segment", func(m *protocol.WALArchive) bool { return len(m.Pending) == 1 })

	h.obj.mu.Lock()
	h.obj.fail = true
	h.obj.mu.Unlock()
	h.ack([]string{}, seg)
	time.Sleep(100 * time.Millisecond)
	if _, err := os.Stat(h.spool(seg)); err != nil {
		t.Fatalf("a failed upload lost the spool copy: %v", err)
	}

	// An ack for another stream (an older one, after a restore) is dropped.
	h.s.Ack(&protocol.WALArchiveAck{Type: protocol.TypeWALArchiveAck, VolumeID: "vol_1", StreamID: "wal_old", Acked: []string{seg}})
	time.Sleep(50 * time.Millisecond)
	if _, err := os.Stat(h.spool(seg)); err != nil {
		t.Fatal("an ack for another stream removed a file")
	}

	h.obj.mu.Lock()
	h.obj.fail = false
	h.obj.mu.Unlock()
	h.ack([]string{}, seg)
	h.waitFor("the retried upload", func(m *protocol.WALArchive) bool { return len(m.Archived) == 1 })
}

func TestRefusesASymlinkedSpool(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	h := newHarness(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "000000010000000000000009"), []byte("host secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	spool := filepath.Join(h.data, protocol.WALSpoolDir)
	waitDir(t, spool)
	if err := os.Remove(spool); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, spool); err != nil {
		t.Fatal(err)
	}
	// A symlinked file inside a real spool is refused as well.
	time.Sleep(100 * time.Millisecond)
	h.mu.Lock()
	n := len(h.sent)
	h.mu.Unlock()
	if n != 0 {
		t.Fatalf("reported a spool that is a symlink: %+v", h.sent[0])
	}
	if err := os.Remove(spool); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(spool, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "000000010000000000000009"), filepath.Join(spool, "000000010000000000000009")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	h.mu.Lock()
	n = len(h.sent)
	h.mu.Unlock()
	if n != 0 {
		t.Fatal("reported a symlink as a WAL file")
	}
}

func TestStopsShippingVolumesNoLongerListed(t *testing.T) {
	h := newHarness(t)
	if got := h.s.Streams(); len(got) != 1 {
		t.Fatalf("streams %v", got)
	}
	h.s.Apply(1, nil)
	if got := h.s.Streams(); len(got) != 1 {
		t.Fatal("an old generation changed the streams")
	}
	h.s.Apply(2, []protocol.VolumeSpec{{ID: "vol_1"}})
	if got := h.s.Streams(); len(got) != 0 {
		t.Fatalf("still shipping %v", got)
	}
}

func waitDir(t *testing.T, dir string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s was never created", dir)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
