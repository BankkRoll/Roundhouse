package logship

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/leaktest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// fakeLogs serves each container's lines as the engine does: multiplexed,
// timestamp-prefixed, filtered by an inclusive since, and ending when the
// container "stops" (follow is honoured only while open is true).
type fakeLogs struct {
	mu    sync.Mutex
	lines map[string][]fakeLine
	opens []docker.LogsOptions
	// live keeps a stream open until the test closes it.
	live chan struct{}
}

type fakeLine struct {
	ts     time.Time
	stream docker.StreamType
	text   string
}

func (f *fakeLogs) add(id string, ts time.Time, st docker.StreamType, text string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lines[id] = append(f.lines[id], fakeLine{ts, st, text})
}

func (f *fakeLogs) ContainerLogs(ctx context.Context, id string, opts docker.LogsOptions) (io.ReadCloser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.opens = append(f.opens, opts)
	var buf bytes.Buffer
	for _, l := range f.lines[id] {
		if l.ts.Before(opts.Since) {
			continue
		}
		payload := l.ts.UTC().Format(time.RFC3339Nano) + " " + l.text + "\n"
		hdr := make([]byte, 8)
		hdr[0] = byte(l.stream)
		binary.BigEndian.PutUint32(hdr[4:], uint32(len(payload)))
		buf.Write(hdr)
		buf.WriteString(payload)
	}
	if f.live == nil {
		return io.NopCloser(&buf), nil
	}
	pr, pw := io.Pipe()
	live := f.live
	go func() {
		_, _ = pw.Write(buf.Bytes())
		select {
		case <-live:
		case <-ctx.Done():
		}
		pw.Close()
	}()
	return pr, nil
}

// sink collects delivered frames; while down, Send fails.
type sink struct {
	mu     sync.Mutex
	down   bool
	frames []protocol.Logs
}

func (s *sink) send(_ context.Context, l *protocol.Logs) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.down {
		return errors.New("not connected")
	}
	data, _ := json.Marshal(l)
	if len(data) > protocol.MaxAgentFrameBytes {
		return fmt.Errorf("frame of %d bytes", len(data))
	}
	if err := l.Validate(); err != nil {
		return err
	}
	s.frames = append(s.frames, *l)
	return nil
}

func (s *sink) setDown(down bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.down = down
}

func (s *sink) texts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, f := range s.frames {
		for _, l := range f.Lines {
			out = append(out, l.Text)
		}
	}
	return out
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type run struct {
	s      *Shipper
	cancel context.CancelFunc
	done   chan error
}

func start(t *testing.T, opts Options) *run {
	t.Helper()
	s, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &run{s: s, cancel: cancel, done: make(chan error, 1)}
	go func() { r.done <- s.Run(ctx) }()
	return r
}

func (r *run) stop(t *testing.T) {
	t.Helper()
	r.cancel()
	select {
	case <-r.done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return")
	}
}

var t0 = time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)

func target(id string, running bool, started time.Time) Target {
	return Target{ContainerID: id, WorkloadID: "wl_a", DeploymentID: "dep_a", Running: running, StartedAt: started}
}

func TestFollowBatchAndResumeWithoutDuplicates(t *testing.T) {
	leaktest.Check(t)
	src := &fakeLogs{lines: map[string][]fakeLine{}}
	out := &sink{}
	dir := t.TempDir()
	src.add("c1", t0, docker.Stdout, "one")
	src.add("c1", t0.Add(time.Millisecond), docker.Stderr, "two")
	r := start(t, Options{Docker: src, Send: out.send, Dir: dir, FlushInterval: 20 * time.Millisecond})
	r.s.Sync([]Target{target("c1", false, t0), {ContainerID: "sys", WorkloadID: "sys_registry"}})
	eventually(t, "two lines", func() bool { return len(out.texts()) == 2 })

	// The container restarts and writes more; the shipper resumes from the
	// last timestamp and skips the line the inclusive since returns again.
	src.add("c1", t0.Add(time.Second), docker.Stdout, "three")
	r.s.Sync([]Target{target("c1", true, t0.Add(time.Second))})
	eventually(t, "three lines", func() bool { return len(out.texts()) == 3 })
	time.Sleep(50 * time.Millisecond)
	if got := strings.Join(out.texts(), ","); got != "one,two,three" {
		t.Fatalf("lines = %s", got)
	}
	out.mu.Lock()
	f := out.frames[0]
	out.mu.Unlock()
	if f.Source != (protocol.LogSource{Type: protocol.LogSourceRuntime, WorkloadID: "wl_a", DeploymentID: "dep_a"}) ||
		f.Lines[0].TS != t0.UnixMilli() || f.Lines[1].Stream != protocol.StreamStderr {
		t.Fatalf("frame %+v", f)
	}
	src.mu.Lock()
	if len(src.opens) < 2 || !src.opens[len(src.opens)-1].Since.Equal(t0.Add(time.Millisecond)) {
		t.Fatalf("resume since = %v", src.opens[len(src.opens)-1].Since)
	}
	src.mu.Unlock()
	r.stop(t)

	// After an agent restart the saved position prevents a replay.
	out2 := &sink{}
	r2 := start(t, Options{Docker: src, Send: out2.send, Dir: dir, FlushInterval: 20 * time.Millisecond})
	src.add("c1", t0.Add(2*time.Second), docker.Stdout, "four")
	r2.s.Sync([]Target{target("c1", false, t0.Add(time.Second))})
	eventually(t, "the new line", func() bool { return len(out2.texts()) == 1 })
	time.Sleep(50 * time.Millisecond)
	if got := out2.texts(); len(got) != 1 || got[0] != "four" {
		t.Fatalf("after restart: %v", got)
	}
	r2.stop(t)
}

