// Package api is the roundhouse CLI's client for the control plane's REST
// API, Better Auth endpoints and project realtime socket.
//
// Responsibilities:
//   - typed request/response shapes mirroring apps/api/src/schemas.ts;
//   - one method per route, each declared in [Routes] so contract tests can
//     check every path against the API's OpenAPI document;
//   - error decoding into [*Error] with stable exit codes;
//   - redacted HTTP tracing for --debug;
//   - the same-origin rules the API enforces (see [Client.Do]).
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// maxResponseBytes bounds any response body the client reads.
const maxResponseBytes = 32 << 20

// Options configures a [Client].
type Options struct {
	// BaseURL is the control plane origin, e.g. https://cp.example.com.
	BaseURL string
	// Insecure allows plain http:// to a loopback host. It never disables
	// TLS verification.
	Insecure bool
	// Credential authenticates requests; nil sends none.
	Credential Credential
	// UserAgent is sent on every request.
	UserAgent string
	// Logger receives redacted request traces at debug level; nil disables them.
	Logger *slog.Logger
	// Transport overrides the HTTP transport, for tests.
	Transport http.RoundTripper
	// OnSessionCookie is called when a response sets the session cookie, so a
	// refreshed session can be persisted, or a cleared one forgotten (see
	// [SessionCookieCleared]). It is never called when Credential is a
	// [BearerToken]: a token request has no session to refresh.
	OnSessionCookie func(*http.Cookie)
}

// Client calls the control plane.
type Client struct {
	base            *url.URL
	http            *http.Client
	stream          *http.Client
	cred            Credential
	userAgent       string
	onSessionCookie func(*http.Cookie)
}

// New returns a client for the control plane at opts.BaseURL.
func New(opts Options) (*Client, error) {
	base, err := ParseBaseURL(opts.BaseURL, opts.Insecure)
	if err != nil {
		return nil, err
	}
	transport := opts.Transport
	if transport == nil {
		// SECURITY: the default TLS config verifies certificates; there is
		// deliberately no option to change it.
		transport = http.DefaultTransport.(*http.Transport).Clone()
	}
	if opts.Logger != nil {
		transport = &tracingTransport{next: transport, log: opts.Logger}
	}
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	onSessionCookie := opts.OnSessionCookie
	if _, ok := opts.Credential.(BearerToken); ok {
		onSessionCookie = nil
	}
	return &Client{
		base: base,
		// SECURITY: redirects are not followed, so the Cookie header can
		// never be replayed to another host.
		http:            &http.Client{Transport: transport, Timeout: 60 * time.Second, CheckRedirect: noRedirect},
		stream:          &http.Client{Transport: transport, CheckRedirect: noRedirect},
		cred:            opts.Credential,
		userAgent:       opts.UserAgent,
		onSessionCookie: onSessionCookie,
	}, nil
}

// BaseURL returns the control plane origin.
func (c *Client) BaseURL() *url.URL {
	u := *c.base
	return &u
}

// Origin returns the control plane origin as a browser would send it in an
// Origin header, e.g. "https://cp.example.com".
func (c *Client) Origin() string {
	return c.base.Scheme + "://" + c.base.Host
}

// ParseBaseURL validates a control plane URL and reduces it to its origin.
//
// SECURITY: plain http:// would expose the password and session cookie, so it
// is accepted only for a loopback host and only when insecure is set.
// Nothing ever disables TLS certificate verification.
func ParseBaseURL(raw string, insecure bool) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("no control plane URL: pass --url or set ROUNDHOUSE_URL")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, fmt.Errorf("control plane URL must be an https:// origin, got %q", raw)
	}
	if u.User != nil {
		return nil, fmt.Errorf("control plane URL must not contain credentials")
	}
	if u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("control plane URL must be an origin without a path, got %q", raw)
	}
	if u.Scheme == "http" {
		if !IsLoopback(u.Hostname()) {
			return nil, fmt.Errorf("refusing plain http:// to %s: use https://", u.Host)
		}
		if !insecure {
			return nil, fmt.Errorf("refusing plain http:// to %s without --insecure", u.Host)
		}
	}
	return &url.URL{Scheme: u.Scheme, Host: strings.ToLower(u.Host)}, nil
}

// IsLoopback reports whether host names the local machine.
func IsLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Route is one REST route: an HTTP method and an OpenAPI path template.
type Route struct {
	Method string
	// Path uses OpenAPI placeholders, e.g. "/v1/projects/{projectId}".
	Path string
}

// String formats the route as "METHOD /path".
func (r Route) String() string { return r.Method + " " + r.Path }

