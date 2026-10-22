package protocol

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// EnvelopeVersion is the only envelope format version this package accepts.
const EnvelopeVersion = 1

// Envelope is the signed wrapper around every control → agent frame.
//
// The payload travels as a JSON string and the signature covers its exact
// UTF-8 bytes, so neither side needs canonical JSON: the agent verifies the
// bytes it received, then parses them.
type Envelope struct {
	V int `json:"v"`
	// KID identifies the signing key so the control plane can rotate keys.
	KID     string `json:"kid"`
	Payload string `json:"payload"`
	// Sig is the standard-base64 Ed25519 signature over Payload.
	Sig string `json:"sig"`
}

// Rejection is the reason [VerifyEnvelope] refused an envelope. Its values
// match the TypeScript EnvelopeRejection union, and errors returned by
// [VerifyEnvelope] wrap one of the Err* constants so callers can use
// [errors.Is].
type Rejection string

// Error implements error.
func (r Rejection) Error() string { return string(r) }

// Envelope rejection reasons.
const (
	ErrBadSignature Rejection = "bad_signature"
	ErrMalformed    Rejection = "malformed"
	ErrExpired      Rejection = "expired"
	ErrWrongNode    Rejection = "wrong_node"
)

// ErrInvalidPublicKey is returned when the pinned control-plane key is not a
// 32-byte Ed25519 public key. It indicates local misconfiguration rather than
// a bad frame.
var ErrInvalidPublicKey = errors.New("protocol: invalid ed25519 public key")

// RejectionOf extracts the [Rejection] wrapped by err, if any.
func RejectionOf(err error) (Rejection, bool) {
	var r Rejection
	ok := errors.As(err, &r)
	return r, ok
}

// ParsePublicKey decodes a standard-base64 raw Ed25519 public key.
func ParsePublicKey(b64 string) (ed25519.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, ErrInvalidPublicKey
	}
	return ed25519.PublicKey(raw), nil
}

// ParseEnvelope decodes an envelope frame off the wire. Errors wrap
// [ErrMalformed].
func ParseEnvelope(data []byte) (Envelope, error) {
	if err := requireKeys(data, "v", "kid", "payload", "sig"); err != nil {
		return Envelope{}, fmt.Errorf("%w: envelope: %v", ErrMalformed, err)
	}
	var env Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return Envelope{}, fmt.Errorf("%w: envelope: %v", ErrMalformed, err)
	}
	return env, nil
}

// VerifyEnvelope authenticates env against the pinned control-plane key and
// returns the decoded payload, mirroring the TypeScript verifyEnvelope.
//
// Checks run in this order: envelope version, signature over the raw payload
// bytes, payload schema, target node, expiry. The payload is not parsed until
// the signature has been verified.
//
// Returned errors wrap one of [ErrBadSignature], [ErrMalformed], [ErrExpired]
// or [ErrWrongNode], or are [ErrInvalidPublicKey].
func VerifyEnvelope(env Envelope, pub ed25519.PublicKey, nodeID string, now time.Time) (ControlMessage, error) {
	if len(pub) != ed25519.PublicKeySize {
		return nil, ErrInvalidPublicKey
	}
	if env.V != EnvelopeVersion {
		return nil, fmt.Errorf("%w: unsupported envelope version %d", ErrMalformed, env.V)
	}
	sig, err := base64.StdEncoding.DecodeString(env.Sig)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, ErrBadSignature
	}
	// SECURITY: verification must cover the exact received bytes; the payload
	// is only interpreted after this succeeds.
	if !ed25519.Verify(pub, []byte(env.Payload), sig) {
		return nil, ErrBadSignature
	}

	msg, err := DecodeControlMessage([]byte(env.Payload))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	h := msg.Header()
	if h.NodeID != nodeID {
		return nil, ErrWrongNode
	}
	if h.ExpiresAt < now.UnixMilli() {
		return nil, ErrExpired
	}
	return msg, nil
}

