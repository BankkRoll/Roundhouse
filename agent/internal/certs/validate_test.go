package certs

import (
	"crypto/tls"
	"strings"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/sealtest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

func TestVerify(t *testing.T) {
	ca := newCA(t)
	good := ca.valid(t, "shop.example.com", "www.shop.example.com")
	wild := ca.valid(t, "*.apps.example.com")
	other := ca.valid(t, "shop.example.com")
	expired := ca.issue(t, time.Now().Add(-48*time.Hour), time.Now().Add(-time.Hour), "shop.example.com")
	now := time.Now()

	v, err := Verify(sealtest.Key(), testNode, ptr(upsert(t, "cer_1", good, "shop.example.com", "WWW.shop.example.com")), now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tls.X509KeyPair(v.File, v.File); err != nil {
		t.Fatalf("file is not a loadable pair: %v", err)
	}
	if !strings.HasPrefix(string(v.File), good.chain) || v.NotAfter != good.leaf.NotAfter || v.Hostnames[1] != "www.shop.example.com" {
		t.Fatalf("verified = %+v", v)
	}
	if _, err := Verify(sealtest.Key(), testNode, ptr(upsert(t, "cer_w", wild, "*.apps.example.com", "x.apps.example.com")), now); err != nil {
		t.Fatalf("wildcard: %v", err)
	}

	for name, tc := range map[string]struct {
		u    protocol.CertUpsert
		key  bool
		want string
	}{
		"bad sha": {u: func() protocol.CertUpsert {
			u := upsert(t, "cer_1", good, "shop.example.com")
			u.CertPEM = other.chain
			return u
		}(), want: "sha256"},
		"key mismatch": {u: func() protocol.CertUpsert {
			u := upsert(t, "cer_1", good, "shop.example.com")
			u.KeySealed = *sealtest.SealCertKey(t, sealtest.Key().PublicKey(), testNode, "cer_1", u.SHA256, other.key)
			return u
		}(), want: "does not match"},
		"SAN mismatch":      {u: upsert(t, "cer_1", good, "evil.example.com"), want: "does not cover evil.example.com"},
		"wildcard too deep": {u: upsert(t, "cer_w", wild, "a.b.apps.example.com"), want: "does not cover"},
		"wildcard host":     {u: upsert(t, "cer_1", good, "*.shop.example.com"), want: "does not cover"},
		"expired":           {u: upsert(t, "cer_1", expired, "shop.example.com"), want: "expired"},
		"wrong AAD: other certificate": {u: func() protocol.CertUpsert {
			u := upsert(t, "cer_1", good, "shop.example.com")
			u.ID = "cer_2"
			return u
		}(), want: "certificate cer_2"},
		"wrong AAD: other node": {u: func() protocol.CertUpsert {
			u := upsert(t, "cer_1", good, "shop.example.com")
			u.KeySealed = *sealtest.SealCertKey(t, sealtest.Key().PublicKey(), "nod_other", "cer_1", u.SHA256, good.key)
			return u
		}(), want: "certificate cer_1"},
		"wrong node key": {u: upsert(t, "cer_1", good, "shop.example.com"), key: true, want: "certificate cer_1"},
		"key in chain": {u: func() protocol.CertUpsert {
			u := upsert(t, "cer_1", good, "shop.example.com")
			u.CertPEM = good.chain + good.key
			u.SHA256 = digest(u.CertPEM)
			u.KeySealed = *sealtest.SealCertKey(t, sealtest.Key().PublicKey(), testNode, "cer_1", u.SHA256, good.key)
			return u
		}(), want: "PRIVATE KEY"},
	} {
		key := sealtest.Key()
		if tc.key {
			key = sealtest.OtherKey(t)
		}
		_, err := Verify(key, testNode, &tc.u, now)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v, want %q", name, err, tc.want)
		}
	}
}

func ptr[T any](v T) *T { return &v }

func TestCovers(t *testing.T) {
	ca := newCA(t)
	leaf := ca.valid(t, "a.example.com", "*.apps.example.com").leaf
	for host, want := range map[string]bool{
		"a.example.com":        true,
		"A.Example.com.":       true,
		"x.apps.example.com":   true,
		"*.apps.example.com":   true,
		"apps.example.com":     false,
		"x.y.apps.example.com": false,
		"b.example.com":        false,
		"*.example.com":        false,
	} {
		if got := Covers(leaf, host); got != want {
			t.Errorf("Covers(%q) = %v", host, got)
		}
	}
}
