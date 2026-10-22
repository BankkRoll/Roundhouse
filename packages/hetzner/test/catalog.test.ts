import { describe, expect, it } from "vitest";
import {
  buildOffers,
  decimalToCents,
  filterSupportedImages,
  listOffers,
  listSupportedImages,
  recommend,
} from "../src/catalog";
import { IMAGES, image, LOCATIONS, SERVER_TYPES } from "./fixtures";
import { harness } from "./helpers";

const NOW = Date.parse("2026-10-22T00:00:00Z");
const EUR = { currency: "EUR" };

describe("decimalToCents", () => {
  it("rounds half up without floating point error", () => {
    expect(decimalToCents("4.1500")).toBe(415);
    expect(decimalToCents("1.0050")).toBe(101);
    expect(decimalToCents("1.0049")).toBe(100);
    expect(decimalToCents("12")).toBe(1200);
    expect(decimalToCents("0.9950")).toBe(100);
  });

  it("rejects non-decimals", () => {
    expect(() => decimalToCents("-1")).toThrow(RangeError);
    expect(() => decimalToCents("abc")).toThrow(RangeError);
  });
});

describe("buildOffers", () => {
  const offers = buildOffers(SERVER_TYPES, LOCATIONS, EUR, { now: NOW });
  const keys = offers.map((o) => `${o.serverType}@${o.location}`);

  it("joins types with per-location prices, sorted by gross monthly price", () => {
    expect(keys).toEqual([
      "cx11@fsn1",
      "cx23@fsn1",
      "cx23@nbg1",
      "cax11@fsn1",
      "cx33@fsn1",
      "cx33@nbg1",
      "cpx22@fsn1",
      "cpx22@ash",
      "ccx13@fsn1",
      "ccx13@ash",
    ]);
  });

  it("maps fields, architecture, and prices", () => {
    const cx23 = offers.find((o) => o.serverType === "cx23" && o.location === "nbg1")!;
    expect(cx23).toMatchObject({
      serverTypeId: 101,
      vcpus: 2,
      memoryGb: 4,
      diskGb: 40,
      architecture: "amd64",
      cpuType: "shared",
      category: "Shared vCPU",
      city: "Nuremberg",
      country: "DE",
      networkZone: "eu-central",
      currency: "EUR",
      monthlyGrossCents: 415,
      includedTrafficTb: 20,
      recommended: true,
      deprecated: false,
      unavailableAfter: null,
    });
    expect(cx23.priceMonthly.gross).toBe("4.1500");
    expect(offers.find((o) => o.serverType === "cax11")!.architecture).toBe("arm64");
  });

  it("excludes temporarily unavailable, unpriced, and unknown locations", () => {
    expect(keys).not.toContain("cx23@hel1");
    expect(keys).not.toContain("cpx22@nbg1");
    expect(keys.some((k) => k.startsWith("cx43@"))).toBe(false);
  });

  it("excludes deprecated types by default, and past unavailable_after always", () => {
    expect(keys.some((k) => k.startsWith("cx22@"))).toBe(false);
    const all = buildOffers(SERVER_TYPES, LOCATIONS, EUR, { now: NOW, includeDeprecated: true });
    const cx22 = all.filter((o) => o.serverType === "cx22");
    expect(cx22.map((o) => o.location)).toEqual(["fsn1"]);
    expect(cx22[0]).toMatchObject({ deprecated: true, unavailableAfter: "2099-01-01T00:00:00Z" });
  });

  it("honours the legacy type-level deprecated flag", () => {
    const legacy = structuredClone(SERVER_TYPES.filter((t) => t.name === "cx33"));
    legacy[0]!.deprecated = true;
    expect(buildOffers(legacy, LOCATIONS, EUR, { now: NOW })).toEqual([]);
  });
});

describe("listOffers", () => {
  it("reads types, locations, and the currency live from the API", async () => {
    const { fake, client } = harness();
    const offers = await listOffers(client, { now: NOW });
    expect(offers).toHaveLength(10);
    expect(offers.every((o) => o.currency === "EUR")).toBe(true);
    expect(new Set(fake.requests.map((r) => r.path))).toEqual(
      new Set(["/server_types", "/locations", "/pricing"]),
    );
  });

  it("reflects price changes without code changes", async () => {
    const { fake, client } = harness();
    fake.serverTypes = fake.serverTypes.filter((t) => t.name === "cx23");
    fake.serverTypes[0]!.prices[0]!.price_monthly.gross = "5.0000";
    const offers = await listOffers(client, { now: NOW });
    expect(offers.find((o) => o.location === "fsn1")!.monthlyGrossCents).toBe(500);
  });
});

