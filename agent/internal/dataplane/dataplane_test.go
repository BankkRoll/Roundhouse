package dataplane

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/leaktest"
	"github.com/BankkRoll/Roundhouse/agent/internal/runtime"
	"github.com/BankkRoll/Roundhouse/agent/internal/sealtest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// fixtureQuery verifies the protocol's signed db_query fixture, whose
// credential is sealed to the fixture node key ([sealtest.Key]).
func fixtureQuery(t *testing.T) (*protocol.DBQuery, string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "protocol", "fixtures", "signed-db-query.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		PublicKey string            `json:"public_key"`
		NodeID    string            `json:"node_id"`
		Envelope  protocol.Envelope `json:"envelope"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	pub, err := protocol.ParsePublicKey(f.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	var probe struct {
		IssuedAt int64 `json:"iat"`
	}
	_ = json.Unmarshal([]byte(f.Envelope.Payload), &probe)
	msg, err := protocol.VerifyEnvelope(f.Envelope, pub, f.NodeID, time.UnixMilli(probe.IssuedAt+1000))
	if err != nil {
		t.Fatal(err)
	}
	return msg.(*protocol.DBQuery), f.NodeID
}

type fakeWorkloads map[string]runtime.WorkloadInfo

func (f fakeWorkloads) Workload(id string) (runtime.WorkloadInfo, bool) {
	w, ok := f[id]
	return w, ok
}

type fakeInspector map[string][]string

func (f fakeInspector) InspectContainer(_ context.Context, id string) (docker.ContainerInfo, error) {
	env, ok := f[id]
	if !ok {
		return docker.ContainerInfo{}, errors.New("no such container")
	}
	return docker.ContainerInfo{ID: id, Config: docker.ContainerConfig{Env: env}}, nil
}

// fakeRunner records calls and, when gate is set, blocks until it closes.
type fakeRunner struct {
	mu    sync.Mutex
	calls []call
	gate  chan struct{}
	rows  int
}

type call struct {
	target QueryTarget
	cred   QueryCredential
}

func (f *fakeRunner) Run(ctx context.Context, t QueryTarget, c QueryCredential, q *protocol.DBQuery) *protocol.DBQueryResult {
	f.mu.Lock()
	f.calls = append(f.calls, call{t, c})
	gate := f.gate
	rows := f.rows
	f.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return &protocol.DBQueryResult{RequestID: q.RequestID, Error: "timed out"}
		}
	}
	cols := []protocol.DBColumn{{Name: "x", Type: "text"}}
	data := make([][]any, rows)
	for i := range data {
		data[i] = []any{strings.Repeat("x", 1024)}
	}
	n := int64(rows)
	return &protocol.DBQueryResult{RequestID: q.RequestID, OK: true, Columns: &cols, Rows: &data, RowCount: &n}
}

type results struct {
	mu  sync.Mutex
	out []protocol.AgentMessage
}

func (r *results) send(_ context.Context, m protocol.AgentMessage) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.out = append(r.out, m)
	return nil
}

func (r *results) query(t *testing.T, id string) *protocol.DBQueryResult {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		for _, m := range r.out {
			if q, ok := m.(*protocol.DBQueryResult); ok && q.RequestID == id {
				r.mu.Unlock()
				if err := q.Validate(); err != nil {
					t.Fatalf("invalid result: %v", err)
				}
				return q
			}
		}
		r.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no result for %s", id)
	return nil
}

func newHandler(t *testing.T, nodeID string, q DBQueryRunner) (*Handler, *results, *protocol.DBQuery) {
	t.Helper()
	leaktest.Check(t)
	m, _ := fixtureQuery(t)
	out := &results{}
	h := New(Options{
		NodeID: nodeID, Key: sealtest.Key(), Query: q, Send: out.send,
		Workloads: fakeWorkloads{m.WorkloadID: {
			ContainerID: "ctr_db", Running: true, IP: "172.18.0.5",
			Spec: protocol.WorkloadSpec{Ports: []protocol.WorkloadPort{{ContainerPort: 5432, Protocol: protocol.PortTCP}}},
		}},
		Docker: fakeInspector{"ctr_db": {"POSTGRES_DB=app", "ROUNDHOUSE_RO_PASSWORD=ro-secret"}},
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.Run(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
	return h, out, m
}

func TestQueryOpensTheSealedCredentialAndTargetsTheContainer(t *testing.T) {
	_, nodeID := fixtureQuery(t)
	r := &fakeRunner{rows: 2}
	h, out, m := newHandler(t, nodeID, r)
	h.RunQuery(m)
	res := out.query(t, m.RequestID)
	if !res.OK || *res.RowCount != 2 || res.DurationMS < 0 {
		t.Fatalf("result %+v", res)
	}
	c := r.calls[0]
	if c.target != (QueryTarget{Engine: "postgres", Host: "172.18.0.5", Port: 5432, Database: "app"}) {
		t.Fatalf("target %+v", c.target)
	}
	if c.cred.Username != "roundhouse_ro" || c.cred.Password == "" || c.cred.ReadonlyPassword != "" {
		t.Fatalf("credential %+v", c.cred)
	}
}

func TestQueryFailuresAreAnsweredWithoutSecrets(t *testing.T) {
	m, _ := fixtureQuery(t)
	// Bound to another node: the box must not open.
	h, out, _ := newHandler(t, "node_other", &fakeRunner{})
	h.RunQuery(m)
	if res := out.query(t, m.RequestID); res.OK || !strings.Contains(res.Error, "credential") {
		t.Fatalf("result %+v", res)
	}

	_, nodeID := fixtureQuery(t)
	h2, out2, m2 := newHandler(t, nodeID, nil)
	h2.RunQuery(m2)
	if res := out2.query(t, m2.RequestID); res.OK || !strings.Contains(res.Error, "not available") {
		t.Fatalf("result %+v", res)
	}

	// A result over the frame budget is replaced by an error.
	h3, out3, m3 := newHandler(t, nodeID, &fakeRunner{rows: 1000})
	h3.RunQuery(m3)
	if res := out3.query(t, m3.RequestID); res.OK || !strings.Contains(res.Error, "could not be sent") {
		t.Fatalf("result %+v", res)
	}
}

func TestAtMostFourQueriesRunAtOnce(t *testing.T) {
	_, nodeID := fixtureQuery(t)
	r := &fakeRunner{gate: make(chan struct{})}
	h, out, m := newHandler(t, nodeID, r)
	// The credential is bound to the request ID, so every query reuses it.
	for range MaxConcurrentQueries {
		h.RunQuery(m)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		r.mu.Lock()
		n := len(r.calls)
		r.mu.Unlock()
		if n == MaxConcurrentQueries || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	// The four hold every slot until the gate opens; the fifth times out
	// waiting for one.
	fifth := *m
	fifth.TimeoutMS = 100
	h.RunQuery(&fifth)
	res := out.query(t, m.RequestID)
	r.mu.Lock()
	n := len(r.calls)
	r.mu.Unlock()
	close(r.gate)
	if n != MaxConcurrentQueries || res.OK || !strings.Contains(res.Error, "too many queries") {
		t.Fatalf("%d ran at once; fifth: %+v", n, res)
	}
}

func TestProvisionReadonlyGetsTheContainersPassword(t *testing.T) {
	_, nodeID := fixtureQuery(t)
	r := &fakeRunner{}
	h, out, m := newHandler(t, nodeID, r)
	q := *m
	q.Op = protocol.DBOp{Type: protocol.DBOpProvisionReadonly}
	h.RunQuery(&q)
	out.query(t, q.RequestID)
	if r.calls[0].cred.ReadonlyPassword != "ro-secret" {
		t.Fatalf("credential %+v", r.calls[0].cred)
	}
}

func TestBackupFramesWithoutARunnerFail(t *testing.T) {
	leaktest.Check(t)
	out := &results{}
	h := New(Options{Send: out.send})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.Run(ctx) }()
	h.StartBackup(&protocol.BackupJob{BackupID: "bak_1"})
	h.StartRestore(&protocol.RestoreJob{RestoreID: "rst_1"})
	h.StartCopyIn(&protocol.VolumeCopyIn{MigrationID: "mig_1"})
	h.DeleteVolume(&protocol.VolumeDelete{VolumeID: "vol_1"})
	deadline := time.Now().Add(5 * time.Second)
	for {
		out.mu.Lock()
		n := len(out.out)
		out.mu.Unlock()
		if n == 3 || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	for _, m := range out.out {
		if v, ok := m.(protocol.Validator); !ok || v.Validate() != nil {
			t.Fatalf("invalid result %+v", m)
		}
	}
	if len(out.out) != 3 {
		t.Fatalf("%d results", len(out.out))
	}
}

func TestEnginePort(t *testing.T) {
	tcp := func(ps ...int) []protocol.WorkloadPort {
		var out []protocol.WorkloadPort
		for _, p := range ps {
			out = append(out, protocol.WorkloadPort{ContainerPort: p, Protocol: protocol.PortTCP})
		}
		return out
	}
	for _, tc := range []struct {
		engine protocol.DatabaseEngine
		ports  []protocol.WorkloadPort
		want   int
	}{
		{protocol.EnginePostgres, nil, 5432},
		{protocol.EngineMySQL, tcp(3306, 33060), 3306},
		{protocol.EngineRedis, tcp(6380), 6380},
		{protocol.EngineMongoDB, tcp(1, 2), 27017},
	} {
		if got := EnginePort(tc.engine, tc.ports); got != tc.want {
			t.Errorf("%s %v: %d, want %d", tc.engine, tc.ports, got, tc.want)
		}
	}
}
