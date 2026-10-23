package cli

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

func TestDeployWithoutWait(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "deploy", "--json")
	h.golden("deploy.json", r.stdout)
	r = h.ok("", "deploy")
	contains(t, r.stdout, "Deploying API to production: dep_0005 (queued)")
	contains(t, r.stdout, "roundhouse logs --deployment dep_0005 -f")
	contains(t, r.stdout, h.fake.URL+"/deployments/dep_0005")

	for _, req := range h.fake.Requests() {
		if req.Method == "POST" && strings.HasPrefix(req.Path, "/v1/") {
			// The same-origin guard allows a mutation with no Origin; see client.Do.
			if req.Header.Get("Origin") != "" || req.Header.Get("Sec-Fetch-Site") != "" {
				t.Errorf("%s sent Origin %q", req.Path, req.Header.Get("Origin"))
			}
			if req.Query != "environment_id="+apitest.ProductionID {
				t.Errorf("%s query = %q", req.Path, req.Query)
			}
		}
	}
}

// progress advances a fresh deployment one status per poll, adding an event
// each time, and ends at final.
func progress(final string) func(*api.DeploymentDetail) {
	steps := []string{"building", "deploying", final}
	n := 0
	return func(d *api.DeploymentDetail) {
		if d.ID == apitest.ActiveDeploy || n >= len(steps) {
			return
		}
		d.Status = steps[n]
		d.Events = append(d.Events, api.DeploymentEvent{ID: fmt.Sprintf("dev_%d", 100+n), DeploymentID: d.ID, Type: "status_changed",
			Message: "Status changed to " + steps[n], CreatedAt: apitest.Now + int64(n)*1000})
		if steps[n] == "failed" {
			d.FailureReason = new("Build failed: exit code 1")
		}
		n++
	}
}

func TestDeployWaitSuccess(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.OnGetDeployment = progress("active")
	r := h.ok("", "deploy", "--wait")
	for _, s := range []string{"Status changed to building", "Status changed to deploying", "Status changed to active", "✓ dep_0004 is active", "https://shop.example.com"} {
		contains(t, r.stdout, s)
	}
	if strings.Count(r.stdout, "Status changed to building") != 1 {
		t.Errorf("events repeated:\n%s", r.stdout)
	}
	notContains(t, r.stdout+r.stderr, "\x1b[")
}

func TestDeployWaitJSON(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.OnGetDeployment = progress("active")
	r := h.ok("", "deploy", "--wait", "--json")
	h.golden("deploy-wait.json", r.stdout)
}

func TestDeployWaitFailure(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.OnGetDeployment = progress("failed")
	r := h.expect(exitcode.DeploymentFailed, "", "deploy", "--wait")
	contains(t, r.stderr, "deployment dep_0004 failed: Build failed: exit code 1")
}

func TestDeployInterruptedKeepsRunning(t *testing.T) {
	h := newHarness(t)
	h.link()
	ctx, cancel := context.WithCancel(context.Background())
	h.fake.OnGetDeployment = func(d *api.DeploymentDetail) { cancel() }
	r := h.exec(ctx, "", false, "deploy", "--wait")
	if r.code != exitcode.Interrupted {
		t.Fatalf("exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stderr, "Stopped watching; dep_0004 continues")
}

func TestDeployTimeout(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.expect(exitcode.Error, "", "deploy", "--wait", "--timeout", "20ms")
	contains(t, r.stderr, "timed out")
}

func TestDeployNeedsService(t *testing.T) {
	h := newHarness(t)
	h.login()
	h.ok("", "link", "--project", "shop", "--gitignore=false")
	r := h.expect(exitcode.InputRequired, "", "deploy")
	contains(t, r.stderr, "pass --service")
	h.ok("", "deploy", "--service", "db")
	r = h.interactive("2\n", "deploy")
	if r.code != 0 || !strings.Contains(r.stdout, "Deploying Postgres") {
		t.Fatalf("exit %d\n%s\n%s", r.code, r.stdout, r.stderr)
	}
}

func TestRollback(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.expect(exitcode.InputRequired, "", "rollback")
	contains(t, r.stderr, "pass --yes")
	if r := h.interactive("n\n", "rollback"); r.code != exitcode.Error || !strings.Contains(r.stderr, "Roll back to dep_0001 (removed") {
		t.Fatalf("exit %d\n%s", r.code, r.stderr)
	}
	r = h.ok("", "rollback", "--yes", "--json")
	h.golden("rollback.json", r.stdout)

	r = h.expect(exitcode.Conflict, "", "rollback", "dep_0002", "--yes")
	contains(t, r.stderr, "Cannot roll back to a failed deployment")
	h.expect(exitcode.NotFound, "", "rollback", "dep_nope", "--yes")
}

func TestRollbackWait(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.OnGetDeployment = progress("active")
	r := h.ok("", "rollback", apitest.ActiveDeploy, "--yes", "--wait")
	contains(t, r.stdout, "Rolling back to dep_0003: dep_0004")
	contains(t, r.stdout, "✓ dep_0004 is active")
}

func TestCancel(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.expect(exitcode.Conflict, "", "cancel")
	contains(t, r.stderr, "the latest deployment dep_0003 is active; nothing to cancel")
	h.ok("", "deploy")
	r = h.ok("", "cancel", "--json")
	h.golden("cancel.json", r.stdout)
	if d := h.fake.Deployment("dep_0004"); d.Status != api.StatusCancelled {
		t.Errorf("status = %s", d.Status)
	}
	r = h.expect(exitcode.Conflict, "", "cancel", "dep_0004")
	contains(t, r.stderr, "A cancelled deployment can't be cancelled")
}

// flakyTransport fails the first n deployment polls with a network error.
type flakyTransport struct {
	mu sync.Mutex
	n  int
}

func (f *flakyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	f.mu.Lock()
	fail := f.n > 0 && req.Method == http.MethodGet && strings.HasPrefix(req.URL.Path, "/v1/deployments/")
	if fail {
		f.n--
	}
	f.mu.Unlock()
	if fail {
		return nil, errors.New("connection reset by peer")
	}
	return http.DefaultTransport.RoundTrip(req)
}

func TestWatchRetriesNetworkErrors(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.OnGetDeployment = progress("active")
	h.transport = &flakyTransport{n: maxPollFailures}
	h.ok("", "deploy", "--wait")

	h.transport = &flakyTransport{n: maxPollFailures + 1}
	r := h.expect(exitcode.Network, "", "deploy", "--wait")
	contains(t, r.stderr, "connection reset by peer")
}
