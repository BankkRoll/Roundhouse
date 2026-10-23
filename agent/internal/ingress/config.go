// Package ingress configures Caddy, the node's HTTP(S) entry point, through
// its admin API, and serves the on-demand TLS "ask" endpoint.
//
// Responsibilities:
//   - generate Caddy's complete JSON config from the routes of healthy
//     workloads and the install's TLS mode ([BuildConfig]);
//   - load it with POST /load only when it changed, retry with backoff while
//     Caddy is down, and re-load it if Caddy restarts and forgets it
//     ([Manager]);
//   - answer Caddy's on-demand TLS permission checks for exactly the
//     hostnames in the desired routes ([Manager.ServeAsk]).
package ingress

import (
	"cmp"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
	"strconv"
	"strings"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// Route sends requests for Host, and paths under PathPrefix, to Upstreams.
type Route struct {
	Host string
	// PathPrefix is "" or "/" for the whole host.
	PathPrefix string
	// Upstreams are "ip:port" dial addresses.
	Upstreams []string
}

// Config is everything the generated Caddy config depends on.
type Config struct {
	TLSMode protocol.TLSMode
	// Routes with no upstreams are dropped.
	Routes []Route
	// AllowedHosts are the hostnames the ask endpoint approves: every
	// hostname in the desired routes, healthy or not, so a certificate can
	// be ready before the first replica is.
	AllowedHosts []string
}

// BuildOptions are the install-wide parts of the generated config.
type BuildOptions struct {
	// AdminListen is Caddy's admin listener, kept in every loaded config
	// because POST /load replaces the admin section too.
	AdminListen string
	// AskURL is the endpoint Caddy asks before issuing an on-demand
	// certificate.
	AskURL string
	// HTTPPort and HTTPSPort default to 80 and 443.
	HTTPPort, HTTPSPort int
}

// Server is the name of the Caddy server the agent manages.
const Server = "roundhouse"

// BuildConfig returns Caddy's JSON config for c, deterministically: equal
// inputs give byte-identical output, so its hash detects changes.
//
// In acme and internal modes one server listens on HTTPS and Caddy's
// automatic HTTPS adds the HTTP→HTTPS redirect (and ACME HTTP challenges)
// on the HTTP port. In off mode the server listens on HTTP only.
func BuildConfig(c Config, opts BuildOptions) []byte {
	httpPort := cmp.Or(opts.HTTPPort, 80)
	httpsPort := cmp.Or(opts.HTTPSPort, 443)
	routes := normalize(c.Routes)

	srv := map[string]any{"routes": caddyRoutes(routes)}
	apps := map[string]any{}
	httpApp := map[string]any{
		"http_port":  httpPort,
		"https_port": httpsPort,
		"servers":    map[string]any{Server: srv},
	}
	apps["http"] = httpApp

	switch c.TLSMode {
	case protocol.TLSOff:
		srv["listen"] = []string{":" + strconv.Itoa(httpPort)}
		srv["automatic_https"] = map[string]any{"disable": true}
	case protocol.TLSInternal:
		srv["listen"] = []string{":" + strconv.Itoa(httpsPort)}
		if hosts := hostsOf(routes); len(hosts) > 0 {
			apps["tls"] = map[string]any{"automation": map[string]any{"policies": []any{
				map[string]any{"subjects": hosts, "issuers": []any{map[string]any{"module": "internal"}}},
			}}}
		}
	default:
		srv["listen"] = []string{":" + strconv.Itoa(httpsPort)}
		apps["tls"] = map[string]any{"automation": map[string]any{
			"on_demand": map[string]any{"permission": map[string]any{"module": "http", "endpoint": opts.AskURL}},
			"policies":  []any{map[string]any{"on_demand": true}},
		}}
	}

	cfg := map[string]any{
		"admin": map[string]any{"listen": opts.AdminListen},
		"apps":  apps,
	}
	// NOTE: encoding/json sorts map keys, which is what makes the output
	// deterministic.
	data, err := json.Marshal(cfg)
	if err != nil {
		panic("ingress: marshal caddy config: " + err.Error())
	}
	return data
}

// Hash returns the hex SHA-256 of a generated config.
func Hash(config []byte) string {
	sum := sha256.Sum256(config)
	return hex.EncodeToString(sum[:])
}

// normalize merges routes with the same host and prefix, drops routes without
// upstreams, and orders them so that longer prefixes of a host match first.
func normalize(in []Route) []Route {
	byKey := map[string]*Route{}
	for _, r := range in {
		// "/v1" and "/v1/" match the same requests, and "/" matches everything.
		prefix := strings.TrimSuffix(r.PathPrefix, "/")
		host := strings.ToLower(r.Host)
		key := host + " " + prefix
		m, ok := byKey[key]
		if !ok {
			m = &Route{Host: host, PathPrefix: prefix}
			byKey[key] = m
		}
		m.Upstreams = append(m.Upstreams, r.Upstreams...)
	}
	out := make([]Route, 0, len(byKey))
	for _, r := range byKey {
		slices.Sort(r.Upstreams)
		r.Upstreams = slices.Compact(r.Upstreams)
		if len(r.Upstreams) > 0 {
			out = append(out, *r)
		}
	}
	slices.SortFunc(out, func(a, b Route) int {
		if c := strings.Compare(a.Host, b.Host); c != 0 {
			return c
		}
		if c := cmp.Compare(len(b.PathPrefix), len(a.PathPrefix)); c != 0 {
			return c
		}
		return strings.Compare(a.PathPrefix, b.PathPrefix)
	})
	return out
}

func caddyRoutes(routes []Route) []any {
	out := make([]any, 0, len(routes)+1)
	for _, r := range routes {
		match := map[string]any{"host": []string{r.Host}}
		if r.PathPrefix != "" {
			match["path"] = []string{r.PathPrefix, r.PathPrefix + "/*"}
		}
		upstreams := make([]any, len(r.Upstreams))
		for i, u := range r.Upstreams {
			upstreams[i] = map[string]any{"dial": u}
		}
		out = append(out, map[string]any{
			"match": []any{match},
			"handle": []any{map[string]any{
				"handler":   "reverse_proxy",
				"upstreams": upstreams,
				// Retrying for a moment hides an upstream that is
				// restarting or just removed by a config switch.
				"load_balancing": map[string]any{"try_duration": "2s"},
			}},
			"terminal": true,
		})
	}
	out = append(out, map[string]any{
		"handle": []any{map[string]any{"handler": "static_response", "status_code": 404, "body": "no route\n"}},
	})
	return out
}

func hostsOf(routes []Route) []string {
	var hosts []string
	for _, r := range routes {
		hosts = append(hosts, r.Host)
	}
	slices.Sort(hosts)
	return slices.Compact(hosts)
}
