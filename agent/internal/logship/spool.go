package logship

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/BankkRoll/Open-Rail/agent/internal/atomicfile"
)

// spool is a bounded, persistent FIFO of records: the ring buffer that holds
// log frames while the agent is disconnected.
//
// Records are appended to numbered segment files as
// [uint32 length][uint32 CRC-32C][payload]. When the total size exceeds the
// bound, whole segments are dropped from the head, oldest first, so the
// newest logs survive a long outage. The read position is persisted in a
// small cursor file, so frames already sent are not replayed after an agent
// restart. A torn record at the end of a segment (a crash mid-append) ends
// that segment; nothing after it in the segment is trusted.
//
// spool is not safe for concurrent use.
type spool struct {
	dir      string
	maxBytes int64
	segBytes int64

	segs []segment
	// read position: segment number and byte offset within it.
	rseg int64
	roff int64
}

type segment struct {
	n    int64
	size int64
}

const (
	recordHeader = 8
	segPrefix    = "seg-"
	segSuffix    = ".log"
	cursorFile   = "cursor"
	// maxRecord bounds a record's payload, rejecting corrupt lengths.
	maxRecord = 16 << 20
)

var crcTable = crc32.MakeTable(crc32.Castagnoli)

// openSpool opens or creates a spool in dir holding at most maxBytes.
func openSpool(dir string, maxBytes int64) (*spool, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &spool{dir: dir, maxBytes: maxBytes, segBytes: max(maxBytes/16, 64<<10)}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, segPrefix) || !strings.HasSuffix(name, segSuffix) {
			continue
		}
		n, err := strconv.ParseInt(strings.TrimSuffix(strings.TrimPrefix(name, segPrefix), segSuffix), 10, 64)
		if err != nil {
			continue
		}
		info, err := e.Info()
		if err != nil {
			return nil, err
		}
		s.segs = append(s.segs, segment{n: n, size: info.Size()})
	}
	slices.SortFunc(s.segs, func(a, b segment) int { return int(a.n - b.n) })
	s.loadCursor()
	return s, nil
}

func (s *spool) segPath(n int64) string {
	return filepath.Join(s.dir, fmt.Sprintf("%s%016d%s", segPrefix, n, segSuffix))
}

// loadCursor restores the read position, falling back to the oldest
// segment's start if the cursor is missing or points nowhere.
func (s *spool) loadCursor() {
	if len(s.segs) == 0 {
		return
	}
	s.rseg, s.roff = s.segs[0].n, 0
	data, err := os.ReadFile(filepath.Join(s.dir, cursorFile))
	if err != nil {
		return
	}
	var n, off int64
	if _, err := fmt.Sscanf(string(data), "%d %d", &n, &off); err != nil {
		return
	}
	for _, seg := range s.segs {
		if seg.n == n && off >= 0 && off <= seg.size {
			s.rseg, s.roff = n, off
			return
		}
	}
}

func (s *spool) saveCursor() error {
	return atomicfile.Write(filepath.Join(s.dir, cursorFile), fmt.Appendf(nil, "%d %d\n", s.rseg, s.roff), 0o600)
}

// size is the bytes on disk across all segments.
func (s *spool) size() int64 {
	var total int64
	for _, seg := range s.segs {
		total += seg.size
	}
	return total
}

// empty reports whether no unread record remains.
func (s *spool) empty() bool {
	if len(s.segs) == 0 {
		return true
	}
	last := s.segs[len(s.segs)-1]
	return s.rseg == last.n && s.roff >= last.size
}

