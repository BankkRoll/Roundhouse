package builder

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// daemonEngine is an in-memory Engine API for the daemon lifecycle: one
// build network, volumes and containers that start and stop.
type daemonEngine struct {
	mu         sync.Mutex
	containers map[string]*fakeDaemon // by name
	volumes    map[string]bool
	ops        []string
}

type fakeDaemon struct {
	running bool
	labels  map[string]string
	host    map[string]any
}

func (e *daemonEngine) op(s string) { e.ops = append(e.ops, s) }

func (e *daemonEngine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	e.mu.Lock()
	defer e.mu.Unlock()
	path := strings.TrimPrefix(r.URL.Path, "/"+dockerAPIVersion)
	notFound := func() {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"not found"}`))
	}
	switch {
	case r.Method == http.MethodGet && path == "/info":
		_, _ = w.Write([]byte(`{"SecurityOptions":["name=seccomp,profile=builtin"]}`))
	case r.Method == http.MethodGet && path == "/networks/"+NetworkName:
		_, _ = w.Write([]byte(`{"Id":"n","IPAM":{"Config":[{"Subnet":"172.30.0.0/16","Gateway":"172.30.0.1"}]}}`))
	case r.Method == http.MethodGet && strings.HasPrefix(path, "/images/"):
		_, _ = w.Write([]byte(`{}`))
	case r.Method == http.MethodPost && path == "/volumes/create":
		var v struct{ Name string }
		_ = json.NewDecoder(r.Body).Decode(&v)
		e.volumes[v.Name] = true
		_, _ = w.Write([]byte(`{}`))
	case r.Method == http.MethodDelete && strings.HasPrefix(path, "/volumes/"):
		name := strings.TrimPrefix(path, "/volumes/")
		if !e.volumes[name] {
			notFound()
			return
		}
		delete(e.volumes, name)
		e.op("rm volume " + name)
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodGet && path == "/containers/json":
		var out []map[string]any
		for name, c := range e.containers {
			state := "exited"
			if c.running {
				state = "running"
			}
			out = append(out, map[string]any{"Id": name, "Names": []string{"/" + name}, "State": state, "Labels": c.labels})
		}
		_ = json.NewEncoder(w).Encode(out)
	case r.Method == http.MethodGet && strings.HasSuffix(path, "/json") && strings.HasPrefix(path, "/containers/"):
		name := strings.TrimSuffix(strings.TrimPrefix(path, "/containers/"), "/json")
		c := e.containers[name]
		if c == nil {
			notFound()
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"Id": name, "State": map[string]any{"Running": c.running},
			"Config": map[string]any{"Labels": c.labels}})
	case r.Method == http.MethodPost && path == "/containers/create":
		var spec struct {
			Labels     map[string]string
			HostConfig map[string]any
		}
		_ = json.NewDecoder(r.Body).Decode(&spec)
		name := r.URL.Query().Get("name")
		e.containers[name] = &fakeDaemon{labels: spec.Labels, host: spec.HostConfig}
		e.op("create " + name)
		_ = json.NewEncoder(w).Encode(map[string]string{"Id": name})
	case r.Method == http.MethodPut && strings.HasSuffix(path, "/archive"):
		w.WriteHeader(http.StatusOK)
	case r.Method == http.MethodPost && strings.HasSuffix(path, "/start"):
		name := strings.TrimSuffix(strings.TrimPrefix(path, "/containers/"), "/start")
		e.containers[name].running = true
		e.op("start " + name)
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodPost && strings.HasSuffix(path, "/stop"):
		name := strings.TrimSuffix(strings.TrimPrefix(path, "/containers/"), "/stop")
		c := e.containers[name]
		if c == nil {
			notFound()
			return
		}
		if !c.running {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		c.running = false
		e.op("stop " + name)
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodDelete && strings.HasPrefix(path, "/containers/"):
		name := strings.TrimPrefix(path, "/containers/")
		if e.containers[name] == nil {
			notFound()
			return
		}
		delete(e.containers, name)
		e.op("rm " + name)
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "unexpected "+r.Method+" "+path, http.StatusTeapot)
	}
}

func (e *daemonEngine) running() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []string
	for name, c := range e.containers {
		if c.running {
			out = append(out, name)
		}
	}
	slices.Sort(out)
	return out
}

func startDaemonEngine(t *testing.T, e *daemonEngine) *daemon {
	t.Helper()
	if e.containers == nil {
		e.containers = map[string]*fakeDaemon{}
	}
	if e.volumes == nil {
		e.volumes = map[string]bool{}
	}
	// NOTE: unix socket paths are limited to ~100 bytes, which t.TempDir()
	// can exceed.
	dir, err := os.MkdirTemp("", "rh-bk")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	ln, err := net.Listen("unix", filepath.Join(dir, "d.sock"))
	if err != nil {
		t.Skipf("unix sockets unavailable: %v", err)
	}
	srv := &http.Server{Handler: e}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	api, err := newDockerAPI("unix://" + filepath.Join(dir, "d.sock"))
	if err != nil {
		t.Fatal(err)
	}
	return &daemon{docker: api, log: slog.New(slog.DiscardHandler), image: BuildKitImage, proxyPort: 5001,
		cacheMaxBytes: 20 << 30, minFreeBytes: 5 << 30}
}

func build(t *testing.T, d *daemon, project string) {
	t.Helper()
	name, err := d.ensure(context.Background(), project)
	if err != nil {
		t.Fatalf("ensure %s: %v", project, err)
	}
	if name != DaemonName(project) {
		t.Fatalf("daemon %q for %s", name, project)
	}
	d.release(project)
}

func TestOneDaemonPerProject(t *testing.T) {
	e := &daemonEngine{}
	d := startDaemonEngine(t, e)
	build(t, d, "prj_A1")
	build(t, d, "prj_B2")
	if got, want := e.running(), []string{DaemonName("prj_A1"), DaemonName("prj_B2")}; !slices.Equal(got, want) {
		t.Fatalf("running %v, want %v", got, want)
	}
	for _, p := range []string{"prj_A1", "prj_B2"} {
		c := e.containers[DaemonName(p)]
		mounts, _ := json.Marshal(c.host["Mounts"])
		if !strings.Contains(string(mounts), `"Source":"`+daemonVolume(p)+`"`) {
			t.Errorf("%s mounts %s, want its own volume", p, mounts)
		}
		if c.labels[labelProject] != p {
			t.Errorf("%s labels %v", p, c.labels)
		}
		if !e.volumes[daemonVolume(p)] {
			t.Errorf("volume of %s not created", p)
		}
	}
	if DaemonName("prj_01JABC") != "sys_buildkitd-prj_01jabc" || daemonVolume("prj_01JABC") != "roundhouse-buildkit-prj_01jabc" {
		t.Fatal("names must use the lowercased project ID")
	}
}

// Pull request builds run in the project's separate preview daemon, with
// a state volume (and so a cache) of their own (ADR 0014 section 14).
func TestPreviewBuildsUseTheirOwnDaemonAndCache(t *testing.T) {
	job := validJob()
	if got := daemonKey(&job); got != "prj_A" {
		t.Fatalf("daemon key %q for a regular build", got)
	}
	job.Isolation = protocol.BuildIsolationPreview
	preview := daemonKey(&job)
	if preview != "prj_A-preview" {
		t.Fatalf("daemon key %q for a preview build", preview)
	}

	e := &daemonEngine{}
	d := startDaemonEngine(t, e)
	build(t, d, "prj_A")
	build(t, d, preview)
	if got, want := e.running(), []string{DaemonName("prj_A"), DaemonName(preview)}; !slices.Equal(got, want) {
		t.Fatalf("running %v, want %v", got, want)
	}
	if daemonVolume(preview) == daemonVolume("prj_A") || !e.volumes[daemonVolume(preview)] {
		t.Fatalf("preview volume %q must exist and differ from the project's", daemonVolume(preview))
	}
	mounts, _ := json.Marshal(e.containers[DaemonName(preview)].host["Mounts"])
	if strings.Contains(string(mounts), `"Source":"`+daemonVolume("prj_A")+`"`) {
		t.Fatalf("preview daemon mounts the project's cache: %s", mounts)
	}
}

func TestAtMostTwoDaemonsLeastRecentlyUsedStops(t *testing.T) {
	e := &daemonEngine{}
	d := startDaemonEngine(t, e)
	build(t, d, "prj_A1")
	time.Sleep(2 * time.Millisecond)
	build(t, d, "prj_B2")
	time.Sleep(2 * time.Millisecond)
	build(t, d, "prj_A1") // A1 is now the most recently used
	time.Sleep(2 * time.Millisecond)
	build(t, d, "prj_C3")
	if got, want := e.running(), []string{DaemonName("prj_A1"), DaemonName("prj_C3")}; !slices.Equal(got, want) {
		t.Fatalf("running %v, want %v", got, want)
	}
	// The stopped daemon keeps its container and cache for next time.
	if e.containers[DaemonName("prj_B2")] == nil || !e.volumes[daemonVolume("prj_B2")] {
		t.Fatal("stopping a daemon removed its container or cache")
	}
	build(t, d, "prj_B2")
	if got := e.running(); len(got) != 2 || !slices.Contains(got, DaemonName("prj_B2")) {
		t.Fatalf("running %v", got)
	}
}

func TestIdleDaemonStops(t *testing.T) {
	e := &daemonEngine{}
	d := startDaemonEngine(t, e)
	d.idleAfter = 50 * time.Millisecond
	build(t, d, "prj_A1")
	deadline := time.Now().Add(5 * time.Second)
	for len(e.running()) != 0 {
		if time.Now().After(deadline) {
			t.Fatal("idle daemon kept running")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// In use, it doesn't stop however long the build takes.
	if _, err := d.ensure(context.Background(), "prj_A1"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	if got := e.running(); len(got) != 1 {
		t.Fatalf("a daemon in use stopped: running %v", got)
	}
	d.release("prj_A1")
}

func TestSharedDaemonAndCacheAreRemoved(t *testing.T) {
	e := &daemonEngine{
		containers: map[string]*fakeDaemon{
			ContainerName:          {running: true, labels: map[string]string{labelSystem: "buildkitd"}},
			DaemonName("prj_old1"): {running: true, labels: map[string]string{labelSystem: "buildkitd", labelProject: "prj_old1"}},
			DaemonName("prj_old2"): {running: true, labels: map[string]string{labelSystem: "buildkitd", labelProject: "prj_old2"}},
		},
		volumes: map[string]bool{CacheVolumeName: true},
	}
	d := startDaemonEngine(t, e)
	build(t, d, "prj_new")
	if e.containers[ContainerName] != nil || e.volumes[CacheVolumeName] {
		t.Fatalf("shared daemon or cache survived: ops %v", e.ops)
	}
	// Daemons an earlier agent left running count towards the limit.
	if got := e.running(); len(got) != 2 || !slices.Contains(got, DaemonName("prj_new")) {
		t.Fatalf("running %v", got)
	}
}

func TestDaemonLimits(t *testing.T) {
	d := &daemon{image: BuildKitImage}
	host := d.containerSpec("prj_A", "172.30.0.1", "unconfined", "h")["HostConfig"].(map[string]any)
	if host["Memory"] != int64(DefaultDaemonMemoryBytes) || host["MemorySwap"] != int64(DefaultDaemonMemoryBytes) ||
		host["NanoCpus"] != int64(DefaultDaemonCPUs*1e9) || host["PidsLimit"] != int64(DaemonPidsLimit) {
		t.Fatalf("limits %v %v %v %v", host["Memory"], host["MemorySwap"], host["NanoCpus"], host["PidsLimit"])
	}
	if host["NetworkMode"] != NetworkName {
		t.Fatalf("network %v: daemons never run on the host network", host["NetworkMode"])
	}
	d.memoryBytes, d.nanoCPUs = 1<<30, 5e8
	host = d.containerSpec("prj_A", "172.30.0.1", "unconfined", "h")["HostConfig"].(map[string]any)
	if host["Memory"] != int64(1<<30) || host["NanoCpus"] != int64(5e8) {
		t.Fatalf("configured limits ignored: %v %v", host["Memory"], host["NanoCpus"])
	}
}
