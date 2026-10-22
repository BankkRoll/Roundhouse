package ingress

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

// DefaultAskListen is where the ask endpoint listens.
const DefaultAskListen = "127.0.0.1:2020"

// ServeAsk answers Caddy's on-demand TLS permission check,
// GET /ask?domain=<host>: 200 if host is in the latest [Config.AllowedHosts],
// 404 otherwise. Caddy issues a certificate only on 2xx.
func (m *Manager) ServeAsk(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/ask" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	domain := strings.TrimSuffix(strings.ToLower(r.URL.Query().Get("domain")), ".")
	if _, ok := (*m.allowed.Load())[domain]; !ok || domain == "" {
		http.Error(w, "unknown domain", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// ListenAsk listens on addr, which must be a loopback address: the endpoint
// decides who gets certificates and must never be reachable from outside.
func ListenAsk(addr string) (net.Listener, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return nil, fmt.Errorf("ask endpoint must listen on a loopback IP, got %q", addr)
	}
	return net.Listen("tcp", addr)
}

// ServeAskOn serves the ask endpoint on ln until ctx ends. Every timeout is
// tight: Caddy's checks are tiny and anything slow is not Caddy.
func (m *Manager) ServeAskOn(ctx context.Context, ln net.Listener) error {
	srv := &http.Server{
		Handler:           http.HandlerFunc(m.ServeAsk),
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       2 * time.Second,
		WriteTimeout:      2 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    8 << 10,
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
		<-errc
		return nil
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}
