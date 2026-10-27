package cli

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/apitest"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// lastPatch decodes the body of the last PATCH of a service.
func lastPatch(t *testing.T, f *apitest.Fake) api.UpdateServiceInput {
	t.Helper()
	var in api.UpdateServiceInput
	reqs := f.Requests()
	for i := len(reqs) - 1; i >= 0; i-- {
		if reqs[i].Method == "PATCH" && strings.HasPrefix(reqs[i].Path, "/v1/services/") {
			if err := json.Unmarshal([]byte(reqs[i].Body), &in); err != nil {
				t.Fatal(err)
			}
			return in
		}
	}
	t.Fatal("no PATCH of a service")
	return in
}

func TestRuntimeShow(t *testing.T) {
	h := newHarness(t)
	h.link()
	appID, url, digest := "app_123", "https://rh-api.acme.workers.dev", "sha256:"+strings.Repeat("c", 64)
	h.fake.SetCloudflare(apitest.APIServiceID, apitest.ProductionID, api.CloudflareStatus{
		Provider: api.ProviderCloudflare, Configured: true, Eligibility: []api.EligibilityFailure{},
		Runtime: &api.CloudflareRuntime{ScriptName: "rh-svc-api-prod", Status: "active", Generation: 3, ApplicationID: &appID,
			Routes: []string{"api.apps.example.com/*"}, WorkersDevURL: &url, Instances: &api.CloudflareInstances{Total: 4, Running: 2}},
		Deployments: []api.CloudflareDeployment{{ID: "cfd_1", DeploymentID: apitest.ActiveDeploy, Status: "active", ImageRef: "registry.cloudflare.com/acme/api:dep_0003", ImageDigest: &digest,
			InstanceType: "basic", MaxInstances: 4, CreatedAt: apitest.Now - 600000}},
	})
	r := h.ok("", "runtime")
	for _, want := range []string{
		"API in production runs on Cloudflare Containers", "Cloudflare   set up", "Eligible     yes",
		"Script       rh-svc-api-prod", "Generation   3", "Application  app_123", "Routes       api.apps.example.com/*",
		"workers.dev  https://rh-api.acme.workers.dev", "Instances    2 running of 4",
		"Recent rollouts", "dep_0003", "basic", "sha256:cccccccccccc", "10m ago",
	} {
		contains(t, r.stdout, want)
	}

	r = h.ok("", "runtime", "api", "--json")
	var st api.CloudflareStatus
	if err := json.Unmarshal([]byte(r.stdout), &st); err != nil {
		t.Fatal(err)
	}
	if st.Runtime == nil || st.Runtime.ScriptName != "rh-svc-api-prod" || len(st.Deployments) != 1 {
		t.Errorf("--json = %+v", st)
	}
}

func TestRuntimeShowIneligible(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.SetCloudflare(apitest.APIServiceID, apitest.StagingID, api.CloudflareStatus{
		Provider: api.ProviderNodes, Configured: false,
		Eligibility: []api.EligibilityFailure{{Rule: "volume", Message: "Services with a volume must run on nodes"}},
		Warnings:    []string{"DATABASE_URL references db, which Cloudflare can't reach"},
		Deployments: []api.CloudflareDeployment{},
	})
	r := h.ok("", "runtime", "--environment", "staging")
	contains(t, r.stdout, "API in staging runs on your servers")
	contains(t, r.stdout, "not set up")
	contains(t, r.stdout, "Eligible     no")
	contains(t, r.stdout, "✗ volume: Services with a volume must run on nodes")
	contains(t, r.stdout, "Warning      DATABASE_URL references db")
	notContains(t, r.stdout, "Recent rollouts")
}

func TestRuntimeSetCloudflare(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.ok("", "runtime", "set", "cloudflare", "--instance-type", "standard-1", "--sleep-after", "30m", "--region", "enam", "--region", "weur", "--yes")
	contains(t, r.stdout, "✓ API in production will run on Cloudflare Containers (config version 2)")
	contains(t, r.stdout, "Instance type  standard-1")
	contains(t, r.stdout, "Max instances  1")
	contains(t, r.stdout, "Sleep after    30m")
	contains(t, r.stdout, "Regions        enam, weur")
	contains(t, r.stdout, "roundhouse deploy --service api --environment production")
	in := lastPatch(t, h.fake)
	if in.EnvironmentID != apitest.ProductionID || in.ExpectedVersion != 1 || in.Placement == nil || in.Placement.Provider != "cloudflare" {
		t.Fatalf("patch = %+v", in)
	}
	cf := in.Placement.Cloudflare
	if cf == nil || cf.InstanceType != "standard-1" || cf.MaxInstances != 1 || cf.SleepAfter != "30m" || strings.Join(cf.Regions, ",") != "enam,weur" {
		t.Errorf("cloudflare = %+v", cf)
	}

	h.ok("", "runtime", "set", "cloudflare", "--max-instances", "8")
	cf = lastPatch(t, h.fake).Placement.Cloudflare
	if cf.InstanceType != "standard-1" || cf.MaxInstances != 8 || cf.SleepAfter != "30m" || len(cf.Regions) != 2 {
		t.Errorf("saved settings not kept: %+v", cf)
	}

	r = h.ok("", "runtime", "set", "cloudflare")
	contains(t, r.stdout, "already runs on Cloudflare Containers; nothing to change")

	h.expect(exitcode.InputRequired, "", "runtime", "set", "nodes")
	r = h.ok("", "runtime", "set", "nodes", "--yes", "--json")
	var out api.UpdatedService
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil {
		t.Fatal(err)
	}
	var p api.PlacementConfig
	if out.Config == nil || json.Unmarshal(out.Config.Placement, &p) != nil || p.Provider != "nodes" || p.Cloudflare == nil {
		t.Errorf("config after set nodes = %s", out.Config.Placement)
	}
	if in := lastPatch(t, h.fake); in.Placement.Cloudflare != nil {
		t.Errorf("set nodes sent cloudflare settings: %+v", in.Placement.Cloudflare)
	}
}

