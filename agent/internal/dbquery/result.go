package dbquery

import (
	"bytes"
	"database/sql/driver"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

const (
	maxColumnTypeBytes = 128
	maxValueDepth      = 32
)

// resultSet accumulates a result within its row and byte limits.
type resultSet struct {
	cols     []protocol.DBColumn
	rows     [][]any
	maxRows  int
	maxBytes int
	// size is the encoded length of rows as a JSON array.
	size      int
	truncated bool
	// affected, when set, is the row count of a statement without rows.
	affected *int64
	notices  []string
}

func newResultSet(maxRows, maxBytes int) *resultSet {
	return &resultSet{cols: []protocol.DBColumn{}, rows: [][]any{}, maxRows: maxRows, maxBytes: maxBytes, size: 2}
}

// setColumns sets the result's columns, clipping names and type names to
// the protocol's limits.
func (s *resultSet) setColumns(cols []protocol.DBColumn) error {
	if len(cols) > protocol.MaxDBColumns {
		return usageError(fmt.Sprintf("result has %d columns; at most %d are supported", len(cols), protocol.MaxDBColumns))
	}
	s.cols = make([]protocol.DBColumn, len(cols))
	for i, c := range cols {
		s.cols[i] = protocol.DBColumn{
			Name: clip(c.Name, protocol.MaxDBIdentifierBytes),
			Type: clip(strings.ToLower(c.Type), maxColumnTypeBytes),
		}
	}
	return nil
}

// columns is a shorthand for untyped column lists.
func columns(names ...string) []protocol.DBColumn {
	out := make([]protocol.DBColumn, len(names))
	for i, n := range names {
		name, typ, _ := strings.Cut(n, ":")
		out[i] = protocol.DBColumn{Name: name, Type: typ}
	}
	return out
}

// add normalizes and appends row. It returns false once the result is
// full; the row that did not fit is dropped and truncated is set, so
// callers stop reading.
func (s *resultSet) add(row []any) bool {
	if len(s.rows) >= s.maxRows {
		s.truncated = true
		return false
	}
	for i, v := range row {
		row[i] = normalize(v)
	}
	n := encodedLen(row)
	if len(s.rows) > 0 {
		n++
	}
	if s.size+n > s.maxBytes {
		s.truncated = true
		s.notice(fmt.Sprintf("result truncated at %d bytes", s.maxBytes))
		return false
	}
	s.size += n
	s.rows = append(s.rows, row)
	return true
}

func (s *resultSet) notice(msg string) {
	for _, n := range s.notices {
		if n == msg {
			return
		}
	}
	s.notices = append(s.notices, msg)
}

func (s *resultSet) fill(res *protocol.DBQueryResult) {
	res.OK = true
	cols, rows := s.cols, s.rows
	res.Columns, res.Rows = &cols, &rows
	count := int64(len(s.rows))
	if s.affected != nil && len(s.cols) == 0 {
		count = *s.affected
	}
	res.RowCount = &count
	if s.truncated {
		t := true
		res.Truncated = &t
	}
	res.Notice = strings.Join(s.notices, "; ")
}

// encodedLen is the length of v as JSON.stringify writes it.
func encodedLen(v any) int {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return math.MaxInt32
	}
	return buf.Len() - 1
}

// b64 is how binary values travel.
func b64(b []byte) map[string]any {
	return map[string]any{"$b64": base64.StdEncoding.EncodeToString(b)}
}

// text returns b as a string when it is valid UTF-8, and as binary
// otherwise.
func text(b []byte) any {
	if utf8.Valid(b) {
		return string(b)
	}
	return b64(b)
}

// normalize turns a driver value into a JSON value: 64-bit integers and
// non-finite floats become strings, bytes become {"$b64": …}, times become
// RFC 3339, and anything unfamiliar becomes its text form.
func normalize(v any) any { return normalizeDepth(v, 0) }

func normalizeDepth(v any, depth int) any {
	if depth > maxValueDepth {
		return "…"
	}
	switch x := v.(type) {
	case nil, bool, int8, int16, int32, uint8, uint16, uint32:
		return x
	case map[string]any:
		if isB64(x) {
			return x
		}
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = normalizeDepth(e, depth+1)
		}
		return out
	case string:
		if utf8.ValidString(x) {
			return x
		}
		return b64([]byte(x))
	case []byte:
		return b64(x)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case uint:
		return strconv.FormatUint(uint64(x), 10)
	case uint64:
		return strconv.FormatUint(x, 10)
	case float32:
		return finite(float64(x), 32)
	case float64:
		return finite(x, 64)
	case time.Time:
		return x.Format(time.RFC3339Nano)
	case time.Duration:
		return x.String()
	case json.Number:
		return x.String()
	case json.RawMessage:
		return string(x)
	case [16]byte:
		return formatUUID(x)
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = normalizeDepth(e, depth+1)
		}
		return out
	case driver.Valuer:
		dv, err := x.Value()
		if err != nil {
			return fmt.Sprint(x)
		}
		if reflect.TypeOf(dv) == reflect.TypeOf(v) {
			return fmt.Sprint(dv)
		}
		return normalizeDepth(dv, depth+1)
	case fmt.Stringer:
		return x.String()
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Pointer:
		if rv.IsNil() {
			return nil
		}
		return normalizeDepth(rv.Elem().Interface(), depth+1)
	case reflect.Slice, reflect.Array:
		out := make([]any, rv.Len())
		for i := range out {
			out[i] = normalizeDepth(rv.Index(i).Interface(), depth+1)
		}
		return out
	case reflect.Map:
		if rv.Type().Key().Kind() != reflect.String {
			break
		}
		out := make(map[string]any, rv.Len())
		for it := rv.MapRange(); it.Next(); {
			out[it.Key().String()] = normalizeDepth(it.Value().Interface(), depth+1)
		}
		return out
	case reflect.String:
		return normalizeDepth(rv.String(), depth+1)
	case reflect.Bool:
		return rv.Bool()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return normalizeDepth(rv.Int(), depth+1)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return normalizeDepth(rv.Uint(), depth+1)
	case reflect.Float32, reflect.Float64:
		return finite(rv.Float(), 64)
	}
	return fmt.Sprint(v)
}

func isB64(m map[string]any) bool {
	if len(m) != 1 {
		return false
	}
	_, ok := m["$b64"].(string)
	return ok
}

// finite returns f, or its text when JSON cannot carry it.
func finite(f float64, bits int) any {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return strconv.FormatFloat(f, 'g', -1, bits)
	}
	if bits == 32 {
		// NOTE: widening float32(0.1) gives 0.10000000149011612; going
		// through its shortest text keeps it 0.1.
		g, _ := strconv.ParseFloat(strconv.FormatFloat(f, 'g', -1, 32), 64)
		return g
	}
	return f
}

func formatUUID(u [16]byte) string {
	var buf [36]byte
	hex.Encode(buf[0:8], u[0:4])
	buf[8] = '-'
	hex.Encode(buf[9:13], u[4:6])
	buf[13] = '-'
	hex.Encode(buf[14:18], u[6:8])
	buf[18] = '-'
	hex.Encode(buf[19:23], u[8:10])
	buf[23] = '-'
	hex.Encode(buf[24:], u[10:])
	return string(buf[:])
}
