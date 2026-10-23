//go:build integration

package ingress_test

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/dockertest"
	"github.com/BankkRoll/Roundhouse/agent/internal/ingress"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// caddyCmd starts Caddy with its admin API reachable from other containers;
// the agent keeps that listener in every config it loads.
var caddyCmd = []string{"sh", "-c",
	`printf '{"admin":{"listen":"0.0.0.0:2019"}}' > /tmp/boot.json && exec caddy run --config /tmp/boot.json`}

type env struct {
	c       *docker.Client
	network string
	caddy   string // container name, resolvable on the network
	caddyID string
	whoami  string // upstream dial address
	mgr     *ingress.Manager
	client  *http.Client
}

// setup starts Caddy and a whoami upstream on a fresh network, and a
// manager whose upstream DNS server runs in this test process, as it runs in
// the agent. refresh overrides Caddy's upstream cache interval when set.
func setup(t *testing.T, refresh time.Duration) *env {
	c := dockertest.Client(t)
	network := dockertest.Unique("roundhouse-it-ing-")
	dockertest.Network(t, c, network, nil)
	dockertest.Attach(t, c, network)

	w := dockertest.Run(t, c, dockertest.Unique("roundhouse-it-whoami-"), docker.ContainerCreate{
		Image: dockertest.WhoamiImage, HostConfig: docker.HostConfig{NetworkMode: network},
	})
	caddy := dockertest.Unique("roundhouse-it-caddy-")
	caddyID := dockertest.Run(t, c, caddy, docker.ContainerCreate{
		Image: dockertest.CaddyImage, Entrypoint: caddyCmd, HostConfig: docker.HostConfig{NetworkMode: network},
	})

	// NOTE: ListenDNS insists on loopback; here Caddy runs in another
	// container, so the test listens on its address on the shared network.
	self := dockertest.IP(t, c, dockertest.Self(t, c), network)
	pc, err := net.ListenPacket("udp", self+":0")
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", pc.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	e := &env{
		c: c, network: network, caddy: caddy, caddyID: caddyID, whoami: dockertest.IP(t, c, w, network) + ":80",
		client: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				DisableKeepAlives: true,
				TLSClientConfig:   &tls.Config{InsecureSkipVerify: true},
			},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
	e.mgr = ingress.New(ingress.Options{
		AdminURL: "http://" + caddy + ":2019",
		Build: ingress.BuildOptions{
			AdminListen: "0.0.0.0:2019",
			Resolver:    pc.LocalAddr().String(),
			Refresh:     refresh,
		},
		VerifyInterval: 300 * time.Millisecond,
		MinBackoff:     100 * time.Millisecond,
		MaxBackoff:     500 * time.Millisecond,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 2)
	go func() { done <- e.mgr.Run(ctx) }()
	go func() { done <- e.mgr.ServeDNSOn(ctx, pc, ln) }()
	t.Cleanup(func() {
		cancel()
		<-done
		<-done
	})
	dockertest.Eventually(t, 30*time.Second, "caddy admin API", func() bool {
		resp, err := e.client.Get("http://" + caddy + ":2019/config/")
		if err == nil {
			resp.Body.Close()
		}
		return err == nil && resp.StatusCode == 200
	})
	return e
}

