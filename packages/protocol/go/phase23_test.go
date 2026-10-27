package protocol

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

var phase23AgentFixtures = map[string]AgentMessage{
	"hello-phase2.json":         &Hello{},
	"mesh-status.json":          &MeshStatus{},
	"mesh-key.json":             &MeshKey{},
	"volume-status.json":        &VolumeStatus{},
	"backup-parts-request.json": &BackupPartsRequest{},
	"backup-progress.json":      &BackupProgress{},
	"backup-result-ok.json":     &BackupResult{},
	"backup-result-failed.json": &BackupResult{},
	"restore-result.json":       &RestoreResult{},
	"db-query-result.json":      &DBQueryResult{},
	"job-status.json":           &JobStatus{},
	"metrics.json":              &Metrics{},
	"cert-ack.json":             &CertAck{},
	"cert-request.json":         &CertRequest{},
	"cert-status.json":          &CertStatus{},
	"logs-job.json":             &Logs{},
	"logs-task.json":            &Logs{},
}

// TestPhase23AgentFixtures decodes every new agent fixture strictly, checks
// its type, and re-encodes it to the same JSON, so a field that exists on
// only one side fails here or in fixtures.test.ts.
func TestPhase23AgentFixtures(t *testing.T) {
	for file, want := range phase23AgentFixtures {
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

var phase23SignedFixtures = map[string]ControlMessage{
	"signed-desired-state-phase2.json": &DesiredState{},
	"signed-desired-state-phase3.json": &DesiredState{},
	"signed-welcome-next-keys.json":    &Welcome{},
	"signed-key-announce.json":         &KeyAnnounce{},
	"signed-volume-delete.json":        &VolumeDelete{},
	"signed-backup-job.json":           &BackupJob{},
	"signed-backup-parts.json":         &BackupParts{},
	"signed-restore-job.json":          &RestoreJob{},
	"signed-volume-copy-out.json":      &VolumeCopyOut{},
	"signed-volume-copy-in.json":       &VolumeCopyIn{},
	"signed-db-query.json":             &DBQuery{},
	"signed-job-run.json":              &JobRun{},
	"signed-job-cancel.json":           &JobCancel{},
	"signed-cert-sync.json":            &CertSync{},
}

var credentialFixtures = map[string]bool{
	"signed-desired-state-phase2.json": true,
	"signed-backup-job.json":           true,
	"signed-backup-parts.json":         true,
	"signed-restore-job.json":          true,
	"signed-volume-copy-out.json":      true,
	"signed-volume-copy-in.json":       true,
	"signed-db-query.json":             true,
	"signed-job-run.json":              true,
	"signed-cert-sync.json":            true,
}

// TestPhase23SignedFixtures verifies every new signed frame against the TS
// signature, checks its credential TTL, and re-encodes it byte-for-byte as
// JSON values.
func TestPhase23SignedFixtures(t *testing.T) {
	for file, want := range phase23SignedFixtures {
		t.Run(file, func(t *testing.T) {
			msg, payload := verifyFixture(t, file)
			if reflect.TypeOf(msg) != reflect.TypeOf(want) {
				t.Fatalf("got %T, want %T", msg, want)
			}
			if got := CarriesCredentials(msg); got != credentialFixtures[file] {
				t.Errorf("CarriesCredentials = %v, want %v", got, credentialFixtures[file])
			}
			assertRoundTrip(t, msg, payload)
		})
	}
}

func signedPayload[T ControlMessage](t *testing.T, file string) T {
	t.Helper()
	msg, _ := verifyFixture(t, file)
	m, ok := msg.(T)
	if !ok {
		t.Fatalf("%s: got %T", file, msg)
	}
	return m
}

// TestPhase23BoxesOpen opens every sealed box of the new fixtures with the
// fixture node key, under the documented AAD, and checks the plaintext.
func TestPhase23BoxesOpen(t *testing.T) {
	f, node, _ := loadBoxFixture(t)
	id := f.NodeID

	ds := signedPayload[*DesiredState](t, "signed-desired-state-phase2.json")
	psks, err := OpenMeshPSKs(node, id, ds.Generation, ds.Mesh)
	if err != nil || len(psks) != len(ds.Mesh.Peers) {
		t.Fatalf("psks %v, %v", psks, err)
	}
	for _, p := range ds.Mesh.Peers {
		if len(psks[p.NodeID]) != 32 {
			t.Errorf("no psk for %s", p.NodeID)
		}
	}
	if pw, err := OpenRegistryUpstream(node, id, ds.Generation, ds.Registry.Upstream); err != nil || pw != "fixture-pull-password" {
		t.Errorf("upstream password %q, %v", pw, err)
	}
	if err := OpenWorkloadEnv(node, id, ds.Generation, &ds.Workloads[0]); err != nil ||
		ds.Workloads[0].Env["POSTGRES_PASSWORD"] != "fixture-postgres-password" {
		t.Errorf("db env %v, %v", ds.Workloads[0].Env, err)
	}

	job := signedPayload[*BackupJob](t, "signed-backup-job.json")
	parts, err := OpenBackupParts(node, id, job.BackupID, &job.PartsSealed)
	if err != nil || len(parts) != 2 || parts[0].PartNumber != 1 {
		t.Errorf("backup parts %v, %v", parts, err)
	}
	more := signedPayload[*BackupParts](t, "signed-backup-parts.json")
	if parts, err := OpenBackupParts(node, id, more.BackupID, &more.PartsSealed); err != nil || parts[0].PartNumber != 3 {
		t.Errorf("more parts %v, %v", parts, err)
	}
	out := signedPayload[*VolumeCopyOut](t, "signed-volume-copy-out.json")
	if _, err := OpenBackupParts(node, id, out.BackupID, &out.PartsSealed); err != nil {
		t.Error(err)
	}

	restore := signedPayload[*RestoreJob](t, "signed-restore-job.json")
	secrets, err := OpenRestoreSecrets(node, id, restore.RestoreID, &restore.SecretsSealed)
	if err != nil || !strings.HasPrefix(secrets.AgeIdentity, "AGE-SECRET-KEY-1") {
		t.Errorf("restore secrets %+v, %v", secrets, err)
	}
	in := signedPayload[*VolumeCopyIn](t, "signed-volume-copy-in.json")
	if _, err := OpenRestoreSecrets(node, id, in.MigrationID, &in.SecretsSealed); err != nil {
		t.Error(err)
	}
	if _, err := OpenRestoreSecrets(node, id, restore.RestoreID, &in.SecretsSealed); err == nil {
		t.Error("a copy-in box opened under a restore's AAD")
	}

	q := signedPayload[*DBQuery](t, "signed-db-query.json")
	if cred, err := OpenDBCredential(node, id, q); err != nil || cred.Username != "roundhouse_ro" {
		t.Errorf("credential %+v, %v", cred, err)
	}

	run := signedPayload[*JobRun](t, "signed-job-run.json")
	if err := OpenJobEnv(node, id, run.RunID, &run.Workload); err != nil || run.Workload.Env["GREETING"] != "hello from cron" {
		t.Errorf("job env %v, %v", run.Workload.Env, err)
	}
	if err := OpenWorkloadEnv(node, id, 0, &run.Workload); err == nil {
		t.Error("a job env opened as a workload env")
	}

	sync := signedPayload[*CertSync](t, "signed-cert-sync.json")
	for i := range sync.Upserts {
		if key, err := OpenCertKey(node, id, &sync.Upserts[i]); err != nil || !strings.HasPrefix(key, "-----BEGIN ") {
			t.Errorf("cert key %q, %v", key, err)
		}
	}
}

// TestPhase23SpecHashes checks every signed Phase 2–3 workload hashes to
// its spec_hash in Go too.
func TestPhase23SpecHashes(t *testing.T) {
	ds := signedPayload[*DesiredState](t, "signed-desired-state-phase2.json")
	run := signedPayload[*JobRun](t, "signed-job-run.json")
	for _, w := range append(ds.Workloads, run.Workload) {
		got, err := ComputeSpecHash(w)
		if err != nil || got != w.SpecHash {
			t.Errorf("%s: spec_hash %s, computed %s (%v)", w.ID, w.SpecHash, got, err)
		}
	}
}

// TestFormatsFixture is the Go half of the format-helper agreement check.
func TestFormatsFixture(t *testing.T) {
	var f struct {
		Cases []struct {
			Fn    string `json:"fn"`
			Input string `json:"input"`
			Want  bool   `json:"want"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(readFixture(t, "formats.json"), &f); err != nil {
		t.Fatal(err)
	}
	fns := map[string]func(string) bool{
		"isIPv4":          IsIPv4,
		"isIPv6":          IsIPv6,
		"isCidr":          IsCIDR,
		"isIPv4Cidr":      IsIPv4CIDR,
		"isHostPort":      IsHostPort,
		"isSafeMountPath": IsSafeMountPath,
		"isRouteHostname": IsRouteHostname,
		"ipv4InCidr": func(s string) bool {
			ip, cidr, _ := strings.Cut(s, "|")
			return IPv4InCIDR(ip, cidr)
		},
	}
	if len(f.Cases) < 50 {
		t.Fatalf("only %d cases", len(f.Cases))
	}
	for _, c := range f.Cases {
		fn, ok := fns[c.Fn]
		if !ok {
			t.Fatalf("unknown helper %s", c.Fn)
		}
		if got := fn(c.Input); got != c.Want {
			t.Errorf("%s(%q) = %v, want %v", c.Fn, c.Input, got, c.Want)
		}
	}
}

func phase2State(t *testing.T) *DesiredState {
	t.Helper()
	return signedPayload[*DesiredState](t, "signed-desired-state-phase2.json")
}

func TestPhase23WorkloadRules(t *testing.T) {
	cases := map[string]func(ds *DesiredState){
		"mount of an unlisted volume":       func(ds *DesiredState) { ds.Volumes = nil },
		"volume of another service":         func(ds *DesiredState) { ds.Volumes[0].ServiceID = "svc_other" },
		"route workload without the mesh":   func(ds *DesiredState) { ds.Mesh = nil },
		"reserved mount path":               func(ds *DesiredState) { ds.Workloads[0].Mounts[0].Path = "/run/secrets/x" },
		"exec probe with a port":            func(ds *DesiredState) { ds.Workloads[0].Healthcheck.Port = 5432 },
		"exec probe without a command":      func(ds *DesiredState) { ds.Workloads[0].Healthcheck.Command = nil },
		"publish without allowed cidrs":     func(ds *DesiredState) { ds.Workloads[0].PublishAllowedCIDRs = nil },
		"publish on a privileged port":      func(ds *DesiredState) { ds.Workloads[0].Ports[0].Publish.HostPort = 80 },
		"invalid cidr":                      func(ds *DesiredState) { ds.Workloads[0].PublishAllowedCIDRs = []string{"x"} },
		"route without upstreams":           func(ds *DesiredState) { ds.Workloads[1].Upstreams = nil },
		"route with an environment":         func(ds *DesiredState) { ds.Workloads[1].EnvSealed = ds.Workloads[0].EnvSealed },
		"upstreams on a service":            func(ds *DesiredState) { ds.Workloads[0].Upstreams = ds.Workloads[1].Upstreams },
		"mesh address outside the supernet": func(ds *DesiredState) { ds.Mesh.Address = "10.201.1.1" },
		"peers without sealed psks":         func(ds *DesiredState) { ds.Mesh.PSKsSealed = nil },
		"duplicate peer":                    func(ds *DesiredState) { ds.Mesh.Peers = append(ds.Mesh.Peers, ds.Mesh.Peers[0]) },
		"forward pair of three":             func(ds *DesiredState) { ds.Mesh.ForwardPairs[0] = append(ds.Mesh.ForwardPairs[0], "10.0.0.0/8") },
		"proxy without upstream":            func(ds *DesiredState) { ds.Registry.Upstream = nil },
		"primary with upstream":             func(ds *DesiredState) { ds.Registry.Mode = RegistryPrimary },
		"managed tls without ingress":       func(ds *DesiredState) { ds.TLSMode = TLSManaged },
		"wildcard with two stars": func(ds *DesiredState) {
			ds.Workloads[1].Routes[0].Hostname = "*.*.example.com"
		},
		"preload without subdomains": func(ds *DesiredState) {
			ds.Workloads[1].Routes[0].HSTS = &RouteHSTS{MaxAge: 31_536_000, Preload: true}
		},
		"long-lived with sealed psks": func(ds *DesiredState) { ds.ExpiresAt = ds.IssuedAt + CredentialFrameTTLMS + 1 },
	}
	if err := phase2State(t).Validate(); err != nil {
		t.Fatalf("fixture invalid: %v", err)
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			ds := phase2State(t)
			mutate(ds)
			if err := ds.Validate(); err == nil {
				t.Error("accepted")
			}
		})
	}
	t.Run("wildcard with hsts", func(t *testing.T) {
		ds := phase2State(t)
		ds.Workloads[1].Routes[0].Hostname = "*.apps.example.com"
		ds.Workloads[1].Routes[0].HSTS = &RouteHSTS{MaxAge: 31_536_000, IncludeSubdomains: true, Preload: true}
		if err := ds.Validate(); err != nil {
			t.Error(err)
		}
	})
}

func TestPhase23JobRules(t *testing.T) {
	cases := map[string]func(r *JobRun){
		"restart policy":     func(r *JobRun) { r.Workload.Restart = Restart{Policy: RestartOnFailure, MaxRetries: 1} },
		"ports":              func(r *JobRun) { r.Workload.Ports = []WorkloadPort{{ContainerPort: 80, Protocol: PortHTTP}} },
		"no environment":     func(r *JobRun) { r.Workload.EnvSealed = nil },
		"service workload":   func(r *JobRun) { r.Workload.Kind = WorkloadService },
		"timeout too short":  func(r *JobRun) { r.TimeoutS = 5 },
		"kill grace too big": func(r *JobRun) { r.KillGraceS = 121 },
		"long-lived":         func(r *JobRun) { r.ExpiresAt = r.IssuedAt + CredentialFrameTTLMS + 1 },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			r := signedPayload[*JobRun](t, "signed-job-run.json")
			mutate(r)
			if err := r.Validate(); err == nil {
				t.Error("accepted")
			}
		})
	}
}

func TestPhase23FrameRules(t *testing.T) {
	type check struct {
		file   string
		mutate func(m ControlMessage)
	}
	cases := map[string]check{
		"dump without engine":    {"signed-backup-job.json", func(m ControlMessage) { m.(*BackupJob).Engine = "" }},
		"snapshot with dbs":      {"signed-backup-job.json", func(m ControlMessage) { m.(*BackupJob).Method = BackupSnapshot }},
		"quiesced dump":          {"signed-backup-job.json", func(m ControlMessage) { m.(*BackupJob).Quiesce = "stop" }},
		"unaligned part":         {"signed-backup-job.json", func(m ControlMessage) { m.(*BackupJob).PartSizeBytes++ }},
		"bad recipient":          {"signed-backup-job.json", func(m ControlMessage) { m.(*BackupJob).AgeRecipient = "age1short" }},
		"long-lived backup":      {"signed-backup-job.json", func(m ControlMessage) { m.(*BackupJob).ExpiresAt += CredentialFrameTTLMS }},
		"long-lived restore":     {"signed-restore-job.json", func(m ControlMessage) { m.(*RestoreJob).ExpiresAt += CredentialFrameTTLMS }},
		"bad restore sha":        {"signed-restore-job.json", func(m ControlMessage) { m.(*RestoreJob).SHA256 = "x" }},
		"raw with both":          {"signed-db-query.json", func(m ControlMessage) { m.(*DBQuery).Op.Argv = []string{"GET"} }},
		"provision as reader":    {"signed-db-query.json", func(m ControlMessage) { m.(*DBQuery).Op = DBOp{Type: DBOpProvisionReadonly} }},
		"too many rows":          {"signed-db-query.json", func(m ControlMessage) { m.(*DBQuery).MaxRows = MaxDBQueryRows + 1 }},
		"long-lived query":       {"signed-db-query.json", func(m ControlMessage) { m.(*DBQuery).ExpiresAt += CredentialFrameTTLMS }},
		"cert upsert removed":    {"signed-cert-sync.json", func(m ControlMessage) { c := m.(*CertSync); c.Removes = append(c.Removes, c.Upserts[0].ID) }},
		"cert without pem":       {"signed-cert-sync.json", func(m ControlMessage) { m.(*CertSync).Upserts[0].CertPEM = "x" }},
		"long-lived cert sync":   {"signed-cert-sync.json", func(m ControlMessage) { m.(*CertSync).ExpiresAt += CredentialFrameTTLMS }},
		"no announced keys":      {"signed-key-announce.json", func(m ControlMessage) { m.(*KeyAnnounce).Keys = nil }},
		"short announced key":    {"signed-key-announce.json", func(m ControlMessage) { m.(*KeyAnnounce).Keys[0].PublicKey = "AAAA" }},
		"zero not_before":        {"signed-key-announce.json", func(m ControlMessage) { m.(*KeyAnnounce).Keys[0].NotBefore = 0 }},
		"bad announced kid":      {"signed-key-announce.json", func(m ControlMessage) { m.(*KeyAnnounce).Keys[0].KID = "bad kid" }},
		"duplicate next key":     {"signed-welcome-next-keys.json", func(m ControlMessage) { w := m.(*Welcome); w.NextKeys[1].KID = w.NextKeys[0].KID }},
		"three next keys":        {"signed-welcome-next-keys.json", func(m ControlMessage) { w := m.(*Welcome); w.NextKeys = append(w.NextKeys, w.NextKeys[0]) }},
		"metrics interval range": {"signed-welcome-next-keys.json", func(m ControlMessage) { v := int64(10); m.(*Welcome).MetricsIntervalMS = &v }},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			msg, _ := verifyFixture(t, c.file)
			c.mutate(msg)
			if err := msg.(Validator).Validate(); err == nil {
				t.Error("accepted")
			}
		})
	}
	t.Run("empty cert sync is not a credential", func(t *testing.T) {
		c := signedPayload[*CertSync](t, "signed-cert-sync.json")
		c.Upserts, c.ExpiresAt = []CertUpsert{}, c.IssuedAt+CredentialFrameTTLMS*10
		if CarriesCredentials(c) || c.Validate() != nil {
			t.Error("an empty cert_sync should be long-lived and valid")
		}
	})
}

func TestPhase23AgentRules(t *testing.T) {
	cases := map[string]string{
		"job without finished_at":   `{"type":"job_status","run_id":"crn_1","workload_id":"wl_1","state":"failed"}`,
		"succeeded with exit 1":     `{"type":"job_status","run_id":"crn_1","workload_id":"wl_1","state":"succeeded","exit_code":1,"finished_at":1}`,
		"backup ok without sha":     `{"type":"backup_result","backup_id":"bak_1","ok":true,"part_count":1,"bytes_raw":1,"bytes_stored":1,"duration_ms":1}`,
		"backup failed with stats":  `{"type":"backup_result","backup_id":"bak_1","ok":false,"part_count":1,"error":"x","duration_ms":1}`,
		"restore failed silently":   `{"type":"restore_result","restore_id":"rst_1","ok":false,"duration_ms":1}`,
		"query ok without rows":     `{"type":"db_query_result","request_id":"q_1","ok":true,"columns":[],"row_count":0,"duration_ms":1}`,
		"query null row":            `{"type":"db_query_result","request_id":"q_1","ok":true,"columns":[],"rows":[null],"row_count":0,"duration_ms":1}`,
		"cert failed without error": `{"type":"cert_status","hostname":"a.example.com","state":"failed"}`,
		"duplicate metric":          `{"type":"metrics","ts":1,"interval_ms":15000,"source":"cgroup_v2","samples":[` + sample + `,` + sample + `]}`,
		"empty cert ack":            `{"type":"cert_ack","ids":[]}`,
		"mesh key epoch zero":       `{"type":"mesh_key","public_key":"` + strings.Repeat("A", 43) + `=","epoch":0}`,
		"job logs without run":      `{"type":"logs","source":{"type":"job","workload_id":"wl_1"},"lines":[{"ts":1,"stream":"stdout","text":"x"}]}`,
		"unknown field":             `{"type":"cert_ack","ids":["cer_1"],"extra":1}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := DecodeAgentMessage([]byte(raw)); err == nil {
				t.Error("accepted")
			}
		})
	}
	ok := `{"type":"db_query_result","request_id":"q_1","ok":true,"columns":[],"rows":[],"row_count":0,"duration_ms":1}`
	m, err := DecodeAgentMessage([]byte(ok))
	if err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(m)
	if !bytes.Contains(out, []byte(`"columns":[]`)) || !bytes.Contains(out, []byte(`"rows":[]`)) {
		t.Errorf("empty results must stay present: %s", out)
	}
}

const sample = `{"workload_id":"wl_1","cpu_millis":1,"mem_bytes":1,"mem_limit_bytes":1,"net_rx_bytes":0,"net_tx_bytes":0,"disk_read_bytes":0,"disk_write_bytes":0,"pids":1,"restarts":0}`

// TestVerifyRejectsSelfAnnouncedKID checks ADR 0014 §13: a frame may never
// announce the key that signed it.
func TestVerifyRejectsSelfAnnouncedKID(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1500)
	header := ControlHeader{ID: "m1", NodeID: "node_a", IssuedAt: 1000, ExpiresAt: 2000}
	next := []SigningKeyAnnouncement{{KID: "k1", PublicKey: strings.Repeat("A", 43) + "=", NotBefore: 1}}
	for _, msg := range []ControlMessage{
		&KeyAnnounce{Type: TypeKeyAnnounce, ControlHeader: header, Keys: next},
		&Welcome{Type: TypeWelcome, ControlHeader: header, HeartbeatIntervalMS: 1000, NextKeys: next},
	} {
		if !AnnouncesSigningKID("k1", msg) || AnnouncesSigningKID("k0", msg) {
			t.Fatalf("AnnouncesSigningKID wrong for %T", msg)
		}
		self, err := SignEnvelope(msg, priv, "k1")
		if err != nil {
			t.Fatal(err)
		}
		assertRejected(t, self, pub, "node_a", now, ErrMalformed)
		other, _ := SignEnvelope(msg, priv, "k0")
		if _, err := VerifyEnvelope(other, pub, "node_a", now); err != nil {
			t.Errorf("%T signed by k0: %v", msg, err)
		}
	}
}

