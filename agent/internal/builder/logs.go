package builder

import (
	"bytes"
	"sync"
	"time"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// logFlushInterval is the longest a line waits before it is emitted.
const logFlushInterval = time.Second

// logQueueLen bounds lines waiting for the emitter. A slow emit blocks the
// producers instead of buffering a whole build's output in memory.
const logQueueLen = 2048

// logBatcher turns build output into logs frames for one build. Lines are
// redacted, cut with [protocol.TruncateLogLine], and emitted in batches of at
// most [protocol.MaxLogLinesPerFrame] lines and [protocol.MaxLogFrameTextBytes]
// of text, at least every [logFlushInterval].
//
// Every line is emitted from the batcher's own goroutine, in the order lines
// were added; [logBatcher.Close] flushes and waits for it.
type logBatcher struct {
	buildID string
	emit    func(protocol.Logs)
	red     *redactor
	ticks   ticker

	lines chan protocol.LogLine
	done  chan struct{}

	closeOnce sync.Once
	// mu guards closed: adding after Close is a silent no-op rather than a
	// send on a closed channel.
	mu     sync.RWMutex
	closed bool
}

// ticker abstracts time for tests: now reports the current time, and tick
// returns a channel that fires every d with a function that stops it.
type ticker interface {
	now() time.Time
	tick(d time.Duration) (<-chan time.Time, func())
}

type realTicker struct{}

func (realTicker) now() time.Time { return time.Now() }

func (realTicker) tick(d time.Duration) (<-chan time.Time, func()) {
	t := time.NewTicker(d)
	return t.C, t.Stop
}

func newLogBatcher(buildID string, emit func(protocol.Logs), red *redactor, ticks ticker) *logBatcher {
	if ticks == nil {
		ticks = realTicker{}
	}
	b := &logBatcher{
		buildID: buildID,
		emit:    emit,
		red:     red,
		ticks:   ticks,
		lines:   make(chan protocol.LogLine, logQueueLen),
		done:    make(chan struct{}),
	}
	go b.loop()
	return b
}

// add queues one line of text. A trailing newline is removed.
func (b *logBatcher) add(stream protocol.LogStream, text string) {
	text = string(bytes.TrimRight([]byte(text), "\r\n"))
	line := protocol.LogLine{
		TS:     b.ticks.now().UnixMilli(),
		Stream: stream,
		Text:   protocol.TruncateLogLine(b.red.redact(text)),
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.closed {
		return
	}
	b.lines <- line
}

// system queues a line written by the builder itself.
func (b *logBatcher) system(text string) { b.add(protocol.StreamSystem, text) }

// Close emits everything queued and stops the batcher. It is idempotent.
func (b *logBatcher) Close() {
	b.closeOnce.Do(func() {
		b.mu.Lock()
		b.closed = true
		close(b.lines)
		b.mu.Unlock()
		<-b.done
	})
}

func (b *logBatcher) loop() {
	defer close(b.done)
	tick, stopTick := b.ticks.tick(logFlushInterval)
	defer stopTick()

	var batch []protocol.LogLine
	size := 0
	flush := func() {
		if len(batch) == 0 {
			return
		}
		if b.emit != nil {
			b.emit(protocol.Logs{
				Type:   protocol.TypeLogs,
				Source: protocol.LogSource{Type: protocol.LogSourceBuild, BuildID: b.buildID},
				Lines:  batch,
			})
		}
		batch, size = nil, 0
	}
	for {
		select {
		case line, ok := <-b.lines:
			if !ok {
				flush()
				return
			}
			if len(batch) == protocol.MaxLogLinesPerFrame || size+len(line.Text) > protocol.MaxLogFrameTextBytes {
				flush()
			}
			batch = append(batch, line)
			size += len(line.Text)
		case <-tick:
			flush()
		}
	}
}

// lineWriter is an io.Writer that splits what is written into lines and
// adds each to a batcher. "\r" also ends a line, so progress meters that
// redraw in place produce one line per update. Overlong lines are split at
// [maxPendingLine] so a stream without newlines cannot grow without bound.
type lineWriter struct {
	b      *logBatcher
	stream protocol.LogStream

	mu  sync.Mutex
	buf []byte
}

const maxPendingLine = protocol.MaxLogLineBytes

func newLineWriter(b *logBatcher, stream protocol.LogStream) *lineWriter {
	return &lineWriter{b: b, stream: stream}
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf = append(w.buf, p...)
	for {
		i := bytes.IndexAny(w.buf, "\r\n")
		if i < 0 {
			break
		}
		w.emitLine(w.buf[:i])
		w.buf = w.buf[i+1:]
	}
	for len(w.buf) >= maxPendingLine {
		w.emitLine(w.buf[:maxPendingLine])
		w.buf = w.buf[maxPendingLine:]
	}
	// Reclaim the consumed prefix instead of letting the slice creep forward.
	w.buf = append([]byte(nil), w.buf...)
	return len(p), nil
}

// Flush adds any unterminated final line.
func (w *lineWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.emitLine(w.buf)
	w.buf = nil
}

func (w *lineWriter) emitLine(line []byte) {
	if len(bytes.TrimSpace(line)) == 0 {
		return
	}
	w.b.add(w.stream, string(line))
}
