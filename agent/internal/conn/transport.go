package conn

import (
	"net/url"
	"strings"
)

// DevEnv is the environment variable that, set to "1", lets an agent
// connected over plaintext ws:// apply workloads and builds, for local
// development against a control plane without TLS.
const DevEnv = "ROUNDHOUSE_DEV"

// PlaintextRefusal returns why workloads and builds received over
// connectURL must not be applied, or "" when they may: a ws:// session
// outside development mode (ADR 0014, "Protocol gate").
//
// SECURITY: frames are signed, so ws:// can't forge them, but a git token,
// registry password or object-storage key in one would cross the network in
// the clear. `--insecure` therefore only lets the node connect and report;
// running anything needs wss:// or an explicit ROUNDHOUSE_DEV=1.
func PlaintextRefusal(connectURL string, dev bool) string {
	u, err := url.Parse(connectURL)
	if err != nil || dev || !strings.EqualFold(u.Scheme, "ws") {
		return ""
	}
	return "refusing workloads and builds received over plaintext ws://; connect over wss://, " +
		"or set " + DevEnv + "=1 for local development"
}
