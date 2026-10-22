package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/BankkRoll/Open-Rail/cli/internal/api"
	"github.com/BankkRoll/Open-Rail/cli/internal/apitest"
	"github.com/BankkRoll/Open-Rail/cli/internal/exitcode"
	"github.com/BankkRoll/Open-Rail/cli/internal/ui"
)

func TestLogsHistory(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "logs", "-n", "3")
	lines := strings.Split(strings.TrimSpace(r.stdout), "\n")
	if len(lines) != 3 || !strings.HasSuffix(lines[0], "request 247") || !strings.HasSuffix(lines[2], "request 249") {
		t.Fatalf("logs -n 3:\n%s", r.stdout)
	}
	r = h.ok("", "logs", "-n", "4", "--json")
	h.golden("logs.ndjson", r.stdout)
}

func TestLogsPagesBackwards(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "logs", "-n", "1200", "--json")
	if n := strings.Count(r.stdout, "\n"); n != 250 {
		t.Fatalf("got %d lines, want all 250", n)
	}
	var pages int
	for _, req := range h.fake.Requests() {
		if req.Pattern == "GET /v1/deployments/{deploymentId}/logs" {
			pages++
		}
	}
	if pages != 1 {
		t.Errorf("fetched %d pages for 250 lines with limit 1000", pages)
	}

	// A long history forces several pages, oldest first in the output.
	var many []api.LogEntry
	for i := range 2500 {
		many = append(many, api.LogEntry{TS: apitest.Now - int64(2500-i), Stream: "stdout", Text: "line"})
	}
	many[0].Text = "first"
	h.fake.SetLogs("dep:"+apitest.ActiveDeploy, many)
	r = h.ok("", "logs", "-n", "5000")
	got := strings.Split(strings.TrimSpace(r.stdout), "\n")
	if len(got) != 2500 || !strings.HasSuffix(got[0], "first") {
		t.Fatalf("got %d lines, first %q", len(got), got[0])
	}
}

func TestLogsSince(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "logs", "--since", "10s", "--json")
	if n := strings.Count(r.stdout, "\n"); n != 10 {
		t.Fatalf("--since 10s returned %d lines:\n%s", n, r.stdout)
	}
	contains(t, r.stdout, `"text":"request 240"`)
	h.expect(exitcode.Usage, "", "logs", "--since", "yesterday")
	r = h.ok("", "logs", "--since", "2026-10-22T11:59:58Z")
	if n := strings.Count(r.stdout, "\n"); n != 2 {
		t.Errorf("--since timestamp returned %d lines", n)
	}
}

func TestLogsBuild(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "logs", "--build", "--deployment", apitest.ActiveDeploy)
	contains(t, r.stdout, "Cloning https://github.com/acme/shop")
	contains(t, r.stdout, "npm warn deprecated")
	r = h.expect(exitcode.NotFound, "", "logs", "--build", "--deployment", "dep_0001")
	contains(t, r.stderr, "has no build")
}

func TestLogsNoDeployments(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.expect(exitcode.NotFound, "", "logs", "--service", "db")
	contains(t, r.stderr, "no deployments in production yet")
}

func TestLogsFollowEndedDeployment(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "logs", "-f", "--deployment", "dep_0002")
	contains(t, r.stderr, "Deployment dep_0002 is failed; not following.")
}

// followRun starts `logs -f` and returns a channel with its result.
func followRun(h *harness, ctx context.Context, args ...string) <-chan result {
	done := make(chan result, 1)
	go func() { done <- h.exec(ctx, "", false, append([]string{"logs", "-f"}, args...)...) }()
	return done
}

func await(t *testing.T, done <-chan result) result {
	t.Helper()
	select {
	case r := <-done:
		return r
	case <-time.After(15 * time.Second):
		t.Fatal("logs -f did not finish")
		return result{}
	}
}

func runtimeLines(texts ...string) api.RealtimeMessage {
	msg := api.RealtimeMessage{Type: "log.lines", Source: &api.RealtimeLogSource{Type: "runtime", ServiceID: apitest.APIServiceID, DeploymentID: apitest.ActiveDeploy, WorkloadID: "wl_0001"}}
	for i, text := range texts {
		msg.Lines = append(msg.Lines, api.LogEntry{TS: apitest.Now + int64(i), Stream: "stdout", Text: text})
	}
	return msg
}

