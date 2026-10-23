import { describe, expect, it } from "vitest";
import { buildDigitalOceanOffers } from "../src/digitalocean";
import { buildHetznerOffers } from "../src/hetzner";
import { recommend, WORKLOAD_DEFAULTS } from "../src/recommend";
import { REGIONS as DO_REGIONS, SIZES } from "./fixtures/digitalocean";
import { LOCATIONS, SERVER_TYPES } from "./fixtures/hetzner";

const NOW = Date.parse("2026-10-22T00:00:00Z");
const offers = buildHetznerOffers(SERVER_TYPES, LOCATIONS, { currency: "EUR" }, NOW);
const plans = (w: Parameters<typeof recommend>[1]) => recommend(offers, w).map((r) => r.offer.plan);

describe("recommend", () => {
  it("suggests cheapest, more headroom, and dedicated for a node", () => {
    const recs = recommend(offers, {});
    expect(recs.map((r) => [r.offer.plan, r.reason])).toEqual([
      ["cx23", "Cheapest that fits"],
      ["cx33", "More headroom"],
      ["ccx13", "Dedicated vCPU for steady load"],
    ]);
    // The provider's recommended region wins over an equally priced one.
    expect(recs[0]!.offer.region).toBe("nbg1");
  });

  it("requires more disk for builders", () => {
    expect(WORKLOAD_DEFAULTS.builder.minDiskGb).toBeGreaterThan(WORKLOAD_DEFAULTS.node.minDiskGb);
    expect(plans({ role: "builder" })).toEqual(["cx33", "ccx13", "cpx22"]);
  });

  it("filters by architecture, region order, budget, and dedicated vCPUs", () => {
    expect(plans({ arch: "arm64" })).toEqual(["cax11"]);
    expect(plans({ regions: ["ash"] })).toEqual(["cpx22", "ccx13"]);
    expect(recommend(offers, { regions: ["fsn1", "nbg1"] })[0]!.offer.region).toBe("fsn1");
    expect(plans({ maxMonthlyCents: 500 })).toEqual(["cx23", "cax11"]);
    expect(plans({ dedicated: true })).toEqual(["ccx13"]);
    expect(plans({ dedicated: false, limit: 10 })).not.toContain("ccx13");
  });

  it("honours limit and explicit minimums, and never suggests deprecated offers", () => {
    expect(plans({ limit: 1 })).toEqual(["cx23"]);
    expect(plans({ minVcpus: 1, minMemoryMib: 1024, minDiskGb: 10 })[0]).toBe("cx11");
    expect(offers.some((o) => o.deprecated)).toBe(true);
    expect(recommend(offers, { limit: 10 }).some((r) => r.offer.deprecated)).toBe(false);
  });

  it("returns nothing when nothing fits", () => {
    expect(recommend(offers, { minMemoryMib: 512 * 1024 })).toEqual([]);
    expect(recommend([], {})).toEqual([]);
  });

  it("works on any provider's offers", () => {
    const doOffers = buildDigitalOceanOffers(SIZES, DO_REGIONS);
    const recs = recommend(doOffers, { minDiskGb: 25 });
    expect(recs.map((r) => [r.offer.plan, r.reason])).toEqual([
      ["s-2vcpu-4gb", "Cheapest that fits"],
      ["g-2vcpu-8gb", "More headroom"],
    ]);
    expect(recs.every((r) => r.offer.provider === "digitalocean")).toBe(true);
  });
});
