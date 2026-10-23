package protocol

import (
	"errors"
	"fmt"
	"strings"
)

// CertificateRef is a certificate an ingress node must hold, listed in
// [DesiredState].Certificates.
type CertificateRef struct {
	ID string `json:"id"`
	// SHA256 is the hex digest of the chain PEM; a mismatch means
	// [CertRequest].
	SHA256   string `json:"sha256"`
	NotAfter int64  `json:"not_after"`
}

// ACMEChallengeUpstream is where Caddy proxies HTTP-01 challenges of
// managed hosts.
type ACMEChallengeUpstream struct {
	URL string `json:"url"`
	// Host is the Host header to send.
	Host string `json:"host"`
}

// IngressSettings is [DesiredState].Ingress: node-level Caddy settings.
type IngressSettings struct {
	// ACMEChallengeUpstream is nil outside managed mode.
	ACMEChallengeUpstream *ACMEChallengeUpstream `json:"acme_challenge_upstream"`
	// AllowedSources admits only these CIDRs to 80/443; nil admits everyone.
	AllowedSources *[]string `json:"allowed_sources"`
	// ManagedHosts are kept out of Caddy's own certificate automation.
	ManagedHosts []string `json:"managed_hosts"`
}

func (s *IngressSettings) validate() error {
	if u := s.ACMEChallengeUpstream; u != nil {
		if len(u.URL) > 2048 || !httpsURLRE.MatchString(u.URL) || len(u.Host) > 253 || !ingressHostRE.MatchString(u.Host) {
			return errors.New("ingress.acme_challenge_upstream: invalid")
		}
	}
	if s.AllowedSources != nil {
		if len(*s.AllowedSources) == 0 || len(*s.AllowedSources) > MaxIngressSources {
			return fmt.Errorf("ingress.allowed_sources: must have 1 to %d", MaxIngressSources)
		}
		for _, c := range *s.AllowedSources {
			if !IsCIDR(c) {
				return fmt.Errorf("ingress.allowed_sources: invalid %q", c)
			}
		}
	}
	if len(s.ManagedHosts) > MaxManagedHosts {
		return fmt.Errorf("ingress.managed_hosts: at most %d", MaxManagedHosts)
	}
	for _, h := range s.ManagedHosts {
		if !IsRouteHostname(h) {
			return fmt.Errorf("ingress.managed_hosts: invalid %q", h)
		}
	}
	return nil
}

func validateCertificates(certs []CertificateRef) error {
	if len(certs) > MaxCertificatesPerNode {
		return fmt.Errorf("certificates: at most %d", MaxCertificatesPerNode)
	}
	seen := map[string]bool{}
	for _, c := range certs {
		if !idRE.MatchString(c.ID) || seen[c.ID] || !sha256HexRE.MatchString(c.SHA256) || c.NotAfter < 0 {
			return fmt.Errorf("certificates: invalid or duplicate %q", c.ID)
		}
		seen[c.ID] = true
	}
	return nil
}

// CertUpsert is one certificate body in [CertSync].
type CertUpsert struct {
	ID        string   `json:"id"`
	Hostnames []string `json:"hostnames"`
	// CertPEM is the chain, leaf first.
	CertPEM string `json:"cert_pem"`
	// SHA256 is the hex digest of CertPEM.
	SHA256 string `json:"sha256"`
	// KeySealed opens with [OpenCertKey].
	KeySealed SealedBox `json:"key_sealed"`
	NotAfter  int64     `json:"not_after"`
}

// CertSync ships certificate bodies to an ingress node; credential-bearing
// whenever it has upserts. Type must be [TypeCertSync].
type CertSync struct {
	Type string `json:"type"`
	ControlHeader
	Upserts []CertUpsert `json:"upserts"`
	Removes []string     `json:"removes"`
}

func (*CertSync) controlMessage() {}

