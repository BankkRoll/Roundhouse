import { describe, expect, it } from "vitest";
import {
  decimalToCents,
  isPast,
  isSupportedImage,
  ROLE_FLOORS,
  SUPPORTED_IMAGES,
} from "../src/catalog";
import { ProvisionError } from "../src/errors";
import type { Offer } from "../src/provider";
import { filterOffers } from "../src/provision";
import { normalizeSshPublicKey, sameSshKey, sshKeyName } from "../src/ssh-keys";
import { SSH_KEY } from "./helpers";

describe("decimalToCents", () => {
  it("rounds half up without floating point error", () => {
    expect(decimalToCents("4.1500")).toBe(415);
    expect(decimalToCents("1.0050")).toBe(101);
    expect(decimalToCents("1.0049")).toBe(100);
    expect(decimalToCents("12")).toBe(1200);
    expect(decimalToCents("0.9950")).toBe(100);
  });

  it("accepts JSON numbers, as DigitalOcean, Vultr, and Linode send them", () => {
    expect(decimalToCents(5)).toBe(500);
    expect(decimalToCents(7.5)).toBe(750);
    expect(decimalToCents(33.6)).toBe(3360);
    expect(decimalToCents(0.00743999984115362)).toBe(1);
  });

  it("rejects negative and non-decimal amounts", () => {
    expect(() => decimalToCents("-1")).toThrow(RangeError);
    expect(() => decimalToCents("abc")).toThrow(RangeError);
    expect(() => decimalToCents(-1)).toThrow(RangeError);
    expect(() => decimalToCents(Number.NaN)).toThrow(RangeError);
  });
});

describe("supported images and floors", () => {
  it("matches the installer's supported OS list", () => {
    expect(SUPPORTED_IMAGES).toEqual(["ubuntu-24.04", "ubuntu-22.04", "debian-12"]);
    expect(isSupportedImage("debian-12")).toBe(true);
    expect(isSupportedImage("debian-11")).toBe(false);
  });

  it("keeps the builder disk floor above the node's", () => {
    expect(ROLE_FLOORS.builder.diskGb).toBe(20);
    expect(ROLE_FLOORS.node).toEqual({ vcpus: 1, memoryMib: 1024, diskGb: 10 });
  });

  it("compares RFC 3339 times", () => {
    expect(isPast("2026-01-01T00:00:00Z", Date.parse("2026-06-01T00:00:00Z"))).toBe(true);
    expect(isPast("2099-01-01T00:00:00Z", Date.parse("2026-06-01T00:00:00Z"))).toBe(false);
    expect(isPast(null, 0)).toBe(false);
    expect(isPast("garbage", 0)).toBe(false);
  });
});

describe("filterOffers", () => {
  const offer = (o: Partial<Offer>): Offer => {
    const merged: Offer = {
      provider: "hetzner",
      id: "",
      plan: "p",
      description: "",
      category: null,
      region: "r",
      regionName: "R",
      country: null,
      vcpus: 2,
      memoryMib: 4096,
      diskGb: 40,
      arch: "amd64",
      dedicated: false,
      price: { monthlyCents: 500, currency: "EUR" },
      includedTrafficTb: null,
      recommended: false,
      deprecated: false,
      unavailableAfter: null,
      ...o,
    };
    return { ...merged, id: `${merged.plan}@${merged.region}` };
  };
  const all = [
    offer({ plan: "b", region: "x", price: { monthlyCents: 900, currency: "EUR" } }),
    offer({ plan: "a", region: "y" }),
    offer({ plan: "a", region: "x" }),
    offer({ plan: "tiny", memoryMib: 512 }),
    offer({ plan: "small-disk", diskGb: 15 }),
    offer({ plan: "old", deprecated: true }),
  ];

  it("applies the role floor, hides deprecated offers, and sorts by price, plan, region", () => {
    expect(filterOffers(all).map((o) => o.id)).toEqual(["a@x", "a@y", "small-disk@r", "b@x"]);
    expect(filterOffers(all, { role: "builder" }).map((o) => o.plan)).not.toContain("small-disk");
    expect(filterOffers(all, { includeDeprecated: true }).map((o) => o.plan)).toContain("old");
    expect(filterOffers(all, { region: "y" }).map((o) => o.id)).toEqual(["a@y"]);
  });
});

describe("SSH keys", () => {
  it("normalises to type and body, dropping the comment and whitespace", () => {
    const [type, body] = SSH_KEY.split(" ");
    expect(normalizeSshPublicKey(`  ${SSH_KEY}  `)).toBe(`${type} ${body}`);
  });

  it("rejects malformed and multi-line keys", () => {
    for (const bad of [
      "",
      "ssh-ed25519",
      "ssh-dss AAAAB3NzaC1kc3MAAACBAP",
      `${SSH_KEY}\n${SSH_KEY}`,
      "ssh-ed25519 not*base64",
    ]) {
      expect(() => normalizeSshPublicKey(bad)).toThrow(ProvisionError);
    }
  });

  it("matches stored keys whatever their comment, and names keys deterministically", async () => {
    const n = normalizeSshPublicKey(SSH_KEY);
    expect(sameSshKey(SSH_KEY.replace("ops@laptop", "x"), n)).toBe(true);
    expect(sameSshKey("garbage", n)).toBe(false);
    const name = await sshKeyName(n);
    expect(name).toMatch(/^roundhouse-[0-9a-f]{12}$/);
    expect(await sshKeyName(normalizeSshPublicKey(SSH_KEY.replace("ops@laptop", "x")))).toBe(name);
  });
});
