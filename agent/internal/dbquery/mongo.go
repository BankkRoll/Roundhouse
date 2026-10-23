package dbquery

import (
	"context"
	"errors"
	"fmt"
	"net"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

const (
	mongoDefaultDatabase = "test"
	mongoAuthSource      = "admin"
	mongoSampleSize      = 100
	// mongoRawBudget bounds the BSON a query buffers, as a multiple of
	// max_bytes: documents beyond it could not fit the encoded result.
	mongoRawBudget = 4

	mongoCodeUnauthorized   = 13
	mongoCodeAuthFailed     = 18
	mongoCodeUserExists     = 51003
	mongoMaxCommandNameSize = 64
)

// mongoReadCommands are the commands read mode runs.
var mongoReadCommands = map[string]bool{
	"find": true, "aggregate": true, "count": true, "distinct": true,
	"listCollections": true, "listDatabases": true,
}

// mongoCursorCommands answer with a cursor.
var mongoCursorCommands = map[string]bool{"find": true, "aggregate": true, "listCollections": true, "listIndexes": true}

// mongoWriteDenied are commands not run even in write mode: they take the
// server down rather than change data.
var mongoWriteDenied = map[string]bool{"shutdown": true}

// mongoWriteStages are aggregation stages that write.
var mongoWriteStages = map[string]bool{"$out": true, "$merge": true}

type mongoSession struct {
	client *mongo.Client
	req    *request
}

func runMongo(ctx context.Context, req *request) (*resultSet, error) {
	t := req.target
	opts := options.Client().
		SetHosts([]string{net.JoinHostPort(t.Host, strconv.Itoa(t.Port))}).
		SetDirect(true).
		SetAuth(options.Credential{
			Username:   req.cred.Username,
			Password:   req.cred.Password,
			AuthSource: mongoAuthSource,
		}).
		SetConnectTimeout(req.connect).
		SetServerSelectionTimeout(req.connect).
		SetMaxPoolSize(1).
		SetRetryReads(false).
		SetRetryWrites(false).
		SetAppName("roundhouse-data-browser")
	// SECURITY: plaintext on the node's bridge network; see the package doc.
	client, err := mongo.Connect(opts)
	if err != nil {
		return nil, err
	}
	defer func() {
		dctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = client.Disconnect(dctx)
	}()
	cctx, cancel := context.WithTimeout(ctx, req.connect)
	err = client.Ping(cctx, nil)
	cancel()
	if err != nil {
		return nil, err
	}
	// NOTE: the driver turns this deadline into each command's maxTimeMS,
	// so the server stops the work too.
	qctx, cancel := context.WithTimeout(ctx, req.timeout)
	defer cancel()
	s := &mongoSession{client: client, req: req}
	return s.run(qctx)
}

func (s *mongoSession) database() string {
	return namespaceOr(s.req.op.Namespace, namespaceOr(s.req.target.Database, mongoDefaultDatabase))
}

func (s *mongoSession) run(ctx context.Context) (*resultSet, error) {
	op := s.req.op
	set := newResultSet(s.req.maxRows, s.req.maxBytes)
	switch op.Type {
	case protocol.DBOpListNamespaces:
		res, err := s.client.Database("admin").RunCommand(ctx, bson.D{
			{Key: "listDatabases", Value: 1}, {Key: "authorizedDatabases", Value: true},
		}).Raw()
		if err != nil {
			return nil, err
		}
		return set, addExpanded(set, res, "databases")
	case protocol.DBOpListTables:
		if !validMongoDatabase(s.database()) {
			return nil, usageError("invalid namespace")
		}
		return set, s.cursor(ctx, set, s.database(), bson.D{
			{Key: "listCollections", Value: 1}, {Key: "authorizedCollections", Value: true},
			{Key: "nameOnly", Value: true},
		}, []string{"name", "type"})
	case protocol.DBOpDescribe:
		if err := s.checkCollection(ctx, op.Table); err != nil {
			return nil, err
		}
		return set, s.describe(ctx, set)
	case protocol.DBOpRows:
		if err := s.checkCollection(ctx, op.Table); err != nil {
			return nil, err
		}
		if op.OrderBy != "" && !validMongoField(op.OrderBy) {
			return nil, usageError("invalid order_by")
		}
		cmd := bson.D{
			{Key: "find", Value: op.Table},
			{Key: "filter", Value: bson.D{}},
			{Key: "skip", Value: int64(offset(op))},
			{Key: "limit", Value: int64(s.req.maxRows + 1)},
			{Key: "batchSize", Value: int64(s.req.maxRows + 1)},
		}
		if op.OrderBy != "" {
			dir := 1
			if op.Descending != nil && *op.Descending {
				dir = -1
			}
			cmd = append(cmd, bson.E{Key: "sort", Value: bson.D{{Key: op.OrderBy, Value: dir}}})
		}
		return set, s.cursor(ctx, set, s.database(), cmd, nil)
	case protocol.DBOpRaw:
		return set, s.raw(ctx, set)
	case protocol.DBOpProvisionReadonly:
		return set, s.provision(ctx)
	}
	return nil, usageError("unsupported operation")
}

// checkCollection fails unless the collection exists in the database.
func (s *mongoSession) checkCollection(ctx context.Context, coll string) error {
	if !validMongoDatabase(s.database()) || !validMongoCollection(coll) {
		return usageError("invalid namespace or collection")
	}
	names, err := s.client.Database(s.database()).ListCollectionNames(ctx,
		bson.D{{Key: "name", Value: coll}}, options.ListCollections().SetAuthorizedCollections(true))
	if err != nil {
		return err
	}
	if len(names) == 0 {
		return usageError("collection not found")
	}
	return nil
}

// describe samples documents and reports each top-level field with the
// BSON types seen and how many sampled documents have it.
func (s *mongoSession) describe(ctx context.Context, set *resultSet) error {
	cur, err := s.client.Database(s.database()).RunCommandCursor(ctx, bson.D{
		{Key: "aggregate", Value: s.req.op.Table},
		{Key: "pipeline", Value: bson.A{bson.D{{Key: "$sample", Value: bson.D{{Key: "size", Value: mongoSampleSize}}}}}},
		{Key: "cursor", Value: bson.D{{Key: "batchSize", Value: mongoSampleSize}}},
	})
	if err != nil {
		return err
	}
	defer closeCursor(cur)
	type field struct {
		types []string
		count int64
	}
	var order []string
	fields := map[string]*field{}
	for cur.Next(ctx) {
		elems, err := cur.Current.Elements()
		if err != nil {
			return err
		}
		for _, e := range elems {
			f, ok := fields[e.Key()]
			if !ok {
				f = &field{}
				fields[e.Key()] = f
				order = append(order, e.Key())
			}
			f.count++
			if t := e.Value().Type.String(); !slices.Contains(f.types, t) {
				f.types = append(f.types, t)
			}
		}
	}
	if err := cur.Err(); err != nil {
		return err
	}
	if err := set.setColumns(columns("name:string", "types:string", "present_in_sample:int32")); err != nil {
		return err
	}
	for _, name := range order {
		f := fields[name]
		if !set.add([]any{name, strings.Join(f.types, "|"), int32(f.count)}) {
			break
		}
	}
	return nil
}

// raw runs a command document given as Extended JSON.
func (s *mongoSession) raw(ctx context.Context, set *resultSet) error {
	var cmd bson.D
	if err := bson.UnmarshalExtJSON([]byte(s.req.op.Statement), false, &cmd); err != nil {
		return usageError("statement must be a MongoDB command document as JSON")
	}
	if len(cmd) == 0 || len(cmd[0].Key) > mongoMaxCommandNameSize {
		return usageError("empty command document")
	}
	name := cmd[0].Key
	if s.req.write {
		if mongoWriteDenied[name] {
			return usageError(name + " is not allowed")
		}
	} else if err := checkMongoReadCommand(cmd); err != nil {
		return err
	}
	// NOTE: the driver sends maxTimeMS from the context deadline, and the
	// server rejects a command that carries two.
	cmd = slices.DeleteFunc(cmd, func(e bson.E) bool { return e.Key == "maxTimeMS" })
	db := s.database()
	if name == "listDatabases" {
		db = "admin"
	}
	if !validMongoDatabase(db) {
		return usageError("invalid namespace")
	}
	if mongoCursorCommands[name] {
		return s.cursor(ctx, set, db, capBatch(cmd, s.req.maxRows+1), nil)
	}
	res, err := s.client.Database(db).RunCommand(ctx, cmd).Raw()
	if err != nil {
		return err
	}
	switch name {
	case "listDatabases":
		return addExpanded(set, res, "databases")
	case "distinct":
		return addExpanded(set, res, "values")
	}
	return addDocs(set, []bson.Raw{withoutReplyMeta(res)}, nil)
}

// checkMongoReadCommand allows read mode's commands, and no write stage
// anywhere in them, including pipelines nested in $lookup, $facet and
// $unionWith.
func checkMongoReadCommand(cmd bson.D) error {
	if len(cmd) == 0 {
		return usageError("empty command document")
	}
	if !mongoReadCommands[cmd[0].Key] {
		return readOnlyError("only find, aggregate, count, distinct, listCollections and listDatabases are allowed")
	}
	if stage := findWriteStage(cmd, 0); stage != "" {
		return readOnlyError(stage + " writes and is not allowed")
	}
	return nil
}

// findWriteStage returns the first write stage key anywhere in v.
func findWriteStage(v any, depth int) string {
	if depth > 100 {
		return "deeply nested document"
	}
	switch x := v.(type) {
	case bson.D:
		for _, e := range x {
			if mongoWriteStages[e.Key] {
				return e.Key
			}
			if s := findWriteStage(e.Value, depth+1); s != "" {
				return s
			}
		}
	case bson.M:
		for k, e := range x {
			if mongoWriteStages[k] {
				return k
			}
			if s := findWriteStage(e, depth+1); s != "" {
				return s
			}
		}
	case map[string]any:
		return findWriteStage(bson.M(x), depth)
	case bson.A:
		for _, e := range x {
			if s := findWriteStage(e, depth+1); s != "" {
				return s
			}
		}
	case []any:
		return findWriteStage(bson.A(x), depth)
	}
	return ""
}

// setField sets key in doc, replacing an existing value.
func setField(doc bson.D, key string, val any) bson.D {
	for i := range doc {
		if doc[i].Key == key {
			doc[i].Value = val
			return doc
		}
	}
	return append(doc, bson.E{Key: key, Value: val})
}

// capBatch bounds the first batch of a cursor command, so the server does
// not send more documents than the result can hold.
func capBatch(cmd bson.D, n int) bson.D {
	switch cmd[0].Key {
	case "find":
		return setField(cmd, "batchSize", int64(n))
	default:
		cursor := bson.D{}
		for _, e := range cmd {
			if e.Key == "cursor" {
				if d, ok := e.Value.(bson.D); ok {
					cursor = d
				}
			}
		}
		return setField(cmd, "cursor", setField(cursor, "batchSize", int64(n)))
	}
}

// cursor runs a cursor command and adds its documents. cols, when set,
// fixes the columns; otherwise they are the documents' top-level fields.
func (s *mongoSession) cursor(ctx context.Context, set *resultSet, db string, cmd bson.D, cols []string) error {
	cur, err := s.client.Database(db).RunCommandCursor(ctx, cmd)
	if err != nil {
		return err
	}
	defer closeCursor(cur)
	var docs []bson.Raw
	budget := mongoRawBudget * set.maxBytes
	for cur.Next(ctx) {
		if len(docs) >= set.maxRows {
			set.truncated = true
			break
		}
		budget -= len(cur.Current)
		if budget < 0 && len(docs) > 0 {
			set.truncated = true
			set.notice(fmt.Sprintf("result truncated at %d bytes", set.maxBytes))
			break
		}
		docs = append(docs, slices.Clone(cur.Current))
	}
	if err := cur.Err(); err != nil {
		return err
	}
	return addDocs(set, docs, cols)
}

func closeCursor(cur *mongo.Cursor) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = cur.Close(ctx)
}

