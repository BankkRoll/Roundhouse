package dbquery

import (
	"context"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

const (
	pgDefaultDatabase  = "postgres"
	pgDefaultNamespace = "public"
	pgApplicationName  = "roundhouse-data-browser"
	pgMaxNotices       = 8
	scramIterations    = 4096
)

const (
	pgListNamespaces = `SELECT nspname AS name, pg_get_userbyid(nspowner) AS owner
FROM pg_namespace
WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'
ORDER BY 1`

	pgListTables = `SELECT c.relname AS name,
  CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'v' THEN 'view'
    WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' END AS type,
  GREATEST(c.reltuples, 0)::int8 AS estimated_rows
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
ORDER BY 1`

	pgDescribe = `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
  NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS default,
  EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)) AS primary_key
FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`

	pgRelationExists = `SELECT to_regclass($1) IS NOT NULL`

	pgColumnExists = `SELECT EXISTS (SELECT 1 FROM pg_attribute
WHERE attrelid = to_regclass($1) AND attname = $2 AND attnum > 0 AND NOT attisdropped)`

	pgTypeNames = `SELECT oid::int8, format_type(oid, NULL) FROM pg_type WHERE oid::int8 = ANY ($1::int8[])`
)

// pgSession is one connection and what the server said on it.
type pgSession struct {
	conn    *pgx.Conn
	req     *request
	notices []string
	// unknownTypes are result type OIDs pgx has no name for, by column.
	unknownTypes map[int]uint32
}

func runPostgres(ctx context.Context, req *request) (*resultSet, error) {
	s := &pgSession{req: req}
	if err := s.connect(ctx); err != nil {
		return nil, err
	}
	defer func() {
		cctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = s.conn.Close(cctx)
	}()

	set, err := s.run(ctx)
	if err != nil {
		return nil, err
	}
	s.nameUnknownTypes(ctx, set)
	for _, n := range s.notices {
		set.notice(n)
	}
	return set, nil
}

func (s *pgSession) connect(ctx context.Context) error {
	// NOTE: ParseConfig("") folds in PG* environment variables and the
	// passfile; every field that matters is overwritten below.
	cfg, err := pgx.ParseConfig("")
	if err != nil {
		return usageError("invalid connection settings")
	}
	t := s.req.target
	cfg.Host = t.Host
	cfg.Port = uint16(t.Port)
	cfg.Database = t.Database
	if cfg.Database == "" {
		cfg.Database = pgDefaultDatabase
	}
	cfg.User = s.req.cred.Username
	cfg.Password = s.req.cred.Password
	// SECURITY: plaintext on the node's bridge network; see the package doc.
	cfg.TLSConfig = nil
	cfg.Fallbacks = nil
	cfg.ValidateConnect = nil
	cfg.AfterConnect = nil
	cfg.ConnectTimeout = s.req.connect
	cfg.RuntimeParams = map[string]string{"application_name": pgApplicationName}
	cfg.OnNotice = func(_ *pgconn.PgConn, n *pgconn.Notice) {
		if len(s.notices) < pgMaxNotices {
			s.notices = append(s.notices, strings.ToLower(n.Severity)+": "+n.Message)
		}
	}
	// SECURITY: the extended protocol parses exactly one statement, so
	// "SELECT 1; DROP TABLE x" is a syntax error rather than two commands.
	cfg.DefaultQueryExecMode = pgx.QueryExecModeDescribeExec
	cfg.StatementCacheCapacity = 0
	cfg.DescriptionCacheCapacity = 0
	cfg.Tracer = nil

	cctx, cancel := context.WithTimeout(ctx, s.req.connect)
	defer cancel()
	conn, err := pgx.ConnectConfig(cctx, cfg)
	if err != nil {
		return err
	}
	s.conn = conn
	return nil
}

func (s *pgSession) run(ctx context.Context) (*resultSet, error) {
	op := s.req.op
	set := newResultSet(s.req.maxRows, s.req.maxBytes)
	switch op.Type {
	case protocol.DBOpListNamespaces:
		return set, s.inTx(ctx, func(tx pgx.Tx) error {
			return s.collect(ctx, tx, set, true, pgListNamespaces)
		})
	case protocol.DBOpListTables:
		return set, s.inTx(ctx, func(tx pgx.Tx) error {
			return s.collect(ctx, tx, set, true, pgListTables, namespaceOr(op.Namespace, pgDefaultNamespace))
		})
	case protocol.DBOpDescribe:
		rel, err := pgRelation(op)
		if err != nil {
			return nil, err
		}
		return set, s.inTx(ctx, func(tx pgx.Tx) error {
			if err := pgCheckRelation(ctx, tx, rel, ""); err != nil {
				return err
			}
			return s.collect(ctx, tx, set, true, pgDescribe, rel)
		})
	case protocol.DBOpRows:
		rel, err := pgRelation(op)
		if err != nil {
			return nil, err
		}
		if op.OrderBy != "" && !validIdent(op.OrderBy) {
			return nil, usageError("invalid order_by")
		}
		return set, s.inTx(ctx, func(tx pgx.Tx) error {
			if err := pgCheckRelation(ctx, tx, rel, op.OrderBy); err != nil {
				return err
			}
			return s.collect(ctx, tx, set, true, pgRowsSQL(rel, op), int64(s.req.maxRows+1), int64(offset(op)))
		})
	case protocol.DBOpRaw:
		return s.raw(ctx, set)
	case protocol.DBOpProvisionReadonly:
		return set, s.provision(ctx)
	case protocol.DBOpSetPassword:
		if err := s.inTx(ctx, func(tx pgx.Tx) error { return s.setPassword(ctx, tx) }); err != nil {
			return nil, err
		}
		return passwordSet(s.req), nil
	}
	return nil, usageError("unsupported operation")
}

// setPassword sets an existing role's password to the new password.
func (s *pgSession) setPassword(ctx context.Context, tx pgx.Tx) error {
	user := s.req.op.User
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)`, user).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return usageError(fmt.Sprintf("role %q does not exist", user))
	}
	// SECURITY: as in provision, the role gets a SCRAM verifier, so
	// statement logging on the server never records the password itself.
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	verifier := scramSHA256Verifier(s.req.cred.NewPassword, salt, scramIterations)
	_, err := tx.Exec(ctx, `ALTER ROLE `+pgx.Identifier{user}.Sanitize()+` WITH PASSWORD `+quotePostgresString(verifier))
	return err
}

// pgRelation is the quoted, schema-qualified name of op's table.
func pgRelation(op *protocol.DBOp) (string, error) {
	ns := namespaceOr(op.Namespace, pgDefaultNamespace)
	if !validIdent(ns) || !validIdent(op.Table) {
		return "", usageError("invalid namespace or table")
	}
	return quotePostgresIdent(ns) + "." + quotePostgresIdent(op.Table), nil
}

func pgRowsSQL(rel string, op *protocol.DBOp) string {
	q := "SELECT * FROM " + rel
	if op.OrderBy != "" {
		q += " ORDER BY " + quotePostgresIdent(op.OrderBy)
		if op.Descending != nil && *op.Descending {
			q += " DESC"
		}
	}
	return q + " LIMIT $1 OFFSET $2"
}

// pgCheckRelation fails unless rel exists and, when given, has column col.
func pgCheckRelation(ctx context.Context, tx pgx.Tx, rel, col string) error {
	var ok bool
	if err := tx.QueryRow(ctx, pgRelationExists, rel).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return usageError("table not found")
	}
	if col == "" {
		return nil
	}
	if err := tx.QueryRow(ctx, pgColumnExists, rel, col).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return usageError("order_by: no such column")
	}
	return nil
}

// inTx runs fn in a transaction with the query's statement timeout. Read
// mode's transaction is read-only and always rolled back; write mode's is
// committed when fn succeeds.
func (s *pgSession) inTx(ctx context.Context, fn func(pgx.Tx) error) error {
	opts := pgx.TxOptions{}
	if !s.req.write {
		opts.AccessMode = pgx.ReadOnly
	}
	tx, err := s.conn.BeginTx(ctx, opts)
	if err != nil {
		return err
	}
	defer func() {
		rctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = tx.Rollback(rctx)
	}()
	ms := strconv.FormatInt(s.req.timeout.Milliseconds(), 10)
	if _, err := tx.Exec(ctx, `SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)`, ms); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	if s.req.write {
		return tx.Commit(ctx)
	}
	return nil
}

// pgQuerier is a transaction or a bare connection.
type pgQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// collect runs sql and adds its rows to set. bounded says sql has its own
// LIMIT, so stopping early leaves little to drain; otherwise read mode
// cancels the statement rather than draining its remaining rows.
func (s *pgSession) collect(ctx context.Context, q pgQuerier, set *resultSet, bounded bool, sql string, args ...any) error {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	fds := rows.FieldDescriptions()
	cols := make([]protocol.DBColumn, len(fds))
	s.unknownTypes = nil
	for i, fd := range fds {
		cols[i] = protocol.DBColumn{Name: fd.Name, Type: "unknown"}
		if t, ok := s.conn.TypeMap().TypeForOID(fd.DataTypeOID); ok {
			cols[i].Type = t.Name
		} else {
			if s.unknownTypes == nil {
				s.unknownTypes = map[int]uint32{}
			}
			s.unknownTypes[i] = fd.DataTypeOID
		}
	}
	if err := set.setColumns(cols); err != nil {
		return err
	}
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return err
		}
		if !set.add(vals) {
			if !bounded && !s.req.write {
				cctx, cancel := context.WithTimeout(ctx, s.req.connect)
				_ = s.conn.PgConn().CancelRequest(cctx)
				cancel()
			}
			rows.Close()
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(fds) == 0 {
		n := rows.CommandTag().RowsAffected()
		set.affected = &n
	}
	return nil
}

// nameUnknownTypes fills in type names pgx does not know, such as
// extension types. Best effort: on failure they stay "unknown".
func (s *pgSession) nameUnknownTypes(ctx context.Context, set *resultSet) {
	if len(s.unknownTypes) == 0 || s.conn.IsClosed() {
		return
	}
	oids := make([]int64, 0, len(s.unknownTypes))
	for _, oid := range s.unknownTypes {
		oids = append(oids, int64(oid))
	}
	rows, err := s.conn.Query(ctx, pgTypeNames, oids)
	if err != nil {
		return
	}
	names := map[uint32]string{}
	for rows.Next() {
		var oid int64
		var name string
		if rows.Scan(&oid, &name) == nil {
			names[uint32(oid)] = name
		}
	}
	rows.Close()
	for i, oid := range s.unknownTypes {
		if name, ok := names[oid]; ok && i < len(set.cols) {
			set.cols[i].Type = clip(name, maxColumnTypeBytes)
		}
	}
}

func (s *pgSession) raw(ctx context.Context, set *resultSet) (*resultSet, error) {
	op := s.req.op
	args := make([]any, len(op.Params))
	for i, p := range op.Params {
		if p != nil {
			args[i] = *p
		}
	}
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		return s.collect(ctx, tx, set, false, op.Statement, args...)
	})
	var pgErr *pgconn.PgError
	if s.req.write && errors.As(err, &pgErr) && pgErr.Code == "25001" {
		// NOTE: CREATE DATABASE, VACUUM and friends refuse to run in a
		// transaction block; write mode runs them on their own instead.
		set = newResultSet(s.req.maxRows, s.req.maxBytes)
		ms := strconv.FormatInt(s.req.timeout.Milliseconds(), 10)
		if _, err := s.conn.Exec(ctx, `SELECT set_config('statement_timeout', $1, false)`, ms); err != nil {
			return nil, err
		}
		err = s.collect(ctx, s.conn, set, false, op.Statement, args...)
	}
	if err != nil {
		return nil, err
	}
	return set, nil
}

// provision creates or updates roundhouse_ro with the read-only password
// and grants it pg_read_all_data.
func (s *pgSession) provision(ctx context.Context) error {
	pw := s.req.cred.ReadonlyPassword
	if pw == "" {
		return usageError("provision_readonly needs the read-only password")
	}
	// SECURITY: the role gets a SCRAM verifier rather than the password, so
	// statement logging on the server never records the password itself.
	secret := pw
	if scramSafe(pw) {
		salt := make([]byte, 16)
		if _, err := rand.Read(salt); err != nil {
			return err
		}
		secret = scramSHA256Verifier(pw, salt, scramIterations)
	}
	var exists bool
	if err := s.conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)`, ReadonlyUser).Scan(&exists); err != nil {
		return err
	}
	err := s.setRole(ctx, exists, secret)
	var pgErr *pgconn.PgError
	if !exists && errors.As(err, &pgErr) && pgErr.Code == "42710" {
		err = s.setRole(ctx, true, secret)
	}
	if err != nil {
		return err
	}
	role := quotePostgresIdent(ReadonlyUser)
	if _, err := s.conn.Exec(ctx, `ALTER ROLE `+role+` SET default_transaction_read_only = on`); err != nil {
		return err
	}
	_, err = s.conn.Exec(ctx, `GRANT pg_read_all_data TO `+role)
	return err
}

