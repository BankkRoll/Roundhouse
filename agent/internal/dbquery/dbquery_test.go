package dbquery

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"net"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

func ptr[T any](v T) *T { return &v }

func query(engine, mode string, op protocol.DBOp) *protocol.DBQuery {
	return &protocol.DBQuery{
		Type: protocol.TypeDBQuery, RequestID: "req_1", Engine: protocol.DatabaseEngine(engine),
		Mode: mode, Op: op, MaxRows: 100, MaxBytes: protocol.MaxDBQueryResultBytes, TimeoutMS: 2000,
	}
}

func TestMongoReadCommand(t *testing.T) {
	cases := []struct {
		name, cmd string
		ok        bool
	}{
		{"find", `{"find": "users", "filter": {"age": {"$gt": 3}}}`, true},
		{"aggregate", `{"aggregate": "users", "pipeline": [{"$match": {}}, {"$group": {"_id": "$x"}}], "cursor": {}}`, true},
		{"count", `{"count": "users"}`, true},
		{"distinct", `{"distinct": "users", "key": "x"}`, true},
		{"listCollections", `{"listCollections": 1}`, true},
		{"listDatabases", `{"listDatabases": 1}`, true},
		{"insert", `{"insert": "users", "documents": [{}]}`, false},
		{"drop", `{"drop": "users"}`, false},
		{"findAndModify", `{"findAndModify": "users", "update": {}}`, false},
		{"out", `{"aggregate": "users", "pipeline": [{"$out": "copy"}], "cursor": {}}`, false},
		{"merge", `{"aggregate": "users", "pipeline": [{"$merge": {"into": "copy"}}], "cursor": {}}`, false},
		{"lookup", `{"aggregate": "a", "pipeline": [{"$lookup": {"from": "b", "as": "c", "pipeline": [{"$merge": "x"}]}}], "cursor": {}}`, false},
		{"facet", `{"aggregate": "a", "pipeline": [{"$facet": {"one": [{"$match": {}}], "two": [{"$out": "x"}]}}], "cursor": {}}`, false},
		{"unionWith", `{"aggregate": "a", "pipeline": [{"$unionWith": {"coll": "b", "pipeline": [{"$lookup": {"from": "c", "as": "d", "pipeline": [{"$out": "e"}]}}]}}], "cursor": {}}`, false},
		{"field named like a stage", `{"find": "a", "filter": {"$out": 1}}`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var cmd bson.D
			if err := bson.UnmarshalExtJSON([]byte(c.cmd), false, &cmd); err != nil {
				t.Fatal(err)
			}
			err := checkMongoReadCommand(cmd)
			if c.ok != (err == nil) {
				t.Fatalf("checkMongoReadCommand(%s) = %v, want ok=%v", c.cmd, err, c.ok)
			}
			var ro readOnlyError
			if err != nil && !errors.As(err, &ro) {
				t.Fatalf("error %v is not a read-only error", err)
			}
		})
	}
}

