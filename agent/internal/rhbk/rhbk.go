// Package rhbk reads and writes RHBK1, the streaming container a backup
// stores before compression and encryption (ADR 0004). It holds several
// dumps in one object without knowing their sizes ahead.
//
// Layout:
//
//		"RHBK1\n"
//		entry*:  header line, chunk*, terminator
//		trailer: {"name":"_end"}\n
//
//	  - A header line is a JSON object ([Header]) followed by "\n", at most
//	    [MaxHeaderBytes] including the newline. Its "name" is required, and
//	    only the trailer is named "_end".
//	  - A chunk is a big-endian uint32 length in 1..[MaxChunkBytes], then that
//	    many bytes; a zero length terminates the entry.
//	  - The trailer is a header line alone, with no chunks or terminator, and
//	    nothing may follow it. A stream without one is truncated.
package rhbk

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"
)

// Magic starts every RHBK1 stream.
const Magic = "RHBK1\n"

// Limits of the format.
const (
	// MaxChunkBytes is the largest chunk.
	MaxChunkBytes = 1 << 20
	// MaxHeaderBytes bounds a header line, newline included.
	MaxHeaderBytes = 4096
	// MaxNameBytes bounds an entry name.
	MaxNameBytes = 255
)

// TrailerName names the trailer entry.
const TrailerName = "_end"

// Entry formats.
const (
	// FormatTar is a tar of a volume's files (snapshot backups).
	FormatTar = "tar"
	// FormatPGCustom is pg_dump -Fc output.
	FormatPGCustom = "pg_custom"
	// FormatPGGlobals is pg_dumpall --globals-only SQL.
	FormatPGGlobals = "pg_globals"
	// FormatSQL is plain SQL (mysqldump).
	FormatSQL = "sql"
	// FormatRDB is a Redis or Valkey RDB file.
	FormatRDB = "rdb"
	// FormatMongoArchive is mongodump --archive output.
	FormatMongoArchive = "mongo_archive"
	// FormatPGBaseTar is pg_basebackup's tar of the data directory, with
	// the WAL it needs to be consistent (base backups).
	FormatPGBaseTar = "pg_base_tar"
)

// Header describes one entry.
type Header struct {
	Name string `json:"name"`
	// Engine is the database engine of a dump, "" for snapshots.
	Engine string `json:"engine,omitempty"`
	Format string `json:"format,omitempty"`
	// Database is the database a per-database dump holds.
	Database string `json:"database,omitempty"`
}

// Errors returned by [Reader].
var (
	ErrBadMagic     = errors.New("rhbk: not an RHBK1 stream")
	ErrBadHeader    = errors.New("rhbk: malformed entry header")
	ErrBadChunk     = errors.New("rhbk: chunk too large")
	ErrTrailingData = errors.New("rhbk: data after the trailer")
)

func (h Header) validate(trailer bool) error {
	if h.Name == "" || len(h.Name) > MaxNameBytes || !utf8.ValidString(h.Name) {
		return fmt.Errorf("%w: invalid name", ErrBadHeader)
	}
	if (h.Name == TrailerName) != trailer {
		return fmt.Errorf("%w: %q is reserved for the trailer", ErrBadHeader, TrailerName)
	}
	return nil
}

func encodeHeader(h Header) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(h); err != nil {
		return nil, err
	}
	if buf.Len() > MaxHeaderBytes {
		return nil, fmt.Errorf("%w: header too long", ErrBadHeader)
	}
	return buf.Bytes(), nil
}

// -----------------------------------------------------------------------------
// Writer
// -----------------------------------------------------------------------------

// Writer writes an RHBK1 stream. Entries are written one at a time:
// [Writer.Create] ends the previous entry.
type Writer struct {
	w      io.Writer
	cur    *EntryWriter
	closed bool
	// Raw counts entry payload bytes written.
	raw int64
}

// NewWriter returns a writer that writes the magic to w at once.
func NewWriter(w io.Writer) (*Writer, error) {
	if _, err := io.WriteString(w, Magic); err != nil {
		return nil, err
	}
	return &Writer{w: w}, nil
}

// Create starts an entry, ending the previous one.
func (w *Writer) Create(h Header) (*EntryWriter, error) {
	if w.closed {
		return nil, errors.New("rhbk: writer closed")
	}
	if err := h.validate(false); err != nil {
		return nil, err
	}
	if err := w.endEntry(); err != nil {
		return nil, err
	}
	line, err := encodeHeader(h)
	if err != nil {
		return nil, err
	}
	if _, err := w.w.Write(line); err != nil {
		return nil, err
	}
	w.cur = &EntryWriter{w: w, buf: make([]byte, 0, 256<<10)}
	return w.cur, nil
}

func (w *Writer) endEntry() error {
	if w.cur == nil {
		return nil
	}
	err := w.cur.Close()
	w.cur = nil
	return err
}

// Close ends the current entry and writes the trailer. It does not close
// the underlying writer.
func (w *Writer) Close() error {
	if w.closed {
		return nil
	}
	if err := w.endEntry(); err != nil {
		return err
	}
	w.closed = true
	line, _ := encodeHeader(Header{Name: TrailerName})
	_, err := w.w.Write(line)
	return err
}

