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
//     only when routes, their ports, HSTS, the TLS mode, the managed hosts
//     or the loaded certificates change; batch certificate renewals; retry
//     with backoff while Caddy is down, and re-load it if Caddy restarts
//     and forgets it ([Manager]);
//   - answer Caddy's on-demand TLS permission checks for exactly the
//     hostnames in the desired routes, never wildcards or managed hosts
//     ([Manager.ServeAsk]).
//
// TLS modes (ADR 0009): in acme mode Caddy issues on demand, gated by the
// ask endpoint, and sends its tls logs to the agent ([DefaultTLSLogListen]).
// Managed mode does the same for hosts the control plane has no certificate
// for yet, and for managed hosts loads the control plane's certificates from
// files, keeps Caddy from managing any, and proxies their HTTP-01
// challenges to the control plane. Internal and off are for development and
// send no HSTS.
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
	"net/url"
	"regexp"
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
	// HSTS is sent on HTTPS responses for Host in acme and managed modes;
	// nil sends none. Routes of one host share the strongest setting.
	HSTS *protocol.RouteHSTS
}

// Certificate is a certificate file Caddy loads in managed mode.
type Certificate struct {
	ID string
	// Path holds the PEM chain, leaf first, followed by its private key.
	Path string
	// SHA256 is the hex digest of the chain. It is a tag in the config, so
	// a renewal written over the same path changes the config: Caddy
	// ignores a /load of an unchanged config and would keep the old one.
	SHA256 string
}

// Config is everything the generated Caddy config and the DNS answers
// depend on.
type Config struct {
	TLSMode protocol.TLSMode
	// Routes with neither upstreams nor ports are dropped.
	Routes []Route
	// AllowedHosts are the hostnames the ask endpoint approves: every
	// hostname in the desired routes, healthy or not, so a certificate can
	// be ready before the first replica is. Wildcards and ManagedHosts are
	// never approved.
	AllowedHosts []string
	// ManagedHosts have certificates from the control plane (managed mode
	// only): Caddy never issues for them.
	ManagedHosts []string
	// ChallengeUpstream is where HTTP-01 challenges for ManagedHosts are
	// proxied in managed mode; nil proxies none.
	ChallengeUpstream *protocol.ACMEChallengeUpstream
	// Certificates are loaded from files in managed mode. [Manager.Apply]
	// replaces them with the set given to [Manager.SetCertificates].
	Certificates []Certificate
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
	// TLSLogAddress is where Caddy sends its tls logs in acme and managed
	// modes. Default [DefaultTLSLogListen].
	TLSLogAddress string
}

// Server is the name of the Caddy server the agent manages.
const Server = "roundhouse"

// HTTPServer is the name of the plain-HTTP server that proxies managed
// hosts' ACME challenges in managed mode.
const HTTPServer = "roundhouse_http"

// TLSLog is the name of the Caddy log that carries tls events to the agent.
const TLSLog = "roundhouse_tls"

// DefaultTLSLogListen is where the agent receives Caddy's tls logs.
const DefaultTLSLogListen = "127.0.0.1:2022"

// ChallengePrefix is the ACME HTTP-01 path prefix (RFC 8555 §8.3).
const ChallengePrefix = "/.well-known/acme-challenge/"

// challengeTokenPattern bounds the token to base64url (RFC 8555 §8.3), so
// nothing but a token is ever appended to the upstream path.
const challengeTokenPattern = `^/\.well-known/acme-challenge/[A-Za-z0-9_-]{1,256}$`

// safeUpstreamPath is what a challenge upstream path may contain: Caddy
// would expand "{...}" as a placeholder, and anything exotic is suspect.
var safeUpstreamPath = regexp.MustCompile(`^(/[A-Za-z0-9._~-]+)*/?$`)

