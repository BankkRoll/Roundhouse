package dbquery

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"strconv"
)

// RESP2 reply kinds.
const (
	respSimple  = '+'
	respError   = '-'
	respInteger = ':'
	respBulk    = '$'
	respArray   = '*'
)

// respValue is one decoded RESP2 reply.
type respValue struct {
	kind byte
	// str holds simple strings, errors and bulk strings.
	str []byte
	num int64
	arr []respValue
	// null is a null bulk string or array.
	null bool
}

// respLimits bound what one reply may make the client allocate.
type respLimits struct {
	// maxLine is the longest simple string, error or length line.
	maxLine int
	// maxBulk is the largest bulk string.
	maxBulk int
	// maxArray is the most elements one array may declare.
	maxArray int
	// maxDepth is how deeply arrays may nest.
	maxDepth int
	// maxTotal is the reply's total budget in bytes, counting a fixed
	// overhead per array element.
	maxTotal int
}

var defaultRESPLimits = respLimits{
	maxLine:  64 << 10,
	maxBulk:  8 << 20,
	maxArray: 1 << 20,
	maxDepth: 16,
	maxTotal: 32 << 20,
}

const (
	respElementOverhead = 64
	respPrealloc        = 1024
)

// errRESPTooLarge is a reply over the client's limits.
var errRESPTooLarge = errors.New("reply too large")

// respProtocolError is a malformed reply.
type respProtocolError string

func (e respProtocolError) Error() string { return "invalid reply from the server: " + string(e) }

// respReader decodes RESP2 replies within limits.
type respReader struct {
	br     *bufio.Reader
	limits respLimits
	used   int
}

func newRESPReader(r io.Reader, limits respLimits) *respReader {
	return &respReader{br: bufio.NewReaderSize(r, limits.maxLine+2), limits: limits}
}

// read decodes the next reply.
func (r *respReader) read() (respValue, error) {
	r.used = 0
	return r.value(0)
}

func (r *respReader) charge(n int) error {
	if n < 0 || r.used > r.limits.maxTotal-n {
		return errRESPTooLarge
	}
	r.used += n
	return nil
}

func (r *respReader) line() ([]byte, error) {
	b, err := r.br.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) {
		return nil, respProtocolError("line too long")
	}
	if err != nil {
		return nil, err
	}
	if len(b) < 3 || b[len(b)-2] != '\r' {
		return nil, respProtocolError("bad line")
	}
	if err := r.charge(len(b)); err != nil {
		return nil, err
	}
	return b[:len(b)-2], nil
}

// respInt parses a RESP integer strictly: optional minus, then digits.
func respInt(b []byte) (int64, error) {
	if len(b) == 0 || len(b) > 20 {
		return 0, respProtocolError("bad integer")
	}
	for i, c := range b {
		if (c < '0' || c > '9') && (i != 0 || c != '-' || len(b) == 1) {
			return 0, respProtocolError("bad integer")
		}
	}
	n, err := strconv.ParseInt(string(b), 10, 64)
	if err != nil {
		return 0, respProtocolError("bad integer")
	}
	return n, nil
}

func (r *respReader) value(depth int) (respValue, error) {
	line, err := r.line()
	if err != nil {
		return respValue{}, err
	}
	kind, rest := line[0], line[1:]
	switch kind {
	case respSimple, respError:
		return respValue{kind: kind, str: bytes.Clone(rest)}, nil
	case respInteger:
		n, err := respInt(rest)
		return respValue{kind: kind, num: n}, err
	case respBulk:
		n, err := respInt(rest)
		if err != nil {
			return respValue{}, err
		}
		if n == -1 {
			return respValue{kind: kind, null: true}, nil
		}
		if n < 0 {
			return respValue{}, respProtocolError("bad bulk length")
		}
		if n > int64(r.limits.maxBulk) {
			return respValue{}, errRESPTooLarge
		}
		if err := r.charge(int(n) + 2); err != nil {
			return respValue{}, err
		}
		buf := make([]byte, n+2)
		if _, err := io.ReadFull(r.br, buf); err != nil {
			return respValue{}, err
		}
		if buf[n] != '\r' || buf[n+1] != '\n' {
			return respValue{}, respProtocolError("bad bulk terminator")
		}
		return respValue{kind: kind, str: buf[:n:n]}, nil
	case respArray:
		n, err := respInt(rest)
		if err != nil {
			return respValue{}, err
		}
		if n == -1 {
			return respValue{kind: kind, null: true}, nil
		}
		if n < 0 {
			return respValue{}, respProtocolError("bad array length")
		}
		if n > int64(r.limits.maxArray) {
			return respValue{}, errRESPTooLarge
		}
		if depth >= r.limits.maxDepth {
			return respValue{}, respProtocolError("arrays nested too deeply")
		}
		arr := make([]respValue, 0, min(int(n), respPrealloc))
		for range n {
			if err := r.charge(respElementOverhead); err != nil {
				return respValue{}, err
			}
			v, err := r.value(depth + 1)
			if err != nil {
				return respValue{}, err
			}
			arr = append(arr, v)
		}
		return respValue{kind: kind, arr: arr}, nil
	}
	return respValue{}, respProtocolError(fmt.Sprintf("unknown type %q", kind))
}

// appendRESPCommand appends args as a RESP array of bulk strings.
func appendRESPCommand(buf []byte, args []string) []byte {
	buf = append(buf, respArray)
	buf = strconv.AppendInt(buf, int64(len(args)), 10)
	buf = append(buf, '\r', '\n')
	for _, a := range args {
		buf = append(buf, respBulk)
		buf = strconv.AppendInt(buf, int64(len(a)), 10)
		buf = append(buf, '\r', '\n')
		buf = append(buf, a...)
		buf = append(buf, '\r', '\n')
	}
	return buf
}

// json turns a reply into a JSON value: bulk strings as text (or base64
// when not UTF-8), integers as strings, arrays as arrays.
func (v respValue) json() any {
	if v.null {
		return nil
	}
	switch v.kind {
	case respSimple, respError:
		return string(v.str)
	case respBulk:
		return text(v.str)
	case respInteger:
		return strconv.FormatInt(v.num, 10)
	case respArray:
		out := make([]any, len(v.arr))
		for i, e := range v.arr {
			out[i] = e.json()
		}
		return out
	}
	return nil
}

// string returns a string-like reply's text.
func (v respValue) string() string {
	if v.kind == respInteger {
		return strconv.FormatInt(v.num, 10)
	}
	return string(v.str)
}
