package dbquery

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

const (
	redisMaxScanCount  = 1000
	redisMaxDBIndexLen = 5
	// redisProbeDBs is how many database indexes list_namespaces probes;
	// the server default is 16.
	redisProbeDBs = 16
)

// redisReadCommands are the commands read mode runs.
var redisReadCommands = map[string]bool{
	"GET": true, "MGET": true, "HGET": true, "HGETALL": true, "LRANGE": true, "SMEMBERS": true,
	"ZRANGE": true, "SCAN": true, "TYPE": true, "TTL": true, "STRLEN": true, "XRANGE": true,
	"EXISTS": true, "DBSIZE": true, "INFO": true,
}

// redisWriteDenied are commands not run even in write mode: they break
// this client's request-reply protocol, re-authenticate, or take the
// server down rather than change data.
var redisWriteDenied = map[string]bool{
	"HELLO": true, "AUTH": true, "RESET": true, "QUIT": true, "CLIENT": true,
	"MONITOR": true, "SUBSCRIBE": true, "PSUBSCRIBE": true, "SSUBSCRIBE": true,
	"SYNC": true, "PSYNC": true, "REPLICAOF": true, "SLAVEOF": true, "FAILOVER": true,
	"SHUTDOWN": true, "DEBUG": true, "MODULE": true,
}

// redisReplyError is an error reply from the server.
type redisReplyError string

func (e redisReplyError) Error() string { return string(e) }

// redisConn is one RESP2 connection.
type redisConn struct {
	c    net.Conn
	r    *respReader
	stop func() bool
}

func dialRedis(ctx context.Context, req *request) (*redisConn, error) {
	t := req.target
	cctx, cancel := context.WithTimeout(ctx, req.connect)
	defer cancel()
	d := net.Dialer{Timeout: req.connect}
	// SECURITY: plaintext on the node's bridge network; see the package doc.
	c, err := d.DialContext(cctx, "tcp", net.JoinHostPort(t.Host, strconv.Itoa(t.Port)))
	if err != nil {
		return nil, err
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = c.SetDeadline(dl)
	}
	rc := &redisConn{c: c, r: newRESPReader(c, defaultRESPLimits)}
	rc.stop = context.AfterFunc(ctx, func() { _ = c.Close() })
	auth := []string{"AUTH", req.cred.Username, req.cred.Password}
	if req.cred.Username == "" {
		auth = []string{"AUTH", req.cred.Password}
	}
	if _, err := rc.do(auth...); err != nil {
		rc.close()
		var re redisReplyError
		if errors.As(err, &re) {
			return nil, usageError("authentication failed")
		}
		return nil, err
	}
	return rc, nil
}

func (c *redisConn) close() {
	c.stop()
	_ = c.c.Close()
}

// do sends one command and reads its reply; an error reply is an error.
func (c *redisConn) do(args ...string) (respValue, error) {
	vs, err := c.pipeline([][]string{args})
	if err != nil {
		return respValue{}, err
	}
	if vs[0].kind == respError {
		return respValue{}, redisReplyError(vs[0].str)
	}
	return vs[0], nil
}

// pipeline sends cmds at once and reads their replies in order. Error
// replies are returned as values.
func (c *redisConn) pipeline(cmds [][]string) ([]respValue, error) {
	var buf []byte
	for _, args := range cmds {
		buf = appendRESPCommand(buf, args)
	}
	if _, err := c.c.Write(buf); err != nil {
		return nil, err
	}
	out := make([]respValue, len(cmds))
	for i := range cmds {
		v, err := c.r.read()
		if err != nil {
			return nil, err
		}
		out[i] = v
	}
	return out, nil
}

func runRedis(ctx context.Context, req *request) (*resultSet, error) {
	op := req.op
	if op.Type == protocol.DBOpProvisionReadonly {
		// NOTE: the image's start command declares roundhouse_ro.
		return newResultSet(req.maxRows, req.maxBytes), nil
	}
	if op.Type == protocol.DBOpDescribe {
		return nil, usageError("describe is not supported for redis")
	}
	if op.Type == protocol.DBOpSetPassword {
		c, err := dialRedis(ctx, req)
		if err != nil {
			return nil, err
		}
		defer c.close()
		return redisSetPassword(c, req)
	}
	db := namespaceOr(op.Namespace, namespaceOr(req.target.Database, "0"))
	if !validRedisDB(db) {
		return nil, usageError("namespace must be a database index")
	}
	c, err := dialRedis(ctx, req)
	if err != nil {
		return nil, err
	}
	defer c.close()
	if db != "0" {
		if _, err := c.do("SELECT", db); err != nil {
			return nil, err
		}
	}
	set := newResultSet(req.maxRows, req.maxBytes)
	switch op.Type {
	case protocol.DBOpListNamespaces:
		return set, redisListDBs(c, set)
	case protocol.DBOpListTables:
		return set, redisScanKeys(c, set, op)
	case protocol.DBOpRows:
		return set, redisKeyRows(c, set, op)
	case protocol.DBOpRaw:
		if len(op.Argv) == 0 {
			return nil, usageError("raw needs argv")
		}
		argv, err := redisCheckCommand(op.Argv, req.write, req.maxRows)
		if err != nil {
			return nil, err
		}
		v, err := c.do(argv...)
		if err != nil {
			return nil, err
		}
		return set, redisReplyRows(set, strings.ToUpper(argv[0]), v)
	}
	return nil, usageError("unsupported operation")
}

