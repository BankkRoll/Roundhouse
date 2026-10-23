package protocol

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func strPtr(s string) *string { return &s }

// testBox is shape-valid; these tests never open it.
func testBox() *SealedBox {
	return &SealedBox{V: 1, KID: "0123456789abcdef", EPK: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=", CT: "AAAAAAAAAAAAAAAAAAAAAA=="}
}

func validSpec() WorkloadSpec {
	return WorkloadSpec{
		ID:            "wl_1",
		Kind:          WorkloadService,
		ProjectID:     strPtr("prj_1"),
		EnvironmentID: strPtr("env_1"),
		ServiceID:     strPtr("svc_1"),
		DeploymentID:  strPtr("dep_1"),
		Image:         "nginx:1.27",
		EnvSealed:     testBox(),
		Ports:         []WorkloadPort{{ContainerPort: 8080, Protocol: PortHTTP}},
		Routes:        []WorkloadRoute{{Hostname: "web.example.com", ContainerPort: 8080}},
		Resources:     Resources{CPUMillis: 250, MemoryMB: 256, PIDs: 128},
		Restart:       Restart{Policy: RestartAlways},
		Network:       "roundhouse-prj_1-env_1",
		Labels:        map[string]string{},
		DrainS:        10,
		SpecHash:      strings.Repeat("0", 64),
	}
}

func validDesired() *DesiredState {
	return &DesiredState{
		Type:          TypeDesiredState,
		ControlHeader: ControlHeader{ID: "m1", NodeID: "node_a", IssuedAt: 1000, ExpiresAt: 1000 + CredentialFrameTTLMS},
		Generation:    1,
		Workloads:     []WorkloadSpec{validSpec()},
		TLSMode:       TLSInternal,
		AppsDomain:    strPtr("127.0.0.1.nip.io"),
	}
}

func validBuildJob() *BuildJob {
	return &BuildJob{
		Type:          TypeBuildJob,
		ControlHeader: ControlHeader{ID: "m1", NodeID: "node_a", IssuedAt: 1000, ExpiresAt: 1000 + CredentialFrameTTLMS},
		BuildID:       "bld_1",
		DeploymentID:  "dep_1",
		ProjectID:     "prj_1",
		ServiceID:     "svc_1",
		Source: GitBuildSource{
			Type:      "git",
			URL:       "https://github.com/acme/api.git",
			CommitSHA: strings.Repeat("a", 40),
		},
		Builder:         BuilderRailpack,
		ContextDir:      ".",
		BuildArgs:       map[string]string{},
		ImageRepository: "127.0.0.1:5000/prj_1/svc_1",
		CacheKey:        "prj_1.svc_1",
		TimeoutS:        600,
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestDecodeControlMessageRoundTrip(t *testing.T) {
	withSecret := validBuildJob()
	withSecret.BuildArgs = map[string]string{"NPM_TOKEN": "npm_x", "NODE_ENV": "production"}
	withSecret.SecretBuildArgs = []string{"NPM_TOKEN"}
	cancel := &BuildCancel{
		Type:          TypeBuildCancel,
		ControlHeader: ControlHeader{ID: "m1", NodeID: "node_a", IssuedAt: 1000, ExpiresAt: 2000},
		BuildID:       "bld_1",
	}
	for name, msg := range map[string]ControlMessage{
		"desired_state":   validDesired(),
		"build_job":       validBuildJob(),
		"secret_args_job": withSecret,
		"build_cancel":    cancel,
	} {
		t.Run(name, func(t *testing.T) {
			got, err := DecodeControlMessage(mustJSON(t, msg))
			if err != nil {
				t.Fatal(err)
			}
			if string(mustJSON(t, got)) != string(mustJSON(t, msg)) {
				t.Errorf("round trip changed the message")
			}
		})
	}
}

func TestWorkloadSpecValidate(t *testing.T) {
	if err := (&WorkloadSpec{}).Validate(); err == nil {
		t.Error("zero spec should be invalid")
	}
	spec := validSpec()
	if err := spec.Validate(); err != nil {
		t.Fatalf("valid spec rejected: %v", err)
	}
	cases := map[string]func(*WorkloadSpec){
		"service without ids":   func(w *WorkloadSpec) { w.ProjectID = nil },
		"system with ids":       func(w *WorkloadSpec) { w.Kind = WorkloadSystem; w.EnvSealed = nil },
		"service without box":   func(w *WorkloadSpec) { w.EnvSealed = nil },
		"box with bad kid":      func(w *WorkloadSpec) { w.EnvSealed.KID = "nope" },
		"box of v2":             func(w *WorkloadSpec) { w.EnvSealed.V = 2 },
		"other env network":     func(w *WorkloadSpec) { w.Network = "roundhouse-prj_1-env_2" },
		"other project network": func(w *WorkloadSpec) { w.Network = "roundhouse-prj_2-env_1" },
		"other project legacy":  func(w *WorkloadSpec) { w.Network = "roundhouse-prj_2" },
		"host network":          func(w *WorkloadSpec) { w.Network = "host" },
		"bridge network":        func(w *WorkloadSpec) { w.Network = "bridge" },
		"none network":          func(w *WorkloadSpec) { w.Network = "none" },
		"system network":        func(w *WorkloadSpec) { w.Network = "roundhouse-system" },
		"build network":         func(w *WorkloadSpec) { w.Network = "roundhouse-build" },
		"foreign local image":   func(w *WorkloadSpec) { w.Image = "127.0.0.1:5000/prj_1/svc_2@sha256:" + strings.Repeat("a", 64) },
		"tagged local image":    func(w *WorkloadSpec) { w.Image = "127.0.0.1:5000/prj_1/svc_1:latest" },
		"unknown kind":          func(w *WorkloadSpec) { w.Kind = "job" },
		"uppercase image":       func(w *WorkloadSpec) { w.Image = "Nginx" },
		"empty command":         func(w *WorkloadSpec) { w.Command = []string{} },
		"nul in argument":       func(w *WorkloadSpec) { w.Entrypoint = []string{"a\x00"} },
		"bad opened env name":   func(w *WorkloadSpec) { w.Env = map[string]string{"1X": ""} },
		"oversized env value":   func(w *WorkloadSpec) { w.Env = map[string]string{"A": strings.Repeat("x", MaxEnvValueBytes+1)} },
		"port zero":             func(w *WorkloadSpec) { w.Ports = []WorkloadPort{{ContainerPort: 0, Protocol: PortTCP}}; w.Routes = nil },
		"duplicate port":        func(w *WorkloadSpec) { w.Ports = append(w.Ports, WorkloadPort{ContainerPort: 8080, Protocol: PortTCP}) },
		"route to tcp port":     func(w *WorkloadSpec) { w.Ports[0].Protocol = PortTCP },
		"route to unknown port": func(w *WorkloadSpec) { w.Routes[0].ContainerPort = 9 },
		"duplicate route": func(w *WorkloadSpec) {
			w.Routes = append(w.Routes, WorkloadRoute{Hostname: "web.example.com", ContainerPort: 8080, PathPrefix: "/"})
		},
		"single-label hostname": func(w *WorkloadSpec) { w.Routes[0].Hostname = "localhost" },
		"long hostname":         func(w *WorkloadSpec) { w.Routes[0].Hostname = strings.Repeat("a.", 127) + "com" },
		"bad path prefix":       func(w *WorkloadSpec) { w.Routes[0].PathPrefix = "v1" },
		"http probe without path": func(w *WorkloadSpec) {
			w.Healthcheck = &Healthcheck{Type: HealthcheckHTTP, Port: 8080, IntervalS: 5, TimeoutS: 2}
		},
		"tcp probe with path": func(w *WorkloadSpec) {
			w.Healthcheck = &Healthcheck{Type: HealthcheckTCP, Path: "/x", Port: 8080, IntervalS: 5, TimeoutS: 2}
		},
		"tiny memory":     func(w *WorkloadSpec) { w.Resources.MemoryMB = 8 },
		"unknown restart": func(w *WorkloadSpec) { w.Restart.Policy = "sometimes" },
		"bad network":     func(w *WorkloadSpec) { w.Network = "-x" },
		"bad label":       func(w *WorkloadSpec) { w.Labels = map[string]string{"-x": ""} },
		"bad spec hash":   func(w *WorkloadSpec) { w.SpecHash = "ABC" },
		"bad registry auth": func(w *WorkloadSpec) {
			w.RegistryAuth = &RegistryAuth{Server: "ghcr.io/x", Username: "u", Password: "p"}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			w := validSpec()
			w.Ports = append([]WorkloadPort(nil), w.Ports...)
			w.Routes = append([]WorkloadRoute(nil), w.Routes...)
			mutate(&w)
			if err := w.Validate(); err == nil {
				t.Error("expected an error")
			}
		})
	}
}

func TestDesiredStateValidate(t *testing.T) {
	cases := map[string]func(*DesiredState){
		"system workload": func(m *DesiredState) {
			m.Workloads[0].Kind = WorkloadSystem
			m.Workloads[0].ProjectID, m.Workloads[0].EnvironmentID = nil, nil
			m.Workloads[0].ServiceID, m.Workloads[0].DeploymentID = nil, nil
		},
		"duplicate workload": func(m *DesiredState) { m.Workloads = append(m.Workloads, m.Workloads[0]) },
		"bad tls mode":       func(m *DesiredState) { m.TLSMode = "strict" },
		"bad apps domain":    func(m *DesiredState) { m.AppsDomain = strPtr("Apps.Example.com") },
		"registry elsewhere": func(m *DesiredState) {
			m.Registry = &RegistryConfig{Listen: "0.0.0.0:5000", Storage: RegistryStorage{Type: StorageFilesystem}}
		},
		"incomplete s3": func(m *DesiredState) {
			m.Registry = &RegistryConfig{Listen: RegistryListen, Storage: RegistryStorage{Type: StorageS3, Bucket: "b"}}
		},
		"long-lived registry auth": func(m *DesiredState) {
			m.Workloads[0].RegistryAuth = &RegistryAuth{Server: "ghcr.io", Username: "u", Password: "p"}
			m.ExpiresAt++
		},
		"long-lived s3 keys": func(m *DesiredState) {
			m.Registry = &RegistryConfig{Listen: RegistryListen, Storage: RegistryStorage{
				Type: StorageS3, Endpoint: "https://x.r2.cloudflarestorage.com", Bucket: "reg", Region: "auto",
				AccessKeyID: "a", SecretAccessKey: "b",
			}}
			m.ExpiresAt++
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			m := validDesired()
			mutate(m)
			if err := m.Validate(); err == nil {
				t.Error("expected an error")
			}
		})
	}

	t.Run("long-lived with a sealed env", func(t *testing.T) {
		m := validDesired()
		m.ExpiresAt += 1
		if err := m.Validate(); err == nil {
			t.Fatal("expected an error")
		}
	})

	t.Run("long-lived without credentials", func(t *testing.T) {
		m := validDesired()
		m.Workloads = nil
		m.ExpiresAt += 60_000
		if err := m.Validate(); err != nil {
			t.Fatal(err)
		}
	})
}

func TestBuildJobValidate(t *testing.T) {
	if err := validBuildJob().Validate(); err != nil {
		t.Fatalf("valid job rejected: %v", err)
	}
	cases := map[string]func(*BuildJob){
		"credentials in url":   func(j *BuildJob) { j.Source.URL = "https://x:y@github.com/a/b" },
		"http url":             func(j *BuildJob) { j.Source.URL = "http://github.com/a/b" },
		"short sha":            func(j *BuildJob) { j.Source.CommitSHA = "abc" },
		"escaping context":     func(j *BuildJob) { j.ContextDir = "../x" },
		"absolute context":     func(j *BuildJob) { j.ContextDir = "/etc" },
		"dockerfile, railpack": func(j *BuildJob) { j.DockerfilePath = "Dockerfile" },
		"escaping dockerfile": func(j *BuildJob) {
			j.Builder = BuilderDockerfile
			j.DockerfilePath = "a/../../b"
		},
		"foreign repository":  func(j *BuildJob) { j.ImageRepository = "ghcr.io/acme/api" },
		"tagged repository":   func(j *BuildJob) { j.ImageRepository = "127.0.0.1:5000/a/b:latest" },
		"bad build arg":       func(j *BuildJob) { j.BuildArgs = map[string]string{"a-b": ""} },
		"short timeout":       func(j *BuildJob) { j.TimeoutS = 5 },
		"other service repo":  func(j *BuildJob) { j.ImageRepository = "127.0.0.1:5000/prj_1/svc_2" },
		"other project cache": func(j *BuildJob) { j.CacheKey = "prj_2.svc_1" },
		"missing project":     func(j *BuildJob) { j.ProjectID = "" },
		"option-like ref":     func(j *BuildJob) { j.Source.Ref = "--upload-pack=sh" },
		"dotdot ref":          func(j *BuildJob) { j.Source.Ref = "a..b" },
		"bad secrets box":     func(j *BuildJob) { j.BuildSecretsSealed = &SealedBox{V: 1, KID: "x"} },
		"long-lived secrets": func(j *BuildJob) {
			j.BuildSecretsSealed = testBox()
			j.ExpiresAt++
		},
		"unknown builder": func(j *BuildJob) { j.Builder = "nixpacks" },
		"long-lived token": func(j *BuildJob) {
			j.Source.Token = "ghs_x"
			j.ExpiresAt++
		},
		"secret arg that is not a build arg": func(j *BuildJob) { j.SecretBuildArgs = []string{"NPM_TOKEN"} },
		"secret arg listed twice": func(j *BuildJob) {
			j.BuildArgs = map[string]string{"NPM_TOKEN": "x"}
			j.SecretBuildArgs = []string{"NPM_TOKEN", "NPM_TOKEN"}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			j := validBuildJob()
			mutate(j)
			if err := j.Validate(); err == nil {
				t.Error("expected an error")
			}
		})
	}
}

