package protocol

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"
)

type boxFixture struct {
	NodeID                 string `json:"node_id"`
	NodePrivateKeyHex      string `json:"node_private_key_hex"`
	NodePublicKey          string `json:"node_public_key"`
	NodeKID                string `json:"node_kid"`
	EphemeralPrivateKeyHex string `json:"ephemeral_private_key_hex"`
	X25519SharedHex        string `json:"x25519_shared_hex"`
	Cases                  []struct {
		Name      string     `json:"name"`
		Purpose   BoxPurpose `json:"purpose"`
		AAD       string     `json:"aad"`
		Plaintext string     `json:"plaintext"`
		Box       SealedBox  `json:"box"`
	} `json:"cases"`
}

func loadBoxFixture(t *testing.T) (boxFixture, *ecdh.PrivateKey, *ecdh.PrivateKey) {
	t.Helper()
	var f boxFixture
	if err := json.Unmarshal(readFixture(t, "sealed-box.json"), &f); err != nil {
		t.Fatal(err)
	}
	key := func(h string) *ecdh.PrivateKey {
		raw, err := hex.DecodeString(h)
		if err != nil {
			t.Fatal(err)
		}
		k, err := ecdh.X25519().NewPrivateKey(raw)
		if err != nil {
			t.Fatal(err)
		}
		return k
	}
	return f, key(f.NodePrivateKeyHex), key(f.EphemeralPrivateKeyHex)
}

// TestSealedBoxVectors is the Go half of the box interop check: the
// TypeScript suite opens and re-seals the same vectors.
func TestSealedBoxVectors(t *testing.T) {
	f, node, eph := loadBoxFixture(t)
	if got := base64.StdEncoding.EncodeToString(node.PublicKey().Bytes()); got != f.NodePublicKey {
		t.Fatalf("public key %s, want %s", got, f.NodePublicKey)
	}
	if got := NodeEncryptionKeyID(node.PublicKey().Bytes()); got != f.NodeKID {
		t.Fatalf("kid %s, want %s", got, f.NodeKID)
	}
	shared, err := eph.ECDH(node.PublicKey())
	if err != nil || hex.EncodeToString(shared) != f.X25519SharedHex {
		t.Fatalf("shared secret %x does not match RFC 7748", shared)
	}
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			pt, err := OpenBox(node, &c.Box, c.Purpose, c.AAD)
			if err != nil {
				t.Fatal(err)
			}
			if string(pt) != c.Plaintext {
				t.Errorf("plaintext %q, want %q", pt, c.Plaintext)
			}
			again, err := sealBoxWith(eph, node.PublicKey(), []byte(c.Plaintext), c.Purpose, c.AAD)
			if err != nil {
				t.Fatal(err)
			}
			if *again != c.Box {
				t.Errorf("re-sealed %+v, want %+v", *again, c.Box)
			}
		})
	}
}

func TestOpenBoxRejects(t *testing.T) {
	f, node, _ := loadBoxFixture(t)
	c := f.Cases[0]
	other, _ := ecdh.X25519().GenerateKey(rand.Reader)
	cases := map[string]func() error{
		"other aad": func() error {
			_, err := OpenBox(node, &c.Box, c.Purpose, c.AAD+"x")
			return err
		},
		"other purpose": func() error {
			_, err := OpenBox(node, &c.Box, BoxPurposeBuildSecrets, c.AAD)
			return err
		},
		"tampered ct": func() error {
			b := c.Box
			raw, _ := base64.StdEncoding.DecodeString(b.CT)
			raw[0] ^= 1
			b.CT = base64.StdEncoding.EncodeToString(raw)
			_, err := OpenBox(node, &b, c.Purpose, c.AAD)
			return err
		},
		"swapped epk": func() error {
			b := c.Box
			b.EPK = f.NodePublicKey
			_, err := OpenBox(node, &b, c.Purpose, c.AAD)
			return err
		},
		"nil box": func() error {
			_, err := OpenBox(node, nil, c.Purpose, c.AAD)
			return err
		},
		"bad version": func() error {
			b := c.Box
			b.V = 2
			_, err := OpenBox(node, &b, c.Purpose, c.AAD)
			return err
		},
	}
	for name, run := range cases {
		t.Run(name, func(t *testing.T) {
			if run() == nil {
				t.Fatal("expected an error")
			}
		})
	}
	if _, err := OpenBox(other, &c.Box, c.Purpose, c.AAD); !errors.Is(err, ErrBoxWrongKey) {
		t.Fatalf("got %v, want ErrBoxWrongKey", err)
	}
}

