package conn

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/state"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// nextHello skips frames until the agent sends a hello.
func (f *fakeControlPlane) nextHello(t *testing.T) *protocol.Hello {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case m := <-f.received:
			if h, ok := m.(*protocol.Hello); ok {
				return h
			}
		case <-deadline:
			t.Fatal("no hello")
			return nil
		}
	}
}

func TestSigningKeyRollover(t *testing.T) {
	oldPub, oldPriv := newKey(t)
	newPub, newPriv := newKey(t)
	_, rogue := newKey(t)
	dir := t.TempDir()
	keysPath := filepath.Join(dir, "control-keys.json")
	store := state.NewStore(filepath.Join(dir, "state.json"))
	logs := &syncBuffer{}
	cp := newFakeControlPlane(t)

	keys, err := OpenKeyStore(keysPath, oldPub, "")
	if err != nil {
		t.Fatal(err)
	}
	c := newTestClient(t, cp.url(), oldPub, store, logs)
	c.Keys = keys
	stop := startClient(t, c)

	if h := cp.nextHello(t); h.PinnedKIDs != nil {
		t.Fatalf("an unpinned agent reported pinned_kids %v", h.PinnedKIDs)
	}
	future := time.Now().Add(time.Minute)
	later := time.Now().Add(time.Hour)
	cp.pushKID(t, oldPriv, "k1", &protocol.Welcome{
		Type:                protocol.TypeWelcome,
		ControlHeader:       header("m_welcome", future),
		HeartbeatIntervalMS: 1000,
		NextKeys:            []protocol.SigningKeyAnnouncement{announcement("k2", newPub, later)},
	})
	cp.pushKID(t, oldPriv, "k1", desired("m_1", 1, future))
	waitFor(t, "generation 1", persistedGeneration(store, 1))
	if got := keys.PinnedKIDs(); !slices.Equal(got, []string{"k1", "k2"}) {
		t.Fatalf("pins after the welcome = %v", got)
	}

	t.Run("a successor is refused before not_before", func(t *testing.T) {
		cp.pushKID(t, newPriv, "k2", desired("m_early", 9, future))
		cp.pushKID(t, oldPriv, "k1", desired("m_2", 2, future))
		waitFor(t, "generation 2", persistedGeneration(store, 2))
	})

	t.Run("announcements from anything but the pinned key are ignored", func(t *testing.T) {
		rogueKey := announcement("evil", oldPub, future)
		// Signed by a key nobody trusts: fails verification.
		cp.pushKID(t, rogue, "k1", &protocol.KeyAnnounce{Type: protocol.TypeKeyAnnounce, ControlHeader: header("m_rogue", future), Keys: []protocol.SigningKeyAnnouncement{rogueKey}})
		// Announcing the very key that signs it: malformed.
		cp.pushKID(t, oldPriv, "k1", &protocol.KeyAnnounce{Type: protocol.TypeKeyAnnounce, ControlHeader: header("m_self", future), Keys: []protocol.SigningKeyAnnouncement{announcement("k1", newPub, future)}})
		cp.pushKID(t, oldPriv, "k1", desired("m_3", 3, future))
		waitFor(t, "generation 3", persistedGeneration(store, 3))
		if got := keys.PinnedKIDs(); !slices.Equal(got, []string{"k1", "k2"}) {
			t.Fatalf("pins changed: %v", got)
		}
	})

	t.Run("hello reports both kids after a reconnect", func(t *testing.T) {
		cp.kick <- struct{}{}
		if h := cp.nextHello(t); !slices.Equal(h.PinnedKIDs, []string{"k1", "k2"}) {
			t.Fatalf("hello pinned_kids = %v", h.PinnedKIDs)
		}
	})

	t.Run("the successor takes over once not_before passes", func(t *testing.T) {
		// The control plane moved not_before forward; key_announce replaces it.
		cp.pushKID(t, oldPriv, "k1", &protocol.KeyAnnounce{
			Type:          protocol.TypeKeyAnnounce,
			ControlHeader: header("m_announce", future),
			Keys:          []protocol.SigningKeyAnnouncement{announcement("k2", newPub, time.Now().Add(-time.Second))},
		})
		cp.pushKID(t, newPriv, "k2", desired("m_4", 4, future))
		waitFor(t, "generation 4", persistedGeneration(store, 4))
		if got := keys.PinnedKIDs(); !slices.Equal(got, []string{"k2"}) {
			t.Fatalf("pins after the switch = %v", got)
		}
		// The retired key is refused from now on.
		cp.pushKID(t, oldPriv, "k1", desired("m_old", 9, future))
		cp.pushKID(t, newPriv, "k2", desired("m_5", 5, future))
		waitFor(t, "generation 5", persistedGeneration(store, 5))
		if !strings.Contains(logs.String(), `"reason":"unknown_kid"`) {
			t.Error("the retired kid was not rejected")
		}
	})

	if err := stop(); err != nil {
		t.Fatal(err)
	}

	t.Run("a restarted agent keeps only the new key", func(t *testing.T) {
		reopened, err := OpenKeyStore(keysPath, oldPub, "")
		if err != nil {
			t.Fatal(err)
		}
		c2 := newTestClient(t, cp.url(), oldPub, store, logs)
		c2.Keys = reopened
		startClient(t, c2)
		if h := cp.nextHello(t); !slices.Equal(h.PinnedKIDs, []string{"k2"}) {
			t.Fatalf("hello pinned_kids after restart = %v", h.PinnedKIDs)
		}
		cp.pushKID(t, oldPriv, "k1", desired("m_old_again", 9, future))
		cp.pushKID(t, newPriv, "k2", desired("m_6", 6, future))
		waitFor(t, "generation 6", persistedGeneration(store, 6))
	})
}

func TestWelcomeWithoutNextKeysWithdrawsThem(t *testing.T) {
	oldPub, oldPriv := newKey(t)
	newPub, newPriv := newKey(t)
	store := state.NewStore(filepath.Join(t.TempDir(), "state.json"))
	cp := newFakeControlPlane(t)
	c := newTestClient(t, cp.url(), oldPub, store, &syncBuffer{})
	c.ControlKeyID = "k1"
	startClient(t, c)
	cp.nextHello(t)

	future := time.Now().Add(time.Minute)
	cp.pushKID(t, oldPriv, "k1", &protocol.KeyAnnounce{
		Type:          protocol.TypeKeyAnnounce,
		ControlHeader: header("m_announce", future),
		Keys:          []protocol.SigningKeyAnnouncement{announcement("k2", newPub, time.Now())},
	})
	cp.pushKID(t, oldPriv, "k1", &protocol.Welcome{Type: protocol.TypeWelcome, ControlHeader: header("m_welcome", future), HeartbeatIntervalMS: 1000})
	cp.pushKID(t, newPriv, "k2", desired("m_cancelled", 9, future))
	cp.pushKID(t, oldPriv, "k1", desired("m_1", 1, future))
	waitFor(t, "generation 1", persistedGeneration(store, 1))
	if got := c.Keys.PinnedKIDs(); !slices.Equal(got, []string{"k1"}) {
		t.Fatalf("pins after a cancelled rollover = %v", got)
	}
}
