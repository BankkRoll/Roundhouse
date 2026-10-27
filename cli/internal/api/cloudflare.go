package api

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"time"
)

// RouteServiceCloudflare reports a service's Cloudflare Containers runtime
// (ADR 0011).
var RouteServiceCloudflare = Route{http.MethodGet, "/v1/services/{serviceId}/cloudflare"}

// Service providers, from SERVICE_PROVIDERS in packages/shared/src/cloudflare.ts.
const (
	ProviderNodes      = "nodes"
	ProviderCloudflare = "cloudflare"
)

// ServiceProviders lists where a service's replicas can run.
var ServiceProviders = []string{ProviderNodes, ProviderCloudflare}

// CloudflareInstanceTypes lists the instance type names, smallest first,
// from CLOUDFLARE_INSTANCE_TYPES.
var CloudflareInstanceTypes = []string{"lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"}

// MaxCloudflareInstances is the largest `max_instances`.
const MaxCloudflareInstances = 100

// MaxCloudflareRegions is the most regions `placement.cloudflare` takes.
const MaxCloudflareRegions = 16

// CloudflareRegionRE matches a region code.
var CloudflareRegionRE = regexp.MustCompile(`^[A-Za-z0-9-]{2,16}$`)

// DefaultCloudflareSleepAfter is `sleep_after` when none is set.
const DefaultCloudflareSleepAfter = "10m"

var sleepAfterRE = regexp.MustCompile(`^([1-9][0-9]{0,4})(s|m|h)$`)

// ParseSleepAfter mirrors parseSleepAfter in packages/shared: "90s", "10m"
// or "2h", between 1 minute and 24 hours.
func ParseSleepAfter(s string) (time.Duration, error) {
	m := sleepAfterRE.FindStringSubmatch(s)
	if m == nil {
		return 0, fmt.Errorf("invalid duration %q: use a whole number of s, m or h, e.g. 10m", s)
	}
	n, _ := strconv.Atoi(m[1])
	d := time.Duration(n) * map[string]time.Duration{"s": time.Second, "m": time.Minute, "h": time.Hour}[m[2]]
	if d < time.Minute || d > 24*time.Hour {
		return 0, fmt.Errorf("%s is outside 1m to 24h", s)
	}
	return d, nil
}

// CloudflarePlacement is `placement.cloudflare`: how a service runs on
// Cloudflare Containers.
type CloudflarePlacement struct {
	// InstanceType is one of [CloudflareInstanceTypes]; empty derives it
	// from the service's resources.
	InstanceType string `json:"instance_type,omitempty"`
	// MaxInstances is the pool size, 1..[MaxCloudflareInstances].
	MaxInstances int `json:"max_instances"`
	// SleepAfter is the idle time before an instance sleeps, "1m".."24h".
	SleepAfter string   `json:"sleep_after"`
	Regions    []string `json:"regions,omitempty"`
}

// PlacementPatch changes where a service runs. `cloudflare` replaces the
// stored part whole.
type PlacementPatch struct {
	// Provider is one of [ServiceProviders].
	Provider   string               `json:"provider,omitempty"`
	Cloudflare *CloudflarePlacement `json:"cloudflare,omitempty"`
}

// PlacementConfig is a config's `placement`: which nodes, or Cloudflare.
type PlacementConfig struct {
	NodeSelector map[string]string `json:"node_selector"`
	// Provider is empty on a control plane without providers, meaning nodes.
	Provider   string               `json:"provider"`
	Cloudflare *CloudflarePlacement `json:"cloudflare"`
}

// EligibilityFailure is a Cloudflare eligibility rule a service fails.
type EligibilityFailure struct {
	// Rule is e.g. "port", "volume" or "domains".
	Rule    string `json:"rule"`
	Message string `json:"message"`
}

// CloudflareInstances counts a service's running Cloudflare instances.
type CloudflareInstances struct {
	Total   int `json:"total"`
	Running int `json:"running"`
}

// CloudflareRuntime is the Worker and container application serving a
// service on Cloudflare.
type CloudflareRuntime struct {
	ScriptName    string               `json:"script_name"`
	Status        string               `json:"status"`
	Generation    int                  `json:"generation"`
	ApplicationID *string              `json:"application_id"`
	Routes        []string             `json:"routes"`
	WorkersDevURL *string              `json:"workers_dev_url"`
	Instances     *CloudflareInstances `json:"instances"`
	// DeleteAfter is when an unused script and application are deleted.
	DeleteAfter *int64 `json:"delete_after"`
}

// CloudflareDeployment is one rollout of a service to Cloudflare.
type CloudflareDeployment struct {
	ID           string  `json:"id"`
	DeploymentID string  `json:"deployment_id"`
	Status       string  `json:"status"`
	ImageRef     string  `json:"image_ref"`
	ImageDigest  *string `json:"image_digest"`
	InstanceType string  `json:"instance_type"`
	MaxInstances int     `json:"max_instances"`
	Error        *string `json:"error"`
	CreatedAt    int64   `json:"created_at"`
}

// CloudflareStatus is the response of GET /v1/services/{serviceId}/cloudflare.
type CloudflareStatus struct {
	// Provider is one of [ServiceProviders].
	Provider string `json:"provider"`
	// Configured reports whether the instance has a Cloudflare account set up.
	Configured bool `json:"configured"`
	// Eligibility lists every rule the service fails; empty when eligible.
	Eligibility []EligibilityFailure `json:"eligibility"`
	// Warnings are non-fatal, e.g. a reference to a database Cloudflare
	// can't reach.
	Warnings []string `json:"warnings"`
	// Runtime is nil until the service has run on Cloudflare.
	Runtime     *CloudflareRuntime     `json:"runtime"`
	Deployments []CloudflareDeployment `json:"deployments"`
}

// ServiceCloudflare reports where a service runs in an environment and, on
// Cloudflare, its runtime and recent rollouts.
func (c *Client) ServiceCloudflare(ctx context.Context, serviceID, environmentID string) (*CloudflareStatus, error) {
	return fetch[CloudflareStatus](ctx, c, RouteServiceCloudflare, envQuery(environmentID), nil, serviceID)
}