// BuildConfig returns Caddy's JSON config for c, deterministically: equal
// inputs give byte-identical output, so its hash detects changes.
//
// In acme, managed and internal modes one server listens on HTTPS and
// Caddy's automatic HTTPS adds the HTTP→HTTPS redirect (and answers the
// ACME HTTP challenges it started) on the HTTP port. In off mode the server
// listens on HTTP only.
//
// Managed mode is acme mode plus: the control plane's certificates loaded
// from files; automatic_https.skip_certificates for c.ManagedHosts, so Caddy
// neither issues nor renews for them while still redirecting them; and a
// second server on the HTTP port that proxies HTTP-01 challenges for every
// exact routed host to the control plane, whose first order for a domain
// comes before the domain is managed. Caddy answers the challenges it
// started itself before any route runs, and appends its redirects to that
// server after the routes with a host matcher, so the challenge route
// matches before the redirect.
func BuildConfig(c Config, opts BuildOptions) []byte {
	httpPort := cmp.Or(opts.HTTPPort, 80)
	httpsPort := cmp.Or(opts.HTTPSPort, 443)
	routes := normalize(c.Routes)
	hsts := c.TLSMode == protocol.TLSACME || c.TLSMode == protocol.TLSManaged

	srv := map[string]any{"routes": caddyRoutes(routes, opts, hsts)}
	servers := map[string]any{Server: srv}
	apps := map[string]any{"http": map[string]any{
		"http_port":  httpPort,
		"https_port": httpsPort,
		"servers":    servers,
	}}
	cfg := map[string]any{
		"admin": map[string]any{"listen": opts.AdminListen},
		"apps":  apps,
	}

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
		tlsApp := map[string]any{"automation": map[string]any{
			"on_demand": map[string]any{"permission": map[string]any{"module": "http", "endpoint": opts.AskURL}},
			"policies":  []any{map[string]any{"on_demand": true}},
		}}
		apps["tls"] = tlsApp
		cfg["logging"] = map[string]any{"logs": map[string]any{TLSLog: map[string]any{
			"writer": map[string]any{
				"output":       "net",
				"address":      cmp.Or(opts.TLSLogAddress, DefaultTLSLogListen),
				"dial_timeout": "2s",
				// NOTE: without soft_start a stopped agent would make every
				// load fail; Caddy logs to stderr until it reconnects.
				"soft_start": true,
			},
			"encoder": map[string]any{"format": "json"},
			"level":   "INFO",
			"include": []string{"tls"},
		}}}
		if c.TLSMode != protocol.TLSManaged {
			break
		}
		if managed := validHosts(c.ManagedHosts); len(managed) > 0 {
			srv["automatic_https"] = map[string]any{"skip_certificates": managed}
		}
		if files := loadFiles(c.Certificates); len(files) > 0 {
			tlsApp["certificates"] = map[string]any{"load_files": files}
		}
		if route := challengeRoute(c, routes); route != nil {
			servers[HTTPServer] = map[string]any{
				"listen": []string{":" + strconv.Itoa(httpPort)},
				"routes": []any{route},
				// NOTE: Caddy disables automatic HTTPS for an HTTP-only
				// server anyway, with a warning on every load. It still
				// answers its own HTTP challenges here and appends the HTTPS
				// server's redirects to this server.
				"automatic_https": map[string]any{"disable": true},
			}
		}
	}

	// NOTE: encoding/json sorts map keys, which is what makes the output
	// deterministic.
	data, err := json.Marshal(cfg)
	if err != nil {
		panic("ingress: marshal caddy config: " + err.Error())
	}
	return data
}

