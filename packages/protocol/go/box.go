package protocol

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
)

// BoxVersion is the sealed box format version. See box.ts for the scheme;
// both sides open fixtures/sealed-box.json.
const BoxVersion = 1

// BoxPurpose says what a box is for. It is part of the key derivation, so a
// box opens for one purpose only.
type BoxPurpose string

// Box purposes, mirroring BOX_PURPOSES in TypeScript.
const (
	BoxPurposeWorkloadEnv  BoxPurpose = "workload-env"
	BoxPurposeBuildSecrets BoxPurpose = "build-secrets"
)

// ErrBoxWrongKey means a box was sealed to another encryption key than the
// one the node holds, typically after the node's key was replaced. The
// agent reports it instead of a generic decryption failure.
var ErrBoxWrongKey = errors.New("sealed box is for another encryption key")

// SealedBox is a payload encrypted to one node's X25519 key.
type SealedBox struct {
	// V is always [BoxVersion].
	V int `json:"v"`
	// KID is [NodeEncryptionKeyID] of the recipient key.
	KID string `json:"kid"`
	// EPK is the ephemeral X25519 public key, standard base64 of 32 bytes.
	EPK string `json:"epk"`
	// CT is the AES-256-GCM ciphertext with the tag appended, standard base64.
	CT string `json:"ct"`
}

// NodeEncryptionKey is a node's X25519 public key signed by its Ed25519
// identity key, sent in [Hello] by nodes that joined without one.
type NodeEncryptionKey struct {
	// PublicKey is standard base64 of the raw 32-byte X25519 public key.
	PublicKey string `json:"public_key"`
	// KID is [NodeEncryptionKeyID] of PublicKey.
	KID string `json:"kid"`
	// Sig is the identity key's Ed25519 signature over
	// [EncryptionKeySignaturePayload], standard base64.
	Sig string `json:"sig"`
}

// SealedWorkloadEnv is the plaintext of [WorkloadSpec].EnvSealed.
type SealedWorkloadEnv struct {
	Env map[string]string `json:"env"`
	// Files are written to /run/secrets/<KEY> instead of the environment.
	Files map[string]string `json:"files"`
}

// SealedBuildSecrets is the plaintext of [BuildJob].BuildSecretsSealed.
type SealedBuildSecrets struct {
	// Secrets are BuildKit secrets by id.
	Secrets map[string]string `json:"secrets"`
}

// BoxInfo returns the HKDF info string of a purpose.
func BoxInfo(purpose BoxPurpose) string {
	return "roundhouse-box:v" + strconv.Itoa(BoxVersion) + ":" + string(purpose)
}

// WorkloadEnvAAD returns the AAD of a workload's sealed environment.
// Mirrors workloadEnvAad in TypeScript.
func WorkloadEnvAAD(nodeID, workloadID string, generation int64) string {
	return BoxInfo(BoxPurposeWorkloadEnv) + ":" + nodeID + ":" + workloadID + ":" + strconv.FormatInt(generation, 10)
}

// BuildSecretsAAD returns the AAD of a build job's sealed secrets.
// Mirrors buildSecretsAad in TypeScript.
func BuildSecretsAAD(nodeID, buildID string) string {
	return BoxInfo(BoxPurposeBuildSecrets) + ":" + nodeID + ":" + buildID
}

// NodeEncryptionKeyID returns the first 16 hex characters of SHA-256 of a
// raw X25519 public key. Mirrors nodeEncryptionKeyId in TypeScript.
func NodeEncryptionKeyID(publicKey []byte) string {
	sum := sha256.Sum256(publicKey)
	return hex.EncodeToString(sum[:])[:16]
}

// EncryptionKeySignaturePayload returns the bytes a node signs to register
// its encryption key. Mirrors encryptionKeySignaturePayload in TypeScript.
func EncryptionKeySignaturePayload(nodeID, publicKeyB64 string) []byte {
	return []byte("roundhouse-node-encryption-key:v1:" + nodeID + ":" + publicKeyB64)
}

