package docker

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeEngine routes requests by "METHOD /path" (without the version prefix)
// and records them.
type fakeEngine struct {
	t      *testing.T
	mu     sync.Mutex
	routes map[string]http.HandlerFunc
	seen   []*http.Request
	bodies []string
}

func newFakeEngine(t *testing.T) (*fakeEngine, *Client) {
	t.Helper()
	f := &fakeEngine{t: t, routes: map[string]http.HandlerFunc{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, ok := strings.CutPrefix(r.URL.Path, "/"+APIVersion)
		if !ok {
			t.Errorf("request without API version: %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.seen = append(f.seen, r)
		f.bodies = append(f.bodies, string(body))
		h := f.routes[r.Method+" "+path]
		f.mu.Unlock()
		if h == nil {
			http.Error(w, `{"message":"no such route"}`, http.StatusNotFound)
			return
		}
		h(w, r)
	}))
	t.Cleanup(srv.Close)
	c, err := New("tcp://" + strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	return f, c
}

func (f *fakeEngine) handle(route string, h http.HandlerFunc) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.routes[route] = h
}

func (f *fakeEngine) last() (*http.Request, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.seen[len(f.seen)-1], f.bodies[len(f.bodies)-1]
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func TestNewHosts(t *testing.T) {
	for _, tc := range []struct {
		host string
		ok   bool
	}{
		{"", true},
		{"unix:///var/run/docker.sock", true},
		{"tcp://127.0.0.1:2375", true},
		{"unix://", false},
		{"npipe:////./pipe/docker_engine", false},
		{"tcp://", false},
	} {
		_, err := New(tc.host)
		if (err == nil) != tc.ok {
			t.Errorf("New(%q) err = %v, want ok=%v", tc.host, err, tc.ok)
		}
	}
	t.Setenv("DOCKER_HOST", "ssh://example")
	if _, err := FromEnv(); err == nil {
		t.Error("FromEnv accepted an ssh host")
	}
}

func TestErrors(t *testing.T) {
	f, c := newFakeEngine(t)
	f.handle("GET /containers/missing/json", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 404, map[string]string{"message": "No such container: missing"})
	})
	f.handle("POST /containers/create", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(409)
		_, _ = io.WriteString(w, "plain conflict")
	})
	_, err := c.InspectContainer(context.Background(), "missing")
	if !IsNotFound(err) || !strings.Contains(err.Error(), "No such container") {
		t.Fatalf("inspect err = %v", err)
	}
	_, err = c.CreateContainer(context.Background(), "x", ContainerCreate{Image: "busybox"})
	if !IsConflict(err) || !strings.Contains(err.Error(), "plain conflict") {
		t.Fatalf("create err = %v", err)
	}
	if IsNotFound(errors.New("other")) {
		t.Fatal("plain error reported as not found")
	}
}

func TestPingVersionInfo(t *testing.T) {
	f, c := newFakeEngine(t)
	f.handle("GET /_ping", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "OK") })
	f.handle("GET /version", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]string{"Version": "29.5.3", "ApiVersion": "1.52"})
	})
	f.handle("GET /info", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]string{"DockerRootDir": "/var/lib/docker"})
	})
	ctx := context.Background()
	if err := c.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	v, err := c.Version(ctx)
	if err != nil || v.Version != "29.5.3" {
		t.Fatalf("version = %+v, %v", v, err)
	}
	i, err := c.Info(ctx)
	if err != nil || i.DockerRootDir != "/var/lib/docker" {
		t.Fatalf("info = %+v, %v", i, err)
	}
}

func TestParseReference(t *testing.T) {
	for _, tc := range []struct {
		ref  string
		want Reference
	}{
		{"nginx", Reference{Domain: "docker.io", Repository: "nginx"}},
		{"nginx:1.27", Reference{Domain: "docker.io", Repository: "nginx", Tag: "1.27"}},
		{"traefik/whoami", Reference{Domain: "docker.io", Repository: "traefik/whoami"}},
		{"ghcr.io/acme/api:v1", Reference{Domain: "ghcr.io", Repository: "ghcr.io/acme/api", Tag: "v1"}},
		{"127.0.0.1:5000/prj/svc@sha256:ab", Reference{Domain: "127.0.0.1:5000", Repository: "127.0.0.1:5000/prj/svc", Digest: "sha256:ab"}},
		{"localhost/app:1@sha256:cd", Reference{Domain: "localhost", Repository: "localhost/app", Tag: "1", Digest: "sha256:cd"}},
		{"registry:3.1.2@sha256:ef", Reference{Domain: "docker.io", Repository: "registry", Tag: "3.1.2", Digest: "sha256:ef"}},
	} {
		if got := ParseReference(tc.ref); got != tc.want {
			t.Errorf("ParseReference(%q) = %+v, want %+v", tc.ref, got, tc.want)
		}
	}
	if !SameRegistry("index.docker.io", "docker.io") || !SameRegistry("GHCR.io", "ghcr.io") || SameRegistry("ghcr.io", "docker.io") {
		t.Error("SameRegistry mismatch")
	}
}

