package api

import (
	"context"
	"net/http"
)

// Custom domain routes (ADR 0009). Listing is RouteListDomains.
var (
	RouteAddDomain    = Route{http.MethodPost, "/v1/services/{serviceId}/domains"}
	RouteGetDomain    = Route{http.MethodGet, "/v1/domains/{domainId}"}
	RouteUpdateDomain = Route{http.MethodPatch, "/v1/domains/{domainId}"}
	RouteCheckDomain  = Route{http.MethodPost, "/v1/domains/{domainId}/check"}
	RouteRemoveDomain = Route{http.MethodDelete, "/v1/domains/{domainId}"}
)

// AddDomainInput is the body of POST /v1/services/{serviceId}/domains.
type AddDomainInput struct {
	EnvironmentID string `json:"environment_id"`
	// Hostname is normalised by the API: case, a trailing dot and
	// internationalised names are accepted.
	Hostname string `json:"hostname"`
}

// AddDomain adds a custom hostname to a service in an environment. The API
// checks DNS once and returns the records still to create.
func (c *Client) AddDomain(ctx context.Context, serviceID string, in AddDomainInput) (*Domain, error) {
	return fetch[Domain](ctx, c, RouteAddDomain, nil, in, serviceID)
}

// GetDomain returns one domain with its records and verification state.
func (c *Client) GetDomain(ctx context.Context, domainID string) (*Domain, error) {
	return fetch[Domain](ctx, c, RouteGetDomain, nil, nil, domainID)
}

// UpdateDomainInput is the body of PATCH /v1/domains/{domainId}.
type UpdateDomainInput struct {
	HSTS DomainHSTS `json:"hsts"`
	// ConfirmPreload is the hostname, typed out, when turning preload on;
	// the API refuses preload without it.
	ConfirmPreload string `json:"confirm_preload,omitempty"`
}

// UpdateDomain changes a custom domain's HSTS policy. The API answers 422
// invalid_hsts or preload_confirmation_required, and 409 for a generated
// domain.
func (c *Client) UpdateDomain(ctx context.Context, domainID string, in UpdateDomainInput) (*Domain, error) {
	return fetch[Domain](ctx, c, RouteUpdateDomain, nil, in, domainID)
}

// CheckDomain checks a domain's DNS now, resuming a failed one. The API
// answers 429 when it was checked moments ago.
func (c *Client) CheckDomain(ctx context.Context, domainID string) (*Domain, error) {
	return fetch[Domain](ctx, c, RouteCheckDomain, nil, nil, domainID)
}

// RemoveDomain removes a custom domain and its route.
func (c *Client) RemoveDomain(ctx context.Context, domainID string) error {
	return c.call(ctx, RouteRemoveDomain, nil, nil, nil, domainID)
}
