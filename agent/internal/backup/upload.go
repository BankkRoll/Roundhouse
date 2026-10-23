package backup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// ErrTooLarge fails a backup whose stream would need more than
// [protocol.MaxBackupParts] parts.
var ErrTooLarge = errors.New("backup_too_large: the stream needs more than 10000 parts at this part size")

// memoryPartLimit is the largest part buffered in memory; larger parts are
// spooled to a scratch file so two in flight plus one filling stay cheap.
const memoryPartLimit = 64 << 20

// Upload retry policy for one part.
const (
	partAttempts   = 4
	partRetryDelay = time.Second
)

// partStore holds one part's bytes until its PUT finishes.
type partStore interface {
	io.Writer
	// reader returns the part's bytes from the start.
	reader() (io.ReadSeeker, error)
	size() int64
	release()
}

type memPart struct{ buf bytes.Buffer }

func (p *memPart) Write(b []byte) (int, error)    { return p.buf.Write(b) }
func (p *memPart) reader() (io.ReadSeeker, error) { return bytes.NewReader(p.buf.Bytes()), nil }
func (p *memPart) size() int64                    { return int64(p.buf.Len()) }
func (p *memPart) release()                       { p.buf = bytes.Buffer{} }

type filePart struct {
	f *os.File
	n int64
}

func (p *filePart) Write(b []byte) (int, error) {
	n, err := p.f.Write(b)
	p.n += int64(n)
	return n, err
}
func (p *filePart) reader() (io.ReadSeeker, error) {
	return io.NewSectionReader(p.f, 0, p.n), nil
}
func (p *filePart) size() int64 { return p.n }
func (p *filePart) release() {
	name := p.f.Name()
	p.f.Close()
	os.Remove(name)
}

// urlSource hands out presigned part URLs, asking the control plane for
// more when it runs low.
type urlSource interface {
	url(ctx context.Context, part int) (string, error)
}

// uploader is the tail of the pipeline: an io.Writer that cuts the
// encrypted stream into parts of exactly partSize bytes (the last one
// shorter), PUTs them two at a time and reports each one's ETag.
//
// It also hashes and counts every stored byte, for backup_result.
type uploader struct {
	ctx      context.Context
	cancel   context.CancelCauseFunc
	partSize int64
	urls     urlSource
	client   *http.Client
	scratch  string
	// done receives every uploaded part, in completion order.
	done func(protocol.UploadedPart)

	sum    hash.Hash
	stored int64
	cur    partStore
	next   int // number of the part being filled
	sem    chan struct{}
	wg     sync.WaitGroup

	mu  sync.Mutex
	err error
}

func newUploader(ctx context.Context, partSize int64, urls urlSource, client *http.Client, scratch string,
	done func(protocol.UploadedPart)) *uploader {
	ctx, cancel := context.WithCancelCause(ctx)
	return &uploader{
		ctx: ctx, cancel: cancel, partSize: partSize, urls: urls, client: client, scratch: scratch, done: done,
		sum: sha256.New(), next: 1, sem: make(chan struct{}, 2),
	}
}

func (u *uploader) failure() error {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.err
}

func (u *uploader) fail(err error) {
	u.mu.Lock()
	if u.err == nil {
		u.err = err
	}
	u.mu.Unlock()
	u.cancel(err)
}

func (u *uploader) newPart() (partStore, error) {
	if u.partSize <= memoryPartLimit || u.scratch == "" {
		return &memPart{}, nil
	}
	f, err := os.CreateTemp(u.scratch, "part-*")
	if err != nil {
		return nil, err
	}
	return &filePart{f: f}, nil
}

// Write implements io.Writer.
func (u *uploader) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		if err := u.failure(); err != nil {
			return written, err
		}
		if u.cur == nil {
			if u.next > protocol.MaxBackupParts {
				u.fail(ErrTooLarge)
				return written, ErrTooLarge
			}
			part, err := u.newPart()
			if err != nil {
				return written, err
			}
			u.cur = part
		}
		room := u.partSize - u.cur.size()
		chunk := p[:min(int64(len(p)), room)]
		if _, err := u.cur.Write(chunk); err != nil {
			return written, err
		}
		u.sum.Write(chunk)
		u.stored += int64(len(chunk))
		written += len(chunk)
		p = p[len(chunk):]
		if u.cur.size() == u.partSize {
			if err := u.ship(); err != nil {
				return written, err
			}
		}
	}
	return written, nil
}

// ship hands the filled part to an upload slot, waiting for one.
func (u *uploader) ship() error {
	part, number := u.cur, u.next
	u.cur = nil
	u.next++
	select {
	case u.sem <- struct{}{}:
	case <-u.ctx.Done():
		part.release()
		return context.Cause(u.ctx)
	}
	u.wg.Add(1)
	go func() {
		defer func() {
			part.release()
			<-u.sem
			u.wg.Done()
		}()
		etag, err := u.put(number, part)
		if err != nil {
			u.fail(fmt.Errorf("part %d: %w", number, err))
			return
		}
		u.done(protocol.UploadedPart{PartNumber: number, ETag: etag, Size: part.size()})
	}()
	return nil
}

