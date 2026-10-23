package backup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// memTransport stores PUT bodies by part number.
type memTransport struct {
	mu    sync.Mutex
	parts map[int][]byte
	fail  map[int]int // part → failures left
}

func (m *memTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	n, _ := strconv.Atoi(r.URL.Query().Get("partNumber"))
	body, _ := io.ReadAll(r.Body)
	m.mu.Lock()
	defer m.mu.Unlock()
	resp := &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("")), Request: r}
	if m.fail[n] > 0 {
		m.fail[n]--
		resp.StatusCode = 503
		return resp, nil
	}
	if m.parts == nil {
		m.parts = map[int][]byte{}
	}
	m.parts[n] = body
	resp.Header.Set("ETag", `"p`+strconv.Itoa(n)+`"`)
	return resp, nil
}

// staticURLs gives every part a URL.
type staticURLs struct{}

func (staticURLs) url(_ context.Context, part int) (string, error) {
	return "https://s3.test/b/k?partNumber=" + strconv.Itoa(part), nil
}

func runUploader(t *testing.T, tr *memTransport, partSize int64, writes [][]byte) (*uploader, []protocol.UploadedPart, int, error) {
	t.Helper()
	var mu sync.Mutex
	var done []protocol.UploadedPart
	u := newUploader(context.Background(), partSize, staticURLs{}, &http.Client{Transport: tr}, t.TempDir(),
		func(p protocol.UploadedPart) {
			mu.Lock()
			done = append(done, p)
			mu.Unlock()
		})
	for _, w := range writes {
		if _, err := u.Write(w); err != nil {
			n, cerr := u.Close()
			return u, done, n, errors.Join(err, cerr)
		}
	}
	n, err := u.Close()
	return u, done, n, err
}

func TestSplitterCutsEqualPartsAndAShortLast(t *testing.T) {
	for _, tc := range []struct {
		name  string
		total int
		want  []int
	}{
		{"exact multiple", 30, []int{10, 10, 10}},
		{"short last", 25, []int{10, 10, 5}},
		{"one short part", 3, []int{3}},
		{"empty stream", 0, []int{0}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := bytes.Repeat([]byte("abcdefg"), tc.total/7+1)[:tc.total]
			// Odd write sizes cross part boundaries.
			var writes [][]byte
			for rest := data; len(rest) > 0; {
				n := min(len(rest), 7)
				writes = append(writes, rest[:n])
				rest = rest[n:]
			}
			tr := &memTransport{}
			u, done, n, err := runUploader(t, tr, 10, writes)
			if err != nil {
				t.Fatal(err)
			}
			if n != len(tc.want) || len(done) != n {
				t.Fatalf("%d parts, %d reported; want %d", n, len(done), len(tc.want))
			}
			var joined []byte
			for i, size := range tc.want {
				p := tr.parts[i+1]
				if len(p) != size {
					t.Fatalf("part %d has %d bytes, want %d", i+1, len(p), size)
				}
				joined = append(joined, p...)
			}
			if !bytes.Equal(joined, data) {
				t.Fatal("parts do not reassemble the stream")
			}
			sum := sha256.Sum256(data)
			if u.digest() != hex.EncodeToString(sum[:]) || u.stored != int64(len(data)) {
				t.Fatalf("digest %s stored %d", u.digest(), u.stored)
			}
			for _, p := range done {
				if p.ETag != `"p`+strconv.Itoa(p.PartNumber)+`"` || p.Size != int64(len(tr.parts[p.PartNumber])) {
					t.Fatalf("reported %+v", p)
				}
			}
		})
	}
}

func TestSplitterRetriesTransientFailures(t *testing.T) {
	tr := &memTransport{fail: map[int]int{2: 2}}
	_, done, n, err := runUploader(t, tr, 4, [][]byte{[]byte("0123456789")})
	if err != nil || n != 3 || len(done) != 3 {
		t.Fatalf("n %d done %d err %v", n, len(done), err)
	}
}

func TestSplitterFailsAfterRetries(t *testing.T) {
	tr := &memTransport{fail: map[int]int{1: partAttempts}}
	_, _, _, err := runUploader(t, tr, 4, [][]byte{[]byte("0123")})
	if err == nil || !strings.Contains(err.Error(), "HTTP 503") {
		t.Fatalf("err %v", err)
	}
}

func TestSplitterRefusesMoreThanTheMaximumParts(t *testing.T) {
	tr := &memTransport{}
	data := make([]byte, protocol.MaxBackupParts+1)
	_, _, _, err := runUploader(t, tr, 1, [][]byte{data})
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err %v", err)
	}
	if !strings.HasPrefix(ErrTooLarge.Error(), "backup_too_large") {
		t.Fatal("error does not lead with backup_too_large")
	}
}

func TestSplitterSpoolsLargePartsToDisk(t *testing.T) {
	u := newUploader(context.Background(), memoryPartLimit+protocol.BackupPartAlignBytes, staticURLs{}, http.DefaultClient,
		t.TempDir(), func(protocol.UploadedPart) {})
	p, err := u.newPart()
	if err != nil {
		t.Fatal(err)
	}
	defer p.release()
	if _, ok := p.(*filePart); !ok {
		t.Fatalf("part store %T", p)
	}
}

func TestPartURLsAskAheadAndWaitForAnswers(t *testing.T) {
	var mu sync.Mutex
	var asked [][2]int
	var book *partURLs
	book = newPartURLs([]protocol.BackupPartURL{{PartNumber: 1, URL: "https://s3.test/1"}},
		func(_ context.Context, from, count int) error {
			mu.Lock()
			asked = append(asked, [2]int{from, count})
			mu.Unlock()
			go func() {
				var urls []protocol.BackupPartURL
				for n := from; n < from+count; n++ {
					urls = append(urls, protocol.BackupPartURL{PartNumber: n, URL: "https://s3.test/" + strconv.Itoa(n)})
				}
				book.add(urls)
			}()
			return nil
		})
	ctx := context.Background()
	for n := 1; n <= 40; n++ {
		u, err := book.url(ctx, n)
		if err != nil || u != "https://s3.test/"+strconv.Itoa(n) {
			t.Fatalf("part %d: %q %v", n, u, err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(asked) < 2 || asked[0] != [2]int{2, 32} {
		t.Fatalf("requests %v", asked)
	}
	for _, a := range asked {
		if a[1] < 1 || a[1] > protocol.MaxBackupPartsPerFrame {
			t.Fatalf("request %v", a)
		}
	}
}
