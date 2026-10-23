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
		{"hello-statuses.json", &Hello{}},
		{"workload-status.json", &WorkloadStatus{}},
		{"logs-runtime.json", &Logs{}},
		{"logs-build.json", &Logs{}},
		{"build-result-ok.json", &BuildResult{}},
		{"build-result-failed.json", &BuildResult{}},
		{"build-result-cancelled.json", &BuildResult{}},
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
	cases := map[string]AgentMessage{
		"hello.json":                  &Hello{},
		"hello-statuses.json":         &Hello{},
		"heartbeat.json":              &Heartbeat{},
		"workload-status.json":        &WorkloadStatus{},
		"logs-runtime.json":           &Logs{},
		"logs-build.json":             &Logs{},
		"build-result-ok.json":        &BuildResult{},
		"build-result-failed.json":    &BuildResult{},
		"build-result-cancelled.json": &BuildResult{},
	}
	for file, want := range cases {
		t.Run(file, func(t *testing.T) {
			m, err := DecodeAgentMessage(readFixture(t, file))
			if err != nil {
				t.Fatal(err)
			}
			if reflect.TypeOf(m) != reflect.TypeOf(want) {
				t.Fatalf("got %T, want %T", m, want)
			}
		})
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
		Workloads:  []WorkloadSpec{},
		TLSMode:    TLSOff,
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

// fixtureIAT is the iat of every signed fixture. Credential-bearing fixtures
// expire 60 s later, so verification pins the clock to it.
var fixtureIAT = time.UnixMilli(1_700_000_000_000)

func verifyFixture(t *testing.T, name string) (ControlMessage, string) {
	t.Helper()
	var f signedFixture
	if err := json.Unmarshal(readFixture(t, name), &f); err != nil {
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
	msg, err := VerifyEnvelope(env, pub, f.NodeID, fixtureIAT)
	if err != nil {
		t.Fatalf("verify %s: %v", name, err)
	}
	if _, err := VerifyEnvelope(env, pub, f.NodeID, fixtureIAT.Add(CredentialFrameTTLMS*time.Millisecond+time.Millisecond)); err == nil {
		t.Errorf("%s: credential-bearing fixture should expire within %d ms", name, CredentialFrameTTLMS)
	}
	return msg, env.Payload
}

// assertRoundTrip checks that re-encoding msg reproduces payload exactly as
// JSON values, so no field is lost or invented by the Go types.
func assertRoundTrip(t *testing.T, msg ControlMessage, payload string) {
	t.Helper()
	out, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	var want, got any
	if err := json.Unmarshal([]byte(payload), &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(want, got) {
		t.Errorf("round trip mismatch\nwant: %s\ngot:  %s", payload, out)
	}
}

func TestVerifySignedDesiredStateFixture(t *testing.T) {
	msg, payload := verifyFixture(t, "signed-desired-state.json")
	ds, ok := msg.(*DesiredState)
	if !ok {
		t.Fatalf("got %T, want *DesiredState", msg)
	}
	if !CarriesCredentials(ds) {
		t.Error("fixture should carry credentials")
	}
	if len(ds.Workloads) == 0 || ds.Registry == nil || ds.AppsDomain == nil {
		t.Fatalf("fixture is missing parts: %+v", ds)
	}
	for _, w := range ds.Workloads {
		if want := EnvironmentNetworkName(*w.ProjectID, *w.EnvironmentID); w.Network != want {
			t.Errorf("%s: network %s, want %s", w.ID, w.Network, want)
		}
		got, err := ComputeSpecHash(w)
		if err != nil {
			t.Fatal(err)
		}
		if got != w.SpecHash {
			t.Errorf("%s: spec_hash %s, computed %s", w.ID, w.SpecHash, got)
		}
	}
	assertRoundTrip(t, ds, payload)
}

func TestVerifySignedBuildJobFixture(t *testing.T) {
	msg, payload := verifyFixture(t, "signed-build-job.json")
	job, ok := msg.(*BuildJob)
	if !ok {
		t.Fatalf("got %T, want *BuildJob", msg)
	}
	if job.Source.Token == "" || !CarriesCredentials(job) {
		t.Error("fixture should carry a git token")
	}
	if len(job.SecretBuildArgs) == 0 {
		t.Fatal("fixture should mark a build arg secret")
	}
	for _, name := range job.SecretBuildArgs {
		if _, ok := job.BuildArgs[name]; !ok || !job.IsSecretArg(name) {
			t.Errorf("secret build arg %s is not a build arg", name)
		}
	}
	if job.IsSecretArg("NODE_ENV") {
		t.Error("NODE_ENV is not secret")
	}
	assertRoundTrip(t, job, payload)
}

func TestVerifySignedBuildCancelFixture(t *testing.T) {
	var f signedFixture
	if err := json.Unmarshal(readFixture(t, "signed-build-cancel.json"), &f); err != nil {
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
	msg, err := VerifyEnvelope(env, pub, f.NodeID, fixtureIAT)
	if err != nil {
		t.Fatal(err)
	}
	c, ok := msg.(*BuildCancel)
	if !ok {
		t.Fatalf("got %T, want *BuildCancel", msg)
	}
	if c.BuildID != "bld_01JAAAAAAAAAAAAAAAAAAAAAAA" || CarriesCredentials(c) {
		t.Errorf("unexpected cancel %+v", c)
	}
	assertRoundTrip(t, c, env.Payload)
}

// TestNetworkNamesFixture is the Go half of the network-name agreement
// check: the TypeScript suite recomputes the same cases.
func TestNetworkNamesFixture(t *testing.T) {
	var f struct {
		Cases []struct {
			ProjectID     string `json:"project_id"`
			EnvironmentID string `json:"environment_id"`
			Network       string `json:"network"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(readFixture(t, "network-names.json"), &f); err != nil {
		t.Fatal(err)
	}
	hashed := false
	for _, c := range f.Cases {
		got := EnvironmentNetworkName(c.ProjectID, c.EnvironmentID)
		if got != c.Network {
			t.Errorf("EnvironmentNetworkName(%s, %s) = %s, want %s", c.ProjectID, c.EnvironmentID, got, c.Network)
		}
		if !networkRE.MatchString(got) {
			t.Errorf("%s is not a valid network name", got)
		}
		hashed = hashed || strings.HasPrefix(got, HashedNetworkPrefix)
	}
	if !hashed {
		t.Error("fixture has no hashed case")
	}
}

// TestSpecHashFixture is the Go half of the spec-hash agreement check: the
// TypeScript suite recomputes the same cases with computeSpecHash.
func TestSpecHashFixture(t *testing.T) {
	var f struct {
		Cases []struct {
			Name      string          `json:"name"`
			Spec      json.RawMessage `json:"spec"`
			Canonical string          `json:"canonical"`
			SpecHash  string          `json:"spec_hash"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(readFixture(t, "spec-hash.json"), &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) < 4 {
		t.Fatalf("expected at least 4 cases, got %d", len(f.Cases))
	}
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			var w WorkloadSpec
			if err := decodeStrict(c.Spec, &w, true); err != nil {
				t.Fatal(err)
			}
			if err := w.Validate(); err != nil {
				t.Fatal(err)
			}
			input, err := SpecHashInput(w)
			if err != nil {
				t.Fatal(err)
			}
			if input != c.Canonical {
				t.Errorf("canonical mismatch\nwant: %s\ngot:  %s", c.Canonical, input)
			}
			got, err := ComputeSpecHash(w)
			if err != nil {
				t.Fatal(err)
			}
			if got != c.SpecHash || w.SpecHash != c.SpecHash {
				t.Errorf("spec_hash: fixture %s, spec %s, computed %s", c.SpecHash, w.SpecHash, got)
			}
		})
	}
}
