package protocol

import (
	"crypto/ecdh"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Point-in-time recovery for Postgres (ADR 0004), mirroring pitr.ts: WAL
// archiving through the volume's spool, and the WAL a base restore replays.

// PITRProtocolVersion gates base backups, [VolumeSpec].WALArchive,
// [WALArchive], [WALArchiveAck], [RestoreJob].PITR, [WALFetchRequest] and
// [WALFetch]. Mirrors PITR_PROTOCOL_VERSION.
const PITRProtocolVersion = 8

// WALSpoolDir is the directory, relative to the volume's mount path, that
// archive_command copies finished WAL files into and the agent ships from.
const WALSpoolDir = "roundhouse-wal"

// WALArchiveTimeoutS is the database's archive_timeout.
const WALArchiveTimeoutS = 60

// PITR limits, mirroring limits.ts.
const (
	// MaxWALArchivedPerFrame is the most files one [WALArchive] reports.
	MaxWALArchivedPerFrame = 64
	// MaxWALUploadsPerFrame is the most files one [WALArchive] asks URLs
	// for, and one [WALArchiveAck] carries.
	MaxWALUploadsPerFrame = 32
	// MaxWALFetchPerFrame is the most files one [WALFetch] carries.
	MaxWALFetchPerFrame = 32
	// MaxPITRWALFiles is the most WAL files one restore replays.
	MaxPITRWALFiles = 100_000
	// MaxWALFileBytes is the largest raw WAL file (wal_segment_size's maximum).
	MaxWALFileBytes = 1 << 30
)

// PITR frame types.
const (
	TypeWALArchive      = "wal_archive"
	TypeWALArchiveAck   = "wal_archive_ack"
	TypeWALFetchRequest = "wal_fetch_request"
	TypeWALFetch        = "wal_fetch"
)

var (
	walFileRE    = regexp.MustCompile(`^(?:[0-9A-F]{24}(?:\.[0-9A-F]{8}\.backup|\.partial)?|[0-9A-F]{8}\.history)$`)
	walSegmentRE = regexp.MustCompile(`^[0-9A-F]{24}$`)
)

// ValidWALFileName reports whether name is a file archive_command archives:
// a segment, a .partial segment, a .backup or a .history file. Never a path.
func ValidWALFileName(name string) bool { return walFileRE.MatchString(name) }

// ValidWALSegmentName reports whether name is a full segment's name.
func ValidWALSegmentName(name string) bool { return walSegmentRE.MatchString(name) }

// WALTimeline returns a WAL file's timeline, its first eight hex digits.
func WALTimeline(name string) string {
	if len(name) < 8 {
		return ""
	}
	return name[:8]
}

// NextWALSegment returns the segment after name on its timeline, at the
// default 16 MiB wal_segment_size.
func NextWALSegment(name string) (string, error) {
	if !walSegmentRE.MatchString(name) {
		return "", fmt.Errorf("not a WAL segment: %q", name)
	}
	log, _ := strconv.ParseUint(name[8:16], 16, 32)
	seg, _ := strconv.ParseUint(name[16:24], 16, 32)
	seg++
	if seg >= 0x100 {
		seg = 0
		log++
	}
	return fmt.Sprintf("%s%08X%08X", name[:8], log, seg), nil
}

// PITRRecovery is how a base restore recovers.
type PITRRecovery struct {
	// TargetTime is unix ms to stop at; nil stops once the base backup is
	// consistent.
	TargetTime *int64 `json:"target_time"`
	// WALFiles is how many files to fetch, indexed from 0.
	WALFiles int `json:"wal_files"`
	// WALEnd is the last segment fetched; replay must reach it when
	// recovery ends without meeting TargetTime.
	WALEnd *string `json:"wal_end"`
}

func (p *PITRRecovery) validate() error {
	if p.TargetTime != nil && *p.TargetTime <= 0 {
		return errors.New("pitr.target_time: must be positive")
	}
	if p.WALFiles < 0 || p.WALFiles > MaxPITRWALFiles {
		return errors.New("pitr.wal_files: out of range")
	}
	if (p.WALFiles == 0) != (p.WALEnd == nil) {
		return errors.New("pitr.wal_end: set exactly when WAL is fetched")
	}
	if p.WALEnd != nil && !walSegmentRE.MatchString(*p.WALEnd) {
		return errors.New("pitr.wal_end: expected a WAL segment name")
	}
	if p.TargetTime != nil && p.WALEnd == nil {
		return errors.New("pitr.target_time: needs WAL to replay")
	}
	return nil
}

// WALArchiveSpec is [VolumeSpec].WALArchive.
type WALArchiveSpec struct {
	// StreamID names the stream the files belong to.
	StreamID string `json:"stream_id"`
	// AgeRecipient is the project's age recipient the files are encrypted to.
	AgeRecipient string `json:"age_recipient"`
}

// -----------------------------------------------------------------------------
// Agent → control
// -----------------------------------------------------------------------------

// ArchivedWALFile is a WAL file the agent uploaded.
type ArchivedWALFile struct {
	Name       string `json:"name"`
	SizeRaw    int64  `json:"size_raw"`
	SizeStored int64  `json:"size_stored"`
	// SHA256 is the hex digest of the stored bytes.
	SHA256 string `json:"sha256"`
	// ArchivedAt is unix ms when Postgres finished the file.
	ArchivedAt int64 `json:"archived_at"`
}

// WALArchive reports uploaded WAL files and asks for upload URLs. Type must
// be [TypeWALArchive].
type WALArchive struct {
	Type     string            `json:"type"`
	VolumeID string            `json:"volume_id"`
	StreamID string            `json:"stream_id"`
	Archived []ArchivedWALFile `json:"archived"`
	// Pending are spooled files waiting for an upload URL, oldest first.
	Pending []string `json:"pending"`
}

func (*WALArchive) agentMessage() {}

// Validate implements [Validator].
func (m *WALArchive) Validate() error {
	if !idRE.MatchString(m.VolumeID) || !idRE.MatchString(m.StreamID) {
		return errors.New("volume_id and stream_id must be ids")
	}
	if m.Archived == nil || m.Pending == nil {
		return errors.New("archived and pending are required")
	}
	if len(m.Archived) > MaxWALArchivedPerFrame || len(m.Pending) > MaxWALUploadsPerFrame {
		return errors.New("archived or pending: too many files")
	}
	seen := map[string]bool{}
	for _, f := range m.Archived {
		if !walFileRE.MatchString(f.Name) || seen[f.Name] {
			return fmt.Errorf("archived: invalid or duplicate %q", f.Name)
		}
		seen[f.Name] = true
		if f.SizeRaw < 1 || f.SizeRaw > MaxWALFileBytes || f.SizeStored < 1 || !sha256HexRE.MatchString(f.SHA256) ||
			f.ArchivedAt < 1 {
			return fmt.Errorf("archived: invalid %q", f.Name)
		}
	}
	for _, n := range m.Pending {
		if !walFileRE.MatchString(n) || seen[n] {
			return fmt.Errorf("pending: invalid or duplicate %q", n)
		}
		seen[n] = true
	}
	return nil
}

// WALFetchRequest asks for a base restore's WAL download URLs. Type must be
// [TypeWALFetchRequest].
type WALFetchRequest struct {
	Type      string `json:"type"`
	RestoreID string `json:"restore_id"`
	From      int    `json:"from"`
	Count     int    `json:"count"`
}

func (*WALFetchRequest) agentMessage() {}

// Validate implements [Validator].
func (m *WALFetchRequest) Validate() error {
	if !idRE.MatchString(m.RestoreID) {
		return errors.New("restore_id: invalid")
	}
	if m.From < 0 || m.From >= MaxPITRWALFiles || m.Count < 1 || m.Count > MaxWALFetchPerFrame {
		return errors.New("from or count: out of range")
	}
	return nil
}

// -----------------------------------------------------------------------------
// Control → agent
// -----------------------------------------------------------------------------

// WALArchiveAck answers a [WALArchive]: the files recorded, which the agent
// removes from its spool, and upload URLs for pending ones. Always
// credential-bearing. Type must be [TypeWALArchiveAck].
type WALArchiveAck struct {
	Type string `json:"type"`
	ControlHeader
	VolumeID string   `json:"volume_id"`
	StreamID string   `json:"stream_id"`
	Acked    []string `json:"acked"`
	// UploadsSealed opens with [OpenWALUploads]; nil when nothing is pending.
	UploadsSealed *SealedBox `json:"uploads_sealed,omitempty"`
}

func (*WALArchiveAck) controlMessage() {}

// Validate implements [Validator].
func (m *WALArchiveAck) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if !idRE.MatchString(m.VolumeID) || !idRE.MatchString(m.StreamID) {
		return errors.New("volume_id and stream_id must be ids")
	}
	if m.Acked == nil || len(m.Acked) > MaxWALArchivedPerFrame {
		return errors.New("acked: required, at most 64")
	}
	for _, n := range m.Acked {
		if !walFileRE.MatchString(n) {
			return fmt.Errorf("acked: invalid %q", n)
		}
	}
	if m.UploadsSealed != nil {
		if err := m.UploadsSealed.validate(); err != nil {
			return fmt.Errorf("uploads_sealed: %w", err)
		}
	}
	return validateShortLived(m)
}

