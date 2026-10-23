// Package sealtest seals workload environments and build secrets to a test
// node key the way the control plane does, so tests feed the agent the same
// boxes a real desired_state or build_job carries. Test code only.
package sealtest

import (
	"crypto/ecdh"
	"encoding/hex"
	"encoding/json"
	"testing"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// bobKey is RFC 7748 §6.1 Bob's private key, the node key of the protocol's
// sealed-box fixtures.
const bobKey = "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb"

// Key returns the fixed test node encryption key.
func Key() *ecdh.PrivateKey {
	raw, _ := hex.DecodeString(bobKey)
	k, err := ecdh.X25519().NewPrivateKey(raw)
	if err != nil {
		panic(err)
	}
	return k
}

// OtherKey returns a key that is not [Key], for wrong-key tests.
func OtherKey(tb testing.TB) *ecdh.PrivateKey {
	tb.Helper()
	raw := make([]byte, 32)
	raw[0] = 7
	k, err := ecdh.X25519().NewPrivateKey(raw)
	if err != nil {
		tb.Fatal(err)
	}
	return k
}

// SealWorkload seals env and files into w.EnvSealed for nodeID and
// generation, as the control plane does for one desired_state, and clears
// w.Env and w.SecretFiles so only the box carries them.
func SealWorkload(tb testing.TB, to *ecdh.PublicKey, nodeID string, generation int64, w *protocol.WorkloadSpec,
	env, files map[string]string) {
	tb.Helper()
	if env == nil {
		env = map[string]string{}
	}
	if files == nil {
		files = map[string]string{}
	}
	pt, err := json.Marshal(protocol.SealedWorkloadEnv{Env: env, Files: files})
	if err != nil {
		tb.Fatal(err)
	}
	box, err := protocol.SealBox(to, pt, protocol.BoxPurposeWorkloadEnv, protocol.WorkloadEnvAAD(nodeID, w.ID, generation))
	if err != nil {
		tb.Fatal(err)
	}
	w.EnvSealed, w.Env, w.SecretFiles = box, nil, nil
}

// SealBuildSecrets seals secrets into j.BuildSecretsSealed for nodeID.
func SealBuildSecrets(tb testing.TB, to *ecdh.PublicKey, nodeID string, j *protocol.BuildJob, secrets map[string]string) {
	tb.Helper()
	pt, err := json.Marshal(protocol.SealedBuildSecrets{Secrets: secrets})
	if err != nil {
		tb.Fatal(err)
	}
	box, err := protocol.SealBox(to, pt, protocol.BoxPurposeBuildSecrets, protocol.BuildSecretsAAD(nodeID, j.BuildID))
	if err != nil {
		tb.Fatal(err)
	}
	j.BuildSecretsSealed = box
}

// Opener returns an OpenEnv function for the agent's runtime that opens
// boxes with key as node nodeID.
func Opener(key *ecdh.PrivateKey, nodeID string) func(int64, *protocol.WorkloadSpec) error {
	return func(generation int64, w *protocol.WorkloadSpec) error {
		return protocol.OpenWorkloadEnv(key, nodeID, generation, w)
	}
}
