package mesh

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sync"

	"github.com/BankkRoll/Roundhouse/agent/internal/atomicfile"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// KeyFileName is the key store's name in the agent's data directory.
const KeyFileName = "wireguard.key"

// keyFile is the key store's on-disk form.
type keyFile struct {
	Epoch      int64     `json:"epoch"`
	PrivateKey string    `json:"private_key"`
	Next       *keyEntry `json:"next"`
}

// keyEntry is a key generated for a rotation, not yet in use.
type keyEntry struct {
	Epoch      int64  `json:"epoch"`
	PrivateKey string `json:"private_key"`
}

// KeyStore holds the node's WireGuard private key and, during a rotation,
// its successor (ADR 0005, "Key rotation"). It is safe for concurrent use.
//
// SECURITY: the file is 0600 and written atomically; the private keys never
// leave the node and are never logged. Only public keys are exposed.
type KeyStore struct {
	path string

	mu   sync.Mutex
	cur  wgtypes.Key
	ep   int64
	next *wgtypes.Key
	nep  int64
}

// OpenKeyStore loads the key store at path, creating it with a fresh key at
// epoch 0 when it doesn't exist, and reports whether it did.
func OpenKeyStore(path string) (*KeyStore, bool, error) {
	k := &KeyStore{path: path}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		key, err := wgtypes.GeneratePrivateKey()
		if err != nil {
			return nil, false, err
		}
		k.cur = key
		if err := k.save(); err != nil {
			return nil, false, err
		}
		return k, true, nil
	}
	if err != nil {
		return nil, false, err
	}
	var f keyFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, false, fmt.Errorf("%s: corrupt key file: %w", path, err)
	}
	if k.cur, err = wgtypes.ParseKey(f.PrivateKey); err != nil || f.Epoch < 0 {
		return nil, false, fmt.Errorf("%s: invalid private key or epoch", path)
	}
	k.ep = f.Epoch
	if f.Next != nil {
		next, err := wgtypes.ParseKey(f.Next.PrivateKey)
		if err != nil || f.Next.Epoch <= f.Epoch {
			return nil, false, fmt.Errorf("%s: invalid next key", path)
		}
		k.next, k.nep = &next, f.Next.Epoch
	}
	return k, false, nil
}

// save writes the store. Caller holds k.mu or owns k exclusively.
func (k *KeyStore) save() error {
	f := keyFile{Epoch: k.ep, PrivateKey: k.cur.String()}
	if k.next != nil {
		f.Next = &keyEntry{Epoch: k.nep, PrivateKey: k.next.String()}
	}
	data, err := json.Marshal(f)
	if err != nil {
		return err
	}
	return atomicfile.Write(k.path, data, 0o600)
}

// Current returns the private key wg0 uses and its epoch.
func (k *KeyStore) Current() (wgtypes.Key, int64) {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.cur, k.ep
}

// PublicKey returns the current public key, standard base64.
func (k *KeyStore) PublicKey() string {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.cur.PublicKey().String()
}

// Next returns the pending successor's public key and epoch, ok false when
// no rotation is under way.
func (k *KeyStore) Next() (publicKey string, epoch int64, ok bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.next == nil {
		return "", 0, false
	}
	return k.next.PublicKey().String(), k.nep, true
}

// Rotate generates and persists a successor at the next epoch, unless one
// is pending already, and returns the successor's public key and epoch. The
// current key stays in use until [KeyStore.Activate].
func (k *KeyStore) Rotate() (publicKey string, epoch int64, err error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.next == nil {
		next, err := wgtypes.GeneratePrivateKey()
		if err != nil {
			return "", 0, err
		}
		k.next, k.nep = &next, k.ep+1
		if err := k.save(); err != nil {
			k.next, k.nep = nil, 0
			return "", 0, fmt.Errorf("persist the next mesh key: %w", err)
		}
	}
	return k.next.PublicKey().String(), k.nep, nil
}

// Activate makes the successor of epoch current and reports whether the key
// changed. An epoch at or below the current one is a no-op (an activation
// already done); one that matches no pending successor is an error.
func (k *KeyStore) Activate(epoch int64) (bool, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if epoch <= k.ep {
		return false, nil
	}
	if k.next == nil || k.nep != epoch {
		return false, fmt.Errorf("asked to activate mesh key epoch %d, but this node holds no key for it (current epoch %d)", epoch, k.ep)
	}
	prevKey, prevEpoch, prevNext := k.cur, k.ep, k.next
	k.cur, k.ep, k.next, k.nep = *k.next, epoch, nil, 0
	if err := k.save(); err != nil {
		k.cur, k.ep, k.next, k.nep = prevKey, prevEpoch, prevNext, epoch
		return false, fmt.Errorf("persist the activated mesh key: %w", err)
	}
	return true, nil
}
