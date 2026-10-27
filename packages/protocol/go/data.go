package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// DatabaseEngine is an engine the agent has dump tools and drivers for.
type DatabaseEngine string

// Database engines.
const (
	EnginePostgres DatabaseEngine = "postgres"
	EngineMySQL    DatabaseEngine = "mysql"
	EngineRedis    DatabaseEngine = "redis"
	EngineMongoDB  DatabaseEngine = "mongodb"
)

func (e DatabaseEngine) valid() bool {
	return e == EnginePostgres || e == EngineMySQL || e == EngineRedis || e == EngineMongoDB
}

// BackupMethod is how a backup reads its source.
type BackupMethod string

// Backup methods: dump runs the engine's tool in the container; snapshot
// tars the volume; base (Postgres, from [PITRProtocolVersion]) is a
// pg_basebackup that archived WAL replays onto.
const (
	BackupDump     BackupMethod = "dump"
	BackupSnapshot BackupMethod = "snapshot"
	BackupBase     BackupMethod = "base"
)

// VolumeQuotaMode is how the node enforces a volume's quota.
type VolumeQuotaMode string

// Quota modes.
const (
	QuotaXFSProject  VolumeQuotaMode = "xfs_project"
	QuotaExt4Project VolumeQuotaMode = "ext4_project"
	QuotaLoop        VolumeQuotaMode = "loop"
	QuotaNone        VolumeQuotaMode = "none"
)

func (q VolumeQuotaMode) valid() bool {
	return q == QuotaXFSProject || q == QuotaExt4Project || q == QuotaLoop || q == QuotaNone
}

// VolumeState is a volume's state on the node.
type VolumeState string

// Volume states. Orphaned means held but no longer listed in desired state.
const (
	VolumeCreating VolumeState = "creating"
	VolumeReady    VolumeState = "ready"
	VolumeResizing VolumeState = "resizing"
	VolumeOrphaned VolumeState = "orphaned"
	VolumeError    VolumeState = "error"
	VolumeDeleted  VolumeState = "deleted"
)

// -----------------------------------------------------------------------------
// Control → agent
// -----------------------------------------------------------------------------

// VolumeDelete deletes a volume's data, 72 h after a soft delete; the only
// frame that removes data. Type must be [TypeVolumeDelete].
type VolumeDelete struct {
	Type string `json:"type"`
	ControlHeader
	VolumeID string `json:"volume_id"`
}

func (*VolumeDelete) controlMessage() {}

// Validate implements [Validator].
func (m *VolumeDelete) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if !idRE.MatchString(m.VolumeID) {
		return fmt.Errorf("volume_id: invalid %q", m.VolumeID)
	}
	return nil
}

// BackupSource names what a backup or restore reads or writes.
type BackupSource struct {
	Method BackupMethod `json:"method"`
	// Engine is required for dump.
	Engine DatabaseEngine `json:"engine,omitempty"`
	// WorkloadID is the container to dump from, or to stop around a
	// quiesced snapshot.
	WorkloadID string `json:"workload_id,omitempty"`
	VolumeID   string `json:"volume_id"`
}

func (s *BackupSource) validate() error {
	switch s.Method {
	case BackupDump:
		if !s.Engine.valid() || s.WorkloadID == "" {
			return errors.New("dump needs engine and workload_id")
		}
	case BackupSnapshot:
		if s.Engine != "" && !s.Engine.valid() {
			return fmt.Errorf("engine: invalid %q", s.Engine)
		}
	case BackupBase:
		if s.Engine != EnginePostgres || s.WorkloadID == "" {
			return errors.New("base backups are of Postgres and need workload_id")
		}
	default:
		return fmt.Errorf("method: invalid %q", s.Method)
	}
	if !idRE.MatchString(s.VolumeID) || (s.WorkloadID != "" && !idRE.MatchString(s.WorkloadID)) {
		return errors.New("volume_id and workload_id must be ids")
	}
	return nil
}

