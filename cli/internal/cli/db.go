package cli

import (
	"cmp"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// engineNames are the engines' display names, from DATABASE_ENGINE_SPECS.
var engineNames = map[string]string{"postgres": "PostgreSQL", "mysql": "MySQL", "redis": "Valkey", "mongodb": "MongoDB"}

// engineAliases are other names `db create --engine` accepts.
var engineAliases = map[string]string{"postgresql": "postgres", "pg": "postgres", "valkey": "redis", "mongo": "mongodb"}

// connectionKeys are the reference-valued connection variables each engine
// gets, from engineVariables in packages/shared/src/databases.ts; the first
// is the one other services usually reference.
var connectionKeys = map[string][]string{
	"postgres": {"DATABASE_URL", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"},
	"mysql":    {"DATABASE_URL", "MYSQL_URL"},
	"redis":    {"REDIS_URL"},
	"mongodb":  {"MONGO_URL", "DATABASE_URL"},
}

// engineLabel names an engine version, e.g. "PostgreSQL 17" or "Valkey 9".
func engineLabel(engine, version string) string {
	name := engineNames[engine]
	if name == "" {
		name = engine
	}
	if engine == "redis" {
		if server, v, ok := strings.Cut(version, "-"); ok {
			if server == "redis" {
				return "Redis " + v
			}
			return "Valkey " + v
		}
	}
	if version == "" {
		return name
	}
	return name + " " + version
}

func reference(slug, key string) string {
	return "${{" + slug + "." + key + "}}"
}

func (a *App) dbCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "db",
		Aliases: []string{"database", "databases"},
		Short:   "Add, inspect, query, back up and operate database services",
		Long: `Work with the project's database services: PostgreSQL, MySQL, Valkey (or
Redis) and MongoDB, each with a volume, generated credentials and backups.

Commands act on --service, else the linked service when it is a database,
else the project's only database, and ask when there are several.
Credentials are write-only secrets: other services reference them, e.g.
DATABASE_URL=${{postgres.DATABASE_URL}}, and no command prints them.`,
		Example: `  roundhouse db create --engine postgres
  roundhouse db list
  roundhouse db query "SELECT count(*) FROM users"
  roundhouse db backups run --wait
  roundhouse db volume move --to edge-2 --wait
  roundhouse db tcp-proxy enable --allow 203.0.113.7
  roundhouse db rotate-credentials`,
		Args: noArgs,
	}
	cmd.AddCommand(a.dbCreateCmd(), a.dbListCmd(), a.dbInfoCmd(), a.dbQueryCmd(), a.dbTablesCmd(),
		a.dbVolumeCmd(), a.dbBackupsCmd(), a.dbTCPProxyCmd(), a.dbRotateCredentialsCmd(), a.dbRotationsCmd(), a.dbConnectCmd())
	return cmd
}

func (a *App) dbConnectCmd() *cobra.Command {
	// TODO(phase-4): needs a tunnel endpoint to reach a database's private
	// address from this machine.
	return a.stub("connect [SERVICE]", "Open a database client to a database service (not available yet)",
		`Connect psql, mysql or redis-cli to a database service through a tunnel.
This needs database tunnels the control plane does not offer yet. Until
then, "roundhouse db query" runs read-only queries.`,
		`  roundhouse db connect postgres`, maxArgs(1))
}

// -----------------------------------------------------------------------------
// Target
// -----------------------------------------------------------------------------

// databases lists the project's database services.
func databases(p *api.ProjectDetail) []api.Service {
	var out []api.Service
	for _, s := range p.Services {
		if s.Database != nil {
			out = append(out, s)
		}
	}
	return out
}

// resolveDatabase loads the target and picks its database: --service, else
// the linked service when it is a database, else the only database, else
// asks. With anyService, an explicitly named service need not be a
// database (volumes and backups also belong to other services).
func (a *App) resolveDatabase(ctx context.Context, f targetFlags, anyService bool) (*target, error) {
	t, err := a.resolve(ctx, f, serviceOptional)
	if err != nil {
		return nil, err
	}
	if f.service != "" {
		if t.service.Database == nil && !anyService {
			return nil, exitcode.New(exitcode.Conflict, "%s is not a database service; `roundhouse db list` shows the project's databases", t.service.Name)
		}
		return t, nil
	}
	if t.service != nil && t.service.Database != nil {
		return t, nil
	}
	dbs := databases(t.project)
	switch len(dbs) {
	case 0:
		return nil, exitcode.New(exitcode.NotFound, "project %s has no databases; add one with `roundhouse db create --engine postgres`", t.project.Name)
	case 1:
		t.service = &dbs[0]
		return t, nil
	}
	names := make([]string, len(dbs))
	for i, s := range dbs {
		names[i] = fmt.Sprintf("%s (%s, %s)", s.Name, s.Slug, engineLabel(s.Database.Engine, s.Database.Version))
	}
	i, err := a.IO.Select("Which database?", names, "pass --service")
	if err != nil {
		return nil, err
	}
	t.service = &dbs[i]
	return t, nil
}