func TestSealBoxRoundTrip(t *testing.T) {
	node, _ := ecdh.X25519().GenerateKey(rand.Reader)
	aad := WorkloadEnvAAD("node_1", "wl_1", 9)
	a, err := SealBox(node.PublicKey(), []byte("v"), BoxPurposeWorkloadEnv, aad)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := SealBox(node.PublicKey(), []byte("v"), BoxPurposeWorkloadEnv, aad)
	if a.EPK == b.EPK {
		t.Fatal("ephemeral key reused")
	}
	pt, err := OpenBox(node, a, BoxPurposeWorkloadEnv, aad)
	if err != nil || string(pt) != "v" {
		t.Fatalf("got %q, %v", pt, err)
	}
}

func TestOpenWorkloadEnv(t *testing.T) {
	node, _ := ecdh.X25519().GenerateKey(rand.Reader)
	seal := func(plaintext string, generation int64) *SealedBox {
		b, err := SealBox(node.PublicKey(), []byte(plaintext), BoxPurposeWorkloadEnv, WorkloadEnvAAD("node_1", "wl_1", generation))
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	w := validSpec()
	w.EnvSealed = seal(`{"env":{"PORT":"80"},"files":{"KEY":"s3cret"}}`, 4)
	if err := OpenWorkloadEnv(node, "node_1", 4, &w); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(w.Env, map[string]string{"PORT": "80"}) ||
		!reflect.DeepEqual(w.SecretFiles, map[string]string{"KEY": "s3cret"}) {
		t.Fatalf("got env %v files %v", w.Env, w.SecretFiles)
	}
	if err := OpenWorkloadEnv(node, "node_1", 5, &w); err == nil {
		t.Error("opened with the wrong generation")
	}
	for name, pt := range map[string]string{
		"duplicate key": `{"env":{"A":"1"},"files":{"A":"2"}}`,
		"bad name":      `{"env":{"1A":"1"},"files":{}}`,
		"nul value":     `{"env":{"A":"\u0000"},"files":{}}`,
		"unknown field": `{"env":{},"files":{},"extra":1}`,
		"missing files": `{"env":{}}`,
		"not an object": `[]`,
	} {
		t.Run(name, func(t *testing.T) {
			w := validSpec()
			w.EnvSealed = seal(pt, 1)
			if err := OpenWorkloadEnv(node, "node_1", 1, &w); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestOpenBuildSecrets(t *testing.T) {
	node, _ := ecdh.X25519().GenerateKey(rand.Reader)
	j := validBuildJob()
	if s, err := OpenBuildSecrets(node, "node_a", j); err != nil || len(s) != 0 {
		t.Fatalf("no secrets: got %v, %v", s, err)
	}
	box, _ := SealBox(node.PublicKey(), []byte(`{"secrets":{"NPM_TOKEN":"t"}}`), BoxPurposeBuildSecrets, BuildSecretsAAD("node_a", j.BuildID))
	j.BuildSecretsSealed = box
	s, err := OpenBuildSecrets(node, "node_a", j)
	if err != nil || s["NPM_TOKEN"] != "t" {
		t.Fatalf("got %v, %v", s, err)
	}
	if _, err := OpenBuildSecrets(node, "node_b", j); err == nil {
		t.Error("opened for another node")
	}
}

// TestSignedDesiredStateOpens checks the generated frame's boxes open with
// the fixture node key at the frame's generation.
func TestSignedDesiredStateOpens(t *testing.T) {
	_, node, _ := loadBoxFixture(t)
	var f signedFixture
	if err := json.Unmarshal(readFixture(t, "signed-desired-state.json"), &f); err != nil {
		t.Fatal(err)
	}
	env, _ := ParseEnvelope(f.Envelope)
	pub, _ := ParsePublicKey(f.PublicKey)
	msg, err := VerifyEnvelope(env, pub, f.NodeID, time.UnixMilli(1_700_000_000_000))
	if err != nil {
		t.Fatal(err)
	}
	ds := msg.(*DesiredState)
	for i := range ds.Workloads {
		if err := OpenWorkloadEnv(node, f.NodeID, ds.Generation, &ds.Workloads[i]); err != nil {
			t.Fatal(err)
		}
	}
	if ds.Workloads[0].SecretFiles["STRIPE_KEY"] != "fixture-stripe-key" || ds.Workloads[0].Env["PORT"] != "3000" {
		t.Errorf("unexpected env %v / %v", ds.Workloads[0].Env, ds.Workloads[0].SecretFiles)
	}
}

func TestNodeEncryptionKeyFixture(t *testing.T) {
	var f struct {
		NodeID            string            `json:"node_id"`
		IdentityPublicKey string            `json:"identity_public_key"`
		EncryptionKey     NodeEncryptionKey `json:"encryption_key"`
	}
	if err := json.Unmarshal(readFixture(t, "encryption-key.json"), &f); err != nil {
		t.Fatal(err)
	}
	if err := f.EncryptionKey.validate(); err != nil {
		t.Fatal(err)
	}
	identity, _ := base64.StdEncoding.DecodeString(f.IdentityPublicKey)
	sig, _ := base64.StdEncoding.DecodeString(f.EncryptionKey.Sig)
	if !ed25519.Verify(identity, EncryptionKeySignaturePayload(f.NodeID, f.EncryptionKey.PublicKey), sig) {
		t.Fatal("fixture signature does not verify")
	}

	// RFC 8032 test key 1, the one gen-fixtures signs with.
	seed, _ := hex.DecodeString("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
	_, node, _ := loadBoxFixture(t)
	got := NewNodeEncryptionKey(ed25519.NewKeyFromSeed(seed), f.NodeID, node.PublicKey())
	if got != f.EncryptionKey {
		t.Errorf("got %+v, want %+v", got, f.EncryptionKey)
	}
}

func TestIsSafeGitRef(t *testing.T) {
	for _, r := range []string{"main", "refs/heads/main", "feature/x-1", "v1.2.3", "a_b", "release/2026.10"} {
		if !IsSafeGitRef(r) {
			t.Errorf("%q should be safe", r)
		}
	}
	for _, r := range []string{"", "-x", "--upload-pack=sh", "/main", "main/", "main.", "a..b", "a//b", ".hidden",
		"a/.b", "x.lock", "a.lock/b", "a b", "a~1", "a^", "a:b", "a@{1}", `a\b`, string(make([]byte, 256))} {
		if IsSafeGitRef(r) {
			t.Errorf("%q should be unsafe", r)
		}
	}
}

func TestNamingHelpers(t *testing.T) {
	if got := EnvironmentNetworkName("prj_1", "env_1"); got != "roundhouse-prj_1-env_1" {
		t.Errorf("network %q", got)
	}
	if got := PrivateServiceAlias("svc_01JAB"); got != "svc-01jab.roundhouse.internal" {
		t.Errorf("alias %q", got)
	}
	if got := BuildCacheKey("prj_1", "svc_1"); got != "prj_1.svc_1" {
		t.Errorf("cache key %q", got)
	}
	if !IsPrivateDomain("api.production.internal") || IsPrivateDomain("evil.example.com") || IsPrivateDomain("a.b.c.internal") {
		t.Error("IsPrivateDomain")
	}
}
