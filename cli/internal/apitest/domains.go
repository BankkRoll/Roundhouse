package apitest

import (
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
)

// DNSState is what the fake's resolver sees for a custom hostname; see
// [Fake.SetDNS]. Hostnames nobody set resolve to nothing.
type DNSState struct {
	// Routing is set when the CNAME (or A/AAAA) points at the install.
	Routing bool
	// Ownership is set when the _roundhouse TXT holds the domain's token.
	Ownership bool
}

// SetDNS sets what checks of hostname see from now on.
func (f *Fake) SetDNS(hostname string, s DNSState) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dns == nil {
		f.dns = map[string]DNSState{}
	}
	f.dns[hostname] = s
}

// Domains returns copies of every domain.
func (f *Fake) Domains() []api.Domain {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.domains)
}

var fakeHostnameRE = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// checkDomain applies the fake resolver's view, as one API check would.
func (f *Fake) checkDomain(d *api.Domain) {
	s := f.dns[d.Hostname]
	state := func(ok bool) string {
		if ok {
			return "ok"
		}
		return "missing"
	}
	for i := range d.Records {
		if d.Records[i].Purpose == "routing" {
			d.Records[i].State = state(s.Routing)
		} else {
			d.Records[i].State = state(s.Ownership)
		}
	}
	d.LastCheckedAt = i64(Now)
	switch {
	case s.Routing && s.Ownership:
		d.Status, d.VerificationStatus, d.TLSStatus, d.Error = "active", "verified", "issued", nil
		d.VerifiedAt = i64(Now)
	case s.Routing:
		d.Status = "pending_verification"
		d.Error = str("TXT _roundhouse." + d.Hostname + " not found.")
	default:
		d.Status = "pending_dns"
		d.Error = str("No CNAME or A/AAAA record found for " + d.Hostname + ".")
	}
}

func (f *Fake) findDomain(w http.ResponseWriter, id string) *api.Domain {
	for i := range f.domains {
		if f.domains[i].ID == id {
			return &f.domains[i]
		}
	}
	apiError(w, http.StatusNotFound, "not_found", "Domain not found")
	return nil
}

func (f *Fake) addDomain(w http.ResponseWriter, r *http.Request) {
	p, s := f.service(w, r.PathValue("serviceId"))
	if s == nil {
		return
	}
	var in api.AddDomainInput
	if decode(r, &in) != nil || in.EnvironmentID == "" {
		apiError(w, http.StatusBadRequest, "invalid_request", "environment_id: Required")
		return
	}
	if !slices.ContainsFunc(p.Environments, func(e api.Environment) bool { return e.ID == in.EnvironmentID }) {
		apiError(w, http.StatusNotFound, "not_found", "Environment not found")
		return
	}
	host := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(in.Hostname)), ".")
	switch {
	case strings.HasPrefix(host, "*."):
		apiError(w, http.StatusUnprocessableEntity, "hostname_not_allowed", "Wildcard domains aren't supported yet; add each hostname on its own.")
		return
	case !fakeHostnameRE.MatchString(host):
		apiError(w, http.StatusBadRequest, "invalid_request", "Enter a full hostname such as shop.example.com.")
		return
	case host == "apps.example.com" || strings.HasSuffix(host, ".apps.example.com"):
		apiError(w, http.StatusUnprocessableEntity, "hostname_not_allowed", "That hostname belongs to this install.")
		return
	}
	if slices.ContainsFunc(f.domains, func(d api.Domain) bool { return d.Hostname == host }) {
		apiError(w, http.StatusConflict, "domain_taken", host+" is already added to a service on this install")
		return
	}
	target := "ingress.apps.example.com"
	for _, d := range f.domains {
		if d.ServiceID == s.ID && d.EnvironmentID == in.EnvironmentID && d.Type == "generated" {
			target = d.Hostname
		}
	}
	id := f.nextID("dom")
	d := api.Domain{
		ID: id, ServiceID: s.ID, EnvironmentID: in.EnvironmentID, Hostname: host, URL: "https://" + host,
		Type: "custom", TargetPort: 8080, VerificationStatus: "pending", TLSStatus: "pending", Status: "pending_dns",
		Records: []api.DNSRecord{
			{Type: "CNAME", Name: host, Value: target, Purpose: "routing", State: "unknown"},
			{Type: "TXT", Name: "_roundhouse." + host, Value: fmt.Sprintf("rh-verify=%064d", f.seq), Purpose: "ownership", State: "unknown"},
		},
		NextCheckAt: i64(Now + 60000), CreatedAt: Now,
	}
	f.checkDomain(&d)
	f.domains = append(f.domains, d)
	writeJSON(w, http.StatusCreated, d)
}

func (f *Fake) getDomain(w http.ResponseWriter, r *http.Request) {
	if d := f.findDomain(w, r.PathValue("domainId")); d != nil {
		writeJSON(w, http.StatusOK, d)
	}
}

func (f *Fake) recheckDomain(w http.ResponseWriter, r *http.Request) {
	d := f.findDomain(w, r.PathValue("domainId"))
	if d == nil {
		return
	}
	if d.Type != "custom" {
		apiError(w, http.StatusConflict, "conflict", "Generated domains are always verified")
		return
	}
	f.checkDomain(d)
	writeJSON(w, http.StatusOK, d)
}

func (f *Fake) removeDomain(w http.ResponseWriter, r *http.Request) {
	d := f.findDomain(w, r.PathValue("domainId"))
	if d == nil {
		return
	}
	if d.Type != "custom" {
		apiError(w, http.StatusConflict, "conflict", "Turn off the generated domain under Networking instead")
		return
	}
	id := d.ID
	f.domains = slices.DeleteFunc(f.domains, func(x api.Domain) bool { return x.ID == id })
	w.WriteHeader(http.StatusNoContent)
}
