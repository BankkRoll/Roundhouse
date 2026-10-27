package cli

import (
	"encoding/json"
	"slices"
	"strings"
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

func TestDomainListShowsCertificateExpiry(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "domain", "list")
	contains(t, r.stdout, "issued, expires in 89d")
	h.fake.SetDomainTLS("shop.example.com", api.DomainTLS{Status: "failed", Nodes: []api.DomainTLSNode{}})
	r = h.ok("", "domain", "list")
	contains(t, r.stdout, "failed")
}

func TestDomainVerifyPrintsCertificate(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.ok("", "domain", "add", "blog.example.com")
	r := h.ok("", "domain", "verify", "blog.example.com")
	if strings.Contains(r.stdout, "Certificate:") {
		t.Errorf("certificate shown before verification:\n%s", r.stdout)
	}

	h.fake.SetDNS("blog.example.com", apitest.DNSState{Routing: true, Ownership: true})
	r = h.ok("", "domain", "verify", "blog.example.com")
	contains(t, r.stdout, "Certificate: issued by R11, expires 2027-")
	contains(t, r.stdout, "(in 90d)")

	h.fake.SetDomainTLS("blog.example.com", api.DomainTLS{
		Status: "failed", Error: strp("Let's Encrypt could not reach the HTTP-01 challenge."),
		Nodes: []api.DomainTLSNode{
			{NodeID: "node_1", Name: "edge-1", State: "issued"},
			{NodeID: "node_2", Name: "edge-2", State: "failed", Error: strp("rate limited")},
		},
	})
	r = h.ok("", "domain", "verify", "blog.example.com")
	contains(t, r.stdout, "Certificate: failed")
	contains(t, r.stdout, "could not reach the HTTP-01 challenge")
	contains(t, r.stdout, "edge-2: failed rate limited")
	if strings.Contains(r.stdout, "edge-1:") {
		t.Errorf("listed a node that has its certificate:\n%s", r.stdout)
	}
}

func TestDomainAddNotesServersWithoutReplicas(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.SetRoutingNodes([]api.DomainRoutingNode{
		{ID: "node_1", Name: "edge-1", PublicIP: strp("203.0.113.10"), Serves: true},
		{ID: "node_2", Name: "edge-2", PublicIP: strp("203.0.113.11"), Serves: false},
	})
	r := h.ok("", "domain", "add", "blog.example.com")
	contains(t, r.stdout, "Only servers running a replica of this service answer for blog.example.com: edge-1 (203.0.113.10). Point DNS at those, not at edge-2.")
	contains(t, r.stdout, "WireGuard mesh")

	h.fake.SetRoutingNodes([]api.DomainRoutingNode{{ID: "node_2", Name: "edge-2", Serves: false}})
	r = h.ok("", "domain", "verify", "blog.example.com")
	contains(t, r.stdout, "No server runs a replica of this service yet")

	h.fake.SetRoutingNodes([]api.DomainRoutingNode{{ID: "node_1", Name: "edge-1", Serves: true}})
	r = h.ok("", "domain", "verify", "blog.example.com")
	if strings.Contains(r.stdout, "replica") {
		t.Errorf("routing note shown when every server serves:\n%s", r.stdout)
	}
}

