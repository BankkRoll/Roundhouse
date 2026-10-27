//go:build integration

package ingress_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/dockertest"
	"github.com/BankkRoll/Roundhouse/agent/internal/ingress"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// hostScratch is mounted at the same path in the test container and on the
// Docker host (agent/test/integration.sh), so Caddy can bind files the test
// writes.
const hostScratch = "/var/lib/roundhouse-it"

// selfSigned returns a certificate file (chain, then key) for names and the
// SHA-256 of its chain.
func selfSigned(t *testing.T, names ...string) (file []byte, sha string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: names[0]},
		DNSNames:     names,
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	chain := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	kder, _ := x509.MarshalPKCS8PrivateKey(key)
	sum := sha256.Sum256(chain)
	return append(chain, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kder})...), hex.EncodeToString(sum[:])
}

// fetch requests url with host as Host and SNI and returns the response
// (body closed) and the leaf served over TLS, if any.
func fetch(t *testing.T, url, host string) (*http.Response, *x509.Certificate) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	req.Host = host
	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			DisableKeepAlives: true,
			TLSClientConfig:   &tls.Config{InsecureSkipVerify: true, ServerName: host},
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil
	}
	resp.Body.Close()
	var leaf *x509.Certificate
	if resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
		leaf = resp.TLS.PeerCertificates[0]
	}
	return resp, leaf
}

// TestManagedModeServesLoadedCertificates: in managed mode Caddy serves the
// control plane's certificates from files (an exact host and a wildcard),
// with HSTS on HTTPS only, and still redirects plain HTTP.
func TestManagedModeServesLoadedCertificates(t *testing.T) {
	dir := filepath.Join(hostScratch, dockertest.Unique("certs-"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	shopFile, shopSHA := selfSigned(t, "shop.roundhouse.test")
	wildFile, wildSHA := selfSigned(t, "*.apps.roundhouse.test")
	for name, data := range map[string][]byte{"cer_shop.pem": shopFile, "cer_wild.pem": wildFile} {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	e := setupBinds(t, 0, []string{dir + ":/certs:ro"})
	ctx := context.Background()
	if err := e.mgr.SetCertificates(ctx, []ingress.Certificate{
		{ID: "cer_shop", Path: "/certs/cer_shop.pem", SHA256: shopSHA},
		{ID: "cer_wild", Path: "/certs/cer_wild.pem", SHA256: wildSHA},
	}); err != nil {
		t.Fatal(err)
	}
	hsts := &protocol.RouteHSTS{MaxAge: 31536000, IncludeSubdomains: true}
	err := e.mgr.Apply(ctx, ingress.Config{
		TLSMode: protocol.TLSManaged,
		Routes: []ingress.Route{
			{Host: "shop.roundhouse.test", Upstreams: []string{e.whoami}, HSTS: hsts},
			{Host: "*.apps.roundhouse.test", Upstreams: []string{e.whoami}, HSTS: hsts},
		},
		AllowedHosts: []string{"shop.roundhouse.test", "*.apps.roundhouse.test"},
		ManagedHosts: []string{"shop.roundhouse.test", "*.apps.roundhouse.test"},
	})
	if err != nil {
		t.Fatal(err)
	}

	for host, san := range map[string]string{"shop.roundhouse.test": "shop.roundhouse.test", "x.apps.roundhouse.test": "*.apps.roundhouse.test"} {
		var resp *http.Response
		var leaf *x509.Certificate
		dockertest.Eventually(t, 30*time.Second, "HTTPS for "+host, func() bool {
			resp, leaf = fetch(t, "https://"+e.caddy+"/", host)
			return resp != nil && resp.StatusCode == 200
		})
		if leaf == nil || !slices.Contains(leaf.DNSNames, san) {
			t.Fatalf("%s: served %v, want the loaded %s certificate", host, leaf, san)
		}
		if got := resp.Header.Get("Strict-Transport-Security"); got != "max-age=31536000; includeSubDomains" {
			t.Fatalf("%s: HSTS = %q", host, got)
		}
		plain, _ := fetch(t, "http://"+e.caddy+"/", host)
		if plain == nil || plain.StatusCode != http.StatusPermanentRedirect {
			t.Fatalf("%s: plain HTTP = %v, want a redirect", host, plain)
		}
		if got := plain.Header.Get("Strict-Transport-Security"); got != "" {
			t.Fatalf("%s: HSTS on plain HTTP: %q", host, got)
		}
	}
	// A host with no loaded certificate and no on-demand permission fails
	// TLS instead of being served another host's certificate.
	if resp, leaf := fetch(t, "https://"+e.caddy+"/", "a.b.apps.roundhouse.test"); resp != nil && leaf != nil &&
		!slices.Contains(leaf.DNSNames, "a.b.apps.roundhouse.test") {
		t.Fatalf("served %v for an uncovered host", leaf.DNSNames)
	}
}
