package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func validConfig(dir string) Config {
	return Config{
		ControlPlaneURL:  "https://cp.example.com",
		NodeID:           "node_1",
		ConnectURL:       "wss://cp.example.com/v1/nodes/node_1/connect",
		ControlPublicKey: "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=",
	}.WithDataDir(dir, "")
}

func TestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "etc", "agent.yaml")
	want := validConfig(filepath.Join(dir, "data"))

	if ok, err := Exists(path); err != nil || ok {
		t.Fatalf("Exists before save = %v, %v", ok, err)
	}
	if err := Save(path, want); err != nil {
		t.Fatal(err)
	}
	if ok, err := Exists(path); err != nil || !ok {
		t.Fatalf("Exists after save = %v, %v", ok, err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	if err := got.Validate(); err != nil {
		t.Fatal(err)
	}
	if !got.Joined() {
		t.Fatal("expected Joined")
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("perm = %o, want 600", perm)
		}
	}
}

func TestLoadRejectsUnknownKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	if err := os.WriteFile(path, []byte("node_id: n\nnode_idd: typo\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "node_idd") {
		t.Fatalf("got %v", err)
	}
}

func TestValidate(t *testing.T) {
	c := validConfig(t.TempDir())
	c.NodeID = ""
	c.ConnectURL = "https://cp.example.com/connect"
	c.ControlPublicKey = "short"
	err := c.Validate()
	if err == nil {
		t.Fatal("expected error")
	}
	for _, want := range []string{"node_id", "connect_url", "control_public_key"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s", err, want)
		}
	}
}

func TestSecrets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "credential")
	if err := WriteSecret(path, []byte("nc_secret\n")); err != nil {
		t.Fatal(err)
	}
	got, err := ReadSecret(path)
	if err != nil || got != "nc_secret" {
		t.Fatalf("got %q, %v", got, err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("perm = %o, want 600", perm)
		}
	}
	empty := filepath.Join(t.TempDir(), "empty")
	if err := WriteSecret(empty, []byte(" \n")); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadSecret(empty); err == nil {
		t.Fatal("expected empty secret to be rejected")
	}
}