// BackupJob backs up a volume to a multipart object. Answered by
// [BackupProgress], [BackupPartsRequest] and [BackupResult]. Always
// credential-bearing. Type must be [TypeBackupJob].
type BackupJob struct {
	Type string `json:"type"`
	ControlHeader
	BackupID string `json:"backup_id"`
	BackupSource
	// Quiesce is "none" or "stop" (snapshot only).
	Quiesce string `json:"quiesce"`
	// Databases to dump; nil dumps all. Dump only.
	Databases *[]string `json:"databases"`
	// AgeRecipient is the project's age X25519 recipient.
	AgeRecipient string `json:"age_recipient"`
	// PartSizeBytes is the size of every part but the last.
	PartSizeBytes int64 `json:"part_size_bytes"`
	// PartsSealed opens with [OpenBackupParts].
	PartsSealed SealedBox `json:"parts_sealed"`
	TimeoutS    int       `json:"timeout_s"`
}

func (*BackupJob) controlMessage() {}

// Validate implements [Validator].
func (m *BackupJob) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if !idRE.MatchString(m.BackupID) {
		return fmt.Errorf("backup_id: invalid %q", m.BackupID)
	}
	if err := m.BackupSource.validate(); err != nil {
		return err
	}
	switch m.Quiesce {
	case "none":
	case "stop":
		if m.Method != BackupSnapshot || m.WorkloadID == "" {
			return errors.New("quiesce: stop is for snapshots and needs workload_id")
		}
	default:
		return fmt.Errorf("quiesce: invalid %q", m.Quiesce)
	}
	if m.Method != BackupSnapshot && m.Quiesce != "none" {
		return errors.New("quiesce: only snapshots are quiesced")
	}
	if m.Databases != nil {
		if m.Method != BackupDump {
			return errors.New("databases: snapshots back up the whole volume")
		}
		if len(*m.Databases) == 0 || len(*m.Databases) > MaxBackupDatabases {
			return fmt.Errorf("databases: must have 1 to %d", MaxBackupDatabases)
		}
		for _, d := range *m.Databases {
			if !dbNameRE.MatchString(d) {
				return fmt.Errorf("databases: invalid %q", d)
			}
		}
	}
	if err := validateUpload(m.AgeRecipient, m.PartSizeBytes, &m.PartsSealed, m.TimeoutS); err != nil {
		return err
	}
	return validateShortLived(m)
}

func validateUpload(recipient string, partSize int64, parts *SealedBox, timeoutS int) error {
	if !ageRecipientRE.MatchString(recipient) {
		return errors.New("age_recipient: expected an age recipient")
	}
	if partSize < MinBackupPartBytes || partSize > MaxBackupPartBytes || partSize%BackupPartAlignBytes != 0 {
		return errors.New("part_size_bytes: out of range or unaligned")
	}
	if err := parts.validate(); err != nil {
		return fmt.Errorf("parts_sealed: %w", err)
	}
	return validateBackupTimeout(timeoutS)
}

func validateBackupTimeout(timeoutS int) error {
	if timeoutS < 60 || timeoutS > MaxBackupTimeoutS {
		return errors.New("timeout_s: out of range")
	}
	return nil
}

// BackupParts carries more presigned part URLs. Always credential-bearing.
// Type must be [TypeBackupParts].
type BackupParts struct {
	Type string `json:"type"`
	ControlHeader
	BackupID string `json:"backup_id"`
	// PartsSealed opens with [OpenBackupParts].
	PartsSealed SealedBox `json:"parts_sealed"`
}

func (*BackupParts) controlMessage() {}

// Validate implements [Validator].
func (m *BackupParts) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if !idRE.MatchString(m.BackupID) {
		return fmt.Errorf("backup_id: invalid %q", m.BackupID)
	}
	if err := m.PartsSealed.validate(); err != nil {
		return fmt.Errorf("parts_sealed: %w", err)
	}
	return validateShortLived(m)
}