// Validate implements [Validator].
func (m *CertSync) Validate() error {
	if err := m.ControlHeader.validate(); err != nil {
		return err
	}
	if len(m.Upserts) > MaxCertUpsertsPerFrame || len(m.Removes) > MaxCertIDsPerFrame {
		return errors.New("cert_sync: too many entries")
	}
	seen := map[string]bool{}
	for _, u := range m.Upserts {
		if !idRE.MatchString(u.ID) || seen[u.ID] {
			return fmt.Errorf("upserts: invalid or duplicate %q", u.ID)
		}
		seen[u.ID] = true
		if len(u.Hostnames) == 0 || len(u.Hostnames) > MaxCertHostnames {
			return fmt.Errorf("upserts: %s needs 1 to %d hostnames", u.ID, MaxCertHostnames)
		}
		for _, h := range u.Hostnames {
			if !IsRouteHostname(h) {
				return fmt.Errorf("upserts: %s: invalid hostname %q", u.ID, h)
			}
		}
		if u.CertPEM == "" || len(u.CertPEM) > MaxCertPEMBytes || !strings.HasPrefix(u.CertPEM, "-----BEGIN CERTIFICATE-----") {
			return fmt.Errorf("upserts: %s: expected a PEM certificate chain", u.ID)
		}
		if !sha256HexRE.MatchString(u.SHA256) || u.NotAfter < 0 {
			return fmt.Errorf("upserts: %s: invalid sha256 or not_after", u.ID)
		}
		if err := u.KeySealed.validate(); err != nil {
			return fmt.Errorf("upserts: %s: key_sealed: %w", u.ID, err)
		}
	}
	for _, id := range m.Removes {
		if !idRE.MatchString(id) || seen[id] {
			return fmt.Errorf("removes: invalid or repeated %q", id)
		}
		seen[id] = true
	}
	return validateShortLived(m)
}

// CertAck confirms certificates written and loaded. Type must be
// [TypeCertAck].
type CertAck struct {
	Type string   `json:"type"`
	IDs  []string `json:"ids"`
}

func (*CertAck) agentMessage() {}

// Validate implements [Validator].
func (m *CertAck) Validate() error { return validateCertIDs(m.IDs, MaxCertIDsPerFrame) }

// CertRequest asks for manifest entries the agent lacks or holds with
// another digest. Type must be [TypeCertRequest].
type CertRequest struct {
	Type string   `json:"type"`
	IDs  []string `json:"ids"`
}

func (*CertRequest) agentMessage() {}

// Validate implements [Validator].
func (m *CertRequest) Validate() error { return validateCertIDs(m.IDs, MaxCertificatesPerNode) }

func validateCertIDs(ids []string, max int) error {
	if len(ids) == 0 || len(ids) > max {
		return fmt.Errorf("ids: must have 1 to %d", max)
	}
	for _, id := range ids {
		if !idRE.MatchString(id) {
			return fmt.Errorf("ids: invalid %q", id)
		}
	}
	return nil
}

// CertState is Caddy's on-demand issuance outcome for a hostname.
type CertState string

// Certificate states.
const (
	CertIssued  CertState = "issued"
	CertFailed  CertState = "failed"
	CertPending CertState = "pending"
)

// CertStatus reports Caddy's on-demand issuance for one hostname in acme
// mode; Error is set exactly when failed. Type must be [TypeCertStatus].
type CertStatus struct {
	Type     string    `json:"type"`
	Hostname string    `json:"hostname"`
	State    CertState `json:"state"`
	Issuer   string    `json:"issuer,omitempty"`
	NotAfter *int64    `json:"not_after,omitempty"`
	Error    string    `json:"error,omitempty"`
}

func (*CertStatus) agentMessage() {}

// Validate implements [Validator].
func (m *CertStatus) Validate() error {
	if !IsRouteHostname(m.Hostname) {
		return fmt.Errorf("hostname: invalid %q", m.Hostname)
	}
	switch m.State {
	case CertIssued, CertFailed, CertPending:
	default:
		return fmt.Errorf("state: invalid %q", m.State)
	}
	if (m.State == CertFailed) != (m.Error != "") {
		return errors.New("error: exactly failed states carry one")
	}
	if len(m.Issuer) > 256 || len(m.Error) > MaxMessageBytes || (m.NotAfter != nil && *m.NotAfter < 0) {
		return errors.New("issuer, error or not_after: out of range")
	}
	return nil
}
