package conn

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"filippo.io/age"

	"github.com/BankkRoll/Roundhouse/agent/internal/leaktest"
	"github.com/BankkRoll/Roundhouse/agent/internal/sealtest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// fakeData records the data-plane frames it is handed.
type fakeData struct {
	mu  sync.Mutex
	got []string
}

func (f *fakeData) add(s string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, s)
}

func (f *fakeData) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.got)
}

func (f *fakeData) DeleteVolume(m *protocol.VolumeDelete)  { f.add("volume_delete " + m.VolumeID) }
func (f *fakeData) StartBackup(m *protocol.BackupJob)      { f.add("backup_job " + m.BackupID) }
func (f *fakeData) AddBackupParts(m *protocol.BackupParts) { f.add("backup_parts " + m.BackupID) }
func (f *fakeData) StartRestore(m *protocol.RestoreJob)    { f.add("restore_job " + m.RestoreID) }
func (f *fakeData) StartCopyOut(m *protocol.VolumeCopyOut) { f.add("volume_copy_out " + m.MigrationID) }
func (f *fakeData) StartCopyIn(m *protocol.VolumeCopyIn)   { f.add("volume_copy_in " + m.MigrationID) }
func (f *fakeData) RunQuery(m *protocol.DBQuery)           { f.add("db_query " + m.RequestID) }

func backupJob(t *testing.T, id string, ttl time.Duration) *protocol.BackupJob {
	t.Helper()
	ident, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	pt, _ := json.Marshal(protocol.SealedBackupParts{Parts: []protocol.BackupPartURL{{PartNumber: 1, URL: "https://s3.example.com/b/k?partNumber=1&uploadId=u&X-Amz-Signature=abc"}}})
	box, err := protocol.SealBox(sealtest.Key().PublicKey(), pt, protocol.BoxPurposeBackupParts, protocol.BackupPartsAAD(testNodeID, id))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	return &protocol.BackupJob{
		Type:          protocol.TypeBackupJob,
		ControlHeader: protocol.ControlHeader{ID: "m_" + id, NodeID: testNodeID, IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(ttl).UnixMilli()},
		BackupID:      id,
		BackupSource:  protocol.BackupSource{Method: protocol.BackupSnapshot, VolumeID: "vol_1"},
		Quiesce:       "none",
		AgeRecipient:  ident.Recipient().String(),
		PartSizeBytes: 16 << 20,
		PartsSealed:   *box,
		TimeoutS:      600,
	}
}

func TestDataFramesAreDispatchedAndCredentialFramesExpireFast(t *testing.T) {
	leaktest.Check(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	cp := newFakeControlPlane(t)
	logs := &syncBuffer{}
	c := newTestClient(t, cp.url(), pub, nil, logs)
	data := &fakeData{}
	c.Data = data
	var raised []int
	var mu sync.Mutex
	c.OnPeerProtocol = func(v int) { mu.Lock(); raised = append(raised, v); mu.Unlock() }
	stop := startClient(t, c)
	cp.next(t)

	if v := c.PeerProtocolVersion(); v != 0 {
		t.Fatalf("peer version %d before any frame", v)
	}
	future := time.Now().Add(time.Minute)
	cp.push(t, priv, &protocol.Welcome{Type: protocol.TypeWelcome, ControlHeader: header("m_w", future), HeartbeatIntervalMS: 10_000})
	waitFor(t, "a plain welcome", func() bool { return c.PeerProtocolVersion() == protocol.MinProtocolVersion })

	// SECURITY: a credential-bearing frame that lives longer than the
	// credential TTL is dropped before any handler sees it.
	cp.push(t, priv, backupJob(t, "bak_long", 2*time.Minute))
	cp.push(t, priv, &protocol.VolumeDelete{Type: protocol.TypeVolumeDelete, ControlHeader: header("m_del", future), VolumeID: "vol_9"})
	cp.push(t, priv, backupJob(t, "bak_ok", 30*time.Second))
	waitFor(t, "the data frames", func() bool { return len(data.seen()) == 2 })
	if got := data.seen(); !slices.Equal(got, []string{"volume_delete vol_9", "backup_job bak_ok"}) {
		t.Fatalf("dispatched %v", got)
	}
	if !strings.Contains(logs.String(), "dropping control frame") {
		t.Fatal("the long-lived credential frame was not logged as dropped")
	}
	if v := c.PeerProtocolVersion(); v != protocol.BackupsProtocolVersion {
		t.Fatalf("peer version %d after data frames", v)
	}

	interval := int64(15_000)
	cp.push(t, priv, &protocol.Welcome{Type: protocol.TypeWelcome, ControlHeader: header("m_w2", future),
		HeartbeatIntervalMS: 10_000, MetricsIntervalMS: &interval})
	waitFor(t, "a metrics welcome", func() bool { return c.PeerProtocolVersion() == protocol.MetricsProtocolVersion })
	mu.Lock()
	got := slices.Clone(raised)
	mu.Unlock()
	if !slices.Equal(got, []int{protocol.MinProtocolVersion, protocol.BackupsProtocolVersion, protocol.MetricsProtocolVersion}) {
		t.Fatalf("raised %v", got)
	}
	if err := stop(); err != nil {
		t.Fatal(err)
	}
	if v := c.PeerProtocolVersion(); v != 0 {
		t.Fatalf("peer version %d after disconnect", v)
	}
}

func TestDesiredStateVersion(t *testing.T) {
	ds := &protocol.DesiredState{}
	if v := desiredStateVersion(ds); v != protocol.MinProtocolVersion {
		t.Fatalf("plain: %d", v)
	}
	ds.Volumes = []protocol.VolumeSpec{}
	if v := desiredStateVersion(ds); v != protocol.VolumesProtocolVersion {
		t.Fatalf("volumes: %d", v)
	}
	ds.Certificates = []protocol.CertificateRef{}
	if v := desiredStateVersion(ds); v != protocol.CertsProtocolVersion {
		t.Fatalf("certificates: %d", v)
	}
}
