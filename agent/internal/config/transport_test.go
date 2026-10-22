package config

import (
	"strings"
	"testing"
)

func TestParseControlPlaneURL(t *testing.T) {
	for _, tc := range []struct {
		url      string
		insecure bool
		wantErr  string
	}{
		{url: "https://cp.example.com/"},
		{url: "http://localhost:8787"},
		{url: "http://127.0.0.1:8787"},
		{url: "http://[::1]:8787"},
		{url: "http://cp.example.com", wantErr: "refusing plaintext"},
		{url: "http://cp.example.com", insecure: true},
		{url: "ftp://cp.example.com", wantErr: "http(s) origin"},
		{url: "cp.example.com", wantErr: "http(s) origin"},
	} {
		_, err := ParseControlPlaneURL(tc.url, tc.insecure)
		if tc.wantErr == "" && err != nil {
			t.Errorf("%s (insecure=%v): unexpected error %v", tc.url, tc.insecure, err)
		}
		if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
			t.Errorf("%s (insecure=%v): got %v, want error containing %q", tc.url, tc.insecure, err, tc.wantErr)
		}
	}
}

func TestCheckConnectURL(t *testing.T) {
	for _, tc := range []struct {
		cp, connect string
		insecure    bool
		wantErr     string
	}{
		{cp: "https://cp.example.com", connect: "wss://cp.example.com/v1/nodes/n/connect"},
		{cp: "https://cp.example.com", connect: "wss://CP.example.com:443/x"},
		{cp: "https://cp.example.com:8443", connect: "wss://cp.example.com:8443/x"},
		{cp: "http://localhost:8787", connect: "ws://localhost:8787/x"},
		{cp: "https://cp.example.com", connect: "wss://evil.example.com/x", wantErr: "points at"},
		{cp: "https://cp.example.com", connect: "wss://cp.example.com:8443/x", wantErr: "points at"},
		{cp: "https://cp.example.com", connect: "ws://cp.example.com/x", wantErr: "plaintext"},
		{cp: "http://cp.example.com", connect: "ws://cp.example.com/x", insecure: true},
		{cp: "https://cp.example.com", connect: "https://cp.example.com/x", wantErr: "ws:// or wss://"},
	} {
		cp, err := ParseControlPlaneURL(tc.cp, tc.insecure)
		if err != nil {
			t.Fatalf("%s: %v", tc.cp, err)
		}
		err = CheckConnectURL(tc.connect, cp, tc.insecure)
		if tc.wantErr == "" && err != nil {
			t.Errorf("%s -> %s: unexpected error %v", tc.cp, tc.connect, err)
		}
		if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
			t.Errorf("%s -> %s: got %v, want error containing %q", tc.cp, tc.connect, err, tc.wantErr)
		}
	}
}

func TestValidateAppliesTransportRules(t *testing.T) {
	c := validConfig(t.TempDir())
	c.ControlPlaneURL = "http://cp.example.com"
	c.ConnectURL = "ws://cp.example.com/connect"
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "plaintext") {
		t.Fatalf("got %v, want plaintext rejection", err)
	}
	c.Insecure = true
	if err := c.Validate(); err != nil {
		t.Fatalf("insecure config rejected: %v", err)
	}
	c.ConnectURL = "ws://other.example.com/connect"
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "points at") {
		t.Fatalf("got %v, want host mismatch", err)
	}
}
