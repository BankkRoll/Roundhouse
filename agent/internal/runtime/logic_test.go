package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/leaktest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

func TestShouldRestart(t *testing.T) {
	for _, tc := range []struct {
		policy   protocol.RestartPolicy
		max      int
		restarts int
		code     int
		oom      bool
		want     bool
	}{
		{protocol.RestartAlways, 0, 100, 0, false, true},
		{protocol.RestartAlways, 0, 0, 1, false, true},
		{protocol.RestartNever, 0, 0, 1, false, false},
		{protocol.RestartNever, 0, 0, 0, true, false},
		{protocol.RestartOnFailure, 0, 0, 0, false, false},
		{protocol.RestartOnFailure, 0, 500, 1, false, true},
		{protocol.RestartOnFailure, 3, 2, 1, false, true},
		{protocol.RestartOnFailure, 3, 3, 1, false, false},
		{protocol.RestartOnFailure, 3, 0, 0, true, true},
	} {
		got := shouldRestart(protocol.Restart{Policy: tc.policy, MaxRetries: tc.max}, tc.restarts, tc.code, tc.oom)
		if got != tc.want {
			t.Errorf("%+v: got %v", tc, got)
		}
	}
	if stoppedState(0, false) != protocol.StateExited || stoppedState(2, false) != protocol.StateCrashed ||
		stoppedState(0, true) != protocol.StateCrashed {
		t.Error("stoppedState")
	}
}

func TestBackoffDelay(t *testing.T) {
	for streak, want := range []time.Duration{1, 2, 4, 8, 16, 32, 60, 60} {
		if got := backoffDelay(time.Second, time.Minute, streak); got != want*time.Second {
			t.Errorf("streak %d: %v, want %v", streak, got, want*time.Second)
		}
	}
	if got := backoffDelay(time.Second, time.Minute, 1<<20); got != time.Minute {
		t.Errorf("huge streak: %v", got)
	}
}

func TestHealthTracker(t *testing.T) {
	start := time.Unix(1000, 0)
	at := func(s int) time.Time { return start.Add(time.Duration(s) * time.Second) }
	fail := errors.New("connection refused")
	hc := protocol.Healthcheck{Type: protocol.HealthcheckHTTP, IntervalS: 5, TimeoutS: 2, Retries: 3, StartPeriodS: 10}

	type step struct {
		at      int
		err     error
		want    health
		changed bool
	}
	for name, steps := range map[string][]step{
		"failures in the start period do not count": {
			{1, fail, healthUnknown, false}, {6, fail, healthUnknown, false},
			{11, fail, healthUnknown, false}, {16, fail, healthUnknown, false}, {21, fail, healthUnhealthy, true},
		},
		"a pass in the start period counts at once": {
			{1, nil, healthHealthy, true}, {2, nil, healthHealthy, false},
		},
		"after the first pass start period failures count": {
			{1, nil, healthHealthy, true}, {2, fail, healthHealthy, false}, {3, fail, healthHealthy, false},
			{4, fail, healthUnhealthy, true}, {5, fail, healthUnhealthy, false},
		},
		"one pass recovers and resets the count": {
			{11, fail, healthUnknown, false}, {12, nil, healthHealthy, true}, {13, fail, healthHealthy, false},
			{14, fail, healthHealthy, false}, {15, nil, healthHealthy, false}, {16, fail, healthHealthy, false},
		},
	} {
		tr := newHealthTracker(hc, start)
		for i, s := range steps {
			changed := tr.observe(s.err, at(s.at))
			if tr.state != s.want || changed != s.changed {
				t.Errorf("%s: step %d: state %d changed %v, want %d %v", name, i, tr.state, changed, s.want, s.changed)
			}
		}
	}

	zero := newHealthTracker(protocol.Healthcheck{IntervalS: 30, Retries: 0}, start)
	if zero.observe(fail, at(1)); zero.state != healthUnhealthy {
		t.Error("retries 0 should mean the first counted failure is fatal")
	}
	if zero.firstDelay() != time.Second || newHealthTracker(protocol.Healthcheck{IntervalS: 1}, start).firstDelay() != time.Second {
		t.Error("first probe delay")
	}
}

