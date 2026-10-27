package dbquery

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

const (
	myListNamespaces = `SELECT schema_name AS name FROM information_schema.schemata
WHERE schema_name NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
ORDER BY 1`

	myListTables = `SELECT table_name AS name, LOWER(table_type) AS type, table_rows AS estimated_rows
FROM information_schema.tables WHERE table_schema = ? ORDER BY 1`

	myDescribe = `SELECT column_name AS name, column_type AS type, IF(is_nullable = 'YES', 'true', 'false') AS nullable,
  column_default AS ` + "`default`" + `, IF(column_key = 'PRI', 'true', 'false') AS primary_key
FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`

	myTableExists = `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`

	myColumnExists = `SELECT COUNT(*) FROM information_schema.columns
WHERE table_schema = ? AND table_name = ? AND column_name = ?`
)

// mySession is one MySQL connection.
type mySession struct {
	db   *sql.DB
	conn *sql.Conn
	req  *request
}

func runMySQL(ctx context.Context, req *request) (*resultSet, error) {
	s := &mySession{req: req}
	if err := s.connect(ctx); err != nil {
		return nil, err
	}
	defer func() {
		_ = s.conn.Close()
		_ = s.db.Close()
	}()
	return s.run(ctx)
}

func (s *mySession) connect(ctx context.Context) error {
	t := s.req.target
	cfg := mysql.NewConfig()
	cfg.User = s.req.cred.Username
	cfg.Passwd = s.req.cred.Password
	cfg.Net = "tcp"
	cfg.Addr = net.JoinHostPort(t.Host, strconv.Itoa(t.Port))
	cfg.DBName = t.Database
	cfg.Timeout = s.req.connect
	cfg.ReadTimeout = s.req.connect + s.req.timeout
	cfg.WriteTimeout = s.req.connect + s.req.timeout
	cfg.Loc = time.UTC
	cfg.ParseTime = true
	// SECURITY: one statement per query, sent as written; placeholders
	// travel as prepared-statement parameters, never spliced into SQL.
	cfg.MultiStatements = false
	cfg.InterpolateParams = false
	// SECURITY: LOAD DATA LOCAL INFILE must not read the node's files.
	cfg.AllowAllFiles = false
	cfg.AllowCleartextPasswords = false
	cfg.AllowOldPasswords = false
	// SECURITY: plaintext on the node's bridge network; see the package
	// doc. caching_sha2_password then fetches the server's RSA key.
	cfg.TLS = nil
	cfg.TLSConfig = ""
	cfg.Logger = &mysql.NopLogger{}
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return usageError("invalid connection settings")
	}
	s.db = sql.OpenDB(connector)
	s.db.SetMaxOpenConns(1)
	cctx, cancel := context.WithTimeout(ctx, s.req.connect)
	defer cancel()
	conn, err := s.db.Conn(cctx)
	if err == nil {
		err = conn.PingContext(cctx)
	}
	if err != nil {
		_ = s.db.Close()
		return err
	}
	s.conn = conn
	return nil
}

func (s *mySession) run(ctx context.Context) (*resultSet, error) {
	op := s.req.op
	set := newResultSet(s.req.maxRows, s.req.maxBytes)
	ns := namespaceOr(op.Namespace, s.req.target.Database)
	switch op.Type {
	case protocol.DBOpListNamespaces:
		return set, s.inTx(ctx, func(tx *sql.Tx) error {
			return s.collect(ctx, tx, set, true, myListNamespaces)
		})
	case protocol.DBOpListTables:
		if !validIdent(ns) {
			return nil, usageError("namespace required")
		}
		return set, s.inTx(ctx, func(tx *sql.Tx) error {
			return s.collect(ctx, tx, set, true, myListTables, ns)
		})
	case protocol.DBOpDescribe:
		if !validIdent(ns) || !validIdent(op.Table) {
			return nil, usageError("invalid namespace or table")
		}
		return set, s.inTx(ctx, func(tx *sql.Tx) error {
			if err := myCheckTable(ctx, tx, ns, op.Table, ""); err != nil {
				return err
			}
			if err := s.collect(ctx, tx, set, true, myDescribe, ns, op.Table); err != nil {
				return err
			}
			for _, row := range set.rows {
				row[2], row[4] = row[2] == "true", row[4] == "true"
			}
			return nil
		})
	case protocol.DBOpRows:
		if !validIdent(ns) || !validIdent(op.Table) {
			return nil, usageError("invalid namespace or table")
		}
		if op.OrderBy != "" && !validIdent(op.OrderBy) {
			return nil, usageError("invalid order_by")
		}
		return set, s.inTx(ctx, func(tx *sql.Tx) error {
			if err := myCheckTable(ctx, tx, ns, op.Table, op.OrderBy); err != nil {
				return err
			}
			return s.collect(ctx, tx, set, true, myRowsSQL(ns, op, s.req.maxRows+1))
		})
	case protocol.DBOpRaw:
		args := make([]any, len(op.Params))
		for i, p := range op.Params {
			if p != nil {
				args[i] = *p
			}
		}
		return set, s.inTx(ctx, func(tx *sql.Tx) error {
			return s.collect(ctx, tx, set, false, op.Statement, args...)
		})
	case protocol.DBOpProvisionReadonly:
		return set, s.provision(ctx)
	case protocol.DBOpSetPassword:
		if err := s.setPassword(ctx); err != nil {
			return nil, err
		}
		return passwordSet(s.req), nil
	}
	return nil, usageError("unsupported operation")
}