// volumeOf returns the target service's volume, or nil when it has none.
func volumeOf(ctx context.Context, t *target) (*api.Volume, error) {
	v, err := t.sess.client.ServiceVolume(ctx, t.service.ID, t.env.ID)
	if api.IsStatus(err, http.StatusNotFound) {
		return nil, nil
	}
	return v, err
}

// requireVolume is volumeOf for commands that act on the volume.
func requireVolume(ctx context.Context, t *target) (*api.Volume, error) {
	v, err := volumeOf(ctx, t)
	if err == nil && v == nil {
		return nil, exitcode.New(exitcode.NotFound, "%s has no volume in %s", t.service.Name, t.env.Name)
	}
	return v, err
}

// -----------------------------------------------------------------------------
// db create
// -----------------------------------------------------------------------------

func (a *App) dbCreateCmd() *cobra.Command {
	var f targetFlags
	var engine, version, name, slug string
	var sizeMB int
	var noDeploy bool
	cmd := &cobra.Command{
		Use:     "create --engine ENGINE",
		Aliases: []string{"add"},
		Short:   "Add a database service to the project",
		Long: `Add a database service: a pinned image, a volume in every environment,
and generated credentials stored as write-only secrets with reference-valued
connection variables (DATABASE_URL, …). It is deployed to the environment
at once unless --no-deploy is given.

Engines: postgres, mysql, redis (Valkey by default) and mongodb. --version
picks a release, e.g. 17 or valkey-8; the newest is the default.`,
		Example: `  roundhouse db create --engine postgres
  roundhouse db create --engine postgres --version 17 --size-mb 20480 --name "Main DB"
  roundhouse db create --engine redis --name cache --environment staging`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			e := strings.ToLower(strings.TrimSpace(engine))
			if alias, ok := engineAliases[e]; ok {
				e = alias
			}
			if !slices.Contains(api.DatabaseEngines, e) {
				return exitcode.New(exitcode.Usage, "unknown --engine %q; use one of %s", engine, strings.Join(api.DatabaseEngines, ", "))
			}
			if cmd.Flags().Changed("size-mb") && (sizeMB < api.MinVolumeMB || sizeMB > api.MaxVolumeMB) {
				return exitcode.New(exitcode.Usage, "--size-mb must be between %d and %d", api.MinVolumeMB, api.MaxVolumeMB)
			}
			ctx := cmd.Context()
			t, err := a.resolve(ctx, f, serviceOptional)
			if err != nil {
				return err
			}
			created, err := t.sess.client.CreateDatabase(ctx, t.project.ID, api.CreateDatabaseInput{
				Engine: e, Version: version, SizeMB: sizeMB, EnvironmentID: t.env.ID, Name: name, Slug: slug, Deploy: !noDeploy,
			})
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(created)
			}
			a.printCreatedDatabase(t, created)
			return nil
		},
	}
	f.register(cmd, false)
	cmd.Flags().StringVar(&engine, "engine", "", "postgres, mysql, redis or mongodb")
	cmd.Flags().StringVar(&version, "version", "", "engine version, e.g. 17 or valkey-8 (default: the newest)")
	cmd.Flags().IntVar(&sizeMB, "size-mb", 0, fmt.Sprintf("volume size in MiB (default %d)", api.DefaultVolumeMB))
	cmd.Flags().StringVar(&name, "name", "", "service name (default: the engine's name)")
	cmd.Flags().StringVar(&slug, "slug", "", "slug, also its ${{slug.VAR}} reference namespace (default: the engine)")
	cmd.Flags().BoolVar(&noDeploy, "no-deploy", false, "create it without deploying")
	_ = cmd.MarkFlagRequired("engine")
	return cmd
}