func TestRuntimeSetAsks(t *testing.T) {
	h := newHarness(t)
	h.link()
	r := h.interactive("n\n", "runtime", "set", "cloudflare")
	if r.code != exitcode.Error {
		t.Fatalf("exit %d, want %d\n%s", r.code, exitcode.Error, r.stderr)
	}
	contains(t, r.stderr, "Run API in production on Cloudflare Containers?")
	if n := patchCount(h); n != 0 {
		t.Errorf("%d PATCHes after declining", n)
	}
	r = h.interactive("y\n", "runtime", "set", "cloudflare")
	if r.code != 0 {
		t.Fatalf("exit %d\n%s", r.code, r.stderr)
	}
}

func TestRuntimeSetIneligible(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.SetCloudflare(apitest.APIServiceID, apitest.ProductionID, api.CloudflareStatus{
		Provider: api.ProviderNodes, Configured: true,
		Eligibility: []api.EligibilityFailure{
			{Rule: "volume", Message: "Services with a volume must run on nodes"},
			{Rule: "domains", Message: "Custom domains must use Cloudflare for SaaS mode: shop.example.com"},
		},
		Deployments: []api.CloudflareDeployment{},
	})
	r := h.expect(exitcode.Invalid, "", "runtime", "set", "cloudflare", "--yes")
	want := "error: This service can't run on Cloudflare Containers\n" +
		"  ✗ volume: Services with a volume must run on nodes\n" +
		"  ✗ domains: Custom domains must use Cloudflare for SaaS mode: shop.example.com\n" +
		"hint: fix these, then retry; `roundhouse runtime` lists every rule the service fails\n"
	if r.stderr != want {
		t.Errorf("stderr =\n%s\nwant\n%s", r.stderr, want)
	}

	r = h.expect(exitcode.Invalid, "", "runtime", "set", "cloudflare", "--yes", "--json")
	var body struct {
		Error struct {
			Code    string            `json:"code"`
			Details []api.ErrorDetail `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(r.stderr), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "provider_ineligible" || len(body.Error.Details) != 2 || body.Error.Details[0].Code != "volume" {
		t.Errorf("--json error = %+v", body)
	}
}

func TestRuntimeSetNotConfigured(t *testing.T) {
	h := newHarness(t)
	h.link()
	h.fake.SetCloudflare(apitest.APIServiceID, apitest.ProductionID, api.CloudflareStatus{
		Provider: api.ProviderNodes, Eligibility: []api.EligibilityFailure{}, Deployments: []api.CloudflareDeployment{},
	})
	r := h.expect(exitcode.Unavailable, "", "runtime", "set", "cloudflare", "--yes")
	contains(t, r.stderr, "Cloudflare Containers are not set up on this control plane")
	if n := patchCount(h); n != 0 {
		t.Errorf("%d PATCHes", n)
	}
}

func TestRuntimeSetValidatesFlags(t *testing.T) {
	h := newHarness(t)
	h.link()
	for _, tc := range []struct {
		args []string
		msg  string
	}{
		{[]string{"aws"}, `unknown provider "aws"; use nodes or cloudflare`},
		{[]string{"cloudflare", "--instance-type", "huge"}, `unknown instance type "huge"; use one of lite, basic, standard-1, standard-2, standard-3, standard-4`},
		{[]string{"cloudflare", "--max-instances", "0"}, "--max-instances must be between 1 and 100"},
		{[]string{"cloudflare", "--max-instances", "101"}, "--max-instances must be between 1 and 100"},
		{[]string{"cloudflare", "--sleep-after", "30s"}, "30s is outside 1m to 24h"},
		{[]string{"cloudflare", "--sleep-after", "25h"}, "25h is outside 1m to 24h"},
		{[]string{"cloudflare", "--sleep-after", "10 minutes"}, "invalid duration"},
		{[]string{"cloudflare", "--region", ""}, "is not a region code"},
		{[]string{"cloudflare", "--region", "e am"}, "is not a region code"},
		{[]string{"nodes", "--max-instances", "3"}, "--max-instances is only for cloudflare"},
		{[]string{"cloudflare", "api", "extra"}, "takes nodes or cloudflare and an optional service"},
		{[]string{}, "takes nodes or cloudflare and an optional service"},
	} {
		r := h.expect(exitcode.Usage, "", append([]string{"runtime", "set"}, tc.args...)...)
		contains(t, r.stderr, tc.msg)
	}
	if n := patchCount(h); n != 0 {
		t.Errorf("%d PATCHes for invalid flags", n)
	}
	h.ok("", "runtime", "set", "cloudflare", "api", "--sleep-after", "24h", "--max-instances", "100", "--yes")
}

func TestParseSleepAfter(t *testing.T) {
	for in, ok := range map[string]bool{"1m": true, "60s": true, "90s": true, "24h": true, "1440m": true, "59s": false, "86401s": false, "0m": false, "10": false, "1.5h": false} {
		if _, err := api.ParseSleepAfter(in); (err == nil) != ok {
			t.Errorf("ParseSleepAfter(%q) err = %v, want ok=%v", in, err, ok)
		}
	}
}
