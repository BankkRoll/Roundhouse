package protocol

import (
	"encoding/base64"
	"errors"
	"fmt"
)

// SigningKeyAnnouncement is a successor control-plane signing key (ADR 0014
// §13), announced in [Welcome].NextKeys and [KeyAnnounce] under the current
// key. The agent pins it next to the current key and accepts frames signed
// by it from NotBefore on.
type SigningKeyAnnouncement struct {
	// KID is the [Envelope].KID frames signed by this key carry.
	KID string `json:"kid"`
	// PublicKey is standard base64 of the raw 32-byte Ed25519 key.
	PublicKey string `json:"public_key"`
	// NotBefore is unix seconds.
	NotBefore int64 `json:"not_before"`
}

// KeyAnnounce announces successor signing keys on a live connection. Not
// credential-bearing. Type must be [TypeKeyAnnounce].
type KeyAnnounce struct {
	Type string `json:"type"`
	ControlHeader
	Keys []SigningKeyAnnouncement `json:"keys"`
}

func (*KeyAnnounce) controlMessage() {}

func validateAnnouncements(keys []SigningKeyAnnouncement) error {
	if len(keys) > MaxNextSigningKeys {
		return fmt.Errorf("at most %d keys", MaxNextSigningKeys)
	}
	seen := map[string]bool{}
	for _, k := range keys {
		if !signingKeyIDRE.MatchString(k.KID) {
			return fmt.Errorf("invalid kid %q", k.KID)
		}
		if seen[k.KID] {
			return fmt.Errorf("duplicate kid %q", k.KID)
		}
		seen[k.KID] = true
		raw, err := base64.StdEncoding.DecodeString(k.PublicKey)
		if err != nil || len(raw) != 32 || !base64Key32RE.MatchString(k.PublicKey) {
			return fmt.Errorf("kid %s: public_key must be a base64 32-byte key", k.KID)
		}
		if k.NotBefore <= 0 {
			return fmt.Errorf("kid %s: not_before must be positive", k.KID)
		}
	}
	return nil
}

// Validate implements [Validator].
func (m *KeyAnnounce) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if len(m.Keys) == 0 {
		return errors.New("keys: at least one")
	}
	if err := validateAnnouncements(m.Keys); err != nil {
		return fmt.Errorf("keys: %w", err)
	}
	return nil
}

// AnnouncesSigningKID reports whether msg announces the key that signed it
// (envelopeKID) as a successor. [VerifyEnvelope] rejects such frames as
// malformed, since a key can't vouch for itself. Mirrors
// announcesSigningKid in TypeScript.
func AnnouncesSigningKID(envelopeKID string, msg ControlMessage) bool {
	var keys []SigningKeyAnnouncement
	switch m := msg.(type) {
	case *Welcome:
		keys = m.NextKeys
	case *KeyAnnounce:
		keys = m.Keys
	}
	for _, k := range keys {
		if k.KID == envelopeKID {
			return true
		}
	}
	return false
}
