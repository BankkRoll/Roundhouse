package builds

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/leaktest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// fakeBuilder blocks each build until release is closed or ctx ends.
type fakeBuilder struct {
	release chan struct{}
	started chan string
	result  func(job protocol.BuildJob) protocol.BuildResult
}

func (b *fakeBuilder) Run(ctx context.Context, job protocol.BuildJob, emit func(protocol.Logs)) protocol.BuildResult {
	b.started <- job.BuildID
	emit(protocol.Logs{Lines: []protocol.LogLine{{Stream: protocol.StreamStdout, Text: "building " + job.BuildID}}})
	select {
	case <-b.release:
	case <-ctx.Done():
		return protocol.BuildResult{BuildID: job.BuildID, Error: "cancelled"}
	}
	return b.result(job)
}

type outbox struct {
	mu      sync.Mutex
	down    bool
	results []protocol.BuildResult
	logs    []protocol.Logs
}

func (o *outbox) send(_ context.Context, r *protocol.BuildResult) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.down {
		return errors.New("not connected")
	}
	if err := r.Validate(); err != nil {
		return err
	}
	o.results = append(o.results, *r)
	return nil
}

func (o *outbox) log(_ context.Context, l protocol.Logs) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.logs = append(o.logs, l)
	return nil
}

func (o *outbox) get() []protocol.BuildResult {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]protocol.BuildResult(nil), o.results...)
}

func job(id string) *protocol.BuildJob {
	return &protocol.BuildJob{Type: protocol.TypeBuildJob, BuildID: id, DeploymentID: "dep_1", TimeoutS: 60}
}

func okResult(job protocol.BuildJob) protocol.BuildResult {
	return protocol.BuildResult{OK: true, Image: &protocol.BuiltImage{
		Repository: protocol.LocalImageRepository("prj_1", "svc_1"), Digest: "sha256:" + strings.Repeat("ab", 32),
	}}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func start(t *testing.T, d *Dispatcher) func() {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_ = d.Run(ctx)
		close(done)
	}()
	return func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("Run did not return")
		}
	}
}

func TestOneBuildAtATime(t *testing.T) {
	leaktest.Check(t)
	b := &fakeBuilder{release: make(chan struct{}), started: make(chan string, 4), result: okResult}
	out := &outbox{}
	d := New(Options{Builder: b, Send: out.send, Logs: out.log})
	stop := start(t, d)
	defer stop()

	d.Start(job("bld_1"))
	if id := <-b.started; id != "bld_1" {
		t.Fatalf("started %s", id)
	}
	d.Start(job("bld_1"))
	d.Start(job("bld_2"))
	waitFor(t, "the rejection", func() bool { return len(out.get()) == 1 })
	r := out.get()[0]
	if r.BuildID != "bld_2" || r.OK || !strings.Contains(r.Error, "bld_1") {
		t.Fatalf("rejection %+v", r)
	}
	close(b.release)
	waitFor(t, "the result", func() bool { return len(out.get()) == 2 })
	r = out.get()[1]
	if r.BuildID != "bld_1" || !r.OK || r.Type != protocol.TypeBuildResult {
		t.Fatalf("result %+v", r)
	}
	out.mu.Lock()
	if len(out.logs) != 1 || out.logs[0].Source.BuildID != "bld_1" || out.logs[0].Type != protocol.TypeLogs {
		t.Fatalf("logs %+v", out.logs)
	}
	out.mu.Unlock()

	// A re-sent job gets its result again rather than a second build.
	d.Start(job("bld_1"))
	waitFor(t, "the repeated result", func() bool { return len(out.get()) == 3 })
	if r := out.get()[2]; r.BuildID != "bld_1" || !r.OK {
		t.Fatalf("repeat %+v", r)
	}
	select {
	case id := <-b.started:
		t.Fatalf("rebuilt %s", id)
	default:
	}
}

func TestNotABuilder(t *testing.T) {
	leaktest.Check(t)
	out := &outbox{}
	d := New(Options{Send: out.send})
	stop := start(t, d)
	defer stop()
	d.Start(job("bld_1"))
	waitFor(t, "the refusal", func() bool { return len(out.get()) == 1 })
	if r := out.get()[0]; r.OK || !strings.Contains(r.Error, "not a builder") {
		t.Fatalf("result %+v", r)
	}
}

func TestResultsRetriedUntilConnected(t *testing.T) {
	leaktest.Check(t)
	b := &fakeBuilder{release: make(chan struct{}), started: make(chan string, 1), result: okResult}
	close(b.release)
	out := &outbox{down: true}
	d := New(Options{Builder: b, Send: out.send})
	stop := start(t, d)
	defer stop()
	d.Start(job("bld_1"))
	<-b.started
	time.Sleep(50 * time.Millisecond)
	if len(out.get()) != 0 {
		t.Fatal("delivered while down")
	}
	out.mu.Lock()
	out.down = false
	out.mu.Unlock()
	d.Connected()
	waitFor(t, "delivery", func() bool { return len(out.get()) == 1 })
}

func TestInvalidResultBecomesFailure(t *testing.T) {
	leaktest.Check(t)
	b := &fakeBuilder{release: make(chan struct{}), started: make(chan string, 1), result: func(protocol.BuildJob) protocol.BuildResult {
		return protocol.BuildResult{OK: true}
	}}
	close(b.release)
	out := &outbox{}
	d := New(Options{Builder: b, Send: out.send})
	stop := start(t, d)
	defer stop()
	d.Start(job("bld_1"))
	waitFor(t, "result", func() bool { return len(out.get()) == 1 })
	if r := out.get()[0]; r.OK || !strings.Contains(r.Error, "invalid result") {
		t.Fatalf("result %+v", r)
	}
}

func TestShutdownCancelsRunningBuild(t *testing.T) {
	leaktest.Check(t)
	b := &fakeBuilder{release: make(chan struct{}), started: make(chan string, 1), result: okResult}
	out := &outbox{}
	d := New(Options{Builder: b, Send: out.send})
	stop := start(t, d)
	d.Start(job("bld_1"))
	<-b.started
	stop()
	d.Start(job("bld_2"))
	if len(out.get()) != 0 {
		t.Fatalf("results after shutdown: %+v", out.get())
	}
}

func TestNotReadyFailsFast(t *testing.T) {
	leaktest.Check(t)
	b := &fakeBuilder{release: make(chan struct{}), started: make(chan string, 1), result: okResult}
	out := &outbox{}
	d := New(Options{Builder: b, Send: out.send, Ready: func() error { return errors.New("registry is not healthy") }})
	stop := start(t, d)
	defer stop()
	d.Start(job("bld_1"))
	waitFor(t, "the failure", func() bool { return len(out.get()) == 1 })
	if r := out.get()[0]; r.OK || r.Error != "registry is not healthy" {
		t.Fatalf("result %+v", r)
	}
}