func TestDecodeControlMessageShape(t *testing.T) {
	base := string(mustJSON(t, validDesired()))
	cases := map[string]string{
		// A nested key differing only by case would be read by Go but not by
		// the TypeScript signer.
		"nested case-variant key": strings.Replace(base, `"image":"nginx:1.27"`, `"image":"nginx:1.27","IMAGE":"evil:1"`, 1),
		"deep case-variant key":   strings.Replace(base, `"memory_mb":256`, `"memory_mb":256,"Memory_MB":1`, 1),
		"missing nested field":    strings.Replace(base, `"pids":128`, `"pidz":128`, 1),
		"null required map":       strings.Replace(base, `"labels":{}`, `"labels":null`, 1),
		"missing nullable field":  strings.Replace(base, `"apps_domain":"127.0.0.1.nip.io",`, ``, 1),
		"null array element":      strings.Replace(base, `"workloads":[`, `"workloads":[null,`, 1),
		"fractional number":       strings.Replace(base, `"replica":0`, `"replica":0.5`, 1),
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			if payload == base {
				t.Fatal("replacement did not apply")
			}
			if _, err := DecodeControlMessage([]byte(payload)); err == nil {
				t.Error("expected an error")
			}
		})
	}

	t.Run("nullable fields may be null", func(t *testing.T) {
		m := validDesired()
		m.AppsDomain = nil
		if _, err := DecodeControlMessage(mustJSON(t, m)); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("unknown nested fields are ignored", func(t *testing.T) {
		payload := strings.Replace(base, `"pids":128`, `"pids":128,"future":true`, 1)
		if _, err := DecodeControlMessage([]byte(payload)); err != nil {
			t.Fatal(err)
		}
	})
}

func TestDecodeAgentMessageStrict(t *testing.T) {
	status := `{"type":"workload_status","workload_id":"wl_1","deployment_id":null,"state":"running","restarts":0,"ts":1}`
	if _, err := DecodeAgentMessage([]byte(status)); err != nil {
		t.Fatalf("valid status rejected: %v", err)
	}
	long := strings.Repeat("x", MaxLogLineBytes)
	var lines []string
	for range MaxLogFrameTextBytes / MaxLogLineBytes {
		lines = append(lines, `{"ts":1,"stream":"stdout","text":"`+long+`"}`)
	}
	cases := map[string]string{
		"case-variant key":       `{"type":"workload_status","workload_id":"wl_1","Workload_ID":"wl_2","deployment_id":null,"state":"running","restarts":0,"ts":1}`,
		"unknown field":          `{"type":"workload_status","workload_id":"wl_1","deployment_id":null,"state":"running","restarts":0,"ts":1,"x":1}`,
		"missing nullable field": `{"type":"workload_status","workload_id":"wl_1","state":"running","restarts":0,"ts":1}`,
		"unknown state":          `{"type":"workload_status","workload_id":"wl_1","deployment_id":null,"state":"dead","restarts":0,"ts":1}`,
		"bad container id":       `{"type":"workload_status","workload_id":"wl_1","deployment_id":null,"state":"running","container_id":"XYZ","restarts":0,"ts":1}`,
		"exit code out of range": `{"type":"workload_status","workload_id":"wl_1","deployment_id":null,"state":"crashed","exit_code":256,"restarts":0,"ts":1}`,
		"empty logs":             `{"type":"logs","source":{"type":"build","build_id":"bld_1"},"lines":[]}`,
		"runtime without dep":    `{"type":"logs","source":{"type":"runtime","workload_id":"wl_1"},"lines":[{"ts":1,"stream":"stdout","text":""}]}`,
		"mixed source":           `{"type":"logs","source":{"type":"build","build_id":"bld_1","workload_id":"wl_1"},"lines":[{"ts":1,"stream":"stdout","text":""}]}`,
		"unknown stream":         `{"type":"logs","source":{"type":"build","build_id":"bld_1"},"lines":[{"ts":1,"stream":"tty","text":""}]}`,
		"long line":              `{"type":"logs","source":{"type":"build","build_id":"bld_1"},"lines":[{"ts":1,"stream":"stdout","text":"` + long + `x"}]}`,
		"frame over text budget": `{"type":"logs","source":{"type":"build","build_id":"bld_1"},"lines":[` + strings.Join(lines, ",") + `,{"ts":1,"stream":"stdout","text":"x"}]}`,
		"ok without image":       `{"type":"build_result","build_id":"bld_1","ok":true,"duration_ms":1}`,
		"failed without error":   `{"type":"build_result","build_id":"bld_1","ok":false,"duration_ms":1}`,
		"failed with image":      `{"type":"build_result","build_id":"bld_1","ok":false,"error":"x","image":{"repository":"a/b","digest":"sha256:` + strings.Repeat("a", 64) + `"},"duration_ms":1}`,
		"bad hello status":       strings.Replace(string(readFixture(t, "hello-statuses.json")), `"state": "healthy"`, `"state": "great"`, 1),
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := DecodeAgentMessage([]byte(payload)); err == nil {
				t.Error("expected an error")
			}
		})
	}
	t.Run("frame at text budget", func(t *testing.T) {
		payload := `{"type":"logs","source":{"type":"build","build_id":"bld_1"},"lines":[` + strings.Join(lines, ",") + `]}`
		if _, err := DecodeAgentMessage([]byte(payload)); err != nil {
			t.Fatal(err)
		}
	})
}

