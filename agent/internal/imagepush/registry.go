package imagepush

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"unicode"
)

// maxErrorBody is how much of a registry's error response is read.
const maxErrorBody = 4096

// maxTokenBody bounds a token endpoint's response.
const maxTokenBody = 1 << 20

// registry speaks the OCI distribution API to one host.
type registry struct {
	scheme string
	host   string
	client *http.Client
	// auth authorizes requests to host; nil sends them anonymously.
	auth *authorizer
}

func (r *registry) url(path string) string { return r.scheme + "://" + r.host + path }

// do sends the request build makes. On a 401 it answers the registry's
// challenge and sends a newly built request once more, so build must
// reopen any body it streams.
func (r *registry) do(ctx context.Context, build func() (*http.Request, error)) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		req, err := build()
		if err != nil {
			return nil, err
		}
		var gen int
		if r.auth != nil {
			gen = r.auth.authorize(req)
		}
		resp, err := r.client.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusUnauthorized || r.auth == nil || attempt > 0 {
			return resp, nil
		}
		challenges := resp.Header.Values("WWW-Authenticate")
		drain(resp)
		if err := r.auth.refresh(ctx, challenges, gen); err != nil {
			return nil, err
		}
	}
}

// newClient returns an HTTP client with the redirect policy every registry
// request follows.
func newClient(rt http.RoundTripper) *http.Client {
	return &http.Client{Transport: rt, CheckRedirect: checkRedirect}
}

// targetTransport is the default transport to the target registry.
func targetTransport() http.RoundTripper {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	return t
}

// sourceTransport is the default transport to the local registry.
func sourceTransport() http.RoundTripper {
	t := http.DefaultTransport.(*http.Transport).Clone()
	// NOTE: the local registry listens on loopback; a proxy from the
	// environment could not reach it.
	t.Proxy = nil
	return t
}

// checkRedirect refuses a redirect that leaves https and drops the
// Authorization header when a redirect leaves the original host.
func checkRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return errors.New("stopped after 10 redirects")
	}
	first := via[0]
	if first.URL.Scheme == "https" && req.URL.Scheme != "https" {
		return fmt.Errorf("refusing a redirect from https to %s://%s", req.URL.Scheme, req.URL.Host)
	}
	if req.URL.Host != first.URL.Host {
		// SECURITY: blob requests commonly redirect to object storage, which
		// must never see the registry login or token.
		req.Header.Del("Authorization")
	}
	return nil
}

// authorizer holds one push's registry login and the token it earned.
type authorizer struct {
	host string
	// scope is the token scope a push needs: pull and push on its repository.
	scope string
	user  string
	pass  string
	// plainRealm reports whether a token realm may be plain http (tests).
	plainRealm func(host string) bool
	client     *http.Client

	// refreshMu serializes refreshes, so concurrent requests rejected
	// together fetch one token.
	refreshMu sync.Mutex

	mu     sync.Mutex
	scheme string
	token  string
	// gen counts refreshes; a request rejected under an older generation
	// is retried without refreshing again.
	gen int
	// tokens records every token received, so errors can be redacted.
	tokens []string
}

// authorize sets req's Authorization when it goes to the registry's host,
// and returns the generation it used.
func (a *authorizer) authorize(req *http.Request) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	if req.URL.Host != a.host {
		return a.gen
	}
	switch a.scheme {
	case "basic":
		req.SetBasicAuth(a.user, a.pass)
	case "bearer":
		req.Header.Set("Authorization", "Bearer "+a.token)
	}
	return a.gen
}

