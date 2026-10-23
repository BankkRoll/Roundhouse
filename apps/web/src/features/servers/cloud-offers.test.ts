import { describe, expect, it } from "vitest";
import type { NodeProvision, ProviderOffer } from "../../lib/api/providers-types";
import { MOCK_OFFERS, mockRecommendations } from "../../mocks/providers-db";
import {
  defaultOffer,
  formatMemoryMib,
  formatMonthlyPrice,
  groupOffersByPlan,
  nodeNameError,
  pendingProvisions,
  provisionProgress,
  provisionStepLabel,
} from "./cloud-offers";

const HETZNER = MOCK_OFFERS.hetzner;

function run(overrides: Partial<NodeProvision>): NodeProvision {
  return {
    id: "npr_1",
    provider: "hetzner",
    name: "web-1",
    plan: "cx22",
    region: "fsn1",
    builder: false,
    status: "queued",
    step: null,
    failure_reason: null,
    failure_message: null,
    server_id: null,
    ipv4: null,
    ipv6: null,
    node_id: null,
    cancel_requested_at: null,
    estimated_monthly_cost: null,
    created_at: 1,
    updated_at: 1,
    finished_at: null,
    ...overrides,
  };
}

describe("cloud offers", () => {
  it("groups offers into plans, recommended first, then by price", () => {
    const plans = groupOffersByPlan(HETZNER, mockRecommendations(HETZNER, "node"));
    expect(plans.map((plan) => plan.plan)).toEqual(["cx22", "cx32", "cax11", "cx42"]);
    expect(plans[0]).toMatchObject({
      recommendation: "Cheapest plan that fits",
      vcpus: 2,
      memoryMib: 4096,
    });
    expect(plans[0]?.offers.map((offer) => offer.region)).toEqual(["fsn1", "nbg1", "hel1"]);
    expect(plans[2]?.recommendation).toBeNull();
  });

  it("defaults to the first listed recommendation, else the cheapest offer", () => {
    expect(defaultOffer(HETZNER, mockRecommendations(HETZNER, "node"))?.id).toBe("cx22@fsn1");
    expect(defaultOffer(HETZNER, [{ offer_id: "gone@fsn1", reason: "" }])?.id).toBe("cax11@fsn1");
    expect(defaultOffer([] as ProviderOffer[], [])).toBeUndefined();
  });

  it("formats prices in the offer's currency and sizes as providers advertise them", () => {
    expect(formatMonthlyPrice(451, "EUR")).toBe("€4.51/mo");
    expect(formatMonthlyPrice(2400, "USD")).toBe("$24.00/mo");
    expect(formatMonthlyPrice(100, "???")).toBe("1.00 ???/mo");
    expect(formatMemoryMib(512)).toBe("512 MB");
    expect(formatMemoryMib(4096)).toBe("4 GB");
    expect(formatMemoryMib(1536)).toBe("1.5 GB");
  });

  it("validates names with the API's rule", () => {
    expect(nodeNameError("web-1")).toBeNull();
    expect(nodeNameError("")).toBe("Enter a name.");
    for (const bad of ["-web", "web-", "Web", "web_1", "a".repeat(64)]) {
      expect(nodeNameError(bad)).toMatch(/lowercase letters/);
    }
  });

  it("labels adapter steps, falling back to the step id", () => {
    expect(provisionStepLabel("create_server")).toBe("Creating the server");
    expect(provisionStepLabel("attach_volume")).toBe("attach volume");
    expect(provisionStepLabel(null)).toBeNull();
  });

  it("maps statuses onto the three stages", () => {
    expect(provisionProgress(run({ status: "queued" }))).toEqual({ current: 0, failed: false });
    expect(provisionProgress(run({ status: "booting" }))).toEqual({ current: 1, failed: false });
    expect(provisionProgress(run({ status: "joined" }))).toEqual({ current: 3, failed: false });
    expect(provisionProgress(run({ status: "failed", step: "create_server" }))).toEqual({
      current: 0,
      failed: true,
    });
    expect(provisionProgress(run({ status: "cleanup_failed", server_id: "1" }))).toEqual({
      current: 1,
      failed: true,
    });
  });

  it("lists in-flight and leaked runs whose node isn't listed yet", () => {
    const runs = [
      run({ id: "a", name: "a", status: "creating" }),
      run({ id: "b", name: "b", status: "joined", node_id: "node_b" }),
      run({ id: "c", name: "c", status: "failed" }),
      run({ id: "d", name: "d", status: "cleanup_failed" }),
      run({ id: "e", name: "e", status: "booting", node_id: "node_e" }),
    ];
    const nodes = [{ id: "node_e", name: "e" }];
    expect(pendingProvisions(runs, nodes).map((entry) => entry.id)).toEqual(["a", "d"]);
  });
});