func TestDefaultProber(t *testing.T) {
	leaktest.Check(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok":
			w.WriteHeader(204)
		case "/redirect":
			http.Redirect(w, r, "/nowhere", http.StatusFound)
		default:
			w.WriteHeader(503)
		}
	}))
	defer srv.Close()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ := strconv.Atoi(portStr)
	ctx := context.Background()
	probe := func(typ protocol.HealthcheckType, path string) error {
		return DefaultProber(ctx, protocol.Healthcheck{Type: typ, Path: path, Port: port, TimeoutS: 1}, host)
	}
	if err := probe(protocol.HealthcheckHTTP, "/ok"); err != nil {
		t.Errorf("2xx: %v", err)
	}
	if err := probe(protocol.HealthcheckHTTP, "/redirect"); err != nil {
		t.Errorf("3xx must pass without following: %v", err)
	}
	if err := probe(protocol.HealthcheckHTTP, "/fail"); err == nil || !strings.Contains(err.Error(), "503") {
		t.Errorf("5xx: %v", err)
	}
	if err := probe(protocol.HealthcheckTCP, ""); err != nil {
		t.Errorf("tcp: %v", err)
	}
	if err := probe(protocol.HealthcheckNone, ""); err != nil {
		t.Errorf("none: %v", err)
	}
	if err := DefaultProber(ctx, protocol.Healthcheck{Type: protocol.HealthcheckTCP, Port: port}, ""); err == nil {
		t.Error("probe without an IP passed")
	}
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	closedPort := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	if err := DefaultProber(ctx, protocol.Healthcheck{Type: protocol.HealthcheckTCP, Port: closedPort}, "127.0.0.1"); err == nil {
		t.Error("closed port passed")
	}
}

func TestStatusBoardQueuesAndRemoves(t *testing.T) {
	b := newStatusBoard()
	dep := ptr("dep_1")
	b.set(protocol.WorkloadStatusReport{WorkloadID: "wl_a", DeploymentID: dep, State: protocol.StatePulling})
	b.set(protocol.WorkloadStatusReport{WorkloadID: "wl_b", State: protocol.StateRunning})
	b.set(protocol.WorkloadStatusReport{WorkloadID: "wl_a", DeploymentID: dep, State: protocol.StateStarting})
	b.set(protocol.WorkloadStatusReport{WorkloadID: "wl_a", DeploymentID: dep, State: protocol.StateStarting})
	got := b.take()
	if len(got) != 3 || got[0].State != protocol.StatePulling || got[1].WorkloadID != "wl_b" || got[2].State != protocol.StateStarting {
		t.Fatalf("take = %+v", got)
	}
	if len(b.take()) != 0 {
		t.Fatal("unchanged status re-queued")
	}
	b.sync(map[string]protocol.WorkloadStatusReport{"wl_b": {WorkloadID: "wl_b", State: protocol.StateRunning}}, true)
	got = b.take()
	if len(got) != 1 || got[0].WorkloadID != "wl_a" || got[0].State != protocol.StateRemoved || got[0].DeploymentID != dep {
		t.Fatalf("removal = %+v", got)
	}
	if all := b.all(); len(all) != 1 || all[0].WorkloadID != "wl_b" {
		t.Fatalf("all = %+v", all)
	}
	long := strings.Repeat("é", protocol.MaxMessageBytes)
	b.set(protocol.WorkloadStatusReport{WorkloadID: "wl_c", State: protocol.StateCrashed, Message: long})
	if r, _ := b.get("wl_c"); len(r.Message) > protocol.MaxMessageBytes || !strings.HasPrefix(long, r.Message) {
		t.Fatalf("message not truncated safely: %d bytes", len(r.Message))
	}
}

func TestStatusBoardHelloCap(t *testing.T) {
	b := newStatusBoard()
	for i := range protocol.MaxStatusesPerHello + 10 {
		b.set(protocol.WorkloadStatusReport{WorkloadID: "wl_" + strconv.Itoa(1000+i), State: protocol.StateHealthy})
	}
	if n := len(b.all()); n != protocol.MaxStatusesPerHello {
		t.Fatalf("all = %d", n)
	}
}

