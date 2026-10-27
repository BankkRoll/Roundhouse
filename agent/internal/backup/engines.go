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
	"time"

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
		// SECURITY: the mysql schema holds the accounts and their password
		// hashes; restored elsewhere it would replace that server's
		// credentials, so a dump never carries it, even when asked to.
		for _, db := range *databases {
			if slices.Contains(mysqlSystemSchemas, db) {
				return fmt.Errorf("database %s is a system schema; dump backups do not carry it", db)
			}
		}
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
		err := t.run(ctx, pgPrefix+`exec psql -X -q -U "$U" -d postgres -f -`, nil, r, nil)
		// The entry may have run in part even when it failed.
		if cerr := t.reapplyPostgresCredentials(ctx); cerr != nil {
			err = errors.Join(err, fmt.Errorf("re-apply credentials: %w", cerr))
		}
		return err
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
		// NOTE: the merge runs whatever mongorestore's outcome, so the
		// temporary collections never outlive the restore.
		return t.run(ctx, `command -v mongosh >/dev/null || { echo "no mongosh in the image" >&2; exit 127; }; `+
			`f=$(mktemp) || exit 1; `+
			`printf 'password: "%s"\n' "$MONGO_INITDB_ROOT_PASSWORD" > "$f" || { rm -f "$f"; exit 1; }; `+
			`mongorestore --config="$f" --username "$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase admin --archive --drop `+
			`--nsFrom=admin.system.users --nsTo="$2" --nsFrom=admin.system.roles --nsTo="$3"; rc=$?; rm -f "$f"; `+
			`ok=0; [ $rc -eq 0 ] && ok=1; `+
			`ROUNDHOUSE_RESTORE_OK=$ok mongosh --nodb --quiet --norc --eval "$1" </dev/null || { [ $rc -eq 0 ] && rc=1; }; exit $rc`,
			[]string{mongoMergeScript, mongoRestoreUsers, mongoRestoreRoles}, r, nil)
	}
	return fmt.Errorf("entry %s: format %q cannot be restored into %s", h.Name, h.Format, engine)
}

// -----------------------------------------------------------------------------
// Credentials after a restore
// -----------------------------------------------------------------------------

// A dump of a whole instance carries its principals' passwords: Postgres's
// globals entry has `ALTER ROLE … PASSWORD 'SCRAM-SHA-256$…'` for the
// superuser and roundhouse_ro, and a full mongodump has admin.system.users,
// which mongorestore --drop puts in place of the target's users. Restored
// as is into a service whose credentials differ (a new service, or the same
// one after a rotation), they would reset its passwords to the source's
// and lock out the control plane and every app. A Postgres restore
// therefore re-applies the container's own passwords from its environment
// after the globals entry, and a MongoDB restore keeps the target's own
// root and roundhouse_ro while taking the dump's other users and roles.
//
// MySQL dumps leave out the mysql schema (mysqlSystemSchemas), so they carry
// no accounts; a Redis RDB holds no ACL users, which the start command
// declares.

// pgCredentialsScript sets the superuser's and, when it exists,
// roundhouse_ro's password from the container's environment. psql reads it
// on stdin and takes the values with \getenv (psql 15+; the template offers
// 16 to 18), and format quotes them on the server, so no password is in an
// argument vector or in script text.
//
// SECURITY: the session turns statement and duration logging off first, so
// the server log, which the agent ships as the container's output, cannot
// record a password even in an error's STATEMENT line or a slow-statement
// line.
const pgCredentialsScript = `\set ON_ERROR_STOP on
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
SET log_min_duration_sample = -1;
\getenv rh_user POSTGRES_USER
\getenv rh_password POSTGRES_PASSWORD
\getenv rh_ro_password ROUNDHOUSE_RO_PASSWORD
SELECT format('ALTER ROLE %I WITH PASSWORD %L', :'rh_user', :'rh_password') WHERE :'rh_password' <> '' \gexec
SELECT format('ALTER ROLE %I WITH PASSWORD %L', 'roundhouse_ro', :'rh_ro_password')
WHERE :'rh_ro_password' <> '' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roundhouse_ro') \gexec
`

