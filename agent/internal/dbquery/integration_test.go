//go:build integration

package dbquery_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/dbquery"
	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/dockertest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// Images as pinned in packages/shared/src/database-images.json.
const (
	postgresImage = "postgres:18-bookworm@sha256:bbf83594798e144bff365a9c191c5d779f181fb3135902064ab8ff11918020fc"
	mysqlImage    = "mysql:8.4@sha256:76f0358884cb92d9a086d24e5671c38048d3fef40f2588703d73eb55392d6b69"
	valkeyImage   = "valkey/valkey:9.1@sha256:418652cfb58ef879d4978c33553735d7147016032d5aefaa14c828e611eb9dfd"
	mongoImage    = "mongo:8.0@sha256:4a4ab5d4834207389e0d7270fac988e21ffedccecba77991a552f755df229907"
)

const (
	adminPassword = "admin-Pw_0123456789abcdefghijklmnopqrstuvwxyz"
	roPassword    = "ro-Pw_0123456789abcdefghijklmnopqrstuvwxyzABC"
	readyTimeout  = 3 * time.Minute

	// The set_password tests rotate to these.
	appPassword      = "app-Pw_0123456789abcdefghijklmnopqrstuvwxyz"
	newAdminPassword = "new.admin~Pw_0123456789abcdefghijklmnopqrstu"
	newROPassword    = "new.ro~Pw_0123456789abcdefghijklmnopqrstuvwxy"
	newAppPassword   = "new.app~Pw_0123456789abcdefghijklmnopqrstuvwx"
)

type engineEnv struct {
	r         *dbquery.Runner
	container string
	target    dbquery.Target
	admin     dbquery.Credential
	ro        dbquery.Credential
}

func ptr[T any](v T) *T { return &v }

