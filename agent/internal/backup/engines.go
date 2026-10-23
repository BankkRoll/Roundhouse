package backup

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/rhbk"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// The dump and restore commands are built into the agent, never taken from
// a frame (ADR 0004). Each runs with `docker exec` inside the database
// container, so the tools match the server's version.
//
// SECURITY: no credential ever appears in an argument vector. The scripts
// below name the container's own variables ("$POSTGRES_PASSWORD"), which the
// shell expands inside the container into an environment variable or a
// 0600 temp file; where the tool reads an option file from stdin, the agent
// writes the password (read from the container's config) there. Database
// names reach the scripts as positional arguments ("$1"), never spliced
// into script text, and must match dbNameRE, so none can be read as a
// connection string or an option.

// dbNameRE mirrors the protocol's database name rule.
var dbNameRE = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_$-]{0,63}$`)

// stderrKeep bounds how much of a failing tool's stderr an error quotes.
const stderrKeep = 2048

// engineTarget is the database container a dump reads or a restore writes.
type engineTarget struct {
	d         Docker
	container string
	// env is the container's configured environment.
	env map[string]string
	// log receives the tools' stderr lines for the task log.
	log func(line string)
}

func envMap(entries []string) map[string]string {
	m := make(map[string]string, len(entries))
	for _, e := range entries {
		if k, v, ok := strings.Cut(e, "="); ok {
			m[k] = v
		}
	}
	return m
}

// lineWriter splits output into lines for the task log and keeps the tail
// for error messages.
type lineWriter struct {
	log  func(string)
	buf  []byte
	tail []byte
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.tail = append(w.tail, p...)
	if len(w.tail) > stderrKeep {
		w.tail = w.tail[len(w.tail)-stderrKeep:]
	}
	w.buf = append(w.buf, p...)
	for {
		i := bytes.IndexByte(w.buf, '\n')
		if i < 0 {
			break
		}
		if w.log != nil {
			w.log(string(bytes.TrimRight(w.buf[:i], "\r")))
		}
		w.buf = w.buf[i+1:]
	}
	if len(w.buf) > 64<<10 {
		w.buf = w.buf[:0]
	}
	return len(p), nil
}

func (w *lineWriter) flush() {
	if len(w.buf) > 0 && w.log != nil {
		w.log(string(w.buf))
	}
	w.buf = nil
}

// run executes a shell script in the container. args become $1, $2, ….
func (t *engineTarget) run(ctx context.Context, script string, args []string, stdin io.Reader, stdout io.Writer) error {
	errw := &lineWriter{log: t.log}
	cmd := append([]string{"sh", "-c", script, "roundhouse"}, args...)
	code, err := t.d.RunExec(ctx, t.container, docker.ExecRun{Cmd: cmd, Stdin: stdin, Stdout: stdout, Stderr: errw})
	errw.flush()
	if err != nil {
		return err
	}
	if code != 0 {
		msg := strings.TrimSpace(string(errw.tail))
		if i := strings.LastIndexByte(msg, '\n'); i >= 0 && len(msg)-i > 20 {
			msg = msg[i+1:]
		}
		if msg == "" {
			return fmt.Errorf("exited with code %d", code)
		}
		return fmt.Errorf("exited with code %d: %s", code, msg)
	}
	return nil
}

// output runs a script and returns its stdout, bounded.
func (t *engineTarget) output(ctx context.Context, script string, args []string, stdin io.Reader) (string, error) {
	var out limitedBuffer
	out.max = 1 << 20
	err := t.run(ctx, script, args, stdin, &out)
	return out.String(), err
}

type limitedBuffer struct {
	bytes.Buffer
	max int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.max {
		return 0, errors.New("output too large")
	}
	return b.Buffer.Write(p)
}

// optionFile is a MySQL [client] option file carrying the root password.
func optionFile(password string) io.Reader {
	q := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(password)
	return strings.NewReader("[client]\npassword=\"" + q + "\"\n")
}

// mongoConfig is a mongodump/mongorestore --config YAML document with the
// password, quoted as a JSON string (which YAML reads the same way).
func mongoConfig(password string) io.Reader {
	return strings.NewReader("password: " + strconv.Quote(password) + "\n")
}

// -----------------------------------------------------------------------------
// Dumps
// -----------------------------------------------------------------------------

const pgPrefix = `export PGPASSWORD="${POSTGRES_PASSWORD:-}"; U="${POSTGRES_USER:-postgres}"; `

// pgDatabases lists the non-template databases.
func (t *engineTarget) pgDatabases(ctx context.Context) ([]string, error) {
	out, err := t.output(ctx, pgPrefix+
		`exec psql -X -U "$U" -d postgres -Atc 'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1'`, nil, nil)
	if err != nil {
		return nil, fmt.Errorf("list databases: %w", err)
	}
	return splitLines(out), nil
}

func splitLines(s string) []string {
	var out []string
	sc := bufio.NewScanner(strings.NewReader(s))
	for sc.Scan() {
		if l := strings.TrimSpace(sc.Text()); l != "" {
			out = append(out, l)
		}
	}
	return out
}

func checkNames(names []string) error {
	for _, n := range names {
		if !dbNameRE.MatchString(n) {
			return fmt.Errorf("database %q has a name dump backups cannot carry; use a snapshot backup", n)
		}
	}
	return nil
}

// dump writes the engine's dump entries into w.
func (t *engineTarget) dump(ctx context.Context, engine protocol.DatabaseEngine, databases *[]string, w *rhbk.Writer) error {
	switch engine {
	case protocol.EnginePostgres:
		return t.dumpPostgres(ctx, databases, w)
	case protocol.EngineMySQL:
		return t.dumpMySQL(ctx, databases, w)
	case protocol.EngineRedis:
		return t.dumpRedis(ctx, w)
	case protocol.EngineMongoDB:
		return t.dumpMongo(ctx, w)
	}
	return fmt.Errorf("unsupported engine %q", engine)
}

func (t *engineTarget) entry(ctx context.Context, w *rhbk.Writer, h rhbk.Header, script string, args []string, stdin io.Reader) error {
	e, err := w.Create(h)
	if err != nil {
		return err
	}
	if err := t.run(ctx, script, args, stdin, e); err != nil {
		return fmt.Errorf("%s: %w", h.Name, err)
	}
	return e.Close()
}

func (t *engineTarget) dumpPostgres(ctx context.Context, databases *[]string, w *rhbk.Writer) error {
	var dbs []string
	if databases != nil {
		dbs = *databases
	} else {
		var err error
		if dbs, err = t.pgDatabases(ctx); err != nil {
			return err
		}
	}
	if err := checkNames(dbs); err != nil {
		return err
	}
	engine := string(protocol.EnginePostgres)
	if err := t.entry(ctx, w, rhbk.Header{Name: "_globals.sql", Engine: engine, Format: rhbk.FormatPGGlobals},
		pgPrefix+`exec pg_dumpall -U "$U" --globals-only`, nil, nil); err != nil {
		return err
	}
	for _, db := range dbs {
		if err := t.entry(ctx, w, rhbk.Header{Name: db + ".dump", Engine: engine, Format: rhbk.FormatPGCustom, Database: db},
			pgPrefix+`export PGDATABASE="$1"; exec pg_dump -U "$U" -Fc`, []string{db}, nil); err != nil {
			return err
		}
	}
	return nil
}

// mysqlSystemSchemas are never dumped: the server recreates them.
var mysqlSystemSchemas = []string{"information_schema", "mysql", "performance_schema", "sys"}

func (t *engineTarget) dumpMySQL(ctx context.Context, databases *[]string, w *rhbk.Writer) error {
	password := t.env["MYSQL_ROOT_PASSWORD"]
	var dbs []string
	if databases != nil {
		dbs = *databases
	} else {
		out, err := t.output(ctx, `exec mysql --defaults-extra-file=/dev/stdin -uroot -N -B -e 'SHOW DATABASES'`,
			nil, optionFile(password))
		if err != nil {
			return fmt.Errorf("list databases: %w", err)
		}
		for _, db := range splitLines(out) {
			if !slices.Contains(mysqlSystemSchemas, db) {
				dbs = append(dbs, db)
			}
		}
	}
	if err := checkNames(dbs); err != nil {
		return err
	}
	if len(dbs) == 0 {
		return nil
	}
	return t.entry(ctx, w, rhbk.Header{Name: "databases.sql", Engine: string(protocol.EngineMySQL), Format: rhbk.FormatSQL},
		`exec mysqldump --defaults-extra-file=/dev/stdin -uroot --single-transaction --routines --events --triggers --databases "$@"`,
		dbs, optionFile(password))
}

// redisCLI finds the client the image ships: valkey-cli or redis-cli.
const redisCLI = `cli=$(command -v valkey-cli || command -v redis-cli) || { echo "no valkey-cli or redis-cli in the image" >&2; exit 127; }; ` +
	`if [ -n "${REDIS_PASSWORD:-}" ]; then export REDISCLI_AUTH="$REDIS_PASSWORD"; fi; `

func (t *engineTarget) dumpRedis(ctx context.Context, w *rhbk.Writer) error {
	return t.entry(ctx, w, rhbk.Header{Name: "dump.rdb", Engine: string(protocol.EngineRedis), Format: rhbk.FormatRDB},
		redisCLI+`exec "$cli" --rdb -`, nil, nil)
}

func (t *engineTarget) dumpMongo(ctx context.Context, w *rhbk.Writer) error {
	h := rhbk.Header{Name: "mongo.archive", Engine: string(protocol.EngineMongoDB), Format: rhbk.FormatMongoArchive}
	user, password := t.env["MONGO_INITDB_ROOT_USERNAME"], t.env["MONGO_INITDB_ROOT_PASSWORD"]
	if user == "" || password == "" {
		return t.entry(ctx, w, h, `exec mongodump --archive`, nil, nil)
	}
	return t.entry(ctx, w, h,
		`exec mongodump --archive --config=/dev/stdin --username "$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase admin`,
		nil, mongoConfig(password))
}

