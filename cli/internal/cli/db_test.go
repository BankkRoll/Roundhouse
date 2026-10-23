package cli

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

const gib = 1024 * mib

// seedPostgres makes the seeded db service a PostgreSQL 17 database with a
// 5 GiB volume, 1.2 GiB used, in production.
func seedPostgres(h *harness) {
	h.fake.SeedDatabase(apitest.DBServiceID, "postgres", "17", 5120, 1.2*gib)
}

func TestDBCreate(t *testing.T) {
	h := newHarness(t)
	h.link()

	r := h.ok("", "db", "create", "--engine", "postgres")
	for _, want := range []string{
		"✓ Added PostgreSQL 18 database PostgreSQL (postgres) to Shop",
		"5.0 GiB in each environment, mounted at /var/lib/postgresql",
		"generated as write-only secrets (DATABASE_URL, PGPASSWORD, POSTGRES_PASSWORD, ROUNDHOUSE_RO_PASSWORD)",
		"in production; follow it with `roundhouse logs --deployment",
		"roundhouse vars set 'DATABASE_URL=${{postgres.DATABASE_URL}}' --service <app>",
	} {
		contains(t, r.stdout, want)
	}
	notContains(t, r.stdout, apitest.SecretValue)
	body := lastBody(t, h, api.RouteCreateDatabase.String())
	if body["engine"] != "postgres" || body["environment_id"] != apitest.ProductionID || body["deploy"] != true ||
		body["version"] != nil || body["size_mb"] != nil {
		t.Errorf("create body = %v", body)
	}

	r = h.ok("", "db", "create", "--engine", "pg", "--version", "16", "--size-mb", "1024", "--name", "Reports",
		"--environment", "staging", "--no-deploy", "--json")
	var created api.CreatedDatabase
	if err := json.Unmarshal([]byte(r.stdout), &created); err != nil {
		t.Fatal(err)
	}
	if created.Service.Slug != "postgres-2" || created.Version != "16" || len(created.DeploymentIDs) != 0 ||
		created.Service.Database == nil || created.Service.Database.Engine != "postgres" || len(created.Volumes) != 2 || created.Volumes[0].SizeMB != 1024 {
		t.Errorf("created = %+v", created)
	}
	body = lastBody(t, h, api.RouteCreateDatabase.String())
	if body["deploy"] != false || body["environment_id"] != apitest.StagingID || body["name"] != "Reports" {
		t.Errorf("create body = %v", body)
	}

	r = h.ok("", "db", "create", "--engine", "redis", "--no-deploy")
	contains(t, r.stdout, "Added Valkey 9 database Valkey (redis)")
	contains(t, r.stdout, "deploy it with `roundhouse deploy --service redis`")
	contains(t, r.stdout, "'REDIS_URL=${{redis.REDIS_URL}}'")
}