// run runs op and checks the result is valid and free of passwords.
func (e *engineEnv) run(t *testing.T, cred dbquery.Credential, mode string, op protocol.DBOp, edit ...func(*protocol.DBQuery)) *protocol.DBQueryResult {
	t.Helper()
	q := &protocol.DBQuery{
		Type: protocol.TypeDBQuery, RequestID: "it_1", Engine: protocol.DatabaseEngine(e.target.Engine),
		Mode: mode, Op: op, MaxRows: 100, MaxBytes: protocol.MaxDBQueryResultBytes, TimeoutMS: 10_000,
	}
	for _, f := range edit {
		f(q)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	res := e.r.Run(ctx, e.target, cred, q)
	if err := res.Validate(); err != nil {
		t.Fatalf("invalid result %+v: %v", res, err)
	}
	b, _ := json.Marshal(res)
	for _, pw := range []string{adminPassword, roPassword, appPassword, newAdminPassword, newROPassword, newAppPassword} {
		if strings.Contains(string(b), pw) {
			t.Fatalf("result carries a password: %s", b)
		}
	}
	if res.RequestID != "it_1" || res.DurationMS < 0 {
		t.Fatalf("result header %+v", res)
	}
	return res
}

func (e *engineEnv) ok(t *testing.T, cred dbquery.Credential, mode string, op protocol.DBOp, edit ...func(*protocol.DBQuery)) *protocol.DBQueryResult {
	t.Helper()
	res := e.run(t, cred, mode, op, edit...)
	if !res.OK {
		t.Fatalf("%s %+v failed: %s", mode, op, res.Error)
	}
	return res
}

func (e *engineEnv) fails(t *testing.T, cred dbquery.Credential, mode string, op protocol.DBOp, want string) {
	t.Helper()
	res := e.run(t, cred, mode, op)
	if res.OK || !strings.Contains(strings.ToLower(res.Error), strings.ToLower(want)) {
		t.Fatalf("%s %+v: ok=%v error %q, want an error containing %q", mode, op, res.OK, res.Error, want)
	}
}

// waitReady polls list_namespaces as the admin until the server answers.
func (e *engineEnv) waitReady(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(readyTimeout)
	last := ""
	for time.Now().Before(deadline) {
		res := e.run(t, e.admin, "write", protocol.DBOp{Type: protocol.DBOpListNamespaces})
		if res.OK {
			return
		}
		last = res.Error
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("%s not ready after %v: %s", e.target.Engine, readyTimeout, last)
}

func rowsJSON(res *protocol.DBQueryResult) string {
	b, _ := json.Marshal(res.Rows)
	return string(b)
}

func raw(stmt string, params ...*string) protocol.DBOp {
	return protocol.DBOp{Type: protocol.DBOpRaw, Statement: stmt, Params: params}
}

func start(t *testing.T, c *docker.Client, network, engine string, port int, spec docker.ContainerCreate) *engineEnv {
	spec.HostConfig.NetworkMode = network
	id := dockertest.Run(t, c, dockertest.Unique("roundhouse-it-dbq-"+engine+"-"), spec)
	return &engineEnv{
		r:         dbquery.New(dbquery.Options{}),
		container: id,
		target:    dbquery.Target{Engine: engine, Host: dockertest.IP(t, c, id, network), Port: port},
	}
}

func TestEngines(t *testing.T) {
	c := dockertest.Client(t)
	network := dockertest.Unique("roundhouse-it-dbq-")
	dockertest.Network(t, c, network, nil)
	dockertest.Attach(t, c, network)

	t.Run("postgres", func(t *testing.T) { t.Parallel(); testPostgres(t, c, network) })
	t.Run("mysql", func(t *testing.T) { t.Parallel(); testMySQL(t, c, network) })
	t.Run("redis", func(t *testing.T) { t.Parallel(); testRedis(t, c, network) })
	t.Run("mongodb", func(t *testing.T) { t.Parallel(); testMongo(t, c, network) })
}

func testPostgres(t *testing.T, c *docker.Client, network string) {
	e := start(t, c, network, dbquery.EnginePostgres, 5432, docker.ContainerCreate{
		Image: postgresImage,
		Env:   []string{"POSTGRES_USER=postgres", "POSTGRES_PASSWORD=" + adminPassword, "POSTGRES_DB=app"},
	})
	e.target.Database = "app"
	e.admin = dbquery.Credential{Username: "postgres", Password: adminPassword, ReadonlyPassword: "first-" + roPassword}
	e.ro = dbquery.Credential{Username: dbquery.ReadonlyUser, Password: roPassword}
	e.waitReady(t)

	e.ok(t, e.admin, "write", protocol.DBOp{Type: protocol.DBOpProvisionReadonly})
	e.fails(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpListNamespaces}, "authentication failed")
	e.admin.ReadonlyPassword = roPassword
	e.ok(t, e.admin, "write", protocol.DBOp{Type: protocol.DBOpProvisionReadonly})

	e.ok(t, e.admin, "write", raw(`CREATE TABLE items (id int8 PRIMARY KEY, name text, data bytea, at timestamptz, n numeric, tags text[], doc jsonb, small int4)`))
	res := e.ok(t, e.admin, "write", raw(`INSERT INTO items
SELECT g, 'item ' || g, '\x00ff'::bytea, '2026-01-02T03:04:05Z', 1.5, ARRAY['a'], '{"k": 1}', g FROM generate_series(1, 3) g`))
	if *res.RowCount != 3 || len(*res.Columns) != 0 {
		t.Fatalf("insert row count %+v", res)
	}

	res = e.ok(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpListNamespaces})
	if !strings.Contains(rowsJSON(res), `"public"`) {
		t.Fatalf("namespaces %s", rowsJSON(res))
	}
	res = e.ok(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpListTables})
	if !strings.Contains(rowsJSON(res), `["items","table"`) {
		t.Fatalf("tables %s", rowsJSON(res))
	}
	res = e.ok(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpDescribe, Table: "items"})
	if !strings.HasPrefix(rowsJSON(res), `[["id","bigint",false,null,true],["name","text",true,null,false]`) {
		t.Fatalf("describe %s", rowsJSON(res))
	}
	res = e.ok(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpRows, Table: "items", OrderBy: "id", Descending: ptr(true), Offset: ptr(1)})
	want := `[["2","item 2",{"$b64":"AP8="},"2026-01-02T03:04:05Z","1.5",["a"],{"k":1},2],["1","item 1",{"$b64":"AP8="},"2026-01-02T03:04:05Z","1.5",["a"],{"k":1},1]]`
	if rowsJSON(res) != want || *res.RowCount != 2 || res.Truncated != nil {
		t.Fatalf("rows\n got %s\nwant %s", rowsJSON(res), want)
	}
	if cols := *res.Columns; cols[0].Type != "int8" || cols[2].Type != "bytea" {
		t.Fatalf("columns %+v", cols)
	}
	e.fails(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpRows, Table: "items", OrderBy: "nope", Offset: ptr(0)}, "no such column")
	e.fails(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpRows, Table: "missing", Offset: ptr(0)}, "not found")

	res = e.ok(t, e.ro, "read", raw(`SELECT name FROM items WHERE id = $1 OR name = $2`, ptr("3"), nil))
	if rowsJSON(res) != `[["item 3"]]` {
		t.Fatalf("params %s", rowsJSON(res))
	}
	res = e.ok(t, e.ro, "read", raw(`SELECT g FROM generate_series(1, 1000000) g`))
	if len(*res.Rows) != 100 || res.Truncated == nil || !*res.Truncated {
		t.Fatalf("truncation: %d rows, truncated %v", len(*res.Rows), res.Truncated)
	}
	res = e.ok(t, e.ro, "read", raw(`SELECT repeat('x', 1000) FROM generate_series(1, 50)`), func(q *protocol.DBQuery) { q.MaxBytes = 5000 })
	if len(*res.Rows) != 4 || !strings.Contains(res.Notice, "5000 bytes") {
		t.Fatalf("byte cap: %d rows, notice %q", len(*res.Rows), res.Notice)
	}
	begin := time.Now()
	sleep := e.run(t, e.ro, "read", raw(`SELECT pg_sleep(10)`), func(q *protocol.DBQuery) { q.TimeoutMS = 300 })
	if sleep.OK || time.Since(begin) > 5*time.Second {
		t.Fatalf("statement timeout: %+v after %v", sleep, time.Since(begin))
	}

	e.fails(t, e.ro, "read", raw(`INSERT INTO items (id) VALUES (9)`), "read-only mode")
	e.fails(t, e.admin, "read", raw(`INSERT INTO items (id) VALUES (9)`), "read-only mode")
	e.fails(t, e.ro, "write", raw(`INSERT INTO items (id) VALUES (9)`), "read-only")
	e.fails(t, e.ro, "read", raw(`SELECT 1; DROP TABLE items`), "one statement")
	e.fails(t, e.admin, "write", raw(`SELECT 1; DROP TABLE items`), "one statement")
	res = e.ok(t, e.admin, "write", raw(`UPDATE items SET name = $1 WHERE id = 1`, ptr("renamed")))
	if *res.RowCount != 1 {
		t.Fatalf("update row count %d", *res.RowCount)
	}
	res = e.ok(t, e.ro, "read", raw(`SELECT count(*), max(name) FROM items`))
	if rowsJSON(res) != `[["3","renamed"]]` {
		t.Fatalf("after writes %s", rowsJSON(res))
	}
	e.ok(t, e.admin, "write", raw(`CREATE DATABASE other`))
}