func TestMongoHelpers(t *testing.T) {
	cmd := bson.D{{Key: "find", Value: "a"}, {Key: "batchSize", Value: 5000}}
	cmd = capBatch(cmd, 101)
	if len(cmd) != 2 || cmd[1].Value != int64(101) {
		t.Fatalf("find batch: %v", cmd)
	}
	agg := capBatch(bson.D{{Key: "aggregate", Value: "a"}, {Key: "cursor", Value: bson.D{{Key: "x", Value: 1}}}}, 7)
	cur := agg[1].Value.(bson.D)
	if len(cur) != 2 || cur[1].Key != "batchSize" || cur[1].Value != int64(7) {
		t.Fatalf("aggregate batch: %v", agg)
	}

	oid := bson.NewObjectID()
	raw, err := bson.Marshal(bson.D{
		{Key: "_id", Value: oid},
		{Key: "n", Value: int64(1) << 60},
		{Key: "i", Value: int32(7)},
		{Key: "bin", Value: bson.Binary{Data: []byte{0, 1, 2}}},
		{Key: "at", Value: bson.NewDateTimeFromTime(time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC))},
		{Key: "sub", Value: bson.D{{Key: "x", Value: int64(2)}}},
		{Key: "nan", Value: math.NaN()},
	})
	if err != nil {
		t.Fatal(err)
	}
	set := newResultSet(10, 1<<20)
	if err := addDocs(set, []bson.Raw{raw}, nil); err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(set.rows[0])
	want := `[{"$oid":"` + oid.Hex() + `"},"1152921504606846976",7,{"$b64":"AAEC"},"2026-01-02T03:04:05Z",{"x":"2"},"NaN"]`
	if string(got) != want {
		t.Fatalf("row\n got %s\nwant %s", got, want)
	}
	if set.cols[0].Name != "_id" || set.cols[1].Type != "64-bit integer" {
		t.Fatalf("columns %+v", set.cols)
	}
}

