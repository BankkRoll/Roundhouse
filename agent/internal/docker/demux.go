package docker

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// StreamType identifies which output a multiplexed frame came from.
type StreamType byte

// Stream types of the engine's multiplexed attach and logs format.
const (
	Stdin  StreamType = 0
	Stdout StreamType = 1
	Stderr StreamType = 2
	// Systemerr carries engine-side errors in a logs stream.
	Systemerr StreamType = 3
)

// MaxFrameSize bounds a single multiplexed frame. The engine splits output
// into chunks far smaller than this; a larger header means a corrupt stream.
const MaxFrameSize = 1 << 20

// ErrFrameTooLarge is returned by [Demuxer.Next] for a frame header larger
// than [MaxFrameSize].
var ErrFrameTooLarge = errors.New("docker: multiplexed frame too large")

// Demuxer splits the engine's multiplexed stream format: each frame is an
// 8-byte header (stream type, three zero bytes, big-endian uint32 length)
// followed by that many payload bytes.
type Demuxer struct {
	r   io.Reader
	hdr [8]byte
	buf []byte
}

// NewDemuxer returns a demuxer reading from r.
func NewDemuxer(r io.Reader) *Demuxer {
	return &Demuxer{r: r}
}

// Next returns the next frame's stream and payload. The payload is valid
// until the following call. It returns io.EOF at a clean end of stream and
// io.ErrUnexpectedEOF if the stream ends inside a frame.
func (d *Demuxer) Next() (StreamType, []byte, error) {
	if _, err := io.ReadFull(d.r, d.hdr[:]); err != nil {
		return 0, nil, err
	}
	st := StreamType(d.hdr[0])
	if st > Systemerr {
		return 0, nil, fmt.Errorf("docker: invalid stream type %d", st)
	}
	n := binary.BigEndian.Uint32(d.hdr[4:])
	if n > MaxFrameSize {
		return 0, nil, ErrFrameTooLarge
	}
	if cap(d.buf) < int(n) {
		d.buf = make([]byte, n)
	}
	d.buf = d.buf[:n]
	if _, err := io.ReadFull(d.r, d.buf); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		return 0, nil, err
	}
	return st, d.buf, nil
}