func TestPullImage(t *testing.T) {
	f, c := newFakeEngine(t)
	f.handle("POST /images/create", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("fromImage") == "private/app" {
			_, _ = io.WriteString(w, `{"status":"Pulling"}`+"\n"+`{"errorDetail":{"message":"unauthorized"},"error":"unauthorized"}`+"\n")
			return
		}
		_, _ = io.WriteString(w, `{"status":"Pulling fs layer","id":"a"}`+"\n"+`{"status":"Done"}`+"\n")
	})
	ctx := context.Background()
	auth := &AuthConfig{Username: "u", Password: "p", ServerAddress: "docker.io"}
	if err := c.PullImage(ctx, "traefik/whoami", auth); err != nil {
		t.Fatal(err)
	}
	r, _ := f.last()
	if q := r.URL.Query(); q.Get("fromImage") != "traefik/whoami" || q.Get("tag") != "latest" {
		t.Fatalf("query = %v", q)
	}
	raw, err := base64.URLEncoding.DecodeString(r.Header.Get("X-Registry-Auth"))
	if err != nil || !strings.Contains(string(raw), `"serveraddress":"docker.io"`) {
		t.Fatalf("auth header = %q, %v", raw, err)
	}

	if err := c.PullImage(ctx, "busybox@sha256:abc", nil); err != nil {
		t.Fatal(err)
	}
	r, _ = f.last()
	if r.URL.Query().Get("tag") != "sha256:abc" || r.Header.Get("X-Registry-Auth") != "" {
		t.Fatalf("digest pull: %v %q", r.URL.Query(), r.Header.Get("X-Registry-Auth"))
	}

	if err := c.PullImage(ctx, "private/app:1", nil); err == nil || err.Error() != "unauthorized" {
		t.Fatalf("pull err = %v", err)
	}
}

func TestContainerLifecycleRequests(t *testing.T) {
	f, c := newFakeEngine(t)
	f.handle("POST /containers/create", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 201, map[string]string{"Id": "abc123"})
	})
	f.handle("POST /containers/abc123/start", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(304) })
	f.handle("POST /containers/abc123/stop", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })
	f.handle("DELETE /containers/abc123", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })
	f.handle("GET /containers/json", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, []ContainerSummary{{ID: "abc123", State: "running", Labels: map[string]string{"openrail.managed": "true"}}})
	})
	ctx := context.Background()
	pids := int64(64)
	id, err := c.CreateContainer(ctx, "openrail-wl", ContainerCreate{
		Image:      "busybox",
		HostConfig: HostConfig{CapDrop: []string{"ALL"}, PidsLimit: &pids, RestartPolicy: RestartPolicy{Name: "no"}},
	})
	if err != nil || id != "abc123" {
		t.Fatalf("create = %q, %v", id, err)
	}
	r, body := f.last()
	if r.URL.Query().Get("name") != "openrail-wl" || !strings.Contains(body, `"PidsLimit":64`) || !strings.Contains(body, `"CapDrop":["ALL"]`) {
		t.Fatalf("create request %v %s", r.URL, body)
	}
	if err := c.StartContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err := c.StopContainer(ctx, id, 7*time.Second); err != nil {
		t.Fatal(err)
	}
	if r, _ := f.last(); r.URL.Query().Get("t") != "7" {
		t.Fatalf("stop query = %v", r.URL.Query())
	}
	if err := c.RemoveContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	if r, _ := f.last(); r.URL.Query().Get("force") != "1" {
		t.Fatalf("remove query = %v", r.URL.Query())
	}
	if err := c.RemoveContainer(ctx, "gone"); err != nil {
		t.Fatalf("removing a missing container: %v", err)
	}
	list, err := c.ListContainers(ctx, "openrail.managed=true")
	if err != nil || len(list) != 1 {
		t.Fatalf("list = %v, %v", list, err)
	}
	if r, _ := f.last(); r.URL.Query().Get("filters") != `{"label":["openrail.managed=true"]}` || r.URL.Query().Get("all") != "1" {
		t.Fatalf("list query = %v", r.URL.Query())
	}
}

