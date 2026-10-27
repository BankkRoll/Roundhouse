package certs

import (
	"crypto/ecdh"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
	"time"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// Verified is a certificate upsert that passed [Verify]: the file Caddy
// loads, and what the store records about it.
type Verified struct {
	ID        string
	SHA256    string
	Hostnames []string
	// NotAfter is the leaf's expiry.
	NotAfter time.Time
	// File is the chain PEM followed by the private key PEM.
	File []byte
}

// Verify opens an upsert's key and checks the certificate before anything
// is written: the chain digest is the one the key was sealed with, every
// block of the chain parses, the key belongs to the leaf, the leaf covers
// every hostname the upsert claims and has not expired.
//
// SECURITY: the frame is signed, but these checks keep a control-plane bug
// from installing a certificate Caddy would refuse (which fails the whole
// load) or one for names it was not issued for.
func Verify(key *ecdh.PrivateKey, nodeID string, u *protocol.CertUpsert, now time.Time) (*Verified, error) {
	sum := sha256.Sum256([]byte(u.CertPEM))
	if hex.EncodeToString(sum[:]) != u.SHA256 {
		return nil, errors.New("sha256 does not match cert_pem")
	}
	keyPEM, err := protocol.OpenCertKey(key, nodeID, u)
	if err != nil {
		return nil, err
	}
	chain, err := parseChain([]byte(u.CertPEM))
	if err != nil {
		return nil, err
	}
	leaf := chain[0]
	if err := checkKeyPEM(keyPEM); err != nil {
		return nil, err
	}
	if _, err := tls.X509KeyPair([]byte(u.CertPEM), []byte(keyPEM)); err != nil {
		return nil, fmt.Errorf("private key does not match the certificate: %w", err)
	}
	for _, h := range u.Hostnames {
		if !Covers(leaf, h) {
			return nil, fmt.Errorf("certificate does not cover %s", h)
		}
	}
	if !now.Before(leaf.NotAfter) {
		return nil, fmt.Errorf("certificate expired at %s", leaf.NotAfter.UTC().Format(time.RFC3339))
	}
	file := make([]byte, 0, len(u.CertPEM)+len(keyPEM)+1)
	file = append(file, u.CertPEM...)
	if !strings.HasSuffix(u.CertPEM, "\n") {
		file = append(file, '\n')
	}
	file = append(file, keyPEM...)
	return &Verified{
		ID: u.ID, SHA256: u.SHA256, Hostnames: normalizeHosts(u.Hostnames), NotAfter: leaf.NotAfter, File: file,
	}, nil
}

// parseChain parses a PEM chain of certificates only, leaf first.
func parseChain(data []byte) ([]*x509.Certificate, error) {
	var chain []*x509.Certificate
	for {
		var block *pem.Block
		block, data = pem.Decode(data)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			return nil, fmt.Errorf("cert_pem holds a %q block", block.Type)
		}
		c, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("cert_pem: %w", err)
		}
		chain = append(chain, c)
	}
	if len(chain) == 0 {
		return nil, errors.New("cert_pem holds no certificate")
	}
	if strings.TrimSpace(string(data)) != "" {
		return nil, errors.New("cert_pem has trailing data")
	}
	return chain, nil
}

// checkKeyPEM requires exactly one private key block and nothing else. The
// key is appended to the chain in one file that Caddy splits by block type,
// so a stray CERTIFICATE block would extend the chain, and a second key
// would fail the whole load.
func checkKeyPEM(keyPEM string) error {
	block, rest := pem.Decode([]byte(keyPEM))
	if block == nil || !strings.HasSuffix(block.Type, "PRIVATE KEY") {
		return errors.New("key_pem holds no private key")
	}
	if strings.TrimSpace(string(rest)) != "" {
		return errors.New("key_pem has trailing data")
	}
	return nil
}

// Covers reports whether leaf is valid for host: a DNS SAN equal to it, or
// for an exact host a wildcard SAN matching its first label. A wildcard host
// needs the identical wildcard SAN.
func Covers(leaf *x509.Certificate, host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	_, parent, hasParent := strings.Cut(host, ".")
	for _, san := range leaf.DNSNames {
		san = strings.ToLower(san)
		if san == host {
			return true
		}
		if hasParent && !strings.HasPrefix(host, "*.") && strings.HasPrefix(san, "*.") && san[2:] == parent {
			return true
		}
	}
	return false
}

func normalizeHosts(in []string) []string {
	out := make([]string, len(in))
	for i, h := range in {
		out[i] = strings.ToLower(h)
	}
	return out
}
