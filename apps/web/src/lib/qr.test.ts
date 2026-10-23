/**
 * The QR encoder against an independent implementation (segno 1.6, generated once
 * into `qr.reference.json` as SHA-256 hashes of the module matrix, row by row as
 * `0`/`1` characters): every mask, byte mode with 8- and 16-bit lengths, several
 * blocks, UTF-8, and all four error correction levels.
 *
 * segno 1.6 pads a byte-aligned bit stream with a whole extra zero byte (ISO/IEC 18004
 * 7.4.10 asks for none); the reference was generated with that one function patched to
 * the standard. Implementations score masks slightly differently, so when the mask is
 * left to the encoder only the version is compared; any mask decodes the same.
 */
import { describe, expect, it } from "vitest";
import { encodeQr, type QrErrorCorrection } from "./qr";
import reference from "./qr.reference.json";

interface ReferenceCase {
  text: string;
  ecc: QrErrorCorrection;
  mask: number;
  version: number;
  forced: boolean;
  sha256: string;
}

async function hashModules(modules: boolean[][]): Promise<string> {
  const bits = modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join("")).join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bits));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const HELLO_M_MASK_2 = [
  "111111100000001111111",
  "100000100101101000001",
  "101110101011101011101",
  "101110101010101011101",
  "101110101010101011101",
  "100000101001001000001",
  "111111101010101111111",
  "000000001010000000000",
  "101111100011001111100",
  "111010010011111001101",
  "011010100000101101110",
  "000011010001111001100",
  "010100111100100100001",
  "000000001110100101001",
  "111111100101010010110",
  "100000101010000111110",
  "101110101101010010010",
  "101110101101111101000",
  "101110101000101100100",
  "100000100101111011100",
  "111111101000100010010",
];

describe("encodeQr", () => {
  it("draws 'hello' (version 1-M, mask 2) module for module", () => {
    const qr = encodeQr("hello", { errorCorrection: "M", mask: 2 });
    expect(qr.version).toBe(1);
    expect(qr.size).toBe(21);
    expect(qr.modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join(""))).toEqual(
      HELLO_M_MASK_2,
    );
  });

  it.each(reference as ReferenceCase[])(
    "matches the reference for %#: version $version-$ecc, mask $mask",
    async (c) => {
      const qr = encodeQr(c.text, { errorCorrection: c.ecc, mask: c.forced ? c.mask : undefined });
      expect(qr.version).toBe(c.version);
      expect(qr.size).toBe(17 + 4 * c.version);
      if (!c.forced) return;
      expect(qr.mask).toBe(c.mask);
      expect(await hashModules(qr.modules)).toBe(c.sha256);
    },
  );

  it("picks the smallest version that fits", () => {
    expect(encodeQr("a".repeat(14), { errorCorrection: "M" }).version).toBe(1);
    expect(encodeQr("a".repeat(15), { errorCorrection: "M" }).version).toBe(2);
    expect(encodeQr("a", { minVersion: 5 }).version).toBe(5);
  });

  it("refuses text longer than version 40 holds", () => {
    expect(() => encodeQr("a".repeat(2954), { errorCorrection: "L" })).toThrow(RangeError);
    expect(encodeQr("a".repeat(2953), { errorCorrection: "L" }).version).toBe(40);
  });

  it("chooses the same mask it would draw when forced", () => {
    const uri = "otpauth://totp/Roundhouse:ada%40example.com?secret=ABC&issuer=Roundhouse";
    const auto = encodeQr(uri);
    expect(encodeQr(uri, { mask: auto.mask }).modules).toEqual(auto.modules);
  });
});
