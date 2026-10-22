package builder

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/moby/buildkit/session/auth"
)

func TestRegistryProxyAuthorize(t *testing.T) {
	p := &registryProxy{repos: map[string]bool{"prj_a/svc_b": true, "openrail-cache/abc": true}}
	cases := []struct {
		method, path string
		ok           bool
	}{
		{"GET", "/v2/", true},
		{"POST", "/v2/", false},
		{"HEAD", "/v2/prj_a/svc_b/manifests/bld_1", true},
		{"GET", "/v2/prj_a/svc_b/blobs/sha256:abc", true},
		{"PUT", "/v2/prj_a/svc_b/manifests/bld_1", true},
		{"POST", "/v2/prj_a/svc_b/blobs/uploads/", true},
		{"PATCH", "/v2/prj_a/svc_b/blobs/uploads/uuid", true},
		{"PUT", "/v2/prj_a/svc_b/blobs/uploads/uuid", true},
		{"GET", "/v2/openrail-cache/abc/manifests/buildcache", true},
		{"DELETE", "/v2/prj_a/svc_b/manifests/sha256:abc", false},
		{"DELETE", "/v2/prj_a/svc_b/blobs/sha256:abc", false},
		{"PUT", "/v2/prj_a/svc_b/blobs/sha256:abc", false},
		{"POST", "/v2/prj_a/svc_b/manifests/x", false},
		{"GET", "/v2/prj_a/other/manifests/latest", false},
		{"GET", "/v2/prj_a/svc_b2/manifests/latest", false},
		{"GET", "/v2/prj_a/svc_b/extra/manifests/latest", false},
		{"GET", "/v2/prj_a/manifests/latest", false},
		{"GET", "/v2/_catalog", false},
		{"GET", "/v2/prj_a/svc_b/tags/list", true},
		{"GET", "/v1/prj_a/svc_b/manifests/x", false},
		{"GET", "/v2/prj_a/svc_b/../other/manifests/x", false},
	}
	for _, tc := range cases {
		if got := p.authorize(tc.method, tc.path); got != tc.ok {
			t.Errorf("%s %s = %v, want %v", tc.method, tc.path, got, tc.ok)
		}
	}
}

func TestRegistryProxyForwarding(t *testing.T) {
	var mu sync.Mutex
	var seen []*http.Request
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Clone(context.Background()))
		mu.Unlock()
		if r.Method == http.MethodPost {
			w.Header().Set("Location", "http://127.0.0.1:5000/v2/prj_a/svc_b/blobs/uploads/u1?_state=s")
			w.WriteHeader(http.StatusAccepted)
			return
		}
		_, _ = io.WriteString(w, "ok")
	}))
	defer upstream.Close()
	u, _ := url.Parse(upstream.URL)

	p, err := startRegistryProxy("127.0.0.1:0", u.Host, []string{"prj_a/svc_b"}, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	base := "http://" + p.ln.Addr().String()

	do := func(method, path string, user, pass string) *http.Response {
		t.Helper()
		req, _ := http.NewRequest(method, base+path, nil)
		if user != "" {
			req.SetBasicAuth(user, pass)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return resp
	}

	resp := do("GET", "/v2/prj_a/svc_b/manifests/x", "", "")
	if resp.StatusCode != http.StatusUnauthorized || !strings.HasPrefix(resp.Header.Get("WWW-Authenticate"), "Basic ") {
		t.Fatalf("anonymous: %d %q", resp.StatusCode, resp.Header.Get("WWW-Authenticate"))
	}
	if resp := do("GET", "/v2/prj_a/svc_b/manifests/x", p.user, "wrong"); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong password: %d", resp.StatusCode)
	}
	if resp := do("GET", "/v2/prj_z/svc_z/manifests/x", p.user, p.password); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("other repository: %d", resp.StatusCode)
	}
	if resp := do("GET", "/v2/prj_a/svc_b/manifests/x", p.user, p.password); resp.StatusCode != http.StatusOK {
		t.Fatalf("allowed: %d", resp.StatusCode)
	}
	resp = do("POST", "/v2/prj_a/svc_b/blobs/uploads/?mount=sha256:abc&from=prj_z/svc_z", p.user, p.password)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("upload: %d", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); loc != "/v2/prj_a/svc_b/blobs/uploads/u1?_state=s" {
		t.Errorf("Location = %q, want it relative", loc)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 2 {
		t.Fatalf("upstream saw %d requests, want 2", len(seen))
	}
	for _, r := range seen {
		if r.Header.Get("Authorization") != "" {
			t.Error("credentials forwarded upstream")
		}
		if !strings.HasPrefix(r.Host, "127.0.0.1:") || r.Host == u.Host {
			t.Errorf("upstream Host = %q, want the proxy's", r.Host)
		}
	}
	if q := seen[1].URL.Query(); q.Has("mount") || q.Has("from") {
		t.Errorf("cross-repository mount forwarded: %s", seen[1].URL.RawQuery)
	}
}

func TestSessionAuth(t *testing.T) {
	a := &sessionAuth{host: "openrail-registry.internal:5001", user: "u", password: "p"}
	got, err := a.Credentials(context.Background(), &auth.CredentialsRequest{Host: "openrail-registry.internal:5001"})
	if err != nil || got.Username != "u" || got.Secret != "p" {
		t.Fatalf("own host: %+v %v", got, err)
	}
	got, err = a.Credentials(context.Background(), &auth.CredentialsRequest{Host: "registry-1.docker.io"})
	if err != nil || got.Username != "" || got.Secret != "" {
		t.Fatalf("other host must be anonymous: %+v %v", got, err)
	}
}
