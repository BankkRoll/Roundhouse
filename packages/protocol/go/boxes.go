package protocol

import (
	"bytes"
	"crypto/ecdh"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// AADs and plaintexts of the Phase 2–3 sealed boxes (ADR 0015), mirroring
// box.ts. Each Open* helper opens one box, decodes it strictly and checks
// it the way the zod plaintext schema does.

// JobEnvAAD returns the AAD of a job run's sealed environment.
func JobEnvAAD(nodeID, runID, workloadID string) string {
	return BoxInfo(BoxPurposeJobEnv) + ":" + nodeID + ":" + runID + ":" + workloadID
}

// MeshPSKsAAD returns the AAD of desired_state.mesh.psks_sealed.
func MeshPSKsAAD(nodeID string, generation int64) string {
	return BoxInfo(BoxPurposeMeshPSKs) + ":" + nodeID + ":" + strconv.FormatInt(generation, 10)
}

// RegistryUpstreamAAD returns the AAD of a proxy registry's sealed upstream password.
func RegistryUpstreamAAD(nodeID string, generation int64) string {
	return BoxInfo(BoxPurposeRegistryUpstream) + ":" + nodeID + ":" + strconv.FormatInt(generation, 10)
}

// BackupPartsAAD returns the AAD of presigned part URLs for backupID.
func BackupPartsAAD(nodeID, backupID string) string {
	return BoxInfo(BoxPurposeBackupParts) + ":" + nodeID + ":" + backupID
}

// RestoreSecretsAAD returns the AAD of a restore's (or copy-in's) download
// URL and age identity; restoreID is the restore or migration ID.
func RestoreSecretsAAD(nodeID, restoreID string) string {
	return BoxInfo(BoxPurposeRestore) + ":" + nodeID + ":" + restoreID
}

// DBCredentialAAD returns the AAD of a db_query's sealed credential.
func DBCredentialAAD(nodeID, requestID string) string {
	return BoxInfo(BoxPurposeDBCredential) + ":" + nodeID + ":" + requestID
}

// CertKeyAAD returns the AAD of a certificate's sealed private key. Binding
// sha256, the hex digest of the chain, stops a key being paired with
// another chain.
func CertKeyAAD(nodeID, certID, sha256 string) string {
	return BoxInfo(BoxPurposeCertKey) + ":" + nodeID + ":" + certID + ":" + sha256
}

// SealedMeshPSKs is the plaintext of [MeshConfig].PSKsSealed.
type SealedMeshPSKs struct {
	// PSKs maps each peer's node ID to its standard-base64 32-byte key.
	PSKs map[string]string `json:"psks"`
}

// SealedRegistryUpstream is the plaintext of [RegistryUpstream].PasswordSealed.
type SealedRegistryUpstream struct {
	Password string `json:"password"`
}

// BackupPartURL is one presigned UploadPart URL.
type BackupPartURL struct {
	PartNumber int    `json:"part_number"`
	URL        string `json:"url"`
}

// SealedBackupParts is the plaintext of parts_sealed: consecutive part URLs.
type SealedBackupParts struct {
	Parts []BackupPartURL `json:"parts"`
}

// SealedRestoreSecrets is the plaintext of secrets_sealed.
type SealedRestoreSecrets struct {
	// DownloadURL is a presigned GET of the encrypted object.
	DownloadURL string `json:"download_url"`
	// AgeIdentity decrypts it.
	AgeIdentity string `json:"age_identity"`
}

// SealedDBCredential is the plaintext of [DBQuery].CredentialSealed.
type SealedDBCredential struct {
	Username string `json:"username"`
	Password string `json:"password"`
	// NewPassword is set only for a set_password op: the password it sets.
	NewPassword string `json:"new_password,omitempty"`
}

// SealedCertKey is the plaintext of [CertUpsert].KeySealed.
type SealedCertKey struct {
	KeyPEM string `json:"key_pem"`
}

func openStrict(priv *ecdh.PrivateKey, box *SealedBox, purpose BoxPurpose, aad string, into any) error {
	pt, err := OpenBox(priv, box, purpose, aad)
	if err != nil {
		return err
	}
	return decodeStrict(pt, into, true)
}

// OpenJobEnv opens a job_run workload's environment and fills w.Env and
// w.SecretFiles.
func OpenJobEnv(priv *ecdh.PrivateKey, nodeID, runID string, w *WorkloadSpec) error {
	var env SealedWorkloadEnv
	if err := openStrict(priv, w.EnvSealed, BoxPurposeJobEnv, JobEnvAAD(nodeID, runID, w.ID), &env); err != nil {
		return fmt.Errorf("job %s: %w", runID, err)
	}
	if err := env.validate(); err != nil {
		return fmt.Errorf("job %s: %w", runID, err)
	}
	w.Env, w.SecretFiles = env.Env, env.Files
	return nil
}

// OpenMeshPSKs opens a desired state's preshared keys, decoded to raw bytes
// by peer node ID.
func OpenMeshPSKs(priv *ecdh.PrivateKey, nodeID string, generation int64, m *MeshConfig) (map[string][]byte, error) {
	var s SealedMeshPSKs
	if err := openStrict(priv, m.PSKsSealed, BoxPurposeMeshPSKs, MeshPSKsAAD(nodeID, generation), &s); err != nil {
		return nil, fmt.Errorf("mesh psks: %w", err)
	}
	if len(s.PSKs) > MaxMeshPeers {
		return nil, fmt.Errorf("mesh psks: at most %d", MaxMeshPeers)
	}
	out := make(map[string][]byte, len(s.PSKs))
	for node, b64 := range s.PSKs {
		raw, err := base64.StdEncoding.DecodeString(b64)
		if !nodeIDRE.MatchString(node) || err != nil || len(raw) != 32 || !base64Key32RE.MatchString(b64) {
			return nil, fmt.Errorf("mesh psks: invalid key for %q", node)
		}
		out[node] = raw
	}
	return out, nil
}

// OpenRegistryUpstream opens a proxy registry's upstream password.
func OpenRegistryUpstream(priv *ecdh.PrivateKey, nodeID string, generation int64, u *RegistryUpstream) (string, error) {
	var s SealedRegistryUpstream
	if err := openStrict(priv, &u.PasswordSealed, BoxPurposeRegistryUpstream, RegistryUpstreamAAD(nodeID, generation), &s); err != nil {
		return "", fmt.Errorf("registry upstream: %w", err)
	}
	if s.Password == "" || len(s.Password) > 4096 {
		return "", errors.New("registry upstream: invalid password")
	}
	return s.Password, nil
}

// OpenBackupParts opens presigned part URLs sealed for backupID.
func OpenBackupParts(priv *ecdh.PrivateKey, nodeID, backupID string, box *SealedBox) ([]BackupPartURL, error) {
	var s SealedBackupParts
	if err := openStrict(priv, box, BoxPurposeBackupParts, BackupPartsAAD(nodeID, backupID), &s); err != nil {
		return nil, fmt.Errorf("backup %s parts: %w", backupID, err)
	}
	if len(s.Parts) == 0 || len(s.Parts) > MaxBackupPartsPerFrame {
		return nil, fmt.Errorf("backup %s parts: must have 1 to %d", backupID, MaxBackupPartsPerFrame)
	}
	for i, p := range s.Parts {
		if p.PartNumber < 1 || p.PartNumber > MaxBackupParts || (i > 0 && p.PartNumber != s.Parts[i-1].PartNumber+1) {
			return nil, fmt.Errorf("backup %s parts: part numbers must be consecutive and ascending", backupID)
		}
		if !validPresignedURL(p.URL) {
			return nil, fmt.Errorf("backup %s parts: invalid url for part %d", backupID, p.PartNumber)
		}
	}
	return s.Parts, nil
}

// OpenRestoreSecrets opens a restore's (or copy-in's) download URL and age
// identity; restoreID is the restore or migration ID.
func OpenRestoreSecrets(priv *ecdh.PrivateKey, nodeID, restoreID string, box *SealedBox) (SealedRestoreSecrets, error) {
	var s SealedRestoreSecrets
	if err := openStrict(priv, box, BoxPurposeRestore, RestoreSecretsAAD(nodeID, restoreID), &s); err != nil {
		return SealedRestoreSecrets{}, fmt.Errorf("restore %s: %w", restoreID, err)
	}
	if !validPresignedURL(s.DownloadURL) || !ageIdentityRE.MatchString(s.AgeIdentity) {
		return SealedRestoreSecrets{}, fmt.Errorf("restore %s: invalid secrets", restoreID)
	}
	return s, nil
}

// OpenDBCredential opens a db_query's credential.
func OpenDBCredential(priv *ecdh.PrivateKey, nodeID string, q *DBQuery) (SealedDBCredential, error) {
	var s SealedDBCredential
	if err := openStrict(priv, &q.CredentialSealed, BoxPurposeDBCredential, DBCredentialAAD(nodeID, q.RequestID), &s); err != nil {
		return SealedDBCredential{}, fmt.Errorf("db query %s: %w", q.RequestID, err)
	}
	if s.Username == "" || len(s.Username) > 256 || s.Password == "" || len(s.Password) > 4096 {
		return SealedDBCredential{}, fmt.Errorf("db query %s: invalid credential", q.RequestID)
	}
	if s.NewPassword != "" && !dbPasswordRE.MatchString(s.NewPassword) {
		return SealedDBCredential{}, fmt.Errorf("db query %s: invalid new password", q.RequestID)
	}
	if (s.NewPassword != "") != (q.Op.Type == DBOpSetPassword) {
		return SealedDBCredential{}, fmt.Errorf("db query %s: a new password goes with set_password exactly", q.RequestID)
	}
	return s, nil
}

// OpenCertKey opens a certificate's private key PEM.
func OpenCertKey(priv *ecdh.PrivateKey, nodeID string, u *CertUpsert) (string, error) {
	var s SealedCertKey
	if err := openStrict(priv, &u.KeySealed, BoxPurposeCertKey, CertKeyAAD(nodeID, u.ID, u.SHA256), &s); err != nil {
		return "", fmt.Errorf("certificate %s: %w", u.ID, err)
	}
	if s.KeyPEM == "" || len(s.KeyPEM) > MaxCertKeyPEMBytes || !strings.HasPrefix(s.KeyPEM, "-----BEGIN ") ||
		bytes.IndexByte([]byte(s.KeyPEM), 0) >= 0 {
		return "", fmt.Errorf("certificate %s: invalid key", u.ID)
	}
	return s.KeyPEM, nil
}

func validPresignedURL(u string) bool {
	return len(u) <= MaxPresignedURLBytes && presignedURLRE.MatchString(u)
}