func TestRedisCheckCommand(t *testing.T) {
	cases := []struct {
		argv  []string
		write bool
		want  string // joined argv, or "!" for a refusal
	}{
		{[]string{"get", "k"}, false, "GET k"},
		{[]string{"SET", "k", "v"}, false, "!"},
		{[]string{"FLUSHALL"}, false, "!"},
		{[]string{"EVAL", "return 1", "0"}, false, "!"},
		{[]string{"SCAN", "0"}, false, "SCAN 0 COUNT 11"},
		{[]string{"SCAN", "0", "MATCH", "a*", "count", "99999"}, false, "SCAN 0 MATCH a* count 11"},
		{[]string{"LRANGE", "l", "0", "-1"}, false, "LRANGE l 0 -1"},
		{[]string{"LRANGE", "l", "5", "500"}, false, "LRANGE l 5 15"},
		{[]string{"ZRANGE", "z", "0", "100", "WITHSCORES"}, false, "ZRANGE z 0 10 WITHSCORES"},
		{[]string{"ZRANGE", "z", "0", "+inf", "BYSCORE"}, false, "ZRANGE z 0 +inf BYSCORE LIMIT 0 11"},
		{[]string{"ZRANGE", "z", "0", "+inf", "BYSCORE", "LIMIT", "0", "-1"}, false, "ZRANGE z 0 +inf BYSCORE LIMIT 0 11"},
		{[]string{"XRANGE", "s", "-", "+"}, false, "XRANGE s - + COUNT 11"},
		{[]string{"XRANGE", "s", "-", "+", "COUNT", "5"}, false, "XRANGE s - + COUNT 5"},
		{[]string{"SET", "k", "v"}, true, "SET k v"},
		{[]string{"hello", "3"}, true, "!"},
		{[]string{"SUBSCRIBE", "c"}, true, "!"},
		{[]string{"SHUTDOWN"}, true, "!"},
	}
	for _, c := range cases {
		orig := strings.Join(c.argv, " ")
		got, err := redisCheckCommand(c.argv, c.write, 10)
		if c.want == "!" {
			if err == nil {
				t.Errorf("%v (write=%v) allowed as %v", c.argv, c.write, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%v: %v", c.argv, err)
			continue
		}
		if s := strings.Join(got, " "); s != c.want {
			t.Errorf("%v → %q, want %q", c.argv, s, c.want)
		}
		if strings.Join(c.argv, " ") != orig && !c.write {
			t.Errorf("%v: input argv mutated", c.argv)
		}
	}
	for name := range redisReadCommands {
		if _, err := redisCheckCommand([]string{strings.ToLower(name), "x"}, false, 10); err != nil {
			t.Errorf("%s refused: %v", name, err)
		}
	}
}

func TestQuote(t *testing.T) {
	if got := quotePostgresIdent(`we"ird`); got != `"we""ird"` {
		t.Errorf("postgres ident %s", got)
	}
	if got := quoteMySQLIdent("we`ird"); got != "`we``ird`" {
		t.Errorf("mysql ident %s", got)
	}
	pw := "a'b\\c\x00d\ne\x1a"
	if got := quoteMySQLString(pw, false); got != `'a''b\\c\0d\ne\Z'` {
		t.Errorf("mysql string %s", got)
	}
	if got := quoteMySQLString(pw, true); got != "'a''b\\c\x00d\ne\x1a'" {
		t.Errorf("mysql string (no backslash escapes) %q", got)
	}
	if got := quotePostgresString("it's"); got != `'it''s'` {
		t.Errorf("postgres string %s", got)
	}
	if got := quotePostgresString(`a\'b`); got != `E'a\\''b'` {
		t.Errorf("postgres escape string %s", got)
	}
	op := &protocol.DBOp{Namespace: `s"x`, Table: "t", OrderBy: `c"; DROP`, Descending: ptr(true), Offset: ptr(5)}
	rel, err := pgRelation(op)
	if err != nil {
		t.Fatal(err)
	}
	if got := pgRowsSQL(rel, op); got != `SELECT * FROM "s""x"."t" ORDER BY "c""; DROP" DESC LIMIT $1 OFFSET $2` {
		t.Errorf("pg rows %s", got)
	}
	if got := myRowsSQL("db", op, 11); got != "SELECT * FROM `db`.`t` ORDER BY `c\"; DROP` DESC LIMIT 11 OFFSET 5" {
		t.Errorf("mysql rows %s", got)
	}
	if _, err := pgRelation(&protocol.DBOp{Table: "a\x00b"}); err == nil {
		t.Error("NUL in identifier accepted")
	}
}

func TestNormalize(t *testing.T) {
	type named string
	when := time.Date(2026, 10, 23, 1, 2, 3, 400, time.FixedZone("x", 3600))
	cases := []struct {
		in   any
		want string
	}{
		{nil, `null`},
		{true, `true`},
		{int16(-3), `-3`},
		{int32(7), `7`},
		{int64(math.MaxInt64), `"9223372036854775807"`},
		{uint64(math.MaxUint64), `"18446744073709551615"`},
		{42, `"42"`},
		{float32(0.1), `0.1`},
		{1.5, `1.5`},
		{math.Inf(-1), `"-Inf"`},
		{math.NaN(), `"NaN"`},
		{[]byte{0xff, 0}, `{"$b64":"/wA="}`},
		{"héllo", `"héllo"`},
		{"\xff", `{"$b64":"/w=="}`},
		{when, `"2026-10-23T01:02:03.0000004+01:00"`},
		{[16]byte{0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 1, 2, 3, 4, 5, 6, 7, 8}, `"12345678-9abc-def0-0102-030405060708"`},
		{[]any{int64(1), "a"}, `["1","a"]`},
		{map[string]any{"n": int64(2)}, `{"n":"2"}`},
		{ptr(int64(5)), `"5"`},
		{named("x"), `"x"`},
		{[]int64{1, 2}, `["1","2"]`},
		{time.Second, `"1s"`},
	}
	for _, c := range cases {
		got, err := json.Marshal(normalize(c.in))
		if err != nil {
			t.Errorf("%#v: %v", c.in, err)
			continue
		}
		if string(got) != c.want {
			t.Errorf("normalize(%#v) = %s, want %s", c.in, got, c.want)
		}
	}
}

func TestMySQLValue(t *testing.T) {
	cases := []struct {
		typ  string
		in   any
		want string
	}{
		{"VARCHAR", []byte("hi"), `"hi"`},
		{"TEXT", []byte{0xff}, `{"$b64":"/w=="}`},
		{"BLOB", []byte("hi"), `{"$b64":"aGk="}`},
		{"VARBINARY", []byte{1}, `{"$b64":"AQ=="}`},
		{"BIT", []byte{1, 0}, `"256"`},
		{"DECIMAL", []byte("12.50"), `"12.50"`},
		{"BIGINT", int64(9), `"9"`},
		{"INT", int64(9), `"9"`},
	}
	for _, c := range cases {
		got, _ := json.Marshal(normalize(mysqlValue(c.typ, c.in)))
		if string(got) != c.want {
			t.Errorf("%s %v → %s, want %s", c.typ, c.in, got, c.want)
		}
	}
}

func TestResultSetLimits(t *testing.T) {
	set := newResultSet(3, 1<<20)
	for i := range 5 {
		if !set.add([]any{int64(i)}) {
			break
		}
	}
	if len(set.rows) != 3 || !set.truncated || len(set.notices) != 0 {
		t.Fatalf("row cap: %d rows, truncated=%v, notices=%v", len(set.rows), set.truncated, set.notices)
	}

	set = newResultSet(100, 30)
	for range 10 {
		if !set.add([]any{"abcdef"}) {
			break
		}
	}
	enc, _ := json.Marshal(set.rows)
	if len(enc) > 30 || !set.truncated || len(set.notices) != 1 {
		t.Fatalf("byte cap: %s (%d bytes), truncated=%v, notices=%v", enc, len(enc), set.truncated, set.notices)
	}
	if len(enc) != set.size {
		t.Fatalf("size accounting %d != %d", set.size, len(enc))
	}

	res := &protocol.DBQueryResult{Type: protocol.TypeDBQueryResult, RequestID: "r"}
	newResultSet(10, 100).fill(res)
	b, _ := json.Marshal(res)
	if !bytes.Contains(b, []byte(`"columns":[],"rows":[],"row_count":0`)) {
		t.Fatalf("empty result encodes as %s", b)
	}
	if err := res.Validate(); err != nil {
		t.Fatal(err)
	}

	set = newResultSet(10, 100)
	n := int64(4)
	set.affected = &n
	res = &protocol.DBQueryResult{Type: protocol.TypeDBQueryResult, RequestID: "r"}
	set.fill(res)
	if *res.RowCount != 4 {
		t.Fatalf("affected row count %d", *res.RowCount)
	}

	set = newResultSet(10, 100)
	many := make([]protocol.DBColumn, protocol.MaxDBColumns+1)
	if err := set.setColumns(many); err == nil {
		t.Fatal("too many columns accepted")
	}
	if err := set.setColumns([]protocol.DBColumn{{Name: strings.Repeat("n", 300), Type: strings.Repeat("T", 300)}}); err != nil {
		t.Fatal(err)
	}
	if len(set.cols[0].Name) != protocol.MaxDBIdentifierBytes || len(set.cols[0].Type) != 128 || set.cols[0].Type[0] != 't' {
		t.Fatalf("column not clipped: %d %d", len(set.cols[0].Name), len(set.cols[0].Type))
	}
}

func TestScramVerifier(t *testing.T) {
	salt := []byte("0123456789abcdef")
	v := scramSHA256Verifier("pencil", salt, 4096)
	re := regexp.MustCompile(`^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$`)
	if !re.MatchString(v) {
		t.Fatalf("verifier %q", v)
	}
	if v != scramSHA256Verifier("pencil", salt, 4096) || v == scramSHA256Verifier("pencil2", salt, 4096) {
		t.Fatal("verifier not a function of the password")
	}
	if strings.Contains(v, "pencil") {
		t.Fatal("verifier contains the password")
	}
	if !scramSafe("abc-_XYZ09") || scramSafe("pässword") || scramSafe("a\nb") || scramSafe("") {
		t.Fatal("scramSafe")
	}
}

func TestRunRejects(t *testing.T) {
	r := New(Options{})
	ctx := context.Background()
	target := Target{Engine: EnginePostgres, Host: "127.0.0.1", Port: 1}
	cred := Credential{Username: "u", Password: "secret-password"}

	if res := r.Run(ctx, target, cred, nil); res.OK || res.Error == "" {
		t.Fatalf("nil query: %+v", res)
	}
	cases := []struct {
		name   string
		target Target
		q      *protocol.DBQuery
		want   string
	}{
		{"engine mismatch", Target{Engine: EngineMySQL, Host: "h", Port: 1}, query("postgres", "read", protocol.DBOp{Type: "list_namespaces"}), "engine"},
		{"no address", Target{Engine: EnginePostgres}, query("postgres", "read", protocol.DBOp{Type: "list_namespaces"}), "address"},
		{"provision in read mode", target, query("postgres", "read", protocol.DBOp{Type: "provision_readonly"}), "admin"},
		{"bad mode", target, query("postgres", "admin", protocol.DBOp{Type: "list_namespaces"}), "mode"},
	}
	for _, c := range cases {
		res := r.Run(ctx, c.target, cred, c.q)
		if res.OK || !strings.Contains(res.Error, c.want) || res.RequestID != "req_1" || res.Type != protocol.TypeDBQueryResult {
			t.Errorf("%s: %+v", c.name, res)
		}
		if err := res.Validate(); err != nil {
			t.Errorf("%s: %v", c.name, err)
		}
	}
}

func TestErrorScrubbing(t *testing.T) {
	cred := Credential{Password: "hunter2-secret", ReadonlyPassword: "ro-secret-pw"}
	got := scrub("bad hunter2-secret and ro-secret-pw", cred)
	if strings.Contains(got, "hunter2") || strings.Contains(got, "ro-secret") {
		t.Fatalf("scrub left a secret: %s", got)
	}
	if got := clip("ééé", 3); got != "é" {
		t.Fatalf("clip on rune boundary: %q", got)
	}
	q := query("postgres", "read", protocol.DBOp{Type: "raw"})
	if got := errorMessage(context.DeadlineExceeded, q); !strings.Contains(got, "timed out") {
		t.Fatalf("timeout message %q", got)
	}
	if got := errorMessage(readOnlyError("SET is not an allowed read command"), q); !strings.HasPrefix(got, "read-only mode: ") {
		t.Fatalf("read-only message %q", got)
	}
}

// fakeRedis serves canned replies for exact command lines, and records
// what it received.
type fakeRedis struct {
	ln      net.Listener
	replies map[string]string
	got     chan string
}

func newFakeRedis(t *testing.T, replies map[string]string) *fakeRedis {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeRedis{ln: ln, replies: replies, got: make(chan string, 64)}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(c)
		}
	}()
	return f
}