// WALFetch answers a [WALFetchRequest]. Always credential-bearing. Type
// must be [TypeWALFetch].
type WALFetch struct {
	Type string `json:"type"`
	ControlHeader
	RestoreID string `json:"restore_id"`
	// FilesSealed opens with [OpenWALFiles].
	FilesSealed SealedBox `json:"files_sealed"`
}

func (*WALFetch) controlMessage() {}

// Validate implements [Validator].
func (m *WALFetch) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if !idRE.MatchString(m.RestoreID) {
		return errors.New("restore_id: invalid")
	}
	if err := m.FilesSealed.validate(); err != nil {
		return fmt.Errorf("files_sealed: %w", err)
	}
	return validateShortLived(m)
}

// -----------------------------------------------------------------------------
// Sealed payloads
// -----------------------------------------------------------------------------

// WALUploadAAD binds a stream's upload URLs to its node and stream.
func WALUploadAAD(nodeID, streamID string) string {
	return BoxInfo(BoxPurposeWALUpload) + ":" + nodeID + ":" + streamID
}

// WALFetchAAD binds a restore's WAL download URLs to its node and restore.
func WALFetchAAD(nodeID, restoreID string) string {
	return BoxInfo(BoxPurposeWALFetch) + ":" + nodeID + ":" + restoreID
}

