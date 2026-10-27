package protocol

import (
	"crypto/ecdh"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// ImagePushProtocolVersion gates [ImagePush] and [ImagePushResult]
// (ADR 0011). Mirrors IMAGE_PUSH_PROTOCOL_VERSION.
const ImagePushProtocolVersion = 7

// Image push limits, mirroring limits.ts.
const (
	// MinImagePushTimeoutS is the shortest [ImagePush].TimeoutS.
	MinImagePushTimeoutS = 60
	// MaxImagePushTimeoutS is the longest [ImagePush].TimeoutS.
	MaxImagePushTimeoutS = 3600
)

// Image push frame types.
const (
	TypeImagePush       = "image_push"
	TypeImagePushResult = "image_push_result"
)

// ImagePushPlatformAMD64 is the only platform a push selects today.
const ImagePushPlatformAMD64 = "linux/amd64"

var (
	pinnedDigestSuffixRE = regexp.MustCompile(`@sha256:[a-f0-9]{64}$`)
	remoteHostRE         = regexp.MustCompile(`^[^/]+[.:][^/]*/`)
	trailingTagRE        = regexp.MustCompile(`:[^/:]+$`)
)

// maxPushReference is the longest source or target reference.
const maxPushReference = 512

// ImagePush copies one image from the builder's local registry to another
// registry (ADR 0011). Always credential-bearing: the target's login is
// sealed to the node. Type must be [TypeImagePush].
type ImagePush struct {
	Type string `json:"type"`
	ControlHeader
	PushID string `json:"push_id"`
	// Source is pinned by digest in the local registry at [RegistryListen].
	Source string `json:"source"`
	// Target names a registry host and a tag, without a digest.
	Target   string `json:"target"`
	Platform string `json:"platform"`
	// CredentialSealed opens with [OpenImagePushCredential].
	CredentialSealed SealedBox `json:"credential_sealed"`
	TimeoutS         int       `json:"timeout_s"`
}

func (*ImagePush) controlMessage() {}

// Validate implements [Validator].
func (m *ImagePush) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if !idRE.MatchString(m.PushID) {
		return errors.New("push_id: invalid")
	}
	if len(m.Source) > maxPushReference || !imageReferenceRE.MatchString(m.Source) ||
		!strings.HasPrefix(m.Source, RegistryListen+"/") || !pinnedDigestSuffixRE.MatchString(m.Source) {
		return fmt.Errorf("source: must be pinned by digest in the local registry at %s", RegistryListen)
	}
	if len(m.Target) > maxPushReference || !imageReferenceRE.MatchString(m.Target) ||
		!remoteHostRE.MatchString(m.Target) || strings.Contains(m.Target, "@") || !trailingTagRE.MatchString(m.Target) {
		return errors.New("target: must name a registry host and a tag, without a digest")
	}
	if strings.HasPrefix(m.Target, RegistryListen+"/") {
		return errors.New("target: must not be the local registry")
	}
	if m.Platform != ImagePushPlatformAMD64 {
		return fmt.Errorf("platform: invalid %q", m.Platform)
	}
	if err := m.CredentialSealed.validate(); err != nil {
		return fmt.Errorf("credential_sealed: %w", err)
	}
	if m.TimeoutS < MinImagePushTimeoutS || m.TimeoutS > MaxImagePushTimeoutS {
		return errors.New("timeout_s: out of range")
	}
	return validateShortLived(m)
}

// ImagePushResult answers an [ImagePush]. Type must be [TypeImagePushResult].
type ImagePushResult struct {
	Type   string `json:"type"`
	PushID string `json:"push_id"`
	OK     bool   `json:"ok"`
	// Digest is the pushed manifest's digest, set exactly when OK.
	Digest string `json:"digest,omitempty"`
	// Bytes counts the blob bytes uploaded (layers the target lacked).
	Bytes *int64 `json:"bytes,omitempty"`
	// Error says why the push failed; it never contains the credential.
	Error string `json:"error,omitempty"`
}

func (*ImagePushResult) agentMessage() {}

// Validate implements [Validator].
func (m *ImagePushResult) Validate() error {
	if !idRE.MatchString(m.PushID) {
		return errors.New("push_id: invalid")
	}
	if m.Digest != "" && !digestRE.MatchString(m.Digest) {
		return errors.New("digest: expected a sha256 digest")
	}
	if m.Bytes != nil && *m.Bytes < 0 {
		return errors.New("bytes: negative")
	}
	if len(m.Error) > MaxMessageBytes {
		return errors.New("error: too long")
	}
	if m.OK && (m.Digest == "" || m.Error != "") || !m.OK && m.Error == "" {
		return errors.New("ok: a successful push has a digest and no error; a failed one has an error")
	}
	return nil
}

// ImagePushAAD binds a push's sealed credential to its node and push.
func ImagePushAAD(nodeID, pushID string) string {
	return BoxInfo(BoxPurposeImagePush) + ":" + nodeID + ":" + pushID
}

// SealedImagePushCredential is the plaintext of [ImagePush].CredentialSealed.
type SealedImagePushCredential struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// OpenImagePushCredential opens a push's registry login.
func OpenImagePushCredential(priv *ecdh.PrivateKey, nodeID string, m *ImagePush) (SealedImagePushCredential, error) {
	var s SealedImagePushCredential
	if err := openStrict(priv, &m.CredentialSealed, BoxPurposeImagePush, ImagePushAAD(nodeID, m.PushID), &s); err != nil {
		return SealedImagePushCredential{}, fmt.Errorf("image push %s: %w", m.PushID, err)
	}
	if s.Username == "" || len(s.Username) > 256 || s.Password == "" || len(s.Password) > 4096 {
		return SealedImagePushCredential{}, fmt.Errorf("image push %s: invalid credential", m.PushID)
	}
	return s, nil
}
