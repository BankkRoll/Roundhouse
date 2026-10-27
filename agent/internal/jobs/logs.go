package jobs

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// logItem is one line read from a container, with its engine timestamp.
type logItem struct {
	line protocol.LogLine
	ns   int64
}

// follow ships container id's output until the container has exited and
// every line is submitted, which it reports; it returns false when ctx ends
// first or the stream keeps failing after the exit. exited is closed once
// the container has stopped.
func (r *Runner) follow(ctx context.Context, rn *run, id string, exited <-chan struct{}) bool {
	if r.opts.Logs == nil {
		return true
	}
	delay := 500 * time.Millisecond
	failures := 0
	for {
		// NOTE: a stream can end cleanly just before the container exits; a
		// pass that starts after the exit is known reads everything left.
		final := isClosed(exited)
		err := r.followOnce(ctx, rn, id)
		switch {
		case ctx.Err() != nil:
			return false
		case docker.IsNotFound(err):
			return true
		case err == nil && final:
			return true
		case err != nil:
			failures++
			r.log.Debug("job log stream ended", "run_id", rn.id, "err", err)
			if final && failures > 5 {
				return false
			}
		}
		var wake <-chan struct{}
		if !final {
			wake = exited
		}
		t := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			t.Stop()
			return false
		case <-wake:
		case <-t.C:
		}
		t.Stop()
		delay = min(delay*2, 10*time.Second)
	}
}

func isClosed(c <-chan struct{}) bool {
	select {
	case <-c:
		return true
	default:
		return false
	}
}

// followOnce streams the lines written after rn's last shipped line until
// the stream ends, submitting them in frames of at most
// [protocol.MaxLogLinesPerFrame] lines and [protocol.MaxLogFrameTextBytes]
// of text, at least every FlushInterval. The position advances only past
// lines that were submitted.
func (r *Runner) followOnce(ctx context.Context, rn *run, id string) error {
	r.mu.Lock()
	since := rn.lastLogNS
	r.mu.Unlock()
	opts := docker.LogsOptions{Follow: true, Timestamps: true}
	if since > 0 {
		opts.Since = time.Unix(0, since)
	}
	rc, err := r.d.ContainerLogs(ctx, id, opts)
	if err != nil {
		return err
	}
	defer rc.Close()

	items := make(chan logItem, 256)
	done := make(chan struct{})
	defer close(done)
	var readErr error
	go func() {
		defer close(items)
		readErr = readLogs(rc, since, items, done)
	}()

	source := logSource(rn)
	var lines []protocol.LogLine
	var text int
	var newest int64
	flush := func() error {
		if len(lines) == 0 {
			return nil
		}
		if err := r.opts.Logs(ctx, protocol.Logs{Type: protocol.TypeLogs, Source: source, Lines: lines}); err != nil {
			return err
		}
		lines, text = nil, 0
		r.mu.Lock()
		rn.lastLogNS = max(rn.lastLogNS, newest)
		r.stateDirty = true
		r.mu.Unlock()
		return nil
	}
	tick := time.NewTicker(r.opts.FlushInterval)
	defer tick.Stop()
	for {
		select {
		case it, ok := <-items:
			if !ok {
				if err := flush(); err != nil {
					return err
				}
				return readErr
			}
			if len(lines) >= protocol.MaxLogLinesPerFrame || text+len(it.line.Text) > protocol.MaxLogFrameTextBytes {
				if err := flush(); err != nil {
					return err
				}
			}
			lines = append(lines, it.line)
			text += len(it.line.Text)
			newest = max(newest, it.ns)
		case <-tick.C:
			if err := flush(); err != nil {
				return err
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// readLogs splits the engine's multiplexed, timestamped stream into lines
// newer than since (unix nanos) and sends them to out until the stream ends
// or done closes.
func readLogs(rc io.Reader, since int64, out chan<- logItem, done <-chan struct{}) error {
	d := docker.NewDemuxer(bufio.NewReaderSize(rc, 64<<10))
	for {
		st, payload, err := d.Next()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		stream := protocol.StreamStdout
		switch st {
		case docker.Stderr:
			stream = protocol.StreamStderr
		case docker.Systemerr:
			stream = protocol.StreamSystem
		}
		for _, raw := range bytes.Split(bytes.TrimSuffix(payload, []byte("\n")), []byte("\n")) {
			ts, text := splitTimestamp(raw)
			// NOTE: Since is inclusive, so the last line shipped comes back
			// on resume. The engine stamps stdout and stderr separately, so
			// only the position from before this stream can be compared.
			if ts.UnixNano() <= since {
				continue
			}
			it := logItem{
				line: protocol.LogLine{TS: ts.UnixMilli(), Stream: stream, Text: protocol.TruncateLogLine(string(text))},
				ns:   ts.UnixNano(),
			}
			select {
			case out <- it:
			case <-done:
				return nil
			}
		}
	}
}

// splitTimestamp separates the RFC 3339 timestamp the engine prefixes to
// each line. A line without one is stamped now.
func splitTimestamp(raw []byte) (time.Time, []byte) {
	if i := bytes.IndexByte(raw, ' '); i > 0 {
		if ts, err := time.Parse(time.RFC3339Nano, string(raw[:i])); err == nil {
			return ts, raw[i+1:]
		}
	}
	return time.Now(), raw
}