func TestLogsFollow(t *testing.T) {
	h := newHarness(t)
	h.link()
	done := followRun(h, context.Background(), "-n", "2", "--json")
	h.fake.WaitSubscribed(t, "deployment_logs:"+apitest.ActiveDeploy)

	// The last history line arrives again live; it is printed once.
	dup := runtimeLines()
	dup.Lines = []api.LogEntry{{TS: apitest.Now - 1000, Stream: "stderr", Text: "request 249"}}
	h.fake.Publish(dup)
	h.fake.Publish(runtimeLines("live one", "live two"))
	// Lines of another deployment are ignored.
	other := runtimeLines("someone else")
	other.Source.DeploymentID = "dep_other"
	h.fake.Publish(other)
	removed := h.fake.Deployment(apitest.ActiveDeploy).Deployment
	removed.Status = api.StatusRemoved
	h.fake.Publish(api.RealtimeMessage{Type: "deployment.updated", Deployment: &removed})

	r := await(t, done)
	if r.code != 0 {
		t.Fatalf("exit %d\n%s", r.code, r.stderr)
	}
	h.golden("logs-follow.ndjson", r.stdout)
	if strings.Count(r.stdout, "request 249") != 1 {
		t.Errorf("history line repeated from the live stream:\n%s", r.stdout)
	}
	contains(t, r.stderr, "is now removed")
	for _, req := range h.fake.Requests() {
		if req.Pattern == "GET /v1/projects/{projectId}/realtime" {
			if req.Header.Get("Origin") != h.fake.URL || !strings.Contains(req.Header.Get("Cookie"), apitest.SessionToken) {
				t.Errorf("realtime upgrade headers: Origin %q", req.Header.Get("Origin"))
			}
		}
	}
}

