package nodekey

import (
	"crypto/ed25519"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestIdentityRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity-abc.key")
	pub, err := CreateIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	priv, err := LoadIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	if !priv.Public().(ed25519.PublicKey).Equal(pub) {
		t.Fatal("loaded key does not match the created one")
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
			t.Errorf("mode %v, want 0600", fi.Mode().Perm())
		}
	}
}

func TestLoadIdentityRejectsGarbage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.key")
	if err := os.WriteFile(path, []byte("not a key"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadIdentity(path); err == nil {
		t.Fatal("garbage accepted")
	}
}

func TestEncryptionKeyLoadOrCreate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "encryption-abc.key")
	if _, err := LoadEncryptionKey(path); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing key: %v", err)
	}
	first, created, err := LoadOrCreateEncryptionKey(path)
	if err != nil || !created {
		t.Fatalf("create: created=%v err=%v", created, err)
	}
	again, created, err := LoadOrCreateEncryptionKey(path)
	if err != nil || created {
		t.Fatalf("load: created=%v err=%v", created, err)
	}
	if !first.Equal(again) {
		t.Fatal("reloaded key differs")
	}
	data, _ := os.ReadFile(path)
	if len(data) != 32 {
		t.Fatalf("stored %d bytes, want the raw 32", len(data))
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
			t.Errorf("mode %v, want 0600", fi.Mode().Perm())
		}
	}
}

func TestLoadEncryptionKeyRejectsWrongSize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "encryption.key")
	if err := os.WriteFile(path, make([]byte, 31), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := LoadOrCreateEncryptionKey(path); err == nil {
		t.Fatal("a truncated key must not be replaced silently")
	}
}

func TestEncryptionKeyPath(t *testing.T) {
	dir := t.TempDir()
	for in, want := range map[string]string{
		filepath.Join(dir, "identity-1a2b.key"): filepath.Join(dir, "encryption-1a2b.key"),
		filepath.Join(dir, "identity.key"):      filepath.Join(dir, "encryption.key"),
		filepath.Join(dir, "node.pem"):          filepath.Join(dir, "encryption.key"),
	} {
		if got := EncryptionKeyPath(in); got != want {
			t.Errorf("EncryptionKeyPath(%q) = %q, want %q", in, got, want)
		}
	}
}