// NewNodeEncryptionKey signs pub with the node's identity key for [Hello].
func NewNodeEncryptionKey(identity ed25519.PrivateKey, nodeID string, pub *ecdh.PublicKey) NodeEncryptionKey {
	b64 := base64.StdEncoding.EncodeToString(pub.Bytes())
	sig := ed25519.Sign(identity, EncryptionKeySignaturePayload(nodeID, b64))
	return NodeEncryptionKey{
		PublicKey: b64,
		KID:       NodeEncryptionKeyID(pub.Bytes()),
		Sig:       base64.StdEncoding.EncodeToString(sig),
	}
}

func (k *NodeEncryptionKey) validate() error {
	pub, err := base64.StdEncoding.DecodeString(k.PublicKey)
	if err != nil || len(pub) != 32 || !base64Key32RE.MatchString(k.PublicKey) {
		return errors.New("encryption_key.public_key: expected a base64 32-byte key")
	}
	if k.KID != NodeEncryptionKeyID(pub) {
		return errors.New("encryption_key.kid: does not match public_key")
	}
	if sig, err := base64.StdEncoding.DecodeString(k.Sig); err != nil || len(sig) != ed25519.SignatureSize {
		return errors.New("encryption_key.sig: expected a base64 Ed25519 signature")
	}
	return nil
}

func (b *SealedBox) validate() error {
	if b.V != BoxVersion {
		return fmt.Errorf("sealed box: unsupported version %d", b.V)
	}
	if !nodeKeyIDRE.MatchString(b.KID) {
		return errors.New("sealed box: invalid kid")
	}
	if !base64Key32RE.MatchString(b.EPK) {
		return errors.New("sealed box: invalid epk")
	}
	if len(b.CT) > MaxSealedBoxCTChars || !base64RE.MatchString(b.CT) {
		return errors.New("sealed box: invalid ct")
	}
	return nil
}

