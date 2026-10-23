package enroll

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/BankkRoll/Roundhouse/agent/internal/config"
	"github.com/BankkRoll/Roundhouse/agent/internal/facts"
	"github.com/BankkRoll/Roundhouse/agent/internal/nodekey"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// fakeJoin is a control plane whose join behaviour each test can change.
type fakeJoin struct {
	srv     *httptest.Server
	got     protocol.JoinRequest
	handler func(w http.ResponseWriter, r *http.Request)
}

func newFakeJoin(t *testing.T) *fakeJoin {
	f := &fakeJoin{}
	f.handler = f.accept
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != protocol.JoinPath {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		f.handler(w, r)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeJoin) connectURL() string {
	return "ws" + strings.TrimPrefix(f.srv.URL, "http") + "/v1/nodes/node_1/connect"
}

func (f *fakeJoin) accept(w http.ResponseWriter, r *http.Request) {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f.got); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	f.respond(w, f.connectURL())
}

func (f *fakeJoin) respond(w http.ResponseWriter, connectURL string) {
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(protocol.JoinResponse{
		NodeID:           "node_1",
		Credential:       "nc_secret",
		ControlPublicKey: "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=",
		ConnectURL:       connectURL,
	})
}

func (f *fakeJoin) reject(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusBadRequest)
	w.Write([]byte(`{"error":{"code":"token_expired","message":"join token expired"}}`))
}

func testOptions(t *testing.T, cpURL string) Options {
	dir := t.TempDir()
	return Options{
		ControlPlaneURL: cpURL + "/",
		Token:           "njt_test",
		ConfigPath:      filepath.Join(dir, "agent.yaml"),
		DataDir:         filepath.Join(dir, "data"),
		AgentVersion:    "0.0.0-test",
		Facts: facts.Static{
			Hostname: "node-host",
			OS:       "ubuntu 24.04",
			Arch:     protocol.ArchARM64,
			Hardware: protocol.Hardware{CPUCores: 2, MemBytes: 1 << 30, DiskBytes: 10 << 30},
		},
	}
}

