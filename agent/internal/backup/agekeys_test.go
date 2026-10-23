package backup

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"

	"filippo.io/age"
)

// TestControlPlaneAgeKeypairInterop checks that the age keys the control
// plane generates (apps/api/src/lib/age.ts) parse here, so a backup the
// agent encrypts to a project's recipient can be restored with its identity.
func TestControlPlaneAgeKeypairInterop(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "api", "test", "fixtures", "age", "keypair.json"))
	if err != nil {
		t.Fatal(err)
	}
	var kp struct {
		Identity  string `json:"identity"`
		Recipient string `json:"recipient"`
	}
	if err := json.Unmarshal(raw, &kp); err != nil {
		t.Fatal(err)
	}
	id, err := age.ParseX25519Identity(kp.Identity)
	if err != nil {
		t.Fatal(err)
	}
	if got := id.Recipient().String(); got != kp.Recipient {
		t.Fatalf("recipient %s, fixture %s", got, kp.Recipient)
	}
	rcpt, err := age.ParseX25519Recipient(kp.Recipient)
	if err != nil {
		t.Fatal(err)
	}
	var sealed bytes.Buffer
	w, err := age.Encrypt(&sealed, rcpt)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("backup")); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	r, err := age.Decrypt(&sealed, id)
	if err != nil {
		t.Fatal(err)
	}
	if out, _ := io.ReadAll(r); string(out) != "backup" {
		t.Fatalf("round trip %q", out)
	}
}
