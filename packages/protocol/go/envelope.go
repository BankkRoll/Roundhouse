package protocol

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
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
	var env Envelope
	if err := decodeStrict(data, &env, false); err != nil {
		return Envelope{}, fmt.Errorf("%w: envelope: %v", ErrMalformed, err)
	}
	return env, nil
}

// VerifyEnvelope authenticates env against the pinned control-plane key and
// returns the decoded payload, mirroring the TypeScript verifyEnvelope.
//
// Checks run in this order: envelope version, signature over the raw payload
// bytes, payload schema, self-announced signing kid, target node, expiry. The
// payload is not parsed until the signature has been verified.
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
	// SECURITY: a key can't vouch for itself as its own successor (ADR 0014
	// §13), so such an announcement is malformed rather than a no-op.
	if AnnouncesSigningKID(env.KID, msg) {
		return nil, fmt.Errorf("%w: frame announces its own signing kid %q", ErrMalformed, env.KID)
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
// [*Welcome], [*DesiredState], [*BuildJob] or [*BuildCancel].
//
// Like the zod schemas it mirrors, unknown fields are ignored so that the
// control plane can add optional fields without breaking older agents, but
// every required field must be present with a valid value, at every level of
// nesting. Keys that match a known field only case-insensitively are
// rejected; see [checkShape].
func DecodeControlMessage(data []byte) (ControlMessage, error) {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return nil, err
	}
	var msg interface {
		ControlMessage
		Validator
	}
	switch probe.Type {
	case TypeWelcome:
		msg = &Welcome{}
	case TypeDesiredState:
		msg = &DesiredState{}
	case TypeBuildJob:
		msg = &BuildJob{}
	case TypeBuildCancel:
		msg = &BuildCancel{}
	case TypeKeyAnnounce:
		msg = &KeyAnnounce{}
	case TypeVolumeDelete:
		msg = &VolumeDelete{}
	case TypeBackupJob:
		msg = &BackupJob{}
	case TypeBackupParts:
		msg = &BackupParts{}
	case TypeRestoreJob:
		msg = &RestoreJob{}
	case TypeVolumeCopyOut:
		msg = &VolumeCopyOut{}
	case TypeVolumeCopyIn:
		msg = &VolumeCopyIn{}
	case TypeDBQuery:
		msg = &DBQuery{}
	case TypeJobRun:
		msg = &JobRun{}
	case TypeJobCancel:
		msg = &JobCancel{}
	case TypeCertSync:
		msg = &CertSync{}
	default:
		return nil, fmt.Errorf("unknown control message type %q", probe.Type)
	}
	if err := decodeStrict(data, msg, false); err != nil {
		return nil, err
	}
	if err := msg.Validate(); err != nil {
		return nil, err
	}
	return msg, nil
}

// DecodeAgentMessage parses and validates an agent → control frame,
// returning a [*Hello], [*Heartbeat], [*WorkloadStatus], [*Logs] or
// [*BuildResult]. Unknown fields are rejected, matching what the control
// plane accepts, as are case-variant keys and missing required fields.
func DecodeAgentMessage(data []byte) (AgentMessage, error) {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return nil, err
	}
	var msg interface {
		AgentMessage
		Validator
	}
	switch probe.Type {
	case TypeHello:
		msg = &Hello{}
	case TypeHeartbeat:
		msg = &Heartbeat{}
	case TypeWorkloadStatus:
		msg = &WorkloadStatus{}
	case TypeLogs:
		msg = &Logs{}
	case TypeBuildResult:
		msg = &BuildResult{}
	case TypeMeshStatus:
		msg = &MeshStatus{}
	case TypeMeshKey:
		msg = &MeshKey{}
	case TypeVolumeStatus:
		msg = &VolumeStatus{}
	case TypeBackupPartsRequest:
		msg = &BackupPartsRequest{}
	case TypeBackupProgress:
		msg = &BackupProgress{}
	case TypeBackupResult:
		msg = &BackupResult{}
	case TypeRestoreResult:
		msg = &RestoreResult{}
	case TypeDBQueryResult:
		msg = &DBQueryResult{}
	case TypeJobStatus:
		msg = &JobStatus{}
	case TypeMetrics:
		msg = &Metrics{}
	case TypeCertAck:
		msg = &CertAck{}
	case TypeCertRequest:
		msg = &CertRequest{}
	case TypeCertStatus:
		msg = &CertStatus{}
	default:
		return nil, fmt.Errorf("unknown agent message type %q", probe.Type)
	}
	if err := decodeStrict(data, msg, true); err != nil {
		return nil, err
	}
	if err := msg.Validate(); err != nil {
		return nil, err
	}
	return msg, nil
}