func TestVerifyRejectsLongLivedCredentials(t *testing.T) {
	pub, priv := newKey(t)
	job := validBuildJob()
	job.Source.Token = "ghs_x"
	job.ExpiresAt = job.IssuedAt + CredentialFrameTTLMS + 1
	env, err := SignEnvelope(job, priv, "k1")
	if err != nil {
		t.Fatal(err)
	}
	assertRejected(t, env, pub, "node_a", time.UnixMilli(1500), ErrMalformed)
}

func TestCanonicalJSON(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{`null`, `null`},
		{`true`, `true`},
		{`0`, `0`},
		{`-42`, `-42`},
		{`9007199254740991`, `9007199254740991`},
		{`""`, `""`},
		{`[]`, `[]`},
		{`{}`, `{}`},
		{`[1,null,"a"]`, `[1,null,"a"]`},
		{`{"b":1,"a":2}`, `{"a":2,"b":1}`},
		{`{"a":null,"c":1}`, `{"c":1}`},
		{`{"Z":1,"a":2,"_":3}`, `{"Z":1,"_":3,"a":2}`},
		{`{"nested":{"y":[{"b":1,"a":0}],"x":{}}}`, `{"nested":{"x":{},"y":[{"a":0,"b":1}]}}`},
		{`"a\"b\\c"`, `"a\"b\\c"`},
		{`"\u0000\b\t\n\u001f"`, `"\u0000\u0008\u0009\u000a\u001f"`},
		{`"<&>\u007f  é🚀"`, "\"<&>\u007f  é🚀\""},
		// Non-BMP keys sort by UTF-16 code unit, as JavaScript does: U+1F680
		// encodes as 0xD83D, which sorts before U+FFFF.
		{`{"￿":1,"🚀":2}`, "{\"🚀\":2,\"￿\":1}"},
	}
	for _, c := range cases {
		dec := json.NewDecoder(strings.NewReader(c.in))
		dec.UseNumber()
		var v any
		if err := dec.Decode(&v); err != nil {
			t.Fatalf("%s: %v", c.in, err)
		}
		got, err := CanonicalJSON(v)
		if err != nil {
			t.Fatalf("%s: %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("%s: got %s, want %s", c.in, got, c.want)
		}
	}
	for _, bad := range []any{json.Number("1.5"), json.Number("1e3"), json.Number("9007199254740992"), 3.5} {
		if _, err := CanonicalJSON(bad); err == nil {
			t.Errorf("%v: expected an error", bad)
		}
	}
}

