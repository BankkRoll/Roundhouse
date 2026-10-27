package ingress

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

var hsts = &protocol.RouteHSTS{MaxAge: 31536000}

func managedSample() Config {
	return Config{
		TLSMode: protocol.TLSManaged,
		Routes: []Route{
			{Host: "shop.customer.test", Upstreams: []string{"172.18.0.2:3000"}, HSTS: &protocol.RouteHSTS{MaxAge: 63072000, IncludeSubdomains: true, Preload: true}},
			{Host: "*.apps.example.com", Upstreams: []string{"172.18.0.3:3000"}, HSTS: hsts},
			{Host: "api.apps.example.com", PathPrefix: "/v1", Upstreams: []string{"172.18.0.4:3000"}, HSTS: hsts},
			{Host: "pending.customer.test", Upstreams: []string{"172.18.0.5:3000"}, HSTS: hsts},
		},
		AllowedHosts: []string{"shop.customer.test", "*.apps.example.com", "api.apps.example.com", "pending.customer.test"},
		ManagedHosts: []string{"shop.customer.test", "*.apps.example.com", "api.apps.example.com"},
		ChallengeUpstream: &protocol.ACMEChallengeUpstream{
			URL: "https://cp.example.com/v1/acme/http-01", Host: "cp.example.com",
		},
		Certificates: []Certificate{
			{ID: "cer_wild", Path: "/var/lib/roundhouse-certs/cer_wild.pem", SHA256: strings.Repeat("a", 64)},
			{ID: "cer_shop", Path: "/var/lib/roundhouse-certs/cer_shop.pem", SHA256: strings.Repeat("b", 64)},
		},
	}
}

func TestBuildConfigManagedGolden(t *testing.T) {
	opts := BuildOptions{AdminListen: DefaultAdminListen, AskURL: DefaultAskURL}
	got := BuildConfig(managedSample(), opts)
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, got, "", "  "); err != nil {
		t.Fatal(err)
	}
	pretty.WriteByte('\n')
	golden := filepath.Join("testdata", "caddy-managed.json")
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

	c := managedSample()
	slices.Reverse(c.Routes)
	slices.Reverse(c.Certificates)
	slices.Reverse(c.ManagedHosts)
	if Hash(BuildConfig(c, opts)) != Hash(got) {
		t.Fatal("input order changed the managed config")
	}
}

// caddyJSON is the part of a generated config the structural tests read.
type caddyJSON struct {
	Apps struct {
		HTTP struct {
			Servers map[string]struct {
				Listen         []string         `json:"listen"`
				Routes         []map[string]any `json:"routes"`
				AutomaticHTTPS map[string]any   `json:"automatic_https"`
			} `json:"servers"`
		} `json:"http"`
		TLS *struct {
			Certificates struct {
				LoadFiles []struct {
					Certificate string   `json:"certificate"`
					Key         string   `json:"key"`
					Tags        []string `json:"tags"`
				} `json:"load_files"`
			} `json:"certificates"`
			Automation *struct {
				OnDemand map[string]any `json:"on_demand"`
			} `json:"automation"`
		} `json:"tls"`
	} `json:"apps"`
	Logging *struct {
		Logs map[string]struct {
			Writer  map[string]any `json:"writer"`
			Include []string       `json:"include"`
		} `json:"logs"`
	} `json:"logging"`
}