func (a *App) printCreatedDatabase(t *target, c *api.CreatedDatabase) {
	pal := a.IO.OutColor()
	svc := c.Service
	fmt.Fprintf(a.IO.Out, "%s Added %s database %s (%s) to %s\n", pal.Green("✓"), engineLabel(c.Engine, c.Version), svc.Name, svc.Slug, t.project.Name)
	for _, v := range c.Volumes {
		if v.EnvironmentID == t.env.ID {
			fmt.Fprintf(a.IO.Out, "  %-12s %s in each environment, mounted at %s\n", "Volume", formatMiB(v.SizeMB), v.MountPath)
			break
		}
	}
	var secrets []string
	for _, v := range c.Variables {
		if v.Secret {
			secrets = append(secrets, v.Key)
		}
	}
	if len(secrets) > 0 {
		fmt.Fprintf(a.IO.Out, "  %-12s generated as write-only secrets (%s)\n", "Credentials", strings.Join(secrets, ", "))
	}
	if len(c.DeploymentIDs) > 0 {
		fmt.Fprintf(a.IO.Out, "  %-12s %s in %s; follow it with `roundhouse logs --deployment %s -f`\n", "Deploying", strings.Join(c.DeploymentIDs, ", "), t.env.Name, c.DeploymentIDs[0])
	} else {
		fmt.Fprintf(a.IO.Out, "  %-12s deploy it with `roundhouse deploy --service %s`\n", "Not deployed", svc.Slug)
	}
	for _, s := range c.Skipped {
		fmt.Fprintf(a.IO.Out, "  %-12s %s: %s\n", "Skipped", s.ServiceID, s.Reason)
	}
	if keys := connectionKeys[c.Engine]; len(keys) > 0 {
		fmt.Fprintf(a.IO.Out, "\nReference it from another service:\n  roundhouse vars set '%s=%s' --service <app>\n", keys[0], reference(svc.Slug, keys[0]))
	}
}

func formatMiB(mb int64) string {
	return formatBytes(float64(mb) * 1024 * 1024)
}

// -----------------------------------------------------------------------------
// db list
// -----------------------------------------------------------------------------

// dbListItem is one entry of `db list --json`.
type dbListItem struct {
	Service api.Service `json:"service"`
	Engine  string      `json:"engine"`
	Version string      `json:"version"`
	// Volume is nil when the database has no volume in the environment.
	Volume *api.Volume `json:"volume"`
}

func (a *App) dbListCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the project's databases with their volumes",
		Example: `  roundhouse db list
  roundhouse db list --environment staging --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolve(ctx, f, serviceOptional)
			if err != nil {
				return err
			}
			items := []dbListItem{}
			for _, s := range databases(t.project) {
				v, err := t.sess.client.ServiceVolume(ctx, s.ID, t.env.ID)
				if err != nil && !api.IsStatus(err, http.StatusNotFound) {
					return err
				}
				items = append(items, dbListItem{Service: s, Engine: s.Database.Engine, Version: s.Database.Version, Volume: v})
			}
			if a.jsonOut {
				return a.printJSON(items)
			}
			if len(items) == 0 {
				fmt.Fprintf(a.IO.Out, "No databases in %s. Add one with `roundhouse db create --engine postgres`.\n", t.project.Name)
				return nil
			}
			tb := a.newTable("name", "slug", "engine", "volume", "usage", "server")
			for _, it := range items {
				status, usage, server := "none", "-", "-"
				if v := it.Volume; v != nil {
					status, usage, server = v.Status, volumeUsage(v), orDash(deref(v.NodeName))
				}
				tb.row(it.Service.Name, it.Service.Slug, engineLabel(it.Engine, it.Version), status, usage, server)
			}
			tb.flush()
			return nil
		},
	}
	f.register(cmd, false)
	return cmd
}

// volumeUsage renders a volume's usage, e.g. "1.2 GiB / 5.0 GiB (24%)".
func volumeUsage(v *api.Volume) string {
	size := formatMiB(v.SizeMB)
	if v.UsedBytes == nil {
		return "- / " + size
	}
	pct := 0.0
	if v.SizeMB > 0 {
		pct = *v.UsedBytes / (float64(v.SizeMB) * 1024 * 1024) * 100
	}
	return fmt.Sprintf("%s / %s (%.0f%%)", formatBytes(*v.UsedBytes), size, pct)
}

// -----------------------------------------------------------------------------
// db info
// -----------------------------------------------------------------------------

// dbReference is a connection variable and the reference that reads it.
type dbReference struct {
	Key       string `json:"key"`
	Reference string `json:"reference"`
}

// dbInfo is the --json output of `db info`.
type dbInfo struct {
	Service       api.Service   `json:"service"`
	EnvironmentID string        `json:"environment_id"`
	Engine        string        `json:"engine"`
	Version       string        `json:"version"`
	Volume        *api.Volume   `json:"volume"`
	Connection    []dbReference `json:"connection"`
}

func (a *App) dbInfoCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:     "info",
		Aliases: []string{"show"},
		Short:   "Show a database's engine, volume and connection references",
		Long: `Show a database's engine and version, its volume in the environment, and
