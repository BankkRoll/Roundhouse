package conn

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"slices"
	"sync"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/atomicfile"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// NotBeforeGrace is how long before its not_before an announced key is
// already accepted. The control plane switches to it at not_before by its own
// clock; accepting a key the current one vouched for a little early is
// harmless, while rejecting frames over residual clock error would stall the
// node until the next frame.
const NotBeforeGrace = 5 * time.Minute

// keyFileVersion is the format of the file [KeyStore] persists.
const keyFileVersion = 1

// Errors returned by [KeyStore.SetNext].
var (
	// ErrAnnouncerNotPinned means the announcement was not signed by the
	// currently pinned key, so it can't extend trust.
	ErrAnnouncerNotPinned = errors.New("announcement not signed by the pinned control key")
	// ErrAnnouncesCurrent means an announcement names the pinned key itself.
	ErrAnnouncesCurrent = errors.New("announcement names the pinned control key")
	// ErrKeyConflict means an announcement binds an already pinned kid to a
	// different public key.
	ErrKeyConflict = errors.New("announcement changes the public key of a pinned kid")
)

// TrustedKey is one control-plane signing key the agent accepts.
type TrustedKey struct {
	// KID is the envelope kid the key signs under; empty only for the join
	// key before the first welcome pinned it.
	KID string
	// PublicKey is the raw Ed25519 key.
	PublicKey ed25519.PublicKey
	// NotBefore is when an announced successor becomes acceptable (less
	// [NotBeforeGrace]); zero for the current key.
	NotBefore time.Time
}

// KeyStore is the set of control-plane signing keys this node trusts (ADR
// 0014 §13): the current key and up to [protocol.MaxNextSigningKeys]
// successors announced under it.
//
// Trust only moves forward from a key already pinned:
//   - successors are recorded only from frames signed by the current key
//     ([KeyStore.SetNext]); a frame signed by anything else, or naming the
//     current key, changes nothing;
//   - a successor verifies frames once its not_before has (nearly) passed,
//     and the first frame it verifies makes it current and drops the old key
//     ([KeyStore.Verified]).
//
// Every change is written atomically to a 0600 JSON file, so a restart keeps
// the keys an announcement added and never revives a dropped one. Safe for
// concurrent use.
type KeyStore struct {
	mu   sync.Mutex
	path string
	// origin is the key the node joined with, standard base64. A file written
	// for another registration (a re-join) is ignored.
	origin  string
	current TrustedKey
	next    []TrustedKey
}

type keyFile struct {
	V       int         `json:"v"`
	Origin  string      `json:"origin"`
	Current storedKey   `json:"current"`
	Next    []storedKey `json:"next,omitempty"`
}

type storedKey struct {
	KID       string `json:"kid,omitempty"`
	PublicKey string `json:"public_key"`
	NotBefore int64  `json:"not_before,omitempty"`
}

// NewKeyStore returns an in-memory store trusting joinKey under joinKID
// (empty until a welcome pins it). Nothing is persisted.
func NewKeyStore(joinKey ed25519.PublicKey, joinKID string) *KeyStore {
	return &KeyStore{
		origin:  base64.StdEncoding.EncodeToString(joinKey),
		current: TrustedKey{KID: joinKID, PublicKey: slices.Clone(joinKey)},
	}
}

// OpenKeyStore loads the store persisted at path, or starts one from the join
// key and kid in the config when the file is missing or belongs to an earlier
// registration (its origin isn't joinKey). A corrupt file is an error rather
// than a silent fallback: falling back could resurrect a retired key.
func OpenKeyStore(path string, joinKey ed25519.PublicKey, joinKID string) (*KeyStore, error) {
	ks := NewKeyStore(joinKey, joinKID)
	ks.path = path
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return ks, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read control keys: %w", err)
	}
	var f keyFile
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("parse control keys %s: %w", path, err)
	}
	if f.V != keyFileVersion {
		return nil, fmt.Errorf("control keys %s: unsupported version %d", path, f.V)
	}
	if f.Origin != ks.origin {
		return ks, nil
	}
	cur, err := f.Current.parse(false)
	if err != nil {
		return nil, fmt.Errorf("control keys %s: current: %w", path, err)
	}
	if len(f.Next) > protocol.MaxNextSigningKeys {
		return nil, fmt.Errorf("control keys %s: more than %d successors", path, protocol.MaxNextSigningKeys)
	}
	next := make([]TrustedKey, 0, len(f.Next))
	for _, s := range f.Next {
		k, err := s.parse(true)
		if err != nil {
			return nil, fmt.Errorf("control keys %s: next: %w", path, err)
		}
		if k.KID == cur.KID || slices.ContainsFunc(next, func(n TrustedKey) bool { return n.KID == k.KID }) {
			return nil, fmt.Errorf("control keys %s: duplicate kid %q", path, k.KID)
		}
		next = append(next, k)
	}
	ks.current, ks.next = cur, next
	return ks, nil
}

func (s storedKey) parse(successor bool) (TrustedKey, error) {
	if (successor || s.KID != "") && !protocol.ValidSigningKeyID(s.KID) {
		return TrustedKey{}, fmt.Errorf("invalid kid %q", s.KID)
	}
	pub, err := protocol.ParsePublicKey(s.PublicKey)
	if err != nil {
		return TrustedKey{}, fmt.Errorf("kid %q: %w", s.KID, err)
	}
	k := TrustedKey{KID: s.KID, PublicKey: pub}
	if successor {
		if s.NotBefore <= 0 {
			return TrustedKey{}, fmt.Errorf("kid %q: not_before must be positive", s.KID)
		}
		k.NotBefore = time.Unix(s.NotBefore, 0)
	}
	return k, nil
}