func testMySQL(t *testing.T, c *docker.Client, network string) {
	e := start(t, c, network, dbquery.EngineMySQL, 3306, docker.ContainerCreate{
		Image: mysqlImage,
		Env:   []string{"MYSQL_ROOT_PASSWORD=" + adminPassword, "MYSQL_DATABASE=app"},
	})
	e.target.Database = "app"
	e.admin = dbquery.Credential{Username: "root", Password: adminPassword, ReadonlyPassword: "first-" + roPassword}
	e.ro = dbquery.Credential{Username: dbquery.ReadonlyUser, Password: roPassword}
	e.waitReady(t)

	e.ok(t, e.admin, "write", protocol.DBOp{Type: protocol.DBOpProvisionReadonly})
	e.fails(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpListNamespaces}, "authentication failed")
	e.admin.ReadonlyPassword = roPassword
	e.ok(t, e.admin, "write", protocol.DBOp{Type: protocol.DBOpProvisionReadonly})

	e.ok(t, e.admin, "write", raw("CREATE TABLE items (id BIGINT PRIMARY KEY, name VARCHAR(50), data BLOB, at DATETIME, n DECIMAL(10,2), flag BIT(1), small INT)"))
	res := e.ok(t, e.admin, "write", raw("INSERT INTO items VALUES (1, 'item 1', x'00ff', '2026-01-02 03:04:05', 1.50, b'1', 1), (2, 'item 2', NULL, NULL, NULL, b'0', 2), (3, ?, NULL, NULL, NULL, NULL, 3)", ptr("item 3")))
	if *res.RowCount != 3 {
		t.Fatalf("insert row count %+v", res)
	}

	res = e.ok(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpListNamespaces})
	if rowsJSON(res) != `[["app"]]` {
		t.Fatalf("namespaces %s", rowsJSON(res))
	}
	res = e.ok(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpListTables})
	if !strings.HasPrefix(rowsJSON(res), `[["items","base table"`) {
		t.Fatalf("tables %s", rowsJSON(res))
	}
	res = e.ok(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpDescribe, Table: "items"})
	if !strings.HasPrefix(rowsJSON(res), `[["id","bigint",false,null,true],["name","varchar(50)",true,null,false]`) {
		t.Fatalf("describe %s", rowsJSON(res))
	}
	res = e.ok(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpRows, Table: "items", OrderBy: "id", Offset: ptr(0)})
	want := `[["1","item 1",{"$b64":"AP8="},"2026-01-02T03:04:05Z","1.50","1","1"],["2","item 2",null,null,null,"0","2"],["3","item 3",null,null,null,null,"3"]]`
	if rowsJSON(res) != want {
		t.Fatalf("rows\n got %s\nwant %s", rowsJSON(res), want)
	}
	e.fails(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpRows, Table: "items", OrderBy: "nope", Offset: ptr(0)}, "no such column")

	res = e.ok(t, e.ro, "read", raw("SELECT name FROM items WHERE id = ?", ptr("2")))
	if rowsJSON(res) != `[["item 2"]]` {
		t.Fatalf("params %s", rowsJSON(res))
	}
	res = e.ok(t, e.ro, "read", raw("SELECT a.column_name FROM information_schema.columns a, information_schema.columns b"))
	if len(*res.Rows) != 100 || res.Truncated == nil || !*res.Truncated {
		t.Fatalf("truncation: %d rows", len(*res.Rows))
	}
	begin := time.Now()
	e.run(t, e.ro, "read", raw("SELECT SLEEP(10)"), func(q *protocol.DBQuery) { q.TimeoutMS = 300 })
	if time.Since(begin) > 5*time.Second {
		t.Fatalf("statement timeout took %v", time.Since(begin))
	}

	e.fails(t, e.ro, "read", raw("INSERT INTO items (id) VALUES (9)"), "read-only mode")
	e.fails(t, e.admin, "read", raw("INSERT INTO items (id) VALUES (9)"), "read-only mode")
	e.fails(t, e.ro, "write", raw("INSERT INTO items (id) VALUES (9)"), "denied")
	e.fails(t, e.ro, "read", raw("SELECT 1; DROP TABLE items"), "syntax")
	e.fails(t, e.ro, "read", raw("SELECT authentication_string FROM mysql.user"), "denied")
	e.fails(t, e.admin, "write", raw("SELECT 1; DROP TABLE items"), "syntax")
	res = e.ok(t, e.admin, "write", raw("UPDATE items SET name = ? WHERE id = 1", ptr("renamed")))
	if *res.RowCount != 1 {
		t.Fatalf("update row count %d", *res.RowCount)
	}
	res = e.ok(t, e.ro, "read", raw("SELECT COUNT(*) FROM items"))
	if rowsJSON(res) != `[["3"]]` {
		t.Fatalf("after writes %s", rowsJSON(res))
	}
}

