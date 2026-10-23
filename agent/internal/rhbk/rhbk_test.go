package rhbk

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"testing"
)

type entry struct {
	h    Header
	data []byte
}

func encode(t testing.TB, entries []entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	w, err := NewWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		ew, err := w.Create(e.h)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ew.Write(e.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func decode(data []byte) ([]entry, error) {
	r, err := NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	var out []entry
	for {
		h, err := r.Next()
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return out, err
		}
		b, err := io.ReadAll(r)
		if err != nil {
			return out, err
		}
		out = append(out, entry{h, b})
	}
}

// TestVector pins the byte layout: magic, header line, one chunk, the
// terminator, an empty entry, and the trailer.
func TestVector(t *testing.T) {
	got := encode(t, []entry{
		{Header{Name: "app.dump", Engine: "postgres", Format: FormatPGCustom, Database: "app"}, []byte("hi")},
		{Header{Name: "empty", Format: FormatSQL}, nil},
	})
	want := "RHBK1\n" +
		`{"name":"app.dump","engine":"postgres","format":"pg_custom","database":"app"}` + "\n" +
		"\x00\x00\x00\x02hi\x00\x00\x00\x00" +
		`{"name":"empty","format":"sql"}` + "\n" +
		"\x00\x00\x00\x00" +
		`{"name":"_end"}` + "\n"
	if string(got) != want {
		t.Fatalf("encoded\n%s\nwant\n%s", hex.Dump(got), hex.Dump([]byte(want)))
	}
	entries, err := decode([]byte(want))
	if err != nil || len(entries) != 2 || string(entries[0].data) != "hi" || entries[0].h.Database != "app" ||
		entries[1].h.Name != "empty" || len(entries[1].data) != 0 {
		t.Fatalf("decoded %+v, %v", entries, err)
	}
}

func TestRoundTripLargeEntries(t *testing.T) {
	big := make([]byte, 3*MaxChunkBytes+12345)
	_, _ = rand.Read(big)
	in := []entry{
		{Header{Name: "globals.sql", Engine: "postgres", Format: FormatPGGlobals}, []byte("CREATE ROLE x;\n")},
		{Header{Name: "big.dump", Engine: "postgres", Format: FormatPGCustom}, big},
		{Header{Name: "volume.tar", Format: FormatTar}, big[:MaxChunkBytes]},
	}
	data := encode(t, in)
	out, err := decode(data)
	if err != nil || len(out) != len(in) {
		t.Fatalf("decoded %d entries, %v", len(out), err)
	}
	for i := range in {
		if out[i].h != in[i].h || !bytes.Equal(out[i].data, in[i].data) {
			t.Fatalf("entry %d differs", i)
		}
	}
}

func TestReaderSkipsUnreadEntries(t *testing.T) {
	data := encode(t, []entry{
		{Header{Name: "a"}, bytes.Repeat([]byte("a"), 300<<10)},
		{Header{Name: "b"}, []byte("bee")},
	})
	r, err := NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if h, err := r.Next(); err != nil || h.Name != "a" {
		t.Fatal(h, err)
	}
	if h, err := r.Next(); err != nil || h.Name != "b" {
		t.Fatal(h, err)
	}
	if b, _ := io.ReadAll(r); string(b) != "bee" {
		t.Fatalf("b = %q", b)
	}
	if _, err := r.Next(); !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
}

func TestReaderRejectsMalformedStreams(t *testing.T) {
	good := encode(t, []entry{{Header{Name: "a"}, []byte("data")}})
	for name, tc := range map[string]struct {
		data []byte
		want error
	}{
		"bad magic":     {[]byte("RHBK2\n"), ErrBadMagic},
		"no trailer":    {good[:len(good)-len(`{"name":"_end"}`)-1], io.ErrUnexpectedEOF},
		"mid chunk":     {good[:len(Magic)+len(`{"name":"a"}`)+1+6], io.ErrUnexpectedEOF},
		"trailing data": {append(bytes.Clone(good), 'x'), ErrTrailingData},
		"huge chunk":    {[]byte(Magic + `{"name":"a"}` + "\n\x00\x10\x00\x01"), ErrBadChunk},
		"bad header":    {[]byte(Magic + "not json\n"), ErrBadHeader},
		"empty name":    {[]byte(Magic + `{"name":""}` + "\n"), ErrBadHeader},
		"long header":   {append([]byte(Magic), bytes.Repeat([]byte("x"), MaxHeaderBytes+1)...), ErrBadHeader},
	} {
		_, err := decode(tc.data)
		if !errors.Is(err, tc.want) {
			t.Errorf("%s: err = %v, want %v", name, err, tc.want)
		}
	}
}

func TestWriterRejectsReservedNames(t *testing.T) {
	w, _ := NewWriter(io.Discard)
	if _, err := w.Create(Header{Name: TrailerName}); !errors.Is(err, ErrBadHeader) {
		t.Fatalf("err = %v", err)
	}
	if _, err := w.Create(Header{}); !errors.Is(err, ErrBadHeader) {
		t.Fatalf("err = %v", err)
	}
}

func TestRawBytes(t *testing.T) {
	var buf bytes.Buffer
	w, _ := NewWriter(&buf)
	e, _ := w.Create(Header{Name: "a"})
	_, _ = e.Write(make([]byte, 1000))
	e, _ = w.Create(Header{Name: "b"})
	_, _ = e.Write(make([]byte, 24))
	_ = w.Close()
	if w.RawBytes() != 1024 {
		t.Fatalf("raw = %d", w.RawBytes())
	}
}

// FuzzReader feeds arbitrary bytes to the reader: it must never panic or
// over-allocate, and anything it accepts must re-encode to the same entries.
func FuzzReader(f *testing.F) {
	f.Add(encode(f, []entry{{Header{Name: "a", Format: FormatTar}, []byte("x")}}))
	f.Add([]byte(Magic + `{"name":"_end"}` + "\n"))
	f.Add([]byte(Magic + `{"name":"a"}` + "\n\x00\x00\x00\x01"))
	f.Fuzz(func(t *testing.T, data []byte) {
		entries, err := decode(data)
		if err != nil {
			return
		}
		again, err := decode(encode(t, entries))
		if err != nil || len(again) != len(entries) {
			t.Fatalf("re-encoded stream: %d entries, %v", len(again), err)
		}
		for i := range entries {
			if again[i].h != entries[i].h || !bytes.Equal(again[i].data, entries[i].data) {
				t.Fatalf("entry %d changed on re-encode", i)
			}
		}
	})
}

// FuzzRoundTrip encodes entries cut from arbitrary data and checks they
// decode unchanged, however the writes are split.
func FuzzRoundTrip(f *testing.F) {
	f.Add([]byte("hello world"), uint16(3), uint8(2))
	f.Fuzz(func(t *testing.T, data []byte, split uint16, n uint8) {
		count := int(n%4) + 1
		var in []entry
		for i := range count {
			lo, hi := len(data)*i/count, len(data)*(i+1)/count
			in = append(in, entry{Header{Name: "e" + string(rune('a'+i))}, data[lo:hi]})
		}
		var buf bytes.Buffer
		w, _ := NewWriter(&buf)
		step := int(split%4096) + 1
		for _, e := range in {
			ew, err := w.Create(e.h)
			if err != nil {
				t.Fatal(err)
			}
			for p := e.data; len(p) > 0; {
				k := min(step, len(p))
				if _, err := ew.Write(p[:k]); err != nil {
					t.Fatal(err)
				}
				p = p[k:]
			}
		}
		if err := w.Close(); err != nil {
			t.Fatal(err)
		}
		out, err := decode(buf.Bytes())
		if err != nil || len(out) != len(in) {
			t.Fatalf("decoded %d, %v", len(out), err)
		}
		for i := range in {
			if !bytes.Equal(out[i].data, in[i].data) {
				t.Fatalf("entry %d differs", i)
			}
		}
	})
}