the variable references other services use to connect, such as
${{postgres.DATABASE_URL}}. Credentials are write-only secrets; no value is
ever shown.`,
		Example: `  roundhouse db info
  roundhouse db info --service cache --environment staging --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, false)
			if err != nil {
				return err
			}
			v, err := volumeOf(ctx, t)
			if err != nil {
				return err
			}
			refs, err := connectionRefs(ctx, t)
			if err != nil {
				return err
			}
			db := t.service.Database
			if a.jsonOut {
				return a.printJSON(dbInfo{Service: *t.service, EnvironmentID: t.env.ID, Engine: db.Engine, Version: db.Version, Volume: v, Connection: refs})
			}
			a.printDBInfo(t, v, refs)
			return nil
		},
	}
	f.register(cmd, true)
	return cmd
}

// connectionRefs lists the engine's connection variables the service has.
// Without permission to list variables it assumes the template's set.
func connectionRefs(ctx context.Context, t *target) ([]dbReference, error) {
	keys := connectionKeys[t.service.Database.Engine]
	vars, err := t.sess.client.ListVariables(ctx, api.VariableScope{ServiceID: t.service.ID}, t.env.ID)
	switch {
	case err == nil:
		keys = slices.DeleteFunc(slices.Clone(keys), func(k string) bool {
			return !slices.ContainsFunc(vars, func(v api.Variable) bool { return v.Key == k })
		})
	case !api.IsStatus(err, http.StatusForbidden):
		return nil, err
	}
	refs := []dbReference{}
	for _, k := range keys {
		refs = append(refs, dbReference{Key: k, Reference: reference(t.service.Slug, k)})
	}
	return refs, nil
}

func (a *App) printDBInfo(t *target, v *api.Volume, refs []dbReference) {
	pal := a.IO.OutColor()
	db := t.service.Database
	fmt.Fprintf(a.IO.Out, "%s (%s) in %s\n", pal.Bold(t.service.Name), t.service.Slug, t.env.Name)
	row := func(k, val string) { fmt.Fprintf(a.IO.Out, "  %-10s %s\n", k, val) }
	row("Engine", engineLabel(db.Engine, db.Version))
	a.printVolumeRows(row, v, t)
	if len(refs) == 0 {
		return
	}
	fmt.Fprintln(a.IO.Out, "\nConnect from another service with a variable reference:")
	tb := a.newTable()
	for _, r := range refs {
		tb.row("  "+r.Key, r.Reference)
	}
	tb.flush()
	fmt.Fprintf(a.IO.Out, "  e.g. roundhouse vars set '%s=%s' --service <app>\n", refs[0].Key, refs[0].Reference)
}

// printVolumeRows renders a volume as labelled rows.
func (a *App) printVolumeRows(row func(k, v string), v *api.Volume, t *target) {
	pal := a.IO.OutColor()
	if v == nil {
		row("Volume", "none in "+t.env.Name)
		return
	}
	where := ""
	if v.NodeName != nil {
		where = " on " + *v.NodeName
	} else if v.NodeID == nil {
		where = ", placed by its first deployment"
	}
	row("Volume", fmt.Sprintf("%s, %s%s", v.ID, pal.Status(v.Status), where))
	row("Usage", volumeUsage(v))
	row("Mount", v.MountPath)
	switch q := deref(v.QuotaMode); q {
	case "none":
		row("Quota", pal.Yellow("not enforced on this server: the volume can outgrow its size"))
	case "":
	default:
		row("Quota", q)
	}
	if v.Status == api.VolumePendingDeletion && v.DeleteAfter != nil {
		row("Deleted", pal.Red(fmt.Sprintf("data is removed %s unless you run `roundhouse db volume undelete`", formatInstant(millis(*v.DeleteAfter)))))
	}
	if v.Message != nil && *v.Message != "" {
		row("Message", *v.Message)
	}
}

// -----------------------------------------------------------------------------
// db query
// -----------------------------------------------------------------------------

// maxStatementBytes mirrors MAX_DB_STATEMENT_BYTES.
const maxStatementBytes = 64 * 1024

// maxCellWidth bounds a cell in table output; --json has the full value.
const maxCellWidth = 60