func myRowsSQL(ns string, op *protocol.DBOp, limit int) string {
	q := "SELECT * FROM " + quoteMySQLIdent(ns) + "." + quoteMySQLIdent(op.Table)
	if op.OrderBy != "" {
		q += " ORDER BY " + quoteMySQLIdent(op.OrderBy)
		if op.Descending != nil && *op.Descending {
			q += " DESC"
		}
	}
	return q + fmt.Sprintf(" LIMIT %d OFFSET %d", limit, offset(op))
}

// myCheckTable fails unless ns.table exists and, when given, has column col.
func myCheckTable(ctx context.Context, tx *sql.Tx, ns, table, col string) error {
	var n int
	if err := tx.QueryRowContext(ctx, myTableExists, ns, table).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return usageError("table not found")
	}
	if col == "" {
		return nil
	}
	if err := tx.QueryRowContext(ctx, myColumnExists, ns, table, col).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return usageError("order_by: no such column")
	}
	return nil
}

// inTx sets the session's server-side timeouts and runs fn in a
// transaction: START TRANSACTION READ ONLY and always rolled back in read
// mode, committed when fn succeeds in write mode.
func (s *mySession) inTx(ctx context.Context, fn func(*sql.Tx) error) error {
	ms := max(s.req.timeout.Milliseconds(), 1)
	secs := max((ms+999)/1000, 1)
	if _, err := s.conn.ExecContext(ctx, fmt.Sprintf(
		"SET SESSION max_execution_time = %d, lock_wait_timeout = %d, innodb_lock_wait_timeout = %d", ms, secs, secs)); err != nil {
		return err
	}
	tx, err := s.conn.BeginTx(ctx, &sql.TxOptions{ReadOnly: !s.req.write})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := fn(tx); err != nil {
		return err
	}
	if s.req.write {
		return tx.Commit()
	}
	return nil
}

