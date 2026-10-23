package ingress

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Open-Rail/agent/internal/leaktest"
	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
)

var update = flag.Bool("update", false, "rewrite golden files")

var sampleRoutes = []Route{
	{Host: "api.example.com", PathPrefix: "/v1", Upstreams: []string{"172.18.0.3:3000"}},
	{Host: "api.example.com", Upstreams: []string{"172.18.0.2:3000"}},
	{Host: "API.example.com", PathPrefix: "/v1/", Upstreams: []string{"172.18.0.4:3000", "172.18.0.3:3000"}},
	{Host: "web-production-x7k2.127.0.0.1.nip.io", PathPrefix: "/", Upstreams: []string{"172.19.0.2:8080"}},
	{Host: "idle.example.com", Upstreams: nil},
	{Host: "starting.example.com", Ports: []int{8080}},
	{Host: "moving.example.com", Upstreams: []string{"172.20.0.2:3000"}, Ports: []int{4000}},
}

func TestBuildConfigGolden(t *testing.T) {
	opts := BuildOptions{AdminListen: DefaultAdminListen, AskURL: DefaultAskURL}
	for _, mode := range []protocol.TLSMode{protocol.TLSOff, protocol.TLSInternal, protocol.TLSACME} {
		t.Run(string(mode), func(t *testing.T) {
			got := BuildConfig(Config{TLSMode: mode, Routes: sampleRoutes}, opts)
			var pretty bytes.Buffer
			if err := json.Indent(&pretty, got, "", "  "); err != nil {
				t.Fatal(err)
			}
			pretty.WriteByte('\n')
			golden := filepath.Join("testdata", "caddy-"+string(mode)+".json")
			if *update {
				if err := os.WriteFile(golden, pretty.Bytes(), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(golden)
			if err != nil {
				t.Fatalf("%v (run with -update to create)", err)
			}
			if !bytes.Equal(bytes.ReplaceAll(want, []byte("\r\n"), []byte("\n")), pretty.Bytes()) {
				t.Fatalf("config differs from %s; run with -update if intended:\n%s", golden, pretty.String())
			}
		})
	}
}

func TestBuildConfigDeterministic(t *testing.T) {
	a := BuildConfig(Config{TLSMode: protocol.TLSInternal, Routes: sampleRoutes}, BuildOptions{})
	reversed := slices.Clone(sampleRoutes)
	slices.Reverse(reversed)
	b := BuildConfig(Config{TLSMode: protocol.TLSInternal, Routes: reversed}, BuildOptions{})
	if Hash(a) != Hash(b) {
		t.Fatal("route order changed the config")
	}
	c := BuildConfig(Config{TLSMode: protocol.TLSInternal, Routes: sampleRoutes[:1]}, BuildOptions{})
	if Hash(a) == Hash(c) {
		t.Fatal("different routes gave the same hash")
	}
}

func TestInternalWithoutRoutesHasNoTLSPolicy(t *testing.T) {
	var cfg struct {
		Apps map[string]json.RawMessage `json:"apps"`
	}
	if err := json.Unmarshal(BuildConfig(Config{TLSMode: protocol.TLSInternal}, BuildOptions{}), &cfg); err != nil {
		t.Fatal(err)
	}
	if _, ok := cfg.Apps["tls"]; ok {
		t.Fatal("a subject-less internal policy would issue certificates for any name")
	}
}

func TestAsk(t *testing.T) {
	m := New(Options{AdminURL: "http://127.0.0.1:1"})
	_ = m.Apply(context.Background(), Config{TLSMode: protocol.TLSACME, AllowedHosts: []string{"App.Example.com"}})
	for _, tc := range []struct {
		method, target string
		want           int
	}{
		{"GET", "/ask?domain=app.example.com", 200},
		{"GET", "/ask?domain=APP.example.com.", 200},
		{"GET", "/ask?domain=other.example.com", 404},
		{"GET", "/ask?domain=", 404},
		{"GET", "/ask", 404},
		{"POST", "/ask?domain=app.example.com", 405},
		{"GET", "/other?domain=app.example.com", 404},
	} {
		rec := httptest.NewRecorder()
		m.ServeAsk(rec, httptest.NewRequest(tc.method, tc.target, nil))
		if rec.Code != tc.want {
			t.Errorf("%s %s = %d, want %d", tc.method, tc.target, rec.Code, tc.want)
		}
	}
	_ = m.Apply(context.Background(), Config{TLSMode: protocol.TLSACME})
	rec := httptest.NewRecorder()
	m.ServeAsk(rec, httptest.NewRequest("GET", "/ask?domain=app.example.com", nil))
	if rec.Code != 404 {
		t.Fatalf("removed host still allowed: %d", rec.Code)
	}
}

func TestListenAskLoopbackOnly(t *testing.T) {
	leaktest.Check(t)
	if _, err := ListenAsk("0.0.0.0:0"); err == nil {
		t.Fatal("wildcard address accepted")
	}
	if _, err := ListenAsk("localhost:0"); err == nil {
		t.Fatal("hostname accepted; it may resolve to a non-loopback address")
	}
	ln, err := ListenAsk("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	_ = m.Apply(context.Background(), Config{AllowedHosts: []string{"a.example.com"}})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- m.ServeAskOn(ctx, ln) }()
	resp, err := http.Get("http://" + ln.Addr().String() + "/ask?domain=a.example.com")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	http.DefaultClient.CloseIdleConnections()
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// fakeCaddy is a minimal admin API: /load stores the config, /config/
// returns it, and down makes every request fail.
type fakeCaddy struct {
	mu     sync.Mutex
	config []byte
	loads  int
	down   bool
}

func (f *fakeCaddy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.down {
		http.Error(w, "down", http.StatusServiceUnavailable)
		return
	}
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/load":
		body, _ := io.ReadAll(r.Body)
		if !json.Valid(body) {
			http.Error(w, "bad json", 400)
			return
		}
		f.config = body
		f.loads++
	case r.Method == http.MethodGet && r.URL.Path == "/config/":
		if f.config == nil {
			_, _ = io.WriteString(w, "null\n")
			return
		}
		_, _ = w.Write(f.config)
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeCaddy) state() (loads int, cfg []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.loads, f.config
}

func (f *fakeCaddy) set(fn func(*fakeCaddy)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestManagerLoadsOnlyOnChange(t *testing.T) {
	leaktest.Check(t)
	caddy := &fakeCaddy{}
	srv := httptest.NewServer(caddy)
	defer srv.Close()
	m := New(Options{AdminURL: srv.URL})
	ctx := context.Background()
	cfg := Config{TLSMode: protocol.TLSOff, Routes: sampleRoutes[:1]}
	for range 3 {
		if err := m.Apply(ctx, cfg); err != nil {
			t.Fatal(err)
		}
	}
	if loads, _ := caddy.state(); loads != 1 {
		t.Fatalf("loads = %d, want 1", loads)
	}
	// AllowedHosts are not part of Caddy's config.
	cfg.AllowedHosts = []string{"x.example.com"}
	_ = m.Apply(ctx, cfg)
	if loads, _ := caddy.state(); loads != 1 {
		t.Fatalf("allowlist change reloaded caddy: loads = %d", loads)
	}
	cfg.Routes = sampleRoutes[:2]
	_ = m.Apply(ctx, cfg)
	loads, got := caddy.state()
	if loads != 2 || !bytes.Equal(got, BuildConfig(cfg, m.opts.Build)) {
		t.Fatalf("loads = %d", loads)
	}
	if !m.Healthy() || m.AppliedHash() != Hash(got) || m.Loads() != 2 {
		t.Fatal("manager does not report the applied config")
	}
}

// Moving a route to other containers on the same port changes only the DNS
// answers, never Caddy's config.
func TestUpstreamSwapNeverReloads(t *testing.T) {
	leaktest.Check(t)
	caddy := &fakeCaddy{}
	srv := httptest.NewServer(caddy)
	defer srv.Close()
	m := New(Options{AdminURL: srv.URL})
	ctx := context.Background()
	route := func(ups ...string) Config {
		return Config{TLSMode: protocol.TLSOff, Routes: []Route{{Host: "app.example.com", Upstreams: ups, Ports: []int{3000}}}}
	}
	name := UpstreamName("app.example.com", "", 3000)
	for i, ups := range [][]string{
		{"172.18.0.2:3000"},
		{"172.18.0.2:3000", "172.18.0.3:3000"},
		{"172.18.0.3:3000"},
		nil,
		{"172.18.0.4:3000"},
	} {
		if err := m.Apply(ctx, route(ups...)); err != nil {
			t.Fatal(err)
		}
		var want []netip.Addr
		for _, u := range ups {
			want = append(want, netip.MustParseAddrPort(u).Addr())
		}
		if got := m.Upstreams()[name]; !slices.Equal(got, want) {
			t.Fatalf("swap %d: answers %v, want %v", i, got, want)
		}
	}
	if loads, _ := caddy.state(); loads != 1 {
		t.Fatalf("upstream swaps reloaded caddy: loads = %d, want 1", loads)
	}

	// A new hostname, a port change, or a TLS change does reload.
	cfg := route("172.18.0.4:3000")
	cfg.Routes = append(cfg.Routes, Route{Host: "www.example.com", Ports: []int{3000}})
	_ = m.Apply(ctx, cfg)
	cfg.Routes[0] = Route{Host: "app.example.com", Upstreams: []string{"172.18.0.4:8080"}}
	_ = m.Apply(ctx, cfg)
	cfg.TLSMode = protocol.TLSInternal
	_ = m.Apply(ctx, cfg)
	if loads, _ := caddy.state(); loads != 4 {
		t.Fatalf("loads = %d, want 4", loads)
	}
}

// A restarted agent finds Caddy already running the config it wants and
// does not reload it.
func TestManagerAdoptsRunningConfig(t *testing.T) {
	leaktest.Check(t)
	caddy := &fakeCaddy{}
	srv := httptest.NewServer(caddy)
	defer srv.Close()
	cfg := Config{TLSMode: protocol.TLSOff, Routes: sampleRoutes}
	if err := New(Options{AdminURL: srv.URL}).Apply(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	restarted := New(Options{AdminURL: srv.URL})
	if err := restarted.Apply(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if loads, _ := caddy.state(); loads != 1 || !restarted.Healthy() || restarted.Loads() != 0 {
		t.Fatalf("restart reloaded caddy: loads = %d", loads)
	}
	cfg.Routes = sampleRoutes[:1]
	_ = restarted.Apply(context.Background(), cfg)
	if loads, _ := caddy.state(); loads != 2 {
		t.Fatalf("a changed config was not loaded: loads = %d", loads)
	}
}

// The answers survive an agent restart, so Caddy can resolve upstreams
// before the restarted agent receives its first desired state.
func TestUpstreamsPersistAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "upstreams.json")
	m := New(Options{AdminURL: "http://127.0.0.1:1", UpstreamsPath: path})
	cfg := Config{TLSMode: protocol.TLSOff, Routes: sampleRoutes}
	_ = m.Apply(context.Background(), cfg)
	restarted := New(Options{AdminURL: "http://127.0.0.1:1", UpstreamsPath: path})
	got, want := restarted.Upstreams(), BuildTable(cfg)
	if len(want) == 0 || fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("restored answers %v, want %v", got, want)
	}
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if len(New(Options{UpstreamsPath: path}).Upstreams()) != 0 {
		t.Fatal("a corrupt file produced answers")
	}
}

func TestBuildTable(t *testing.T) {
	table := BuildTable(Config{Routes: sampleRoutes})
	v1 := UpstreamName("api.example.com", "/v1", 3000)
	if got := fmt.Sprint(table[v1]); got != "[172.18.0.3 172.18.0.4]" {
		t.Fatalf("/v1 answers %s", got)
	}
	if _, ok := table[UpstreamName("starting.example.com", "", 8080)]; ok {
		t.Fatal("a route with no upstream must not resolve")
	}
	if got := fmt.Sprint(table[UpstreamName("moving.example.com", "", 3000)]); got != "[172.20.0.2]" {
		t.Fatalf("moving answers %s", got)
	}
	for name := range table {
		if !strings.HasSuffix(name, "."+UpstreamZone) {
			t.Fatalf("name %s outside the zone", name)
		}
	}
}

func TestManagerRetriesWhileCaddyIsDown(t *testing.T) {
	leaktest.Check(t)
	caddy := &fakeCaddy{down: true}
	srv := httptest.NewServer(caddy)
	defer srv.Close()
	m := New(Options{AdminURL: srv.URL, MinBackoff: 10 * time.Millisecond, MaxBackoff: 20 * time.Millisecond})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- m.Run(ctx) }()
	defer func() {
		cancel()
		<-done
	}()

	if err := m.Apply(ctx, Config{TLSMode: protocol.TLSOff, Routes: sampleRoutes}); err == nil {
		t.Fatal("Apply succeeded against a down caddy")
	}
	if m.Healthy() {
		t.Fatal("healthy while caddy is down")
	}
	time.Sleep(50 * time.Millisecond)
	caddy.set(func(f *fakeCaddy) { f.down = false })
	waitFor(t, "retry to load the config", m.Healthy)
}

func TestManagerReloadsAfterCaddyRestart(t *testing.T) {
	leaktest.Check(t)
	caddy := &fakeCaddy{}
	srv := httptest.NewServer(caddy)
	defer srv.Close()
	m := New(Options{AdminURL: srv.URL, VerifyInterval: 10 * time.Millisecond})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- m.Run(ctx) }()
	defer func() {
		cancel()
		<-done
	}()
	if err := m.Apply(ctx, Config{TLSMode: protocol.TLSOff, Routes: sampleRoutes}); err != nil {
		t.Fatal(err)
	}
	caddy.set(func(f *fakeCaddy) { f.config = nil })
	waitFor(t, "reload after restart", func() bool {
		loads, cfg := caddy.state()
		return loads == 2 && cfg != nil
	})
}

func TestServeAskOnStopsWithListenerError(t *testing.T) {
	leaktest.Check(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ln.Close()
	if err := New(Options{}).ServeAskOn(context.Background(), ln); err == nil {
		t.Fatal("closed listener did not fail")
	}
}