func (a *App) dbQueryCmd() *cobra.Command {
	var f targetFlags
	var params []string
	var maxRows int
	var timeout time.Duration
	cmd := &cobra.Command{
		Use:   "query STATEMENT",
		Short: "Run a read-only query against a database",
		Long: `Run one read-only statement and print the result as a table. Pass - to
read the statement from stdin.

Queries run as the database's read-only principal inside a read-only
transaction, so writes are refused by the database itself. The statement is
SQL for PostgreSQL and MySQL (one statement; $1 or ? placeholders take
--param values), a command document in JSON for MongoDB, and a command line
for Valkey and Redis (read commands only).

The control plane records every statement in the audit log; results are
never stored. Long cells are shortened in the table; --json has every value.`,
		Example: `  roundhouse db query "SELECT id, email FROM users ORDER BY id DESC LIMIT 10"
  roundhouse db query 'SELECT * FROM orders WHERE user_id = $1' --param 42
  roundhouse db query --service mongo '{"find": "users", "limit": 5}'
  roundhouse db query --service cache "HGETALL session:42"
  roundhouse db query - --json < report.sql`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if maxRows < 1 || maxRows > api.MaxQueryRows {
				return exitcode.New(exitcode.Usage, "--max-rows must be between 1 and %d", api.MaxQueryRows)
			}
			ms := int(timeout.Milliseconds())
			if ms < api.MinQueryTimeoutMS || ms > api.MaxQueryTimeoutMS {
				return exitcode.New(exitcode.Usage, "--timeout must be between 100ms and 30s")
			}
			statement := args[0]
			if statement == "-" {
				in, err := a.IO.ReadAll()
				if err != nil {
					return err
				}
				statement = in
			}
			statement = strings.TrimSpace(statement)
			if statement == "" {
				return exitcode.New(exitcode.Usage, "the statement is empty")
			}
			if len(statement) > maxStatementBytes {
				return exitcode.New(exitcode.Usage, "the statement is %d bytes; the limit is 64 KiB", len(statement))
			}
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, false)
			if err != nil {
				return err
			}
			op, err := rawOp(t.service.Database.Engine, statement, params)
			if err != nil {
				return err
			}
			res, err := t.sess.client.QueryDatabase(ctx, t.service.ID, api.DatabaseQueryInput{
				EnvironmentID: t.env.ID, Mode: api.QueryRead, Op: op, MaxRows: maxRows, TimeoutMS: ms,
			})
			if err != nil {
				return err
			}
			return a.printQueryResult(res, maxRows)
		},
	}
	f.register(cmd, true)
	cmd.Flags().StringArrayVar(&params, "param", nil, "positional parameter for $1/? placeholders (SQL only), repeatable")
	cmd.Flags().IntVar(&maxRows, "max-rows", api.DefaultQueryRows, fmt.Sprintf("rows to return at most (up to %d)", api.MaxQueryRows))
	cmd.Flags().DurationVar(&timeout, "timeout", api.DefaultQueryTimeoutMS*time.Millisecond, "query timeout (100ms to 30s)")
	return cmd
}

// rawOp builds the raw operation the engine takes.
func rawOp(engine, statement string, params []string) (api.QueryOp, error) {
	op := api.QueryOp{Type: "raw"}
	switch engine {
	case "redis":
		if len(params) > 0 {
			return op, exitcode.New(exitcode.Usage, "--param applies to SQL databases only")
		}
		argv, err := splitCommand(statement)
		if err != nil {
			return op, exitcode.New(exitcode.Usage, "%v", err)
		}
		op.Argv = argv
	case "mongodb":
		if len(params) > 0 {
			return op, exitcode.New(exitcode.Usage, "--param applies to SQL databases only")
		}
		var doc map[string]json.RawMessage
		if err := json.Unmarshal([]byte(statement), &doc); err != nil {
			return op, exitcode.New(exitcode.Usage, `MongoDB takes a command document in JSON, e.g. '{"find": "users", "limit": 10}'`)
		}
		op.Statement = statement
	default:
		op.Statement = statement
		for _, p := range params {
			op.Params = append(op.Params, &p)
		}
	}
	return op, nil
}

// splitCommand splits a Redis command line into arguments: whitespace
// separates them, quotes group them, and a backslash escapes the next
// character inside double quotes.
func splitCommand(s string) ([]string, error) {
	var args []string
	var cur strings.Builder
	inArg := false
	var quote rune
	escaped := false
	for _, r := range s {
		switch {
		case escaped:
			cur.WriteRune(r)
			escaped = false
		case quote == '"' && r == '\\':
			escaped = true
		case quote != 0 && r == quote:
			quote = 0
		case quote != 0:
			cur.WriteRune(r)
		case r == '"' || r == '\'':
			quote, inArg = r, true
		case unicode.IsSpace(r):
			if inArg {
				args = append(args, cur.String())
				cur.Reset()
				inArg = false
			}
		default:
			cur.WriteRune(r)
			inArg = true
		}
	}
	if quote != 0 || escaped {
		return nil, errors.New("unterminated quote in the command")
	}
	if inArg {
		args = append(args, cur.String())
	}
	if len(args) == 0 {
		return nil, errors.New("the command is empty")
	}
	return args, nil
}