// SignEnvelope serialises and signs msg. The agent never signs; this exists
// for tests and fake control planes.
func SignEnvelope(msg ControlMessage, priv ed25519.PrivateKey, kid string) (Envelope, error) {
	payload, err := json.Marshal(msg)
	if err != nil {
		return Envelope{}, err
	}
	return Envelope{
		V:       EnvelopeVersion,
		KID:     kid,
		Payload: string(payload),
		Sig:     base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload)),
	}, nil
}

// DecodeControlMessage parses and validates a control payload, returning a
// [*Welcome] or [*DesiredState].
//
// Like the zod schemas it mirrors, unknown fields are ignored so that the
// control plane can add optional fields without breaking older agents, but
// every known field must be present with a valid value. Keys that match a known field
// only case-insensitively are rejected; see [requireKeys].
func DecodeControlMessage(data []byte) (ControlMessage, error) {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return nil, err
	}
	header := []string{"type", "id", "node_id", "iat", "exp"}
	switch probe.Type {
	case TypeWelcome:
		var m Welcome
		if err := strictDecode(data, &m, append(header, "heartbeat_interval_ms")...); err != nil {
			return nil, err
		}
		if err := m.ControlHeader.validate(); err != nil {
			return nil, err
		}
		if m.HeartbeatIntervalMS <= 0 {
			return nil, errors.New("heartbeat_interval_ms must be positive")
		}
		return &m, nil
	case TypeDesiredState:
		var m DesiredState
		if err := strictDecode(data, &m, append(header, "generation", "workloads")...); err != nil {
			return nil, err
		}
		if err := m.ControlHeader.validate(); err != nil {
			return nil, err
		}
		if m.Generation < 0 {
			return nil, errors.New("generation must be non-negative")
		}
		var raw struct {
			Workloads []json.RawMessage `json:"workloads"`
		}
		if err := json.Unmarshal(data, &raw); err != nil {
			return nil, err
		}
		for i, w := range raw.Workloads {
			if err := requireKeys(w, "id", "image"); err != nil {
				return nil, fmt.Errorf("workloads[%d]: %w", i, err)
			}
		}
		return &m, nil
	default:
		return nil, fmt.Errorf("unknown control message type %q", probe.Type)
	}
}

// DecodeAgentMessage parses an agent → control frame, returning a [*Hello] or
// [*Heartbeat]. Unknown fields are rejected, matching what the control plane
// accepts.
func DecodeAgentMessage(data []byte) (AgentMessage, error) {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return nil, err
	}
	var msg AgentMessage
	switch probe.Type {
	case TypeHello:
		msg = &Hello{}
	case TypeHeartbeat:
		msg = &Heartbeat{}
	default:
		return nil, fmt.Errorf("unknown agent message type %q", probe.Type)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(msg); err != nil {
		return nil, err
	}
	return msg, nil
}

func (h ControlHeader) validate() error {
	if h.IssuedAt < 0 || h.ExpiresAt < 0 {
		return errors.New("iat and exp must be non-negative")
	}
	return nil
}

// strictDecode unmarshals data into v after checking that every key in
// required is present and non-null, since encoding/json silently zero-fills
// missing fields.
func strictDecode(data []byte, v any, required ...string) error {
	if err := requireKeys(data, required...); err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func requireKeys(data []byte, keys ...string) error {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil {
		return err
	}
	if obj == nil {
		return errors.New("expected a JSON object")
	}
	for _, k := range keys {
		v, ok := obj[k]
		if !ok || bytes.Equal(v, []byte("null")) {
			return fmt.Errorf("missing field %q", k)
		}
	}
	// SECURITY: encoding/json matches object keys case-insensitively while
	// JavaScript does not, so {"node_id":"a","NODE_ID":"b"} would mean
	// different things to the signer and to this verifier. Reject any key
	// that differs from a known field only by case.
	for got := range obj {
		for _, k := range keys {
			if got != k && strings.EqualFold(got, k) {
				return fmt.Errorf("field %q differs from %q only by case", got, k)
			}
		}
	}
	return nil
}