// Close uploads the final part and waits for every upload. It returns the
// number of parts.
func (u *uploader) Close() (int, error) {
	if u.failure() == nil && (u.cur != nil && u.cur.size() > 0 || u.next == 1) {
		if u.cur == nil {
			u.cur = &memPart{}
		}
		if err := u.ship(); err != nil {
			u.fail(err)
		}
	} else if u.cur != nil {
		u.cur.release()
		u.cur = nil
	}
	u.wg.Wait()
	if err := u.failure(); err != nil {
		return 0, err
	}
	return u.next - 1, nil
}

// digest is the hex SHA-256 of the stored bytes.
func (u *uploader) digest() string { return hex.EncodeToString(u.sum.Sum(nil)) }

// put uploads one part, retrying transient failures with a fresh request
// each time, and returns its ETag.
func (u *uploader) put(number int, part partStore) (string, error) {
	var last error
	for attempt := range partAttempts {
		if attempt > 0 && !sleepCtx(u.ctx, partRetryDelay<<(attempt-1)) {
			return "", context.Cause(u.ctx)
		}
		url, err := u.urls.url(u.ctx, number)
		if err != nil {
			return "", err
		}
		body, err := part.reader()
		if err != nil {
			return "", err
		}
		etag, retry, err := u.putOnce(url, body, part.size())
		if err == nil {
			return etag, nil
		}
		last = err
		if !retry || u.ctx.Err() != nil {
			break
		}
	}
	return "", last
}

func (u *uploader) putOnce(url string, body io.ReadSeeker, size int64) (etag string, retry bool, err error) {
	req, err := http.NewRequestWithContext(u.ctx, http.MethodPut, url, body)
	if err != nil {
		return "", false, errors.New("PUT: invalid URL")
	}
	req.ContentLength = size
	req.GetBody = func() (io.ReadCloser, error) {
		_, err := body.Seek(0, io.SeekStart)
		return io.NopCloser(body), err
	}
	resp, err := u.client.Do(req)
	if err != nil {
		// SECURITY: the presigned URL is a bearer credential; a *url.Error
		// would print it.
		return "", true, errors.New("PUT failed: " + redactURLError(err))
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode/100 != 2 {
		return "", resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests,
			fmt.Errorf("PUT answered HTTP %d", resp.StatusCode)
	}
	etag = resp.Header.Get("ETag")
	if etag == "" || len(etag) > 256 {
		return "", false, errors.New("PUT answered without a usable ETag")
	}
	for i := 0; i < len(etag); i++ {
		if etag[i] < 0x21 || etag[i] > 0x7e {
			return "", false, errors.New("PUT answered without a usable ETag")
		}
	}
	return etag, false, nil
}

// redactURLError drops the URL from a transport error.
func redactURLError(err error) string {
	var ue interface{ Unwrap() error }
	if errors.As(err, &ue) {
		if inner := ue.Unwrap(); inner != nil {
			return inner.Error()
		}
	}
	return "request error"
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// partURLs is the URL book of one backup: URLs the job and backup_parts
// frames delivered, and the requests for more.
type partURLs struct {
	request func(ctx context.Context, from, count int) error
	// refill is how many URLs ahead of the part being uploaded the book
	// asks for more.
	refill int

	mu        sync.Mutex
	urls      map[int]string
	highest   int
	requested int // highest part number asked for
	arrived   chan struct{}
}

func newPartURLs(initial []protocol.BackupPartURL, request func(ctx context.Context, from, count int) error) *partURLs {
	b := &partURLs{request: request, refill: 8, urls: map[int]string{}, arrived: make(chan struct{})}
	b.add(initial)
	return b
}

// add records URLs from a frame. A later URL for the same part replaces the
// earlier one, which may have expired.
func (b *partURLs) add(parts []protocol.BackupPartURL) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, p := range parts {
		b.urls[p.PartNumber] = p.URL
		b.highest = max(b.highest, p.PartNumber)
	}
	b.requested = max(b.requested, b.highest)
	close(b.arrived)
	b.arrived = make(chan struct{})
}

// requestWait bounds the wait for backup_parts before asking again.
const requestWait = 30 * time.Second

func (b *partURLs) url(ctx context.Context, part int) (string, error) {
	for {
		b.mu.Lock()
		u, ok := b.urls[part]
		from := 0
		switch {
		case part > b.requested:
			from = part
		case ok && part+b.refill > b.requested && b.requested < protocol.MaxBackupParts:
			from = b.requested + 1
		}
		count := 0
		if from > 0 {
			count = min(protocol.MaxBackupPartsPerFrame, protocol.MaxBackupParts-from+1)
			b.requested = from + count - 1
		}
		arrived := b.arrived
		b.mu.Unlock()

		wait := requestWait
		if count > 0 {
			if err := b.request(ctx, from, count); err != nil {
				b.mu.Lock()
				b.requested = min(b.requested, from-1)
				b.mu.Unlock()
				// NOTE: usually a dropped connection; ask again once it may
				// be back rather than failing the whole backup.
				wait = 2 * time.Second
			}
		}
		if ok {
			return u, nil
		}
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return "", context.Cause(ctx)
		case <-arrived:
			t.Stop()
		case <-t.C:
			b.mu.Lock()
			// Nothing came: the request or its answer was lost; ask again.
			b.requested = min(b.requested, part-1)
			b.mu.Unlock()
		}
	}
}