// printQueryResult prints a result as a table with notes on stderr, or as
// JSON. An engine error exits 1 either way.
func (a *App) printQueryResult(res *api.DatabaseQueryResult, maxRows int) error {
	if a.jsonOut {
		a.printJSON(res)
		if !res.OK {
			return exitcode.Silent(exitcode.Error)
		}
		return nil
	}
	if !res.OK {
		return exitcode.New(exitcode.Error, "the database refused the query: %s", cmp.Or(res.Error, "unknown error"))
	}
	a.printResultTable(res)
	c := a.IO.ErrColor()
	n := len(res.Rows)
	if res.RowCount != nil && len(res.Columns) == 0 {
		n = *res.RowCount
	}
	fmt.Fprintf(a.IO.Err, "%s\n", c.Dim(fmt.Sprintf("(%s in %d ms)", plural(n, "row", "rows"), res.DurationMS)))
	if res.Truncated {
		msg := fmt.Sprintf("the result was cut at %s or its size cap; narrow the query", plural(len(res.Rows), "row", "rows"))
		if maxRows < api.MaxQueryRows {
			msg += fmt.Sprintf(" or raise --max-rows (up to %d)", api.MaxQueryRows)
		}
		fmt.Fprintf(a.IO.Err, "%s %s\n", c.Dim("note:"), msg)
	}
	if res.Notice != "" && !strings.HasPrefix(res.Notice, "cursor:") {
		fmt.Fprintf(a.IO.Err, "%s %s\n", c.Dim("note:"), sanitizeCell(res.Notice, 200))
	}
	return nil
}

func (a *App) printResultTable(res *api.DatabaseQueryResult) {
	if len(res.Columns) == 0 && len(res.Rows) == 0 {
		fmt.Fprintln(a.IO.Out, "OK")
		return
	}
	headers := make([]string, len(res.Columns))
	for i, col := range res.Columns {
		headers[i] = sanitizeCell(col.Name, maxCellWidth)
	}
	if len(headers) == 0 && len(res.Rows) > 0 {
		for i := range res.Rows[0] {
			headers = append(headers, "#"+strconv.Itoa(i+1))
		}
	}
	tb := a.newTable(headers...)
	for _, row := range res.Rows {
		cells := make([]string, len(row))
		for i, v := range row {
			cells[i] = formatCell(v)
		}
		tb.row(cells...)
	}
	tb.flush()
}

// formatCell renders one JSON cell for a table: NULL for null, a size for
// binary, compact JSON for documents.
func formatCell(v any) string {
	switch x := v.(type) {
	case nil:
		return "NULL"
	case string:
		return sanitizeCell(x, maxCellWidth)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	case map[string]any:
		if b64, ok := x["$b64"].(string); ok && len(x) == 1 {
			if raw, err := base64.StdEncoding.DecodeString(b64); err == nil {
				return fmt.Sprintf("<binary, %s>", plural(len(raw), "byte", "bytes"))
			}
		}
	}
	data, err := json.Marshal(v)
	if err != nil {
		return "?"
	}
	return sanitizeCell(string(data), maxCellWidth)
}

// sanitizeCell makes untrusted text safe for one table cell, shortened to
// width runes.
//
// SECURITY: values come from a database, which anyone with write access to
// it controls, or from a pull request, which anyone can open; escape sequences in them could rewrite the terminal, so
// control characters are shown escaped instead, as are bidirectional
// overrides, which could make text read differently from what it is.
func sanitizeCell(s string, width int) string {
	var b strings.Builder
	n := 0
	for _, r := range s {
		if n >= width {
			b.WriteString("…")
			break
		}
		switch {
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\t':
			b.WriteString(`\t`)
		case r == '\r':
			b.WriteString(`\r`)
		case unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) || r == ' ' || r == ' ':
			fmt.Fprintf(&b, `\u%04x`, r)
		default:
			b.WriteRune(r)
		}
		n++
	}
	return b.String()
}

// -----------------------------------------------------------------------------
// db tables
// -----------------------------------------------------------------------------

// dbTables is the --json output of `db tables`.
type dbTables struct {
	Engine     string                   `json:"engine"`
	Version    *string                  `json:"version"`
	Namespaces api.DatabaseQueryResult  `json:"namespaces"`
	Tables     *api.DatabaseQueryResult `json:"tables"`
}

