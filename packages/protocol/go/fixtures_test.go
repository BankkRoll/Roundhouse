package protocol

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "fixtures", name))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return data
}

// TestFixturesRoundTrip is the Go half of the cross-language drift guard: the
// TypeScript suite parses the same files with the zod schemas.
func TestFixturesRoundTrip(t *testing.T) {
	cases := []struct {
		file string
		into any
	}{
		{"hello.json", &Hello{}},
		{"heartbeat.json", &Heartbeat{}},
		{"join-request.json", &JoinRequest{}},
		{"join-response.json", &JoinResponse{}},
	}
	for _, tc := range cases {
		t.Run(tc.file, func(t *testing.T) {
			data := readFixture(t, tc.file)
			dec := json.NewDecoder(bytes.NewReader(data))
			dec.DisallowUnknownFields()
			if err := dec.Decode(tc.into); err != nil {
				t.Fatalf("decode: %v", err)
			}
			out, err := json.Marshal(tc.into)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			var want, got any
			if err := json.Unmarshal(data, &want); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(out, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(want, got) {
				t.Errorf("round trip mismatch\nwant: %s\ngot:  %s", data, out)
			}
		})
	}
}

func TestDecodeAgentMessageFixtures(t *testing.T) {
	if m, err := DecodeAgentMessage(readFixture(t, "hello.json")); err != nil {
		t.Fatal(err)
	} else if _, ok := m.(*Hello); !ok {
		t.Fatalf("got %T, want *Hello", m)
	}
	if m, err := DecodeAgentMessage(readFixture(t, "heartbeat.json")); err != nil {
		t.Fatal(err)
	} else if _, ok := m.(*Heartbeat); !ok {
		t.Fatalf("got %T, want *Heartbeat", m)
	}
	if _, err := DecodeAgentMessage([]byte(`{"type":"heartbeat","seq":1,"extra":true}`)); err == nil {
		t.Fatal("expected unknown field to be rejected")
	}
}

type signedFixture struct {
	PublicKey string          `json:"public_key"`
	NodeID    string          `json:"node_id"`
	Envelope  json.RawMessage `json:"envelope"`
}

func TestVerifySignedFixture(t *testing.T) {
	var f signedFixture
	if err := json.Unmarshal(readFixture(t, "signed-envelope.json"), &f); err != nil {
		t.Fatal(err)
	}
	env, err := ParseEnvelope(f.Envelope)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := ParsePublicKey(f.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_700_000_000_000)

	msg, err := VerifyEnvelope(env, pub, f.NodeID, now)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	want := &DesiredState{
		Type: TypeDesiredState,
		ControlHeader: ControlHeader{
			ID:        "msg_fixture",
			NodeID:    "node_fixture",
			IssuedAt:  1700000000000,
			ExpiresAt: 4102444800000,
		},
		Generation: 7,
		Workloads:  []Workload{{ID: "wl_1", Image: "nginx:1.27"}},
	}
	if !reflect.DeepEqual(msg, want) {
		t.Errorf("got %+v, want %+v", msg, want)
	}

	t.Run("tampered", func(t *testing.T) {
		bad := env
		bad.Payload = strings.Replace(env.Payload, `"generation":7`, `"generation":8`, 1)
		if bad.Payload == env.Payload {
			t.Fatal("fixture payload changed shape")
		}
		assertRejected(t, bad, pub, f.NodeID, now, ErrBadSignature)
	})
	t.Run("garbage signature", func(t *testing.T) {
		bad := env
		bad.Sig = "not base64!"
		assertRejected(t, bad, pub, f.NodeID, now, ErrBadSignature)
	})
	t.Run("wrong node", func(t *testing.T) {
		assertRejected(t, env, pub, "node_other", now, ErrWrongNode)
	})
	t.Run("expired", func(t *testing.T) {
		assertRejected(t, env, pub, f.NodeID, time.UnixMilli(4102444800001), ErrExpired)
	})
	t.Run("unsupported version", func(t *testing.T) {
		bad := env
		bad.V = 2
		assertRejected(t, bad, pub, f.NodeID, now, ErrMalformed)
	})
}

func assertRejected(t *testing.T, env Envelope, pub ed25519.PublicKey, nodeID string, now time.Time, want Rejection) {
	t.Helper()
	msg, err := VerifyEnvelope(env, pub, nodeID, now)
	if msg != nil {
		t.Fatalf("expected rejection, got %+v", msg)
	}
	got, ok := RejectionOf(err)
	if !ok || got != want {
		t.Fatalf("got error %v, want %s", err, want)
	}
}
