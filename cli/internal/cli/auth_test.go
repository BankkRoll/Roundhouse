package cli

import (
	"encoding/json"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/config"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

func TestLoginStoresSession(t *testing.T) {
	h := newHarness(t)
	r := h.ok(apitest.Password+"\n", "login", "--url", h.fake.URL, "--insecure", "--email", apitest.Email, "--password-stdin", "--json")
	h.golden("login.json", r.stdout)

	path := config.CredentialsPath(h.configDir)
	creds, warning, err := config.LoadCredentials(path)
	if err != nil || warning != "" {
		t.Fatalf("LoadCredentials: %v %q", err, warning)
	}
	prof := creds.Profiles[config.DefaultProfile]
	if prof == nil || prof.Session == nil || prof.Session.Value != apitest.SessionToken || prof.Session.CookieName != apitest.CookieName {
		t.Fatalf("stored profile = %+v", prof)
	}
	if !prof.Insecure || prof.URL != h.fake.URL || prof.Session.ExpiresAt == nil {
		t.Errorf("profile = %+v", prof)
	}
	if runtime.GOOS != "windows" {
		fi, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o600 {
			t.Errorf("credentials mode = %#o, want 0600", fi.Mode().Perm())
		}
	}
	for _, req := range h.fake.Requests() {
		if req.Pattern == "POST /api/auth/sign-in/email" && req.Header.Get("Origin") != "" {
			t.Errorf("sign-in sent Origin %q; a first login needs none", req.Header.Get("Origin"))
		}
	}
	notContains(t, r.stdout+r.stderr, apitest.SessionToken)
	notContains(t, r.stdout+r.stderr, apitest.Password)
}

func TestLoginErrors(t *testing.T) {
	h := newHarness(t)
	r := h.expect(exitcode.Unauthenticated, "wrong password\n", "login", "--url", h.fake.URL, "--insecure", "--email", apitest.Email, "--password-stdin")
	contains(t, r.stderr, "invalid email or password")

	r = h.expect(exitcode.InputRequired, "", "login", "--url", h.fake.URL, "--insecure", "--email", apitest.Email)
	contains(t, r.stderr, "--password-stdin")

	r = h.expect(exitcode.Usage, "", "login", "--url", h.fake.URL, "--email", apitest.Email, "--password-stdin")
	contains(t, r.stderr, "without --insecure")

	r = h.expect(exitcode.Usage, "", "login", "--url", "http://cp.example.com", "--insecure", "--password-stdin")
	contains(t, r.stderr, "use https://")

	r = h.expect(exitcode.InputRequired, "", "login", "--password-stdin")
	contains(t, r.stderr, "pass --url")
}

func TestLoginInteractive(t *testing.T) {
	h := newHarness(t)
	r := h.interactive(apitest.Email+"\n"+apitest.Password+"\n", "login", "--url", h.fake.URL, "--insecure")
	if r.code != 0 {
		t.Fatalf("exit %d: %s", r.code, r.stderr)
	}
	contains(t, r.stdout, "Logged in to "+h.fake.URL+" as Ada Lovelace")
	contains(t, r.stderr, "Password:")
	notContains(t, r.stderr+r.stdout, apitest.Password)
}

func TestLogoutRevokesSession(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.ok("", "logout", "--json")
	h.golden("logout.json", r.stdout)
	if h.fake.SessionValid() {
		t.Error("session still valid on the control plane")
	}
	var signOut *apitest.Request
	for _, req := range h.fake.Requests() {
		if req.Pattern == "POST /api/auth/sign-out" {
			signOut = &req
		}
	}
	if signOut == nil || signOut.Header.Get("Origin") != h.fake.URL || !strings.Contains(signOut.Header.Get("Cookie"), apitest.SessionToken) {
		t.Fatalf("sign-out request = %+v", signOut)
	}
	creds, _, _ := config.LoadCredentials(config.CredentialsPath(h.configDir))
	if p := creds.Profiles[config.DefaultProfile]; p == nil || p.Session != nil || p.URL != h.fake.URL {
		t.Errorf("profile after logout = %+v", p)
	}
	h.expect(exitcode.Unauthenticated, "", "whoami")
	r = h.ok("", "logout")
	contains(t, r.stdout, "Not logged in")
}

func TestWhoami(t *testing.T) {
	h := newHarness(t)
	h.expect(exitcode.Unauthenticated, "", "whoami")
	h.login()
	r := h.ok("", "whoami", "--json")
	h.golden("whoami.json", r.stdout)
	r = h.ok("", "whoami")
	contains(t, r.stdout, "Ada Lovelace <ada@example.com>")
	contains(t, r.stdout, "Acme")
	notContains(t, r.stdout, "\x1b[")
}

func TestRevokedSessionHint(t *testing.T) {
	h := newHarness(t)
	h.login()
	h.ok("", "logout")
	// Restore the stale session locally, as if it had been revoked elsewhere.
	path := config.CredentialsPath(h.configDir)
	creds, _, _ := config.LoadCredentials(path)
	creds.Profiles[config.DefaultProfile].Session = &config.Session{CookieName: apitest.CookieName, Value: apitest.SessionToken}
	if err := creds.Save(path); err != nil {
		t.Fatal(err)
	}
	r := h.expect(exitcode.Unauthenticated, "", "whoami")
	contains(t, r.stderr, "run `roundhouse login`")
}

func TestProfiles(t *testing.T) {
	h := newHarness(t)
	h.ok(apitest.Password+"\n", "login", "--profile", "staging", "--url", h.fake.URL, "--insecure", "--email", apitest.Email, "--password-stdin")
	h.expect(exitcode.Unauthenticated, "", "whoami")
	r := h.ok("", "whoami", "--profile", "staging")
	contains(t, r.stdout, "profile staging")
	h.env[EnvProfile] = "staging"
	h.ok("", "whoami")
}

func TestTokenEnvironment(t *testing.T) {
	h := newHarness(t)
	h.fake.Login()
	h.env[EnvURL] = h.fake.URL
	h.env[EnvToken] = apitest.SessionToken
	r := h.expect(exitcode.Usage, "", "whoami")
	contains(t, r.stderr, "--insecure")
	r = h.ok("", "whoami", "--insecure")
	contains(t, r.stdout, "("+EnvToken+")")

	// API tokens are sent as bearer tokens, ready for when the API accepts them.
	h.env[EnvToken] = "tok_example"
	h.expect(exitcode.Unauthenticated, "", "whoami", "--insecure")
	reqs := h.fake.Requests()
	last := reqs[len(reqs)-1]
	if last.Header.Get("Authorization") != "Bearer tok_example" || last.Header.Get("Cookie") != "" {
		t.Errorf("headers = %v", last.Header)
	}
}

func TestCredentialsPermissionWarning(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no Unix mode bits; access is governed by the %AppData% ACL")
	}
	h := newHarness(t)
	h.login()
	path := config.CredentialsPath(h.configDir)
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	r := h.ok("", "whoami")
	contains(t, r.stderr, "readable by other users")
	contains(t, r.stderr, "chmod 600")
	// Saving rewrites the file 0600 again.
	h.ok("", "logout")
	fi, _ := os.Stat(path)
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("mode after save = %#o", fi.Mode().Perm())
	}
}

