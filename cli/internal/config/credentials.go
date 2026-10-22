// Package config persists the CLI's state on disk:
//   - the credentials file, holding one named profile per control plane with
//     its URL and session cookie, in the OS config directory, mode 0600;
//   - the link file `.roundhouse/config.json`, binding a directory to a
//     project, environment and service.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// DefaultProfile is the profile used when none is named.
const DefaultProfile = "default"

// credentialsMode is the only mode the credentials file is written with.
const credentialsMode fs.FileMode = 0o600

// Credentials is the content of the credentials file.
type Credentials struct {
	// Profiles maps a profile name to its control plane and session.
	Profiles map[string]*Profile `json:"profiles"`
}

// Profile is one control plane the user has signed in to.
type Profile struct {
	// URL is the control plane origin.
	URL string `json:"url"`
	// Insecure records that plain http:// to loopback was allowed at login.
	Insecure bool `json:"insecure,omitempty"`
	// Session is the Better Auth session; nil once signed out.
	Session *Session `json:"session,omitempty"`
	// User is who signed in, for display only.
	User *ProfileUser `json:"user,omitempty"`
}

// Session is a stored session cookie.
type Session struct {
	CookieName string `json:"cookie_name"`
	// Value is the cookie value. SECURITY: never print or log it.
	Value     string     `json:"value"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

// ProfileUser identifies the signed-in user.
type ProfileUser struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// Dir returns the CLI's config directory: $ROUNDHOUSE_CONFIG_DIR, or
// `roundhouse` under the OS user config directory (XDG_CONFIG_HOME or
// ~/.config on Linux, ~/Library/Application Support on macOS, %AppData% on
// Windows).
func Dir(getenv func(string) string) (string, error) {
	if d := getenv("ROUNDHOUSE_CONFIG_DIR"); d != "" {
		return d, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("locate config directory: %w (set ROUNDHOUSE_CONFIG_DIR)", err)
	}
	return filepath.Join(base, "roundhouse"), nil
}

// CredentialsPath returns the credentials file inside dir.
func CredentialsPath(dir string) string {
	return filepath.Join(dir, "credentials.json")
}

// LoadCredentials reads the credentials file. A missing file yields empty
// credentials. The returned warning is non-empty when the file is readable by
// other users; the caller should show it.
func LoadCredentials(path string) (*Credentials, string, error) {
	c := &Credentials{Profiles: map[string]*Profile{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return c, "", nil
	}
	if err != nil {
		return nil, "", fmt.Errorf("read credentials: %w", err)
	}
	var warning string
	if fi, err := os.Stat(path); err == nil && tooOpen(fi.Mode()) {
		warning = fmt.Sprintf("credentials file %s has mode %#o and is readable by other users; run `chmod 600 %s`",
			path, fi.Mode().Perm(), path)
	}
	if err := json.Unmarshal(data, c); err != nil {
		return nil, warning, fmt.Errorf("parse %s: %w", path, err)
	}
	if c.Profiles == nil {
		c.Profiles = map[string]*Profile{}
	}
	return c, warning, nil
}

// Save writes the credentials file atomically with mode 0600, creating its
// directory with mode 0700.
func (c *Credentials) Save(path string) error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(path, append(data, '\n'), credentialsMode)
}

// writeAtomic replaces path via a synced temp file and rename, so a crash
// leaves the old file or the new one, never a truncated mix.
//
// NOTE: perm is applied to the temp file before any data is written, so a
// session is never briefly readable by others. On Windows the mode is mostly
// ignored; the file inherits the per-user ACL of %AppData%.
func writeAtomic(path string, data []byte, perm fs.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(perm); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
