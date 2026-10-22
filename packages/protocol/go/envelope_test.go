package protocol

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"testing"
	"time"
)

func newKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func welcome() *Welcome {
	return &Welcome{
		Type:                TypeWelcome,
		ControlHeader:       ControlHeader{ID: "m1", NodeID: "node_a", IssuedAt: 1000, ExpiresAt: 2000},
		HeartbeatIntervalMS: 10_000,
	}
}

func signRaw(priv ed25519.PrivateKey, payload string) Envelope {
	sig := ed25519.Sign(priv, []byte(payload))
	return Envelope{V: 1, KID: "k1", Payload: payload, Sig: base64.StdEncoding.EncodeToString(sig)}
}

func TestSignVerifyRoundTrip(t *testing.T) {
	pub, priv := newKey(t)
	env, err := SignEnvelope(welcome(), priv, "k1")
	if err != nil {
		t.Fatal(err)
	}
	msg, err := VerifyEnvelope(env, pub, "node_a", time.UnixMilli(1500))
	if err != nil {
		t.Fatal(err)
	}
	w, ok := msg.(*Welcome)
	if !ok || *w != *welcome() {
		t.Fatalf("got %#v", msg)
	}
}

func TestVerifyRejectsOtherKey(t *testing.T) {
	_, priv := newKey(t)
	otherPub, _ := newKey(t)
	env, err := SignEnvelope(welcome(), priv, "k1")
	if err != nil {
		t.Fatal(err)
	}
	assertRejected(t, env, otherPub, "node_a", time.UnixMilli(1500), ErrBadSignature)
}

func TestVerifyRejectsMalformedPayloads(t *testing.T) {
	pub, priv := newKey(t)
	payloads := map[string]string{
		"not json":          `{`,
		"array":             `[]`,
		"unknown type":      `{"type":"reboot","id":"m","node_id":"node_a","iat":1,"exp":2000}`,
		"missing field":     `{"type":"welcome","id":"m","node_id":"node_a","iat":1,"exp":2000}`,
		"null field":        `{"type":"welcome","id":"m","node_id":"node_a","iat":1,"exp":2000,"heartbeat_interval_ms":null}`,
		"zero interval":     `{"type":"welcome","id":"m","node_id":"node_a","iat":1,"exp":2000,"heartbeat_interval_ms":0}`,
		"fractional int":    `{"type":"welcome","id":"m","node_id":"node_a","iat":1.5,"exp":2000,"heartbeat_interval_ms":5}`,
		"negative gen":      `{"type":"desired_state","id":"m","node_id":"node_a","iat":1,"exp":2000,"generation":-1,"workloads":[]}`,
		"workload missing":  `{"type":"desired_state","id":"m","node_id":"node_a","iat":1,"exp":2000,"generation":1,"workloads":[{"id":"w"}]}`,
		"case-variant key":  `{"type":"desired_state","id":"m","node_id":"node_a","NODE_ID":"node_b","iat":1,"exp":2000,"generation":1,"workloads":[]}`,
		"case-variant item": `{"type":"desired_state","id":"m","node_id":"node_a","iat":1,"exp":2000,"generation":1,"workloads":[{"id":"w","image":"a","Image":"b"}]}`,
	}
	for name, p := range payloads {
		t.Run(name, func(t *testing.T) {
			assertRejected(t, signRaw(priv, p), pub, "node_a", time.UnixMilli(1500), ErrMalformed)
		})
	}
}

func TestVerifyAcceptsUnknownPayloadFields(t *testing.T) {
	pub, priv := newKey(t)
	p := `{"type":"welcome","id":"m","node_id":"node_a","iat":1,"exp":2000,"heartbeat_interval_ms":5,"future":true}`
	if _, err := VerifyEnvelope(signRaw(priv, p), pub, "node_a", time.UnixMilli(1500)); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyInvalidPublicKey(t *testing.T) {
	if _, err := VerifyEnvelope(Envelope{V: 1}, ed25519.PublicKey{1, 2, 3}, "n", time.Now()); !errors.Is(err, ErrInvalidPublicKey) {
		t.Fatalf("got %v", err)
	}
	if _, err := ParsePublicKey("AAAA"); !errors.Is(err, ErrInvalidPublicKey) {
		t.Fatalf("got %v", err)
	}
}

func TestParseEnvelope(t *testing.T) {
	for _, in := range []string{
		`{"v":1,"kid":"k","payload":"{}"}`,
		`{"v":1,"kid":"k","payload":7,"sig":"x"}`,
		`null`,
	} {
		if _, err := ParseEnvelope([]byte(in)); !errors.Is(err, ErrMalformed) {
			t.Errorf("%s: got %v", in, err)
		}
	}
}
