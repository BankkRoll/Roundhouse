// Package config loads and saves the agent's on-disk configuration and the
// secret files it points to.
//
// The YAML config holds only non-secret settings. The bearer credential, the
// node's Ed25519 identity key and its X25519 encryption key live in separate
// 0600 files referenced by path, so the config can be inspected or backed up
// without leaking them.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/BankkRoll/Roundhouse/agent/internal/atomicfile"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
	"gopkg.in/yaml.v3"
)

// Config is the agent configuration written by `join` and read by `run`.
type Config struct {
	// ControlPlaneURL is the http(s) origin the node joined.
	ControlPlaneURL string `yaml:"control_plane_url"`
	NodeID          string `yaml:"node_id"`
	// ConnectURL is the ws(s) URL the agent dials for its control socket.
	ConnectURL string `yaml:"connect_url"`
	// ControlPublicKey is the pinned control-plane Ed25519 key, standard
	// base64 of the raw 32 bytes.
	ControlPublicKey string `yaml:"control_public_key"`
	// CredentialFile holds the bearer credential for ConnectURL.
	CredentialFile string `yaml:"credential_file"`
	// IdentityKeyFile holds the node's PEM-encoded PKCS#8 Ed25519 private key.
	IdentityKeyFile string `yaml:"identity_key_file"`
	// EncryptionKeyFile holds the node's raw X25519 private key, which opens
	// sealed environments and build secrets. Empty in configs written before
	// sealing; `run` then creates the key and records its path.
	EncryptionKeyFile string `yaml:"encryption_key_file,omitempty"`
	// StateFile holds state that must survive restarts, such as the observed
	// desired-state generation.
	StateFile string `yaml:"state_file"`
	// ControlKeysFile holds the control-plane signing keys the node trusts,
	// including successors announced for a rollover. Empty in configs
	// written before rollover; see [Config.ControlKeysPath].
	ControlKeysFile string `yaml:"control_keys_file,omitempty"`
	// ControlKeyID is the envelope kid of ControlPublicKey, pinned from the
	// first verified welcome. Empty until then.
	ControlKeyID string `yaml:"control_key_id,omitempty"`
	// Insecure permits plaintext http:// and ws:// to non-loopback hosts. Set
	// only by `join --insecure`.
	Insecure bool `yaml:"insecure,omitempty"`
	// DataDir holds the log buffer, the registry's storage and other runtime
	// data. Empty means the directory of StateFile.
	DataDir string `yaml:"data_dir,omitempty"`
	// Builder makes this node a builder: it runs the local registry and
	// accepts build jobs. Set by `join --builder`.
	Builder bool `yaml:"builder,omitempty"`
	// Volumes configures where and how the node keeps volumes.
	Volumes VolumesConfig `yaml:"volumes,omitempty"`
}

// VolumesConfig is the volumes section of the config (ADR 0004, "Volumes").
type VolumesConfig struct {
	// Root is the volumes root; empty means /var/lib/roundhouse/volumes on
	// Linux and a "volumes" directory in the data directory elsewhere.
	Root string `yaml:"root,omitempty"`
	// Quota is how volume sizes are enforced: auto, loop or none; empty
	// means auto. xfs and ext4 are refused (ADR 0004, "Why not project
	// quotas").
	Quota string `yaml:"quota,omitempty"`
}

// DefaultPath returns the config path used when --config is not given:
// /etc/roundhouse/agent.yaml on Linux, and a per-user location elsewhere so the
// agent can be run unprivileged during local development.
func DefaultPath() string {
	if runtime.GOOS == "linux" {
		return "/etc/roundhouse/agent.yaml"
	}
	return filepath.Join(userDir(), "agent.yaml")
}

// DefaultDataDir returns the directory for the credential, key and state
// files belonging to the config at configPath: /var/lib/roundhouse on
// Linux, and a sibling of the config elsewhere, so local agents started with
// different --config paths never share a credential.
func DefaultDataDir(configPath string) string {
	if runtime.GOOS == "linux" {
		return "/var/lib/roundhouse"
	}
	base := filepath.Base(configPath)
	return filepath.Join(filepath.Dir(configPath), strings.TrimSuffix(base, filepath.Ext(base))+"-data")
}

func userDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "roundhouse")
}

