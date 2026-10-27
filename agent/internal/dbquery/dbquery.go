// Package dbquery runs the data browser's operations against a database
// container with a native driver: pgx for Postgres, go-sql-driver/mysql for
// MySQL, the official MongoDB driver, and a minimal RESP2 client for Redis
// and Valkey. It never shells out.
//
// Responsibilities:
//   - list namespaces, list tables, describe, page rows, run raw statements,
//     provision the read-only principal (roundhouse_ro), and set a
//     template principal's password (credential rotation);
//   - enforce read-only mode beyond the principal: read-only transactions
//     with server-side timeouts on SQL, a command and stage allowlist on
//     MongoDB, a command allowlist with capped counts on Redis, and a single
//     statement per query everywhere;
//   - bound every result: max_rows (fetching one more to set truncated),
//     max_bytes of encoded rows, and timeout_ms;
//   - encode cells as JSON values: binary as {"$b64": …}, 64-bit integers
//     as strings, timestamps as RFC 3339;
//   - report errors as short messages that never carry a credential.
//
// A [Runner] holds no connections between calls: each [Runner.Run] dials,
// runs one operation and closes, so it is safe for concurrent use and has no
// Docker or control-connection dependencies.
//
// Redis list_tables pages with SCAN. The result has no cursor field, so the
// next cursor travels in the notice as "cursor:<n>" ("cursor:0" when the
// scan is complete).
//
// SECURITY: connections go to the container's address on a private bridge
// network without TLS. The bridge is local to the node and the images ship
// without certificates; anything that can sniff the bridge already has root
// on the node.
package dbquery

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// ReadonlyUser is the read-only principal the data browser's read mode
// connects as, and the one provision_readonly creates.
const ReadonlyUser = "roundhouse_ro"

// Engines, as in [Target].Engine and protocol.DatabaseEngine.
const (
	EnginePostgres = string(protocol.EnginePostgres)
	EngineMySQL    = string(protocol.EngineMySQL)
	EngineRedis    = string(protocol.EngineRedis)
	EngineMongoDB  = string(protocol.EngineMongoDB)
)

const (
	defaultMaxRows        = 100
	defaultTimeout        = 10 * time.Second
	maxConnectTimeout     = 5 * time.Second
	defaultMaxConcurrent  = 4
	maxErrorBytes         = 1024
	maxNoticeBytes        = 2048
	minScrubbedSecretSize = 6
)

// Target is the database a query runs against.
type Target struct {
	// Engine is one of postgres, mysql, redis, mongodb; it must match the
	// query's engine.
	Engine string
	// Host is the container's address on the bridge network.
	Host string
	Port int
	// Database is the database to connect to: the Postgres database, the
	// default MySQL schema, the default MongoDB database, or a Redis DB
	// index. Empty picks the engine's default.
	Database string
	// AppUser is the application principal from the container's
	// environment (MYSQL_USER), which set_password may also change.
	AppUser string
}

// Credential is the principal a query connects as.
type Credential struct {
	Username, Password string
	// ReadonlyPassword is the password provision_readonly sets for
	// roundhouse_ro. Only that op reads it.
	ReadonlyPassword string
	// NewPassword is the password set_password sets. Only that op reads
	// it.
	NewPassword string
}

// Options tunes a [Runner]. The zero value is usable.
type Options struct {
	// ConnectTimeout bounds dialing and authenticating; default and
	// maximum 5 s.
	ConnectTimeout time.Duration
	// MaxConcurrent is how many queries run at once; others wait for a
	// slot until their context ends. Default 4.
	MaxConcurrent int
}

// Runner runs data-browser operations. It is safe for concurrent use.
type Runner struct {
	connectTimeout time.Duration
	slots          chan struct{}
}

// New returns a Runner configured by opts.
//
// Example:
//
//	r := dbquery.New(dbquery.Options{})
//	res := r.Run(ctx, dbquery.Target{Engine: "postgres", Host: ip, Port: 5432, Database: "app"},
//		dbquery.Credential{Username: "roundhouse_ro", Password: pw}, q)
func New(opts Options) *Runner {
	ct := opts.ConnectTimeout
	if ct <= 0 || ct > maxConnectTimeout {
		ct = maxConnectTimeout
	}
	n := opts.MaxConcurrent
	if n <= 0 {
		n = defaultMaxConcurrent
	}
	return &Runner{connectTimeout: ct, slots: make(chan struct{}, n)}
}

// request is one query with its limits resolved.
type request struct {
	target   Target
	cred     Credential
	op       *protocol.DBOp
	write    bool
	maxRows  int
	maxBytes int
	timeout  time.Duration
	connect  time.Duration
}

// Run runs q against t as cred and always returns a result: failures come
// back with OK false and a short, credential-free Error. RequestID is
// echoed and DurationMS covers the whole call. q is expected to have passed
// its Validate.
func (r *Runner) Run(ctx context.Context, t Target, cred Credential, q *protocol.DBQuery) *protocol.DBQueryResult {
	start := time.Now()
	res := &protocol.DBQueryResult{Type: protocol.TypeDBQueryResult}
	if q == nil {
		res.Error = "no query"
		return res
	}
	res.RequestID = q.RequestID

	set, err := r.run(ctx, t, cred, q)
	if err != nil {
		res.Error = clip(scrub(errorMessage(err, q), cred), maxErrorBytes)
	} else {
		set.fill(res)
		res.Notice = clip(scrub(res.Notice, cred), maxNoticeBytes)
	}
	res.DurationMS = time.Since(start).Milliseconds()
	return res
}