// addExpanded adds each element of res's array field as a row.
func addExpanded(set *resultSet, res bson.Raw, field string) error {
	arr, ok := res.Lookup(field).ArrayOK()
	if !ok {
		return addDocs(set, []bson.Raw{withoutReplyMeta(res)}, nil)
	}
	vals, err := arr.Values()
	if err != nil {
		return err
	}
	var docs []bson.Raw
	scalar := false
	for _, v := range vals {
		if d, ok := v.DocumentOK(); ok {
			docs = append(docs, d)
		} else {
			scalar = true
		}
	}
	if !scalar {
		return addDocs(set, docs, nil)
	}
	if err := set.setColumns(columns("value")); err != nil {
		return err
	}
	for _, v := range vals {
		if !set.add([]any{bsonValue(v, 0)}) {
			break
		}
	}
	return nil
}

// withoutReplyMeta drops a reply's ok and cluster bookkeeping fields.
func withoutReplyMeta(res bson.Raw) bson.Raw {
	elems, err := res.Elements()
	if err != nil {
		return res
	}
	var d bson.D
	for _, e := range elems {
		switch e.Key() {
		case "ok", "$clusterTime", "operationTime":
			continue
		}
		d = append(d, bson.E{Key: e.Key(), Value: e.Value()})
	}
	out, err := bson.Marshal(d)
	if err != nil {
		return res
	}
	return out
}

