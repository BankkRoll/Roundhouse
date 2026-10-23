package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/config"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

func readLink(t *testing.T, dir string) *config.Link {
	t.Helper()
	l, _, err := config.FindLink(dir)
	if err != nil || l == nil {
		t.Fatalf("FindLink: %v %v", l, err)
	}
	return l
}

func TestLinkWithFlags(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.ok("", "link", "--project", "shop", "--environment", "staging", "--service", "API", "--gitignore", "--json")
	h.golden("link.json", r.stdout)
	l := readLink(t, h.dir)
	if l.ProjectID != apitest.ProjectID || l.EnvironmentID != apitest.StagingID || l.ServiceID != apitest.APIServiceID || l.URL != h.fake.URL {
		t.Errorf("link = %+v", l)
	}
	gi, err := os.ReadFile(filepath.Join(h.dir, ".gitignore"))
	if err != nil || !strings.Contains(string(gi), ".roundhouse/\n") {
		t.Errorf(".gitignore = %q, %v", gi, err)
	}
	// Linking again leaves .gitignore alone.
	r = h.ok("", "link", "--project", "prj_shop", "--json")
	contains(t, r.stdout, `"gitignore": "present"`)

	// A nested directory finds the link in its parent.
	sub := filepath.Join(h.dir, "src", "app")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if l := readLink(t, sub); l.ProjectID != apitest.ProjectID {
		t.Errorf("nested link = %+v", l)
	}
}

func TestLinkNonInteractive(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.expect(exitcode.InputRequired, "", "link")
	contains(t, r.stderr, "--project")

	// Without --gitignore a script never gets a prompt; .gitignore is untouched.
	r = h.ok("", "link", "--project", "shop")
	contains(t, r.stderr, "Tip: add .roundhouse/")
	if _, err := os.Stat(filepath.Join(h.dir, ".gitignore")); !os.IsNotExist(err) {
		t.Errorf(".gitignore created without consent: %v", err)
	}
	// Two services and none named: linked without a service.
	if l := readLink(t, h.dir); l.ServiceID != "" {
		t.Errorf("link = %+v", l)
	}
	h.expect(exitcode.NotFound, "", "link", "--project", "nope")
	h.expect(exitcode.NotFound, "", "link", "--project", "shop", "--service", "nope")
}

func TestLinkInteractive(t *testing.T) {
	h := newHarness(t)
	h.login()
	// Project 1 (Shop), environment 2 (staging), service 3 (Postgres), add to .gitignore.
	r := h.interactive("1\n2\n3\ny\n", "link")
	if r.code != 0 {
		t.Fatalf("exit %d\n%s\n%s", r.code, r.stdout, r.stderr)
	}
	contains(t, r.stderr, "Which project?")
	contains(t, r.stderr, "Which environment?")
	contains(t, r.stderr, "Which service?")
	l := readLink(t, h.dir)
	if l.EnvironmentID != apitest.StagingID || l.ServiceID != apitest.DBServiceID {
		t.Errorf("link = %+v", l)
	}
	if _, err := os.Stat(filepath.Join(h.dir, ".gitignore")); err != nil {
		t.Errorf(".gitignore: %v", err)
	}
	contains(t, r.stdout, "Linked "+h.dir+" to Shop / staging / Postgres")
}

func TestGitignoreAtRepoRoot(t *testing.T) {
	h := newHarness(t)
	h.login()
	if err := os.Mkdir(filepath.Join(h.dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.dir, ".gitignore"), []byte("node_modules"), 0o644); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(h.dir, "services", "api")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	h.dir, sub = sub, h.dir
	h.ok("", "link", "--project", "shop", "--service", "api", "--gitignore")
	gi, _ := os.ReadFile(filepath.Join(sub, ".gitignore"))
	if !strings.HasPrefix(string(gi), "node_modules\n") || !strings.HasSuffix(string(gi), ".roundhouse/\n") {
		t.Errorf("root .gitignore = %q", gi)
	}
}

func TestInitCreatesAndLinks(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.ok("", "init", "--name", "Blog", "--json", "--gitignore=false")
	h.golden("init.json", r.stdout)
	l := readLink(t, h.dir)
	if l.ProjectName != "Blog" || l.ServiceID != "" || l.EnvironmentName != "production" {
		t.Errorf("link = %+v", l)
	}
	h.expect(exitcode.Conflict, "", "init", "--name", "Blog", "--gitignore=false")
	// Non-interactive init defaults the name to the directory's.
	r = h.ok("", "init", "--gitignore=false")
	contains(t, r.stdout, "Created project "+filepath.Base(h.dir))
}

func TestUnlink(t *testing.T) {
	h := newHarness(t)
	h.expect(exitcode.NotLinked, "", "unlink")
	h.link()
	h.ok("", "unlink")
	if l, _, _ := config.FindLink(h.dir); l != nil {
		t.Errorf("still linked: %+v", l)
	}
}

func TestLinkBoundToControlPlane(t *testing.T) {
	h := newHarness(t)
	h.link()
	// Another profile on another control plane must not use this link's IDs.
	other := apitest.New(t)
	h.ok(apitest.Password+"\n", "login", "--profile", "other", "--url", other.URL, "--insecure", "--email", apitest.Email, "--password-stdin")
	r := h.expect(exitcode.NotLinked, "", "status", "--profile", "other")
	contains(t, r.stderr, "linked to a project on "+h.fake.URL)
}

func TestStatus(t *testing.T) {
	h := newHarness(t)
	h.expect(exitcode.Unauthenticated, "", "status")
	h.login()
	r := h.expect(exitcode.NotLinked, "", "status")
	contains(t, r.stderr, "roundhouse link")

	h.ok("", "link", "--project", "shop", "--service", "api", "--gitignore=false")
	r = h.ok("", "status", "--json")
	h.golden("status.json", r.stdout)
	r = h.ok("", "status")
	h.golden("status.txt", r.stdout)

	r = h.ok("", "status", "--service", "db", "--environment", "staging", "--json")
	contains(t, r.stdout, `"latest_deployment": null`)
	h.expect(exitcode.NotFound, "", "status", "--environment", "nope")
}

func TestStatusWithoutService(t *testing.T) {
	h := newHarness(t)
	h.login()
	h.ok("", "link", "--project", "shop", "--gitignore=false")
	r := h.ok("", "status")
	contains(t, r.stdout, "none linked (2 services: api, db)")
}

func TestOpen(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "open")
	// The API lists domains by hostname.
	if strings.TrimSpace(r.stdout) != "https://api-production-x7k2.apps.example.com" {
		t.Errorf("open printed %q", r.stdout)
	}
	if len(h.opened) != 0 {
		t.Errorf("opened a browser with stdout redirected: %v", h.opened)
	}
	r = h.ok("", "open", "--dashboard", "--json")
	contains(t, r.stdout, `"url": "`+h.fake.URL+"/w/ws_acme/p/prj_shop/s/svc_api")
	h.expect(exitcode.NotFound, "", "open", "--service", "db")
}

func TestDomain(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "domain", "--json")
	h.golden("domain.json", r.stdout)
	r = h.ok("", "domain", "--all")
	contains(t, r.stdout, "https://api-staging-q9p1.apps.example.com      staging")
}