describe("recommend", () => {
  const offers = buildOffers(SERVER_TYPES, LOCATIONS, EUR, { now: NOW });
  const names = (w: Parameters<typeof recommend>[1]) =>
    recommend(offers, w).map((r) => r.offer.serverType);

  it("suggests cheapest, more headroom, and dedicated for an app node", () => {
    const recs = recommend(offers, {});
    expect(recs.map((r) => [r.offer.serverType, r.reason])).toEqual([
      ["cx23", "Cheapest that fits"],
      ["cx33", "More headroom"],
      ["ccx13", "Dedicated vCPU for steady load"],
    ]);
    // Hetzner's recommended location wins over an equally priced one.
    expect(recs[0]!.offer.location).toBe("nbg1");
  });

  it("requires more disk for builders", () => {
    expect(names({ role: "builder" })).toEqual(["cx33", "ccx13", "cpx22"]);
  });

  it("filters by architecture, location order, budget, and cpu type", () => {
    expect(names({ architecture: "arm64" })).toEqual(["cax11"]);
    expect(names({ locations: ["ash"] })).toEqual(["cpx22", "ccx13"]);
    expect(recommend(offers, { locations: ["fsn1", "nbg1"] })[0]!.offer.location).toBe("fsn1");
    expect(names({ maxMonthlyGrossCents: 500 })).toEqual(["cx23", "cax11"]);
    expect(names({ cpuType: "dedicated" })).toEqual(["ccx13"]);
    expect(names({ networkZone: "us-east" })).toEqual(["cpx22", "ccx13"]);
  });

  it("honours limit and explicit minimums, and never suggests deprecated offers", () => {
    expect(names({ limit: 1 })).toEqual(["cx23"]);
    expect(names({ minVcpus: 1, minMemoryGb: 1, minDiskGb: 10 })[0]).toBe("cx11");
    const withDeprecated = buildOffers(SERVER_TYPES, LOCATIONS, EUR, {
      now: NOW,
      includeDeprecated: true,
    });
    expect(recommend(withDeprecated, { limit: 10 }).some((r) => r.offer.deprecated)).toBe(false);
  });

  it("returns nothing when nothing fits", () => {
    expect(recommend(offers, { minMemoryGb: 512 })).toEqual([]);
  });
});

describe("supported images", () => {
  it("keeps Ubuntu 22.04/24.04 and Debian 12 for both architectures", () => {
    const imgs = filterSupportedImages(IMAGES, NOW);
    expect(imgs.map((i) => `${i.name}/${i.architecture}`)).toEqual([
      "ubuntu-24.04/amd64",
      "ubuntu-24.04/arm64",
      "ubuntu-22.04/amd64",
      "ubuntu-22.04/arm64",
      "debian-12/amd64",
      "debian-12/arm64",
    ]);
  });

  it("flags deprecated images and drops ones past unavailable_after", () => {
    const imgs = filterSupportedImages(
      [
        image(1, "ubuntu-22.04", "x86", {
          deprecation: {
            announced: "2026-01-01T00:00:00Z",
            unavailable_after: "2099-01-01T00:00:00Z",
          },
        }),
        image(2, "ubuntu-22.04", "arm", {
          deprecation: {
            announced: "2025-01-01T00:00:00Z",
            unavailable_after: "2026-01-01T00:00:00Z",
          },
        }),
        image(3, "debian-12", "x86", { status: "unavailable" }),
      ],
      NOW,
    );
    expect(imgs).toEqual([
      {
        id: 1,
        name: "ubuntu-22.04",
        description: "ubuntu-22.04",
        architecture: "amd64",
        deprecated: true,
      },
    ]);
  });

  it("queries system images by architecture", async () => {
    const { fake, client } = harness();
    const imgs = await listSupportedImages(client, { architecture: "arm64" });
    expect(imgs.every((i) => i.architecture === "arm64")).toBe(true);
    expect(fake.requests[0]!.query.get("architecture")).toBe("arm");
    expect(fake.requests[0]!.query.get("type")).toBe("system");
  });
});
