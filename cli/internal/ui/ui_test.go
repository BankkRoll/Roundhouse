package ui

import (
	"bytes"
	"strings"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

func TestNonInteractivePromptsFail(t *testing.T) {
	var out, errOut bytes.Buffer
	u := Test("answer\n", &out, &errOut)
	if u.Interactive() {
		t.Fatal("test IO is interactive by default")
	}
	_, err := u.Prompt("Name:", "", "pass --name")
	if exitcode.Of(err) != exitcode.InputRequired || !strings.Contains(err.Error(), "pass --name") {
		t.Errorf("Prompt: %v", err)
	}
	if v, err := u.Prompt("Name:", "fallback", ""); v != "fallback" || err != nil {
		t.Errorf("Prompt with default = %q, %v", v, err)
	}
	for name, f := range map[string]func() error{
		"Password":     func() error { _, err := u.Password("Password:", "x"); return err },
		"Confirm":      func() error { _, err := u.Confirm("Sure?", true, "x"); return err },
		"Select":       func() error { _, err := u.Select("Pick", []string{"a"}, "x"); return err },
		"ConfirmTyped": func() error { return u.ConfirmTyped("Delete", "shop", "") },
	} {
		if err := f(); exitcode.Of(err) != exitcode.InputRequired {
			t.Errorf("%s: %v", name, err)
		}
	}
	if errOut.Len() != 0 || out.Len() != 0 {
		t.Errorf("non-interactive prompt wrote %q %q", out.String(), errOut.String())
	}
}

func TestDisableInput(t *testing.T) {
	u := Test("y\n", &bytes.Buffer{}, &bytes.Buffer{})
	u.ForceInteractive()
	u.DisableInput()
	if u.Interactive() {
		t.Error("--no-input left prompts enabled")
	}
}

func TestInteractivePrompts(t *testing.T) {
	var errOut bytes.Buffer
	u := Test("\nbob\nx\n9\n2\n\nno\nshop\n", &bytes.Buffer{}, &errOut)
	u.ForceInteractive()
	if v, _ := u.Prompt("Name:", "alice", ""); v != "alice" {
		t.Errorf("default = %q", v)
	}
	if v, _ := u.Prompt("Name:", "", ""); v != "bob" {
		t.Errorf("answer = %q", v)
	}
	if i, err := u.Select("Pick", []string{"a", "b"}, ""); i != 1 || err != nil {
		t.Errorf("Select = %d, %v (invalid answers must re-ask)", i, err)
	}
	if ok, _ := u.Confirm("Sure?", true, ""); !ok {
		t.Error("empty answer ignored the default")
	}
	if ok, _ := u.Confirm("Sure?", true, ""); ok {
		t.Error("no was yes")
	}
	if err := u.ConfirmTyped("Delete", "shop", ""); err != nil {
		t.Errorf("ConfirmTyped: %v", err)
	}
	if _, err := u.Prompt("More:", "", ""); exitcode.Of(err) != exitcode.InputRequired {
		t.Errorf("EOF: %v", err)
	}
	if !strings.Contains(errOut.String(), "Enter a number (1-2)") {
		t.Errorf("prompts not on stderr: %q", errOut.String())
	}
}

func TestConfirmTypedFlag(t *testing.T) {
	u := Test("", &bytes.Buffer{}, &bytes.Buffer{})
	if err := u.ConfirmTyped("Delete", "shop", "shop"); err != nil {
		t.Errorf("matching --confirm: %v", err)
	}
	if err := u.ConfirmTyped("Delete", "shop", "shpo"); exitcode.Of(err) != exitcode.Usage {
		t.Errorf("mismatched --confirm: %v", err)
	}
}

func TestPalette(t *testing.T) {
	off, on := NewPalette(false), NewPalette(true)
	if off.Red("x") != "x" || off.Status("failed") != "failed" {
		t.Error("disabled palette coloured text")
	}
	if on.Red("x") != "\x1b[31mx\x1b[0m" || on.Status("active") != "\x1b[32mactive\x1b[0m" || on.Bold("") != "" {
		t.Error("enabled palette")
	}
	u := Test("", &bytes.Buffer{}, &bytes.Buffer{})
	if u.OutColor().Enabled() || u.ErrColor().Enabled() {
		t.Error("colour without a TTY")
	}
}

func TestSpinnerInertWithoutTTY(t *testing.T) {
	var out, errOut bytes.Buffer
	u := Test("", &out, &errOut)
	s := u.StartSpinner("working")
	s.Update("still working")
	s.Println(&out, "line")
	s.Stop()
	s.Stop()
	if errOut.Len() != 0 || out.String() != "line\n" {
		t.Errorf("stdout %q, stderr %q", out.String(), errOut.String())
	}
}
