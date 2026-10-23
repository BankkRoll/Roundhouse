package protocol

import (
	"encoding/json"
	"slices"
	"testing"
)

// TestRedactionFixture is the Go half of the redaction parity check; the
// TypeScript generator wrote the expected needles with redactionNeedles.
func TestRedactionFixture(t *testing.T) {
	var f struct {
		Cases []struct {
			Secrets  []string `json:"secrets"`
			Line     string   `json:"line"`
			Needles  []string `json:"needles"`
			Redacted string   `json:"redacted"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(readFixture(t, "redaction.json"), &f); err != nil {
		t.Fatal(err)
	}
	for i, c := range f.Cases {
		needles := RedactionNeedles(c.Secrets)
		if !slices.Equal(needles, c.Needles) {
			t.Errorf("case %d: needles\n got %q\nwant %q", i, needles, c.Needles)
		}
		if got := Redact(c.Line, needles); got != c.Redacted {
			t.Errorf("case %d: redacted %q, want %q", i, got, c.Redacted)
		}
	}
	if len(RedactionNeedles([]string{"short", "12345"})) != 0 {
		t.Error("short secrets must not be redacted")
	}
}