// boxKey derives the AES key and nonce. The salt binds both public keys, so
// a box can't be re-targeted by swapping the ephemeral key.
func boxKey(shared, epk, recipient []byte, purpose BoxPurpose) (cipher.AEAD, []byte, error) {
	if bytes.Equal(shared, make([]byte, len(shared))) {
		return nil, nil, errors.New("sealed box: all-zero shared secret")
	}
	salt := append(append([]byte{}, epk...), recipient...)
	okm, err := hkdf.Key(sha256.New, shared, salt, BoxInfo(purpose), 44)
	if err != nil {
		return nil, nil, err
	}
	block, err := aes.NewCipher(okm[:32])
	if err != nil {
		return nil, nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	return aead, okm[32:44], nil
}

// SealBox encrypts plaintext to a node's X25519 public key with a fresh
// ephemeral key. The control plane seals in TypeScript; this exists for
// tests and tooling.
func SealBox(recipient *ecdh.PublicKey, plaintext []byte, purpose BoxPurpose, aad string) (*SealedBox, error) {
	eph, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return sealBoxWith(eph, recipient, plaintext, purpose, aad)
}

// sealBoxWith seals with a given ephemeral key. Reusing one breaks the
// scheme; only the test vectors do it.
func sealBoxWith(eph *ecdh.PrivateKey, recipient *ecdh.PublicKey, plaintext []byte, purpose BoxPurpose, aad string) (*SealedBox, error) {
	shared, err := eph.ECDH(recipient)
	if err != nil {
		return nil, err
	}
	epk := eph.PublicKey().Bytes()
	aead, nonce, err := boxKey(shared, epk, recipient.Bytes(), purpose)
	if err != nil {
		return nil, err
	}
	ct := aead.Seal(nil, nonce, plaintext, []byte(aad))
	return &SealedBox{
		V:   BoxVersion,
		KID: NodeEncryptionKeyID(recipient.Bytes()),
		EPK: base64.StdEncoding.EncodeToString(epk),
		CT:  base64.StdEncoding.EncodeToString(ct),
	}, nil
}

// OpenBox decrypts a box sealed to priv for purpose and aad. It returns
// [ErrBoxWrongKey] when the box names another key.
func OpenBox(priv *ecdh.PrivateKey, box *SealedBox, purpose BoxPurpose, aad string) ([]byte, error) {
	if box == nil {
		return nil, errors.New("sealed box: missing")
	}
	if err := box.validate(); err != nil {
		return nil, err
	}
	recipient := priv.PublicKey().Bytes()
	if box.KID != NodeEncryptionKeyID(recipient) {
		return nil, ErrBoxWrongKey
	}
	epkBytes, err := base64.StdEncoding.DecodeString(box.EPK)
	if err != nil {
		return nil, fmt.Errorf("sealed box: epk: %w", err)
	}
	epk, err := ecdh.X25519().NewPublicKey(epkBytes)
	if err != nil {
		return nil, fmt.Errorf("sealed box: epk: %w", err)
	}
	ct, err := base64.StdEncoding.DecodeString(box.CT)
	if err != nil {
		return nil, fmt.Errorf("sealed box: ct: %w", err)
	}
	shared, err := priv.ECDH(epk)
	if err != nil {
		return nil, err
	}
	aead, nonce, err := boxKey(shared, epkBytes, recipient, purpose)
	if err != nil {
		return nil, err
	}
	pt, err := aead.Open(nil, nonce, ct, []byte(aad))
	if err != nil {
		return nil, errors.New("sealed box: decryption failed")
	}
	return pt, nil
}

// OpenWorkloadEnv opens w.EnvSealed and fills w.Env and w.SecretFiles. The
// generation is the one of the desired_state frame carrying w.
func OpenWorkloadEnv(priv *ecdh.PrivateKey, nodeID string, generation int64, w *WorkloadSpec) error {
	pt, err := OpenBox(priv, w.EnvSealed, BoxPurposeWorkloadEnv, WorkloadEnvAAD(nodeID, w.ID, generation))
	if err != nil {
		return fmt.Errorf("workload %s: %w", w.ID, err)
	}
	var env SealedWorkloadEnv
	if err := decodeStrict(pt, &env, true); err != nil {
		return fmt.Errorf("workload %s: env: %w", w.ID, err)
	}
	if err := env.validate(); err != nil {
		return fmt.Errorf("workload %s: %w", w.ID, err)
	}
	w.Env, w.SecretFiles = env.Env, env.Files
	return nil
}

func (e *SealedWorkloadEnv) validate() error {
	if len(e.Env)+len(e.Files) > MaxEnvVars {
		return fmt.Errorf("env: at most %d variables", MaxEnvVars)
	}
	total := 0
	for _, m := range []map[string]string{e.Env, e.Files} {
		for k, v := range m {
			if len(k) > MaxEnvKeyBytes || !envKeyRE.MatchString(k) {
				return fmt.Errorf("env: invalid name %q", k)
			}
			if len(v) > MaxEnvValueBytes || bytes.IndexByte([]byte(v), 0) >= 0 {
				return fmt.Errorf("env: invalid value for %q", k)
			}
			total += len(k) + len(v)
		}
	}
	if total > MaxEnvTotalBytes {
		return fmt.Errorf("env: at most %d bytes", MaxEnvTotalBytes)
	}
	for k := range e.Files {
		if _, dup := e.Env[k]; dup {
			return fmt.Errorf("env: %s is both an env var and a file", k)
		}
	}
	return nil
}

// OpenBuildSecrets opens j.BuildSecretsSealed. A job without secrets yields
// an empty map.
func OpenBuildSecrets(priv *ecdh.PrivateKey, nodeID string, j *BuildJob) (map[string]string, error) {
	if j.BuildSecretsSealed == nil {
		return map[string]string{}, nil
	}
	pt, err := OpenBox(priv, j.BuildSecretsSealed, BoxPurposeBuildSecrets, BuildSecretsAAD(nodeID, j.BuildID))
	if err != nil {
		return nil, fmt.Errorf("build %s: %w", j.BuildID, err)
	}
	var s SealedBuildSecrets
	if err := decodeStrict(pt, &s, true); err != nil {
		return nil, fmt.Errorf("build %s: secrets: %w", j.BuildID, err)
	}
	if len(s.Secrets) > MaxBuildSecrets {
		return nil, fmt.Errorf("build %s: at most %d secrets", j.BuildID, MaxBuildSecrets)
	}
	for k, v := range s.Secrets {
		if len(k) > MaxEnvKeyBytes || !envKeyRE.MatchString(k) || len(v) > MaxBuildSecretValueBytes ||
			bytes.IndexByte([]byte(v), 0) >= 0 {
			return nil, fmt.Errorf("build %s: invalid secret %q", j.BuildID, k)
		}
	}
	return s.Secrets, nil
}