// append adds a record and returns how many bytes of old records it dropped
// to stay within the bound.
func (s *spool) append(payload []byte) (dropped int64, err error) {
	if len(payload) > maxRecord {
		return 0, fmt.Errorf("spool: record of %d bytes exceeds %d", len(payload), maxRecord)
	}
	rec := make([]byte, recordHeader+len(payload))
	binary.BigEndian.PutUint32(rec[0:], uint32(len(payload)))
	binary.BigEndian.PutUint32(rec[4:], crc32.Checksum(payload, crcTable))
	copy(rec[recordHeader:], payload)

	if len(s.segs) == 0 || s.segs[len(s.segs)-1].size+int64(len(rec)) > s.segBytes {
		n := int64(1)
		if len(s.segs) > 0 {
			n = s.segs[len(s.segs)-1].n + 1
		}
		if len(s.segs) == 0 || s.empty() {
			// Start reading at the new segment; any older ones are spent.
			s.rseg, s.roff = n, 0
		}
		s.segs = append(s.segs, segment{n: n})
	}
	last := &s.segs[len(s.segs)-1]
	f, err := os.OpenFile(s.segPath(last.n), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return 0, err
	}
	_, err = f.Write(rec)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return 0, err
	}
	last.size += int64(len(rec))
	dropped = s.enforceBound()
	s.removeSpent()
	return dropped, nil
}

// enforceBound drops the oldest segments until the spool fits, never the
// one being written.
func (s *spool) enforceBound() int64 {
	var dropped int64
	for len(s.segs) > 1 && s.size() > s.maxBytes {
		head := s.segs[0]
		if head.n == s.rseg {
			dropped += head.size - s.roff
			s.rseg, s.roff = s.segs[1].n, 0
		} else if head.n > s.rseg {
			dropped += head.size
		}
		_ = os.Remove(s.segPath(head.n))
		s.segs = s.segs[1:]
	}
	if dropped > 0 {
		_ = s.saveCursor()
	}
	return dropped
}

// removeSpent deletes fully read segments other than the last.
func (s *spool) removeSpent() {
	for len(s.segs) > 1 && s.segs[0].n < s.rseg {
		_ = os.Remove(s.segPath(s.segs[0].n))
		s.segs = s.segs[1:]
	}
}

// peek returns the oldest unread record, or nil if there is none. It skips
// past torn or corrupt data.
func (s *spool) peek() ([]byte, error) {
	for !s.empty() {
		idx := slices.IndexFunc(s.segs, func(seg segment) bool { return seg.n == s.rseg })
		if idx < 0 {
			s.rseg, s.roff = s.segs[0].n, 0
			continue
		}
		seg := s.segs[idx]
		if s.roff >= seg.size {
			s.advanceSegment(idx)
			continue
		}
		rec, err := s.readAt(seg.n, s.roff, seg.size)
		if errors.Is(err, errCorrupt) {
			// Trust nothing after a bad record in this segment.
			if idx == len(s.segs)-1 {
				s.roff = seg.size
				return nil, nil
			}
			s.advanceSegment(idx)
			continue
		}
		return rec, err
	}
	return nil, nil
}

var errCorrupt = errors.New("spool: corrupt record")

func (s *spool) readAt(n, off, size int64) ([]byte, error) {
	f, err := os.Open(s.segPath(n))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, errCorrupt
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var hdr [recordHeader]byte
	if _, err := f.ReadAt(hdr[:], off); err != nil {
		return nil, errCorrupt
	}
	length := int64(binary.BigEndian.Uint32(hdr[0:]))
	if length > maxRecord || off+recordHeader+length > size {
		return nil, errCorrupt
	}
	payload := make([]byte, length)
	if _, err := f.ReadAt(payload, off+recordHeader); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if crc32.Checksum(payload, crcTable) != binary.BigEndian.Uint32(hdr[4:]) {
		return nil, errCorrupt
	}
	return payload, nil
}

func (s *spool) advanceSegment(idx int) {
	if idx+1 < len(s.segs) {
		s.rseg, s.roff = s.segs[idx+1].n, 0
	} else {
		s.roff = s.segs[idx].size
	}
	s.removeSpent()
}

// pop consumes the record peek returned and persists the read position.
func (s *spool) pop(rec []byte) error {
	s.roff += recordHeader + int64(len(rec))
	if s.empty() {
		// Everything is sent: start over, keeping the directory small.
		for _, seg := range s.segs {
			_ = os.Remove(s.segPath(seg.n))
		}
		next := s.segs[len(s.segs)-1].n + 1
		s.segs = nil
		s.rseg, s.roff = next, 0
		_ = os.Remove(filepath.Join(s.dir, cursorFile))
		return nil
	}
	s.removeSpent()
	return s.saveCursor()
}