// snapshot captures every file a join may touch.
func snapshot(t *testing.T, opts Options) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	entries, _ := os.ReadDir(opts.DataDir)
	for _, e := range entries {
		data, err := os.ReadFile(filepath.Join(opts.DataDir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		out[e.Name()] = data
	}
	if data, err := os.ReadFile(opts.ConfigPath); err == nil {
		out["agent.yaml"] = data
	}
	return out
}

func assertUnchanged(t *testing.T, before, after map[string][]byte) {
	t.Helper()
	if len(before) != len(after) {
		t.Fatalf("files changed: before %d, after %d (%v)", len(before), len(after), keys(after))
	}
	for name, data := range before {
		if !bytes.Equal(after[name], data) {
			t.Errorf("%s changed", name)
		}
	}
}

func keys(m map[string][]byte) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestJoin(t *testing.T) {
	cp := newFakeJoin(t)
	opts := testOptions(t, cp.srv.URL)
	cfg, err := Join(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if cp.got.Name != "node-host" || cp.got.Token != "njt_test" || cp.got.Arch != protocol.ArchARM64 {
		t.Errorf("join request = %+v", cp.got)
	}

	saved, err := config.Load(opts.ConfigPath)
	if err != nil || saved != cfg || saved.NodeID != "node_1" {
		t.Fatalf("saved config = %+v, %v", saved, err)
	}
	if cred, err := config.ReadSecret(cfg.CredentialFile); err != nil || cred != "nc_secret" {
		t.Fatalf("credential = %q, %v", cred, err)
	}
	pemBytes, err := os.ReadFile(cfg.IdentityKeyFile)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(pemBytes)
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		t.Fatalf("identity key: %v", err)
	}
	if _, ok := key.(ed25519.PrivateKey); !ok {
		t.Fatalf("identity key has type %T", key)
	}
	enc, err := nodekey.LoadEncryptionKey(cfg.EncryptionKeyFile)
	if err != nil {
		t.Fatalf("encryption key: %v", err)
	}
	if want := base64.StdEncoding.EncodeToString(enc.PublicKey().Bytes()); cp.got.EncryptionPublicKey != want {
		t.Errorf("join sent encryption key %q, want %q", cp.got.EncryptionPublicKey, want)
	}
	if cp.got.EncryptionPublicKey == cp.got.PublicKey {
		t.Error("identity and encryption keys must differ")
	}
	if files := snapshot(t, opts); len(files) != 4 {
		t.Fatalf("expected two keys, credential and config only, got %v", keys(files))
	}

	if _, err := Join(context.Background(), opts); !errors.Is(err, ErrAlreadyJoined) {
		t.Fatalf("second join = %v, want ErrAlreadyJoined", err)
	}
}

func TestForcedRejoinResetsState(t *testing.T) {
	cp := newFakeJoin(t)
	opts := testOptions(t, cp.srv.URL)
	cfg, err := Join(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	oldKey, _ := os.ReadFile(cfg.IdentityKeyFile)
	if err := os.WriteFile(cfg.StateFile, []byte(`{"observed_generation":41}`), 0o600); err != nil {
		t.Fatal(err)
	}

	opts.Force = true
	next, err := Join(context.Background(), opts)
	if err != nil {
		t.Fatalf("forced re-join: %v", err)
	}
	newKey, _ := os.ReadFile(next.IdentityKeyFile)
	if bytes.Equal(oldKey, newKey) {
		t.Fatal("re-join kept the old identity key")
	}
	if _, err := os.Stat(next.StateFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("new registration did not start with fresh state: %v", err)
	}
	oldEnc, _ := os.ReadFile(cfg.EncryptionKeyFile)
	if newEnc, _ := os.ReadFile(next.EncryptionKeyFile); bytes.Equal(oldEnc, newEnc) {
		t.Fatal("re-join kept the old encryption key")
	}
	for _, old := range []string{cfg.IdentityKeyFile, cfg.EncryptionKeyFile, cfg.CredentialFile, cfg.StateFile} {
		if _, err := os.Stat(old); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("previous registration file %s survived: %v", old, err)
		}
	}
}

func TestFailedRejoinKeepsExistingNode(t *testing.T) {
	cp := newFakeJoin(t)
	opts := testOptions(t, cp.srv.URL)
	if _, err := Join(context.Background(), opts); err != nil {
		t.Fatal(err)
	}
	before := snapshot(t, opts)
	opts.Force = true

	t.Run("rejected", func(t *testing.T) {
		cp.handler = cp.reject
		if _, err := Join(context.Background(), opts); err == nil {
			t.Fatal("expected error")
		}
		assertUnchanged(t, before, snapshot(t, opts))
	})
	t.Run("connect_url on another host", func(t *testing.T) {
		cp.handler = func(w http.ResponseWriter, _ *http.Request) {
			cp.respond(w, "wss://attacker.example.com/v1/nodes/node_1/connect")
		}
		_, err := Join(context.Background(), opts)
		if err == nil || !strings.Contains(err.Error(), "points at") {
			t.Fatalf("got %v, want connect_url host mismatch", err)
		}
		assertUnchanged(t, before, snapshot(t, opts))
	})
}

func TestJoinRejectedErrorShape(t *testing.T) {
	cp := newFakeJoin(t)
	cp.handler = cp.reject
	opts := testOptions(t, cp.srv.URL)
	_, err := Join(context.Background(), opts)
	if err == nil || !strings.Contains(err.Error(), "token_expired") || !strings.Contains(err.Error(), "join token expired") {
		t.Fatalf("got %v", err)
	}
	if ok, _ := config.Exists(opts.ConfigPath); ok {
		t.Fatal("config written after rejected join")
	}
}

func TestJoinRefusesPlaintextRemote(t *testing.T) {
	opts := testOptions(t, "http://cp.example.com")
	_, err := Join(context.Background(), opts)
	if err == nil || !strings.Contains(err.Error(), "plaintext") {
		t.Fatalf("got %v, want plaintext rejection", err)
	}
}

func TestJoinDoesNotFollowRedirects(t *testing.T) {
	target := newFakeJoin(t)
	redirector := newFakeJoin(t)
	redirector.handler = func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.srv.URL+protocol.JoinPath, http.StatusTemporaryRedirect)
	}
	opts := testOptions(t, redirector.srv.URL)
	if _, err := Join(context.Background(), opts); err == nil {
		t.Fatal("expected redirect to fail the join")
	}
	if target.got.Token != "" {
		t.Fatal("join token was forwarded through a redirect")
	}
}

func TestJoinRefusesUnreadableConfigWithoutForce(t *testing.T) {
	cp := newFakeJoin(t)
	opts := testOptions(t, cp.srv.URL)
	if err := os.WriteFile(opts.ConfigPath, []byte("node_id: [unterminated\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Join(context.Background(), opts); err == nil || !strings.Contains(err.Error(), "unreadable") {
		t.Fatalf("got %v, want refusal", err)
	}
	if cp.got.Token != "" {
		t.Fatal("join request sent despite unreadable config")
	}
	opts.Force = true
	if _, err := Join(context.Background(), opts); err != nil {
		t.Fatalf("forced join over unreadable config: %v", err)
	}
}

func TestJoinNameLengthCountsCharacters(t *testing.T) {
	cp := newFakeJoin(t)
	opts := testOptions(t, cp.srv.URL)
	opts.Name = strings.Repeat("ü", 63)
	if _, err := Join(context.Background(), opts); err != nil {
		t.Fatalf("63-character name rejected: %v", err)
	}
	opts = testOptions(t, cp.srv.URL)
	opts.Name = strings.Repeat("ü", 64)
	if _, err := Join(context.Background(), opts); err == nil {
		t.Fatal("64-character name accepted")
	}
}

func TestJoinAsBuilder(t *testing.T) {
	cp := newFakeJoin(t)
	opts := testOptions(t, cp.srv.URL)
	opts.Builder = true
	opts.Insecure = true
	cfg, err := Join(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if !cp.got.Capabilities.Builder {
		t.Fatal("join request did not advertise capabilities.builder")
	}
	saved, err := config.Load(opts.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Builder || !saved.Builder || saved.DataDir != opts.DataDir || saved.RuntimeDir() != opts.DataDir {
		t.Fatalf("saved config %+v", saved)
	}
}