func (a *App) dbTablesCmd() *cobra.Command {
	var f targetFlags
	var namespace, pattern, cursor string
	cmd := &cobra.Command{
		Use:   "tables",
		Short: "List a database's namespaces and tables",
		Long: `List the database's namespaces (databases, schemas, or Valkey/Redis
database indexes) and the tables, views or collections in one of them.
For Valkey and Redis it lists keys, a page at a time: --pattern filters
them and --cursor continues a listing.`,
		Example: `  roundhouse db tables
  roundhouse db tables --namespace audit
  roundhouse db tables --service cache --pattern 'session:*'`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, false)
			if err != nil {
				return err
			}
			if (pattern != "" || cursor != "") && t.service.Database.Engine != "redis" {
				return exitcode.New(exitcode.Usage, "--pattern and --cursor apply to Valkey and Redis only")
			}
			c := t.sess.client
			schema, err := c.DatabaseSchema(ctx, t.service.ID, t.env.ID)
			if err != nil {
				return err
			}
			if !schema.Namespaces.OK {
				if a.jsonOut {
					a.printJSON(dbTables{Engine: schema.Engine, Version: schema.Version, Namespaces: schema.Namespaces})
					return exitcode.Silent(exitcode.Error)
				}
				return exitcode.New(exitcode.Error, "the database refused to list its namespaces: %s", cmp.Or(schema.Namespaces.Error, "unknown error"))
			}
			tables, err := c.QueryDatabase(ctx, t.service.ID, api.DatabaseQueryInput{EnvironmentID: t.env.ID, Mode: api.QueryRead,
				Op: api.QueryOp{Type: "list_tables", Namespace: namespace, Pattern: pattern, Cursor: cursor}})
			if err != nil {
				return err
			}
			if a.jsonOut {
				a.printJSON(dbTables{Engine: schema.Engine, Version: schema.Version, Namespaces: schema.Namespaces, Tables: tables})
				if !tables.OK {
					return exitcode.Silent(exitcode.Error)
				}
				return nil
			}
			var names []string
			for _, row := range schema.Namespaces.Rows {
				if len(row) > 0 {
					names = append(names, formatCell(row[0]))
				}
			}
			fmt.Fprintf(a.IO.Out, "%s (%s) in %s, %s\n", t.service.Name, t.service.Slug, t.env.Name, engineLabel(schema.Engine, deref(schema.Version)))
			fmt.Fprintf(a.IO.Out, "Namespaces: %s\n\n", orDash(strings.Join(names, ", ")))
			if !tables.OK {
				return exitcode.New(exitcode.Error, "the database refused to list tables: %s", cmp.Or(tables.Error, "unknown error"))
			}
			if len(tables.Rows) == 0 {
				fmt.Fprintln(a.IO.Out, "No tables.")
			} else {
				a.printResultTable(tables)
			}
			if next, ok := strings.CutPrefix(tables.Notice, "cursor:"); ok && next != "0" {
				fmt.Fprintf(a.IO.Err, "%s more keys: pass --cursor %s\n", a.IO.ErrColor().Dim("note:"), sanitizeCell(next, 24))
			} else if tables.Truncated {
				fmt.Fprintf(a.IO.Err, "%s the list was cut at %s\n", a.IO.ErrColor().Dim("note:"), plural(len(tables.Rows), "entry", "entries"))
			}
			return nil
		},
	}
	f.register(cmd, true)
	cmd.Flags().StringVar(&namespace, "namespace", "", "database, schema or database index (default: the engine's default)")
	cmd.Flags().StringVar(&pattern, "pattern", "", "Valkey/Redis: only keys matching this glob")
	cmd.Flags().StringVar(&cursor, "cursor", "", "Valkey/Redis: continue a key listing from this cursor")
	return cmd
}

// -----------------------------------------------------------------------------
// db volume
// -----------------------------------------------------------------------------

func (a *App) dbVolumeCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:     "volume",
		Aliases: []string{"vol"},
		Short:   "Show, grow, move, delete or undelete a database's volume",
		Long: `Show the volume of a database (or of --service) in the environment: its
size, usage, server and quota. Subcommands grow it, move it to another
server, list its moves, delete it (its data is removed after 72 hours) and
undelete it within that window.`,
		Example: `  roundhouse db volume
  roundhouse db volume resize --size-mb 20480
  roundhouse db volume delete --environment staging --yes`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, true)
			if err != nil {
				return err
			}
			v, err := requireVolume(ctx, t)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(v)
			}
			a.printVolume(t, v)
			return nil
		},
	}
	f.register(cmd, true)
	cmd.AddCommand(a.dbVolumeResizeCmd(), a.dbVolumeDeleteCmd(), a.dbVolumeUndeleteCmd(), a.dbVolumeMoveCmd(), a.dbVolumeRecoverCmd(), a.dbVolumeMigrationsCmd())
	return cmd
}

func (a *App) printVolume(t *target, v *api.Volume) {
	fmt.Fprintf(a.IO.Out, "Volume of %s in %s\n", a.IO.OutColor().Bold(t.service.Name), t.env.Name)
	a.printVolumeRows(func(k, val string) { fmt.Fprintf(a.IO.Out, "  %-10s %s\n", k, val) }, v, t)
}