// collect runs query and adds its rows to set. bounded says query has its
// own LIMIT; otherwise read mode drops the connection rather than reading
// the rows it will not return.
func (s *mySession) collect(ctx context.Context, tx *sql.Tx, set *resultSet, bounded bool, query string, args ...any) error {
	qctx, cancel := context.WithCancel(ctx)
	defer cancel()
	rows, err := tx.QueryContext(qctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	cts, err := rows.ColumnTypes()
	if err != nil {
		return err
	}
	cols := make([]protocol.DBColumn, len(cts))
	types := make([]string, len(cts))
	for i, ct := range cts {
		types[i] = ct.DatabaseTypeName()
		cols[i] = protocol.DBColumn{Name: ct.Name(), Type: types[i]}
	}
	if err := set.setColumns(cols); err != nil {
		return err
	}
	vals := make([]any, len(cts))
	ptrs := make([]any, len(cts))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return err
		}
		row := make([]any, len(vals))
		for i, v := range vals {
			row[i] = mysqlValue(types[i], v)
		}
		if !set.add(row) {
			if !bounded && !s.req.write {
				// NOTE: the driver closes the connection when the context
				// ends, which stops the server sending the rest.
				cancel()
			}
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(cts) == 0 {
		var n int64
		if err := tx.QueryRowContext(ctx, "SELECT ROW_COUNT()").Scan(&n); err == nil && n >= 0 {
			set.affected = &n
		}
	}
	return nil
}

// mysqlValue maps a scanned value by its column type: binary types to
// base64, BIT to its unsigned value, other bytes to text.
func mysqlValue(typ string, v any) any {
	b, ok := v.([]byte)
	if !ok {
		return v
	}
	switch typ {
	case "BINARY", "VARBINARY", "BLOB", "TINYBLOB", "MEDIUMBLOB", "LONGBLOB", "GEOMETRY":
		return b64(b)
	case "BIT":
		if len(b) <= 8 {
			var buf [8]byte
			copy(buf[8-len(b):], b)
			return strconv.FormatUint(binary.BigEndian.Uint64(buf[:]), 10)
		}
		return b64(b)
	}
	return text(b)
}

// provision creates or updates roundhouse_ro@% with the read-only password
// and grants it SELECT and SHOW VIEW on everything except the mysql system
// schema.
func (s *mySession) provision(ctx context.Context) error {
	pw := s.req.cred.ReadonlyPassword
	if pw == "" {
		return usageError("provision_readonly needs the read-only password")
	}
	var mode string
	if err := s.conn.QueryRowContext(ctx, "SELECT @@SESSION.sql_mode").Scan(&mode); err != nil {
		return err
	}
	// NOTE: IDENTIFIED BY takes a literal, not a placeholder, so the
	// password is quoted here for the session's escaping rules. The server
	// rewrites the password out of its general and slow logs.
	lit := quoteMySQLString(pw, strings.Contains(strings.ToUpper(mode), "NO_BACKSLASH_ESCAPES"))
	user := quoteMySQLString(ReadonlyUser, false) + "@'%'"
	for _, stmt := range []string{
		"CREATE USER IF NOT EXISTS " + user + " IDENTIFIED BY " + lit,
		"ALTER USER " + user + " IDENTIFIED BY " + lit,
		"GRANT SELECT, SHOW VIEW ON *.* TO " + user,
		// SECURITY: a global SELECT would let the browser read mysql.user and
		// its password hashes. Partial revokes carve the system schema out of
		// the global grant; the setting persists across restarts.
		"SET PERSIST partial_revokes = ON",
	} {
		if _, err := s.conn.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	if _, err := s.conn.ExecContext(ctx, "REVOKE SELECT, SHOW VIEW ON mysql.* FROM "+user); err != nil && !isNoSuchGrant(err) {
		return err
	}
	return nil
}

// setPassword sets the new password on every host the user exists on (the
// template's root is both root@'%' and root@'localhost').
func (s *mySession) setPassword(ctx context.Context) error {
	user := s.req.op.User
	rows, err := s.conn.QueryContext(ctx, "SELECT Host FROM mysql.user WHERE User = ? ORDER BY Host", user)
	if err != nil {
		return err
	}
	var hosts []string
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err != nil {
			rows.Close()
			return err
		}
		hosts = append(hosts, h)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(hosts) == 0 {
		return usageError(fmt.Sprintf("user %q does not exist", user))
	}
	var mode string
	if err := s.conn.QueryRowContext(ctx, "SELECT @@SESSION.sql_mode").Scan(&mode); err != nil {
		return err
	}
	nbe := strings.Contains(strings.ToUpper(mode), "NO_BACKSLASH_ESCAPES")
	lit := quoteMySQLString(s.req.cred.NewPassword, nbe)
	specs := make([]string, len(hosts))
	for i, h := range hosts {
		specs[i] = quoteMySQLString(user, nbe) + "@" + quoteMySQLString(h, nbe) + " IDENTIFIED BY " + lit
	}
	// NOTE: one statement for every host, so the accounts change together
	// (account management is atomic DDL since MySQL 8.0). The server
	// rewrites the password out of its general and slow logs.
	_, err = s.conn.ExecContext(ctx, "ALTER USER "+strings.Join(specs, ", "))
	return err
}

// isNoSuchGrant reports MySQL error 1141/1147: the revoke already applies.
func isNoSuchGrant(err error) bool {
	var me *mysql.MySQLError
	return errors.As(err, &me) && (me.Number == 1141 || me.Number == 1147)
}

// mysqlError is the short message for a MySQL error.
func mysqlError(err error, write bool) string {
	var me *mysql.MySQLError
	if errors.As(err, &me) {
		switch me.Number {
		case 1792:
			return "read-only mode: " + me.Message
		case 1044, 1142, 1143, 1227, 1370:
			if !write {
				return "read-only mode: " + me.Message
			}
		case 1045:
			return "authentication failed"
		}
		return fmt.Sprintf("%s (error %d)", me.Message, me.Number)
	}
	if errors.Is(err, mysql.ErrInvalidConn) || errors.Is(err, driver.ErrBadConn) {
		return "connection to the database was lost"
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return "cannot connect: " + ne.Error()
	}
	return err.Error()
}