func testRedis(t *testing.T, c *docker.Client, network string) {
	e := start(t, c, network, dbquery.EngineRedis, 6379, docker.ContainerCreate{
		Image: valkeyImage,
		Env:   []string{"REDIS_PASSWORD=" + adminPassword, "ROUNDHOUSE_RO_PASSWORD=" + roPassword},
		// NOTE: each ACL rule is its own argument; quoted as one, the server
		// reads the whole string as the user name and exits.
		Entrypoint: []string{"sh", "-c", `exec docker-entrypoint.sh valkey-server --requirepass "$REDIS_PASSWORD"` +
			` --user roundhouse_ro on ">$ROUNDHOUSE_RO_PASSWORD" "~*" "&*" +@read -@dangerous +info +select +ping --appendonly yes`},
	})
	e.admin = dbquery.Credential{Username: "default", Password: adminPassword, ReadonlyPassword: roPassword}
	e.ro = dbquery.Credential{Username: dbquery.ReadonlyUser, Password: roPassword}
	e.waitReady(t)

	e.ok(t, e.admin, "write", protocol.DBOp{Type: protocol.DBOpProvisionReadonly})
	argv := func(a ...string) protocol.DBOp { return protocol.DBOp{Type: protocol.DBOpRaw, Argv: a} }
	e.ok(t, e.admin, "write", argv("SET", "s", "hello"))
	e.ok(t, e.admin, "write", argv("HSET", "h", "f", "v", "g", "w"))
	list := []string{"RPUSH", "l"}
	for i := range 300 {
		list = append(list, "x"+string(rune('a'+i%26)))
	}
	e.ok(t, e.admin, "write", argv(list...))
	e.ok(t, e.admin, "write", argv("ZADD", "z", "1.5", "a", "2", "b"))
	e.ok(t, e.admin, "write", argv("SADD", "set", "m1", "m2"))
	e.ok(t, e.admin, "write", argv("XADD", "st", "1-1", "k", "v"))
	e.ok(t, e.admin, "write", argv("SET", "bin", "\xff\x00"))

	res := e.ok(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpListNamespaces})
	if !strings.HasPrefix(rowsJSON(res), `[["0","7"]`) {
		t.Fatalf("namespaces %s", rowsJSON(res))
	}
	res = e.ok(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpListTables, Pattern: "*"})
	if len(*res.Rows) != 7 || res.Notice != "cursor:0" {
		t.Fatalf("keys %s notice %q", rowsJSON(res), res.Notice)
	}
	for key, want := range map[string]string{
		"s":   `[["hello"]]`,
		"h":   `[["f","v"],["g","w"]]`,
		"z":   `[["a",1.5],["b",2]]`,
		"st":  `[["1-1",{"k":"v"}]]`,
		"bin": `[[{"$b64":"/wA="}]]`,
	} {
		res = e.ok(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpRows, Table: key, Offset: ptr(0)})
		got := rowsJSON(res)
		if key == "h" && got == `[["g","w"],["f","v"]]` {
			got = want
		}
		if got != want {
			t.Errorf("rows of %s: %s, want %s", key, got, want)
		}
	}
	res = e.ok(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpRows, Table: "l", Offset: ptr(10)})
	if len(*res.Rows) != 100 || !*res.Truncated || rowsJSON(res)[:12] != `[["10","xk"]` {
		t.Fatalf("list rows %d %s", len(*res.Rows), rowsJSON(res)[:40])
	}
	res = e.ok(t, e.ro, "read", argv("LRANGE", "l", "0", "-1"))
	if len(*res.Rows) != 100 || !*res.Truncated {
		t.Fatalf("LRANGE cap: %d rows", len(*res.Rows))
	}
	res = e.ok(t, e.ro, "read", argv("mget", "s", "missing"))
	if rowsJSON(res) != `[["hello"],[null]]` {
		t.Fatalf("MGET %s", rowsJSON(res))
	}

	e.fails(t, e.ro, "read", argv("SET", "s", "x"), "read-only mode")
	e.fails(t, e.admin, "read", argv("DEL", "s"), "read-only mode")
	e.fails(t, e.ro, "write", argv("SET", "s", "x"), "NOPERM")
	e.ok(t, e.ro, "read", argv("INFO", "server"))
	e.fails(t, e.admin, "write", argv("HELLO", "3"), "not allowed")
	e.fails(t, dbquery.Credential{Username: dbquery.ReadonlyUser, Password: "wrong-password"}, "read", argv("GET", "s"), "authentication failed")
	res = e.ok(t, e.ro, "read", argv("GET", "s"))
	if rowsJSON(res) != `[["hello"]]` {
		t.Fatalf("value changed: %s", rowsJSON(res))
	}
}