// addDocs adds documents as rows. Columns are cols, or the union of the
// documents' top-level fields in order of first appearance, typed by the
// first BSON type seen ("mixed" when they differ).
func addDocs(set *resultSet, docs []bson.Raw, cols []string) error {
	fixed := cols != nil
	index := map[string]int{}
	var types []string
	for i, c := range cols {
		index[c] = i
		types = append(types, "")
	}
	parsed := make([][]bson.RawElement, len(docs))
	for i, d := range docs {
		elems, err := d.Elements()
		if err != nil {
			return err
		}
		parsed[i] = elems
		for _, e := range elems {
			j, ok := index[e.Key()]
			if !ok {
				if fixed {
					continue
				}
				if len(cols) >= protocol.MaxDBColumns {
					set.notice(fmt.Sprintf("only the first %d fields are shown", protocol.MaxDBColumns))
					continue
				}
				j = len(cols)
				index[e.Key()] = j
				cols = append(cols, e.Key())
				types = append(types, "")
			}
			t := e.Value().Type
			if t == bson.TypeNull {
				continue
			}
			switch types[j] {
			case "":
				types[j] = t.String()
			case t.String(), "mixed":
			default:
				types[j] = "mixed"
			}
		}
	}
	dbCols := make([]protocol.DBColumn, len(cols))
	for i, c := range cols {
		dbCols[i] = protocol.DBColumn{Name: c, Type: types[i]}
	}
	if err := set.setColumns(dbCols); err != nil {
		return err
	}
	for _, elems := range parsed {
		row := make([]any, len(cols))
		for _, e := range elems {
			if j, ok := index[e.Key()]; ok {
				row[j] = bsonValue(e.Value(), 0)
			}
		}
		if !set.add(row) {
			break
		}
	}
	return nil
}