func (r *Runner) run(ctx context.Context, t Target, cred Credential, q *protocol.DBQuery) (*resultSet, error) {
	if t.Engine != string(q.Engine) {
		return nil, usageError("target engine does not match the query")
	}
	if q.Mode != "read" && q.Mode != "write" {
		return nil, usageError("mode must be read or write")
	}
	if t.Host == "" || t.Port < 1 || t.Port > 65535 {
		return nil, usageError("no database address")
	}
	if cred.Username == "" || cred.Password == "" {
		return nil, usageError("no credential")
	}
	req := &request{
		target:   t,
		cred:     cred,
		op:       &q.Op,
		write:    q.Mode == "write",
		maxRows:  q.MaxRows,
		maxBytes: q.MaxBytes,
		timeout:  time.Duration(q.TimeoutMS) * time.Millisecond,
		connect:  r.connectTimeout,
	}
	if req.maxRows < 1 {
		req.maxRows = defaultMaxRows
	}
	req.maxRows = min(req.maxRows, protocol.MaxDBQueryRows)
	if req.maxBytes < 1 || req.maxBytes > protocol.MaxDBQueryResultBytes {
		req.maxBytes = protocol.MaxDBQueryResultBytes
	}
	if req.timeout <= 0 {
		req.timeout = defaultTimeout
	}
	req.timeout = min(req.timeout, time.Duration(protocol.MaxDBQueryTimeoutMS)*time.Millisecond)
	if req.op.Type == protocol.DBOpProvisionReadonly && !req.write {
		return nil, usageError("provision_readonly runs as the admin")
	}
	if req.op.Type == protocol.DBOpSetPassword {
		if err := checkSetPassword(req); err != nil {
			return nil, err
		}
	}

	select {
	case r.slots <- struct{}{}:
		defer func() { <-r.slots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	// NOTE: connecting gets its own budget on top of the query's, so a slow
	// handshake does not eat the statement's time.
	ctx, cancel := context.WithTimeout(ctx, req.connect+req.timeout)
	defer cancel()

	switch t.Engine {
	case EnginePostgres:
		return runPostgres(ctx, req)
	case EngineMySQL:
		return runMySQL(ctx, req)
	case EngineMongoDB:
		return runMongo(ctx, req)
	case EngineRedis:
		return runRedis(ctx, req)
	}
	return nil, usageError("unsupported engine")
}

// newPasswordRE mirrors the protocol's rule for a new password: a charset
// that needs no quoting in SQL literals, ACL rules or URLs.
var newPasswordRE = regexp.MustCompile(`^[A-Za-z0-9._~-]{16,256}$`)

// checkSetPassword refuses a set_password that does not run as the admin,
// lacks an acceptable new password, or names a principal other than the
// admin, roundhouse_ro or the container's application user.
//
// SECURITY: the control plane only rotates the template's principals; the
// agent holds it to that whatever user a frame names.
func checkSetPassword(req *request) error {
	if !req.write {
		return usageError("set_password runs as the admin")
	}
	if !newPasswordRE.MatchString(req.cred.NewPassword) {
		return usageError("set_password needs a new password of 16 to 256 URL-safe characters")
	}
	switch user := req.op.User; {
	case user == "":
		return usageError("set_password needs a user")
	case user == req.cred.Username, user == ReadonlyUser:
	case req.target.Engine == EngineMySQL && req.target.AppUser != "" && user == req.target.AppUser:
	default:
		return usageError(fmt.Sprintf("set_password changes only the admin, %s or the application user, not %q", ReadonlyUser, user))
	}
	return nil
}

// passwordSet is the result of a successful set_password.
func passwordSet(req *request) *resultSet {
	set := newResultSet(req.maxRows, req.maxBytes)
	set.notice("password set for " + req.op.User)
	return set
}

// usageError is a message about the request itself, shown as is.
type usageError string

func (e usageError) Error() string { return string(e) }

// readOnlyError is a statement read mode refused before it reached the
// server.
type readOnlyError string

func (e readOnlyError) Error() string { return "read-only mode: " + string(e) }

// errorMessage turns err into the short message a result carries.
func errorMessage(err error, q *protocol.DBQuery) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Sprintf("timed out after %d ms", q.TimeoutMS)
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	var ue usageError
	if errors.As(err, &ue) {
		return string(ue)
	}
	var re readOnlyError
	if errors.As(err, &re) {
		return re.Error()
	}
	write := q.Mode == "write"
	switch q.Engine {
	case protocol.EnginePostgres:
		return postgresError(err, write)
	case protocol.EngineMySQL:
		return mysqlError(err, write)
	case protocol.EngineMongoDB:
		return mongoError(err, write)
	case protocol.EngineRedis:
		return redisError(err, write)
	}
	return err.Error()
}

// scrub removes the credential's secrets from s.
//
// SECURITY: drivers echo parts of a connection string in some errors;
// none is known to include the password, but nothing derived from it may
// leave the node.
func scrub(s string, cred Credential) string {
	for _, secret := range []string{cred.Password, cred.ReadonlyPassword, cred.NewPassword} {
		if len(secret) >= minScrubbedSecretSize {
			s = strings.ReplaceAll(s, secret, "[redacted]")
		}
	}
	return s
}

// clip shortens s to at most n bytes on a rune boundary.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