// RestoreTarget is the backup a restore or copy-in streams back.
type RestoreTarget struct {
	BackupID string `json:"backup_id"`
	// SHA256 is the hex digest of the stored (encrypted) object.
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"size_bytes"`
	// SecretsSealed opens with [OpenRestoreSecrets].
	SecretsSealed SealedBox `json:"secrets_sealed"`
	TimeoutS      int       `json:"timeout_s"`
}

func (t *RestoreTarget) validate() error {
	if !idRE.MatchString(t.BackupID) || !sha256HexRE.MatchString(t.SHA256) || t.SizeBytes < 1 {
		return errors.New("backup_id, sha256 or size_bytes: invalid")
	}
	if err := t.SecretsSealed.validate(); err != nil {
		return fmt.Errorf("secrets_sealed: %w", err)
	}
	return validateBackupTimeout(t.TimeoutS)
}

// RestoreJob restores a backup into a volume; answered by [RestoreResult].
// Always credential-bearing. Type must be [TypeRestoreJob].
type RestoreJob struct {
	Type string `json:"type"`
	ControlHeader
	RestoreID string `json:"restore_id"`
	BackupSource
	RestoreTarget
	// PITR is set exactly with [BackupBase]. From [PITRProtocolVersion].
	PITR *PITRRecovery `json:"pitr,omitempty"`
}

func (*RestoreJob) controlMessage() {}

// Validate implements [Validator].
func (m *RestoreJob) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if !idRE.MatchString(m.RestoreID) {
		return fmt.Errorf("restore_id: invalid %q", m.RestoreID)
	}
	if err := m.BackupSource.validate(); err != nil {
		return err
	}
	if err := m.RestoreTarget.validate(); err != nil {
		return err
	}
	if (m.Method == BackupBase) != (m.PITR != nil) {
		return errors.New("pitr: goes with base exactly")
	}
	if m.PITR != nil {
		if err := m.PITR.validate(); err != nil {
			return err
		}
	}
	return validateShortLived(m)
}

// VolumeCopyOut snapshots a volume for migration, answered like a backup
// for BackupID. Always credential-bearing. Type must be [TypeVolumeCopyOut].
type VolumeCopyOut struct {
	Type string `json:"type"`
	ControlHeader
	MigrationID string `json:"migration_id"`
	BackupID    string `json:"backup_id"`
	VolumeID    string `json:"volume_id"`
	// WorkloadID is the workload to stop for the copy, when one still runs.
	WorkloadID    string    `json:"workload_id,omitempty"`
	AgeRecipient  string    `json:"age_recipient"`
	PartSizeBytes int64     `json:"part_size_bytes"`
	PartsSealed   SealedBox `json:"parts_sealed"`
	TimeoutS      int       `json:"timeout_s"`
}

func (*VolumeCopyOut) controlMessage() {}

// Validate implements [Validator].
func (m *VolumeCopyOut) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if !idRE.MatchString(m.MigrationID) || !idRE.MatchString(m.BackupID) || !idRE.MatchString(m.VolumeID) ||
		(m.WorkloadID != "" && !idRE.MatchString(m.WorkloadID)) {
		return errors.New("migration_id, backup_id, volume_id and workload_id must be ids")
	}
	if err := validateUpload(m.AgeRecipient, m.PartSizeBytes, &m.PartsSealed, m.TimeoutS); err != nil {
		return err
	}
	return validateShortLived(m)
}

// VolumeCopyIn restores a copy-out snapshot into the target volume,
// answered by [RestoreResult] with RestoreID = MigrationID. Always
// credential-bearing. Type must be [TypeVolumeCopyIn].
type VolumeCopyIn struct {
	Type string `json:"type"`
	ControlHeader
	MigrationID string `json:"migration_id"`
	VolumeID    string `json:"volume_id"`
	RestoreTarget
}

func (*VolumeCopyIn) controlMessage() {}

// Validate implements [Validator].
func (m *VolumeCopyIn) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if !idRE.MatchString(m.MigrationID) || !idRE.MatchString(m.VolumeID) {
		return errors.New("migration_id and volume_id must be ids")
	}
	if err := m.RestoreTarget.validate(); err != nil {
		return err
	}
	return validateShortLived(m)
}

// DBOp types.
const (
	DBOpListNamespaces    = "list_namespaces"
	DBOpListTables        = "list_tables"
	DBOpDescribe          = "describe"
	DBOpRows              = "rows"
	DBOpRaw               = "raw"
	DBOpProvisionReadonly = "provision_readonly"
	// DBOpSetPassword sets User's password to the credential box's
	// NewPassword, connected as the admin. System use only.
	DBOpSetPassword = "set_password"
)

// DBOp is one data-browser operation, discriminated on Type. Fields other
// than those of its type are ignored, as the zod union strips them.
type DBOp struct {
	Type      string `json:"type"`
	Namespace string `json:"namespace,omitempty"`
	// Cursor is a Redis SCAN cursor (list_tables).
	Cursor string `json:"cursor,omitempty"`
	// Pattern is a Redis MATCH pattern (list_tables).
	Pattern string `json:"pattern,omitempty"`
	// Table is required for describe and rows.
	Table string `json:"table,omitempty"`
	// Offset is required for rows.
	Offset     *int   `json:"offset,omitempty"`
	OrderBy    string `json:"order_by,omitempty"`
	Descending *bool  `json:"descending,omitempty"`
	// Statement is SQL, or a MongoDB command document as JSON (raw).
	Statement string `json:"statement,omitempty"`
	// Params are positional SQL parameters as text; nil entries are NULL.
	Params []*string `json:"params,omitempty"`
	// Argv is a Redis command (raw).
	Argv []string `json:"argv,omitempty"`
	// User is the principal set_password changes.
	User string `json:"user,omitempty"`
}

func validDBIdentifier(s string, required bool) bool {
	if s == "" {
		return !required
	}
	return len(s) <= MaxDBIdentifierBytes && !strings.ContainsRune(s, 0)
}

func (o *DBOp) validate() error {
	switch o.Type {
	case DBOpListNamespaces, DBOpProvisionReadonly:
	case DBOpSetPassword:
		if !dbUserRE.MatchString(o.User) {
			return errors.New("op: set_password needs a user")
		}
	case DBOpListTables:
		if !validDBIdentifier(o.Namespace, false) || !validDBIdentifier(o.Pattern, false) ||
			(o.Cursor != "" && !scanCursorRE.MatchString(o.Cursor)) {
			return errors.New("op: invalid list_tables")
		}
	case DBOpDescribe:
		if !validDBIdentifier(o.Namespace, false) || !validDBIdentifier(o.Table, true) {
			return errors.New("op: describe needs a table")
		}
	case DBOpRows:
		if !validDBIdentifier(o.Namespace, false) || !validDBIdentifier(o.Table, true) ||
			!validDBIdentifier(o.OrderBy, false) || o.Offset == nil || *o.Offset < 0 || *o.Offset > 1_000_000_000 {
			return errors.New("op: rows needs a table and an offset")
		}
	case DBOpRaw:
		if (o.Statement != "") == (o.Argv != nil) {
			return errors.New("op: raw needs exactly one of statement and argv")
		}
		if o.Params != nil && o.Statement == "" {
			return errors.New("op: params only go with a statement")
		}
		if len(o.Statement) > MaxDBStatementBytes || len(o.Params) > MaxDBParams {
			return errors.New("op: statement or params too large")
		}
		for _, p := range o.Params {
			if p != nil && len(*p) > MaxDBStatementBytes {
				return errors.New("op: param too large")
			}
		}
		if o.Argv != nil && (len(o.Argv) == 0 || len(o.Argv) > MaxDBParams) {
			return fmt.Errorf("op: argv must have 1 to %d entries", MaxDBParams)
		}
		for _, a := range o.Argv {
			if len(a) > MaxDBStatementBytes {
				return errors.New("op: argv entry too large")
			}
		}
	default:
		return fmt.Errorf("op.type: invalid %q", o.Type)
	}
	return nil
}

// DBQuery runs one data-browser operation; answered by [DBQueryResult] with
// the same RequestID. Mode "read" connects as roundhouse_ro in a read-only
// transaction. Always credential-bearing. Type must be [TypeDBQuery].
type DBQuery struct {
	Type string `json:"type"`
	ControlHeader
	RequestID  string         `json:"request_id"`
	WorkloadID string         `json:"workload_id"`
	Engine     DatabaseEngine `json:"engine"`
	// CredentialSealed opens with [OpenDBCredential].
	CredentialSealed SealedBox `json:"credential_sealed"`
	// Mode is "read" or "write".
	Mode      string `json:"mode"`
	Op        DBOp   `json:"op"`
	MaxRows   int    `json:"max_rows"`
	MaxBytes  int    `json:"max_bytes"`
	TimeoutMS int    `json:"timeout_ms"`
}

func (*DBQuery) controlMessage() {}

// Validate implements [Validator].
func (m *DBQuery) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if !requestIDRE.MatchString(m.RequestID) || !idRE.MatchString(m.WorkloadID) || !m.Engine.valid() {
		return errors.New("request_id, workload_id or engine: invalid")
	}
	if err := m.CredentialSealed.validate(); err != nil {
		return fmt.Errorf("credential_sealed: %w", err)
	}
	if m.Mode != "read" && m.Mode != "write" {
		return fmt.Errorf("mode: invalid %q", m.Mode)
	}
	if err := m.Op.validate(); err != nil {
		return err
	}
	if (m.Op.Type == DBOpProvisionReadonly || m.Op.Type == DBOpSetPassword) && m.Mode != "write" {
		return fmt.Errorf("mode: %s runs as the admin", m.Op.Type)
	}
	if m.MaxRows < 1 || m.MaxRows > MaxDBQueryRows || m.MaxBytes < 1 || m.MaxBytes > MaxDBQueryResultBytes ||
		m.TimeoutMS < 100 || m.TimeoutMS > MaxDBQueryTimeoutMS {
		return errors.New("max_rows, max_bytes or timeout_ms: out of range")
	}
	return validateShortLived(m)
}

// -----------------------------------------------------------------------------
// Agent → control
// -----------------------------------------------------------------------------

// VolumeStatusReport is one volume as the node holds it.
type VolumeStatusReport struct {
	VolumeID  string          `json:"volume_id"`
	State     VolumeState     `json:"state"`
	SizeBytes int64           `json:"size_bytes"`
	UsedBytes int64           `json:"used_bytes"`
	Quota     VolumeQuotaMode `json:"quota"`
	Message   string          `json:"message,omitempty"`
}

// VolumeStatus reports every volume the node holds, every 60 s and on
// change. Type must be [TypeVolumeStatus].
type VolumeStatus struct {
	Type    string               `json:"type"`
	Volumes []VolumeStatusReport `json:"volumes"`
}

func (*VolumeStatus) agentMessage() {}

// Validate implements [Validator].
func (m *VolumeStatus) Validate() error {
	if len(m.Volumes) > MaxVolumesPerNode {
		return fmt.Errorf("volumes: at most %d", MaxVolumesPerNode)
	}
	seen := map[string]bool{}
	for _, v := range m.Volumes {
		switch v.State {
		case VolumeCreating, VolumeReady, VolumeResizing, VolumeOrphaned, VolumeError, VolumeDeleted:
		default:
			return fmt.Errorf("volumes: invalid state %q", v.State)
		}
		if !idRE.MatchString(v.VolumeID) || seen[v.VolumeID] || v.SizeBytes < 0 || v.UsedBytes < 0 ||
			!v.Quota.valid() || len(v.Message) > MaxMessageBytes {
			return fmt.Errorf("volumes: invalid or duplicate %q", v.VolumeID)
		}
		seen[v.VolumeID] = true
	}
	return nil
}

// BackupPartsRequest asks for the next presigned part URLs. Type must be
// [TypeBackupPartsRequest].
type BackupPartsRequest struct {
	Type     string `json:"type"`
	BackupID string `json:"backup_id"`
	FromPart int    `json:"from_part"`
	Count    int    `json:"count"`
}

func (*BackupPartsRequest) agentMessage() {}

// Validate implements [Validator].
func (m *BackupPartsRequest) Validate() error {
	if !idRE.MatchString(m.BackupID) || m.FromPart < 1 || m.FromPart > MaxBackupParts || m.Count < 1 ||
		m.Count > MaxBackupPartsPerFrame {
		return errors.New("backup_parts_request: invalid")
	}
	return nil
}

// UploadedPart is one uploaded part, for CompleteMultipartUpload.
type UploadedPart struct {
	PartNumber int    `json:"part_number"`
	ETag       string `json:"etag"`
	Size       int64  `json:"size"`
}

// BackupProgress reports uploaded parts as they complete. Type must be
// [TypeBackupProgress].
type BackupProgress struct {
	Type     string         `json:"type"`
	BackupID string         `json:"backup_id"`
	Parts    []UploadedPart `json:"parts"`
	// BytesRaw is source bytes read so far.
	BytesRaw int64 `json:"bytes_raw"`
}

func (*BackupProgress) agentMessage() {}

// Validate implements [Validator].
func (m *BackupProgress) Validate() error {
	if !idRE.MatchString(m.BackupID) || len(m.Parts) == 0 || len(m.Parts) > MaxBackupProgressParts || m.BytesRaw < 0 {
		return errors.New("backup_progress: invalid")
	}
	for _, p := range m.Parts {
		if p.PartNumber < 1 || p.PartNumber > MaxBackupParts || !etagRE.MatchString(p.ETag) || p.Size < 1 {
			return fmt.Errorf("backup_progress: invalid part %d", p.PartNumber)
		}
	}
	return nil
}

// BackupResult is the outcome of a [BackupJob] or [VolumeCopyOut]: stats
// when OK, an error otherwise. Type must be [TypeBackupResult].
type BackupResult struct {
	Type        string `json:"type"`
	BackupID    string `json:"backup_id"`
	OK          bool   `json:"ok"`
	PartCount   *int   `json:"part_count,omitempty"`
	BytesRaw    *int64 `json:"bytes_raw,omitempty"`
	BytesStored *int64 `json:"bytes_stored,omitempty"`
	// SHA256 is the hex digest of the stored (encrypted) bytes.
	SHA256 string `json:"sha256,omitempty"`
	// WALStart is a successful base backup's first WAL segment (START WAL
	// LOCATION of its backup_label). From [PITRProtocolVersion].
	WALStart   string `json:"wal_start,omitempty"`
	Error      string `json:"error,omitempty"`
	DurationMS int64  `json:"duration_ms"`
}

func (*BackupResult) agentMessage() {}

// Validate implements [Validator].
func (m *BackupResult) Validate() error {
	if !idRE.MatchString(m.BackupID) || m.DurationMS < 0 || len(m.Error) > MaxMessageBytes {
		return errors.New("backup_result: invalid")
	}
	stats := m.PartCount != nil && m.BytesRaw != nil && m.BytesStored != nil && m.SHA256 != ""
	none := m.PartCount == nil && m.BytesRaw == nil && m.BytesStored == nil && m.SHA256 == ""
	if (m.OK && (!stats || m.Error != "")) || (!m.OK && (!none || m.Error == "")) {
		return errors.New("backup_result: a successful result has its stats and no error; a failed one, only an error")
	}
	if stats && (*m.PartCount < 1 || *m.PartCount > MaxBackupParts || *m.BytesRaw < 0 || *m.BytesStored < 0 ||
		!sha256HexRE.MatchString(m.SHA256)) {
		return errors.New("backup_result: invalid stats")
	}
	if m.WALStart != "" && (!m.OK || !walSegmentRE.MatchString(m.WALStart)) {
		return errors.New("backup_result: wal_start is a successful result's WAL segment")
	}
	return nil
}

// RestoreResult is the outcome of a [RestoreJob] or [VolumeCopyIn] (then
// RestoreID is the migration ID). Type must be [TypeRestoreResult].
type RestoreResult struct {
	Type      string `json:"type"`
	RestoreID string `json:"restore_id"`
	OK        bool   `json:"ok"`
	Error     string `json:"error,omitempty"`
	// Bytes restored.
	Bytes      *int64 `json:"bytes,omitempty"`
	DurationMS int64  `json:"duration_ms"`
}

func (*RestoreResult) agentMessage() {}

// Validate implements [Validator].
func (m *RestoreResult) Validate() error {
	if !idRE.MatchString(m.RestoreID) || m.DurationMS < 0 || len(m.Error) > MaxMessageBytes ||
		(m.Bytes != nil && *m.Bytes < 0) {
		return errors.New("restore_result: invalid")
	}
	if m.OK != (m.Error == "") {
		return errors.New("restore_result: exactly the failed results carry an error")
	}
	return nil
}

// DBColumn is a result column.
type DBColumn struct {
	Name string `json:"name"`
	// Type is the engine's type name.
	Type string `json:"type"`
}

// DBQueryResult answers [DBQuery]. Cells are JSON values (binary as
// {"$b64": …}, 64-bit integers as strings). Columns and Rows are pointers
// so a successful result with none still encodes them as []. Type must be
// [TypeDBQueryResult].
type DBQueryResult struct {
	Type      string      `json:"type"`
	RequestID string      `json:"request_id"`
	OK        bool        `json:"ok"`
	Columns   *[]DBColumn `json:"columns,omitempty"`
	Rows      *[][]any    `json:"rows,omitempty"`
	// RowCount is rows returned, or affected by a write.
	RowCount   *int64 `json:"row_count,omitempty"`
	Truncated  *bool  `json:"truncated,omitempty"`
	Notice     string `json:"notice,omitempty"`
	Error      string `json:"error,omitempty"`
	DurationMS int64  `json:"duration_ms"`
}

func (*DBQueryResult) agentMessage() {}

// Validate implements [Validator].
func (m *DBQueryResult) Validate() error {
	if !requestIDRE.MatchString(m.RequestID) || m.DurationMS < 0 || len(m.Notice) > MaxMessageBytes ||
		len(m.Error) > MaxMessageBytes || (m.RowCount != nil && *m.RowCount < 0) {
		return errors.New("db_query_result: invalid")
	}
	if m.OK {
		if m.Columns == nil || m.Rows == nil || m.RowCount == nil || m.Error != "" {
			return errors.New("db_query_result: a successful result has columns, rows and row_count")
		}
	} else if m.Error == "" || m.Columns != nil || m.Rows != nil {
		return errors.New("db_query_result: a failed result has an error and no rows")
	}
	if m.Columns != nil {
		if len(*m.Columns) > MaxDBColumns {
			return fmt.Errorf("db_query_result: at most %d columns", MaxDBColumns)
		}
		for _, c := range *m.Columns {
			if len(c.Name) > MaxDBIdentifierBytes || len(c.Type) > 128 {
				return errors.New("db_query_result: invalid column")
			}
		}
	}
	if m.Rows != nil {
		if len(*m.Rows) > MaxDBQueryRows {
			return fmt.Errorf("db_query_result: at most %d rows", MaxDBQueryRows)
		}
		for _, r := range *m.Rows {
			if len(r) > MaxDBColumns {
				return errors.New("db_query_result: row too wide")
			}
		}
		if n, err := encodedLen(*m.Rows); err != nil || n > MaxDBQueryResultBytes {
			return fmt.Errorf("db_query_result: at most %d bytes of rows", MaxDBQueryResultBytes)
		}
	}
	return nil
}

// encodedLen is the length of v as JSON.stringify writes it: no HTML
// escaping, no trailing newline.
func encodedLen(v any) (int, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return 0, err
	}
	return buf.Len() - 1, nil
}
