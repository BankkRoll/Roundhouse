package builds

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/leaktest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// slowBuilder ignores cancellation until released, as a solve winding down
// does, then reports how its context ended.
type slowBuilder struct {
	release chan struct{}
	started chan string
}

func (b slowBuilder) Run(ctx context.Context, job protocol.BuildJob, _ func(protocol.Logs)) protocol.BuildResult {
	b.started <- job.BuildID
	<-b.release
	if ctx.Err() != nil {
		return protocol.BuildResult{BuildID: job.BuildID, Error: "cancelled"}
	}
	return okResult(job)
}

// A cancelled build stops, is answered as cancelled, and a job sent right
// after the cancel runs as soon as the builder is free instead of being
// refused as busy.
func TestCancelStopsBuildAndFreesBuilder(t *testing.T) {
	leaktest.Check(t)
	b := &fakeBuilder{release: make(chan struct{}), started: make(chan string, 4), result: okResult}
	out := &outbox{}
	d := New(Options{Builder: b, Send: out.send})
	stop := start(t, d)
	defer stop()

	d.Start(job("bld_1"))
	<-b.started
	d.Cancel("bld_1")
	d.Start(job("bld_2"))
	select {
	case id := <-b.started:
		if id != "bld_2" {
			t.Fatalf("started %s", id)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("the next build never started; results %+v", out.get())
	}
	waitFor(t, "the cancelled result", func() bool { return len(out.get()) >= 1 })
	r := out.get()[0]
	if r.BuildID != "bld_1" || r.OK || !r.Cancelled || r.Error != cancelledMessage {
		t.Fatalf("cancelled build answered %+v", r)
	}
	close(b.release)
	waitFor(t, "the next build's result", func() bool { return len(out.get()) == 2 })
	if r := out.get()[1]; r.BuildID != "bld_2" || !r.OK || r.Cancelled {
		t.Fatalf("next build %+v", r)
	}

	// The cancel is idempotent and does not touch finished builds.
	d.Cancel("bld_1")
	d.Cancel("bld_2")
	time.Sleep(50 * time.Millisecond)
	if n := len(out.get()); n != 2 {
		t.Fatalf("%d results after cancelling finished builds", n)
	}
}

// A cancel that arrives before its job (or after the job was lost) makes
// the job answer as cancelled without building.
func TestCancelBeforeJob(t *testing.T) {
	leaktest.Check(t)
	b := &fakeBuilder{release: make(chan struct{}), started: make(chan string, 1), result: okResult}
	out := &outbox{}
	d := New(Options{Builder: b, Send: out.send})
	stop := start(t, d)
	defer stop()
	d.Cancel("bld_1")
	d.Start(job("bld_1"))
	waitFor(t, "the cancelled result", func() bool { return len(out.get()) == 1 })
	if r := out.get()[0]; !r.Cancelled || r.OK {
		t.Fatalf("result %+v", r)
	}
	select {
	case id := <-b.started:
		t.Fatalf("built %s after its cancel", id)
	default:
	}
}

// A queued job can itself be cancelled; only one job waits for a cancelled
// build, the rest are refused as busy.
func TestCancelQueuedJob(t *testing.T) {
	leaktest.Check(t)
	slow := slowBuilder{release: make(chan struct{}), started: make(chan string, 4)}
	out := &outbox{}
	d := New(Options{Builder: slow, Send: out.send})
	stop := start(t, d)
	defer stop()

	d.Start(job("bld_1"))
	<-slow.started
	d.Cancel("bld_1")
	d.Start(job("bld_2"))
	d.Start(job("bld_3"))
	waitFor(t, "bld_3 refused", func() bool { return len(out.get()) == 1 })
	if r := out.get()[0]; r.BuildID != "bld_3" || r.OK || r.Cancelled {
		t.Fatalf("third job %+v", r)
	}
	d.Cancel("bld_2")
	waitFor(t, "bld_2 cancelled", func() bool { return len(out.get()) == 2 })
	if r := out.get()[1]; r.BuildID != "bld_2" || !r.Cancelled {
		t.Fatalf("queued job %+v", r)
	}
	close(slow.release)
	waitFor(t, "bld_1 answered", func() bool { return len(out.get()) == 3 })
	if r := out.get()[2]; r.BuildID != "bld_1" || !r.Cancelled {
		t.Fatalf("cancelled build %+v", r)
	}
	select {
	case id := <-slow.started:
		t.Fatalf("started %s", id)
	case <-time.After(50 * time.Millisecond):
	}
}

// emitAfterCancel writes one line once its build is cancelled, as the real
// builder does with its "Build was cancelled." line.
type emitAfterCancel struct{ started chan string }

func (b emitAfterCancel) Run(ctx context.Context, job protocol.BuildJob, emit func(protocol.Logs)) protocol.BuildResult {
	b.started <- job.BuildID
	<-ctx.Done()
	emit(protocol.Logs{Lines: []protocol.LogLine{{Stream: protocol.StreamSystem, Text: "Error: Build was cancelled."}}})
	return protocol.BuildResult{BuildID: job.BuildID, Error: "Build was cancelled."}
}

// The lines a build writes after its cancel reach the control plane even
// though the build's own context has ended.
func TestLinesAfterCancelAreShipped(t *testing.T) {
	leaktest.Check(t)
	b := emitAfterCancel{started: make(chan string, 1)}
	out := &outbox{}
	var mu sync.Mutex
	var lines []string
	logs := func(ctx context.Context, l protocol.Logs) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		mu.Lock()
		defer mu.Unlock()
		for _, line := range l.Lines {
			lines = append(lines, line.Text)
		}
		return nil
	}
	d := New(Options{Builder: b, Send: out.send, Logs: logs})
	stop := start(t, d)
	defer stop()
	d.Start(job("bld_1"))
	<-b.started
	d.Cancel("bld_1")
	waitFor(t, "the cancelled result", func() bool { return len(out.get()) == 1 })
	mu.Lock()
	defer mu.Unlock()
	if len(lines) != 1 || lines[0] != "Error: Build was cancelled." {
		t.Fatalf("lines shipped: %q", lines)
	}
}