func (f *fakeRedis) serve(c net.Conn) {
	defer c.Close()
	r := newRESPReader(c, defaultRESPLimits)
	for {
		v, err := r.read()
		if err != nil {
			return
		}
		parts := make([]string, len(v.arr))
		for i, a := range v.arr {
			parts[i] = string(a.str)
		}
		line := strings.Join(parts, " ")
		select {
		case f.got <- line:
		default:
		}
		reply, ok := f.replies[line]
		if !ok {
			reply = "-ERR unknown in fake\r\n"
		}
		if _, err := c.Write([]byte(reply)); err != nil {
			return
		}
	}
}

func (f *fakeRedis) target() Target {
	addr := f.ln.Addr().(*net.TCPAddr)
	return Target{Engine: EngineRedis, Host: addr.IP.String(), Port: addr.Port}
}

func TestRedisAgainstFake(t *testing.T) {
	bulk := func(s string) string { return "$" + strconv.Itoa(len(s)) + "\r\n" + s + "\r\n" }
	f := newFakeRedis(t, map[string]string{
		"AUTH roundhouse_ro pw-123456": "+OK\r\n",
		"AUTH default wrong-password":  "-WRONGPASS invalid username-password pair\r\n",
		"SELECT 2":                     "+OK\r\n",
		"GET k":                        "$5\r\nhello\r\n",
		"SCAN 0 MATCH a* COUNT 100":    "*2\r\n$2\r\n17\r\n*2\r\n$2\r\na1\r\n$2\r\na2\r\n",
		"TYPE a1":                      "+string\r\n",
		"TYPE a2":                      "+hash\r\n",
		"HGETALL h":                    "*4\r\n$1\r\nf\r\n$1\r\nv\r\n$1\r\ng\r\n$-1\r\n",
		"INFO keyspace":                bulk("# Keyspace\r\ndb0:keys=3,expires=1,avg_ttl=0\r\n"),
		"SELECT 0":                     "+OK\r\n",
		"SELECT 1":                     "-ERR DB index is out of range\r\n",
		"MGET a b":                     "*2\r\n$1\r\n1\r\n$-1\r\n",
		"DBSIZE":                       ":12\r\n",
		"GET nope":                     "-NOPERM this user has no permissions\r\n",
		"AUTH default admin-pass-1":    "+OK\r\n",
		"SET k v":                      "+OK\r\n",
	})
	r := New(Options{})
	ctx := context.Background()
	ro := Credential{Username: "roundhouse_ro", Password: "pw-123456"}
	run := func(cred Credential, mode string, op protocol.DBOp) *protocol.DBQueryResult {
		t.Helper()
		res := r.Run(ctx, f.target(), cred, query("redis", mode, op))
		if err := res.Validate(); err != nil {
			t.Fatalf("invalid result %+v: %v", res, err)
		}
		return res
	}
	rows := func(res *protocol.DBQueryResult) string {
		b, _ := json.Marshal(res.Rows)
		return string(b)
	}

	res := run(ro, "read", protocol.DBOp{Type: "raw", Argv: []string{"get", "k"}})
	if !res.OK || rows(res) != `[["hello"]]` {
		t.Fatalf("GET: %+v %s", res, rows(res))
	}
	res = run(ro, "read", protocol.DBOp{Type: "list_tables", Pattern: "a*", Namespace: "2"})
	if !res.OK || rows(res) != `[["a1","string"],["a2","hash"]]` || res.Notice != "cursor:17" {
		t.Fatalf("SCAN: %+v %s", res, rows(res))
	}
	res = run(ro, "read", protocol.DBOp{Type: "raw", Argv: []string{"HGETALL", "h"}})
	if !res.OK || rows(res) != `[["f","v"],["g",null]]` {
		t.Fatalf("HGETALL: %s", rows(res))
	}
	res = run(ro, "read", protocol.DBOp{Type: "list_namespaces"})
	if !res.OK || rows(res) != `[["0","12"]]` {
		t.Fatalf("list_namespaces: %s", rows(res))
	}
	res = run(ro, "read", protocol.DBOp{Type: "raw", Argv: []string{"INFO", "keyspace"}})
	if !res.OK || !strings.Contains(rows(res), "db0:keys=3") {
		t.Fatalf("INFO: %s", rows(res))
	}
	res = run(ro, "read", protocol.DBOp{Type: "raw", Argv: []string{"MGET", "a", "b"}})
	if !res.OK || rows(res) != `[["1"],[null]]` {
		t.Fatalf("MGET: %s", rows(res))
	}
	res = run(ro, "read", protocol.DBOp{Type: "raw", Argv: []string{"DBSIZE"}})
	if !res.OK || rows(res) != `[["12"]]` {
		t.Fatalf("DBSIZE: %s", rows(res))
	}
	res = run(ro, "read", protocol.DBOp{Type: "raw", Argv: []string{"GET", "nope"}})
	if res.OK || !strings.HasPrefix(res.Error, "read-only mode: NOPERM") {
		t.Fatalf("NOPERM: %+v", res)
	}
	res = run(ro, "read", protocol.DBOp{Type: "raw", Argv: []string{"SET", "k", "v"}})
	if res.OK || !strings.HasPrefix(res.Error, "read-only mode") {
		t.Fatalf("SET in read mode: %+v", res)
	}
	res = run(Credential{Username: "default", Password: "wrong-password"}, "read", protocol.DBOp{Type: "raw", Argv: []string{"GET", "k"}})
	if res.OK || res.Error != "authentication failed" || strings.Contains(res.Error, "wrong-password") {
		t.Fatalf("bad password: %+v", res)
	}
	res = run(Credential{Username: "default", Password: "admin-pass-1"}, "write", protocol.DBOp{Type: "raw", Argv: []string{"SET", "k", "v"}})
	if !res.OK || rows(res) != `[["OK"]]` {
		t.Fatalf("SET in write mode: %+v", res)
	}
	res = run(Credential{Username: "default", Password: "admin-pass-1"}, "write", protocol.DBOp{Type: "provision_readonly"})
	if !res.OK {
		t.Fatalf("provision: %+v", res)
	}
	res = run(ro, "read", protocol.DBOp{Type: "describe", Table: "k"})
	if res.OK {
		t.Fatalf("describe: %+v", res)
	}
}

