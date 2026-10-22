package builder

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
)

func TestRedactor(t *testing.T) {
	r := newRedactor(testToken, map[string]string{
		"API_TOKEN":    "tok-value-1234",
		"DB_PASSWORD":  "line-one\nline-two-secret",
		"NODE_ENV":     "production",
		"SHORT_SECRET": "abc",
		"STRIPE_KEY":   "sk_live_abcdef",
	})
	basic := base64.StdEncoding.EncodeToString([]byte(gitTokenUser + ":" + testToken))
	cases := map[string]string{
		"token " + testToken + " here":       "token " + redactedText + " here",
		"Authorization: Basic " + basic:      "Authorization: Basic " + redactedText,
		"export API_TOKEN=tok-value-1234":    "export API_TOKEN=" + redactedText,
		"line-two-secret":                    redactedText,
		"key sk_live_abcdef":                 "key " + redactedText,
		"NODE_ENV=production":                "NODE_ENV=production",
		"abc is too short to be a secret":    "abc is too short to be a secret",
		testToken + testToken:                redactedText + redactedText,
		"nothing to see":                     "nothing to see",
		"url https://" + testToken + "@host": "url https://" + redactedText + "@host",
	}
	for in, want := range cases {
		if got := r.redact(in); got != want {
			t.Errorf("redact(%q) = %q, want %q", in, got, want)
		}
	}
	var nilRedactor *redactor
	if nilRedactor.redact("x") != "x" {
		t.Error("nil redactor must be a no-op")
	}
}

type fakeTicker struct {
	ch chan time.Time
}

func (f *fakeTicker) now() time.Time { return time.UnixMilli(1_700_000_000_000) }

func (f *fakeTicker) tick(time.Duration) (<-chan time.Time, func()) { return f.ch, func() {} }

type frameSink struct {
	mu     sync.Mutex
	frames []protocol.Logs
	got    chan struct{}
}

func newFrameSink() *frameSink { return &frameSink{got: make(chan struct{}, 100)} }

func (s *frameSink) emit(l protocol.Logs) {
	s.mu.Lock()
	s.frames = append(s.frames, l)
	s.mu.Unlock()
	s.got <- struct{}{}
}

func (s *frameSink) all() []protocol.Logs {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]protocol.Logs(nil), s.frames...)
}

func TestLogBatcherSplitsByLineCount(t *testing.T) {
	sink := newFrameSink()
	b := newLogBatcher("bld_1", sink.emit, nil, &fakeTicker{ch: make(chan time.Time)})
	for i := range 1200 {
		b.add(protocol.StreamStdout, fmt.Sprintf("line %d\n", i))
	}
	b.Close()
	frames := sink.all()
	var sizes []int
	n := 0
	for _, f := range frames {
		sizes = append(sizes, len(f.Lines))
		if err := f.Validate(); err != nil {
			t.Fatalf("invalid frame: %v", err)
		}
		if f.Source.Type != protocol.LogSourceBuild || f.Source.BuildID != "bld_1" || f.Type != protocol.TypeLogs {
			t.Fatalf("bad frame header %+v", f.Source)
		}
		for _, l := range f.Lines {
			if l.Text != fmt.Sprintf("line %d", n) {
				t.Fatalf("line %d = %q (order or newline handling broken)", n, l.Text)
			}
			n++
		}
	}
	if fmt.Sprint(sizes) != "[500 500 200]" {
		t.Errorf("frame sizes %v", sizes)
	}
}