func TestComputeSpecHashExclusions(t *testing.T) {
	base := validSpec()
	want, err := ComputeSpecHash(base)
	if err != nil {
		t.Fatal(err)
	}
	unchanged := map[string]func(*WorkloadSpec){
		"spec_hash":     func(w *WorkloadSpec) { w.SpecHash = strings.Repeat("1", 64) },
		"routes":        func(w *WorkloadSpec) { w.Routes = nil },
		"registry_auth": func(w *WorkloadSpec) { w.RegistryAuth = &RegistryAuth{Server: "a", Username: "b", Password: "c"} },
		"drain_s":       func(w *WorkloadSpec) { w.DrainS = 600 },
		"env_sealed": func(w *WorkloadSpec) {
			w.EnvSealed = &SealedBox{V: 1, KID: "fedcba9876543210", EPK: testBox().EPK, CT: "BBBB"}
		},
		"opened env": func(w *WorkloadSpec) {
			w.Env = map[string]string{"PORT": "8081"}
			w.SecretFiles = map[string]string{"K": "v"}
		},
		"nil maps": func(w *WorkloadSpec) { w.Labels = nil },
	}
	for name, mutate := range unchanged {
		w := validSpec()
		mutate(&w)
		if got, _ := ComputeSpecHash(w); got != want {
			t.Errorf("%s changed the hash", name)
		}
	}
	changed := map[string]func(*WorkloadSpec){
		"image":   func(w *WorkloadSpec) { w.Image = "nginx:1.28" },
		"network": func(w *WorkloadSpec) { w.Network = "roundhouse-prj_1-env_2" },
		"command": func(w *WorkloadSpec) { w.Command = []string{"sh"} },
		"replica": func(w *WorkloadSpec) { w.Replica = 1 },
	}
	for name, mutate := range changed {
		w := validSpec()
		mutate(&w)
		if got, _ := ComputeSpecHash(w); got == want {
			t.Errorf("%s did not change the hash", name)
		}
	}
}

