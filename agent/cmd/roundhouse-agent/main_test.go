package main

import (
	"bytes"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveToken(t *testing.T) {
	file := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(file, []byte("njt_from_file\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	tok := ""
	if err := resolveToken(&tok, file); err != nil || tok != "njt_from_file" {
		t.Fatalf("file: got %q, %v", tok, err)
	}

	tok = "njt_flag"
	if err := resolveToken(&tok, file); err == nil {
		t.Fatal("expected --token and --token-file together to be rejected")
	}

	t.Setenv("ROUNDHOUSE_JOIN_TOKEN", "njt_env")
	tok = ""
	if err := resolveToken(&tok, ""); err != nil || tok != "njt_env" {
		t.Fatalf("env: got %q, %v", tok, err)
	}
	tok = "njt_flag"
	if err := resolveToken(&tok, ""); err != nil || tok != "njt_flag" {
		t.Fatalf("flag should win over env: got %q, %v", tok, err)
	}

	tok = ""
	if err := resolveToken(&tok, filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("expected a missing token file to fail")
	}
}

func TestPinKeyID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	if err := os.WriteFile(path, []byte("node_id: node_1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := pinKeyID(path, "k1"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if want := "control_key_id: k1"; !strings.Contains(string(data), want) {
		t.Fatalf("config %q does not contain %q", data, want)
	}
}

func TestHelpExitsCleanly(t *testing.T) {
	for _, args := range [][]string{{"join", "-h"}, {"run", "-h"}, {"help"}} {
		var stdout, stderr bytes.Buffer
		if err := run(args, slog.New(slog.DiscardHandler), &stdout, &stderr); err != nil {
			t.Errorf("%v: got %v, want nil", args, err)
		}
		if stdout.Len()+stderr.Len() == 0 {
			t.Errorf("%v: no usage printed", args)
		}
	}
}

func TestUnknownAndMissingCommand(t *testing.T) {
	var stderr bytes.Buffer
	if err := run(nil, slog.New(slog.DiscardHandler), io.Discard, &stderr); err == nil {
		t.Error("expected an error with no command")
	}
	if !strings.Contains(stderr.String(), "Usage:") {
		t.Error("usage not written to the injected writer")
	}
	if err := run([]string{"bogus"}, slog.New(slog.DiscardHandler), io.Discard, io.Discard); err == nil {
		t.Error("expected an error for an unknown command")
	}
}