func TestLogsFollowReconnects(t *testing.T) {
	h := newHarness(t)
	h.link()
	done := followRun(h, context.Background(), "-n", "0", "--deployment", apitest.ActiveDeploy)
	h.fake.WaitSubscribed(t, "deployment_logs:"+apitest.ActiveDeploy)
	h.fake.Publish(runtimeLines("before drop"))
	time.Sleep(50 * time.Millisecond)
	h.fake.DropSockets()
	h.fake.WaitSubscribed(t, "deployment_logs:"+apitest.ActiveDeploy)
	h.fake.Publish(runtimeLines("after reconnect"))
	removed := h.fake.Deployment(apitest.ActiveDeploy).Deployment
	removed.Status = api.StatusRolledBack
	h.fake.Publish(api.RealtimeMessage{Type: "deployment.updated", Deployment: &removed})
	r := await(t, done)
	if r.code != 0 {
		t.Fatalf("exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stdout, "before drop")
	contains(t, r.stdout, "after reconnect")
	contains(t, r.stderr, "reconnecting")
	if strings.Count(r.stdout, "before drop") != 1 {
		t.Errorf("duplicate lines after reconnect:\n%s", r.stdout)
	}
}

func TestLogsFollowBuildEnds(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.ok("", "deploy")
	d := h.fake.Deployment("dep_0004")
	build := api.Build{ID: "bld_0004", DeploymentID: d.ID, ServiceID: apitest.APIServiceID, Status: "running"}
	d.BuildID, d.Build = &build.ID, &build

	done := followRun(h, context.Background(), "--build")
	h.fake.WaitSubscribed(t, "build_logs:bld_0004")
	h.fake.Publish(api.RealtimeMessage{Type: "log.lines", Source: &api.RealtimeLogSource{Type: "build", ServiceID: apitest.APIServiceID, BuildID: "bld_0004"},
		Lines: []api.LogEntry{{TS: apitest.Now, Stream: "system", Text: "Pushing image"}}})
	finished := d.Deployment
	finished.Build = &api.Build{ID: "bld_0004", Status: "succeeded"}
	h.fake.Publish(api.RealtimeMessage{Type: "deployment.updated", Deployment: &finished})
	r := await(t, done)
	contains(t, r.stdout, "Pushing image")
	contains(t, r.stderr, "Build succeeded.")
}

func TestLogsFollowInterrupt(t *testing.T) {
	h := newHarness(t)
	h.link()
	ctx, cancel := context.WithCancel(context.Background())
	done := followRun(h, ctx, "-n", "0")
	h.fake.WaitSubscribed(t, "deployment_logs:"+apitest.ActiveDeploy)
	cancel()
	if r := await(t, done); r.code != 0 {
		t.Errorf("Ctrl-C during logs -f exited %d", r.code)
	}
}

func TestRealtimeRequiresOrigin(t *testing.T) {
	h := newHarness(t)
	h.fake.Login()
	c, err := api.New(api.Options{BaseURL: h.fake.URL, Insecure: true, Credential: api.SessionCookie{Name: apitest.CookieName, Value: apitest.SessionToken}})
	if err != nil {
		t.Fatal(err)
	}
	rt, err := c.DialRealtime(context.Background(), apitest.ProjectID)
	if err != nil {
		t.Fatalf("DialRealtime: %v", err)
	}
	rt.Close()

	anon, _ := api.New(api.Options{BaseURL: h.fake.URL, Insecure: true})
	if _, err := anon.DialRealtime(context.Background(), apitest.ProjectID); !api.IsStatus(err, 401) {
		t.Errorf("anonymous dial: %v", err)
	}
}

func TestLogColouring(t *testing.T) {
	var out bytes.Buffer
	a := &App{Env: Env{IO: ui.Test("", &out, &out)}}
	p := &logPrinter{a: a, pal: ui.NewPalette(true), seen: newDedupe(4), replicas: true}
	p.print([]api.LogEntry{
		{TS: apitest.Now, Stream: "stdout", Text: "plain", WorkloadID: "wl_000001"},
		{TS: apitest.Now, Stream: "stderr", Text: "oops", WorkloadID: "wl_000002"},
		{TS: apitest.Now, Stream: "system", Text: "restarting"},
	}, false)
	got := out.String()
	contains(t, got, "\x1b[31moops\x1b[0m")
	contains(t, got, "\x1b[36mrestarting\x1b[0m")
	contains(t, got, "\x1b[35m[000002]\x1b[0m")
	if strings.Contains(got, "\x1b[31mplain") {
		t.Error("stdout coloured as stderr")
	}

	out.Reset()
	p = &logPrinter{a: a, pal: ui.NewPalette(false), seen: newDedupe(4)}
	p.print([]api.LogEntry{{TS: apitest.Now, Stream: "stderr", Text: "oops"}}, false)
	notContains(t, out.String(), "\x1b[")
}

func TestLogHistoryKeepsRepeatedLines(t *testing.T) {
	h := newHarness(t)
	h.link()
	same := api.LogEntry{TS: apitest.Now, Stream: "stdout", Text: "retrying", WorkloadID: "wl_0001"}
	h.fake.SetLogs("dep:"+apitest.ActiveDeploy, []api.LogEntry{same, same, same})
	r := h.ok("", "logs")
	if n := strings.Count(r.stdout, "retrying"); n != 3 {
		t.Errorf("history printed %d of 3 identical lines", n)
	}
}

func TestDedupeIsBounded(t *testing.T) {
	d := newDedupe(2)
	if !d.add("a") || !d.add("b") || d.add("a") {
		t.Fatal("dedupe within capacity")
	}
	d.add("c")
	if !d.add("a") {
		t.Error("evicted key should be new again")
	}
	if len(d.set) != 2 {
		t.Errorf("set grew to %d", len(d.set))
	}
}

func TestParseSince(t *testing.T) {
	now := time.UnixMilli(apitest.Now)
	for in, want := range map[string]time.Time{
		"90s":                  now.Add(-90 * time.Second),
		"2h":                   now.Add(-2 * time.Hour),
		"1d":                   now.Add(-24 * time.Hour),
		"2026-10-22T10:00:00Z": time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC),
	} {
		got, err := parseSince(in, now)
		if err != nil || !got.Equal(want) {
			t.Errorf("parseSince(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	if _, err := parseSince("soon", now); err == nil {
		t.Error("parseSince accepted garbage")
	}
}
