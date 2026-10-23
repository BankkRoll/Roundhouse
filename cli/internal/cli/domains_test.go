package cli

import (
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

func domainByHost(h *harness, host string) *api.Domain {
	for _, d := range h.fake.Domains() {
		if d.Hostname == host {
			return &d
		}
	}
	return nil
}

func TestDomainAddPrintsRecords(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "domain", "add", "Blog.Example.com.")
	contains(t, r.stdout, "Added blog.example.com to API in production")
	contains(t, r.stdout, "Create these DNS records:")
	contains(t, r.stdout, "CNAME   blog.example.com")
	contains(t, r.stdout, "api-production-x7k2.apps.example.com")
	contains(t, r.stdout, "_roundhouse.blog.example.com")
	contains(t, r.stdout, "rh-verify=")
	contains(t, r.stdout, "No CNAME or A/AAAA record found for blog.example.com.")

	d := domainByHost(h, "blog.example.com")
	if d == nil || d.Status != "pending_dns" || d.EnvironmentID != apitest.ProductionID {
		t.Fatalf("stored domain: %+v", d)
	}

	r = h.ok("", "domain", "add", "news.example.com", "--json")
	var out api.Domain
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil {
		t.Fatal(err)
	}
	if out.Hostname != "news.example.com" || len(out.Records) != 2 {
		t.Fatalf("json: %+v", out)
	}

	r = h.expect(exitcode.Conflict, "", "domain", "add", "blog.example.com")
	contains(t, r.stderr, "already added")
	r = h.expect(exitcode.Invalid, "", "domain", "add", "*.example.com")
	contains(t, r.stderr, "Wildcard domains")
}

func TestDomainVerify(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.ok("", "domain", "add", "blog.example.com")

	h.fake.SetDNS("blog.example.com", apitest.DNSState{Routing: true})
	r := h.ok("", "domain", "verify", "blog.example.com")
	contains(t, r.stdout, "pending_verification")
	contains(t, r.stdout, "TXT _roundhouse.blog.example.com not found.")

	r = h.expect(exitcode.Error, "", "domain", "verify", "blog.example.com", "--wait", "--timeout", "50ms")
	contains(t, r.stderr, "was not verified within 50ms")

	h.fake.SetDNS("blog.example.com", apitest.DNSState{Routing: true, Ownership: true})
	r = h.ok("", "domain", "verify", "blog.example.com", "--json")
	var out api.Domain
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "active" || out.VerificationStatus != "verified" {
		t.Fatalf("after verify: %+v", out)
	}

	h.expect(exitcode.Conflict, "", "domain", "verify", "api-production-x7k2.apps.example.com")
	h.expect(exitcode.NotFound, "", "domain", "verify", "nope.example.com")
}

func TestDomainVerifyWaitsUntilVerified(t *testing.T) {
	old := domainCheckInterval
	domainCheckInterval = time.Millisecond
	t.Cleanup(func() { domainCheckInterval = old })

	h := newHarness(t)
	h.link()
	h.ok("", "domain", "add", "blog.example.com")
	h.fake.SetDNS("blog.example.com", apitest.DNSState{Routing: true, Ownership: true})
	r := h.ok("", "domain", "verify", "blog.example.com", "--wait")
	contains(t, r.stdout, "active")
}

func TestDomainRemove(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.ok("", "domain", "add", "blog.example.com")

	r := h.expect(exitcode.Usage, "", "domain", "remove", "blog.example.com")
	contains(t, r.stderr, "pass --yes")
	if domainByHost(h, "blog.example.com") == nil {
		t.Fatal("removed without confirmation")
	}
	r = h.interactive("n\n", "domain", "remove", "blog.example.com")
	if r.code != exitcode.Error || domainByHost(h, "blog.example.com") == nil {
		t.Fatalf("declined remove: exit %d", r.code)
	}
	r = h.interactive("y\n", "domain", "remove", "blog.example.com")
	if r.code != 0 {
		t.Fatalf("confirmed remove: exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stdout, "Removed blog.example.com")
	if domainByHost(h, "blog.example.com") != nil {
		t.Fatal("domain still there")
	}

	h.expect(exitcode.Conflict, "", "domain", "remove", "api-production-x7k2.apps.example.com", "--yes")
	h.expect(exitcode.NotFound, "", "domain", "remove", "nope.example.com", "--yes")
}

func TestDomainListSubcommand(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "domain", "list")
	contains(t, r.stdout, "shop.example.com")
	contains(t, r.stdout, "active")
	all := h.ok("", "domain", "ls", "--all", "--json")
	var out []api.Domain
	if err := json.Unmarshal([]byte(all.stdout), &out); err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(out, func(d api.Domain) bool { return d.EnvironmentID == apitest.StagingID }) {
		t.Fatalf("--all missed staging: %+v", out)
	}
}