func TestLogBatcherSplitsByBytesAndTruncates(t *testing.T) {
	sink := newFrameSink()
	b := newLogBatcher("bld_1", sink.emit, nil, &fakeTicker{ch: make(chan time.Time)})
	big := strings.Repeat("x", 10_000)
	for range 20 {
		b.add(protocol.StreamStderr, big)
	}
	b.add(protocol.StreamStdout, strings.Repeat("é", protocol.MaxLogLineBytes))
	b.add(protocol.StreamStdout, "bad utf8 \xff\xfe")
	b.Close()
	total := 0
	for _, f := range sink.all() {
		if err := f.Validate(); err != nil {
			t.Fatalf("invalid frame: %v", err)
		}
		enc, _ := json.Marshal(f)
		if len(enc) > protocol.MaxAgentFrameBytes {
			t.Fatalf("frame encodes to %d bytes", len(enc))
		}
		size := 0
		for _, l := range f.Lines {
			size += len(l.Text)
			if len(l.Text) > protocol.MaxLogLineBytes {
				t.Fatalf("line of %d bytes", len(l.Text))
			}
		}
		if size > protocol.MaxLogFrameTextBytes {
			t.Fatalf("frame text %d bytes", size)
		}
		total += len(f.Lines)
	}
	if total != 22 {
		t.Errorf("lines = %d, want 22", total)
	}
}

func TestLogBatcherFlushesOnTick(t *testing.T) {
	sink := newFrameSink()
	ft := &fakeTicker{ch: make(chan time.Time)}
	b := newLogBatcher("bld_1", sink.emit, nil, ft)
	defer b.Close()
	b.add(protocol.StreamSystem, "hello")
	// A tick can win the race against the queued line, flushing nothing, so
	// keep ticking until the line arrives.
	timeout := time.After(5 * time.Second)
	for flushed := false; !flushed; {
		select {
		case ft.ch <- time.Now():
		case <-sink.got:
			flushed = true
		case <-timeout:
			t.Fatal("tick did not flush")
		}
	}
	if f := sink.all(); len(f) != 1 || f[0].Lines[0].Text != "hello" || f[0].Lines[0].TS != 1_700_000_000_000 {
		t.Fatalf("frames %+v", f)
	}
}

func TestLogBatcherRealTickerFlushesWithinASecond(t *testing.T) {
	sink := newFrameSink()
	b := newLogBatcher("bld_1", sink.emit, nil, nil)
	defer b.Close()
	b.system("hello")
	select {
	case <-sink.got:
	case <-time.After(3 * time.Second):
		t.Fatal("no flush within the interval")
	}
}

func TestLogBatcherRedactsAndCloses(t *testing.T) {
	sink := newFrameSink()
	b := newLogBatcher("bld_1", sink.emit, newRedactor(testToken, nil), nil)
	b.add(protocol.StreamStderr, "fatal: "+testToken)
	b.Close()
	b.Close()
	b.add(protocol.StreamStdout, "after close is dropped")
	frames := sink.all()
	if len(frames) != 1 || frames[0].Lines[0].Text != "fatal: "+redactedText {
		t.Fatalf("frames %+v", frames)
	}
}

func TestLineWriter(t *testing.T) {
	sink := newFrameSink()
	b := newLogBatcher("bld_1", sink.emit, nil, &fakeTicker{ch: make(chan time.Time)})
	w := newLineWriter(b, protocol.StreamStderr)
	_, _ = w.Write([]byte("one\ntw"))
	_, _ = w.Write([]byte("o\r\n\nprogress 10%\rprogress 100%\n"))
	_, _ = w.Write([]byte(strings.Repeat("z", maxPendingLine+10)))
	_, _ = w.Write([]byte("tail without newline"))
	w.Flush()
	b.Close()
	var got []string
	for _, f := range sink.all() {
		for _, l := range f.Lines {
			if l.Stream != protocol.StreamStderr {
				t.Fatalf("stream %q", l.Stream)
			}
			got = append(got, l.Text)
		}
	}
	want := []string{"one", "two", "progress 10%", "progress 100%", strings.Repeat("z", maxPendingLine),
		strings.Repeat("z", 10) + "tail without newline"}
	if len(got) != len(want) {
		t.Fatalf("got %d lines: %q", len(got), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("line %d = %.40q, want %.40q", i, got[i], want[i])
		}
	}
}
