// Package nodekey creates and loads the node's two private keys:
//
//   - the Ed25519 identity key, PEM-encoded PKCS#8, which signs the node's
//     encryption key for the control plane (ADR 0014, "Node sealing");
//   - the X25519 encryption key, stored as its raw 32 bytes, which opens the
//     sealed boxes carrying workload environments and build secrets.
//
// Both live in 0600 files next to the credential. The two keys are kept
// separate so neither algorithm's key is ever used for the other's purpose.
package nodekey

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/BankkRoll/Roundhouse/agent/internal/atomicfile"
)

// encryptionKeySize is the length of a raw X25519 private key.
const encryptionKeySize = 32

// CreateIdentity generates an Ed25519 keypair, stores the private key at
// path as PEM-encoded PKCS#8 (a format openssl and other tooling can read)
// and returns the public key.
func CreateIdentity(path string) (ed25519.PublicKey, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, err
	}
	if err := atomicfile.Write(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return nil, err
	}
	return pub, nil
}

// LoadIdentity reads the Ed25519 private key [CreateIdentity] wrote.
func LoadIdentity(path string) (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("%s: not a PEM private key", path)
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	priv, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%s: not an Ed25519 key", path)
	}
	return priv, nil
}

// CreateEncryptionKey generates an X25519 keypair and stores the raw private
// key at path, replacing any file there.
func CreateEncryptionKey(path string) (*ecdh.PrivateKey, error) {
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	if err := atomicfile.Write(path, priv.Bytes(), 0o600); err != nil {
		return nil, err
	}
	return priv, nil
}

// LoadEncryptionKey reads the X25519 private key [CreateEncryptionKey]
// wrote. A missing file returns an error wrapping [fs.ErrNotExist].
func LoadEncryptionKey(path string) (*ecdh.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) != encryptionKeySize {
		return nil, fmt.Errorf("%s: expected a raw %d-byte X25519 key, got %d bytes", path, encryptionKeySize, len(data))
	}
	priv, err := ecdh.X25519().NewPrivateKey(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return priv, nil
}

// LoadOrCreateEncryptionKey loads the key at path, or creates it when the
// file does not exist, and reports whether it created one.
//
// NOTE: a node that joined before encryption keys existed has none; it
// creates one on its first start and registers it in hello. A node whose key
// file was lost gets a new key too, but the control plane keeps the key it
// registered first, so its boxes fail with the protocol's ErrBoxWrongKey
// until the node re-joins.
func LoadOrCreateEncryptionKey(path string) (*ecdh.PrivateKey, bool, error) {
	priv, err := LoadEncryptionKey(path)
	if err == nil {
		return priv, false, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return nil, false, err
	}
	priv, err = CreateEncryptionKey(path)
	return priv, err == nil, err
}

// EncryptionKeyPath returns the encryption key file belonging to an identity
// key file: "identity-<reg>.key" maps to "encryption-<reg>.key" in the same
// directory, so a registration's files keep sharing their suffix.
func EncryptionKeyPath(identityKeyFile string) string {
	dir, base := filepath.Split(identityKeyFile)
	if rest, ok := strings.CutPrefix(base, "identity"); ok {
		return filepath.Join(dir, "encryption"+rest)
	}
	return filepath.Join(dir, "encryption.key")
}
