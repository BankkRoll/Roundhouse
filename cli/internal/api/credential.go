package api

import (
	"net/http"
	"strings"
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

// BearerToken is an API token sent as `Authorization: Bearer`.
//
// TODO(api-tokens): the control plane does not accept bearer tokens yet;
// this type exists so tokens can be wired in without touching commands.
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
