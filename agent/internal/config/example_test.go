package config

import (
	"path/filepath"
	"testing"
)

// TestExampleConfig keeps install/agent.example.yaml loadable: Load rejects
// unknown keys, so a renamed or removed field fails here rather than in an
// operator's hands.
func TestExampleConfig(t *testing.T) {
	c, err := Load(filepath.Join("..", "..", "..", "install", "agent.example.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Validate(); err != nil {
		t.Fatalf("example does not validate: %v", err)
	}
	if c.Insecure || c.Builder {
		t.Error("the example must show the production defaults (insecure and builder off)")
	}
}