// redisSetPassword replaces an existing ACL user's passwords with the new
// one. The change is runtime only: the server starts from --requirepass and
// --user rules built from the container's environment, so the control plane
// redeploys the database with the new password after a rotation.
//
// NOTE: for "default" it sets requirepass, which the server applies as
// ACL SETUSER default resetpass >new and which keeps CONFIG GET requirepass
// in step with the ACL. Either way, connections that already authenticated
// (this one included) stay authenticated.
//
// SECURITY: both commands travel over the connection, never in an argv,
// and the server redacts their arguments from SLOWLOG and MONITOR.
func redisSetPassword(c *redisConn, req *request) (*resultSet, error) {
	user := req.op.User
	v, err := c.do("ACL", "GETUSER", user)
	if err != nil {
		return nil, err
	}
	if v.null {
		return nil, usageError(fmt.Sprintf("user %q does not exist", user))
	}
	if user == "default" {
		_, err = c.do("CONFIG", "SET", "requirepass", req.cred.NewPassword)
	} else {
		_, err = c.do("ACL", "SETUSER", user, "resetpass", ">"+req.cred.NewPassword)
	}
	if err != nil {
		return nil, err
	}
	return passwordSet(req), nil
}

func validRedisDB(s string) bool {
	if s == "" || len(s) > redisMaxDBIndexLen {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// redisListDBs lists the database indexes with their key counts by
// probing SELECT and DBSIZE up to the first index the server refuses.
//
// NOTE: INFO and CONFIG GET would say how many databases exist, but both
// are @dangerous, which the read-only ACL user lacks.
func redisListDBs(c *redisConn, set *resultSet) error {
	cmds := make([][]string, 0, 2*redisProbeDBs)
	for i := range redisProbeDBs {
		cmds = append(cmds, []string{"SELECT", strconv.Itoa(i)}, []string{"DBSIZE"})
	}
	vals, err := c.pipeline(cmds)
	if err != nil {
		return err
	}
	if err := set.setColumns(columns("name:index", "keys:integer")); err != nil {
		return err
	}
	for i := range redisProbeDBs {
		sel, size := vals[2*i], vals[2*i+1]
		if sel.kind == respError {
			if i == 0 && strings.HasPrefix(string(sel.str), "NOPERM") && size.kind == respInteger {
				// NOTE: an ACL user without SELECT sees only db 0, and the
				// DBSIZE after the refused SELECT still counted it.
				set.add([]any{"0", size.json()})
				return nil
			}
			if i == 0 {
				return redisReplyError(sel.str)
			}
			break
		}
		if size.kind == respError {
			return redisReplyError(size.str)
		}
		if !set.add([]any{strconv.Itoa(i), size.json()}) {
			break
		}
	}
	return nil
}

// redisScanKeys returns one SCAN page of keys with their types; the next
// cursor goes in the notice as "cursor:<n>".
func redisScanKeys(c *redisConn, set *resultSet, op *protocol.DBOp) error {
	cursor := op.Cursor
	if cursor == "" {
		cursor = "0"
	}
	args := []string{"SCAN", cursor}
	if op.Pattern != "" {
		args = append(args, "MATCH", op.Pattern)
	}
	args = append(args, "COUNT", strconv.Itoa(min(set.maxRows, redisMaxScanCount)))
	v, err := c.do(args...)
	if err != nil {
		return err
	}
	if v.kind != respArray || len(v.arr) != 2 || v.arr[1].kind != respArray {
		return respProtocolError("unexpected SCAN reply")
	}
	keys := v.arr[1].arr
	if len(keys) > set.maxRows+1 {
		keys = keys[:set.maxRows+1]
	}
	cmds := make([][]string, len(keys))
	for i, k := range keys {
		cmds[i] = []string{"TYPE", string(k.str)}
	}
	types, err := c.pipeline(cmds)
	if err != nil {
		return err
	}
	if err := set.setColumns(columns("key:string", "type:string")); err != nil {
		return err
	}
	set.notice("cursor:" + v.arr[0].string())
	for i, k := range keys {
		if !set.add([]any{text(k.str), types[i].string()}) {
			break
		}
	}
	return nil
}

// redisKeyRows pages through one key's value by its type.
func redisKeyRows(c *redisConn, set *resultSet, op *protocol.DBOp) error {
	key := op.Table
	off := offset(op)
	n := set.maxRows + 1
	t, err := c.do("TYPE", key)
	if err != nil {
		return err
	}
	switch t.string() {
	case "none":
		return usageError("key not found")
	case "string":
		if err := set.setColumns(columns("value:string")); err != nil {
			return err
		}
		v, err := c.do("GET", key)
		if err != nil || off > 0 {
			return err
		}
		set.add([]any{v.json()})
		return nil
	case "list":
		v, err := c.do("LRANGE", key, strconv.Itoa(off), strconv.Itoa(off+n-1))
		if err != nil {
			return err
		}
		if err := set.setColumns(columns("index:integer", "value:string")); err != nil {
			return err
		}
		for i, e := range v.arr {
			if !set.add([]any{strconv.Itoa(off + i), e.json()}) {
				break
			}
		}
		return nil
	case "zset":
		v, err := c.do("ZRANGE", key, strconv.Itoa(off), strconv.Itoa(off+n-1), "WITHSCORES")
		if err != nil {
			return err
		}
		if err := set.setColumns(columns("member:string", "score:double")); err != nil {
			return err
		}
		return addPairs(set, v.arr, true)
	case "hash":
		if err := set.setColumns(columns("field:string", "value:string")); err != nil {
			return err
		}
		items, err := redisScanAll(c, "HSCAN", key, 2*off, 2*n)
		if err != nil {
			return err
		}
		return addPairs(set, items, false)
	case "set":
		if err := set.setColumns(columns("member:string")); err != nil {
			return err
		}
		items, err := redisScanAll(c, "SSCAN", key, off, n)
		if err != nil {
			return err
		}
		for _, e := range items {
			if !set.add([]any{e.json()}) {
				break
			}
		}
		return nil
	case "stream":
		if err := set.setColumns(columns("id:string", "fields:object")); err != nil {
			return err
		}
		v, err := c.do("XRANGE", key, "-", "+", "COUNT", strconv.Itoa(off+n))
		if err != nil {
			return err
		}
		for i, e := range v.arr {
			if i < off {
				continue
			}
			if !addStreamEntry(set, e) {
				break
			}
		}
		return nil
	}
	return usageError("unsupported key type " + t.string())
}

// redisScanAll walks a key with HSCAN or SSCAN and returns the flat items
// from skip up to skip+n.
func redisScanAll(c *redisConn, cmd, key string, skip, n int) ([]respValue, error) {
	var items []respValue
	seen := 0
	cursor := "0"
	for {
		v, err := c.do(cmd, key, cursor, "COUNT", strconv.Itoa(redisMaxScanCount))
		if err != nil {
			return nil, err
		}
		if v.kind != respArray || len(v.arr) != 2 {
			return nil, respProtocolError("unexpected " + cmd + " reply")
		}
		for _, e := range v.arr[1].arr {
			if seen >= skip {
				items = append(items, e)
			}
			seen++
		}
		cursor = v.arr[0].string()
		if cursor == "0" || len(items) >= n {
			break
		}
	}
	if len(items) > n {
		items = items[:n]
	}
	return items, nil
}

// addPairs adds a flat [k1, v1, k2, v2, …] reply as two-column rows; score
// parses the second value as a number.
func addPairs(set *resultSet, flat []respValue, score bool) error {
	for i := 0; i+1 < len(flat); i += 2 {
		var second any = flat[i+1].json()
		if score {
			if f, err := strconv.ParseFloat(flat[i+1].string(), 64); err == nil {
				second = finite(f, 64)
			}
		}
		if !set.add([]any{flat[i].json(), second}) {
			break
		}
	}
	return nil
}

func addStreamEntry(set *resultSet, e respValue) bool {
	if len(e.arr) != 2 {
		return set.add([]any{nil, e.json()})
	}
	fields := map[string]any{}
	kv := e.arr[1].arr
	for i := 0; i+1 < len(kv); i += 2 {
		fields[string(kv[i].str)] = kv[i+1].json()
	}
	return set.add([]any{e.arr[0].string(), fields})
}

// redisReplyRows turns a raw command's reply into rows: pairs for HGETALL
// and CONFIG GET, a page with its cursor for the SCAN family, one row per
// element for other arrays, and one row otherwise.
func redisReplyRows(set *resultSet, cmd string, v respValue) error {
	switch {
	case cmd == "HGETALL" && v.kind == respArray:
		if err := set.setColumns(columns("field:string", "value:string")); err != nil {
			return err
		}
		return addPairs(set, v.arr, false)
	case strings.HasSuffix(cmd, "SCAN") && v.kind == respArray && len(v.arr) == 2 && v.arr[1].kind == respArray:
		set.notice("cursor:" + v.arr[0].string())
		if cmd == "HSCAN" || cmd == "ZSCAN" {
			if err := set.setColumns(columns("field:string", "value:string")); err != nil {
				return err
			}
			return addPairs(set, v.arr[1].arr, cmd == "ZSCAN")
		}
		v = v.arr[1]
	}
	if err := set.setColumns(columns("value")); err != nil {
		return err
	}
	if v.kind != respArray || v.null {
		set.add([]any{v.json()})
		return nil
	}
	for _, e := range v.arr {
		if !set.add([]any{e.json()}) {
			break
		}
	}
	return nil
}

// redisCheckCommand applies read mode's allowlist and count caps, or write
// mode's denylist, and returns the argv to send.
func redisCheckCommand(argv []string, write bool, maxRows int) ([]string, error) {
	name := strings.ToUpper(argv[0])
	if write {
		if redisWriteDenied[name] {
			return nil, usageError(name + " is not allowed")
		}
		return argv, nil
	}
	if !redisReadCommands[name] {
		return nil, readOnlyError(name + " is not an allowed read command")
	}
	out := append([]string{name}, argv[1:]...)
	limit := maxRows + 1
	switch name {
	case "SCAN":
		return capOption(out, "COUNT", 2, min(limit, redisMaxScanCount), false), nil
	case "LRANGE":
		return capIndexRange(out, limit), nil
	case "ZRANGE":
		if hasOption(out, 4, "BYSCORE") || hasOption(out, 4, "BYLEX") {
			return capLimit(out, limit), nil
		}
		return capIndexRange(out, limit), nil
	case "XRANGE":
		return capOption(out, "COUNT", 4, limit, true), nil
	}
	return out, nil
}

func hasOption(argv []string, from int, opt string) bool {
	for i := from; i < len(argv); i++ {
		if strings.EqualFold(argv[i], opt) {
			return true
		}
	}
	return false
}

// capOption sets the value after opt (searched from index from) to at
// most limit, appending "opt limit" when absent. negativeIsAll treats a
// non-positive value as unbounded.
func capOption(argv []string, opt string, from, limit int, negativeIsAll bool) []string {
	for i := from; i+1 < len(argv); i++ {
		if !strings.EqualFold(argv[i], opt) {
			continue
		}
		n, err := strconv.Atoi(argv[i+1])
		if err != nil {
			return argv
		}
		if n > limit || (negativeIsAll && n <= 0) {
			argv[i+1] = strconv.Itoa(limit)
		}
		return argv
	}
	return append(argv, opt, strconv.Itoa(limit))
}

// capLimit caps ZRANGE BYSCORE/BYLEX's LIMIT offset count.
func capLimit(argv []string, limit int) []string {
	for i := 4; i+2 < len(argv); i++ {
		if !strings.EqualFold(argv[i], "LIMIT") {
			continue
		}
		n, err := strconv.Atoi(argv[i+2])
		if err != nil {
			return argv
		}
		if n < 0 || n > limit {
			argv[i+2] = strconv.Itoa(limit)
		}
		return argv
	}
	return append(argv, "LIMIT", "0", strconv.Itoa(limit))
}

// capIndexRange narrows "CMD key start stop" so it spans at most limit
// elements when both indexes count from the same end.
func capIndexRange(argv []string, limit int) []string {
	if len(argv) < 4 {
		return argv
	}
	start, err1 := strconv.Atoi(argv[2])
	stop, err2 := strconv.Atoi(argv[3])
	if err1 != nil || err2 != nil {
		return argv
	}
	if (start >= 0) == (stop >= 0) && stop-start+1 > limit {
		argv[3] = strconv.Itoa(start + limit - 1)
	}
	return argv
}

// redisError is the short message for a Redis error.
func redisError(err error, write bool) string {
	var re redisReplyError
	if errors.As(err, &re) {
		msg := string(re)
		if strings.HasPrefix(msg, "NOPERM") && !write {
			return "read-only mode: " + msg
		}
		if strings.HasPrefix(msg, "WRONGPASS") || strings.HasPrefix(msg, "NOAUTH") {
			return "authentication failed"
		}
		return msg
	}
	if errors.Is(err, errRESPTooLarge) {
		return fmt.Sprintf("reply too large (over %d MiB); narrow the command", defaultRESPLimits.maxTotal>>20)
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return "cannot connect: " + ne.Error()
	}
	return err.Error()
}
