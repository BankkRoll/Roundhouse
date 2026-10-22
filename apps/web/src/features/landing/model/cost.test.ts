import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_MONTHLY,
  compareCosts,
  DEFAULT_FLEET,
  estimatePaas,
  estimateSelfHost,
  fleetFits,
  formatUsd,
  MINUTES_PER_MONTH,
  type PaasRates,
  RAILWAY_RATES,
  type Server,
} from "./cost";

const RATES: PaasRates = {
  asOf: "2026-01-01",
  source: "test",
  perVcpuMinute: 0.001,
  perGbRamMinute: 0.0005,
  perGbEgress: 0.1,
  perGbVolumeMinute: 0.00001,
  planName: "Test",
  planFee: 20,
  includedUsage: 20,
};

const SERVERS: Server[] = [
  { id: "a", name: "a", monthlyPrice: 40, vcpu: 8, ramGb: 32 },
  { id: "b", name: "b", monthlyPrice: 0, vcpu: 4, ramGb: 16 },
];

describe("estimatePaas", () => {
  it("bills each resource per minute over an average month", () => {
    const result = estimatePaas({ vcpu: 2, ramGb: 4, egressGb: 100, volumeGb: 10 }, RATES);
    expect(result.cpu).toBeCloseTo(2 * 0.001 * MINUTES_PER_MONTH);
    expect(result.ram).toBeCloseTo(4 * 0.0005 * MINUTES_PER_MONTH);
    expect(result.egress).toBeCloseTo(10);
    expect(result.volume).toBeCloseTo(10 * 0.00001 * MINUTES_PER_MONTH);
    expect(result.usage).toBeCloseTo(result.cpu + result.ram + result.egress + result.volume);
  });

  it("charges the plan fee and only usage beyond the included credit", () => {
    expect(estimatePaas({ vcpu: 0, ramGb: 0, egressGb: 100, volumeGb: 0 }, RATES).total).toBe(20);
    expect(estimatePaas({ vcpu: 0, ramGb: 0, egressGb: 300, volumeGb: 0 }, RATES).total).toBe(30);
  });

  it("treats negative and non-finite inputs as zero", () => {
    const result = estimatePaas({ vcpu: -1, ramGb: Number.NaN, egressGb: -5, volumeGb: 0 }, RATES);
    expect(result.usage).toBe(0);
    expect(result.total).toBe(20);
  });

  it("matches the published monthly equivalents of the default rates", () => {
    const oneCpu = estimatePaas({ vcpu: 1, ramGb: 0, egressGb: 0, volumeGb: 0 });
    const oneGb = estimatePaas({ vcpu: 0, ramGb: 1, egressGb: 0, volumeGb: 0 });
    const tenGbVolume = estimatePaas({ vcpu: 0, ramGb: 0, egressGb: 0, volumeGb: 10 });
    // Published as $20 / vCPU / month, $10 / GB / month and $0.15 / GB / month.
    expect(oneCpu.cpu).toBeGreaterThan(19.5);
    expect(oneCpu.cpu).toBeLessThan(20.5);
    expect(oneGb.ram).toBeGreaterThan(9.8);
    expect(oneGb.ram).toBeLessThan(10.3);
    expect(tenGbVolume.volume).toBeCloseTo(1.52, 1);
    expect(RAILWAY_RATES.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("estimateSelfHost", () => {
  it("adds server prices and the Cloudflare plan", () => {
    expect(estimateSelfHost(SERVERS)).toEqual({
      servers: 40,
      cloudflare: CLOUDFLARE_MONTHLY,
      total: 40 + CLOUDFLARE_MONTHLY,
    });
  });

  it("accepts an override for Cloudflare", () => {
    expect(estimateSelfHost([], 0).total).toBe(0);
  });
});

describe("fleetFits", () => {
  it("compares total vCPU and RAM", () => {
    expect(fleetFits({ vcpu: 12, ramGb: 48, egressGb: 0, volumeGb: 0 }, SERVERS)).toBe(true);
    expect(fleetFits({ vcpu: 13, ramGb: 8, egressGb: 0, volumeGb: 0 }, SERVERS)).toBe(false);
    expect(fleetFits({ vcpu: 1, ramGb: 49, egressGb: 0, volumeGb: 0 }, SERVERS)).toBe(false);
  });
});

describe("compareCosts", () => {
  it("reports the difference in favour of self-hosting as positive", () => {
    const result = compareCosts({ vcpu: 4, ramGb: 8, egressGb: 0, volumeGb: 0 }, SERVERS, RATES, 5);
    expect(result.difference).toBeCloseTo(result.paas.total - 45);
    expect(result.difference).toBeGreaterThan(0);
    expect(result.fits).toBe(true);
  });

  it("goes negative when the servers cost more than the usage", () => {
    const result = compareCosts({ vcpu: 0, ramGb: 0, egressGb: 0, volumeGb: 0 }, SERVERS, RATES);
    expect(result.difference).toBe(20 - 45);
  });
});

describe("formatUsd", () => {
  it("shows cents for small amounts and whole dollars for large ones", () => {
    expect(formatUsd(4.2)).toBe("$4.20");
    expect(formatUsd(1240.4)).toBe("$1,240");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
  });
});

describe("DEFAULT_FLEET", () => {
  it("is two 8 vCPU / 16 GB servers that hold the default workload", () => {
    expect(DEFAULT_FLEET).toHaveLength(2);
    expect(estimateSelfHost(DEFAULT_FLEET).total).toBe(60 + CLOUDFLARE_MONTHLY);
    expect(fleetFits({ vcpu: 3, ramGb: 12, egressGb: 300, volumeGb: 50 }, DEFAULT_FLEET)).toBe(
      true,
    );
  });
});