// expand fills the route's placeholders in order, escaping each value.
func (r Route) expand(params ...string) string {
	var b strings.Builder
	rest := r.Path
	for _, p := range params {
		open := strings.IndexByte(rest, '{')
		closing := strings.IndexByte(rest, '}')
		if open < 0 || closing < open {
			panic("api: too many params for " + r.Path)
		}
		b.WriteString(rest[:open])
		b.WriteString(url.PathEscape(p))
		rest = rest[closing+1:]
	}
	if strings.IndexByte(rest, '{') >= 0 {
		panic("api: missing params for " + r.Path)
	}
	b.WriteString(rest)
	return b.String()
}

// request is one call to the API.
type request struct {
	method string
	path   string
	query  url.Values
	body   any
	// origin sends an Origin header equal to the control plane's own.
	origin bool
	// cookies, when set, receives the response's cookies.
	cookies *[]*http.Cookie
}

// Do sends a request and decodes a JSON response into out (unless nil or the
// response has no body).
//
// No Origin header is sent: the API's same-origin guard
// (apps/api/src/lib/guards.ts) only rejects a mutation whose Origin differs
// from the control plane's, or which has no Origin but a cross-site
// Sec-Fetch-Site. A CLI sends neither, which the guard documents as allowed.
func (c *Client) Do(ctx context.Context, method, path string, query url.Values, in, out any) error {
	return c.do(ctx, request{method: method, path: path, query: query, body: in}, out)
}

func (c *Client) do(ctx context.Context, r request, out any) error {
	u := c.endpoint(r.path)
	if len(r.query) > 0 {
		u.RawQuery = r.query.Encode()
	}
	var body io.Reader
	if r.body != nil {
		buf, err := json.Marshal(r.body)
		if err != nil {
			return err
		}
		body = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, r.method, u.String(), body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if r.body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.userAgent != "" {
		req.Header.Set("User-Agent", c.userAgent)
	}
	if r.origin {
		req.Header.Set("Origin", c.Origin())
	}
	if c.cred != nil {
		c.cred.Apply(req.Header)
	}
	res, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &NetworkError{URL: c.Origin(), Err: unwrapURLError(err)}
	}
	defer res.Body.Close()
	c.noteCookies(res)
	if r.cookies != nil {
		*r.cookies = res.Cookies()
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes))
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &NetworkError{URL: c.Origin(), Err: err}
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return parseError(res.StatusCode, data)
	}
	if out == nil || res.StatusCode == http.StatusNoContent || len(data) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("unexpected response from %s %s: %w", r.method, r.path, err)
	}
	return nil
}

// endpoint returns the absolute URL of an already-escaped path.
func (c *Client) endpoint(escapedPath string) *url.URL {
	u := *c.base
	u.RawPath = escapedPath
	u.Path, _ = url.PathUnescape(escapedPath)
	return &u
}

func (c *Client) noteCookies(res *http.Response) {
	if c.onSessionCookie == nil {
		return
	}
	for _, ck := range res.Cookies() {
		if IsSessionCookie(ck.Name) {
			c.onSessionCookie(ck)
		}
	}
}

func unwrapURLError(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

// -----------------------------------------------------------------------------
// Tracing
// -----------------------------------------------------------------------------

// redactedHeaders never appear in traces.
var redactedHeaders = map[string]bool{
	"Authorization":       true,
	"Proxy-Authorization": true,
	"Cookie":              true,
	"Set-Cookie":          true,
}

// tracingTransport logs each request and response with secrets redacted.
//
// SECURITY: bodies are never logged: they carry passwords, variable values
// and revealed secrets. Credential headers are replaced with "[REDACTED]".
type tracingTransport struct {
	next http.RoundTripper
	log  *slog.Logger
}

// RoundTrip logs the exchange, then returns the inner transport's result.
func (t *tracingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	start := time.Now()
	t.log.Debug("http request", "method", req.Method, "url", req.URL.Redacted(), "headers", redactHeaders(req.Header))
	res, err := t.next.RoundTrip(req)
	if err != nil {
		t.log.Debug("http error", "method", req.Method, "url", req.URL.Redacted(), "error", err, "duration", time.Since(start))
		return nil, err
	}
	t.log.Debug("http response", "method", req.Method, "url", req.URL.Redacted(), "status", res.StatusCode,
		"duration", time.Since(start).Round(time.Millisecond), "headers", redactHeaders(res.Header))
	return res, nil
}

func redactHeaders(h http.Header) string {
	var b strings.Builder
	for k, vs := range h {
		for _, v := range vs {
			if redactedHeaders[http.CanonicalHeaderKey(k)] {
				v = "[REDACTED]"
			}
			if b.Len() > 0 {
				b.WriteString("; ")
			}
			b.WriteString(k + ": " + v)
		}
	}
	return b.String()
}