// get requests url with the given Host and returns status and body.
func (e *env) get(t *testing.T, url, host string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	req.Host = host
	if strings.HasPrefix(url, "https://") {
		tr := e.client.Transport.(*http.Transport).Clone()
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true, ServerName: host}
		resp, err := (&http.Client{Transport: tr, Timeout: 10 * time.Second}).Do(req)
		if err != nil {
			return 0, err.Error()
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}
	resp, err := e.client.Do(req)
	if err != nil {
		return 0, err.Error()
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func (e *env) routes() []ingress.Route {
	return []ingress.Route{
		{Host: "app.roundhouse.test", Upstreams: []string{e.whoami}},
		{Host: "api.roundhouse.test", PathPrefix: "/v1", Upstreams: []string{e.whoami}},
	}
}

func TestCaddyRoutingTLSOff(t *testing.T) {
	e := setup(t, 0)
	ctx := context.Background()
	if err := e.mgr.Apply(ctx, ingress.Config{TLSMode: protocol.TLSOff, Routes: e.routes()}); err != nil {
		t.Fatal(err)
	}
	base := "http://" + e.caddy
	dockertest.Eventually(t, 15*time.Second, "routing", func() bool {
		code, body := e.get(t, base+"/", "app.roundhouse.test")
		return code == 200 && strings.Contains(body, "Hostname:")
	})
	if code, body := e.get(t, base+"/v1/users", "api.roundhouse.test"); code != 200 || !strings.Contains(body, "GET /v1/users") {
		t.Fatalf("path prefix: %d %s", code, body)
	}
	if code, _ := e.get(t, base+"/v2", "api.roundhouse.test"); code != 404 {
		t.Fatalf("outside the prefix: %d", code)
	}
	if code, body := e.get(t, base+"/", "unknown.roundhouse.test"); code != 404 || !strings.Contains(body, "no route") {
		t.Fatalf("unknown host: %d %s", code, body)
	}

	// Caddy restarts and comes back with only its boot config; the
	// manager notices and loads the routes again.
	if err := e.c.StopContainer(ctx, e.caddyID, time.Second); err != nil {
		t.Fatal(err)
	}
	// While Caddy is down, a new config fails to load and is retried.
	routes := append(e.routes(), ingress.Route{Host: "new.roundhouse.test", Upstreams: []string{e.whoami}})
	if err := e.mgr.Apply(ctx, ingress.Config{TLSMode: protocol.TLSOff, Routes: routes}); err == nil {
		t.Fatal("Apply succeeded with caddy stopped")
	}
	if e.mgr.Healthy() {
		t.Fatal("healthy with caddy stopped")
	}
	if err := e.c.StartContainer(ctx, e.caddyID); err != nil {
		t.Fatal(err)
	}
	dockertest.Eventually(t, 30*time.Second, "routes after the restart", func() bool {
		code, _ := e.get(t, base+"/", "new.roundhouse.test")
		return code == 200 && e.mgr.Healthy()
	})
}

func TestCaddyRoutingTLSInternal(t *testing.T) {
	e := setup(t, 0)
	if err := e.mgr.Apply(context.Background(), ingress.Config{TLSMode: protocol.TLSInternal, Routes: e.routes()}); err != nil {
		t.Fatal(err)
	}
	dockertest.Eventually(t, 30*time.Second, "HTTPS routing with the internal CA", func() bool {
		code, body := e.get(t, "https://"+e.caddy+"/", "app.roundhouse.test")
		return code == 200 && strings.Contains(body, "Hostname:")
	})
	if code, body := e.get(t, "https://"+e.caddy+"/v1/x", "api.roundhouse.test"); code != 200 || !strings.Contains(body, "GET /v1/x") {
		t.Fatalf("https path prefix: %d %s", code, body)
	}
	code, _ := e.get(t, "http://"+e.caddy+"/", "app.roundhouse.test")
	if code != http.StatusPermanentRedirect && code != http.StatusMovedPermanently && code != http.StatusFound {
		t.Fatalf("plain HTTP is not redirected: %d", code)
	}
}

// loop sends requests to Caddy back to back until stop closes, counting
// successes, failures (any transport error, resets included, or a status
// other than 200) and the upstream that answered.
type loop struct {
	ok, failed atomic.Int64
	mu         sync.Mutex
	hosts      map[string]int
	failures   []string
}

func (l *loop) run(e *env, keepAlive bool, stop <-chan struct{}, wg *sync.WaitGroup) {
	defer wg.Done()
	tr := &http.Transport{DisableKeepAlives: !keepAlive, MaxIdleConnsPerHost: 4}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: 10 * time.Second}
	for {
		select {
		case <-stop:
			return
		default:
		}
		req, _ := http.NewRequest(http.MethodGet, "http://"+e.caddy+"/", nil)
		req.Host = "app.roundhouse.test"
		resp, err := client.Do(req)
		if err != nil {
			l.fail(err.Error())
			continue
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil || resp.StatusCode != 200 {
			l.fail(fmt.Sprintf("HTTP %d %v %.100s", resp.StatusCode, err, body))
			continue
		}
		l.ok.Add(1)
		for _, line := range strings.Split(string(body), "\n") {
			if h, ok := strings.CutPrefix(line, "Hostname: "); ok {
				l.mu.Lock()
				l.hosts[strings.TrimSpace(h)]++
				l.mu.Unlock()
			}
		}
	}
}

func (l *loop) fail(msg string) {
	l.failed.Add(1)
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.failures) < 20 {
		l.failures = append(l.failures, time.Now().Format("15:04:05.000")+" "+msg)
	}
}

// TestSwapsNeverReloadCaddy moves a route between two upstreams 200 times,
// back to back, under request loops on fresh and on kept-alive connections.
// No request fails or is reset, Caddy is loaded exactly once, its config
// never names an upstream address, and both upstreams serve: every swap went
// through DNS alone.
func TestSwapsNeverReloadCaddy(t *testing.T) {
	const swaps = 200
	e := setup(t, 50*time.Millisecond)
	second := dockertest.Run(t, e.c, dockertest.Unique("roundhouse-it-whoami-"), docker.ContainerCreate{
		Image: dockertest.WhoamiImage, HostConfig: docker.HostConfig{NetworkMode: e.network},
	})
	upstreams := []string{e.whoami, dockertest.IP(t, e.c, second, e.network) + ":80"}
	apply := func(up string) {
		t.Helper()
		err := e.mgr.Apply(context.Background(), ingress.Config{
			TLSMode: protocol.TLSOff,
			Routes:  []ingress.Route{{Host: "app.roundhouse.test", Upstreams: []string{up}, Ports: []int{80}}},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	apply(upstreams[0])
	base := "http://" + e.caddy
	dockertest.Eventually(t, 15*time.Second, "routing", func() bool {
		code, _ := e.get(t, base+"/", "app.roundhouse.test")
		return code == 200
	})
	loadsBefore, hashBefore := e.mgr.Loads(), e.mgr.AppliedHash()
	if loadsBefore != 1 {
		t.Fatalf("loads before the swaps = %d, want 1", loadsBefore)
	}

	l := &loop{hosts: map[string]int{}}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for _, keepAlive := range []bool{false, false, true, true} {
		wg.Add(1)
		go l.run(e, keepAlive, stop, &wg)
	}
	for i := range swaps {
		apply(upstreams[(i+1)%2])
		// A little over Caddy's 50 ms cache, so the swaps really move
		// traffic back and forth.
		time.Sleep(60 * time.Millisecond)
	}
	time.Sleep(500 * time.Millisecond)
	close(stop)
	wg.Wait()

	t.Logf("%d swaps: %d requests ok, %d failed, by upstream %v", swaps, l.ok.Load(), l.failed.Load(), l.hosts)
	if n := l.failed.Load(); n != 0 {
		t.Fatalf("%d requests failed during the swaps:\n%s", n, strings.Join(l.failures, "\n"))
	}
	if e.mgr.Loads() != loadsBefore || e.mgr.AppliedHash() != hashBefore {
		t.Fatalf("swaps reloaded caddy: loads %d -> %d", loadsBefore, e.mgr.Loads())
	}
	if len(l.hosts) != 2 {
		t.Fatalf("traffic did not move between the upstreams: %v", l.hosts)
	}
	for host, n := range l.hosts {
		if n < 50 {
			t.Fatalf("upstream %s served only %d requests: %v", host, n, l.hosts)
		}
	}
	resp, err := e.client.Get("http://" + e.caddy + ":2019/config/")
	if err != nil {
		t.Fatal(err)
	}
	cfg, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	for _, up := range upstreams {
		if strings.Contains(string(cfg), strings.TrimSuffix(up, ":80")) {
			t.Fatalf("caddy's config names an upstream address, so swaps would need reloads:\n%s", cfg)
		}
	}
}

// TestRouteWaitsForUpstreamDNS: a request that arrives while no upstream
// address can be resolved (as while the agent restarts) waits for one
// instead of failing.
func TestRouteWaitsForUpstreamDNS(t *testing.T) {
	e := setup(t, 50*time.Millisecond)
	route := ingress.Route{Host: "app.roundhouse.test", Upstreams: []string{e.whoami}, Ports: []int{80}}
	apply := func(r ingress.Route) {
		_ = e.mgr.Apply(context.Background(), ingress.Config{TLSMode: protocol.TLSOff, Routes: []ingress.Route{r}})
	}
	apply(route)
	base := "http://" + e.caddy
	dockertest.Eventually(t, 15*time.Second, "routing", func() bool {
		code, _ := e.get(t, base+"/", "app.roundhouse.test")
		return code == 200
	})
	loads := e.mgr.Loads()

	gap := route
	gap.Upstreams = nil
	apply(gap)
	time.AfterFunc(2*time.Second, func() { apply(route) })
	time.Sleep(200 * time.Millisecond)
	started := time.Now()
	code, body := e.get(t, base+"/", "app.roundhouse.test")
	if code != 200 {
		t.Fatalf("request during the gap: %d %s", code, body)
	}
	if waited := time.Since(started); waited < time.Second {
		t.Fatalf("answered after %v; the gap was not exercised", waited)
	}
	if e.mgr.Loads() != loads {
		t.Fatal("losing and regaining every upstream reloaded caddy")
	}
}