// refresh answers a 401's challenges: Basic sends the login from now on,
// Bearer exchanges it for a token at the challenge's realm. gen is the
// generation the rejected request was sent under; when a concurrent
// request has refreshed since, it is simply retried.
func (a *authorizer) refresh(ctx context.Context, headers []string, gen int) error {
	a.refreshMu.Lock()
	defer a.refreshMu.Unlock()
	a.mu.Lock()
	stale, scheme := a.gen != gen, a.scheme
	a.mu.Unlock()
	if stale {
		return nil
	}
	var basic bool
	var bearer map[string]string
	for _, h := range headers {
		for _, c := range parseChallenges(h) {
			switch c.scheme {
			case "basic":
				basic = true
			case "bearer":
				if bearer == nil {
					bearer = c.params
				}
			}
		}
	}
	switch {
	case bearer != nil:
		return a.fetchToken(ctx, bearer)
	case basic:
		if scheme == "basic" {
			return errors.New("the registry rejected the credential (HTTP 401)")
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		a.scheme = "basic"
		a.gen++
		return nil
	default:
		return errors.New("the registry answered HTTP 401 without a Basic or Bearer challenge")
	}
}

// fetchToken runs the token flow: GET realm?service=…&scope=… with the
// login as Basic credentials.
func (a *authorizer) fetchToken(ctx context.Context, params map[string]string) error {
	realm, err := url.Parse(params["realm"])
	if err != nil || realm.Host == "" {
		return errors.New("the registry's Bearer challenge has no valid realm")
	}
	// SECURITY: the realm receives the login, so it gets the same
	// transport rules as the registry itself.
	if realm.Scheme != "https" && !(realm.Scheme == "http" && a.plainRealm(realm.Host)) {
		return fmt.Errorf("refusing to send the credential to a token realm that is not https (%s://%s)", realm.Scheme, realm.Host)
	}
	q := realm.Query()
	if s := params["service"]; s != "" {
		q.Set("service", s)
	}
	q.Add("scope", a.scope)
	if s := params["scope"]; s != "" && s != a.scope {
		q.Add("scope", s)
	}
	realm.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, realm.String(), nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth(a.user, a.pass)
	resp, err := a.client.Do(req)
	if err != nil {
		return fmt.Errorf("token endpoint %s: %w", realm.Host, err)
	}
	defer drain(resp)
	if resp.StatusCode != http.StatusOK {
		return statusError("token endpoint "+realm.Host, resp)
	}
	var body struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxTokenBody)).Decode(&body); err != nil {
		return fmt.Errorf("token endpoint %s: invalid response", realm.Host)
	}
	token := body.Token
	if token == "" {
		token = body.AccessToken
	}
	if token == "" {
		return fmt.Errorf("token endpoint %s: no token in the response", realm.Host)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.scheme = "bearer"
	a.token = token
	a.gen++
	a.tokens = append(a.tokens, token)
	return nil
}

// secrets lists every string that must never leave the push: the
// password, the Basic header value and the tokens.
func (a *authorizer) secrets() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := []string{a.pass, base64.StdEncoding.EncodeToString([]byte(a.user + ":" + a.pass))}
	return append(s, a.tokens...)
}

// challenge is one parsed WWW-Authenticate challenge.
type challenge struct {
	scheme string
	params map[string]string
}

// parseChallenges parses a WWW-Authenticate header value, e.g.
// `Bearer realm="https://auth/token",service="r",scope="repository:a:pull"`.
// Several challenges in one value are separated by a scheme token.
func parseChallenges(h string) []challenge {
	var out []challenge
	s := h
	for {
		s = strings.TrimLeft(s, " ,\t")
		if s == "" {
			return out
		}
		end := strings.IndexFunc(s, func(r rune) bool { return r == ' ' || r == '\t' || r == ',' })
		if end < 0 {
			end = len(s)
		}
		c := challenge{scheme: strings.ToLower(s[:end]), params: map[string]string{}}
		s = s[end:]
		for {
			rest := strings.TrimLeft(s, " ,\t")
			eq := strings.IndexByte(rest, '=')
			if eq <= 0 || strings.ContainsAny(rest[:eq], " \t,") {
				s = rest
				break
			}
			key := strings.ToLower(strings.TrimSpace(rest[:eq]))
			rest = rest[eq+1:]
			var val string
			if strings.HasPrefix(rest, `"`) {
				var b strings.Builder
				i := 1
				for ; i < len(rest); i++ {
					if rest[i] == '\\' && i+1 < len(rest) {
						i++
						b.WriteByte(rest[i])
						continue
					}
					if rest[i] == '"' {
						break
					}
					b.WriteByte(rest[i])
				}
				val = b.String()
				rest = rest[min(i+1, len(rest)):]
			} else {
				j := strings.IndexAny(rest, ", \t")
				if j < 0 {
					j = len(rest)
				}
				val, rest = rest[:j], rest[j:]
			}
			c.params[key] = val
			s = rest
		}
		out = append(out, c)
	}
}

// statusError describes an unexpected registry response with its status
// and the registry's error codes and messages.
func statusError(what string, resp *http.Response) error {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
	var body struct {
		Errors []struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"errors"`
	}
	var detail string
	if json.Unmarshal(raw, &body) == nil && len(body.Errors) > 0 {
		parts := make([]string, 0, len(body.Errors))
		for _, e := range body.Errors {
			parts = append(parts, strings.TrimSpace(e.Code+": "+e.Message))
		}
		detail = strings.Join(parts, "; ")
	} else {
		detail = strings.Map(func(r rune) rune {
			if unicode.IsPrint(r) {
				return r
			}
			return ' '
		}, strings.TrimSpace(string(raw)))
		if len(detail) > 512 {
			detail = detail[:512] + "…"
		}
	}
	if detail == "" {
		return fmt.Errorf("%s: HTTP %d", what, resp.StatusCode)
	}
	return fmt.Errorf("%s: HTTP %d: %s", what, resp.StatusCode, detail)
}

// drain discards the rest of a response body so the connection can be
// reused, then closes it.
func drain(resp *http.Response) {
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
}