func TestBatchLimits(t *testing.T) {
	leaktest.Check(t)
	src := &fakeLogs{lines: map[string][]fakeLine{}, live: make(chan struct{})}
	out := &sink{}
	for i := range 1200 {
		src.add("c1", t0.Add(time.Duration(i)*time.Microsecond), docker.Stdout, fmt.Sprintf("line %d", i))
	}
	long := strings.Repeat("x", protocol.MaxLogLineBytes+100)
	for i := range 6 {
		src.add("c1", t0.Add(time.Second+time.Duration(i)), docker.Stdout, long)
	}
	r := start(t, Options{Docker: src, Send: out.send, Dir: t.TempDir(), FlushInterval: 50 * time.Millisecond})
	r.s.Sync([]Target{target("c1", true, t0)})
	eventually(t, "all lines", func() bool { return len(out.texts()) == 1206 })
	close(src.live)
	r.stop(t)
	out.mu.Lock()
	defer out.mu.Unlock()
	for i, f := range out.frames {
		text := 0
		for _, l := range f.Lines {
			text += len(l.Text)
			if len(l.Text) > protocol.MaxLogLineBytes {
				t.Fatalf("frame %d: line of %d bytes", i, len(l.Text))
			}
		}
		if len(f.Lines) > protocol.MaxLogLinesPerFrame || text > protocol.MaxLogFrameTextBytes {
			t.Fatalf("frame %d: %d lines, %d bytes", i, len(f.Lines), text)
		}
	}
	if len(out.frames) < 3 {
		t.Fatalf("only %d frames", len(out.frames))
	}
}

func TestFlushInterval(t *testing.T) {
	leaktest.Check(t)
	src := &fakeLogs{lines: map[string][]fakeLine{}, live: make(chan struct{})}
	out := &sink{}
	src.add("c1", t0, docker.Stdout, "hello")
	r := start(t, Options{Docker: src, Send: out.send, Dir: t.TempDir()})
	began := time.Now()
	r.s.Sync([]Target{target("c1", true, t0)})
	eventually(t, "a flush", func() bool { return len(out.texts()) == 1 })
	if d := time.Since(began); d > 1500*time.Millisecond {
		t.Fatalf("flushed after %v", d)
	}
	close(src.live)
	r.stop(t)
}

func TestBuffersWhileDisconnectedAndReplaysInOrder(t *testing.T) {
	leaktest.Check(t)
	out := &sink{down: true}
	r := start(t, Options{Docker: &fakeLogs{}, Send: out.send, Dir: t.TempDir()})
	ctx := context.Background()
	submit := func(text string) {
		err := r.s.Submit(ctx, protocol.Logs{Type: protocol.TypeLogs,
			Source: protocol.LogSource{Type: protocol.LogSourceBuild, BuildID: "bld_1"},
			Lines:  []protocol.LogLine{{TS: 1, Stream: protocol.StreamStdout, Text: text}}})
		if err != nil {
			t.Fatal(err)
		}
	}
	for i := range 5 {
		submit(fmt.Sprint(i))
	}
	time.Sleep(50 * time.Millisecond)
	out.setDown(false)
	submit("5")
	r.s.Connected()
	eventually(t, "replay", func() bool { return len(out.texts()) == 6 })
	if got := strings.Join(out.texts(), ""); got != "012345" {
		t.Fatalf("order %s", got)
	}
	r.stop(t)
}

func TestSpoolSurvivesRestart(t *testing.T) {
	leaktest.Check(t)
	dir := t.TempDir()
	out := &sink{down: true}
	r := start(t, Options{Docker: &fakeLogs{}, Send: out.send, Dir: dir})
	for i := range 3 {
		_ = r.s.Submit(context.Background(), protocol.Logs{Type: protocol.TypeLogs,
			Source: protocol.LogSource{Type: protocol.LogSourceBuild, BuildID: "bld_1"},
			Lines:  []protocol.LogLine{{Stream: protocol.StreamStdout, Text: fmt.Sprint(i)}}})
	}
	r.stop(t)

	out.setDown(false)
	r2 := start(t, Options{Docker: &fakeLogs{}, Send: out.send, Dir: dir})
	r2.s.Connected()
	eventually(t, "replay after restart", func() bool { return len(out.texts()) == 3 })
	r2.stop(t)
	if got := strings.Join(out.texts(), ""); got != "012" {
		t.Fatalf("got %s", got)
	}
}