func TestIngressSelection(t *testing.T) {
	rt := New(Options{Docker: newFakeDocker()})
	w := spec("wl_a", "svc_web")
	ws := &wantSpec{WorkloadSpec: w}
	net := w.Network
	add := func(id, workload, hash string, running bool, h health, ip string) *instance {
		inst := &instance{id: id, running: running, health: h, ips: map[string]string{net: ip},
			meta: meta{workloadID: workload, specHash: hash, network: net, routes: w.Routes}}
		rt.instances[id] = inst
		return inst
	}
	ds := desired(1, w)
	cfg := func() []string {
		c := rt.ingressConfig(ds, []*wantSpec{ws}, nil, nil)
		if len(c.Routes) == 0 {
			return nil
		}
		return c.Routes[0].Upstreams
	}

	old := add("c1", "wl_a", "oldhash", true, healthHealthy, "10.0.0.1")
	cur := add("c2", "wl_a", w.SpecHash, true, healthUnknown, "10.0.0.2")
	if got := cfg(); len(got) != 1 || got[0] != "10.0.0.1:80" {
		t.Fatalf("starting replacement: %v", got)
	}
	cur.health = healthHealthy
	if got := cfg(); len(got) != 1 || got[0] != "10.0.0.2:80" {
		t.Fatalf("healthy replacement: %v", got)
	}
	cur.health = healthUnhealthy
	old.drainAt = time.Now()
	if got := cfg(); len(got) != 1 || got[0] != "10.0.0.2:80" {
		t.Fatalf("degraded fallback: %v", got)
	}
	cur.running = false
	if got := cfg(); got != nil {
		t.Fatalf("nothing serving: %v", got)
	}
}

func TestReplacementReady(t *testing.T) {
	rt := New(Options{Docker: newFakeDocker()})
	a := spec("wl_a", "svc_web")
	b := spec("wl_b", "svc_web")
	other := spec("wl_c", "svc_api")
	specs := []*wantSpec{{WorkloadSpec: b}, {WorkloadSpec: other}}
	old := &instance{id: "old", running: true, meta: meta{workloadID: "wl_a", serviceID: "svc_web", environmentID: "env_1", specHash: a.SpecHash}}
	rt.instances["old"] = old
	if rt.replacementReady(old, specs) {
		t.Fatal("ready with no replacement container")
	}
	rt.instances["new"] = &instance{id: "new", running: true, health: healthUnknown, meta: meta{workloadID: "wl_b", specHash: b.SpecHash}}
	if rt.replacementReady(old, specs) {
		t.Fatal("ready before the replacement is healthy")
	}
	rt.instances["new"].health = healthHealthy
	if !rt.replacementReady(old, specs) {
		t.Fatal("not ready with a healthy replacement")
	}
	lone := &instance{id: "lone", running: true, meta: meta{workloadID: "wl_z", serviceID: "svc_gone", environmentID: "env_1"}}
	if !rt.replacementReady(lone, specs) {
		t.Fatal("a removed service without replicas here must drain at once")
	}
}

func TestLabelsRoundTrip(t *testing.T) {
	w := spec("wl_a", "svc_web")
	w.Routes = append(w.Routes, protocol.WorkloadRoute{Hostname: "api.example.com", ContainerPort: 80, PathPrefix: "/v1"})
	w.DrainS = 30
	s := &wantSpec{WorkloadSpec: w, generation: 7}
	l := containerLabels(s)
	if l[LabelManaged] != "true" {
		t.Fatal("user label overrode roundhouse.managed")
	}
	m := parseMeta(l)
	if m.workloadID != "wl_a" || m.generation != 7 || m.drainS != 30 || len(m.routes) != 2 ||
		m.routes[1].PathPrefix != "/v1" || m.serviceID != "svc_web" || m.network != w.Network {
		t.Fatalf("meta %+v", m)
	}
	sys := registrySpec(&protocol.RegistryConfig{Storage: protocol.RegistryStorage{Type: protocol.StorageFilesystem}}, "/data", 1)
	if l := containerLabels(sys); l[LabelDeploymentID] != "" || l[LabelKind] != "system" {
		t.Fatalf("system labels %v", l)
	}
	if err := sys.Validate(); err != nil {
		t.Fatalf("registry spec invalid: %v", err)
	}
}

func TestStatusQueueCollapsesWhenFull(t *testing.T) {
	b := newStatusBoard()
	for i := range maxPendingStatuses + 1 {
		b.set(protocol.WorkloadStatusReport{WorkloadID: "wl_" + strconv.Itoa(i%3), State: protocol.StateRunning, Restarts: i})
	}
	got := b.take()
	if len(got) != 3 {
		t.Fatalf("collapsed queue has %d entries", len(got))
	}
	for _, r := range got {
		if cur, _ := b.get(r.WorkloadID); cur.Restarts != r.Restarts {
			t.Fatalf("collapsed to a stale status: %+v", r)
		}
	}
}

