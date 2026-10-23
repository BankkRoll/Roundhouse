package builder

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	bkclient "github.com/moby/buildkit/client"
	"github.com/opencontainers/go-digest"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

func TestSolveSpecs(t *testing.T) {
	job := validJob()
	job.BuildArgs = map[string]string{"API_TOKEN": "secret-value", "NODE_ENV": "production"}
	paths := buildPaths{context: "/w/src", dockerfileDir: "/w/src/docker", dockerfileName: "Dockerfile.prod"}

	df := dockerfileSolve(&job, paths)
	if df.frontend != "dockerfile.v0" || df.attrs["filename"] != "Dockerfile.prod" ||
		df.attrs["build-arg:NODE_ENV"] != "production" || df.mounts["dockerfile"] != "/w/src/docker" {
		t.Fatalf("dockerfile spec %+v", df)
	}

	job.Builder = protocol.BuilderRailpack
	rp := railpackSolve(&job, paths, "/w/plan", RailpackFrontendImage)
	if rp.frontend != "gateway.v0" || rp.attrs["source"] != RailpackFrontendImage || rp.attrs["filename"] != railpackPlanFile ||
		rp.attrs["build-arg:cache-key"] != job.CacheKey || rp.mounts["dockerfile"] != "/w/plan" {
		t.Fatalf("railpack spec %+v", rp)
	}
	for k, v := range rp.attrs {
		if strings.Contains(v, "secret-value") {
			t.Errorf("build arg value in frontend attr %s", k)
		}
	}
	if string(rp.secrets["API_TOKEN"]) != "secret-value" {
		t.Error("build arg not passed as a secret")
	}
}

func TestSecretsHash(t *testing.T) {
	a := secretsHash(map[string]string{"A": "1", "B": "2"})
	if a != secretsHash(map[string]string{"B": "2", "A": "1"}) {
		t.Error("hash depends on map order")
	}
	if a == secretsHash(map[string]string{"A": "1", "B": "3"}) {
		t.Error("hash ignores values")
	}
	if a == secretsHash(map[string]string{"A": "1B=2"}) {
		t.Error("hash is ambiguous")
	}
}