func TestTruncateLogLine(t *testing.T) {
	if got := TruncateLogLine("hello"); got != "hello" {
		t.Errorf("got %q", got)
	}
	if got := TruncateLogLine(strings.Repeat("x", MaxLogLineBytes+5)); len(got) != MaxLogLineBytes {
		t.Errorf("got %d bytes", len(got))
	}
	// 'é' is two bytes, so an odd budget must drop the partial character.
	got := truncateUTF8("aéé", 4)
	if got != "aé" {
		t.Errorf("got %q", got)
	}
	if got := TruncateLogLine("a\xffb"); got != "a�b" {
		t.Errorf("invalid UTF-8 not replaced: %q", got)
	}
}

func TestIsSafeRelativePath(t *testing.T) {
	for _, p := range []string{".", "Dockerfile", "apps/web", "a/./b", "..foo", "foo.."} {
		if !IsSafeRelativePath(p) {
			t.Errorf("%q should be safe", p)
		}
	}
	for _, p := range []string{"", "/etc", "..", "../x", "a/../b", "a/..", `a\b`, "a b", "~/x"} {
		if IsSafeRelativePath(p) {
			t.Errorf("%q should be unsafe", p)
		}
	}
}

func TestBuildCancelValidate(t *testing.T) {
	c := &BuildCancel{Type: TypeBuildCancel, ControlHeader: ControlHeader{ID: "m", NodeID: "n", IssuedAt: 1, ExpiresAt: 2}, BuildID: "bld_1"}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.BuildID = "nope"
	if err := c.Validate(); err == nil {
		t.Error("expected an invalid build id to be rejected")
	}
	if _, err := DecodeControlMessage([]byte(`{"type":"build_cancel","id":"m","node_id":"n","iat":1,"exp":2}`)); err == nil {
		t.Error("expected a cancel without build_id to be rejected")
	}
}