// RawBytes returns the entry payload bytes written so far.
func (w *Writer) RawBytes() int64 { return w.raw }

// EntryWriter writes one entry's payload as chunks.
type EntryWriter struct {
	w      *Writer
	buf    []byte
	closed bool
}

// Write buffers p and emits full chunks.
func (e *EntryWriter) Write(p []byte) (int, error) {
	if e.closed {
		return 0, errors.New("rhbk: entry closed")
	}
	n := 0
	for len(p) > 0 {
		room := cap(e.buf) - len(e.buf)
		if room == 0 {
			if err := e.flush(); err != nil {
				return n, err
			}
			continue
		}
		k := min(room, len(p))
		e.buf = append(e.buf, p[:k]...)
		p = p[k:]
		n += k
	}
	e.w.raw += int64(n)
	return n, nil
}

func (e *EntryWriter) flush() error {
	if len(e.buf) == 0 {
		return nil
	}
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(e.buf)))
	if _, err := e.w.w.Write(hdr[:]); err != nil {
		return err
	}
	if _, err := e.w.w.Write(e.buf); err != nil {
		return err
	}
	e.buf = e.buf[:0]
	return nil
}

// Close flushes the payload and writes the terminator.
func (e *EntryWriter) Close() error {
	if e.closed {
		return nil
	}
	e.closed = true
	if err := e.flush(); err != nil {
		return err
	}
	_, err := e.w.w.Write([]byte{0, 0, 0, 0})
	return err
}

// -----------------------------------------------------------------------------
// Reader
// -----------------------------------------------------------------------------

// Reader reads an RHBK1 stream entry by entry.
type Reader struct {
	r *bufio.Reader
	// left is the unread rest of the current chunk; -1 when no entry is
	// open.
	left int64
	done bool
	err  error
}

// NewReader checks the magic and returns a reader.
func NewReader(r io.Reader) (*Reader, error) {
	br := bufio.NewReaderSize(r, 64<<10)
	magic := make([]byte, len(Magic))
	if _, err := io.ReadFull(br, magic); err != nil || string(magic) != Magic {
		return nil, ErrBadMagic
	}
	return &Reader{r: br, left: -1}, nil
}

// Next skips the rest of the current entry and returns the next entry's
// header. It returns io.EOF after the trailer, and io.ErrUnexpectedEOF for
// a stream that ends without one.
func (r *Reader) Next() (Header, error) {
	if r.err != nil {
		return Header{}, r.err
	}
	if r.done {
		return Header{}, io.EOF
	}
	if r.left >= 0 {
		if _, err := io.Copy(io.Discard, r); err != nil {
			return Header{}, r.fail(err)
		}
	}
	line, err := r.readLine()
	if err != nil {
		return Header{}, r.fail(err)
	}
	var h Header
	if err := json.Unmarshal(line, &h); err != nil {
		return Header{}, r.fail(fmt.Errorf("%w: %v", ErrBadHeader, err))
	}
	if h.Name == TrailerName {
		if err := h.validate(true); err != nil {
			return Header{}, r.fail(err)
		}
		if _, err := r.r.ReadByte(); err == nil {
			return Header{}, r.fail(ErrTrailingData)
		} else if !errors.Is(err, io.EOF) {
			return Header{}, r.fail(err)
		}
		r.done = true
		return Header{}, io.EOF
	}
	if err := h.validate(false); err != nil {
		return Header{}, r.fail(err)
	}
	r.left = 0
	return h, nil
}

func (r *Reader) readLine() ([]byte, error) {
	var line []byte
	for {
		b, err := r.r.ReadByte()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, io.ErrUnexpectedEOF
			}
			return nil, err
		}
		if b == '\n' {
			return line, nil
		}
		line = append(line, b)
		if len(line) >= MaxHeaderBytes {
			return nil, fmt.Errorf("%w: header too long", ErrBadHeader)
		}
	}
}

func (r *Reader) fail(err error) error {
	r.err = err
	return err
}

// Read reads the current entry's payload, returning io.EOF at its end.
func (r *Reader) Read(p []byte) (int, error) {
	if r.err != nil {
		return 0, r.err
	}
	if r.left < 0 {
		return 0, io.EOF
	}
	for r.left == 0 {
		var hdr [4]byte
		if _, err := io.ReadFull(r.r, hdr[:]); err != nil {
			if errors.Is(err, io.EOF) {
				err = io.ErrUnexpectedEOF
			}
			return 0, r.fail(err)
		}
		n := binary.BigEndian.Uint32(hdr[:])
		if n == 0 {
			r.left = -1
			return 0, io.EOF
		}
		if n > MaxChunkBytes {
			return 0, r.fail(ErrBadChunk)
		}
		r.left = int64(n)
	}
	if int64(len(p)) > r.left {
		p = p[:r.left]
	}
	n, err := r.r.Read(p)
	r.left -= int64(n)
	if errors.Is(err, io.EOF) {
		if r.left > 0 {
			return n, r.fail(io.ErrUnexpectedEOF)
		}
		err = nil
	}
	if err != nil {
		return n, r.fail(err)
	}
	return n, nil
}
