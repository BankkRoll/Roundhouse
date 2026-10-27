package protocol

import (
	"encoding/json"
	"reflect"
	"testing"
)

var pitrAgentFixtures = map[string]AgentMessage{
	"backup-result-base.json": &BackupResult{},
	"wal-archive.json":        &WALArchive{},
	"wal-fetch-request.json":  &WALFetchRequest{},
}

// TestPITRAgentFixtures decodes the protocol 8 agent fixtures strictly and
// re-encodes them to the same JSON.
func TestPITRAgentFixtures(t *testing.T) {
	for file, want := range pitrAgentFixtures {
		t.Run(file, func(t *testing.T) {
			data := readFixture(t, file)
			m, err := DecodeAgentMessage(data)
			if err != nil {
				t.Fatal(err)
			}
			if reflect.TypeOf(m) != reflect.TypeOf(want) {
				t.Fatalf("got %T, want %T", m, want)
			}
			out, err := json.Marshal(m)
			if err != nil {
				t.Fatal(err)
			}
			var a, b any
			_ = json.Unmarshal(data, &a)
			_ = json.Unmarshal(out, &b)
			if !reflect.DeepEqual(a, b) {
				t.Errorf("round trip mismatch\nwant: %s\ngot:  %s", data, out)
			}
		})
	}
}

var pitrSignedFixtures = map[string]struct {
	want        ControlMessage
	credentials bool
}{
	"signed-desired-state-pitr.json": {&DesiredState{}, false},
	"signed-backup-job-base.json":    {&BackupJob{}, true},
	"signed-restore-job-base.json":   {&RestoreJob{}, true},
	"signed-wal-archive-ack.json":    {&WALArchiveAck{}, true},
	"signed-wal-fetch.json":          {&WALFetch{}, true},
}

// TestPITRSignedFixtures verifies the TS signatures, the credential TTL and
// a lossless round trip of every protocol 8 control frame.
func TestPITRSignedFixtures(t *testing.T) {
	for file, c := range pitrSignedFixtures {
		t.Run(file, func(t *testing.T) {
			msg, payload := verifyFixture(t, file)
			if reflect.TypeOf(msg) != reflect.TypeOf(c.want) {
				t.Fatalf("got %T, want %T", msg, c.want)
			}
			if CarriesCredentials(msg) != c.credentials {
				t.Errorf("CarriesCredentials = %v", !c.credentials)
			}
			assertRoundTrip(t, msg, payload)
		})
	}
	ds := signedPayload[*DesiredState](t, "signed-desired-state-pitr.json")
	if ds.Volumes[0].WALArchive == nil || ds.Volumes[0].WALArchive.StreamID == "" {
		t.Error("the volume lost its wal_archive")
	}
}

// TestPITRBoxesOpen opens the upload and fetch URLs with the fixture node
// key, and refuses them under another stream or restore.
func TestPITRBoxesOpen(t *testing.T) {
	f, node, _ := loadBoxFixture(t)
	ack := signedPayload[*WALArchiveAck](t, "signed-wal-archive-ack.json")
	uploads, err := OpenWALUploads(node, f.NodeID, ack)
	if err != nil || len(uploads) != 2 || uploads[1].Name != "00000002.history" {
		t.Fatalf("uploads %+v, %v", uploads, err)
	}
	other := *ack
	other.StreamID = "wal_other"
	if _, err := OpenWALUploads(node, f.NodeID, &other); err == nil {
		t.Error("uploads opened under another stream")
	}

	fetch := signedPayload[*WALFetch](t, "signed-wal-fetch.json")
	files, err := OpenWALFiles(node, f.NodeID, fetch)
	if err != nil || len(files) != 2 || files[0].Index != 1 || files[1].Name != "000000010000000000000004" {
		t.Fatalf("files %+v, %v", files, err)
	}
	moved := *fetch
	moved.RestoreID = "rst_other"
	if _, err := OpenWALFiles(node, f.NodeID, &moved); err == nil {
		t.Error("files opened under another restore")
	}
}