// -----------------------------------------------------------------------------
// Restores
// -----------------------------------------------------------------------------

// restoreEntry applies one dump entry. Redis entries are not handled here:
// they need the container stopped ([Runner.restoreRedis]).
func (t *engineTarget) restoreEntry(ctx context.Context, engine protocol.DatabaseEngine, h rhbk.Header, r io.Reader) error {
	if h.Engine != string(engine) {
		return fmt.Errorf("entry %s is a %s dump, not %s", h.Name, h.Engine, engine)
	}
	switch h.Format {
	case rhbk.FormatPGGlobals:
		// NOTE: roles that exist already (the superuser) fail one by one;
		// psql carries on, as pg_dumpall's documentation expects.
		return t.run(ctx, pgPrefix+`exec psql -X -q -U "$U" -d postgres -f -`, nil, r, nil)
	case rhbk.FormatPGCustom:
		if !dbNameRE.MatchString(h.Database) {
			return fmt.Errorf("entry %s: invalid database name", h.Name)
		}
		dbs, err := t.pgDatabases(ctx)
		if err != nil {
			return err
		}
		if !slices.Contains(dbs, h.Database) {
			if err := t.run(ctx, pgPrefix+`exec createdb -U "$U" "$1"`, []string{h.Database}, nil, nil); err != nil {
				return fmt.Errorf("create database %s: %w", h.Database, err)
			}
		}
		return t.run(ctx, pgPrefix+`exec pg_restore -U "$U" --no-password --clean --if-exists --single-transaction -d "$1"`,
			[]string{h.Database}, r, nil)
	case rhbk.FormatSQL:
		// NOTE: stdin carries the SQL, so the option file goes through a
		// 0600 temp file inside the container instead.
		return t.run(ctx, `f=$(mktemp) || exit 1; `+
			`printf '[client]\npassword="%s"\n' "$MYSQL_ROOT_PASSWORD" > "$f" || { rm -f "$f"; exit 1; }; `+
			`mysql --defaults-extra-file="$f" -uroot; rc=$?; rm -f "$f"; exit $rc`, nil, r, nil)
	case rhbk.FormatMongoArchive:
		if t.env["MONGO_INITDB_ROOT_USERNAME"] == "" || t.env["MONGO_INITDB_ROOT_PASSWORD"] == "" {
			return t.run(ctx, `exec mongorestore --archive --drop`, nil, r, nil)
		}
		return t.run(ctx, `f=$(mktemp) || exit 1; `+
			`printf 'password: "%s"\n' "$MONGO_INITDB_ROOT_PASSWORD" > "$f" || { rm -f "$f"; exit 1; }; `+
			`mongorestore --config="$f" --username "$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase admin --archive --drop; `+
			`rc=$?; rm -f "$f"; exit $rc`, nil, r, nil)
	}
	return fmt.Errorf("entry %s: format %q cannot be restored into %s", h.Name, h.Format, engine)
}
