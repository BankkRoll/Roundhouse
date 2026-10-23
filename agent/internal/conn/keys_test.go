package conn

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

func newKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func announcement(kid string, pub ed25519.PublicKey, notBefore time.Time) protocol.SigningKeyAnnouncement {
	return protocol.SigningKeyAnnouncement{
		KID:       kid,
		PublicKey: base64.StdEncoding.EncodeToString(pub),
		NotBefore: notBefore.Unix(),
	}
}

func TestKeyStoreRollover(t *testing.T) {
	path := filepath.Join(t.TempDir(), "control-keys.json")
	oldPub, _ := newKey(t)
	newPub, _ := newKey(t)
	ks, err := OpenKeyStore(path, oldPub, "k1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("an untouched store must not write a file, stat err = %v", err)
	}

	now := time.Now()
	notBefore := now.Add(time.Hour)
	if changed, err := ks.SetNext("k1", []protocol.SigningKeyAnnouncement{announcement("k2", newPub, notBefore)}); !changed || err != nil {
		t.Fatalf("SetNext = %v, %v", changed, err)
	}
	if got := ks.PinnedKIDs(); !slices.Equal(got, []string{"k1", "k2"}) {
		t.Fatalf("PinnedKIDs = %v", got)
	}

	if _, ok := ks.KeyFor("k2", now); ok {
		t.Fatal("a successor must not verify an hour before not_before")
	}
	if _, ok := ks.KeyFor("k2", notBefore.Add(-NotBeforeGrace-time.Second)); ok {
		t.Fatal("a successor must not verify before the grace window")
	}
	if key, ok := ks.KeyFor("k2", notBefore.Add(-NotBeforeGrace)); !ok || !key.Equal(newPub) {
		t.Fatal("a successor must verify within the grace window")
	}
	if key, ok := ks.KeyFor("k1", notBefore.Add(time.Hour)); !ok || !key.Equal(oldPub) {
		t.Fatal("the current key keeps verifying until a successor's frame is seen")
	}
	if _, ok := ks.KeyFor("k3", now); ok {
		t.Fatal("an unknown kid must not verify")
	}

	if changed, err := ks.Verified("k2", false); !changed || err != nil {
		t.Fatalf("Verified(k2) = %v, %v", changed, err)
	}
	if got := ks.PinnedKIDs(); !slices.Equal(got, []string{"k2"}) {
		t.Fatalf("PinnedKIDs after rollover = %v", got)
	}
	if _, ok := ks.KeyFor("k1", notBefore.Add(time.Hour)); ok {
		t.Fatal("the retired key must not verify after the rollover")
	}
	if key, ok := ks.KeyFor("k2", now); !ok || !key.Equal(newPub) {
		t.Fatal("the new key is current and verifies at any time")
	}

	// A restart keeps the rollover and never revives the retired key.
	reopened, err := OpenKeyStore(path, oldPub, "k1")
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.PinnedKIDs(); !slices.Equal(got, []string{"k2"}) {
		t.Fatalf("PinnedKIDs after restart = %v", got)
	}
	if _, ok := reopened.KeyFor("k1", now); ok {
		t.Fatal("the retired key verifies again after a restart")
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("key file mode = %o, want 600", perm)
		}
	}
}