func TestCommandAndEntrypointMapping(t *testing.T) {
	w := spec("wl_a", "svc_web")
	w.Command = []string{"/bin/sh", "-c", "npm start"}
	cc := containerCreate(&wantSpec{WorkloadSpec: rehash(w)})
	if !slices.Equal(cc.Cmd, w.Command) || cc.Entrypoint != nil {
		t.Fatalf("cmd %v entrypoint %v", cc.Cmd, cc.Entrypoint)
	}
	// The engine keeps the image's ENTRYPOINT only if the field is absent
	// from the request; an empty list would clear it.
	body, err := json.Marshal(cc)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(body, &raw)
	if _, ok := raw["Entrypoint"]; ok {
		t.Fatalf("Entrypoint sent without one in the spec: %s", raw["Entrypoint"])
	}
	if string(raw["Cmd"]) != `["/bin/sh","-c","npm start"]` {
		t.Fatalf("Cmd = %s", raw["Cmd"])
	}

	w.Entrypoint = []string{"/sbin/tini", "--"}
	cc = containerCreate(&wantSpec{WorkloadSpec: rehash(w)})
	if !slices.Equal(cc.Entrypoint, w.Entrypoint) || !slices.Equal(cc.Cmd, w.Command) {
		t.Fatalf("cmd %v entrypoint %v", cc.Cmd, cc.Entrypoint)
	}

	w.Command, w.Entrypoint = nil, nil
	body, _ = json.Marshal(containerCreate(&wantSpec{WorkloadSpec: rehash(w)}))
	clear(raw)
	_ = json.Unmarshal(body, &raw)
	if _, ok := raw["Cmd"]; ok {
		t.Fatal("Cmd sent without a command in the spec")
	}
}