func TestNetworks(t *testing.T) {
	f, c := newFakeEngine(t)
	f.handle("POST /networks/create", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 201, map[string]string{"Id": "net1"})
	})
	f.handle("GET /networks/openrail-prj", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, Network{ID: "net1", Name: "openrail-prj", Driver: "bridge"})
	})
	f.handle("POST /networks/net1/connect", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	f.handle("GET /networks", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, []Network{{ID: "net1"}}) })
	ctx := context.Background()
	id, err := c.CreateNetwork(ctx, NetworkCreate{Name: "openrail-prj", Driver: "bridge"})
	if err != nil || id != "net1" {
		t.Fatalf("create = %q, %v", id, err)
	}
	n, err := c.InspectNetwork(ctx, "openrail-prj")
	if err != nil || n.ID != "net1" {
		t.Fatalf("inspect = %+v, %v", n, err)
	}
	if err := c.ConnectNetwork(ctx, "net1", "ctr"); err != nil {
		t.Fatal(err)
	}
	if _, body := f.last(); !strings.Contains(body, `"Container":"ctr"`) {
		t.Fatalf("connect body %s", body)
	}
	if ns, err := c.ListNetworks(ctx, "openrail.managed=true"); err != nil || len(ns) != 1 {
		t.Fatalf("list = %v, %v", ns, err)
	}
}

func frame(st StreamType, payload string) []byte {
	h := make([]byte, 8, 8+len(payload))
	h[0] = byte(st)
	binary.BigEndian.PutUint32(h[4:], uint32(len(payload)))
	return append(h, payload...)
}

func TestDemuxer(t *testing.T) {
	var stream bytes.Buffer
	stream.Write(frame(Stdout, "hello\n"))
	stream.Write(frame(Stderr, "oops\n"))
	stream.Write(frame(Stdout, ""))
	d := NewDemuxer(&stream)
	for _, want := range []struct {
		st StreamType
		s  string
	}{{Stdout, "hello\n"}, {Stderr, "oops\n"}, {Stdout, ""}} {
		st, p, err := d.Next()
		if err != nil || st != want.st || string(p) != want.s {
			t.Fatalf("Next = %d %q %v, want %d %q", st, p, err, want.st, want.s)
		}
	}
	if _, _, err := d.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("end err = %v", err)
	}

	truncated := frame(Stdout, "partial")[:10]
	if _, _, err := NewDemuxer(bytes.NewReader(truncated)).Next(); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("truncated err = %v", err)
	}
	huge := make([]byte, 8)
	huge[0] = 1
	binary.BigEndian.PutUint32(huge[4:], MaxFrameSize+1)
	if _, _, err := NewDemuxer(bytes.NewReader(huge)).Next(); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("huge err = %v", err)
	}
	if _, _, err := NewDemuxer(bytes.NewReader([]byte{9, 0, 0, 0, 0, 0, 0, 0})).Next(); err == nil {
		t.Fatal("invalid stream type accepted")
	}
}

func TestContainerLogsQuery(t *testing.T) {
	f, c := newFakeEngine(t)
	f.handle("GET /containers/abc/logs", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(frame(Stdout, "2026-01-01T00:00:00.000000001Z line\n"))
	})
	since := time.Unix(1700000000, 42)
	rc, err := c.ContainerLogs(context.Background(), "abc", LogsOptions{Follow: true, Since: since, Timestamps: true})
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	_, p, err := NewDemuxer(rc).Next()
	if err != nil || !strings.HasSuffix(string(p), "line\n") {
		t.Fatalf("frame %q %v", p, err)
	}
	r, _ := f.last()
	q := r.URL.Query()
	if q.Get("since") != "1700000000.000000042" || q.Get("follow") != "1" || q.Get("timestamps") != "1" {
		t.Fatalf("logs query = %v", q)
	}
}

func TestEvents(t *testing.T) {
	f, c := newFakeEngine(t)
	f.handle("GET /events", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"Type":"container","Action":"die","Actor":{"ID":"abc","Attributes":{"exitCode":"1"}},"timeNano":5}`+"\n")
		_, _ = io.WriteString(w, `{"Type":"container","Action":"start","Actor":{"ID":"abc"}}`+"\n")
	})
	var got []Event
	err := c.Events(context.Background(), map[string][]string{"type": {"container"}}, func(e Event) { got = append(got, e) })
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("events err = %v", err)
	}
	if len(got) != 2 || got[0].Action != "die" || got[0].Actor.Attributes["exitCode"] != "1" || got[1].Action != "start" {
		t.Fatalf("events = %+v", got)
	}

	ctx, cancel := context.WithCancel(context.Background())
	f.handle("GET /events", func(w http.ResponseWriter, r *http.Request) {
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	done := make(chan error, 1)
	go func() { done <- c.Events(ctx, nil, func(Event) {}) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("cancelled events err = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Events did not return after cancel")
	}
}
