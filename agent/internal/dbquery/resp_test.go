package dbquery

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func readOne(t *testing.T, in string, limits respLimits) (respValue, error) {
	t.Helper()
	return newRESPReader(strings.NewReader(in), limits).read()
}

func TestRESPDecode(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"+OK\r\n", `"OK"`},
		{"+\r\n", `""`},
		{"-ERR bad\r\n", `"ERR bad"`},
		{":42\r\n", `"42"`},
		{":-7\r\n", `"-7"`},
		{"$5\r\nhe\r\no\r\n", `"he\r\no"`},
		{"$0\r\n\r\n", `""`},
		{"$-1\r\n", `null`},
		{"$2\r\n\xff\x00\r\n", `{"$b64":"/wA="}`},
		{"*-1\r\n", `null`},
		{"*0\r\n", `[]`},
		{"*3\r\n:1\r\n$1\r\na\r\n*1\r\n$-1\r\n", `["1","a",[null]]`},
	}
	for _, c := range cases {
		v, err := readOne(t, c.in, defaultRESPLimits)
		if err != nil {
			t.Errorf("%q: %v", c.in, err)
			continue
		}
		got, _ := json.Marshal(v.json())
		if string(got) != c.want {
			t.Errorf("%q → %s, want %s", c.in, got, c.want)
		}
	}
}

func TestRESPErrors(t *testing.T) {
	small := respLimits{maxLine: 32, maxBulk: 8, maxArray: 4, maxDepth: 2, maxTotal: 300}
	cases := []struct {
		in      string
		tooBig  bool
		limited respLimits
	}{
		{"?x\r\n", false, defaultRESPLimits},
		{"+OK\n", false, defaultRESPLimits},
		{":12a\r\n", false, defaultRESPLimits},
		{":-\r\n", false, defaultRESPLimits},
		{":\r\n", false, defaultRESPLimits},
		{":99999999999999999999\r\n", false, defaultRESPLimits},
		{"$-2\r\n", false, defaultRESPLimits},
		{"$3\r\nabcd\r\n", false, defaultRESPLimits},
		{"$3\r\nab", false, defaultRESPLimits},
		{"*-5\r\n", false, defaultRESPLimits},
		{"*2\r\n:1\r\n", false, defaultRESPLimits},
		{"$9\r\n123456789\r\n", true, small},
		{"*5\r\n", true, small},
		{"*1\r\n*1\r\n*1\r\n:1\r\n", false, small},
		{"+" + strings.Repeat("a", 64) + "\r\n", false, small},
		{"*4\r\n$8\r\n12345678\r\n$8\r\n12345678\r\n$8\r\n12345678\r\n$8\r\n12345678\r\n", true, small},
		{"$9999999999\r\n", true, defaultRESPLimits},
		{"*9999999999\r\n", true, defaultRESPLimits},
	}
	for _, c := range cases {
		_, err := readOne(t, c.in, c.limited)
		if err == nil {
			t.Errorf("%q decoded", c.in)
			continue
		}
		if c.tooBig != errors.Is(err, errRESPTooLarge) {
			t.Errorf("%q: %v, want too-large=%v", c.in, err, c.tooBig)
		}
	}
}

func TestRESPEncodeRoundTrip(t *testing.T) {
	args := []string{"SET", "k\r\nx", "", "\x00\xff"}
	buf := appendRESPCommand(nil, args)
	if !bytes.HasPrefix(buf, []byte("*4\r\n$3\r\nSET\r\n")) {
		t.Fatalf("encoding %q", buf)
	}
	v, err := readOne(t, string(buf), defaultRESPLimits)
	if err != nil {
		t.Fatal(err)
	}
	if len(v.arr) != len(args) {
		t.Fatalf("decoded %d args", len(v.arr))
	}
	for i, a := range args {
		if string(v.arr[i].str) != a {
			t.Errorf("arg %d: %q != %q", i, v.arr[i].str, a)
		}
	}
}

func TestRESPSequentialReplies(t *testing.T) {
	r := newRESPReader(strings.NewReader("+a\r\n:1\r\n$1\r\nb\r\n"), defaultRESPLimits)
	for _, want := range []string{"a", "1", "b"} {
		v, err := r.read()
		if err != nil || v.string() != want {
			t.Fatalf("got %q, %v; want %q", v.string(), err, want)
		}
	}
}

func FuzzRESP(f *testing.F) {
	for _, s := range []string{
		"+OK\r\n", "-ERR x\r\n", ":1\r\n", "$3\r\nabc\r\n", "$-1\r\n", "*2\r\n:1\r\n*1\r\n+x\r\n",
		"*1000000\r\n", "$100000000\r\n", "*1\r\n*1\r\n*1\r\n*1\r\n",
	} {
		f.Add([]byte(s))
	}
	limits := respLimits{maxLine: 128, maxBulk: 256, maxArray: 64, maxDepth: 4, maxTotal: 4096}
	f.Fuzz(func(t *testing.T, data []byte) {
		r := newRESPReader(bytes.NewReader(data), limits)
		for range 8 {
			v, err := r.read()
			if err != nil {
				return
			}
			if r.used > limits.maxTotal {
				t.Fatalf("reply used %d bytes over a %d budget", r.used, limits.maxTotal)
			}
			checkRESP(t, v, limits, 0)
			if _, err := json.Marshal(v.json()); err != nil {
				t.Fatal(err)
			}
		}
	})
}

func checkRESP(t *testing.T, v respValue, l respLimits, depth int) {
	if depth > l.maxDepth || len(v.arr) > l.maxArray || len(v.str) > max(l.maxBulk, l.maxLine) {
		t.Fatalf("reply beyond limits: depth %d, %d elements, %d bytes", depth, len(v.arr), len(v.str))
	}
	for _, e := range v.arr {
		checkRESP(t, e, l, depth+1)
	}
}