func (s *pgSession) setRole(ctx context.Context, exists bool, secret string) error {
	verb := "CREATE"
	if exists {
		verb = "ALTER"
	}
	// NOTE: the server quotes the secret (format's %L), so no client-side
	// escaping has to agree with standard_conforming_strings.
	var ddl string
	err := s.conn.QueryRow(ctx,
		`SELECT format('`+verb+` ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', $1::text, $2::text)`,
		ReadonlyUser, secret).Scan(&ddl)
	if err != nil {
		return err
	}
	_, err = s.conn.Exec(ctx, ddl)
	return err
}

// scramSafe reports whether SASLprep leaves pw unchanged, so a verifier
// computed here matches what the server would compute: printable ASCII.
func scramSafe(pw string) bool {
	for i := 0; i < len(pw); i++ {
		if pw[i] < 0x20 || pw[i] > 0x7e {
			return false
		}
	}
	return pw != ""
}

// scramSHA256Verifier returns the SCRAM-SHA-256 verifier Postgres stores
// for password (RFC 5802, RFC 7677).
func scramSHA256Verifier(password string, salt []byte, iterations int) string {
	salted, err := pbkdf2.Key(sha256.New, password, salt, iterations, sha256.Size)
	if err != nil {
		panic(err)
	}
	clientKey := hmacSHA256(salted, "Client Key")
	storedKey := sha256.Sum256(clientKey)
	serverKey := hmacSHA256(salted, "Server Key")
	enc := base64.StdEncoding.EncodeToString
	return fmt.Sprintf("SCRAM-SHA-256$%d:%s$%s:%s", iterations, enc(salt), enc(storedKey[:]), enc(serverKey))
}

func hmacSHA256(key []byte, msg string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(msg))
	return m.Sum(nil)
}

// postgresError is the short message for a Postgres error.
func postgresError(err error, write bool) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		msg := pgErr.Message
		switch pgErr.Code {
		case "25006":
			return "read-only mode: " + msg
		case "42501":
			if !write {
				return "read-only mode: " + msg
			}
		case "28P01", "28000":
			return "authentication failed"
		case "42601":
			if strings.Contains(msg, "multiple commands") {
				return "only one statement per query is allowed"
			}
		}
		return fmt.Sprintf("%s (SQLSTATE %s)", msg, pgErr.Code)
	}
	var ce *pgconn.ConnectError
	if errors.As(err, &ce) {
		if inner := errors.Unwrap(ce); inner != nil {
			return "cannot connect: " + inner.Error()
		}
		return "cannot connect"
	}
	return err.Error()
}

// namespaceOr returns ns, or def when ns is empty.
func namespaceOr(ns, def string) string {
	if ns == "" {
		return def
	}
	return ns
}

// offset returns op's row offset.
func offset(op *protocol.DBOp) int {
	if op.Offset == nil || *op.Offset < 0 {
		return 0
	}
	return *op.Offset
}
