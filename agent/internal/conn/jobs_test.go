package conn

import (
	"crypto/ed25519"
	"crypto/rand"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/leaktest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// fakeJobs records the job frames it is handed.
type fakeJobs struct {
	mu  sync.Mutex
	got []string
}

func (f *fakeJobs) RunJob(m *protocol.JobRun) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, "run "+m.RunID)
}

func (f *fakeJobs) CancelJob(m *protocol.JobCancel) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, "cancel "+m.RunID+" "+m.Reason)
}

func (f *fakeJobs) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.got)
}

func jobRun(id string, ttl time.Duration) *protocol.JobRun {
	w := serviceOn(protocol.EnvironmentNetworkName("prj_1", "env_1"))
	w.Kind = protocol.WorkloadJob
	w.Restart = protocol.Restart{Policy: protocol.RestartNever}
	w.DrainS = 0
	return &protocol.JobRun{
		Type:          protocol.TypeJobRun,
		ControlHeader: header("m_"+id, time.Now().Add(ttl)),
		RunID:         id,
		Workload:      w,
		TimeoutS:      60,
		KillGraceS:    10,
	}
}

func TestJobFramesAreDispatched(t *testing.T) {
	leaktest.Check(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	cp := newFakeControlPlane(t)
	logs := &syncBuffer{}
	c := newTestClient(t, cp.url(), pub, nil, logs)
	jobs := &fakeJobs{}
	c.Jobs = jobs
	stop := startClient(t, c)
	cp.next(t)

	future := time.Now().Add(time.Minute)
	// SECURITY: job_run is credential-bearing, so one that lives longer than
	// the credential TTL never reaches the handler.
	cp.push(t, priv, jobRun("crn_long", 2*time.Minute))
	cp.push(t, priv, jobRun("crn_1", 30*time.Second))
	cp.push(t, priv, &protocol.JobCancel{Type: protocol.TypeJobCancel, ControlHeader: header("m_c", future),
		RunID: "crn_1", Reason: "replaced"})
	waitFor(t, "the job frames", func() bool { return len(jobs.seen()) == 2 })
	if got := jobs.seen(); !slices.Equal(got, []string{"run crn_1", "cancel crn_1 replaced"}) {
		t.Fatalf("dispatched %v", got)
	}
	if v := c.PeerProtocolVersion(); v != protocol.JobsProtocolVersion {
		t.Fatalf("peer version %d after job frames", v)
	}
	if !strings.Contains(logs.String(), "dropping control frame") {
		t.Fatal("the long-lived job_run was not logged as dropped")
	}
	if err := stop(); err != nil {
		t.Fatal(err)
	}
}

func TestJobFramesWithoutAHandlerAreDropped(t *testing.T) {
	leaktest.Check(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	cp := newFakeControlPlane(t)
	logs := &syncBuffer{}
	c := newTestClient(t, cp.url(), pub, nil, logs)
	stop := startClient(t, c)
	cp.next(t)

	cp.push(t, priv, jobRun("crn_1", 30*time.Second))
	cp.push(t, priv, &protocol.JobCancel{Type: protocol.TypeJobCancel, ControlHeader: header("m_c", time.Now().Add(time.Minute)),
		RunID: "crn_1", Reason: "x"})
	waitFor(t, "both drops", func() bool { return strings.Count(logs.String(), "no_handler") == 2 })
	if v := c.PeerProtocolVersion(); v != protocol.JobsProtocolVersion {
		t.Fatalf("peer version %d", v)
	}
	if err := stop(); err != nil {
		t.Fatal(err)
	}
}
