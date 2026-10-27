import { describe, expect, it } from "vitest";
import {
  type CloudflareEligibilityInput,
  cloudflareEligibility,
  instanceTypeFor,
  parseSleepAfter,
} from "./cloudflare";
import { serviceProvider } from "./service-config";

const eligible: CloudflareEligibilityInput = {
  kind: "app",
  port: 8080,
  resources: { cpu_millis: 500, memory_mb: 512 },
  hasVolume: false,
  hasTcpProxy: false,
  customDomains: [],
  imageArchitectures: ["amd64", "arm64"],
};

describe("cloudflareEligibility", () => {
  it("passes a stateless HTTP app", () => {
    expect(cloudflareEligibility(eligible)).toEqual([]);
    expect(cloudflareEligibility({ ...eligible, imageArchitectures: null })).toEqual([]);
    expect(
      cloudflareEligibility({
        ...eligible,
        customDomains: [{ hostname: "shop.example.com", saas: true }],
      }),
    ).toEqual([]);
  });

  it("names every failing rule", () => {
    const failures = cloudflareEligibility({
      kind: "database",
      port: null,
      resources: { cpu_millis: 8000, memory_mb: 512 },
      hasVolume: true,
      hasTcpProxy: true,
      customDomains: [{ hostname: "api.example.com", saas: false }],
      imageArchitectures: ["arm64"],
    });
    expect(failures.map((f) => f.rule)).toEqual([
      "kind",
      "port",
      "volume",
      "tcp_proxy",
      "domains",
      "resources",
      "image_arch",
    ]);
    expect(failures.find((f) => f.rule === "domains")?.message).toContain("api.example.com");
  });

  it("checks a chosen instance type against resources", () => {
    expect(cloudflareEligibility({ ...eligible, instanceType: "lite" }).map((f) => f.rule)).toEqual(
      ["resources"],
    );
    expect(cloudflareEligibility({ ...eligible, instanceType: "standard-1" })).toEqual([]);
    expect(cloudflareEligibility({ ...eligible, instanceType: "huge" })[0]?.rule).toBe("resources");
  });
});

describe("instanceTypeFor", () => {
  it("picks the smallest type that fits", () => {
    expect(instanceTypeFor({ cpu_millis: 50, memory_mb: 128 })).toBe("lite");
    expect(instanceTypeFor({ cpu_millis: 250, memory_mb: 1024 })).toBe("basic");
    expect(instanceTypeFor({ cpu_millis: 1000, memory_mb: 512 })).toBe("standard-2");
    expect(instanceTypeFor({ cpu_millis: 4000, memory_mb: 12_288 })).toBe("standard-4");
    expect(instanceTypeFor({ cpu_millis: 4001, memory_mb: 512 })).toBeNull();
  });
});

describe("parseSleepAfter", () => {
  it("accepts 1 minute to 24 hours", () => {
    expect(parseSleepAfter("10m")).toBe(600);
    expect(parseSleepAfter("60s")).toBe(60);
    expect(parseSleepAfter("24h")).toBe(86_400);
    for (const bad of ["59s", "25h", "0m", "10", "1d", "10 m", "-1m", "010m"]) {
      expect(parseSleepAfter(bad), bad).toBeNull();
    }
  });
});

describe("serviceProvider", () => {
  it("defaults to nodes for configs from before providers", () => {
    expect(serviceProvider({})).toBe("nodes");
    expect(serviceProvider({ provider: "cloudflare" })).toBe("cloudflare");
  });
});
