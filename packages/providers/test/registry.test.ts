import { describe, expect, it } from "vitest";
import * as pkg from "../src";
import { createProvider, isProviderId, PROVIDER_IDS, PROVIDERS } from "../src/provider";

describe("registry", () => {
  it("describes every provider with a token link and least-privilege scopes", () => {
    expect(Object.keys(PROVIDERS)).toEqual([...PROVIDER_IDS]);
    for (const id of PROVIDER_IDS) {
      const info = PROVIDERS[id];
      expect(info.id).toBe(id);
      expect(info.tokenUrl).toMatch(/^https:\/\//);
      expect(info.tokenDocsUrl).toMatch(/^https:\/\//);
      expect(info.apiDocsUrl).toMatch(/^https:\/\//);
      expect(info.requiredScopes.length).toBeGreaterThan(0);
      expect(info.tokenHint.length).toBeGreaterThan(20);
    }
  });

  it("creates each provider by ID behind the same interface", () => {
    for (const id of PROVIDER_IDS) {
      const p = createProvider(id, { token: "t0ken" });
      expect(p.id).toBe(id);
      expect(p.displayName).toBe(PROVIDERS[id].displayName);
      for (const m of [
        "validateToken",
        "listOffers",
        "listImages",
        "provision",
        "deprovision",
        "getServer",
        "listManaged",
      ] as const) {
        expect(typeof p[m]).toBe("function");
      }
    }
  });

  it("rejects an empty or malformed token before any request", () => {
    for (const id of PROVIDER_IDS) {
      expect(() => createProvider(id, { token: " " })).toThrow(TypeError);
      expect(() => createProvider(id, { token: "a b" })).toThrow(TypeError);
    }
    expect(() => createProvider("aws" as never, { token: "t" })).toThrow(TypeError);
  });

  it("recognises provider IDs", () => {
    expect(isProviderId("vultr")).toBe(true);
    expect(isProviderId("aws")).toBe(false);
    expect(isProviderId("toString")).toBe(false);
  });

  it("exports the cloud-init builder and errors from the package root", () => {
    expect(typeof pkg.buildUserData).toBe("function");
    expect(typeof pkg.ProvisionError).toBe("function");
    expect(typeof pkg.recommend).toBe("function");
  });
});
