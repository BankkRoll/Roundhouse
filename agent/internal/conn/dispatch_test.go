package conn

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/leaktest"
	"github.com/BankkRoll/Roundhouse/agent/internal/state"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// fakeHandler records dispatched messages and accepts desired states the
// way the runtime does: only newer generations.
type fakeHandler struct {
	mu      sync.Mutex
	applied []int64
	builds  []string
}

func (h *fakeHandler) HasDesiredState() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.applied) > 0
}

func (h *fakeHandler) ApplyDesiredState(m *protocol.DesiredState) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if n := len(h.applied); n > 0 && m.Generation <= h.applied[n-1] {
		return false
	}
	h.applied = append(h.applied, m.Generation)
	return true
}

func (h *fakeHandler) StartBuild(m *protocol.BuildJob) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.builds = append(h.builds, m.BuildID)
}

func (h *fakeHandler) snapshot() ([]int64, []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]int64(nil), h.applied...), append([]string(nil), h.builds...)
}

func buildJob(id string, exp time.Time) *protocol.BuildJob {
	return &protocol.BuildJob{
		Type:            protocol.TypeBuildJob,
		ControlHeader:   header("m_"+id, exp),
		BuildID:         id,
		DeploymentID:    "dep_1",
		ProjectID:       "prj_1",
		ServiceID:       "svc_1",
		Source:          protocol.GitBuildSource{Type: "git", URL: "https://github.com/acme/app", CommitSHA: strings.Repeat("a", 40)},
		Builder:         protocol.BuilderRailpack,
		ContextDir:      ".",
		BuildArgs:       map[string]string{},
		ImageRepository: protocol.LocalImageRepository("prj_1", "svc_1"),
		CacheKey:        protocol.BuildCacheKey("prj_1", "svc_1"),
		TimeoutS:        600,
	}
}

func TestDispatchesDesiredStateInOrderAndBuildJobs(t *testing.T) {
	leaktest.Check(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	cp := newFakeControlPlane(t)
	store := state.NewStore(filepath.Join(t.TempDir(), "state.json"))
	// A restarted agent: generation 3 was applied before, but nothing is in
	// memory, so generation 3 must be applied again.
	if err := store.Save(state.State{ObservedGeneration: 3}); err != nil {
		t.Fatal(err)
	}
	h := &fakeHandler{}
	c := newTestClient(t, cp.url(), pub, store, &syncBuffer{})
	c.Handler = h
	stop := startClient(t, c)
	cp.next(t)

	future := time.Now().Add(time.Minute)
	cp.push(t, priv, desired("m_2", 2, future))
	cp.push(t, priv, desired("m_3", 3, future))
	cp.push(t, priv, desired("m_3_again", 3, future))
	cp.push(t, priv, buildJob("bld_1", future))
	cp.push(t, priv, desired("m_4", 4, future))
	waitFor(t, "generation 4", func() bool { a, _ := h.snapshot(); return len(a) == 2 })
	waitFor(t, "the build job", func() bool { _, b := h.snapshot(); return len(b) == 1 })
	applied, builds := h.snapshot()
	if len(applied) != 2 || applied[0] != 3 || applied[1] != 4 || builds[0] != "bld_1" {
		t.Fatalf("applied %v builds %v", applied, builds)
	}
	waitFor(t, "persisted generation 4", func() bool {
		st, _ := store.Load()
		return st.ObservedGeneration == 4
	})
	if err := stop(); err != nil {
		t.Fatal(err)
	}
}

func TestSendGoesThroughTheWriter(t *testing.T) {
	leaktest.Check(t)
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	cp := newFakeControlPlane(t)
	c := newTestClient(t, cp.url(), pub, nil, &syncBuffer{})
	var connects atomic.Int32
	c.OnConnect = func() { connects.Add(1) }

	ctx := context.Background()
	status := &protocol.WorkloadStatus{Type: protocol.TypeWorkloadStatus, WorkloadStatusReport: protocol.WorkloadStatusReport{
		WorkloadID: "wl_1", DeploymentID: ptr("dep_1"), State: protocol.StateHealthy, TS: 1,
	}}
	if err := c.Send(ctx, status); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("send before connecting: %v", err)
	}

	stop := startClient(t, c)
	if _, ok := cp.next(t).(*protocol.Hello); !ok {
		t.Fatal("hello was not first")
	}
	waitFor(t, "OnConnect", func() bool { return connects.Load() == 1 })

	// Many concurrent senders share the one writer.
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := c.Send(ctx, status); err != nil {
				t.Errorf("send: %v", err)
			}
		}()
	}
	wg.Wait()
	got := 0
	deadline := time.After(5 * time.Second)
	for got < 20 {
		select {
		case m := <-cp.received:
			if s, ok := m.(*protocol.WorkloadStatus); ok && s.WorkloadID == "wl_1" {
				got++
			}
		case <-deadline:
			t.Fatalf("received %d of 20 statuses", got)
		}
	}

	huge := &protocol.Logs{Type: protocol.TypeLogs, Source: protocol.LogSource{Type: protocol.LogSourceBuild, BuildID: "bld_1"}}
	for range 40 {
		huge.Lines = append(huge.Lines, protocol.LogLine{Stream: protocol.StreamStdout, Text: strings.Repeat("\x01", protocol.MaxLogLineBytes)})
	}
	if err := c.Send(ctx, huge); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("oversized frame: %v", err)
	}

	if err := stop(); err != nil {
		t.Fatal(err)
	}
	if err := c.Send(ctx, status); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("send after stop: %v", err)
	}
}

