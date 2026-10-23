package api

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

func TestParseBaseURL(t *testing.T) {
	for _, tc := range []struct {
		in       string
		insecure bool
		want     string
		err      string
	}{
		{in: "https://cp.example.com", want: "https://cp.example.com"},
		{in: "https://CP.example.com/", want: "https://cp.example.com"},
		{in: "cp.example.com:8443", want: "https://cp.example.com:8443"},
		{in: "http://127.0.0.1:8787", insecure: true, want: "http://127.0.0.1:8787"},
		{in: "http://localhost", insecure: true, want: "http://localhost"},
		{in: "http://[::1]:80", insecure: true, want: "http://[::1]:80"},
		{in: "http://127.0.0.1:8787", err: "without --insecure"},
		{in: "http://cp.example.com", insecure: true, err: "use https://"},
		{in: "https://user:pw@cp.example.com", err: "credentials"},
		{in: "https://cp.example.com/dashboard", err: "without a path"},
		{in: "ftp://cp.example.com", err: "https:// origin"},
		{in: "", err: "no control plane URL"},
	} {
		u, err := ParseBaseURL(tc.in, tc.insecure)
		if tc.err != "" {
			if err == nil || !strings.Contains(err.Error(), tc.err) {
				t.Errorf("ParseBaseURL(%q) error = %v, want %q", tc.in, err, tc.err)
			}
			continue
		}
		if err != nil || u.String() != tc.want {
			t.Errorf("ParseBaseURL(%q) = %v, %v; want %s", tc.in, u, err, tc.want)
		}
	}
}

func TestRouteExpandEscapes(t *testing.T) {
	var gotRaw string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRaw = r.URL.EscapedPath()
		w.Write([]byte(`{"id":"x"}`))
	}))
	defer srv.Close()
	c, err := New(Options{BaseURL: srv.URL, Insecure: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetProject(context.Background(), "../a b/?x"); err != nil {
		t.Fatal(err)
	}
	if gotRaw != "/v1/projects/..%2Fa%20b%2F%3Fx" {
		t.Errorf("path = %q", gotRaw)
	}
	defer func() {
		if recover() == nil {
			t.Error("expand with missing params did not panic")
		}
	}()
	RouteGetProject.expand()
}

func TestParseError(t *testing.T) {
	five := 5
	e := parseError(400, []byte(`{"error":{"code":"invalid_reference","message":"bad","details":[{"field":"A","code":"malformed_reference","message":"m","start":1,"end":5}]}}`))
	if e.Code != "invalid_reference" || e.Message != "bad" || len(e.Details) != 1 || *e.Details[0].End != five || e.ExitCode() != exitcode.Invalid {
		t.Errorf("API envelope: %+v", e)
	}
	e = parseError(401, []byte(`{"code":"INVALID_EMAIL_OR_PASSWORD","message":"Invalid email or password"}`))
	if e.Code != "invalid_email_or_password" || e.Message != "Invalid email or password" || e.ExitCode() != exitcode.Unauthenticated {
		t.Errorf("Better Auth envelope: %+v", e)
	}
	e = parseError(502, []byte("<html>bad gateway</html>"))
	if e.Message != "502 Bad Gateway" || e.ExitCode() != exitcode.Network {
		t.Errorf("HTML body: %+v", e)
	}
	for status, code := range map[int]int{403: exitcode.Forbidden, 404: exitcode.NotFound, 409: exitcode.Conflict, 429: exitcode.Error} {
		if got := (&Error{Status: status}).ExitCode(); got != code {
			t.Errorf("status %d -> exit %d, want %d", status, got, code)
		}
	}
}

func TestUTF16Span(t *testing.T) {
	s := "é😀${{x}}"
	// é is 1 UTF-16 unit (2 bytes), 😀 is 2 units (4 bytes).
	start, end := UTF16Span(s, 3, 9)
	if s[start:end] != "${{x}}" {
		t.Errorf("span = %q", s[start:end])
	}
	if _, end := UTF16Span(s, 0, 99); end != len(s) {
		t.Errorf("clamped end = %d", end)
	}
}

func TestTraceRedactsSecrets(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "better-auth.session_token", Value: "rotated-secret"})
		w.Write([]byte(`{"variables":[{"key":"K","value":"body-secret"}]}`))
	}))
	defer srv.Close()
	var logs bytes.Buffer
	var rotated *http.Cookie
	c, _ := New(Options{
		BaseURL: srv.URL, Insecure: true,
		Credential:      SessionCookie{Name: "better-auth.session_token", Value: "cookie-secret"},
		Logger:          slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		OnSessionCookie: func(ck *http.Cookie) { rotated = ck },
	})
	if _, err := c.ListVariables(context.Background(), VariableScope{ServiceID: "svc"}, "env"); err != nil {
		t.Fatal(err)
	}
	out := logs.String()
	for _, secret := range []string{"cookie-secret", "rotated-secret", "body-secret"} {
		if strings.Contains(out, secret) {
			t.Errorf("trace contains %q:\n%s", secret, out)
		}
	}
	if !strings.Contains(out, "Cookie: [REDACTED]") || !strings.Contains(out, "Set-Cookie: [REDACTED]") {
		t.Errorf("trace lacks redaction markers:\n%s", out)
	}
	if rotated == nil || rotated.Value != "rotated-secret" {
		t.Errorf("rotated cookie = %v", rotated)
	}
}

