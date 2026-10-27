package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMeshConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	if err := os.WriteFile(path, []byte("mesh:\n  mode: userspace\n  listen_port: 51999\n  endpoint: node1.example.com:51999\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if c.MeshMode() != MeshUserspace || c.MeshListenPort() != 51999 || c.Mesh.Endpoint != "node1.example.com:51999" {
		t.Errorf("mesh = %+v", c.Mesh)
	}
	if err := c.Mesh.validate(); err != nil {
		t.Error(err)
	}
	if d := (Config{}); d.MeshMode() != MeshAuto || d.MeshListenPort() != DefaultMeshListenPort {
		t.Errorf("defaults = %s %d", d.MeshMode(), d.MeshListenPort())
	}
	for _, bad := range []MeshConfig{{Mode: "on"}, {ListenPort: 70000}, {ListenPort: -1}, {Endpoint: "no-port"}, {Endpoint: "UPPER.example.com:1"}} {
		if err := bad.validate(); err == nil || !strings.Contains(err.Error(), "mesh.") {
			t.Errorf("%+v: err = %v", bad, err)
		}
	}
	if err := os.WriteFile(path, []byte("mesh:\n  mtu: 1420\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Error("an unknown mesh key was accepted")
	}
}
