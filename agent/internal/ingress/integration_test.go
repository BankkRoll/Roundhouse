//go:build integration

package ingress_test

import (
	"context"
	"crypto/tls"
	"io"
	"net/http"
	"strings"
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
	caddy   string // container name, resolvable on the network
	caddyID string
	whoami  string // upstream dial address
	mgr     *ingress.Manager
	client  *http.Client
}

func setup(t *testing.T) *env {
	c := dockertest.Client(t)
	net := dockertest.Unique("roundhouse-it-ing-")
	dockertest.Network(t, c, net, nil)
	dockertest.Attach(t, c, net)

	w := dockertest.Run(t, c, dockertest.Unique("roundhouse-it-whoami-"), docker.ContainerCreate{
		Image: dockertest.WhoamiImage, HostConfig: docker.HostConfig{NetworkMode: net},
	})
	caddy := dockertest.Unique("roundhouse-it-caddy-")
	caddyID := dockertest.Run(t, c, caddy, docker.ContainerCreate{
		Image: dockertest.CaddyImage, Entrypoint: caddyCmd, HostConfig: docker.HostConfig{NetworkMode: net},
	})
	e := &env{
		c: c, caddy: caddy, caddyID: caddyID, whoami: dockertest.IP(t, c, w, net) + ":80",
		client: &http.Client{
			Timeout: 5 * time.Second,
			Transport: &http.Transport{
				DisableKeepAlives: true,
				TLSClientConfig:   &tls.Config{InsecureSkipVerify: true},
			},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
	e.mgr = ingress.New(ingress.Options{
		AdminURL:       "http://" + caddy + ":2019",
		Build:          ingress.BuildOptions{AdminListen: "0.0.0.0:2019"},
		VerifyInterval: 300 * time.Millisecond,
		MinBackoff:     100 * time.Millisecond,
		MaxBackoff:     500 * time.Millisecond,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- e.mgr.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
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
		resp, err := (&http.Client{Transport: tr, Timeout: 5 * time.Second}).Do(req)
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
	e := setup(t)
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
	e := setup(t)
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