func TestDomainHSTSShowAndChange(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "domain", "hsts", "shop.example.com")
	contains(t, r.stdout, "shop.example.com  max-age=31536000")

	r = h.ok("", "domain", "hsts", "shop.example.com", "--max-age", "180d", "--include-subdomains")
	contains(t, r.stdout, "HSTS for shop.example.com: max-age=15552000; includeSubDomains")
	contains(t, r.stderr, "includeSubDomains makes browsers refuse plain HTTP")
	if d := domainByHost(h, "shop.example.com"); d.HSTS != (api.DomainHSTS{Enabled: true, MaxAge: 15552000, IncludeSubdomains: true}) {
		t.Fatalf("stored policy: %+v", d.HSTS)
	}

	r = h.ok("", "domain", "hsts", "shop.example.com", "--include-subdomains=false", "--max-age", "1h", "--json")
	contains(t, r.stderr, "under a day")
	var out api.Domain
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil {
		t.Fatal(err)
	}
	if out.HSTS.MaxAge != 3600 || out.HSTS.IncludeSubdomains {
		t.Fatalf("json: %+v", out.HSTS)
	}

	r = h.ok("", "domain", "hsts", "shop.example.com", "--disable")
	contains(t, r.stdout, "HSTS for shop.example.com: off")
	r = h.ok("", "domain", "hsts", "shop.example.com", "--disable")
	contains(t, r.stdout, "already off")

	r = h.expect(exitcode.Usage, "", "domain", "hsts", "shop.example.com", "--max-age", "soon")
	contains(t, r.stderr, "invalid --max-age")
	h.expect(exitcode.Usage, "", "domain", "hsts", "shop.example.com", "--enable", "--disable")
	r = h.expect(exitcode.Invalid, "", "domain", "hsts", "shop.example.com", "--max-age", "3y")
	contains(t, r.stderr, "from 0 to 63072000")
	h.expect(exitcode.Conflict, "", "domain", "hsts", "api-production-x7k2.apps.example.com", "--max-age", "2y")
	h.ok("", "domain", "hsts", "api-production-x7k2.apps.example.com")
}

func TestDomainHSTSPreload(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.ok("", "domain", "add", "example.com")

	r := h.expect(exitcode.Invalid, "", "domain", "hsts", "shop.example.com", "--preload", "--include-subdomains", "--confirm-preload", "shop.example.com")
	contains(t, r.stderr, "Only a registered domain's apex")
	r = h.expect(exitcode.Invalid, "", "domain", "hsts", "example.com", "--preload")
	contains(t, r.stderr, "Preload needs includeSubDomains.")

	preload := []string{"domain", "hsts", "example.com", "--preload", "--include-subdomains", "--max-age", "2y"}
	r = h.expect(exitcode.InputRequired, "", preload...)
	contains(t, r.stderr, "pass --confirm-preload example.com")
	r = h.expect(exitcode.Usage, "", append(preload, "--confirm-preload", "shop.example.com")...)
	contains(t, r.stderr, "does not match")

	r = h.interactive("nope\n", preload...)
	if r.code != exitcode.Error || domainByHost(h, "example.com").HSTS.Preload {
		t.Fatalf("mistyped confirmation: exit %d, preload %v", r.code, domainByHost(h, "example.com").HSTS.Preload)
	}

	r = h.interactive("example.com\n", preload...)
	if r.code != 0 {
		t.Fatalf("confirmed preload: exit %d\n%s", r.code, r.stderr)
	}
	contains(t, r.stderr, "effectively irreversible")
	contains(t, r.stdout, "max-age=63072000; includeSubDomains; preload")
	contains(t, r.stdout, "hstspreload.org")

	var body api.UpdateDomainInput
	for _, req := range h.fake.Requests() {
		if req.Pattern == "PATCH /v1/domains/{domainId}" {
			if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
				t.Fatal(err)
			}
		}
	}
	if body.ConfirmPreload != "example.com" {
		t.Errorf("confirm_preload sent: %q", body.ConfirmPreload)
	}

	h.ok("", "domain", "hsts", "example.com", "--preload=false", "--json")
	h.ok("", "domain", "hsts", "example.com", "--preload", "--confirm-preload", "example.com", "--json")
}

func TestParseMaxAge(t *testing.T) {
	for in, want := range map[string]int{"0": 0, "31536000": 31536000, "1y": 31536000, "2w": 1209600, "180d": 15552000, "12h": 43200, "90s": 90} {
		if got, err := parseMaxAge(in); err != nil || got != want {
			t.Errorf("parseMaxAge(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, in := range []string{"", "-1", "1.5y", "1ms", "soon", "-2d"} {
		if _, err := parseMaxAge(in); err == nil {
			t.Errorf("parseMaxAge(%q) accepted", in)
		}
	}
}