func TestBuildResultCancelled(t *testing.T) {
	ok := &BuildResult{Type: TypeBuildResult, BuildID: "bld_1", OK: true, Cancelled: true,
		Image: &BuiltImage{Repository: "127.0.0.1:5000/a/b", Digest: "sha256:" + strings.Repeat("a", 64)}}
	if err := ok.Validate(); err == nil {
		t.Error("a successful result cannot be cancelled")
	}
	failed := &BuildResult{Type: TypeBuildResult, BuildID: "bld_1", Error: "Build was cancelled.", Cancelled: true}
	if err := failed.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestEnvironmentNetworkName(t *testing.T) {
	prod := EnvironmentNetworkName("prj_1", "env_prod")
	staging := EnvironmentNetworkName("prj_1", "env_staging")
	if prod != "roundhouse-prj_1-env_prod" || staging == prod {
		t.Errorf("got %q and %q", prod, staging)
	}
	long := EnvironmentNetworkName("prj_"+strings.Repeat("a", 64), "env_"+strings.Repeat("b", 64))
	if !strings.HasPrefix(long, HashedNetworkPrefix) || len(long) > MaxNetworkNameLength || !networkRE.MatchString(long) {
		t.Errorf("long ids gave %q", long)
	}
}

func TestServiceNetworkAllowed(t *testing.T) {
	for network, want := range map[string]bool{
		"roundhouse-prj_1-env_1":  true,
		"roundhouse-prj_1":        true,
		"roundhouse-prj_1-env_2":  false,
		"roundhouse-prj_2-env_1":  false,
		"roundhouse-prj_2":        false,
		"host":                    false,
		"bridge":                  false,
		"none":                    false,
		"roundhouse-system":       false,
		"roundhouse-build":        false,
		"roundhouse-env-deadbeef": false,
	} {
		if got := ServiceNetworkAllowed(network, "prj_1", "env_1"); got != want {
			t.Errorf("ServiceNetworkAllowed(%q) = %v, want %v", network, got, want)
		}
	}
}

func TestWorkloadSpecAcceptsLegacyAndHashedNetworks(t *testing.T) {
	legacy := validSpec()
	legacy.Network = ProjectNetworkName(*legacy.ProjectID)
	if err := legacy.Validate(); err != nil {
		t.Errorf("legacy project network: %v", err)
	}
	hashed := validSpec()
	project, env := "prj_"+strings.Repeat("a", 64), "env_"+strings.Repeat("b", 64)
	hashed.ProjectID, hashed.EnvironmentID = &project, &env
	hashed.Network = EnvironmentNetworkName(project, env)
	if err := hashed.Validate(); err != nil {
		t.Errorf("hashed network: %v", err)
	}
	hashed.Network = HashedNetworkPrefix + strings.Repeat("0", 64)
	if hashed.Validate() == nil {
		t.Error("accepted a hashed network of other ids")
	}
}

func TestLocalImageRepository(t *testing.T) {
	repo := LocalImageRepository("prj_01JABC", "svc_01JXYZ")
	if repo != "127.0.0.1:5000/prj_01jabc/svc_01jxyz" || !imageRepositoryRE.MatchString(repo) {
		t.Errorf("got %q", repo)
	}
}

// TestProtocolVersions pins the ADR 0015 plan; messages.test.ts and
// phase23.test.ts pin the TypeScript constants to the same values.
func TestProtocolVersions(t *testing.T) {
	if ProtocolVersion != 6 || MinProtocolVersion != 3 {
		t.Errorf("versions %d..%d, want 3..6", MinProtocolVersion, ProtocolVersion)
	}
	for name, v := range map[string]int{
		"mesh": MeshProtocolVersion, "volumes": VolumesProtocolVersion, "backups": BackupsProtocolVersion,
		"db_query": DBQueryProtocolVersion, "key_rollover": KeyRolloverProtocolVersion,
	} {
		if v != 5 {
			t.Errorf("%s gate %d, want 5", name, v)
		}
	}
	for name, v := range map[string]int{
		"jobs": JobsProtocolVersion, "metrics": MetricsProtocolVersion, "certs": CertsProtocolVersion,
	} {
		if v != 6 {
			t.Errorf("%s gate %d, want 6", name, v)
		}
	}
	if SealedEnvProtocolVersion != 4 || WorkloadsProtocolVersion != 2 {
		t.Errorf("gates sealed=%d workloads=%d", SealedEnvProtocolVersion, WorkloadsProtocolVersion)
	}
	if BuildCancelProtocolVersion != 3 || SecretBuildArgsProtocolVersion != 3 {
		t.Errorf("gates cancel=%d secret_build_args=%d", BuildCancelProtocolVersion, SecretBuildArgsProtocolVersion)
	}
}