// WithDataDir returns a copy of c with every unset file path defaulted to a
// conventional name inside dir. A non-empty registration is embedded in each
// name, so the files of a new registration never overwrite those of the
// registration the current config still points at.
func (c Config) WithDataDir(dir, registration string) Config {
	suffix := ""
	if registration != "" {
		suffix = "-" + registration
	}
	if c.CredentialFile == "" {
		c.CredentialFile = filepath.Join(dir, "credential"+suffix)
	}
	if c.IdentityKeyFile == "" {
		c.IdentityKeyFile = filepath.Join(dir, "identity"+suffix+".key")
	}
	if c.EncryptionKeyFile == "" {
		c.EncryptionKeyFile = filepath.Join(dir, "encryption"+suffix+".key")
	}
	if c.StateFile == "" {
		c.StateFile = filepath.Join(dir, "state"+suffix+".json")
	}
	if c.ControlKeysFile == "" {
		c.ControlKeysFile = filepath.Join(dir, "control-keys"+suffix+".json")
	}
	if c.DataDir == "" {
		c.DataDir = dir
	}
	return c
}

// Joined reports whether c describes a node that has completed `join`.
func (c Config) Joined() bool {
	return c.NodeID != ""
}

// Validate checks that c is complete enough for `run`.
func (c Config) Validate() error {
	var errs []error
	required := []struct{ key, value string }{
		{"control_plane_url", c.ControlPlaneURL},
		{"node_id", c.NodeID},
		{"connect_url", c.ConnectURL},
		{"control_public_key", c.ControlPublicKey},
		{"credential_file", c.CredentialFile},
		{"identity_key_file", c.IdentityKeyFile},
		{"state_file", c.StateFile},
	}
	for _, f := range required {
		if f.value == "" {
			errs = append(errs, fmt.Errorf("%s is required", f.key))
		}
	}
	if c.ControlPlaneURL != "" {
		if cp, err := ParseControlPlaneURL(c.ControlPlaneURL, c.Insecure); err != nil {
			errs = append(errs, err)
		} else if c.ConnectURL != "" {
			if err := CheckConnectURL(c.ConnectURL, cp, c.Insecure); err != nil {
				errs = append(errs, err)
			}
		}
	}
	if c.ControlPublicKey != "" {
		if _, err := protocol.ParsePublicKey(c.ControlPublicKey); err != nil {
			errs = append(errs, errors.New("control_public_key must be a base64 raw Ed25519 public key"))
		}
	}
	return errors.Join(errs...)
}

// Load reads the config at path. Unknown keys are rejected so typos surface
// instead of silently falling back to defaults. A missing file returns an
// error wrapping [fs.ErrNotExist].
func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var c Config
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return Config{}, fmt.Errorf("parse %s: %w", path, err)
	}
	return c, nil
}

// Save atomically writes c to path, creating parent directories.
func Save(path string, c Config) error {
	data, err := yaml.Marshal(c)
	if err != nil {
		return err
	}
	return atomicfile.Write(path, data, 0o600)
}

// Exists reports whether a config file is present at path.
func Exists(path string) (bool, error) {
	_, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// ReadSecret reads a secret file written by [WriteSecret], trimming
// surrounding whitespace so hand-edited files still work.
func ReadSecret(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	s := strings.TrimSpace(string(data))
	if s == "" {
		return "", fmt.Errorf("%s is empty", path)
	}
	return s, nil
}

// WriteSecret atomically writes a secret readable only by the owner.
func WriteSecret(path string, data []byte) error {
	return atomicfile.Write(path, data, 0o600)
}

// RuntimeDir returns the directory for runtime data: DataDir, or the
// directory of StateFile for configs written before DataDir existed.
func (c Config) RuntimeDir() string {
	if c.DataDir != "" {
		return c.DataDir
	}
	return filepath.Dir(c.StateFile)
}

// ControlKeysPath returns ControlKeysFile, or for configs written before it
// existed a file named after StateFile, so each registration keeps its own.
func (c Config) ControlKeysPath() string {
	if c.ControlKeysFile != "" {
		return c.ControlKeysFile
	}
	return strings.TrimSuffix(c.StateFile, filepath.Ext(c.StateFile)) + ".control-keys.json"
}