func TestDBCreateErrors(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.expect(exitcode.Usage, "", "db", "create", "--engine", "oracle")
	contains(t, r.stderr, `unknown --engine "oracle"; use one of postgres, mysql, redis, mongodb`)
	h.expect(exitcode.Usage, "", "db", "create")
	r = h.expect(exitcode.Usage, "", "db", "create", "--engine", "mysql", "--size-mb", "10")
	contains(t, r.stderr, "--size-mb must be between 256 and 1048576")
	r = h.expect(exitcode.NotFound, "", "db", "create", "--engine", "mysql", "--version", "5.7")
	contains(t, r.stderr, "MySQL 5.7 is not available")

	r = h.expect(exitcode.NotFound, "", "db", "create", "--engine", "mysql", "--json", "--version", "5.7")
	var out struct {
		Error struct {
			Code     string `json:"code"`
			Status   int    `json:"status"`
			ExitCode int    `json:"exit_code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(r.stderr), &out); err != nil || out.Error.Code != "not_found" || out.Error.Status != 404 || out.Error.ExitCode != exitcode.NotFound {
		t.Errorf("json error = %s (%v)", r.stderr, err)
	}

	h.env[EnvToken] = h.fake.AddToken("ci", "workspace:read", "projects:read", "services:read")
	r = h.expect(exitcode.Forbidden, "", "db", "create", "--engine", "mysql")
	contains(t, r.stderr, "lacks the services:manage scope")
}

func TestDBList(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "db", "list")
	contains(t, r.stdout, "No databases in Shop. Add one with `roundhouse db create --engine postgres`.")
	r = h.ok("", "db", "list", "--json")
	if strings.TrimSpace(r.stdout) != "[]" {
		t.Errorf("empty --json = %q", r.stdout)
	}

	seedPostgres(h)
	r = h.ok("", "db", "list")
	lines := strings.Split(strings.TrimSpace(r.stdout), "\n")
	if len(lines) != 2 || strings.Join(strings.Fields(lines[0]), " ") != "NAME SLUG ENGINE VOLUME USAGE SERVER" {
		t.Fatalf("db list:\n%s", r.stdout)
	}
	for _, want := range []string{"Postgres", "db", "PostgreSQL 17", "ready", "1.2 GiB / 5.0 GiB (24%)", "edge-1"} {
		contains(t, lines[1], want)
	}
	notContains(t, r.stdout, "API")

	r = h.ok("", "db", "list", "--environment", "staging")
	contains(t, r.stdout, "pending")
	contains(t, r.stdout, "- / 5.0 GiB")

	r = h.ok("", "db", "list", "--json")
	var items []struct {
		Service api.Service `json:"service"`
		Engine  string      `json:"engine"`
		Version string      `json:"version"`
		Volume  *api.Volume `json:"volume"`
	}
	if err := json.Unmarshal([]byte(r.stdout), &items); err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Engine != "postgres" || items[0].Version != "17" || items[0].Volume == nil ||
		items[0].Volume.Status != "ready" || items[0].Service.Database == nil {
		t.Errorf("items = %+v", items)
	}
}

func TestDBInfo(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.expect(exitcode.NotFound, "", "db", "info")
	contains(t, r.stderr, "project Shop has no databases; add one with `roundhouse db create --engine postgres`")

	seedPostgres(h)
	// The directory is linked to the API service, so info picks the only database.
	r = h.ok("", "db", "info")
	for _, want := range []string{
		"Postgres (db) in production", "PostgreSQL 17", "ready on edge-1", "1.2 GiB / 5.0 GiB (24%)",
		"/var/lib/postgresql", "xfs_project",
		"DATABASE_URL", "${{db.DATABASE_URL}}", "${{db.PGHOST}}", "${{db.PGPASSWORD}}",
		"roundhouse vars set 'DATABASE_URL=${{db.DATABASE_URL}}' --service <app>",
	} {
		contains(t, r.stdout, want)
	}
	for _, secret := range []string{apitest.SecretValue, "postgresql://"} {
		notContains(t, r.stdout, secret)
	}

	r = h.ok("", "db", "info", "--environment", "staging", "--json")
	var info struct {
		Service       api.Service `json:"service"`
		EnvironmentID string      `json:"environment_id"`
		Engine        string      `json:"engine"`
		Volume        *api.Volume `json:"volume"`
		Connection    []struct {
			Key       string `json:"key"`
			Reference string `json:"reference"`
		} `json:"connection"`
	}
	if err := json.Unmarshal([]byte(r.stdout), &info); err != nil {
		t.Fatal(err)
	}
	if info.Service.ID != apitest.DBServiceID || info.EnvironmentID != apitest.StagingID || info.Volume == nil ||
		info.Volume.Status != "pending" || len(info.Connection) != 6 || info.Connection[0].Reference != "${{db.DATABASE_URL}}" {
		t.Errorf("info = %+v", info)
	}

	r = h.expect(exitcode.Conflict, "", "db", "info", "--service", "api")
	contains(t, r.stderr, "API is not a database service")
	h.expect(exitcode.NotFound, "", "db", "info", "--service", "nope")

	// Without variables:read the references come from the engine's template.
	h.env[EnvToken] = h.fake.AddToken("ro", "workspace:read", "projects:read", "services:read")
	r = h.ok("", "db", "info", "--service", "db")
	contains(t, r.stdout, "${{db.PGDATABASE}}")
}

func TestDBQuery(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)
	var got api.DatabaseQueryInput
	h.fake.OnQuery(func(_ string, in api.DatabaseQueryInput) api.DatabaseQueryResult {
		got = in
		n := 3
		return api.DatabaseQueryResult{RequestID: "dbq_1", OK: true, DurationMS: 12, RowCount: &n, Truncated: true, Notice: "1 warning",
			Columns: []api.QueryColumn{{Name: "id", Type: "int8"}, {Name: "email", Type: "text"}, {Name: "doc", Type: "jsonb"}, {Name: "avatar", Type: "bytea"}, {Name: "note", Type: "text"}},
			Rows: [][]any{
				{"1", "ada@example.com", map[string]any{"a": 1}, map[string]any{"$b64": "AAEC"}, nil},
				{"2", "evil\x1b[31m@example.com", []any{1, 2}, nil, "line1\nline2"},
				{"3", strings.Repeat("x", 100), true, nil, 4.5},
			}}
	})

	r := h.ok("", "db", "query", "SELECT * FROM users WHERE id > $1", "--param", "0", "--max-rows", "3", "--timeout", "5s")
	lines := strings.Split(r.stdout, "\n")
	if strings.Join(strings.Fields(lines[0]), " ") != "ID EMAIL DOC AVATAR NOTE" {
		t.Errorf("header = %q", lines[0])
	}
	for _, want := range []string{`{"a":1}`, "<binary, 3 bytes>", "NULL", `evil\u001b[31m@example.com`, `line1\nline2`, "[1,2]", "true", "4.5", strings.Repeat("x", 60) + "…"} {
		contains(t, r.stdout, want)
	}
	notContains(t, r.stdout, "\x1b")
	contains(t, r.stderr, "(3 rows in 12 ms)")
	contains(t, r.stderr, "note: the result was cut at 3 rows or its size cap; narrow the query or raise --max-rows (up to 1000)")
	contains(t, r.stderr, "note: 1 warning")
	if got.Mode != api.QueryRead || got.EnvironmentID != apitest.ProductionID || got.Op.Type != "raw" ||
		got.Op.Statement != "SELECT * FROM users WHERE id > $1" || len(got.Op.Params) != 1 || *got.Op.Params[0] != "0" ||
		got.MaxRows != 3 || got.TimeoutMS != 5000 {
		t.Errorf("query = %+v", got)
	}
	body := lastBody(t, h, api.RouteDatabaseQuery.String())
	if body["mode"] != "read" {
		t.Errorf("mode = %v", body["mode"])
	}

	r = h.ok("SELECT 1\n", "db", "query", "-", "--json")
	if got.Op.Statement != "SELECT 1" || got.MaxRows != 100 || got.TimeoutMS != 10000 {
		t.Errorf("stdin query = %+v", got)
	}
	var res api.DatabaseQueryResult
	if err := json.Unmarshal([]byte(r.stdout), &res); err != nil || !res.OK || len(res.Rows) != 3 || res.Rows[1][1] != "evil\x1b[31m@example.com" {
		t.Errorf("--json = %s (%v)", r.stdout, err)
	}
	if r.stderr != "" {
		t.Errorf("--json printed notes: %q", r.stderr)
	}
}

func TestDBQueryEngineError(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)
	h.fake.OnQuery(func(string, api.DatabaseQueryInput) api.DatabaseQueryResult {
		return api.DatabaseQueryResult{RequestID: "dbq_2", OK: false, Error: "cannot execute INSERT in a read-only transaction", DurationMS: 3}
	})
	r := h.expect(exitcode.Error, "", "db", "query", "INSERT INTO users VALUES (1)")
	contains(t, r.stderr, "error: the database refused the query: cannot execute INSERT in a read-only transaction")
	r = h.expect(exitcode.Error, "", "db", "query", "INSERT INTO users VALUES (1)", "--json")
	var res api.DatabaseQueryResult
	if err := json.Unmarshal([]byte(r.stdout), &res); err != nil || res.OK || res.Error == "" {
		t.Errorf("--json = %s", r.stdout)
	}
	if r.stderr != "" {
		t.Errorf("stderr = %q", r.stderr)
	}
}

func TestDBQueryUsage(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"db", "query"}, "takes 1 argument(s)"},
		{[]string{"db", "query", "SELECT 1", "--max-rows", "0"}, "--max-rows must be between 1 and 1000"},
		{[]string{"db", "query", "SELECT 1", "--max-rows", "1001"}, "--max-rows must be between 1 and 1000"},
		{[]string{"db", "query", "SELECT 1", "--timeout", "50ms"}, "--timeout must be between 100ms and 30s"},
		{[]string{"db", "query", "   "}, "the statement is empty"},
		{[]string{"db", "query", strings.Repeat("x", 64*1024+1)}, "the limit is 64 KiB"},
		{[]string{"db", "query", "SELECT 1", "--write"}, "unknown flag: --write"},
	} {
		r := h.expect(exitcode.Usage, "", c.args...)
		contains(t, r.stderr, c.want)
	}
	if n := len(metricsQueries(h, api.RouteDatabaseQuery)); n != 0 {
		t.Errorf("%d queries sent", n)
	}

	r := h.expect(exitcode.Conflict, "", "db", "query", "SELECT 1", "--service", "api")
	contains(t, r.stderr, "API is not a database service")

	// The staging volume has no server yet: the API answers 409.
	r = h.expect(exitcode.Conflict, "", "db", "query", "SELECT 1", "--environment", "staging")
	contains(t, r.stderr, "no running replica")

	h.env[EnvToken] = h.fake.AddToken("ro", "workspace:read", "projects:read", "services:read")
	r = h.expect(exitcode.Forbidden, "", "db", "query", "SELECT 1")
	contains(t, r.stderr, "lacks the data:read scope")
}

func TestDBQueryOtherEngines(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.SeedDatabase(apitest.DBServiceID, "redis", "valkey-9", 1024, 0)
	var got api.DatabaseQueryInput
	h.fake.OnQuery(func(_ string, in api.DatabaseQueryInput) api.DatabaseQueryResult {
		got = in
		return api.DatabaseQueryResult{RequestID: "dbq_3", OK: true, DurationMS: 1,
			Columns: []api.QueryColumn{{Name: "field", Type: "string"}, {Name: "value", Type: "string"}}, Rows: [][]any{{"user", "42"}}}
	})
	h.ok("", "db", "query", `HGETALL "session:42 a" 'x y' plain`)
	if got.Op.Statement != "" || strings.Join(got.Op.Argv, "|") != "HGETALL|session:42 a|x y|plain" {
		t.Errorf("redis op = %+v", got.Op)
	}
	r := h.expect(exitcode.Usage, "", "db", "query", `GET "unterminated`)
	contains(t, r.stderr, "unterminated quote")
	r = h.expect(exitcode.Usage, "", "db", "query", "GET k", "--param", "1")
	contains(t, r.stderr, "--param applies to SQL databases only")

	h.fake.SeedDatabase(apitest.DBServiceID, "mongodb", "9.0", 1024, 0)
	h.ok("", "db", "query", `{"find": "users", "limit": 5}`)
	if got.Op.Statement != `{"find": "users", "limit": 5}` || got.Op.Argv != nil {
		t.Errorf("mongo op = %+v", got.Op)
	}
	r = h.expect(exitcode.Usage, "", "db", "query", "db.users.find()")
	contains(t, r.stderr, "MongoDB takes a command document in JSON")
}

func TestDBTables(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)
	r := h.ok("", "db", "tables", "--namespace", "audit")
	for _, want := range []string{"Postgres (db) in production, PostgreSQL 17", "Namespaces: public, audit", "orders", "active_users", "view"} {
		contains(t, r.stdout, want)
	}
	body := lastBody(t, h, api.RouteDatabaseQuery.String())
	op, _ := body["op"].(map[string]any)
	if body["mode"] != "read" || op["type"] != "list_tables" || op["namespace"] != "audit" {
		t.Errorf("tables body = %v", body)
	}
	r = h.ok("", "db", "tables", "--json")
	var out struct {
		Engine     string                   `json:"engine"`
		Namespaces api.DatabaseQueryResult  `json:"namespaces"`
		Tables     *api.DatabaseQueryResult `json:"tables"`
	}
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil || out.Engine != "postgres" || len(out.Namespaces.Rows) != 2 || out.Tables == nil || len(out.Tables.Rows) != 3 {
		t.Errorf("--json = %s (%v)", r.stdout, err)
	}
	r = h.expect(exitcode.Usage, "", "db", "tables", "--pattern", "x*")
	contains(t, r.stderr, "--pattern and --cursor apply to Valkey and Redis only")

	h.fake.SeedDatabase(apitest.DBServiceID, "redis", "valkey-9", 1024, 0)
	h.fake.OnQuery(func(_ string, in api.DatabaseQueryInput) api.DatabaseQueryResult {
		res := api.DatabaseQueryResult{RequestID: "dbq_4", OK: true, Columns: []api.QueryColumn{{Name: "name", Type: "string"}}}
		if in.Op.Type == "list_tables" {
			res.Columns = append(res.Columns, api.QueryColumn{Name: "type", Type: "string"})
			res.Rows, res.Notice = [][]any{{"session:1", "hash"}}, "cursor:17"
		} else {
			res.Rows = [][]any{{"0"}}
		}
		return res
	})
	r = h.ok("", "db", "tables", "--pattern", "session:*")
	contains(t, r.stdout, "session:1")
	contains(t, r.stderr, "more keys: pass --cursor 17")
}

func TestDBVolume(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)
	vol := h.fake.Volume(apitest.DBServiceID, apitest.ProductionID)

	r := h.ok("", "db", "volume")
	for _, want := range []string{"Volume of Postgres in production", vol.ID + ", ready on edge-1", "1.2 GiB / 5.0 GiB (24%)", "xfs_project"} {
		contains(t, r.stdout, want)
	}
	r = h.ok("", "db", "volume", "--json")
	var v api.Volume
	if err := json.Unmarshal([]byte(r.stdout), &v); err != nil || v.ID != vol.ID {
		t.Errorf("--json = %s", r.stdout)
	}
	r = h.expect(exitcode.NotFound, "", "db", "volume", "--service", "api")
	contains(t, r.stderr, "API has no volume in production")

	r = h.ok("", "db", "volume", "resize", "--size-mb", "10240")
	contains(t, r.stdout, "✓ Grew the volume of Postgres in production from 5.0 GiB to 10.0 GiB")
	if got := h.fake.Volume(apitest.DBServiceID, apitest.ProductionID).SizeMB; got != 10240 {
		t.Errorf("size = %d", got)
	}
	r = h.expect(exitcode.Invalid, "", "db", "volume", "resize", "--size-mb", "2048")
	contains(t, r.stderr, "volumes only grow; Postgres's is 10240 MiB (10.0 GiB)")
	r = h.ok("", "db", "volume", "resize", "--size-mb", "10240")
	contains(t, r.stdout, "already 10.0 GiB; nothing changed")
	h.expect(exitcode.Usage, "", "db", "volume", "resize")
	h.expect(exitcode.Usage, "", "db", "volume", "resize", "--size-mb", "100")

	r = h.expect(exitcode.InputRequired, "", "db", "volume", "delete")
	contains(t, r.stderr, "pass --yes")
	r = h.interactive("n\n", "db", "volume", "delete")
	if r.code != exitcode.Error || !strings.Contains(r.stderr, "delete aborted") {
		t.Errorf("declined delete: exit %d, %s", r.code, r.stderr)
	}
	r = h.interactive("y\n", "db", "volume", "delete")
	if r.code != 0 {
		t.Fatalf("delete: exit %d, %s", r.code, r.stderr)
	}
	contains(t, r.stderr, "Its data is removed from edge-1 after 72 hours unless you undelete it.")
	contains(t, r.stdout, "✓ Deleted the volume of Postgres in production")
	contains(t, r.stdout, "Its data is removed 2026-10-25 12:00 UTC")
	if got := h.fake.Volume(apitest.DBServiceID, apitest.ProductionID).Status; got != api.VolumePendingDeletion {
		t.Errorf("status = %s", got)
	}
	r = h.ok("", "db", "info")
	contains(t, r.stdout, "data is removed 2026-10-25 12:00 UTC unless you run `roundhouse db volume undelete`")
	r = h.expect(exitcode.Conflict, "", "db", "volume", "delete", "--yes")
	contains(t, r.stderr, "The volume is pending deletion")

	r = h.ok("", "db", "volume", "undelete")
	contains(t, r.stdout, "✓ Undeleted the volume of Postgres in production; it is ready")
	r = h.expect(exitcode.Conflict, "", "db", "volume", "undelete")
	contains(t, r.stderr, "The volume is not deleted")

	h.ok("", "db", "volume", "delete", "--environment", "staging", "--yes", "--json")
	if got := h.fake.Volume(apitest.DBServiceID, apitest.StagingID).Status; got != api.VolumePendingDeletion {
		t.Errorf("staging status = %s", got)
	}
}

func TestDBPicksAmongDatabases(t *testing.T) {
	h := newHarness(t)
	h.link()
	seedPostgres(h)
	h.ok("", "db", "create", "--engine", "redis", "--name", "Cache", "--slug", "cache", "--no-deploy")

	r := h.expect(exitcode.InputRequired, "", "db", "info")
	contains(t, r.stderr, "pass --service")
	r = h.interactive("2\n", "db", "info")
	if r.code != 0 {
		t.Fatalf("exit %d: %s", r.code, r.stderr)
	}
	contains(t, r.stderr, "Cache (cache, Valkey 9)")
	contains(t, r.stdout, "${{cache.REDIS_URL}}")

	// A linked database needs no choice.
	h.ok("", "link", "--project", "shop", "--service", "db", "--gitignore=false")
	r = h.ok("", "db", "info")
	contains(t, r.stdout, "Postgres (db) in production")
}