func TestPrivateDomainAliases(t *testing.T) {
	svcAlias := protocol.PrivateServiceAlias("svc_web")
	mk := func(id, service, domain, network string) *wantSpec {
		w := spec(id, service)
		w.Labels = map[string]string{}
		if domain != "" {
			w.Labels[LabelPrivateDomain] = domain
		}
		if network != "" {
			w.Network = network
		}
		return &wantSpec{WorkloadSpec: rehash(w)}
	}
	aliases := func(specs ...*wantSpec) [][]string {
		assignLabelAliases(specs)
		var out [][]string
		for _, s := range specs {
			out = append(out, containerCreate(s).NetworkingConfig.EndpointsConfig[s.Network].Aliases)
		}
		return out
	}
	cases := []struct {
		name  string
		specs []*wantSpec
		want  [][]string
	}{
		{"service alias always", []*wantSpec{mk("wl_a", "svc_web", "", "")}, [][]string{{svcAlias}}},
		{"valid label", []*wantSpec{mk("wl_a", "svc_web", "api.production.internal", "")},
			[][]string{{svcAlias, "api.production.internal"}}},
		{"not a private domain", []*wantSpec{mk("wl_a", "svc_web", "api.example.com", "")}, [][]string{{svcAlias}}},
		{"too many labels", []*wantSpec{mk("wl_a", "svc_web", "a.b.production.internal", "")}, [][]string{{svcAlias}}},
		{"garbage", []*wantSpec{mk("wl_a", "svc_web", "Not A Host", "")}, [][]string{{svcAlias}}},
		{"replicas share it", []*wantSpec{
			mk("wl_a", "svc_web", "api.production.internal", ""), mk("wl_b", "svc_web", "api.production.internal", ""),
		}, [][]string{{svcAlias, "api.production.internal"}, {svcAlias, "api.production.internal"}}},
		{"lowest workload ID wins between services", []*wantSpec{
			mk("wl_b", "svc_web", "api.production.internal", ""), mk("wl_a", "svc_evil", "api.production.internal", ""),
		}, [][]string{{svcAlias}, {protocol.PrivateServiceAlias("svc_evil"), "api.production.internal"}}},
		{"other networks don't contend", []*wantSpec{
			mk("wl_b", "svc_web", "api.production.internal", ""),
			mk("wl_a", "svc_other", "api.production.internal", protocol.ProjectNetworkName("prj_1")),
		}, [][]string{{svcAlias, "api.production.internal"}, {protocol.PrivateServiceAlias("svc_other"), "api.production.internal"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := aliases(tc.specs...)
			if !slices.EqualFunc(got, tc.want, slices.Equal) {
				t.Fatalf("aliases %v, want %v", got, tc.want)
			}
		})
	}

	loser := mk("wl_b", "svc_web", "api.production.internal", "")
	aliases(loser, mk("wl_a", "svc_evil", "api.production.internal", ""))
	if !strings.Contains(loser.note, "claimed by another service") {
		t.Fatalf("note %q", loser.note)
	}
	sys := registrySpec(&protocol.RegistryConfig{Storage: protocol.RegistryStorage{Type: protocol.StorageFilesystem}}, "/d", 1)
	sys.Labels[LabelPrivateDomain] = "registry.system.internal"
	if a := networkAliases(sys); a != nil {
		t.Fatalf("system workload aliases %v", a)
	}
}

func TestRouteConflictsBetweenProjects(t *testing.T) {
	route := func(id, project, host, prefix string) *wantSpec {
		w := spec(id, "svc_"+id)
		w.ProjectID = ptr(project)
		w.Network = protocol.EnvironmentNetworkName(project, "env_1")
		w.Routes = []protocol.WorkloadRoute{{Hostname: host, ContainerPort: 80, PathPrefix: prefix}}
		return &wantSpec{WorkloadSpec: rehash(w)}
	}
	cases := []struct {
		name      string
		specs     []*wantSpec
		conflicts []routeKey
	}{
		{"one project", []*wantSpec{route("wl_a", "prj_1", "a.example.com", ""), route("wl_b", "prj_1", "a.example.com", "")}, nil},
		{"two projects, same host", []*wantSpec{route("wl_a", "prj_1", "a.example.com", ""), route("wl_b", "prj_2", "a.example.com", "/")},
			[]routeKey{{"a.example.com", "/"}}},
		{"two projects, other prefixes", []*wantSpec{route("wl_a", "prj_1", "a.example.com", "/api"), route("wl_b", "prj_2", "a.example.com", "/")}, nil},
		{"two projects, same prefix", []*wantSpec{route("wl_a", "prj_1", "a.example.com", "/api"), route("wl_b", "prj_2", "a.example.com", "/api")},
			[]routeKey{{"a.example.com", "/api"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var lines []string
			rt := New(Options{SystemLog: func(wl, dep, text string) { lines = append(lines, wl+": "+text) }})
			got := rt.markRouteConflicts(tc.specs)
			if len(got) != len(tc.conflicts) {
				t.Fatalf("conflicts %v, want %v", got, tc.conflicts)
			}
			for _, k := range tc.conflicts {
				if !got[k] {
					t.Fatalf("conflicts %v, want %v", got, tc.conflicts)
				}
			}
			if len(tc.conflicts) == 0 {
				return
			}
			for _, s := range tc.specs {
				if !strings.Contains(s.note, "another project claims it") {
					t.Errorf("%s note %q", s.ID, s.note)
				}
			}
			if len(lines) != 2 || strings.Contains(strings.Join(lines, "\n"), "prj_") {
				t.Fatalf("system lines %q: one per workload, never naming the other project", lines)
			}
			cfg := rt.ingressConfig(desired(1), tc.specs, got, nil)
			if len(cfg.Routes) != 0 || len(cfg.AllowedHosts) != 0 {
				t.Fatalf("conflicting route served: %+v", cfg)
			}
			rt.markRouteConflicts(tc.specs)
			if len(lines) != 2 {
				t.Fatal("conflict logged again on the next pass")
			}
		})
	}
}

func TestIngressConfigCarriesTLSSettings(t *testing.T) {
	rt := New(Options{Docker: newFakeDocker()})
	w := spec("wl_a", "svc_web")
	h := &protocol.RouteHSTS{MaxAge: 31536000, IncludeSubdomains: true}
	w.Routes = []protocol.WorkloadRoute{
		{Hostname: "shop.example.com", ContainerPort: 80, HSTS: h},
		{Hostname: "*.apps.example.com", ContainerPort: 80},
	}
	ds := desired(1, w)
	ds.TLSMode = protocol.TLSManaged
	up := &protocol.ACMEChallengeUpstream{URL: "https://cp.example.com/v1/acme/http-01", Host: "cp.example.com"}
	ds.Ingress = &protocol.IngressSettings{ACMEChallengeUpstream: up, ManagedHosts: []string{"*.apps.example.com"}}
	cfg := rt.ingressConfig(ds, []*wantSpec{{WorkloadSpec: w}}, nil, nil)
	if cfg.TLSMode != protocol.TLSManaged || cfg.ChallengeUpstream != up ||
		!slices.Equal(cfg.ManagedHosts, []string{"*.apps.example.com"}) {
		t.Fatalf("ingress settings lost: %+v", cfg)
	}
	got := map[string]*protocol.RouteHSTS{}
	for _, r := range cfg.Routes {
		got[r.Host] = r.HSTS
	}
	if len(got) != 2 || got["shop.example.com"] != h || got["*.apps.example.com"] != nil {
		t.Fatalf("route HSTS = %+v", got)
	}
}
