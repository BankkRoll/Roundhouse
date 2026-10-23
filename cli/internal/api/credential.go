package api

import (
	"net/http"
	"strings"
	"time"
)

// Credential authenticates requests to the control plane. Commands never see
// which kind is in use, so adding a credential type touches only this file
// and the code that picks one (`cli.App.credential`).
type Credential interface {
	// Apply adds the credential to a request's headers.
	Apply(h http.Header)
}

// SessionCookie is a Better Auth session cookie, as set by sign-in.
type SessionCookie struct {
	// Name is the cookie name, e.g. "__Secure-better-auth.session_token".
	Name string
	// Value is the signed, URL-encoded cookie value, sent back verbatim.
	Value string
}

// Apply adds a Cookie header.
//
// NOTE: the header is written directly rather than through http.Cookie,
// whose sanitiser would quote or drop characters of the signed value.
func (s SessionCookie) Apply(h http.Header) {
	h.Add("Cookie", s.Name+"="+s.Value)
}

// APITokenPrefix starts every API token secret (API_TOKEN_PREFIX in
// packages/shared/src/tokens.ts); the API tells tokens from other bearers by it.
const APITokenPrefix = "tok_"

// IsAPIToken reports whether s looks like an API token secret.
func IsAPIToken(s string) bool {
	return strings.HasPrefix(s, APITokenPrefix)
}

// BearerToken is a workspace API token, sent as `Authorization: Bearer`.
type BearerToken string

// Apply adds an Authorization header.
func (t BearerToken) Apply(h http.Header) {
	h.Set("Authorization", "Bearer "+string(t))
}

// SessionCookieSuffix ends the name of Better Auth's session cookie, after
// an optional `__Secure-` prefix and the configurable cookie prefix.
const SessionCookieSuffix = ".session_token"

// DefaultSessionCookieName is the session cookie name Better Auth uses on a
// control plane at baseURL: `__Secure-` is added over HTTPS only.
func DefaultSessionCookieName(https bool) string {
	if https {
		return "__Secure-better-auth" + SessionCookieSuffix
	}
	return "better-auth" + SessionCookieSuffix
}

// IsSessionCookie reports whether a cookie name is Better Auth's session token.
func IsSessionCookie(name string) bool {
	return strings.HasSuffix(name, SessionCookieSuffix)
}

// SessionCookieCleared reports whether a Set-Cookie of the session cookie
// deletes it instead of refreshing it: an empty value, `Max-Age=0` (which
// net/http reports as a negative MaxAge) or an `Expires` already past. Better
// Auth sends one when it ends a session, e.g. an expired one.
func SessionCookieCleared(ck *http.Cookie, now time.Time) bool {
	return ck.Value == "" || ck.MaxAge < 0 || (ck.MaxAge == 0 && !ck.Expires.IsZero() && !ck.Expires.After(now))
}