// credentialsTimeout bounds re-applying credentials, which runs even when
// the restore's own deadline has passed: the passwords must be put back.
const credentialsTimeout = 2 * time.Minute

// reapplyPostgresCredentials runs pgCredentialsScript in the container.
func (t *engineTarget) reapplyPostgresCredentials(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), credentialsTimeout)
	defer cancel()
	// NOTE: the variables are exported even when empty, because \getenv
	// leaves a psql variable unset for a missing one and :'…' would then
	// stay literal text.
	return t.run(ctx, pgPrefix+
		`export POSTGRES_USER="$U" POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}" ROUNDHOUSE_RO_PASSWORD="${ROUNDHOUSE_RO_PASSWORD:-}"; `+
		`exec psql -X -q -U "$U" -d postgres -f -`, nil, strings.NewReader(pgCredentialsScript), nil)
}

// The temporary collections a MongoDB restore puts the dump's users and
// roles in.
const (
	mongoRestoreUsers = "admin.roundhouse_restore_users"
	mongoRestoreRoles = "admin.roundhouse_restore_roles"
)

// mongoMergeScript merges the users and roles a restore set aside into the
// server's, keeping the target's own root and roundhouse_ro as they are.
// The shell sets ROUNDHOUSE_RESTORE_OK when mongorestore succeeded; after a
// failure the script only drops the temporary collections, since merging
// part of a dump's users would drop the rest.
//
// NOTE: mongorestore --drop would replace the target's users with the
// dump's, root included, and the script could then no longer sign in to
// put root's password back: the server also signs out sessions whose user
// was replaced by a different one (a new userId). Restoring the users
// into ordinary collections instead (--nsFrom/--nsTo) and merging them
// with _mergeAuthzCollections, as mongorestore itself does, keeps every
// other user and role of the dump.
//
// SECURITY: the password comes from process.env, never from an argument
// vector, and is cut out of any error message the script prints.
const mongoMergeScript = `const env = process.env;
const user = env.MONGO_INITDB_ROOT_USERNAME;
const password = env.MONGO_INITDB_ROOT_PASSWORD;
const fail = (what, e) => {
  const msg = String((e && e.message) || e).split(password).join('[redacted]');
  process.stderr.write(what + ': ' + msg + '\n');
  quit(1);
};
let admin;
try {
  admin = new Mongo('mongodb://' + encodeURIComponent(user) + ':' + encodeURIComponent(password) +
    '@127.0.0.1:27017/?authSource=admin&directConnection=true').getDB('admin');
  admin.runCommand({ ping: 1 });
} catch (e) {
  fail('connect', e);
}
const ns = { users: '` + mongoRestoreUsers + `', roles: '` + mongoRestoreRoles + `' };
const coll = (n) => admin.getCollection(n.slice('admin.'.length));
let failed;
try {
  if (env.ROUNDHOUSE_RESTORE_OK === '1') {
    const present = admin.getCollectionNames();
    const has = (n) => present.includes(n.slice('admin.'.length));
    const merge = (field, n) => {
      const res = admin.runCommand({ _mergeAuthzCollections: 1, [field]: n, drop: true, db: '' });
      if (!res.ok) throw new Error(res.errmsg || 'merge failed');
    };
    if (has(ns.roles)) merge('tempRolesCollection', ns.roles);
    if (has(ns.users)) {
      const temp = coll(ns.users);
      for (const name of [user, 'roundhouse_ro']) {
        temp.deleteMany({ user: name, db: 'admin' });
        const own = admin.getCollection('system.users').findOne({ user: name, db: 'admin' });
        if (own) temp.insertOne(own);
      }
      merge('tempUsersCollection', ns.users);
    }
  }
} catch (e) {
  failed = e;
}
try {
  coll(ns.users).drop();
  coll(ns.roles).drop();
} catch (e) {
  failed = failed || e;
}
if (failed) fail('merge users and roles', failed);
`