func TestRedirectsAreNotFollowed(t *testing.T) {
	var leaked bool
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true }))
	defer evil.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, evil.URL+"/steal", http.StatusFound)
	}))
	defer srv.Close()
	c, _ := New(Options{BaseURL: srv.URL, Insecure: true, Credential: SessionCookie{Name: "n", Value: "v"}})
	_, err := c.Me(context.Background())
	if !IsStatus(err, http.StatusFound) || leaked {
		t.Errorf("err = %v, leaked = %v", err, leaked)
	}
}

func TestNetworkError(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	c, _ := New(Options{BaseURL: url, Insecure: true})
	_, err := c.Me(context.Background())
	var ne *NetworkError
	if !errors.As(err, &ne) || exitcode.Of(err) != exitcode.Network {
		t.Errorf("err = %v (exit %d)", err, exitcode.Of(err))
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.Me(ctx); !errors.Is(err, context.Canceled) || exitcode.Of(err) != exitcode.Interrupted {
		t.Errorf("cancelled: %v", err)
	}
}

func TestCredentials(t *testing.T) {
	h := http.Header{}
	SessionCookie{Name: "__Secure-better-auth.session_token", Value: "a.b%2Bc%3D"}.Apply(h)
	if h.Get("Cookie") != "__Secure-better-auth.session_token=a.b%2Bc%3D" {
		t.Errorf("cookie header = %q", h.Get("Cookie"))
	}
	h = http.Header{}
	BearerToken("tok_x").Apply(h)
	if h.Get("Authorization") != "Bearer tok_x" {
		t.Errorf("authorization = %q", h.Get("Authorization"))
	}
	if DefaultSessionCookieName(true) != "__Secure-better-auth.session_token" || DefaultSessionCookieName(false) != "better-auth.session_token" {
		t.Error("default cookie names")
	}
	if !IsSessionCookie("__Secure-roundhouse.session_token") || IsSessionCookie("better-auth.session_data") {
		t.Error("IsSessionCookie")
	}
}

func TestStatusHelpers(t *testing.T) {
	for status, want := range map[string][3]bool{ // settled, success, cancellable
		StatusQueued: {false, false, true}, StatusBuilding: {false, false, true}, StatusDeploying: {false, false, true},
		StatusActive: {true, true, false}, StatusFailed: {true, false, false}, StatusCrashed: {true, false, false},
		StatusCancelled: {true, false, false}, StatusRemoved: {true, true, false}, StatusRolledBack: {true, true, false},
	} {
		got := [3]bool{IsSettled(status), IsSuccess(status), IsCancellable(status)}
		if got != want {
			t.Errorf("%s: %v, want %v", status, got, want)
		}
	}
}

func TestSessionCookieCleared(t *testing.T) {
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		header  string
		cleared bool
	}{
		{"better-auth.session_token=abc.sig; Max-Age=604800; Path=/", false},
		{"better-auth.session_token=abc.sig; Path=/", false},
		{"better-auth.session_token=abc.sig; Expires=Thu, 29 Oct 2026 12:00:00 GMT", false},
		{"better-auth.session_token=; Max-Age=0; Path=/", true},
		{"better-auth.session_token=abc.sig; Max-Age=0", true},
		{"better-auth.session_token=; Path=/", true},
		{"better-auth.session_token=abc.sig; Expires=Thu, 01 Jan 1970 00:00:00 GMT", true},
	} {
		ck, err := http.ParseSetCookie(tc.header)
		if err != nil {
			t.Fatalf("%s: %v", tc.header, err)
		}
		if got := SessionCookieCleared(ck, now); got != tc.cleared {
			t.Errorf("SessionCookieCleared(%q) = %v, want %v", tc.header, got, tc.cleared)
		}
	}
}

func TestBearerTokenIgnoresSetCookie(t *testing.T) {
	var auth, cookie string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth, cookie = r.Header.Get("Authorization"), r.Header.Get("Cookie")
		http.SetCookie(w, &http.Cookie{Name: "better-auth.session_token", Value: "someone-elses-session"})
		w.Write([]byte(`{"user":{"id":"usr_1"},"workspaces":[]}`))
	}))
	defer srv.Close()
	called := false
	c, _ := New(Options{BaseURL: srv.URL, Insecure: true, Credential: BearerToken("tok_abc"),
		OnSessionCookie: func(*http.Cookie) { called = true }})
	if _, err := c.Me(context.Background()); err != nil {
		t.Fatal(err)
	}
	if auth != "Bearer tok_abc" || cookie != "" {
		t.Errorf("Authorization %q, Cookie %q", auth, cookie)
	}
	if called {
		t.Error("a bearer-token client reported a session cookie")
	}
	if !IsAPIToken("tok_abc") || IsAPIToken("sess_abc.sig") {
		t.Error("IsAPIToken")
	}
}

func TestRealtimeClosedError(t *testing.T) {
	for code, want := range map[int]struct {
		exit      int
		retryable bool
	}{
		CloseUnauthorized: {exitcode.Unauthenticated, false},
		CloseForbidden:    {exitcode.Forbidden, false},
		CloseNotFound:     {exitcode.NotFound, false},
		ClosePolicy:       {exitcode.Error, false},
		CloseTooBig:       {exitcode.Error, false},
		1001:              {exitcode.Network, true},
		1011:              {exitcode.Network, true},
		1012:              {exitcode.Network, true},
	} {
		e := &RealtimeClosedError{Code: code, Reason: "r"}
		if e.ExitCode() != want.exit || e.Retryable() != want.retryable || exitcode.Of(e) != want.exit {
			t.Errorf("close %d: exit %d retryable %v, want %+v", code, e.ExitCode(), e.Retryable(), want)
		}
		if !strings.Contains(e.Error(), strconv.Itoa(code)) {
			t.Errorf("close %d: message %q", code, e.Error())
		}
	}
}