func parse(t *testing.T, data []byte) caddyJSON {
	t.Helper()
	var c caddyJSON
	if err := json.Unmarshal(data, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

// routeHosts returns the host matcher of each route, "" for none.
func routeHosts(routes []map[string]any) []string {
	var out []string
	for _, r := range routes {
		host := ""
		if m, ok := r["match"].([]any); ok {
			if hs, ok := m[0].(map[string]any)["host"].([]any); ok {
				host = hs[0].(string)
				if p, ok := m[0].(map[string]any)["path"].([]any); ok {
					host += " " + p[0].(string)
				}
			}
		}
		out = append(out, host)
	}
	return out
}

func handlers(route map[string]any) []string {
	var out []string
	for _, h := range route["handle"].([]any) {
		out = append(out, h.(map[string]any)["handler"].(string))
	}
	return out
}

func TestManagedConfigStructure(t *testing.T) {
	cfg := parse(t, BuildConfig(managedSample(), BuildOptions{}))
	https := cfg.Apps.HTTP.Servers[Server]
	if !slices.Equal(https.Listen, []string{":443"}) {
		t.Fatalf("https listen = %v", https.Listen)
	}
	skip, _ := https.AutomaticHTTPS["skip_certificates"].([]any)
	if len(skip) != 3 || skip[0] != "*.apps.example.com" || skip[1] != "api.apps.example.com" || skip[2] != "shop.customer.test" {
		t.Fatalf("skip_certificates = %v", skip)
	}
	if _, ok := https.AutomaticHTTPS["disable_redirects"]; ok {
		t.Fatal("redirects must stay on")
	}
	if cfg.Apps.TLS == nil || cfg.Apps.TLS.Automation == nil || cfg.Apps.TLS.Automation.OnDemand == nil {
		t.Fatal("hosts without a managed certificate need on-demand issuance")
	}
	files := cfg.Apps.TLS.Certificates.LoadFiles
	if len(files) != 2 || files[0].Certificate != "/var/lib/roundhouse-certs/cer_shop.pem" ||
		files[0].Key != files[0].Certificate || !slices.Contains(files[0].Tags, "sha256:"+strings.Repeat("b", 64)) {
		t.Fatalf("load_files = %+v", files)
	}
	if cfg.Logging == nil || cfg.Logging.Logs[TLSLog].Writer["address"] != DefaultTLSLogListen {
		t.Fatal("managed mode must report on-demand issuance through the tls log")
	}

	// Exact hosts first, longer prefixes first, the shadow guard after an
	// exact host the wildcard covers, then the wildcard and the catch-all.
	wantOrder := []string{
		"api.apps.example.com /v1", "api.apps.example.com", "pending.customer.test",
		"shop.customer.test", "*.apps.example.com", "",
	}
	if got := routeHosts(https.Routes); !slices.Equal(got, wantOrder) {
		t.Fatalf("route order = %q, want %q", got, wantOrder)
	}
	if h := handlers(https.Routes[1]); !slices.Equal(h, []string{"static_response"}) {
		t.Fatalf("shadow guard = %v", h)
	}
	for _, i := range []int{0, 2, 3, 4} {
		if h := handlers(https.Routes[i]); !slices.Equal(h, []string{"headers", "reverse_proxy"}) {
			t.Fatalf("route %d handlers = %v, want HSTS before the proxy", i, h)
		}
	}
	set := https.Routes[3]["handle"].([]any)[0].(map[string]any)["response"].(map[string]any)["set"].(map[string]any)
	if v := set["Strict-Transport-Security"].([]any)[0]; v != "max-age=63072000; includeSubDomains; preload" {
		t.Fatalf("HSTS = %v", v)
	}

	http := cfg.Apps.HTTP.Servers[HTTPServer]
	if !slices.Equal(http.Listen, []string{":80"}) || len(http.Routes) != 1 {
		t.Fatalf("http server = %+v", http)
	}
	route := http.Routes[0]
	match := route["match"].([]any)[0].(map[string]any)
	if fmtJSON(match["host"]) != `["api.apps.example.com","pending.customer.test","shop.customer.test"]` {
		t.Fatalf("challenge hosts = %v (every exact host, never a wildcard)", match["host"])
	}
	if fmtJSON(match["path"]) != `["/.well-known/acme-challenge/*"]` {
		t.Fatalf("challenge path = %v", match["path"])
	}
	if h := handlers(route); !slices.Equal(h, []string{"rewrite", "reverse_proxy"}) {
		t.Fatalf("challenge handlers = %v", h)
	}
	handle := route["handle"].([]any)
	if uri := handle[0].(map[string]any)["uri"]; uri != "/v1/acme/http-01/{http.request.uri.path.file}" {
		t.Fatalf("rewrite = %v", uri)
	}
	proxy := handle[1].(map[string]any)
	if fmtJSON(proxy["upstreams"]) != `[{"dial":"cp.example.com:443"}]` ||
		fmtJSON(proxy["transport"]) != `{"protocol":"http","tls":{"server_name":"cp.example.com"}}` ||
		fmtJSON(proxy["headers"]) != `{"request":{"set":{"Host":["cp.example.com"]}}}` {
		t.Fatalf("challenge proxy = %s", fmtJSON(proxy))
	}
	if strings.Contains(fmtJSON(http), "Strict-Transport-Security") {
		t.Fatal("the HTTP port must never send HSTS (RFC 6797 §7.2)")
	}
}

func fmtJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestHSTSOnlyOnHTTPSModes(t *testing.T) {
	routes := []Route{{Host: "a.example.com", Upstreams: []string{"172.18.0.2:80"}, HSTS: hsts}}
	for mode, want := range map[protocol.TLSMode]bool{
		protocol.TLSACME: true, protocol.TLSManaged: true, protocol.TLSInternal: false, protocol.TLSOff: false,
	} {
		got := strings.Contains(string(BuildConfig(Config{TLSMode: mode, Routes: routes}, BuildOptions{})), "Strict-Transport-Security")
		if got != want {
			t.Errorf("%s: HSTS = %v, want %v", mode, got, want)
		}
	}
	if strings.Contains(string(BuildConfig(Config{TLSMode: protocol.TLSACME, Routes: []Route{{Host: "a.example.com", Ports: []int{80}}}}, BuildOptions{})), "Strict-Transport-Security") {
		t.Error("a route without HSTS sent the header")
	}
}

func TestHSTSValue(t *testing.T) {
	for _, tc := range []struct {
		in   protocol.RouteHSTS
		want string
	}{
		{protocol.RouteHSTS{MaxAge: 31536000}, "max-age=31536000"},
		{protocol.RouteHSTS{MaxAge: 0}, "max-age=0"},
		{protocol.RouteHSTS{MaxAge: 300, IncludeSubdomains: true}, "max-age=300; includeSubDomains"},
		{protocol.RouteHSTS{MaxAge: 63072000, IncludeSubdomains: true, Preload: true}, "max-age=63072000; includeSubDomains; preload"},
	} {
		if got := HSTSValue(tc.in); got != tc.want {
			t.Errorf("%+v = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestRoutesOfAHostShareTheStrongestHSTS(t *testing.T) {
	routes := normalize([]Route{
		{Host: "a.example.com", PathPrefix: "/v1", Ports: []int{80}, HSTS: &protocol.RouteHSTS{MaxAge: 100}},
		{Host: "a.example.com", Ports: []int{80}, HSTS: &protocol.RouteHSTS{MaxAge: 100, IncludeSubdomains: true}},
		{Host: "a.example.com", PathPrefix: "/v2", Ports: []int{80}},
	})
	for _, r := range routes {
		if r.HSTS == nil || *r.HSTS != (protocol.RouteHSTS{MaxAge: 100, IncludeSubdomains: true}) {
			t.Fatalf("%s%s: HSTS = %+v", r.Host, r.PathPrefix, r.HSTS)
		}
	}
}

func TestWildcardNeverShadowsExactHosts(t *testing.T) {
	cfg := parse(t, BuildConfig(Config{TLSMode: protocol.TLSManaged, Routes: []Route{
		{Host: "*.example.com", Ports: []int{80}},
		{Host: "z.example.com", PathPrefix: "/api", Ports: []int{80}},
		{Host: "a.example.com", Ports: []int{80}},
		{Host: "deep.a.example.com", PathPrefix: "/x", Ports: []int{80}},
		{Host: "*.a.example.com", PathPrefix: "/p", Ports: []int{80}},
	}}, BuildOptions{}))
	want := []string{
		// a.example.com has its own root route; deep.a.example.com is
		// matched by *.a.example.com and gets a guard; z.example.com too.
		"a.example.com", "deep.a.example.com /x", "deep.a.example.com", "z.example.com /api", "z.example.com",
		"*.a.example.com /p", "*.example.com", "",
	}
	if got := routeHosts(cfg.Apps.HTTP.Servers[Server].Routes); !slices.Equal(got, want) {
		t.Fatalf("routes = %q, want %q", got, want)
	}
	for _, tc := range []struct {
		host, wildcard string
		want           bool
	}{
		{"a.example.com", "*.example.com", true},
		{"b.a.example.com", "*.example.com", false},
		{"example.com", "*.example.com", false},
		{"*.example.com", "*.example.com", false},
		{"a.example.com", "a.example.com", false},
	} {
		if got := coveredByWildcard(tc.host, tc.wildcard); got != tc.want {
			t.Errorf("coveredByWildcard(%q, %q) = %v", tc.host, tc.wildcard, got)
		}
	}
}

func TestChallengeRouteNeedsASafeUpstream(t *testing.T) {
	for _, url := range []string{
		"http://cp.example.com/acme",
		"https://user@cp.example.com/acme",
		"https://cp.example.com/{http.request.host}",
		"https://cp.example.com/acme?x=1",
		"https://cp.example.com/a b",
		"https:///acme",
	} {
		c := managedSample()
		c.ChallengeUpstream.URL = url
		if _, ok := parse(t, BuildConfig(c, BuildOptions{})).Apps.HTTP.Servers[HTTPServer]; ok {
			t.Errorf("%q: challenge route built", url)
		}
	}
	c := managedSample()
	c.ChallengeUpstream.URL = "https://cp.example.com:8443/"
	cfg := BuildConfig(c, BuildOptions{})
	if !strings.Contains(string(cfg), `"dial":"cp.example.com:8443"`) || !strings.Contains(string(cfg), `"uri":"/{http.request.uri.path.file}"`) {
		t.Fatalf("port or root path lost:\n%s", cfg)
	}
	c.ManagedHosts = []string{"*.apps.example.com"}
	c.AllowedHosts = c.ManagedHosts
	c.Routes = c.Routes[1:2]
	if _, ok := parse(t, BuildConfig(c, BuildOptions{})).Apps.HTTP.Servers[HTTPServer]; ok {
		t.Error("a wildcard alone cannot use HTTP-01")
	}
	c = managedSample()
	c.ChallengeUpstream = nil
	if _, ok := parse(t, BuildConfig(c, BuildOptions{})).Apps.HTTP.Servers[HTTPServer]; ok {
		t.Error("challenge route without an upstream")
	}
}

func TestACMEModeLogsTLSEventsToTheAgent(t *testing.T) {
	cfg := parse(t, BuildConfig(Config{TLSMode: protocol.TLSACME}, BuildOptions{TLSLogAddress: "127.0.0.1:9"}))
	l := cfg.Logging.Logs[TLSLog]
	if l.Writer["output"] != "net" || l.Writer["address"] != "127.0.0.1:9" || l.Writer["soft_start"] != true ||
		!slices.Equal(l.Include, []string{"tls"}) {
		t.Fatalf("tls log = %+v", l)
	}
	for _, mode := range []protocol.TLSMode{protocol.TLSInternal, protocol.TLSOff} {
		if parse(t, BuildConfig(Config{TLSMode: mode}, BuildOptions{})).Logging != nil {
			t.Errorf("%s: logging configured", mode)
		}
	}
}

func TestAskDeniesWildcardsAndManagedHosts(t *testing.T) {
	m := New(Options{AdminURL: "http://127.0.0.1:1"})
	c := managedSample()
	_ = m.Apply(context.Background(), c)
	for host, want := range map[string]int{
		"pending.customer.test": 200,
		"shop.customer.test":    404,
		"api.apps.example.com":  404,
		"*.apps.example.com":    404,
		"x.apps.example.com":    404,
	} {
		rec := httptest.NewRecorder()
		m.ServeAsk(rec, httptest.NewRequest("GET", "/ask?domain="+host, nil))
		if rec.Code != want {
			t.Errorf("%s = %d, want %d", host, rec.Code, want)
		}
	}
}

// clock is a settable time source.
type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func TestRenewalsAreBatched(t *testing.T) {
	caddy := &fakeCaddy{}
	srv := httptest.NewServer(caddy)
	defer srv.Close()
	clk := &clock{now: time.Unix(1_800_000_000, 0)}
	var mu sync.Mutex
	var loaded []Loaded
	m := New(Options{AdminURL: srv.URL, Now: clk.Now, OnLoaded: func(l Loaded) {
		mu.Lock()
		defer mu.Unlock()
		loaded = append(loaded, l)
	}})
	defer func() {
		m.mu.Lock()
		if m.renewTimer != nil {
			m.renewTimer.Stop()
		}
		m.mu.Unlock()
	}()
	ctx := context.Background()
	sha := func(c byte) string { return strings.Repeat(string(c), 64) }
	cert := func(id string, c byte) Certificate {
		return Certificate{ID: id, Path: "/c/" + id + ".pem", SHA256: sha(c)}
	}
	loads := func() int { n, _ := caddy.state(); return n }
	running := func() string { _, cfg := caddy.state(); return string(cfg) }

	// Certificates set before the first Apply wait for it.
	if err := m.SetCertificates(ctx, []Certificate{cert("cer_a", 'a')}); err != nil || loads() != 0 {
		t.Fatalf("loaded before the first Apply: %v, %d", err, loads())
	}
	cfg := Config{TLSMode: protocol.TLSManaged, Routes: []Route{{Host: "a.example.com", Ports: []int{80}}}}
	if err := m.Apply(ctx, cfg); err != nil || loads() != 1 || !strings.Contains(running(), sha('a')) {
		t.Fatalf("first apply: %v, loads %d", err, loads())
	}
	last := func() Loaded { mu.Lock(); defer mu.Unlock(); return loaded[len(loaded)-1] }
	if l := last(); l.Certificates["cer_a"] != sha('a') || l.TLSMode != protocol.TLSManaged || !slices.Equal(l.Hosts, []string{}) {
		t.Fatalf("OnLoaded = %+v", l)
	}

	// The first renewal loads at once; the next within the interval waits.
	_ = m.SetCertificates(ctx, []Certificate{cert("cer_a", 'b')})
	if loads() != 2 || !strings.Contains(running(), sha('b')) {
		t.Fatalf("first renewal: loads %d", loads())
	}
	clk.advance(time.Minute)
	_ = m.SetCertificates(ctx, []Certificate{cert("cer_a", 'c')})
	if loads() != 2 || last().Certificates["cer_a"] != sha('b') {
		t.Fatalf("renewal within the interval loaded: loads %d", loads())
	}
	// A new ID loads at once and carries the waiting renewal.
	_ = m.SetCertificates(ctx, []Certificate{cert("cer_a", 'c'), cert("cer_n", 'n')})
	if loads() != 3 || !strings.Contains(running(), sha('c')) || last().Certificates["cer_n"] != sha('n') {
		t.Fatalf("new certificate: loads %d", loads())
	}
	// So does a route change.
	clk.advance(time.Minute)
	_ = m.SetCertificates(ctx, []Certificate{cert("cer_a", 'd'), cert("cer_n", 'n')})
	if loads() != 3 {
		t.Fatalf("renewal within the interval loaded: loads %d", loads())
	}
	cfg.Routes = append(cfg.Routes, Route{Host: "b.example.com", Ports: []int{80}})
	_ = m.Apply(ctx, cfg)
	if loads() != 4 || !strings.Contains(running(), sha('d')) {
		t.Fatalf("route change did not carry the renewal: loads %d", loads())
	}
	// Riding along does not restart the interval; it is due 10 min after
	// the first renewal's load.
	_ = m.SetCertificates(ctx, []Certificate{cert("cer_a", 'e'), cert("cer_n", 'n')})
	if loads() != 4 {
		t.Fatalf("loads %d", loads())
	}
	clk.advance(8 * time.Minute)
	if err := m.rebuild(ctx); err != nil || loads() != 5 || !strings.Contains(running(), sha('e')) {
		t.Fatalf("due renewal: %v, loads %d", err, loads())
	}
	// Removing a certificate loads at once.
	_ = m.SetCertificates(ctx, []Certificate{cert("cer_a", 'e')})
	if loads() != 6 || strings.Contains(running(), "cer_n") {
		t.Fatalf("removal: loads %d", loads())
	}
	// Outside managed mode no certificate is loaded or reported.
	cfg.TLSMode = protocol.TLSACME
	_ = m.Apply(ctx, cfg)
	if strings.Contains(running(), "load_files") || len(last().Certificates) != 0 {
		t.Fatal("certificates loaded in acme mode")
	}
}

func TestOnLoadedReportsAskHosts(t *testing.T) {
	caddy := &fakeCaddy{}
	srv := httptest.NewServer(caddy)
	defer srv.Close()
	var got []Loaded
	m := New(Options{AdminURL: srv.URL, OnLoaded: func(l Loaded) { got = append(got, l) }})
	ctx := context.Background()
	_ = m.Apply(ctx, managedSample())
	_ = m.Apply(ctx, managedSample())
	if len(got) != 1 || !slices.Equal(got[0].Hosts, []string{"pending.customer.test"}) {
		t.Fatalf("OnLoaded calls = %+v", got)
	}
	caddy.set(func(f *fakeCaddy) { f.down = true })
	c := managedSample()
	c.AllowedHosts = append(c.AllowedHosts, "new.customer.test")
	c.Routes = append(c.Routes, Route{Host: "new.customer.test", Ports: []int{80}})
	if err := m.Apply(ctx, c); err == nil || len(got) != 1 {
		t.Fatalf("reported a config caddy refused: %v %d", err, len(got))
	}
}