func TestDebugTraceRedactsCredentials(t *testing.T) {
	h := newHarness(t)
	r := h.ok(apitest.Password+"\n", "login", "--url", h.fake.URL, "--insecure", "--email", apitest.Email, "--password-stdin", "--debug")
	contains(t, r.stderr, "http response")
	contains(t, r.stderr, "Set-Cookie: [REDACTED]")
	r = h.ok("", "whoami", "--debug")
	contains(t, r.stderr, "http request")
	contains(t, r.stderr, "Cookie: [REDACTED]")
	for _, out := range []string{r.stdout, r.stderr} {
		notContains(t, out, apitest.SessionToken)
		notContains(t, out, apitest.Password)
	}
}

func TestJSONErrors(t *testing.T) {
	h := newHarness(t)
	h.login()
	r := h.expect(exitcode.NotLinked, "", "status", "--json")
	if r.stdout != "" {
		t.Errorf("stdout = %q", r.stdout)
	}
	var body struct {
		Error struct {
			Message  string `json:"message"`
			ExitCode int    `json:"exit_code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(r.stderr), &body); err != nil {
		t.Fatalf("stderr is not JSON: %v\n%s", err, r.stderr)
	}
	if body.Error.ExitCode != exitcode.NotLinked || !strings.Contains(body.Error.Message, "roundhouse link") {
		t.Errorf("error = %+v", body.Error)
	}
}

func TestExpiredSession(t *testing.T) {
	h := newHarness(t)
	h.login()
	path := config.CredentialsPath(h.configDir)
	creds, _, _ := config.LoadCredentials(path)
	past := time.UnixMilli(apitest.Now).Add(-time.Hour)
	creds.Profiles[config.DefaultProfile].Session.ExpiresAt = &past
	if err := creds.Save(path); err != nil {
		t.Fatal(err)
	}
	r := h.expect(exitcode.Unauthenticated, "", "whoami")
	contains(t, r.stderr, "expired on")
	for _, req := range h.fake.Requests() {
		if req.Pattern == "GET /v1/me" {
			t.Error("sent an expired session to the control plane")
		}
	}
}