func TestFitHello(t *testing.T) {
	h := protocol.Hello{Type: protocol.TypeHello, Arch: protocol.ArchAMD64}
	for i := range protocol.MaxStatusesPerHello {
		h.Statuses = append(h.Statuses, protocol.WorkloadStatusReport{
			WorkloadID: "wl_" + strings.Repeat("x", 10) + string(rune('a'+i%26)),
			State:      protocol.StateCrashed,
			Message:    strings.Repeat("\x01", protocol.MaxMessageBytes),
		})
	}
	fit := fitHello(h)
	data, _ := json.Marshal(&fit)
	if len(data) > protocol.MaxAgentFrameBytes {
		t.Fatalf("hello still %d bytes", len(data))
	}
	if len(fit.Statuses) != protocol.MaxStatusesPerHello || fit.Statuses[0].Message != "" {
		t.Fatalf("statuses %d, message %q", len(fit.Statuses), fit.Statuses[0].Message)
	}
	if h.Statuses[0].Message == "" {
		t.Fatal("fitHello modified its input")
	}
	small := protocol.Hello{Type: protocol.TypeHello, Statuses: []protocol.WorkloadStatusReport{{WorkloadID: "wl_1", Message: "ok"}}}
	if fitHello(small).Statuses[0].Message != "ok" {
		t.Fatal("a hello that fits was changed")
	}
}

func ptr[T any](v T) *T { return &v }

// serviceOn is a shape-valid service workload of prj_1/env_1 on network.
func serviceOn(network string) protocol.WorkloadSpec {
	id := func(s string) *string { return &s }
	return protocol.WorkloadSpec{
		ID:            "wl_1",
		Kind:          protocol.WorkloadService,
		ProjectID:     id("prj_1"),
		EnvironmentID: id("env_1"),
		ServiceID:     id("svc_1"),
		DeploymentID:  id("dep_1"),
		Image:         "nginx:1.27",
		EnvSealed:     &protocol.SealedBox{V: 1, KID: "0123456789abcdef", EPK: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=", CT: "AAAAAAAAAAAAAAAAAAAAAA=="},
		Ports:         []protocol.WorkloadPort{},
		Routes:        []protocol.WorkloadRoute{},
		Resources:     protocol.Resources{CPUMillis: 250, MemoryMB: 256, PIDs: 128},
		Restart:       protocol.Restart{Policy: protocol.RestartAlways},
		Network:       network,
		Labels:        map[string]string{},
		DrainS:        10,
		SpecHash:      strings.Repeat("0", 64),
	}
}

// TestDropsDesiredStateOnAForeignNetwork checks the agent end of ADR 0014's
// H1: a signed desired_state that puts a service on any network other than
// its own environment's (or its project's legacy one) is never applied.
func TestDropsDesiredStateOnAForeignNetwork(t *testing.T) {
	leaktest.Check(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	cp := newFakeControlPlane(t)
	h := &fakeHandler{}
	c := newTestClient(t, cp.url(), pub, nil, &syncBuffer{})
	c.Handler = h
	stop := startClient(t, c)
	cp.next(t)

	future := time.Now().Add(time.Minute)
	gen := int64(1)
	for _, network := range []string{"roundhouse-prj_2-env_1", "roundhouse-prj_2", "roundhouse-prj_1-env_2", "host", "bridge", "none", "roundhouse-system", "roundhouse-build"} {
		bad := desired("m_bad_"+network, gen, future)
		bad.Workloads = []protocol.WorkloadSpec{serviceOn(network)}
		cp.push(t, priv, bad)
		gen++
	}
	legacy := desired("m_legacy", gen, future)
	legacy.Workloads = []protocol.WorkloadSpec{serviceOn(protocol.ProjectNetworkName("prj_1"))}
	cp.push(t, priv, legacy)
	good := desired("m_good", gen+1, future)
	good.Workloads = []protocol.WorkloadSpec{serviceOn(protocol.EnvironmentNetworkName("prj_1", "env_1"))}
	cp.push(t, priv, good)

	waitFor(t, "the allowed generations", func() bool { a, _ := h.snapshot(); return len(a) == 2 })
	if applied, _ := h.snapshot(); applied[0] != gen || applied[1] != gen+1 {
		t.Fatalf("applied %v, want only %d and %d", applied, gen, gen+1)
	}
	if err := stop(); err != nil {
		t.Fatal(err)
	}
}