func testMongo(t *testing.T, c *docker.Client, network string) {
	e := start(t, c, network, dbquery.EngineMongoDB, 27017, docker.ContainerCreate{
		Image: mongoImage,
		Env:   []string{"MONGO_INITDB_ROOT_USERNAME=root", "MONGO_INITDB_ROOT_PASSWORD=" + adminPassword},
	})
	e.target.Database = "app"
	e.admin = dbquery.Credential{Username: "root", Password: adminPassword, ReadonlyPassword: "first-" + roPassword}
	e.ro = dbquery.Credential{Username: dbquery.ReadonlyUser, Password: roPassword}
	e.waitReady(t)

	e.ok(t, e.admin, "write", protocol.DBOp{Type: protocol.DBOpProvisionReadonly})
	e.fails(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpListNamespaces}, "authentication failed")
	e.admin.ReadonlyPassword = roPassword
	e.ok(t, e.admin, "write", protocol.DBOp{Type: protocol.DBOpProvisionReadonly})

	docs := `{"insert": "items", "documents": [
{"_id": 1, "name": "item 1", "n": {"$numberLong": "9007199254740993"}, "at": {"$date": "2026-01-02T03:04:05Z"}, "bin": {"$binary": {"base64": "AP8=", "subType": "00"}}},
{"_id": 2, "name": "item 2", "extra": true},
{"_id": 3, "name": "item 3"}]}`
	res := e.ok(t, e.admin, "write", raw(docs))
	if !strings.Contains(rowsJSON(res), `[3]`) {
		t.Fatalf("insert %s", rowsJSON(res))
	}
	big := `{"insert": "big", "documents": [` + strings.TrimSuffix(strings.Repeat(`{"v": 1},`, 300), ",") + `]}`
	e.ok(t, e.admin, "write", raw(big))

	res = e.ok(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpListNamespaces})
	if !strings.Contains(rowsJSON(res), `"app"`) {
		t.Fatalf("namespaces %s", rowsJSON(res))
	}
	res = e.ok(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpListTables})
	if !strings.Contains(rowsJSON(res), `["items","collection"]`) {
		t.Fatalf("collections %s", rowsJSON(res))
	}
	res = e.ok(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpDescribe, Table: "items"})
	if !strings.Contains(rowsJSON(res), `["extra","boolean",1]`) {
		t.Fatalf("describe %s", rowsJSON(res))
	}
	res = e.ok(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpRows, Table: "items", OrderBy: "_id", Descending: ptr(true), Offset: ptr(2)})
	want := `[[1,"item 1","9007199254740993","2026-01-02T03:04:05Z",{"$b64":"AP8="}]]`
	if rowsJSON(res) != want {
		t.Fatalf("rows\n got %s\nwant %s", rowsJSON(res), want)
	}
	e.fails(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpRows, Table: "missing", Offset: ptr(0)}, "not found")
	res = e.ok(t, e.ro, "read", protocol.DBOp{Type: protocol.DBOpRows, Table: "big", Offset: ptr(0)})
	if len(*res.Rows) != 100 || !*res.Truncated {
		t.Fatalf("row cap: %d rows", len(*res.Rows))
	}

	res = e.ok(t, e.ro, "read", raw(`{"find": "items", "filter": {"extra": true}}`))
	if !strings.Contains(rowsJSON(res), `"item 2"`) || len(*res.Rows) != 1 {
		t.Fatalf("find %s", rowsJSON(res))
	}
	res = e.ok(t, e.ro, "read", raw(`{"aggregate": "big", "pipeline": [{"$group": {"_id": null, "n": {"$sum": 1}}}], "cursor": {}}`))
	if rowsJSON(res) != `[[null,300]]` {
		t.Fatalf("aggregate %s", rowsJSON(res))
	}
	res = e.ok(t, e.ro, "read", raw(`{"count": "items"}`))
	if rowsJSON(res) != `[[3]]` {
		t.Fatalf("count %s", rowsJSON(res))
	}
	res = e.ok(t, e.ro, "read", raw(`{"distinct": "items", "key": "name"}`))
	if len(*res.Rows) != 3 {
		t.Fatalf("distinct %s", rowsJSON(res))
	}

	e.fails(t, e.ro, "read", raw(`{"insert": "items", "documents": [{}]}`), "read-only mode")
	e.fails(t, e.admin, "read", raw(`{"aggregate": "items", "pipeline": [{"$lookup": {"from": "big", "as": "x", "pipeline": [{"$merge": "copy"}]}}], "cursor": {}}`), "read-only mode")
	e.fails(t, e.ro, "write", raw(`{"insert": "items", "documents": [{"_id": 9}]}`), "not authorized")
	e.fails(t, e.ro, "write", raw(`{"aggregate": "items", "pipeline": [{"$out": "copy"}], "cursor": {}}`), "not authorized")
	res = e.ok(t, e.admin, "write", raw(`{"update": "items", "updates": [{"q": {"_id": 1}, "u": {"$set": {"name": "renamed"}}}]}`))
	if !strings.Contains(rowsJSON(res), `1`) {
		t.Fatalf("update %s", rowsJSON(res))
	}
	res = e.ok(t, e.ro, "read", raw(`{"count": "items"}`))
	if rowsJSON(res) != `[[3]]` {
		t.Fatalf("after writes %s", rowsJSON(res))
	}
}