// bsonValue turns a BSON value into a JSON value in the result's encoding,
// with Extended JSON-style wrappers for types JSON lacks.
func bsonValue(v bson.RawValue, depth int) any {
	if depth > maxValueDepth {
		return "…"
	}
	switch v.Type {
	case bson.TypeDouble:
		return finite(v.Double(), 64)
	case bson.TypeString:
		return v.StringValue()
	case bson.TypeEmbeddedDocument:
		elems, err := v.Document().Elements()
		if err != nil {
			return nil
		}
		m := make(map[string]any, len(elems))
		for _, e := range elems {
			m[e.Key()] = bsonValue(e.Value(), depth+1)
		}
		return m
	case bson.TypeArray:
		vals, err := v.Array().Values()
		if err != nil {
			return nil
		}
		out := make([]any, len(vals))
		for i, e := range vals {
			out[i] = bsonValue(e, depth+1)
		}
		return out
	case bson.TypeBinary:
		_, data := v.Binary()
		return b64(data)
	case bson.TypeObjectID:
		return map[string]any{"$oid": v.ObjectID().Hex()}
	case bson.TypeBoolean:
		return v.Boolean()
	case bson.TypeDateTime:
		return time.UnixMilli(v.DateTime()).UTC().Format(time.RFC3339Nano)
	case bson.TypeNull, bson.TypeUndefined:
		return nil
	case bson.TypeRegex:
		p, o := v.Regex()
		return map[string]any{"$regex": p, "$options": o}
	case bson.TypeInt32:
		return v.Int32()
	case bson.TypeInt64:
		return strconv.FormatInt(v.Int64(), 10)
	case bson.TypeTimestamp:
		t, i := v.Timestamp()
		return map[string]any{"$timestamp": map[string]any{"t": t, "i": i}}
	case bson.TypeDecimal128:
		return v.Decimal128().String()
	case bson.TypeJavaScript:
		return v.JavaScript()
	case bson.TypeSymbol:
		return v.Symbol()
	case bson.TypeMinKey:
		return map[string]any{"$minKey": 1}
	case bson.TypeMaxKey:
		return map[string]any{"$maxKey": 1}
	}
	return v.String()
}