const testNewPassword = "Nw-pass_0123456789.abcdefghij~XYZ"

func TestSetPasswordRefusals(t *testing.T) {
	r := New(Options{})
	ctx := context.Background()
	admin := Credential{Username: "postgres", Password: "admin-password", NewPassword: testNewPassword}
	pg := Target{Engine: EnginePostgres, Host: "127.0.0.1", Port: 1}
	my := Target{Engine: EngineMySQL, Host: "127.0.0.1", Port: 1, AppUser: "app"}
	setPw := func(user string) protocol.DBOp { return protocol.DBOp{Type: protocol.DBOpSetPassword, User: user} }
	cases := []struct {
		name   string
		target Target
		cred   Credential
		mode   string
		op     protocol.DBOp
		want   string
	}{
		{"read mode", pg, admin, "read", setPw("postgres"), "runs as the admin"},
		{"no new password", pg, Credential{Username: "postgres", Password: "admin-password"}, "write", setPw("postgres"), "new password"},
		{"short new password", pg, Credential{Username: "postgres", Password: "admin-password", NewPassword: "short"}, "write", setPw("postgres"), "new password"},
		{"quote in new password", pg, Credential{Username: "postgres", Password: "admin-password", NewPassword: testNewPassword + "'"}, "write", setPw("postgres"), "new password"},
		{"no user", pg, admin, "write", setPw(""), "needs a user"},
		{"another role", pg, admin, "write", setPw("someone_else"), "changes only"},
		{"app user outside mysql", Target{Engine: EnginePostgres, Host: "127.0.0.1", Port: 1, AppUser: "app"}, admin, "write", setPw("app"), "changes only"},
		{"another mysql user", my, Credential{Username: "root", Password: "admin-password", NewPassword: testNewPassword}, "write", setPw("mysql.sys"), "changes only"},
	}
	for _, c := range cases {
		res := r.Run(ctx, c.target, c.cred, query(c.target.Engine, c.mode, c.op))
		if res.OK || !strings.Contains(res.Error, c.want) {
			t.Errorf("%s: %+v, want an error containing %q", c.name, res, c.want)
		}
		if strings.Contains(res.Error, testNewPassword) || strings.Contains(res.Error, "admin-password") {
			t.Errorf("%s: error carries a password: %s", c.name, res.Error)
		}
	}
	// The admin itself, roundhouse_ro and MySQL's application user pass the
	// checks and fail only on connecting.
	for _, c := range []struct {
		target Target
		cred   Credential
		user   string
	}{
		{pg, admin, "postgres"},
		{pg, admin, ReadonlyUser},
		{my, Credential{Username: "root", Password: "admin-password", NewPassword: testNewPassword}, "app"},
	} {
		res := r.Run(ctx, c.target, c.cred, query(c.target.Engine, "write", setPw(c.user)))
		if res.OK || strings.Contains(res.Error, "set_password") {
			t.Errorf("%s on %s: %+v", c.user, c.target.Engine, res)
		}
	}
}