func (a *App) dbVolumeResizeCmd() *cobra.Command {
	var f targetFlags
	var sizeMB int64
	cmd := &cobra.Command{
		Use:     "resize --size-mb SIZE",
		Aliases: []string{"grow"},
		Short:   "Grow a volume",
		Long: `Grow the volume to --size-mb MiB. The server applies it online; volumes
never shrink.`,
		Example: `  roundhouse db volume resize --size-mb 20480`,
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if sizeMB < api.MinVolumeMB || sizeMB > api.MaxVolumeMB {
				return exitcode.New(exitcode.Usage, "--size-mb must be between %d and %d", api.MinVolumeMB, api.MaxVolumeMB)
			}
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, true)
			if err != nil {
				return err
			}
			v, err := requireVolume(ctx, t)
			if err != nil {
				return err
			}
			if sizeMB < v.SizeMB {
				return exitcode.New(exitcode.Invalid, "volumes only grow; %s's is %d MiB (%s)", t.service.Name, v.SizeMB, formatMiB(v.SizeMB))
			}
			if sizeMB == v.SizeMB {
				if a.jsonOut {
					return a.printJSON(v)
				}
				fmt.Fprintf(a.IO.Out, "The volume is already %s; nothing changed.\n", formatMiB(v.SizeMB))
				return nil
			}
			grown, err := t.sess.client.ResizeVolume(ctx, v.ID, sizeMB)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(grown)
			}
			fmt.Fprintf(a.IO.Out, "%s Grew the volume of %s in %s from %s to %s\n", a.IO.OutColor().Green("✓"), t.service.Name, t.env.Name, formatMiB(v.SizeMB), formatMiB(grown.SizeMB))
			return nil
		},
	}
	f.register(cmd, true)
	cmd.Flags().Int64Var(&sizeMB, "size-mb", 0, "new size in MiB")
	_ = cmd.MarkFlagRequired("size-mb")
	return cmd
}

func (a *App) dbVolumeDeleteCmd() *cobra.Command {
	var f targetFlags
	var yes bool
	cmd := &cobra.Command{
		Use:     "delete",
		Aliases: []string{"rm"},
		Short:   "Delete a volume (its data is removed after 72 hours)",
		Long: `Delete the volume of a database in the environment. Its data stays on the
server for 72 hours, during which "roundhouse db volume undelete" brings it
back; after that it is removed for good. The service must no longer run in
the environment.`,
		Example: `  roundhouse db volume delete --environment staging
  roundhouse db volume delete --service cache --yes`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, true)
			if err != nil {
				return err
			}
			v, err := requireVolume(ctx, t)
			if err != nil {
				return err
			}
			if !yes {
				where := ""
				if v.NodeName != nil {
					where = " from " + *v.NodeName
				}
				ok, err := a.IO.Confirm(fmt.Sprintf("Delete the volume of %s in %s? Its data is removed%s after 72 hours unless you undelete it.", t.service.Name, t.env.Name, where), false, "pass --yes")
				if err != nil {
					return err
				}
				if !ok {
					return exitcode.New(exitcode.Error, "delete aborted; nothing was changed")
				}
			}
			deleted, err := t.sess.client.DeleteVolume(ctx, v.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(deleted)
			}
			fmt.Fprintf(a.IO.Out, "%s Deleted the volume of %s in %s\n", a.IO.OutColor().Green("✓"), t.service.Name, t.env.Name)
			if deleted.DeleteAfter != nil {
				fmt.Fprintf(a.IO.Out, "  Its data is removed %s; until then `roundhouse db volume undelete` brings it back.\n", formatInstant(millis(*deleted.DeleteAfter)))
			}
			return nil
		},
	}
	f.register(cmd, true)
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")
	return cmd
}

func (a *App) dbVolumeUndeleteCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:     "undelete",
		Aliases: []string{"restore"},
		Short:   "Undo a volume delete within its 72 hours",
		Example: `  roundhouse db volume undelete --environment staging`,
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolveDatabase(ctx, f, true)
			if err != nil {
				return err
			}
			v, err := requireVolume(ctx, t)
			if err != nil {
				return err
			}
			restored, err := t.sess.client.UndeleteVolume(ctx, v.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(restored)
			}
			fmt.Fprintf(a.IO.Out, "%s Undeleted the volume of %s in %s; it is %s\n", a.IO.OutColor().Green("✓"), t.service.Name, t.env.Name, restored.Status)
			return nil
		},
	}
	f.register(cmd, true)
	return cmd
}
