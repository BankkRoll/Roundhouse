import { describe, expect, it } from "vitest";
import {
  ariCertId,
  computeRenewAfter,
  parseCertificateChain,
  sha256Hex,
  splitPemChain,
} from "../src/lib/acme/index";
// Generated offline with OpenSSL: an EC P-256 "Test R11" CA and a leaf with
// a high-bit serial, three SANs and an authority key identifier.
import chainPem from "./fixtures/acme/chain.pem?raw";

const DAY = 86_400_000;

describe("parseCertificateChain", () => {
  it("reads the leaf of a real-world-like chain", () => {
    expect(parseCertificateChain(chainPem)).toEqual({
      notBefore: Date.UTC(2026, 9, 1),
      notAfter: Date.UTC(2026, 11, 30),
      serialHex: "87a1b2c3d4e5f60718293a4b5c6d7e8f90",
      issuer: "CN=Test R11,O=Roundhouse Test,C=US",
      subjectAltNames: ["shop.example.com", "*.example.com", "192.0.2.1"],
      authorityKeyId: "ae971486a32efa1c752bc8f181a4063448bf949a",
    });
  });

  it("rejects input without a certificate", () => {
    expect(() => parseCertificateChain("")).toThrow(/no certificate/);
    expect(() =>
      parseCertificateChain("-----BEGIN CERTIFICATE-----\nMAA=\n-----END CERTIFICATE-----"),
    ).toThrow();
  });
});

describe("splitPemChain", () => {
  it("canonicalises line endings and wrapping so hashes are stable", async () => {
    const blocks = splitPemChain(chainPem);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) expect(block.endsWith("-----END CERTIFICATE-----\n")).toBe(true);
    const canonical = blocks.join("");
    expect(canonical).toBe(chainPem.replace(/\r\n/g, "\n"));

    const messy = `\r\n${chainPem.replace(/\n/g, "\r\n")}\r\n\r\n`;
    expect(splitPemChain(messy).join("")).toBe(canonical);
    expect(await sha256Hex(splitPemChain(messy).join(""))).toBe(await sha256Hex(canonical));
  });
});

describe("ariCertId", () => {
  it("matches the RFC 9773 §4.1 example", () => {
    expect(
      ariCertId({
        authorityKeyId: "69885b6b87464041e1b37b847ba0ae2cde01c8d4",
        serialHex: "87654321",
      }),
    ).toBe("aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE");
  });

  it("keeps the DER content octets of the fixture's serial", () => {
    expect(ariCertId(parseCertificateChain(chainPem))).toBe(
      "rpcUhqMu-hx1K8jxgaQGNEi_lJo.AIehssPU5fYHGCk6S1xtfo-Q",
    );
  });

  it("needs no padding for a low-bit serial and returns null without an AKI", () => {
    expect(ariCertId({ authorityKeyId: "01", serialHex: "7f" })).toBe("AQ.fw");
    expect(ariCertId({ authorityKeyId: "01", serialHex: "123" })).toBe("AQ.ASM");
    expect(ariCertId({ authorityKeyId: null, serialHex: "01" })).toBeNull();
  });
});

describe("computeRenewAfter", () => {
  const issued = Date.UTC(2027, 0, 1);

  it.each([45, 64, 90])("falls back to one third remaining for a %i-day lifetime", (days) => {
    const leaf = { notBefore: issued, notAfter: issued + days * DAY };
    expect(computeRenewAfter(leaf, null)).toBe(Math.floor(issued + ((days * 2) / 3) * DAY));
  });

  it("picks a uniform point inside the ARI window", () => {
    const leaf = { notBefore: issued, notAfter: issued + 90 * DAY };
    const ari = { start: issued + 60 * DAY, end: issued + 62 * DAY };
    expect(computeRenewAfter(leaf, ari, () => 0)).toBe(ari.start);
    expect(computeRenewAfter(leaf, ari, () => 0.5)).toBe(issued + 61 * DAY);
    expect(computeRenewAfter(leaf, ari, () => 0.999999)).toBeLessThan(ari.end);
    for (let i = 0; i < 100; i++) {
      const at = computeRenewAfter(leaf, ari);
      expect(at).toBeGreaterThanOrEqual(ari.start);
      expect(at).toBeLessThan(ari.end);
    }
  });

  it("honours an ARI window in the past (renew now) and ignores invalid windows", () => {
    const leaf = { notBefore: issued, notAfter: issued + 90 * DAY };
    const past = { start: issued - 2 * DAY, end: issued - DAY };
    expect(computeRenewAfter(leaf, past, () => 0)).toBe(past.start);
    const fallback = issued + 60 * DAY;
    expect(computeRenewAfter(leaf, { start: 10, end: 10 })).toBe(fallback);
    expect(computeRenewAfter(leaf, { start: 10, end: 5 })).toBe(fallback);
    expect(computeRenewAfter(leaf, { start: Number.NaN, end: 5 })).toBe(fallback);
  });
});
