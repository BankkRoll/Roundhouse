package builder

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/moby/buildkit/session/auth"
	"google.golang.org/grpc"
)

// registryProxy gives one build scoped, authenticated access to the local
// registry.
//
// The registry listens on host loopback, which sys_buildkitd cannot reach
// from its bridge network. The proxy listens on that network's gateway for
// the duration of one build and forwards to the registry, but only:
//   - with a random per-build password that only the build's BuildKit
//     session hands out, so RUN steps sharing the daemon's network cannot
//     use it;
//   - for the build's own image repository and cache repository;
//   - for pull and push methods (no deletes, no catalog, no cross-repository
//     blob mounts).
type registryProxy struct {
	srv      *http.Server
	ln       net.Listener
	user     string
	password string
	repos    map[string]bool
	upstream *url.URL
	log      *slog.Logger
}

// startRegistryProxy listens on listenAddr and forwards to the registry at
// upstream (host:port) for the given repository paths.
func startRegistryProxy(listenAddr, upstream string, repos []string, log *slog.Logger) (*registryProxy, error) {
	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		return nil, err
	}
	secret := make([]byte, 24)
	_, _ = rand.Read(secret)
	p := &registryProxy{
		ln:       ln,
		user:     "openrail-build",
		password: hex.EncodeToString(secret),
		repos:    map[string]bool{},
		upstream: &url.URL{Scheme: "http", Host: upstream},
		log:      log,
	}
	for _, r := range repos {
		p.repos[r] = true
	}
	p.srv = &http.Server{
		Handler:           p,
		ReadHeaderTimeout: 30 * time.Second,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}
	go func() { _ = p.srv.Serve(ln) }()
	return p, nil
}

// Close stops the proxy and drops in-flight requests.
func (p *registryProxy) Close() error { return p.srv.Close() }

// port is the port the proxy listens on.
func (p *registryProxy) port() int { return p.ln.Addr().(*net.TCPAddr).Port }

// registryRoutes are the path segments that follow a repository name in the
// distribution API.
var registryRoutes = []string{"manifests", "blobs", "tags", "referrers"}

// authorize reports whether method on path is allowed, and for which
// repository.
func (p *registryProxy) authorize(method, path string) bool {
	if path == "/v2/" || path == "/v2" {
		return method == http.MethodGet || method == http.MethodHead
	}
	rest, ok := strings.CutPrefix(path, "/v2/")
	if !ok {
		return false
	}
	for repo := range p.repos {
		tail, ok := strings.CutPrefix(rest, repo+"/")
		if !ok {
			continue
		}
		route, _, _ := strings.Cut(tail, "/")
		if !isRegistryRoute(route) {
			continue
		}
		switch method {
		case http.MethodGet, http.MethodHead:
			return true
		case http.MethodPost:
			return strings.HasPrefix(tail, "blobs/uploads/") || tail == "blobs/uploads"
		case http.MethodPut:
			return strings.HasPrefix(tail, "blobs/uploads/") || strings.HasPrefix(tail, "manifests/")
		case http.MethodPatch:
			return strings.HasPrefix(tail, "blobs/uploads/")
		}
		return false
	}
	return false
}

func isRegistryRoute(s string) bool {
	for _, r := range registryRoutes {
		if s == r {
			return true
		}
	}
	return false
}

func (p *registryProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Docker-Distribution-API-Version", "registry/2.0")
	user, pass, ok := r.BasicAuth()
	if !ok || subtle.ConstantTimeCompare([]byte(user), []byte(p.user)) != 1 ||
		subtle.ConstantTimeCompare([]byte(pass), []byte(p.password)) != 1 {
		w.Header().Set("WWW-Authenticate", `Basic realm="openrail-build"`)
		http.Error(w, `{"errors":[{"code":"UNAUTHORIZED","message":"authentication required"}]}`, http.StatusUnauthorized)
		return
	}
	if !p.authorize(r.Method, r.URL.Path) {
		http.Error(w, `{"errors":[{"code":"DENIED","message":"not allowed for this build"}]}`, http.StatusForbidden)
		return
	}
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(p.upstream)
			// The registry builds upload URLs from Host; keeping the
			// client's means they point back at the proxy.
			pr.Out.Host = pr.In.Host
			pr.Out.Header.Del("Authorization")
			q := pr.Out.URL.Query()
			if q.Has("mount") || q.Has("from") {
				q.Del("mount")
				q.Del("from")
				pr.Out.URL.RawQuery = q.Encode()
			}
		},
		ModifyResponse: func(resp *http.Response) error {
			// Relative locations keep the client on the proxy even if the
			// registry is configured with an absolute public URL.
			if loc := resp.Header.Get("Location"); loc != "" {
				if u, err := url.Parse(loc); err == nil && u.IsAbs() {
					rel := &url.URL{Path: u.Path, RawPath: u.RawPath, RawQuery: u.RawQuery}
					resp.Header.Set("Location", rel.String())
				}
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if !errors.Is(err, context.Canceled) {
				p.log.Warn("registry proxy", "error", err)
			}
			w.WriteHeader(http.StatusBadGateway)
		},
		FlushInterval: -1,
	}
	rp.ServeHTTP(w, r)
}

// authHost is how sys_buildkitd addresses the proxy.
func (p *registryProxy) authHost() string {
	return registryProxyHost + ":" + strconv.Itoa(p.port())
}

// sessionAuth hands the proxy's credentials to BuildKit through the build
// session, and nothing for any other registry (anonymous pulls).
type sessionAuth struct {
	auth.UnimplementedAuthServer
	host     string
	user     string
	password string
}

func (a *sessionAuth) Register(server *grpc.Server) { auth.RegisterAuthServer(server, a) }

func (a *sessionAuth) Credentials(_ context.Context, req *auth.CredentialsRequest) (*auth.CredentialsResponse, error) {
	if req.GetHost() != a.host {
		return &auth.CredentialsResponse{}, nil
	}
	return &auth.CredentialsResponse{Username: a.user, Secret: a.password}, nil
}