// TestPITRValidation pins the rules both languages enforce.
func TestPITRValidation(t *testing.T) {
	cases := map[string]struct {
		file   string
		mutate func(ControlMessage)
	}{
		"base of mysql":     {"signed-backup-job-base.json", func(m ControlMessage) { m.(*BackupJob).Engine = EngineMySQL }},
		"base without wl":   {"signed-backup-job-base.json", func(m ControlMessage) { m.(*BackupJob).WorkloadID = "" }},
		"quiesced base":     {"signed-backup-job-base.json", func(m ControlMessage) { m.(*BackupJob).Quiesce = "stop" }},
		"base without pitr": {"signed-restore-job-base.json", func(m ControlMessage) { m.(*RestoreJob).PITR = nil }},
		"dump with pitr":    {"signed-restore-job-base.json", func(m ControlMessage) { m.(*RestoreJob).Method = BackupDump }},
		"end without files": {"signed-restore-job-base.json", func(m ControlMessage) { m.(*RestoreJob).PITR.WALFiles = 0 }},
		"history as end": {"signed-restore-job-base.json", func(m ControlMessage) {
			end := "00000002.history"
			m.(*RestoreJob).PITR.WALEnd = &end
		}},
		"target without wal": {"signed-restore-job-base.json", func(m ControlMessage) {
			m.(*RestoreJob).PITR.WALFiles, m.(*RestoreJob).PITR.WALEnd = 0, nil
		}},
		"path in ack":        {"signed-wal-archive-ack.json", func(m ControlMessage) { m.(*WALArchiveAck).Acked = []string{"../x"} }},
		"nil acked":          {"signed-wal-archive-ack.json", func(m ControlMessage) { m.(*WALArchiveAck).Acked = nil }},
		"long-lived ack":     {"signed-wal-archive-ack.json", func(m ControlMessage) { m.(*WALArchiveAck).ExpiresAt += CredentialFrameTTLMS }},
		"long-lived fetch":   {"signed-wal-fetch.json", func(m ControlMessage) { m.(*WALFetch).ExpiresAt += CredentialFrameTTLMS }},
		"bad stream on spec": {"signed-desired-state-pitr.json", func(m ControlMessage) { m.(*DesiredState).Volumes[0].WALArchive.StreamID = "nope" }},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			msg, _ := verifyFixture(t, c.file)
			c.mutate(msg)
			if err := msg.(Validator).Validate(); err == nil {
				t.Error("validated")
			}
		})
	}
}

// TestPITRAgentValidation covers the agent frames' rules.
func TestPITRAgentValidation(t *testing.T) {
	bad := []string{
		`{"type":"wal_archive","volume_id":"vol_1","stream_id":"wal_1","archived":[],"pending":["../x"]}`,
		`{"type":"wal_archive","volume_id":"vol_1","stream_id":"wal_1","archived":[],"pending":["000000010000000000000002","000000010000000000000002"]}`,
		`{"type":"wal_archive","volume_id":"vol_1","stream_id":"wal_1","pending":[]}`,
		`{"type":"wal_fetch_request","restore_id":"rst_1","from":0,"count":0}`,
		`{"type":"wal_fetch_request","restore_id":"rst_1","from":-1,"count":1}`,
		`{"type":"backup_result","backup_id":"bak_1","ok":false,"error":"x","wal_start":"000000010000000000000002","duration_ms":1}`,
	}
	for _, raw := range bad {
		if _, err := DecodeAgentMessage([]byte(raw)); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}

// TestWALSegments pins the segment arithmetic pitr.ts implements too.
func TestWALSegments(t *testing.T) {
	cases := map[string]string{
		"000000010000000000000002": "000000010000000000000003",
		"0000000100000000000000FF": "000000010000000100000000",
		"00000002000000AB000000FE": "00000002000000AB000000FF",
	}
	for in, want := range cases {
		if got, err := NextWALSegment(in); err != nil || got != want {
			t.Errorf("NextWALSegment(%s) = %s, %v; want %s", in, got, err, want)
		}
	}
	if _, err := NextWALSegment("00000002.history"); err == nil {
		t.Error("a history file has a next segment")
	}
	if WALTimeline("00000002000000AB000000FE") != "00000002" {
		t.Error("timeline")
	}
	for _, ok := range []string{"000000010000000000000002.partial", "000000010000000000000002.00000028.backup", "00000002.history"} {
		if !ValidWALFileName(ok) {
			t.Errorf("rejected %s", ok)
		}
	}
	for _, bad := range []string{"", "x/000000010000000000000002", "000000010000000000000002.tmp", "archive_status"} {
		if ValidWALFileName(bad) {
			t.Errorf("accepted %q", bad)
		}
	}
}

// archiveCommand is the command pitr.test.ts pins too.
const archiveCommand = `[ -f "/var/lib/postgresql/roundhouse-wal/%f" ] || [ -f "/var/lib/postgresql/roundhouse-wal/%f.done" ] || ` +
	`{ cp "%p" "/var/lib/postgresql/roundhouse-wal/.%f.tmp" && sync "/var/lib/postgresql/roundhouse-wal/.%f.tmp" && ` +
	`mv "/var/lib/postgresql/roundhouse-wal/.%f.tmp" "/var/lib/postgresql/roundhouse-wal/%f" && sync "/var/lib/postgresql/roundhouse-wal"; }`

// TestPostgresArchiveArgs pins the archive command both languages build.
func TestPostgresArchiveArgs(t *testing.T) {
	got := PostgresArchiveArgs("/var/lib/postgresql/")
	want := []string{"-c", "archive_mode=on", "-c", "archive_command=" + archiveCommand, "-c", "archive_timeout=60"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %q", got)
	}
}
