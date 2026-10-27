package runtime

import (
	"bytes"
	"errors"
	"log/slog"
	"net/netip"
	"os"
	"path/filepath"
	goruntime "runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

const (
	testBcryptA = "$2a$10$wXcTLh2gQ5NcQXYujJHehuZZcQeNFkuCgvT6xI4ziOgPbP9L/49pC"
	testBcryptB = "$2y$10$abcdefghijklmnopqrstuuJ8a7S8e9k3Jq1Fz0C9dWgk0xN1Kc1Wa"
)

func registryMesh() *protocol.MeshConfig {
	m := meshFor()
	m.NodeAddresses = []string{"10.200.1.1", "10.200.2.1"}
	return m
}

func fsPrimary() *protocol.RegistryConfig {
	return &protocol.RegistryConfig{Listen: protocol.RegistryListen, Storage: protocol.RegistryStorage{Type: protocol.StorageFilesystem}}
}

func s3Storage() protocol.RegistryStorage {
	return protocol.RegistryStorage{
		Type: protocol.StorageS3, Endpoint: "https://acct.r2.cloudflarestorage.com", Bucket: "registry", Region: "auto",
		AccessKeyID: "AKREAD", SecretAccessKey: "s3-secret-value",
	}
}

func proxyConfig(url string) *protocol.RegistryConfig {
	return &protocol.RegistryConfig{
		Listen: protocol.RegistryListen, Mode: protocol.RegistryProxy,
		Storage:  protocol.RegistryStorage{Type: protocol.StorageFilesystem},
		Upstream: &protocol.RegistryUpstream{URL: url, Username: "node_b", PasswordSealed: protocol.SealedBox{CT: "sealed"}},
	}
}

func openPassword(gen int64, u *protocol.RegistryUpstream) (string, error) {
	if u.PasswordSealed.CT != "sealed" {
		return "", errors.New("wrong key")
	}
	return "upstream-password-value", nil
}

func dsWith(reg *protocol.RegistryConfig, mesh *protocol.MeshConfig) *protocol.DesiredState {
	ds := desired(3)
	ds.Registry, ds.Mesh = reg, mesh
	return ds
}

func env(s *wantSpec, key string) string { return s.Env[key] }

// TestPrimaryHashesUnchanged pins the hashes of the primaries earlier
// agents ran: a change would recreate every builder's registry on upgrade.
func TestPrimaryHashesUnchanged(t *testing.T) {
	fs := registrySpecs(planRegistry(dsWith(fsPrimary(), nil), nil), "/var/lib/roundhouse", 1)
	s3cfg := fsPrimary()
	s3cfg.Storage = protocol.RegistryStorage{Type: protocol.StorageS3, Endpoint: "https://e", Bucket: "b", Region: "auto", AccessKeyID: "a", SecretAccessKey: "s"}
	s3 := registrySpecs(planRegistry(dsWith(s3cfg, nil), nil), "/var/lib/roundhouse", 1)
	if len(fs) != 1 || fs[0].SpecHash != "94df5ee31f38aef43076504b48d506d5bd9627763a6af5be168b95d8751cd016" {
		t.Errorf("filesystem primary hash changed: %s", fs[0].SpecHash)
	}
	if len(s3) != 1 || s3[0].SpecHash != "efc5b545350402ecf0c93ba25f3e774db053954b4b0c96fdb21024dbe1e45880" {
		t.Errorf("S3 primary hash changed: %s", s3[0].SpecHash)
	}
}

func TestRegistryReplica(t *testing.T) {
	cfg := fsPrimary()
	cfg.Mode, cfg.Storage = protocol.RegistryReplica, s3Storage()
	specs := registrySpecs(planRegistry(dsWith(cfg, nil), nil), "/data", 1)
	if len(specs) != 1 {
		t.Fatalf("%d specs", len(specs))
	}
	s := specs[0]
	for k, want := range map[string]string{
		"REGISTRY_STORAGE":                           "s3",
		"REGISTRY_STORAGE_S3_BUCKET":                 "registry",
		"REGISTRY_STORAGE_S3_ACCESSKEY":              "AKREAD",
		"REGISTRY_STORAGE_S3_SECRETKEY":              "s3-secret-value",
		"REGISTRY_STORAGE_MAINTENANCE_READONLY":      `{"enabled":true}`,
		"REGISTRY_STORAGE_MAINTENANCE_UPLOADPURGING": `{"enabled":false}`,
		"REGISTRY_STORAGE_DELETE_ENABLED":            "false",
	} {
		if got := env(s, k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if s.binds != nil || s.files != nil || s.blocked != "" || s.Healthcheck.Path != "/v2/" {
		t.Errorf("replica spec: binds %v files %v blocked %q", s.binds, s.files, s.blocked)
	}
	if b := s.hostPorts["5000/tcp"]; len(b) != 1 || b[0].HostIP != "127.0.0.1" {
		t.Errorf("ports %v", s.hostPorts)
	}
	if err := s.Validate(); err != nil {
		t.Error(err)
	}
}

func TestRegistryProxy(t *testing.T) {
	plan := planRegistry(dsWith(proxyConfig("http://10.200.2.1:5000/"), registryMesh()), openPassword)
	specs := registrySpecs(plan, "/data", 1)
	if len(specs) != 1 || plan.blocked != "" {
		t.Fatalf("%d specs, blocked %q", len(specs), plan.blocked)
	}
	s := specs[0]
	for k, want := range map[string]string{
		"REGISTRY_PROXY_REMOTEURL":        "http://10.200.2.1:5000",
		"REGISTRY_PROXY_USERNAME":         "node_b",
		"REGISTRY_PROXY_PASSWORD":         "upstream-password-value",
		"REGISTRY_STORAGE_DELETE_ENABLED": "false",
	} {
		if got := env(s, k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if _, ok := s.Env["REGISTRY_STORAGE_MAINTENANCE_READONLY"]; ok {
		t.Error("a proxy must write its cache")
	}
	if !slices.Equal(s.binds, []string{"/data/registry-cache:/var/lib/registry"}) {
		t.Errorf("binds %v", s.binds)
	}
	if plan.upstream != netip.MustParseAddrPort("10.200.2.1:5000") {
		t.Errorf("upstream %v", plan.upstream)
	}
	if err := s.Validate(); err != nil {
		t.Error(err)
	}
}

func TestRegistryRefusals(t *testing.T) {
	cases := []struct {
		name string
		reg  *protocol.RegistryConfig
		mesh *protocol.MeshConfig
		open func(int64, *protocol.RegistryUpstream) (string, error)
		want string
	}{
		{"proxy without mesh", proxyConfig("http://10.200.2.1:5000"), nil, openPassword, "not in the mesh"},
		{"upstream not a node", proxyConfig("http://10.200.2.10:5000"), registryMesh(), openPassword, "not another node's registry"},
		{"upstream is this node", proxyConfig("http://10.200.1.1:5000"), registryMesh(), openPassword, "not another node's registry"},
		{"upstream port", proxyConfig("http://10.200.2.1:2019"), registryMesh(), openPassword, "not another node's registry"},
		{"upstream host name", proxyConfig("http://metadata.internal:5000"), registryMesh(), openPassword, "not another node's registry"},
		{"upstream https", proxyConfig("https://10.200.2.1:5000"), registryMesh(), openPassword, "is not http://"},
		{"upstream path", proxyConfig("http://10.200.2.1:5000/v2"), registryMesh(), openPassword, "is not http://"},
		{"no key", proxyConfig("http://10.200.2.1:5000"), registryMesh(), nil, "no key"},
		{"wrong key", func() *protocol.RegistryConfig {
			c := proxyConfig("http://10.200.2.1:5000")
			c.Upstream.PasswordSealed.CT = "other"
			return c
		}(), registryMesh(), openPassword, "wrong key"},
	}
	for _, tc := range cases {
		plan := planRegistry(dsWith(tc.reg, tc.mesh), tc.open)
		s := registrySpecs(plan, "/data", 1)[0]
		if !strings.Contains(plan.blocked, tc.want) || s.blocked != plan.blocked {
			t.Errorf("%s: blocked %q, want %q", tc.name, plan.blocked, tc.want)
		}
		if _, ok := s.Env["REGISTRY_PROXY_PASSWORD"]; ok {
			t.Errorf("%s: a refused proxy carries a password", tc.name)
		}
	}

	listen := func(addr string) *protocol.RegistryConfig {
		c := fsPrimary()
		c.MeshListen = addr
		return c
	}
	for name, tc := range map[string]struct {
		reg  *protocol.RegistryConfig
		mesh *protocol.MeshConfig
	}{
		"listener without mesh":  {listen("10.200.1.1:5000"), nil},
		"another node's address": {listen("10.200.2.1:5000"), registryMesh()},
	} {
		plan := planRegistry(dsWith(tc.reg, tc.mesh), nil)
		specs := registrySpecs(plan, "/data", 1)
		if len(specs) != 2 || specs[0].blocked != "" || specs[1].blocked == "" || specs[1].hostPorts != nil {
			t.Errorf("%s: primary blocked %q, listener blocked %q ports %v", name, specs[0].blocked, specs[1].blocked, specs[1].hostPorts)
		}
	}
}

func TestRegistryMeshListener(t *testing.T) {
	cfg := fsPrimary()
	cfg.MeshListen = "10.200.1.1:5000"
	cfg.PullUsers = []protocol.RegistryPullUser{{Username: "node_c", Bcrypt: testBcryptB}, {Username: "node_b", Bcrypt: testBcryptA}}
	specs := registrySpecs(planRegistry(dsWith(cfg, registryMesh()), nil), "/data", 1)
	if len(specs) != 2 {
		t.Fatalf("%d specs", len(specs))
	}
	primary, mesh := specs[0], specs[1]
	if primary.ID != RegistryWorkloadID || mesh.ID != RegistryMeshWorkloadID {
		t.Fatalf("ids %s %s", primary.ID, mesh.ID)
	}
	if _, ok := primary.Env["REGISTRY_AUTH"]; ok || primary.Env["REGISTRY_STORAGE_DELETE_ENABLED"] != "true" {
		t.Errorf("primary env %v", primary.Env)
	}
	for k, want := range map[string]string{
		"REGISTRY_AUTH":                         "htpasswd",
		"REGISTRY_AUTH_HTPASSWD_PATH":           "/auth/htpasswd",
		"REGISTRY_STORAGE_MAINTENANCE_READONLY": `{"enabled":true}`,
		"REGISTRY_STORAGE_DELETE_ENABLED":       "false",
	} {
		if got := env(mesh, k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if b := mesh.hostPorts["5000/tcp"]; len(b) != 1 || b[0].HostIP != "10.200.1.1" || b[0].HostPort != "5000" {
		t.Errorf("listener ports %v", mesh.hostPorts)
	}
	if mesh.bindAddr != netip.MustParseAddr("10.200.1.1") || mesh.Healthcheck.Path != "/" || !mesh.exclusive {
		t.Errorf("listener bind %v health %q", mesh.bindAddr, mesh.Healthcheck.Path)
	}
	if !slices.Equal(mesh.binds, []string{"/data/registry:/var/lib/registry:ro", "/data/registry-auth:/auth:ro"}) {
		t.Errorf("listener binds %v", mesh.binds)
	}
	want := "node_b:" + testBcryptA + "\nnode_c:" + testBcryptB + "\n"
	if len(mesh.files) != 1 || string(mesh.files[0].data) != want || filepath.ToSlash(mesh.files[0].path) != "/data/registry-auth/htpasswd" {
		t.Errorf("files %+v", mesh.files)
	}
	if err := mesh.Validate(); err != nil {
		t.Error(err)
	}

	// A new pull user recreates the listener, not the primary.
	cfg2 := *cfg
	cfg2.PullUsers = cfg.PullUsers[:1]
	specs2 := registrySpecs(planRegistry(dsWith(&cfg2, registryMesh()), nil), "/data", 1)
	if specs2[0].SpecHash != primary.SpecHash || specs2[1].SpecHash == mesh.SpecHash {
		t.Error("pull users changed the wrong hash")
	}
	// A proxy or an S3 primary never gets a listener.
	s3 := fsPrimary()
	s3.Storage = s3Storage()
	if n := len(registrySpecs(planRegistry(dsWith(s3, registryMesh()), nil), "/data", 1)); n != 1 {
		t.Errorf("S3 primary: %d specs", n)
	}
}

// TestRegistryMeshListenerRuns drives the runtime: the listener waits for
// the mesh address, its htpasswd is written 0600, and no secret reaches
// the logs.
func TestRegistryMeshListenerRuns(t *testing.T) {
	dir := t.TempDir()
	var up atomic.Bool
	logMu := &syncBuffer{}
	h := newHarness(t, func(o *Options) {
		o.DataDir = dir
		o.HasAddress = func(a netip.Addr) bool { return up.Load() && a == netip.MustParseAddr("10.200.1.1") }
		o.Logger = slog.New(slog.NewTextHandler(logMu, &slog.HandlerOptions{Level: slog.LevelDebug}))
	})
	cfg := fsPrimary()
	cfg.MeshListen = "10.200.1.1:5000"
	cfg.PullUsers = []protocol.RegistryPullUser{{Username: "node_b", Bcrypt: testBcryptA}}
	ds := desired(1)
	ds.Registry, ds.Mesh = cfg, registryMesh()
	h.rt.Apply(ds)
	h.running(RegistryWorkloadID)
	eventually(t, "the listener to wait for the mesh address", func() bool {
		st, ok := h.status.lastOf(RegistryMeshWorkloadID)
		return ok && strings.Contains(st.Message, "waiting for 10.200.1.1")
	})
	if len(h.d.byWorkload(RegistryMeshWorkloadID)) != 0 {
		t.Fatal("listener created before its address was up")
	}
	up.Store(true)
	c := h.running(RegistryMeshWorkloadID)
	if b := c.spec.HostConfig.PortBindings["5000/tcp"]; len(b) != 1 || b[0].HostIP != "10.200.1.1" {
		t.Errorf("ports %v", c.spec.HostConfig.PortBindings)
	}
	path := filepath.Join(dir, registryAuthDir, "htpasswd")
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "node_b:"+testBcryptA+"\n" {
		t.Fatalf("htpasswd %q %v", data, err)
	}
	if goruntime.GOOS != "windows" {
		for p, want := range map[string]os.FileMode{path: 0o600, filepath.Dir(path): 0o700} {
			if fi, err := os.Stat(p); err != nil || fi.Mode().Perm() != want {
				t.Errorf("%s mode %v, want %v (%v)", p, fi.Mode().Perm(), want, err)
			}
		}
	}

	// Proxy mode on the same node: the listener goes, the proxy is reported
	// to the mesh, and its password never reaches a log line.
	mesh := &fakeMesh{}
	h2 := newHarness(t, func(o *Options) {
		o.DataDir = t.TempDir()
		o.Mesh = mesh
		o.OpenRegistryUpstream = openPassword
		o.Logger = slog.New(slog.NewTextHandler(logMu, &slog.HandlerOptions{Level: slog.LevelDebug}))
	})
	ds2 := desired(1)
	ds2.Registry, ds2.Mesh = proxyConfig("http://10.200.2.1:5000"), registryMesh()
	h2.rt.Apply(ds2)
	p := h2.running(RegistryWorkloadID)
	eventually(t, "the proxy reported to the mesh", func() bool {
		got := mesh.registryProxy()
		return got.BridgeIP.String() == p.ip && got.Upstream == netip.MustParseAddrPort("10.200.2.1:5000")
	})
	if !slices.Contains(p.spec.Env, "REGISTRY_PROXY_PASSWORD=upstream-password-value") {
		t.Errorf("proxy env %v", p.spec.Env)
	}
	h2.rt.Apply(desired(2))
	eventually(t, "the proxy to leave the mesh", func() bool { return mesh.registryProxy() == RegistryProxy{} })
	h.stop()
	h2.stop()
	if s := logMu.String(); strings.Contains(s, "upstream-password-value") || strings.Contains(s, testBcryptA) {
		t.Errorf("a secret reached the logs:\n%s", s)
	}
}

// syncBuffer is a log sink two runtimes write to at once.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}