// TestSetPasswordOp checks the credential-rotation op: admin mode only, a
// user name, and a new password that travels in the sealed box exactly
// when the op is set_password.
func TestSetPasswordOp(t *testing.T) {
	f, node, _ := loadBoxFixture(t)
	q := signedPayload[*DBQuery](t, "signed-db-query.json")
	q.Mode, q.Op = "write", DBOp{Type: DBOpSetPassword, User: "roundhouse_ro"}
	if err := q.Validate(); err != nil {
		t.Fatalf("valid set_password refused: %v", err)
	}
	for name, op := range map[string]DBOp{
		"no user":  {Type: DBOpSetPassword},
		"bad user": {Type: DBOpSetPassword, User: "ro'; DROP ROLE x; --"},
	} {
		bad := *q
		bad.Op = op
		if bad.Validate() == nil {
			t.Errorf("%s accepted", name)
		}
	}
	reader := *q
	reader.Mode = "read"
	if reader.Validate() == nil {
		t.Error("set_password as the reader accepted")
	}

	seal := func(body string) SealedBox {
		t.Helper()
		box, err := SealBox(node.PublicKey(), []byte(body), BoxPurposeDBCredential, DBCredentialAAD(f.NodeID, q.RequestID))
		if err != nil {
			t.Fatal(err)
		}
		return *box
	}
	const pw = "Qm9yZGVyLXJlYWR5LXBhc3N3b3JkLWJhc2U2NHVybA"
	q.CredentialSealed = seal(`{"username":"postgres","password":"old","new_password":"` + pw + `"}`)
	if cred, err := OpenDBCredential(node, f.NodeID, q); err != nil || cred.NewPassword != pw {
		t.Errorf("credential %+v, %v", cred, err)
	}
	q.CredentialSealed = seal(`{"username":"postgres","password":"old"}`)
	if _, err := OpenDBCredential(node, f.NodeID, q); err == nil {
		t.Error("set_password without a new password opened")
	}
	q.CredentialSealed = seal(`{"username":"postgres","password":"old","new_password":"it's'; --"}`)
	if _, err := OpenDBCredential(node, f.NodeID, q); err == nil {
		t.Error("a new password needing quoting opened")
	}
	read := signedPayload[*DBQuery](t, "signed-db-query.json")
	read.CredentialSealed = seal(`{"username":"roundhouse_ro","password":"p","new_password":"` + pw + `"}`)
	if _, err := OpenDBCredential(node, f.NodeID, read); err == nil {
		t.Error("a new password opened for a read query")
	}
}