func TestSplitFrame(t *testing.T) {
	ctrl := strings.Repeat("\x01", protocol.MaxLogLineBytes)
	var lines []protocol.LogLine
	for range 20 {
		lines = append(lines, protocol.LogLine{Stream: protocol.StreamStdout, Text: ctrl})
	}
	for range 600 {
		lines = append(lines, protocol.LogLine{Stream: protocol.StreamStdout, Text: "x"})
	}
	lines = append(lines, protocol.LogLine{Stream: protocol.StreamStdout, Text: strings.Repeat("y", 40_000)})
	frames := splitFrame(protocol.Logs{Type: protocol.TypeLogs, Source: protocol.LogSource{Type: protocol.LogSourceBuild, BuildID: "bld_1"}, Lines: lines})
	total := 0
	for i, f := range frames {
		if err := f.Validate(); err != nil {
			t.Fatalf("frame %d invalid: %v", i, err)
		}
		data, _ := json.Marshal(f)
		if len(data) > protocol.MaxAgentFrameBytes {
			t.Fatalf("frame %d encodes to %d bytes", i, len(data))
		}
		total += len(f.Lines)
	}
	if total != len(lines) {
		t.Fatalf("lost lines: %d of %d", total, len(lines))
	}
}

func TestSpool(t *testing.T) {
	dir := t.TempDir()
	sp, err := openSpool(dir, 256<<10)
	if err != nil {
		t.Fatal(err)
	}
	if !sp.empty() {
		t.Fatal("new spool not empty")
	}
	rec := func(i int) []byte { return []byte(fmt.Sprintf("%06d%s", i, strings.Repeat("-", 10_000))) }
	for i := range 10 {
		if _, err := sp.append(rec(i)); err != nil {
			t.Fatal(err)
		}
	}
	for i := range 4 {
		got, err := sp.peek()
		if err != nil || !bytes.Equal(got, rec(i)) {
			t.Fatalf("peek %d = %.6s, %v", i, got, err)
		}
		if err := sp.pop(got); err != nil {
			t.Fatal(err)
		}
	}

	// Reopening resumes at the persisted position.
	sp, err = openSpool(dir, 256<<10)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := sp.peek()
	if !bytes.HasPrefix(got, []byte("000004")) {
		t.Fatalf("after reopen: %.6s", got)
	}

	// Overflow drops the oldest records, keeping the newest.
	var dropped int64
	for i := 10; i < 60; i++ {
		d, err := sp.append(rec(i))
		if err != nil {
			t.Fatal(err)
		}
		dropped += d
	}
	if dropped == 0 || sp.size() > 256<<10 {
		t.Fatalf("dropped %d, size %d", dropped, sp.size())
	}
	var seen []string
	for {
		got, err := sp.peek()
		if err != nil {
			t.Fatal(err)
		}
		if got == nil {
			break
		}
		seen = append(seen, string(got[:6]))
		_ = sp.pop(got)
	}
	if seen[len(seen)-1] != "000059" {
		t.Fatalf("newest record lost: %v", seen)
	}
	for i := 1; i < len(seen); i++ {
		if seen[i] <= seen[i-1] {
			t.Fatalf("out of order: %v", seen)
		}
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatalf("drained spool left files: %v", entries)
	}
}

func TestSpoolTornRecord(t *testing.T) {
	dir := t.TempDir()
	sp, _ := openSpool(dir, 1<<20)
	_, _ = sp.append([]byte("good"))
	_, _ = sp.append([]byte("torn-record"))
	path := sp.segPath(sp.segs[0].n)
	info, _ := os.Stat(path)
	if err := os.Truncate(path, info.Size()-3); err != nil {
		t.Fatal(err)
	}
	sp, _ = openSpool(dir, 1<<20)
	got, _ := sp.peek()
	if string(got) != "good" {
		t.Fatalf("first = %q", got)
	}
	_ = sp.pop(got)
	if got, err := sp.peek(); got != nil || err != nil {
		t.Fatalf("torn record returned: %q %v", got, err)
	}
	if _, err := sp.append([]byte("after")); err != nil {
		t.Fatal(err)
	}
	if got, _ := sp.peek(); string(got) != "after" {
		t.Fatalf("after torn = %q", got)
	}
}

func TestOutOfOrderStreamsAreNotDropped(t *testing.T) {
	leaktest.Check(t)
	src := &fakeLogs{lines: map[string][]fakeLine{}}
	out := &sink{}
	// The engine stamps stdout and stderr in separate goroutines, so a
	// later line can carry an earlier timestamp.
	src.add("c1", t0.Add(2*time.Millisecond), docker.Stdout, "late stamp")
	src.add("c1", t0.Add(time.Millisecond), docker.Stderr, "early stamp")
	r := start(t, Options{Docker: src, Send: out.send, Dir: t.TempDir(), FlushInterval: 20 * time.Millisecond})
	r.s.Sync([]Target{target("c1", false, t0)})
	eventually(t, "both lines", func() bool { return len(out.texts()) == 2 })
	r.stop(t)
}