func TestSetPasswordAgainstFakeRedis(t *testing.T) {
	f := newFakeRedis(t, map[string]string{
		"AUTH default admin-pass-1":                               "+OK\r\n",
		"ACL GETUSER roundhouse_ro":                               "*2\r\n$5\r\nflags\r\n*1\r\n$2\r\non\r\n",
		"ACL SETUSER roundhouse_ro resetpass >" + testNewPassword: "+OK\r\n",
		"ACL GETUSER default":                                     "*-1\r\n",
	})
	r := New(Options{})
	ctx := context.Background()
	run := func(cred Credential, user string) *protocol.DBQueryResult {
		t.Helper()
		res := r.Run(ctx, f.target(), cred, query("redis", "write", protocol.DBOp{Type: protocol.DBOpSetPassword, User: user}))
		if err := res.Validate(); err != nil {
			t.Fatalf("invalid result %+v: %v", res, err)
		}
		b, _ := json.Marshal(res)
		for _, pw := range []string{testNewPassword, cred.Password} {
			if strings.Contains(string(b), pw) {
				t.Fatalf("result carries a password: %s", b)
			}
		}
		return res
	}
	admin := Credential{Username: "default", Password: "admin-pass-1", NewPassword: testNewPassword}
	res := run(admin, ReadonlyUser)
	if !res.OK || res.Notice != "password set for roundhouse_ro" {
		t.Fatalf("set roundhouse_ro: %+v", res)
	}
	res = run(admin, "default")
	if res.OK || !strings.Contains(res.Error, "does not exist") {
		t.Fatalf("missing user: %+v", res)
	}
}