// rotate sets user's password from old to next as the admin, then proves
// next works and old no longer does. mode is how user connects.
func (e *engineEnv) rotate(t *testing.T, user, mode, old, next string) {
	t.Helper()
	admin := e.admin
	admin.NewPassword = next
	res := e.ok(t, admin, "write", protocol.DBOp{Type: protocol.DBOpSetPassword, User: user})
	if res.Notice != "password set for "+user {
		t.Fatalf("set_password %s: notice %q", user, res.Notice)
	}
	e.ok(t, dbquery.Credential{Username: user, Password: next}, mode, protocol.DBOp{Type: protocol.DBOpListNamespaces})
	e.fails(t, dbquery.Credential{Username: user, Password: old}, mode, protocol.DBOp{Type: protocol.DBOpListNamespaces}, "authentication failed")
}

func TestSetPassword(t *testing.T) {
	c := dockertest.Client(t)
	network := dockertest.Unique("roundhouse-it-dbq-pw-")
	dockertest.Network(t, c, network, nil)
	dockertest.Attach(t, c, network)
	setPw := func(user string) protocol.DBOp { return protocol.DBOp{Type: protocol.DBOpSetPassword, User: user} }

	t.Run("postgres", func(t *testing.T) {
		t.Parallel()
		e := start(t, c, network, dbquery.EnginePostgres, 5432, docker.ContainerCreate{
			Image: postgresImage,
			Env:   []string{"POSTGRES_USER=postgres", "POSTGRES_PASSWORD=" + adminPassword, "POSTGRES_DB=app"},
		})
		e.target.Database = "app"
		e.admin = dbquery.Credential{Username: "postgres", Password: adminPassword, ReadonlyPassword: roPassword}
		e.waitReady(t)

		admin := e.admin
		admin.NewPassword = newROPassword
		e.fails(t, admin, "write", setPw(dbquery.ReadonlyUser), "does not exist")
		e.fails(t, admin, "write", setPw("someone_else"), "changes only")
		e.ok(t, e.admin, "write", protocol.DBOp{Type: protocol.DBOpProvisionReadonly})

		e.rotate(t, dbquery.ReadonlyUser, "read", roPassword, newROPassword)
		e.rotate(t, "postgres", "write", adminPassword, newAdminPassword)
		e.admin.Password = newAdminPassword
		e.ok(t, e.admin, "write", raw(`CREATE TABLE after_rotation (id int)`))
	})

	t.Run("mysql", func(t *testing.T) {
		t.Parallel()
		e := start(t, c, network, dbquery.EngineMySQL, 3306, docker.ContainerCreate{
			Image: mysqlImage,
			Env: []string{"MYSQL_ROOT_PASSWORD=" + adminPassword, "MYSQL_DATABASE=app",
				"MYSQL_USER=app", "MYSQL_PASSWORD=" + appPassword},
		})
		e.target.Database, e.target.AppUser = "app", "app"
		e.admin = dbquery.Credential{Username: "root", Password: adminPassword, ReadonlyPassword: roPassword}
		e.waitReady(t)
		e.ok(t, e.admin, "write", protocol.DBOp{Type: protocol.DBOpProvisionReadonly})

		admin := e.admin
		admin.NewPassword = newROPassword
		e.fails(t, admin, "write", setPw("mysql.sys"), "changes only")

		e.rotate(t, dbquery.ReadonlyUser, "read", roPassword, newROPassword)
		e.rotate(t, "app", "read", appPassword, newAppPassword)
		e.rotate(t, "root", "write", adminPassword, newAdminPassword)
		e.admin.Password = newAdminPassword

		// root@'localhost' changed too: the socket login inside the
		// container takes the new password.
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		code, err := c.RunExec(ctx, e.container, docker.ExecRun{
			Cmd: []string{"mysql", "-uroot", "-e", "SELECT 1"}, Env: []string{"MYSQL_PWD=" + newAdminPassword},
		})
		if err != nil || code != 0 {
			t.Fatalf("root@localhost with the new password: code %d, %v", code, err)
		}
	})

	t.Run("redis", func(t *testing.T) {
		t.Parallel()
		e := start(t, c, network, dbquery.EngineRedis, 6379, docker.ContainerCreate{
			Image: valkeyImage,
			Env:   []string{"REDIS_PASSWORD=" + adminPassword, "ROUNDHOUSE_RO_PASSWORD=" + roPassword},
			Entrypoint: []string{"sh", "-c", `exec docker-entrypoint.sh valkey-server --requirepass "$REDIS_PASSWORD"` +
				` --user roundhouse_ro on ">$ROUNDHOUSE_RO_PASSWORD" "~*" "&*" +@read -@dangerous +info +select +ping --appendonly yes`},
		})
		e.admin = dbquery.Credential{Username: "default", Password: adminPassword}
		e.waitReady(t)

		e.rotate(t, dbquery.ReadonlyUser, "read", roPassword, newROPassword)
		e.rotate(t, "default", "write", adminPassword, newAdminPassword)
		e.admin.Password = newAdminPassword
		e.ok(t, e.admin, "write", protocol.DBOp{Type: protocol.DBOpRaw, Argv: []string{"SET", "k", "v"}})
	})

	t.Run("mongodb", func(t *testing.T) {
		t.Parallel()
		e := start(t, c, network, dbquery.EngineMongoDB, 27017, docker.ContainerCreate{
			Image: mongoImage,
			Env:   []string{"MONGO_INITDB_ROOT_USERNAME=root", "MONGO_INITDB_ROOT_PASSWORD=" + adminPassword},
		})
		e.admin = dbquery.Credential{Username: "root", Password: adminPassword, ReadonlyPassword: roPassword}
		e.waitReady(t)

		admin := e.admin
		admin.NewPassword = newROPassword
		e.fails(t, admin, "write", setPw(dbquery.ReadonlyUser), "does not exist")
		e.ok(t, e.admin, "write", protocol.DBOp{Type: protocol.DBOpProvisionReadonly})

		e.rotate(t, dbquery.ReadonlyUser, "read", roPassword, newROPassword)
		e.rotate(t, "root", "write", adminPassword, newAdminPassword)
	})
}
