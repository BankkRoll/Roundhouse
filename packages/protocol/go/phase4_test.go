package protocol

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

var phase4AgentFixtures = map[string]AgentMessage{
	"exec-opened.json":              &ExecOpened{},
	"exec-output.json":              &ExecOutput{},
	"exec-exit.json":                &ExecExit{},
	"exec-exit-error.json":          &ExecExit{},
	"image-push-result-ok.json":     &ImagePushResult{},
	"image-push-result-failed.json": &ImagePushResult{},
}

// TestPhase4AgentFixtures decodes the Phase 4 agent fixtures strictly and
// re-encodes them to the same JSON.
func TestPhase4AgentFixtures(t *testing.T) {
	for file, want := range phase4AgentFixtures {
		t.Run(file, func(t *testing.T) {
			data := readFixture(t, file)
			m, err := DecodeAgentMessage(data)
			if err != nil {
				t.Fatal(err)
			}
			if reflect.TypeOf(m) != reflect.TypeOf(want) {
				t.Fatalf("got %T, want %T", m, want)
			}
			out, err := json.Marshal(m)
			if err != nil {
				t.Fatal(err)
			}
			var a, b any
			_ = json.Unmarshal(data, &a)
			_ = json.Unmarshal(out, &b)
			if !reflect.DeepEqual(a, b) {
				t.Errorf("round trip mismatch\nwant: %s\ngot:  %s", data, out)
			}
		})
	}
}

var phase4SignedFixtures = map[string]ControlMessage{
	"signed-exec-open.json":   &ExecOpen{},
	"signed-exec-input.json":  &ExecInput{},
	"signed-exec-resize.json": &ExecResize{},
	"signed-exec-close.json":  &ExecClose{},
	"signed-image-push.json":  &ImagePush{},
}

// TestPhase4SignedFixtures verifies the TS signatures, checks that every
// shell frame and the push take the credential TTL, and round-trips them.
func TestPhase4SignedFixtures(t *testing.T) {
	for file, want := range phase4SignedFixtures {
		t.Run(file, func(t *testing.T) {
			msg, payload := verifyFixture(t, file)
			if reflect.TypeOf(msg) != reflect.TypeOf(want) {
				t.Fatalf("got %T, want %T", msg, want)
			}
			if !CarriesCredentials(msg) {
				t.Error("CarriesCredentials = false")
			}
			assertRoundTrip(t, msg, payload)
		})
	}
}

// TestPhase4BoxesOpen opens the sealed keystrokes and registry login with
// the fixture node key, and refuses them under another position or push.
func TestPhase4BoxesOpen(t *testing.T) {
	f, node, _ := loadBoxFixture(t)
	in := signedPayload[*ExecInput](t, "signed-exec-input.json")
	data, err := OpenExecInput(node, f.NodeID, in)
	if err != nil || string(data) != "echo $RH_TEST\r" {
		t.Fatalf("input %q, %v", data, err)
	}
	moved := *in
	moved.Seq++
	if _, err := OpenExecInput(node, f.NodeID, &moved); err == nil {
		t.Error("an input batch opened at another sequence number")
	}

	push := signedPayload[*ImagePush](t, "signed-image-push.json")
	cred, err := OpenImagePushCredential(node, f.NodeID, push)
	if err != nil || cred.Username != "v1" || cred.Password != "fixture-push-password" {
		t.Fatalf("credential %+v, %v", cred, err)
	}
	other := *push
	other.PushID = "psh_other"
	if _, err := OpenImagePushCredential(node, f.NodeID, &other); err == nil {
		t.Error("a push credential opened under another push")
	}
}

