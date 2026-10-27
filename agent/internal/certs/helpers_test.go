package certs

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"math/big"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/sealtest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

const testNode = "nod_test"

// issued is a test certificate: its chain PEM (leaf, then CA) and key PEM.
type issued struct {
	chain, key string
	leaf       *x509.Certificate
}

// testCA signs leaves for the tests.
type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  string
}

func newCA(t testing.TB) *testCA {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{Organization: []string{"Roundhouse Test"}, CommonName: "Test CA R1"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(365 * 24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return &testCA{cert: cert, key: key, pem: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))}
}

// issue signs a leaf for names valid from notBefore to notAfter.
func (ca *testCA) issue(t testing.TB, notBefore, notAfter time.Time, names ...string) issued {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: names[0]},
		DNSNames:     names,
		NotBefore:    notBefore,
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(der)
	kder, _ := x509.MarshalPKCS8PrivateKey(key)
	return issued{
		chain: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})) + ca.pem,
		key:   string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kder})),
		leaf:  leaf,
	}
}

// valid issues a certificate for names valid for 90 days.
func (ca *testCA) valid(t testing.TB, names ...string) issued {
	return ca.issue(t, time.Now().Add(-time.Hour), time.Now().Add(90*24*time.Hour), names...)
}

func digest(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// upsert seals c as certificate id for the test node.
func upsert(t testing.TB, id string, c issued, hostnames ...string) protocol.CertUpsert {
	t.Helper()
	sha := digest(c.chain)
	return protocol.CertUpsert{
		ID: id, Hostnames: hostnames, CertPEM: c.chain, SHA256: sha,
		KeySealed: *sealtest.SealCertKey(t, sealtest.Key().PublicKey(), testNode, id, sha, c.key),
		NotAfter:  c.leaf.NotAfter.UnixMilli(),
	}
}