func TestProgressPrinter(t *testing.T) {
	sink := newFrameSink()
	b := newLogBatcher("bld_1", sink.emit, newRedactor("", map[string]string{"API_TOKEN": "hunter2-secret"}),
		&fakeTicker{ch: make(chan time.Time)})
	p := newProgressPrinter(b)
	t0 := time.Unix(100, 0)
	t1 := t0.Add(1500 * time.Millisecond)
	d1, d2, d3, d4 := digest.FromString("1"), digest.FromString("2"), digest.FromString("3"), digest.FromString("4")

	p.print(&bkclient.SolveStatus{Vertexes: []*bkclient.Vertex{
		{Digest: d1, Name: "[internal] load build definition from Dockerfile", Started: &t0},
		{Digest: d4, Name: "importing cache manifest from x", Started: &t0},
	}})
	p.print(&bkclient.SolveStatus{
		Vertexes: []*bkclient.Vertex{
			{Digest: d1, Name: "[internal] load build definition from Dockerfile", Started: &t0, Completed: &t1},
			{Digest: d2, Name: "[1/2] FROM busybox", Started: &t0, Completed: &t1, Cached: true},
			{Digest: d3, Name: "[2/2] RUN make", Started: &t0},
			{Digest: d4, Name: "importing cache manifest from x", Started: &t0, Completed: &t1, Error: "not found"},
		},
		Logs: []*bkclient.VertexLog{
			{Vertex: d3, Stream: 1, Data: []byte("compiling\npartial ")},
			{Vertex: d3, Stream: 2, Data: []byte("line token=hunter2-secret\n")},
		},
		Warnings: []*bkclient.VertexWarning{{Vertex: d1, Short: []byte("FromAsCasing")}},
	})
	p.print(&bkclient.SolveStatus{Vertexes: []*bkclient.Vertex{
		{Digest: d3, Name: "[2/2] RUN make", Started: &t0, Completed: &t1, Error: `process "/bin/sh -c make" did not complete successfully: exit code: 2`},
	}})
	b.Close()

	var out []string
	for _, f := range sink.all() {
		for _, l := range f.Lines {
			out = append(out, string(l.Stream)+" "+l.Text)
		}
	}
	got := strings.Join(out, "\n")
	for _, want := range []string{
		"stdout #1 [internal] load build definition from Dockerfile",
		"stdout #1 DONE 1.5s",
		"stdout #3 [1/2] FROM busybox",
		"stdout #3 CACHED",
		"stdout #4 [2/2] RUN make",
		"stdout #4 compiling",
		"stdout #2 no cache to import yet",
		"stderr #4 line token=" + redactedText,
		"stderr #1 WARN: FromAsCasing",
		"stdout #4 partial",
		"stderr #4 ERROR: process",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("output missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "hunter2-secret") {
		t.Error("secret leaked")
	}

	err := p.failure(errors.New("failed to solve: process ... exit code: 2"))
	var ue *userError
	if !errors.As(err, &ue) || ue.msg != `Build step [2/2] RUN make failed: process "/bin/sh -c make" did not complete successfully: exit code: 2` {
		t.Fatalf("failure = %v", err)
	}
	empty := newProgressPrinter(b)
	if got := empty.failure(errors.New("failed to solve: dockerfile parse error on line 1: unknown instruction: FORM")).Error(); got !=
		"Build failed: dockerfile parse error on line 1: unknown instruction: FORM" {
		t.Errorf("failure without a step = %q", got)
	}
}

func TestDemux(t *testing.T) {
	frame := func(stream byte, s string) []byte {
		h := make([]byte, 8)
		h[0] = stream
		binary.BigEndian.PutUint32(h[4:], uint32(len(s)))
		return append(h, s...)
	}
	var in bytes.Buffer
	in.Write(frame(1, "hello "))
	in.Write(frame(2, "oops"))
	in.Write(frame(1, "world"))
	in.Write(frame(3, "ignored"))
	var stdout, stderr bytes.Buffer
	if err := demux(&in, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if stdout.String() != "hello world" || stderr.String() != "oops" {
		t.Fatalf("stdout %q stderr %q", stdout.String(), stderr.String())
	}
	if err := demux(bytes.NewReader(frame(1, "truncated")[:12]), io.Discard, io.Discard); err == nil {
		t.Error("truncated frame accepted")
	}
}

func TestDockerErrors(t *testing.T) {
	resp := &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader(`{"message":"No such container: x"}`))}
	err := checkDockerStatus(resp)
	if !isNotFound(err) || isConflict(err) || !strings.Contains(err.Error(), "No such container") {
		t.Fatalf("err = %v", err)
	}
	if _, err := newDockerAPI("tcp://10.0.0.1:2375"); err == nil {
		t.Error("tcp docker host accepted")
	}
}

func TestDaemonConfig(t *testing.T) {
	d := &daemon{image: BuildKitImage, proxyPort: 5001, cacheMaxBytes: 20 << 30, minFreeBytes: 5 << 30}
	cfg := d.daemonConfig()
	for _, want := range []string{`[registry."roundhouse-registry.internal:5001"]`, "http = true", "maxUsedSpace = 21474836480", "gc = true"} {
		if !strings.Contains(cfg, want) {
			t.Errorf("config missing %q:\n%s", want, cfg)
		}
	}
	spec := d.containerSpec("172.30.0.1", "hash")
	host := spec["HostConfig"].(map[string]any)
	if host["NetworkMode"] != NetworkName || host["Privileged"] != nil {
		t.Errorf("host config %+v", host)
	}
	if hosts := host["ExtraHosts"].([]string); len(hosts) != 1 || hosts[0] != registryProxyHost+":172.30.0.1" {
		t.Errorf("extra hosts %q", hosts)
	}
	if _, ok := host["PortBindings"]; ok {
		t.Error("BuildKit must not publish ports")
	}
}