// validHosts returns the valid route hostnames of in, lowercased, sorted and
// deduplicated.
func validHosts(in []string) []string {
	out := make([]string, 0, len(in))
	for _, h := range in {
		if h = strings.ToLower(h); protocol.IsRouteHostname(h) {
			out = append(out, h)
		}
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// loadFiles lists certificates for apps.tls.certificates.load_files, by ID.
// The chain and key share one file, which tls.X509KeyPair reads for each, so
// a renewal replaces both with a single atomic rename.
func loadFiles(certs []Certificate) []any {
	certs = slices.Clone(certs)
	slices.SortFunc(certs, func(a, b Certificate) int { return strings.Compare(a.ID, b.ID) })
	certs = slices.CompactFunc(certs, func(a, b Certificate) bool { return a.ID == b.ID })
	out := make([]any, 0, len(certs))
	for _, c := range certs {
		out = append(out, map[string]any{
			"certificate": c.Path,
			"key":         c.Path,
			"tags":        []string{"roundhouse:" + c.ID, "sha256:" + c.SHA256},
		})
	}
	return out
}

// challengeRoute proxies HTTP-01 challenges for every exact host routed or
// managed to the control plane over TLS, verified against the system roots,
// rewriting /.well-known/acme-challenge/<token> to <upstream path>/<token>.
// It returns nil without such hosts or a usable upstream.
//
// NOTE: Caddy's own challenges are not affected: its server answers a
// request whose host and path match a challenge it has pending before any
// route runs (caddyhttp Server.ServeHTTP → TLS.HandleHTTPChallenge), and
// lets every other token through to this route.
func challengeRoute(c Config, routes []Route) map[string]any {
	up := c.ChallengeUpstream
	if up == nil {
		return nil
	}
	all := slices.Concat(c.ManagedHosts, c.AllowedHosts)
	for _, r := range routes {
		all = append(all, r.Host)
	}
	var hosts []string
	for _, h := range validHosts(all) {
		// HTTP-01 cannot validate a wildcard; those use DNS-01.
		if !isWildcard(h) {
			hosts = append(hosts, h)
		}
	}
	if len(hosts) == 0 {
		return nil
	}
	upstreamHost := strings.ToLower(up.Host)
	u, err := url.Parse(up.URL)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Hostname() == "" || u.RawQuery != "" ||
		u.Fragment != "" || !safeUpstreamPath.MatchString(u.Path) || !protocol.IsHostname(upstreamHost) {
		return nil
	}
	return map[string]any{
		"match": []any{map[string]any{
			"host":        hosts,
			"path":        []string{ChallengePrefix + "*"},
			"path_regexp": map[string]any{"pattern": challengeTokenPattern},
		}},
		"handle": []any{
			map[string]any{
				"handler": "rewrite",
				"uri":     strings.TrimSuffix(u.Path, "/") + "/{http.request.uri.path.file}",
			},
			map[string]any{
				"handler":   "reverse_proxy",
				"upstreams": []any{map[string]any{"dial": net.JoinHostPort(u.Hostname(), cmp.Or(u.Port(), "443"))}},
				"transport": map[string]any{
					"protocol": "http",
					"tls":      map[string]any{"server_name": u.Hostname()},
				},
				"headers": map[string]any{"request": map[string]any{
					"set": map[string]any{"Host": []string{upstreamHost}},
				}},
			},
		},
		"terminal": true,
	}
}

// HSTSValue renders a Strict-Transport-Security header value (RFC 6797
// §6.1).
func HSTSValue(h protocol.RouteHSTS) string {
	v := "max-age=" + strconv.Itoa(max(h.MaxAge, 0))
	if h.IncludeSubdomains {
		v += "; includeSubDomains"
	}
	if h.Preload {
		v += "; preload"
	}
	return v
}

// strongerHSTS returns the stronger of two settings, deterministically:
// longer max-age, then includeSubDomains, then preload.
func strongerHSTS(a, b *protocol.RouteHSTS) *protocol.RouteHSTS {
	if a == nil {
		return b
	}
	if b == nil {
		return a
	}
	ra := []int{a.MaxAge, boolInt(a.IncludeSubdomains), boolInt(a.Preload)}
	rb := []int{b.MaxAge, boolInt(b.IncludeSubdomains), boolInt(b.Preload)}
	if slices.Compare(ra, rb) >= 0 {
		return a
	}
	return b
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func isWildcard(host string) bool { return strings.HasPrefix(host, "*.") }

// coveredByWildcard reports whether wildcard ("*.example.com") matches host
// the way Caddy's host matcher does: exactly one label in place of "*".
func coveredByWildcard(host, wildcard string) bool {
	if isWildcard(host) || !isWildcard(wildcard) {
		return false
	}
	_, parent, ok := strings.Cut(host, ".")
	return ok && parent == wildcard[2:]
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
// their upstreams to Ports, drops routes without ports, gives every route of
// a host the host's strongest HSTS, and orders them for Caddy, which tries
// routes in order: exact hosts before wildcard hosts, so a wildcard never
// shadows an exact host, and within a host longer prefixes first.
func normalize(in []Route) []Route {
	byKey := map[string]*Route{}
	hsts := map[string]*protocol.RouteHSTS{}
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
		hsts[host] = strongerHSTS(hsts[host], r.HSTS)
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
		if h := hsts[r.Host]; h != nil {
			r.HSTS = &protocol.RouteHSTS{MaxAge: h.MaxAge, IncludeSubdomains: h.IncludeSubdomains, Preload: h.Preload}
		}
		if len(r.Ports) > 0 {
			out = append(out, *r)
		}
	}
	slices.SortFunc(out, func(a, b Route) int {
		if c := cmp.Compare(boolInt(isWildcard(a.Host)), boolInt(isWildcard(b.Host))); c != 0 {
			return c
		}
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
// A records of [UpstreamName], one source per port, behind an HSTS header
// when hsts is set and the route has one.
//
// There are deliberately no static upstreams: Caddy falls back to them when
// the DNS lookup fails, and they would be stale after the first swap. With
// none, a failed lookup leaves no upstream, which Caddy retries for any
// method (nothing was sent) every try_interval until try_duration, so a
// request arriving while the agent restarts waits for the DNS server
// instead of going to a container that may be gone.
//
// An exact host that a wildcard route also matches gets a final 404 for the
// paths its own routes leave out: requests for a host routed on its own
// never fall through to the wildcard's service.
func caddyRoutes(routes []Route, opts BuildOptions, hsts bool) []any {
	resolver := cmp.Or(opts.Resolver, DefaultDNSListen)
	refresh := cmp.Or(opts.Refresh, DefaultUpstreamRefresh)
	var wildcards []string
	for _, r := range routes {
		if isWildcard(r.Host) {
			wildcards = append(wildcards, r.Host)
		}
	}
	shadowed := func(host string) bool {
		return slices.ContainsFunc(wildcards, func(w string) bool { return coveredByWildcard(host, w) })
	}
	notFound := map[string]any{"handler": "static_response", "status_code": 404, "body": "no route\n"}

	out := make([]any, 0, len(routes)+1)
	for i, r := range routes {
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
		var handle []any
		if hsts && r.HSTS != nil {
			handle = append(handle, map[string]any{
				"handler": "headers",
				"response": map[string]any{
					"set": map[string]any{"Strict-Transport-Security": []string{HSTSValue(*r.HSTS)}},
					// NOTE: deferred applies the header when the response is
					// written, replacing any the upstream sent instead of
					// adding a second one.
					"deferred": true,
				},
			})
		}
		handle = append(handle, map[string]any{
			"handler":           "reverse_proxy",
			"dynamic_upstreams": dynamic,
			"load_balancing": map[string]any{
				"try_duration": tryDuration,
				"try_interval": "100ms",
			},
		})
		out = append(out, map[string]any{"match": []any{match}, "handle": handle, "terminal": true})

		lastOfHost := i == len(routes)-1 || routes[i+1].Host != r.Host
		if lastOfHost && r.PathPrefix != "" && shadowed(r.Host) {
			out = append(out, map[string]any{
				"match":    []any{map[string]any{"host": []string{r.Host}}},
				"handle":   []any{notFound},
				"terminal": true,
			})
		}
	}
	out = append(out, map[string]any{"handle": []any{notFound}})
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