// TestPhase4Validation pins the ADR 0014 §15 rules both languages enforce.
func TestPhase4Validation(t *testing.T) {
	cases := map[string]struct {
		file   string
		mutate func(ControlMessage)
	}{
		"empty command":    {"signed-exec-open.json", func(m ControlMessage) { m.(*ExecOpen).Command = nil }},
		"empty program":    {"signed-exec-open.json", func(m ControlMessage) { m.(*ExecOpen).Command = []string{""} }},
		"NUL in argv":      {"signed-exec-open.json", func(m ControlMessage) { m.(*ExecOpen).Command = []string{"sh", "a\x00b"} }},
		"too many args":    {"signed-exec-open.json", func(m ControlMessage) { m.(*ExecOpen).Command = make([]string, MaxExecArgs+1) }},
		"command too long": {"signed-exec-open.json", func(m ControlMessage) { m.(*ExecOpen).Command = []string{strings.Repeat("x", MaxExecCommandBytes+1)} }},
		"no tty":           {"signed-exec-open.json", func(m ControlMessage) { m.(*ExecOpen).TTY = false }},
		"zero cols":        {"signed-exec-open.json", func(m ControlMessage) { m.(*ExecOpen).Cols = 0 }},
		"LD_PRELOAD":       {"signed-exec-open.json", func(m ControlMessage) { m.(*ExecOpen).Env["LD_PRELOAD"] = "/x.so" }},
		"nil env":          {"signed-exec-open.json", func(m ControlMessage) { m.(*ExecOpen).Env = nil }},
		"idle too short":   {"signed-exec-open.json", func(m ControlMessage) { m.(*ExecOpen).IdleTimeoutS = MinExecIdleTimeoutS - 1 }},
		"long-lived open":  {"signed-exec-open.json", func(m ControlMessage) { m.(*ExecOpen).ExpiresAt += CredentialFrameTTLMS }},
		"negative seq":     {"signed-exec-input.json", func(m ControlMessage) { m.(*ExecInput).Seq = -1 }},
		"long-lived input": {"signed-exec-input.json", func(m ControlMessage) { m.(*ExecInput).ExpiresAt += CredentialFrameTTLMS }},
		"huge resize":      {"signed-exec-resize.json", func(m ControlMessage) { m.(*ExecResize).Rows = MaxExecRows + 1 }},
		"bad close reason": {"signed-exec-close.json", func(m ControlMessage) { m.(*ExecClose).Reason = "bored" }},
		"long-lived close": {"signed-exec-close.json", func(m ControlMessage) { m.(*ExecClose).ExpiresAt += CredentialFrameTTLMS }},
		"unpinned source":  {"signed-image-push.json", func(m ControlMessage) { m.(*ImagePush).Source = RegistryListen + "/prj/svc:latest" }},
		"foreign source": {"signed-image-push.json", func(m ControlMessage) {
			m.(*ImagePush).Source = "docker.io/library/nginx@sha256:" + strings.Repeat("a", 64)
		}},
		"digest target":   {"signed-image-push.json", func(m ControlMessage) { m.(*ImagePush).Target = "r.example.com/a@sha256:" + strings.Repeat("a", 64) }},
		"local target":    {"signed-image-push.json", func(m ControlMessage) { m.(*ImagePush).Target = RegistryListen + "/prj/svc:tag" }},
		"hostless target": {"signed-image-push.json", func(m ControlMessage) { m.(*ImagePush).Target = "app:tag" }},
		"arm64":           {"signed-image-push.json", func(m ControlMessage) { m.(*ImagePush).Platform = "linux/arm64" }},
		"long-lived push": {"signed-image-push.json", func(m ControlMessage) { m.(*ImagePush).ExpiresAt += CredentialFrameTTLMS }},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			msg, _ := verifyFixture(t, c.file)
			c.mutate(msg)
			if err := msg.(Validator).Validate(); err == nil {
				t.Error("validated")
			}
		})
	}
	if !ValidExecCommand(DefaultExecCommand) {
		t.Error("the default command is invalid")
	}
	ok := signedPayload[*ImagePush](t, "signed-image-push.json")
	ok.Target = "localhost:5001/rh-app:dep_1"
	if err := ok.Validate(); err != nil {
		t.Errorf("a loopback test registry target: %v", err)
	}
}

// TestPhase4AgentValidation covers the agent frames' rules.
func TestPhase4AgentValidation(t *testing.T) {
	bad := []string{
		`{"type":"exec_output","session_id":"shl_1","seq":0,"data":""}`,
		`{"type":"exec_output","session_id":"shl_1","seq":0,"data":"not base64!"}`,
		`{"type":"exec_exit","session_id":"shl_1","exit_code":null,"reason":"exited"}`,
		`{"type":"exec_exit","session_id":"shl_1","reason":"closed"}`,
		`{"type":"exec_opened","session_id":"shl_1","user":""}`,
		`{"type":"image_push_result","push_id":"psh_1","ok":true}`,
		`{"type":"image_push_result","push_id":"psh_1","ok":false}`,
		`{"type":"image_push_result","push_id":"psh_1","ok":true,"digest":"sha256:` + strings.Repeat("a", 64) + `","error":"x"}`,
	}
	for _, raw := range bad {
		if _, err := DecodeAgentMessage([]byte(raw)); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	big := `{"type":"exec_output","session_id":"shl_1","seq":0,"data":"` + strings.Repeat("AAAA", MaxExecOutputBytes/3+1) + `"}`
	if _, err := DecodeAgentMessage([]byte(big)); err == nil {
		t.Error("accepted output over the limit")
	}
}