func storedOf(k TrustedKey) storedKey {
	s := storedKey{KID: k.KID, PublicKey: base64.StdEncoding.EncodeToString(k.PublicKey)}
	if !k.NotBefore.IsZero() {
		s.NotBefore = k.NotBefore.Unix()
	}
	return s
}

// persist writes the store; the caller holds mu. In-memory state is already
// updated, so a write failure costs only durability: after a restart the
// node falls back to what was last written, which still verifies frames
// from the key that was current then.
func (ks *KeyStore) persist() error {
	if ks.path == "" {
		return nil
	}
	f := keyFile{V: keyFileVersion, Origin: ks.origin, Current: storedOf(ks.current)}
	for _, k := range ks.next {
		f.Next = append(f.Next, storedOf(k))
	}
	data, err := json.MarshalIndent(&f, "", "  ")
	if err != nil {
		return err
	}
	return atomicfile.Write(ks.path, append(data, '\n'), 0o600)
}

// CurrentKID returns the pinned kid, "" until a welcome pinned one.
func (ks *KeyStore) CurrentKID() string {
	ks.mu.Lock()
	defer ks.mu.Unlock()
	return ks.current.KID
}

// PinnedKIDs returns the kids this node accepts, current first, for
// hello.pinned_kids; nil until a kid is pinned.
func (ks *KeyStore) PinnedKIDs() []string {
	ks.mu.Lock()
	defer ks.mu.Unlock()
	if ks.current.KID == "" {
		return nil
	}
	kids := []string{ks.current.KID}
	for _, k := range ks.next {
		kids = append(kids, k.KID)
	}
	return kids
}

// Next returns copies of the announced successors.
func (ks *KeyStore) Next() []TrustedKey {
	ks.mu.Lock()
	defer ks.mu.Unlock()
	out := make([]TrustedKey, len(ks.next))
	for i, k := range ks.next {
		out[i] = TrustedKey{KID: k.KID, PublicKey: slices.Clone(k.PublicKey), NotBefore: k.NotBefore}
	}
	return out
}

// KeyFor returns the key that must verify an envelope signed under kid at
// now (control-plane time): the current key, or a successor whose
// not_before is at most [NotBeforeGrace] away. Before the first welcome pins
// a kid, every kid maps to the join key.
func (ks *KeyStore) KeyFor(kid string, now time.Time) (ed25519.PublicKey, bool) {
	ks.mu.Lock()
	defer ks.mu.Unlock()
	if ks.current.KID == "" || kid == ks.current.KID {
		return ks.current.PublicKey, true
	}
	for _, k := range ks.next {
		if k.KID == kid && !now.Add(NotBeforeGrace).Before(k.NotBefore) {
			return k.PublicKey, true
		}
	}
	return nil, false
}

// Verified records that a frame signed under kid passed verification with
// the key [KeyStore.KeyFor] returned. A welcome pins the kid of a store
// that has none; a successor becomes current and the previous key is
// dropped for good. It reports whether anything changed; the error is a
// failed write, after which the change still holds in memory.
func (ks *KeyStore) Verified(kid string, welcome bool) (changed bool, err error) {
	ks.mu.Lock()
	defer ks.mu.Unlock()
	if ks.current.KID == "" {
		if !welcome {
			return false, nil
		}
		ks.current.KID = kid
		return true, ks.persist()
	}
	i := slices.IndexFunc(ks.next, func(k TrustedKey) bool { return k.KID == kid })
	if i < 0 {
		return false, nil
	}
	ks.current = TrustedKey{KID: kid, PublicKey: ks.next[i].PublicKey}
	ks.next = slices.Delete(ks.next, i, i+1)
	return true, ks.persist()
}

// SetNext replaces the announced successors with keys, from a welcome
// (where an empty list withdraws them) or a key_announce signed under
// envelopeKID. Nothing changes unless envelopeKID is the pinned kid, no key
// names it, and no already pinned kid is bound to a different key.
//
// SECURITY: this is the only way a new key gains trust, so it is accepted
// only from the key the node already pins. A compromised key could still
// announce a successor; recovering from that takes a re-join (ADR 0014 §13).
func (ks *KeyStore) SetNext(envelopeKID string, keys []protocol.SigningKeyAnnouncement) (changed bool, err error) {
	ks.mu.Lock()
	defer ks.mu.Unlock()
	if ks.current.KID == "" || envelopeKID != ks.current.KID {
		return false, ErrAnnouncerNotPinned
	}
	if len(keys) > protocol.MaxNextSigningKeys {
		return false, fmt.Errorf("at most %d successor keys", protocol.MaxNextSigningKeys)
	}
	next := make([]TrustedKey, 0, len(keys))
	for _, a := range keys {
		if a.KID == ks.current.KID {
			return false, ErrAnnouncesCurrent
		}
		k, err := storedKey{KID: a.KID, PublicKey: a.PublicKey, NotBefore: a.NotBefore}.parse(true)
		if err != nil {
			return false, err
		}
		if k.PublicKey.Equal(ks.current.PublicKey) {
			return false, ErrAnnouncesCurrent
		}
		if slices.ContainsFunc(next, func(n TrustedKey) bool { return n.KID == k.KID }) {
			return false, fmt.Errorf("duplicate kid %q", k.KID)
		}
		for _, old := range ks.next {
			if old.KID == k.KID && !old.PublicKey.Equal(k.PublicKey) {
				return false, ErrKeyConflict
			}
		}
		next = append(next, k)
	}
	if slices.EqualFunc(next, ks.next, sameKey) {
		return false, nil
	}
	ks.next = next
	return true, ks.persist()
}

func sameKey(a, b TrustedKey) bool {
	return a.KID == b.KID && a.PublicKey.Equal(b.PublicKey) && a.NotBefore.Equal(b.NotBefore)
}