func TestKeyStorePersistsAnnouncements(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keys.json")
	oldPub, _ := newKey(t)
	newPub, _ := newKey(t)
	ks, err := OpenKeyStore(path, oldPub, "k1")
	if err != nil {
		t.Fatal(err)
	}
	notBefore := time.Unix(time.Now().Add(time.Hour).Unix(), 0)
	if _, err := ks.SetNext("k1", []protocol.SigningKeyAnnouncement{announcement("k2", newPub, notBefore)}); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenKeyStore(path, oldPub, "k1")
	if err != nil {
		t.Fatal(err)
	}
	next := reopened.Next()
	if len(next) != 1 || next[0].KID != "k2" || !next[0].PublicKey.Equal(newPub) || !next[0].NotBefore.Equal(notBefore) {
		t.Fatalf("Next after restart = %+v", next)
	}
	if key, ok := reopened.KeyFor("k2", notBefore); !ok || !key.Equal(newPub) {
		t.Fatal("a persisted successor must verify after not_before")
	}

	// A welcome with no next_keys withdraws them (a cancelled rollover).
	if changed, err := reopened.SetNext("k1", nil); !changed || err != nil {
		t.Fatalf("SetNext(nil) = %v, %v", changed, err)
	}
	again, err := OpenKeyStore(path, oldPub, "k1")
	if err != nil {
		t.Fatal(err)
	}
	if got := again.PinnedKIDs(); !slices.Equal(got, []string{"k1"}) {
		t.Fatalf("PinnedKIDs after withdrawal = %v", got)
	}
}

func TestKeyStoreRefusesUntrustedAnnouncements(t *testing.T) {
	oldPub, _ := newKey(t)
	newPub, _ := newKey(t)
	otherPub, _ := newKey(t)
	later := time.Now().Add(time.Hour)

	unpinned := NewKeyStore(oldPub, "")
	if _, err := unpinned.SetNext("k1", []protocol.SigningKeyAnnouncement{announcement("k2", newPub, later)}); !errors.Is(err, ErrAnnouncerNotPinned) {
		t.Fatalf("announcement before a kid is pinned: err = %v", err)
	}

	ks := NewKeyStore(oldPub, "k1")
	cases := []struct {
		name string
		kid  string
		keys []protocol.SigningKeyAnnouncement
		want error
	}{
		{"signed by an unpinned kid", "k9", []protocol.SigningKeyAnnouncement{announcement("k2", newPub, later)}, ErrAnnouncerNotPinned},
		{"names the pinned kid", "k1", []protocol.SigningKeyAnnouncement{announcement("k1", newPub, later)}, ErrAnnouncesCurrent},
		{"reuses the pinned public key", "k1", []protocol.SigningKeyAnnouncement{announcement("k2", oldPub, later)}, ErrAnnouncesCurrent},
	}
	for _, tc := range cases {
		changed, err := ks.SetNext(tc.kid, tc.keys)
		if changed || !errors.Is(err, tc.want) {
			t.Errorf("%s: SetNext = %v, %v; want %v", tc.name, changed, err, tc.want)
		}
	}
	for _, bad := range [][]protocol.SigningKeyAnnouncement{
		{announcement("k2", newPub, later), announcement("k2", otherPub, later)},
		{announcement("bad kid!", newPub, later)},
		{{KID: "k2", PublicKey: "AAAA", NotBefore: later.Unix()}},
		{announcement("k2", newPub, time.Unix(0, 0))},
		{announcement("k2", newPub, later), announcement("k3", otherPub, later), announcement("k4", otherPub, later)},
	} {
		if changed, err := ks.SetNext("k1", bad); changed || err == nil {
			t.Errorf("SetNext(%v) = %v, %v; want an error", bad, changed, err)
		}
	}
	if got := ks.PinnedKIDs(); !slices.Equal(got, []string{"k1"}) {
		t.Fatalf("rejected announcements changed the pins: %v", got)
	}

	if _, err := ks.SetNext("k1", []protocol.SigningKeyAnnouncement{announcement("k2", newPub, later)}); err != nil {
		t.Fatal(err)
	}
	if _, err := ks.SetNext("k1", []protocol.SigningKeyAnnouncement{announcement("k2", otherPub, later)}); !errors.Is(err, ErrKeyConflict) {
		t.Fatalf("rebinding a pinned kid: err = %v", err)
	}
	if changed, err := ks.SetNext("k1", []protocol.SigningKeyAnnouncement{announcement("k2", newPub, later)}); changed || err != nil {
		t.Fatalf("repeating an announcement = %v, %v; want a no-op", changed, err)
	}
	// Frames from the successor can't announce before it is current.
	if _, err := ks.SetNext("k2", []protocol.SigningKeyAnnouncement{announcement("k3", otherPub, later)}); !errors.Is(err, ErrAnnouncerNotPinned) {
		t.Fatalf("announcement from a not yet current successor: err = %v", err)
	}
}

func TestKeyStorePinsFromWelcomeOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keys.json")
	pub, _ := newKey(t)
	ks, err := OpenKeyStore(path, pub, "")
	if err != nil {
		t.Fatal(err)
	}
	if key, ok := ks.KeyFor("anything", time.Now()); !ok || !key.Equal(pub) {
		t.Fatal("an unpinned store verifies every kid with the join key")
	}
	if ks.PinnedKIDs() != nil {
		t.Fatal("an unpinned store reports no kids")
	}
	if changed, _ := ks.Verified("k1", false); changed {
		t.Fatal("only a welcome pins the kid")
	}
	if changed, err := ks.Verified("k1", true); !changed || err != nil {
		t.Fatalf("Verified(welcome) = %v, %v", changed, err)
	}
	reopened, err := OpenKeyStore(path, pub, "")
	if err != nil {
		t.Fatal(err)
	}
	if reopened.CurrentKID() != "k1" {
		t.Fatalf("pinned kid after restart = %q", reopened.CurrentKID())
	}
	if _, ok := reopened.KeyFor("k2", time.Now()); ok {
		t.Fatal("a pinned store must refuse other kids")
	}
}

func TestKeyStoreIgnoresAnotherRegistrationsFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keys.json")
	firstPub, _ := newKey(t)
	nextPub, _ := newKey(t)
	ks, err := OpenKeyStore(path, firstPub, "k1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ks.SetNext("k1", []protocol.SigningKeyAnnouncement{announcement("k2", nextPub, time.Now())}); err != nil {
		t.Fatal(err)
	}

	rejoinedPub, _ := newKey(t)
	fresh, err := OpenKeyStore(path, rejoinedPub, "r1")
	if err != nil {
		t.Fatal(err)
	}
	if got := fresh.PinnedKIDs(); !slices.Equal(got, []string{"r1"}) {
		t.Fatalf("PinnedKIDs after a re-join = %v", got)
	}
}

func TestKeyStoreRejectsCorruptFile(t *testing.T) {
	pub, _ := newKey(t)
	origin := base64.StdEncoding.EncodeToString(pub)
	for name, body := range map[string]string{
		"not json":      "{",
		"unknown field": `{"v":1,"origin":"` + origin + `","current":{"kid":"k1","public_key":"` + origin + `"},"extra":1}`,
		"bad version":   `{"v":9,"origin":"` + origin + `","current":{"kid":"k1","public_key":"` + origin + `"}}`,
		"bad key":       `{"v":1,"origin":"` + origin + `","current":{"kid":"k1","public_key":"AAAA"}}`,
		"duplicate kid": `{"v":1,"origin":"` + origin + `","current":{"kid":"k1","public_key":"` + origin + `"},"next":[{"kid":"k1","public_key":"` + origin + `","not_before":1}]}`,
		"no not_before": `{"v":1,"origin":"` + origin + `","current":{"kid":"k1","public_key":"` + origin + `"},"next":[{"kid":"k2","public_key":"` + origin + `"}]}`,
		"too many keys": `{"v":1,"origin":"` + origin + `","current":{"kid":"k1","public_key":"` + origin + `"},"next":[` + strings.Repeat(`{"kid":"k2","public_key":"`+origin+`","not_before":1},`, 2) + `{"kid":"k3","public_key":"` + origin + `","not_before":1}]}`,
		"successor kid": `{"v":1,"origin":"` + origin + `","current":{"kid":"k1","public_key":"` + origin + `"},"next":[{"kid":"","public_key":"` + origin + `","not_before":1}]}`,
	} {
		path := filepath.Join(t.TempDir(), "keys.json")
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := OpenKeyStore(path, pub, "k1"); err == nil {
			t.Errorf("%s: OpenKeyStore accepted a corrupt file", name)
		}
	}
}
