// Package ingress configures Caddy, the node's HTTP(S) entry point, through
// its admin API, serves the DNS zone Caddy resolves upstreams from, and
// serves the on-demand TLS "ask" endpoint.
//
// Responsibilities:
//   - generate Caddy's JSON config from the set of routes and the install's
//     TLS mode ([BuildConfig]). Upstream addresses are not in it: every route
//     resolves them per request (cached for [DefaultUpstreamRefresh]) from a
//     DNS name in [UpstreamZone], so moving a route to new containers never
//     reloads Caddy;
//   - answer those names from the latest upstreams ([BuildTable],
//     [Manager.ServeDNSOn]) and persist the answers, so a restarted agent
//     serves them before its first desired state arrives;
//   - load the config with POST /load only when it changed, which happens
//     only when routes, their ports or the TLS mode change; retry with
//     backoff while Caddy is down, and re-load it if Caddy restarts and
//     forgets it ([Manager]);
//   - answer Caddy's on-demand TLS permission checks for exactly the
//     hostnames in the desired routes ([Manager.ServeAsk]).
//
// Upstreams are resolved rather than loaded because every POST /load
// replaces Caddy's HTTP servers, and shutting the old server down resets a
// connection whose first request it reads after the shutdown began: about
// one request in 5,000 under a request loop. See ADR 0003, "Ingress swaps
// without reloads".
package ingress

import (
	"cmp"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/netip"
	"slices"
	"strconv"
	"strings"
	"time"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// DefaultUpstreamRefresh is how long Caddy caches a route's upstream
// addresses before it asks the DNS server again.
const DefaultUpstreamRefresh = time.Second

// SwitchDelay bounds how long Caddy may keep sending new requests to an
// upstream after the DNS answer stopped naming it: one refresh interval plus
// a margin. A replaced container must keep serving at least this long.
const SwitchDelay = DefaultUpstreamRefresh + time.Second

// tryDuration is how long Caddy keeps retrying a request it could not send:
// an upstream that refuses connections, or no upstream address while the
// DNS server is briefly down during an agent restart. Long enough to ride
// out both, short enough to answer for a dead service promptly.
const tryDuration = "5s"

// Route sends requests for Host, and paths under PathPrefix, to Upstreams.
type Route struct {
	Host string
	// PathPrefix is "" or "/" for the whole host.
	PathPrefix string
	// Upstreams are the "ip:port" dial addresses serving the route now.
	Upstreams []string
	// Ports are the container ports the route is served on even while no
	// upstream serves it: the desired replicas' ports. A route stays in
	// Caddy's config while it has a port, so a restarting replica does not
	// cost a reload when it goes and another when it comes back.
	Ports []int
}

// Config is everything the generated Caddy config and the DNS answers
// depend on.
type Config struct {
	TLSMode protocol.TLSMode
	// Routes with neither upstreams nor ports are dropped.
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
	// Resolver is where Caddy sends upstream DNS queries: the agent's
	// [Manager.ServeDNSOn] listener. Default [DefaultDNSListen].
	Resolver string
	// Refresh is how long Caddy caches upstream addresses. Default
	// [DefaultUpstreamRefresh].
	Refresh time.Duration
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

	srv := map[string]any{"routes": caddyRoutes(routes, opts)}
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

// BuildTable returns the DNS answers for c's routes: for every route and
// port, the IPv4 addresses of the upstreams serving it on that port. A route
// and port with no upstream has no entry, so its name does not resolve.
func BuildTable(c Config) map[string][]netip.Addr {
	table := map[string][]netip.Addr{}
	for _, r := range normalize(c.Routes) {
		for _, u := range r.Upstreams {
			ap, err := netip.ParseAddrPort(u)
			if err != nil || !ap.Addr().Is4() {
				continue
			}
			name := UpstreamName(r.Host, r.PathPrefix, int(ap.Port()))
			table[name] = append(table[name], ap.Addr())
		}
	}
	for name, addrs := range table {
		slices.SortFunc(addrs, func(a, b netip.Addr) int { return a.Compare(b) })
		table[name] = slices.Compact(addrs)
	}
	return table
}

// UpstreamName is the DNS name Caddy resolves for the upstreams of one route
// (normalised host and path prefix) on one port. It is hashed so any
// hostname and prefix fit one DNS label, and it ends with a dot so no search
// domain is ever appended to it.
func UpstreamName(host, prefix string, port int) string {
	sum := sha256.Sum256([]byte(host + " " + prefix + " " + strconv.Itoa(port)))
	return hex.EncodeToString(sum[:16]) + "." + UpstreamZone
}

// normalize merges routes with the same host and prefix, adds the ports of
// their upstreams to Ports, drops routes without ports, and orders them so
// that longer prefixes of a host match first.
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
		m.Ports = append(m.Ports, r.Ports...)
	}
	out := make([]Route, 0, len(byKey))
	for _, r := range byKey {
		slices.Sort(r.Upstreams)
		r.Upstreams = slices.Compact(r.Upstreams)
		for _, u := range r.Upstreams {
			if _, port, err := net.SplitHostPort(u); err == nil {
				if p, err := strconv.Atoi(port); err == nil {
					r.Ports = append(r.Ports, p)
				}
			}
		}
		slices.Sort(r.Ports)
		r.Ports = slices.Compact(r.Ports)
		if len(r.Ports) > 0 {
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

// caddyRoutes renders each route as a reverse proxy whose upstreams are the
// A records of [UpstreamName], one source per port.
//
// There are deliberately no static upstreams: Caddy falls back to them when
// the DNS lookup fails, and they would be stale after the first swap. With
// none, a failed lookup leaves no upstream, which Caddy retries for any
// method (nothing was sent) every try_interval until try_duration, so a
// request arriving while the agent restarts waits for the DNS server
// instead of going to a container that may be gone.
func caddyRoutes(routes []Route, opts BuildOptions) []any {
	resolver := cmp.Or(opts.Resolver, DefaultDNSListen)
	refresh := cmp.Or(opts.Refresh, DefaultUpstreamRefresh)
	out := make([]any, 0, len(routes)+1)
	for _, r := range routes {
		match := map[string]any{"host": []string{r.Host}}
		if r.PathPrefix != "" {
			match["path"] = []string{r.PathPrefix, r.PathPrefix + "/*"}
		}
		sources := make([]any, len(r.Ports))
		for i, port := range r.Ports {
			sources[i] = map[string]any{
				"source":       "a",
				"name":         UpstreamName(r.Host, r.PathPrefix, port),
				"port":         strconv.Itoa(port),
				"refresh":      refresh.String(),
				"resolver":     map[string]any{"addresses": []string{resolver}},
				"dial_timeout": "1s",
				"versions":     map[string]any{"ipv4": true},
			}
		}
		dynamic := sources[0]
		if len(sources) > 1 {
			dynamic = map[string]any{"source": "multi", "sources": sources}
		}
		out = append(out, map[string]any{
			"match": []any{match},
			"handle": []any{map[string]any{
				"handler":           "reverse_proxy",
				"dynamic_upstreams": dynamic,
				"load_balancing": map[string]any{
					"try_duration": tryDuration,
					"try_interval": "100ms",
				},
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
