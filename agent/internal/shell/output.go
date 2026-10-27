package shell

import (
	"encoding/base64"
	"io"
	"time"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// outputWindow is the period [protocol.MaxExecOutputFramesPerSecond] counts
// frames over.
const outputWindow = time.Second

// readChunk is how much one read of the terminal takes.
const readChunk = 32 * 1024

// pumpOutput reads the terminal until it ends and sends what it read as
// exec_output frames, then closes done.
//
// Output is coalesced and sent every flush interval, in frames of at most
// [protocol.MaxExecOutputBytes], and at most
// [protocol.MaxExecOutputFramesPerSecond] frames per second. Output over
// that budget waits for the next window; once [maxPendingOutput] is
// waiting, the terminal is not read until it drains, so the process blocks
// instead of losing output.
func (s *session) pumpOutput(r io.Reader, done chan<- struct{}) {
	defer close(done)
	chunks := make(chan []byte)
	go func() {
		defer close(chunks)
		for {
			buf := make([]byte, readChunk)
			n, err := r.Read(buf)
			if n > 0 {
				chunks <- buf[:n]
			}
			if err != nil {
				return
			}
		}
	}()
	o := outputFrames{s: s}
	tick := time.NewTicker(s.m.opts.flushInterval)
	defer tick.Stop()
	in := chunks
	eof := false
	for {
		select {
		case c, ok := <-in:
			if !ok {
				eof, in = true, nil
				break
			}
			o.pending = append(o.pending, c...)
			if len(o.pending) >= maxPendingOutput {
				in = nil
			}
			continue
		case <-tick.C:
		}
		o.flush(time.Now())
		if eof {
			if len(o.pending) == 0 {
				return
			}
		} else if len(o.pending) < maxPendingOutput {
			in = chunks
		}
	}
}

// outputFrames turns a session's output into numbered frames within the
// frame budget.
type outputFrames struct {
	s       *session
	pending []byte
	seq     int64
	// sentAt is a ring of the last [protocol.MaxExecOutputFramesPerSecond]
	// send times; next indexes the oldest. A sliding window, unlike a fixed
	// one, never lets a burst straddling two windows exceed the budget.
	sentAt [protocol.MaxExecOutputFramesPerSecond]time.Time
	next   int
}

// flush sends as much pending output as the budget allows.
func (o *outputFrames) flush(now time.Time) {
	for len(o.pending) > 0 {
		if oldest := o.sentAt[o.next]; !oldest.IsZero() && now.Sub(oldest) < outputWindow {
			return
		}
		n := min(len(o.pending), protocol.MaxExecOutputBytes)
		o.s.m.send(&protocol.ExecOutput{
			Type: protocol.TypeExecOutput, SessionID: o.s.id, Seq: o.seq,
			Data: base64.StdEncoding.EncodeToString(o.pending[:n]),
		}, o.s.id)
		o.seq++
		o.sentAt[o.next] = now
		o.next = (o.next + 1) % len(o.sentAt)
		o.pending = append(o.pending[:0], o.pending[n:]...)
	}
}