// provision creates or updates roundhouse_ro in admin with readAnyDatabase.
func (s *mongoSession) provision(ctx context.Context) error {
	pw := s.req.cred.ReadonlyPassword
	if pw == "" {
		return usageError("provision_readonly needs the read-only password")
	}
	admin := s.client.Database("admin")
	info, err := admin.RunCommand(ctx, bson.D{
		{Key: "usersInfo", Value: bson.D{{Key: "user", Value: ReadonlyUser}, {Key: "db", Value: "admin"}}},
	}).Raw()
	if err != nil {
		return err
	}
	exists := false
	if users, ok := info.Lookup("users").ArrayOK(); ok {
		vals, _ := users.Values()
		exists = len(vals) > 0
	}
	set := func(verb string) error {
		return admin.RunCommand(ctx, bson.D{
			{Key: verb, Value: ReadonlyUser},
			{Key: "pwd", Value: pw},
			{Key: "roles", Value: bson.A{bson.D{{Key: "role", Value: "readAnyDatabase"}, {Key: "db", Value: "admin"}}}},
		}).Err()
	}
	if exists {
		return set("updateUser")
	}
	err = set("createUser")
	var ce mongo.CommandError
	if errors.As(err, &ce) && ce.Code == mongoCodeUserExists {
		err = set("updateUser")
	}
	return err
}

// validMongoDatabase reports whether name can name a database.
func validMongoDatabase(name string) bool {
	return name != "" && len(name) < 64 && !strings.ContainsAny(name, "/\\. \"$*<>:|?\x00")
}

// validMongoCollection reports whether name can name a collection.
func validMongoCollection(name string) bool {
	return name != "" && len(name) <= 255 && !strings.ContainsAny(name, "$\x00")
}

// validMongoField reports whether name is a plain field path.
func validMongoField(name string) bool {
	return name != "" && len(name) <= protocol.MaxDBIdentifierBytes && !strings.HasPrefix(name, "$") &&
		!strings.ContainsRune(name, 0)
}

// mongoError is the short message for a MongoDB error.
func mongoError(err error, write bool) string {
	var ce mongo.CommandError
	if errors.As(err, &ce) && ce.Code != 0 {
		switch ce.Code {
		case mongoCodeUnauthorized:
			if !write {
				return "read-only mode: " + ce.Message
			}
		case mongoCodeAuthFailed:
			return "authentication failed"
		}
		return fmt.Sprintf("%s (%s)", ce.Message, ce.Name)
	}
	var se mongo.ServerError
	if errors.As(err, &se) && se.HasErrorCode(mongoCodeUnauthorized) && !write {
		return "read-only mode: " + err.Error()
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "AuthenticationFailed") || strings.Contains(msg, "auth error"):
		return "authentication failed"
	case strings.Contains(msg, "server selection"):
		return "cannot connect: the database did not answer"
	case mongo.IsTimeout(err):
		return "timed out"
	}
	return msg
}