// TestSetPasswordErrorsAreScrubbed has the server echo both passwords in
// its error: neither may reach the result.
func TestSetPasswordErrorsAreScrubbed(t *testing.T) {
	echo := "-ERR Error in ACL SETUSER modifier '>" + testNewPassword + "' after AUTH admin-pass-3\r\n"
	f := newFakeRedis(t, map[string]string{
		"AUTH default admin-pass-3":                         "+OK\r\n",
		"ACL GETUSER default":                               "*0\r\n",
		"ACL SETUSER default resetpass >" + testNewPassword: echo,
	})
	cred := Credential{Username: "default", Password: "admin-pass-3", NewPassword: testNewPassword}
	res := New(Options{}).Run(context.Background(), f.target(), cred,
		query("redis", "write", protocol.DBOp{Type: protocol.DBOpSetPassword, User: "default"}))
	if res.OK || !strings.Contains(res.Error, "[redacted]") {
		t.Fatalf("result %+v", res)
	}
	b, _ := json.Marshal(res)
	if strings.Contains(string(b), testNewPassword) || strings.Contains(string(b), "admin-pass-3") {
		t.Fatalf("result carries a password: %s", b)
	}
}

func TestRedisTimeout(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err == nil {
			_, _ = bufio.NewReader(c).ReadByte()
			time.Sleep(3 * time.Second)
			c.Close()
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	q := query("redis", "read", protocol.DBOp{Type: "raw", Argv: []string{"GET", "k"}})
	q.TimeoutMS = 200
	start := time.Now()
	res := New(Options{ConnectTimeout: 100 * time.Millisecond}).Run(context.Background(),
		Target{Engine: EngineRedis, Host: addr.IP.String(), Port: addr.Port}, Credential{Username: "u", Password: "p"}, q)
	if res.OK || time.Since(start) > 2*time.Second {
		t.Fatalf("hung server: %+v after %v", res, time.Since(start))
	}
}