// WALUpload is one presigned PUT of a WAL file.
type WALUpload struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

// SealedWALUploads is the plaintext of [WALArchiveAck].UploadsSealed.
type SealedWALUploads struct {
	Uploads []WALUpload `json:"uploads"`
}

// WALFetchFile is one archived WAL file a restore fetches.
type WALFetchFile struct {
	Index int    `json:"index"`
	Name  string `json:"name"`
	// URL is a presigned GET of the stored file.
	URL string `json:"url"`
	// SHA256 is the hex digest of the stored bytes.
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// SealedWALFiles is the plaintext of [WALFetch].FilesSealed.
type SealedWALFiles struct {
	Files []WALFetchFile `json:"files"`
}

// OpenWALUploads opens an ack's upload URLs, sealed for streamID.
func OpenWALUploads(priv *ecdh.PrivateKey, nodeID string, m *WALArchiveAck) ([]WALUpload, error) {
	if m.UploadsSealed == nil {
		return nil, nil
	}
	var s SealedWALUploads
	if err := openStrict(priv, m.UploadsSealed, BoxPurposeWALUpload, WALUploadAAD(nodeID, m.StreamID), &s); err != nil {
		return nil, fmt.Errorf("wal stream %s uploads: %w", m.StreamID, err)
	}
	if len(s.Uploads) == 0 || len(s.Uploads) > MaxWALUploadsPerFrame {
		return nil, fmt.Errorf("wal stream %s uploads: must have 1 to %d", m.StreamID, MaxWALUploadsPerFrame)
	}
	seen := map[string]bool{}
	for _, u := range s.Uploads {
		if !walFileRE.MatchString(u.Name) || seen[u.Name] || !validPresignedURL(u.URL) {
			return nil, fmt.Errorf("wal stream %s uploads: invalid entry %q", m.StreamID, u.Name)
		}
		seen[u.Name] = true
	}
	return s.Uploads, nil
}

// OpenWALFiles opens a restore's WAL download URLs.
func OpenWALFiles(priv *ecdh.PrivateKey, nodeID string, m *WALFetch) ([]WALFetchFile, error) {
	var s SealedWALFiles
	if err := openStrict(priv, &m.FilesSealed, BoxPurposeWALFetch, WALFetchAAD(nodeID, m.RestoreID), &s); err != nil {
		return nil, fmt.Errorf("restore %s wal: %w", m.RestoreID, err)
	}
	if len(s.Files) == 0 || len(s.Files) > MaxWALFetchPerFrame {
		return nil, fmt.Errorf("restore %s wal: must have 1 to %d files", m.RestoreID, MaxWALFetchPerFrame)
	}
	for i, f := range s.Files {
		if f.Index < 0 || f.Index >= MaxPITRWALFiles || (i > 0 && f.Index != s.Files[i-1].Index+1) {
			return nil, fmt.Errorf("restore %s wal: indexes must be consecutive and ascending", m.RestoreID)
		}
		if !walFileRE.MatchString(f.Name) || !validPresignedURL(f.URL) || !sha256HexRE.MatchString(f.SHA256) ||
			f.Size < 1 || strings.ContainsAny(f.Name, "/\\") {
			return nil, fmt.Errorf("restore %s wal: invalid file %d", m.RestoreID, f.Index)
		}
	}
	return s.Files, nil
}

// PostgresArchiveArgs returns the postgres arguments that turn on WAL
// archiving into the volume's spool, exactly as postgresArchiveArgs in
// pitr.ts builds them; the agent's tests run Postgres with them.
func PostgresArchiveArgs(mountPath string) []string {
	d := strings.TrimRight(mountPath, "/") + "/" + WALSpoolDir
	command := `[ -f "` + d + `/%f" ] || [ -f "` + d + `/%f.done" ] || ` +
		`{ cp "%p" "` + d + `/.%f.tmp" && sync "` + d + `/.%f.tmp" && mv "` + d + `/.%f.tmp" "` + d + `/%f" && sync "` + d + `"; }`
	return []string{
		"-c", "archive_mode=on",
		"-c", "archive_command=" + command,
		"-c", "archive_timeout=" + strconv.Itoa(WALArchiveTimeoutS),
	}
}
