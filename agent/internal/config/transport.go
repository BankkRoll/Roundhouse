package config

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// ParseControlPlaneURL validates an http(s) control-plane origin.
//
// SECURITY: plaintext http:// would expose the join token and the returned
// credential, so it is accepted only for loopback hosts or when insecure is
// set explicitly.
func ParseControlPlaneURL(raw string, insecure bool) (*url.URL, error) {
	u, err := url.Parse(strings.TrimRight(raw, "/"))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("control plane URL must be an http(s) origin, got %q", raw)
	}
	if u.Scheme == "http" && !insecure && !IsLoopback(u.Hostname()) {
		return nil, fmt.Errorf("refusing plaintext control plane URL %q: use https:// (or --insecure for testing)", raw)
	}
	return u, nil
}

// CheckConnectURL validates that connect is a ws(s) URL on the same host and
// port as the control plane origin cp.
//
// SECURITY: binding connect_url to the origin the operator typed stops a
// compromised or misconfigured join endpoint from redirecting the node's
// bearer credential to another host. Plaintext ws:// follows the same
// loopback/insecure exception as [ParseControlPlaneURL].
func CheckConnectURL(connect string, cp *url.URL, insecure bool) error {
	u, err := url.Parse(connect)
	if err != nil || (u.Scheme != "ws" && u.Scheme != "wss") || u.Host == "" {
		return fmt.Errorf("connect_url must be a ws:// or wss:// URL, got %q", connect)
	}
	if u.Scheme == "ws" && !insecure && !IsLoopback(u.Hostname()) {
		return fmt.Errorf("refusing plaintext connect_url %q: control plane must use wss://", connect)
	}
	if got, want := hostPort(u), hostPort(cp); got != want {
		return fmt.Errorf("connect_url %q points at %s, but the control plane is %s", connect, got, want)
	}
	return nil
}

// IsLoopback reports whether host names the local machine.
func IsLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func hostPort(u *url.URL) string {
	port := u.Port()
	if port == "" {
		switch u.Scheme {
		case "https", "wss":
			port = "443"
		default:
			port = "80"
		}
	}
	return net.JoinHostPort(strings.ToLower(u.Hostname()), port)
}
