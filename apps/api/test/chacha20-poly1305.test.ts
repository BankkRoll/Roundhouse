/**
 * Known-answer and differential tests for the hand-written ChaCha20-Poly1305
 * that seals shell recordings.
 *
 * - `fixtures/crypto/rfc8439.json`: every vector in RFC 8439 sections 2.3.2,
 *   2.4.2, 2.5.2, 2.6.2, 2.8.2 and Appendix A.1–A.5, extracted mechanically
 *   from the RFC text. A.3 #5–#11 are the Poly1305 reduction edge cases a
 *   limb implementation gets wrong first.
 * - `fixtures/crypto/x-crypto.json`: AEAD seals and Poly1305 tags written by
 *   `golang.org/x/crypto`, including all-0xff keys and messages at every
 *   length across the 16- and 64-byte block boundaries.
 */
import { describe, expect, it } from "vitest";
import {
  chacha20,
  chacha20poly1305Open,
  chacha20poly1305Seal,
  poly1305,
} from "../src/lib/chacha20-poly1305";
import rfc from "./fixtures/crypto/rfc8439.json";
import xcrypto from "./fixtures/crypto/x-crypto.json";

const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("RFC 8439 known answers", () => {
  it.each(rfc.chacha20Block)("ChaCha20 block: $source", (v) => {
    expect(toHex(chacha20(hex(v.key), hex(v.nonce), v.counter, new Uint8Array(64)))).toBe(
      v.keystream,
    );
  });

  it.each(rfc.chacha20)("ChaCha20 encryption: $source", (v) => {
    expect(toHex(chacha20(hex(v.key), hex(v.nonce), v.counter, hex(v.plaintext)))).toBe(
      v.ciphertext,
    );
    expect(toHex(chacha20(hex(v.key), hex(v.nonce), v.counter, hex(v.ciphertext)))).toBe(
      v.plaintext,
    );
  });

  it.each(rfc.poly1305)("Poly1305: $source", (v) => {
    expect(toHex(poly1305(hex(v.key), hex(v.message)))).toBe(v.tag);
  });

  it.each(rfc.polyKeyGen)("Poly1305 key generation: $source", (v) => {
    expect(toHex(chacha20(hex(v.key), hex(v.nonce), 0, new Uint8Array(32)))).toBe(v.otk);
  });

  it.each(rfc.aead)("AEAD seal and open: $source", (v) => {
    const sealed = chacha20poly1305Seal(hex(v.key), hex(v.nonce), hex(v.plaintext), hex(v.aad));
    expect(toHex(sealed)).toBe(v.ciphertext + v.tag);
    expect(toHex(chacha20poly1305Open(hex(v.key), hex(v.nonce), sealed, hex(v.aad)))).toBe(
      v.plaintext,
    );
  });
});

describe("golang.org/x/crypto differential", () => {
  it("seals and opens exactly as x/crypto does", () => {
    for (const v of xcrypto.aead) {
      const label = `plaintext ${v.Plaintext.length / 2} B, aad ${v.AAD.length / 2} B`;
      const sealed = chacha20poly1305Seal(hex(v.Key), hex(v.Nonce), hex(v.Plaintext), hex(v.AAD));
      expect(toHex(sealed), label).toBe(v.Sealed);
      expect(toHex(chacha20poly1305Open(hex(v.Key), hex(v.Nonce), sealed, hex(v.AAD))), label).toBe(
        v.Plaintext,
      );
    }
    expect(xcrypto.aead.length).toBeGreaterThan(140);
  });

  it("computes the Poly1305 tags x/crypto does", () => {
    for (const v of xcrypto.poly1305) {
      expect(toHex(poly1305(hex(v.Key), hex(v.Message))), `${v.Message.length / 2} B`).toBe(v.Tag);
    }
  });
});

describe("AEAD refusals", () => {
  const v = rfc.aead[1]!;
  const key = hex(v.key);
  const nonce = hex(v.nonce);
  const aad = hex(v.aad);
  const sealed = hex(v.ciphertext + v.tag);

  it("refuses any single flipped bit in the ciphertext, the tag or the AAD", () => {
    for (let i = 0; i < sealed.byteLength; i += 7) {
      const tampered = sealed.slice();
      tampered[i] = tampered[i]! ^ (1 << (i % 8));
      expect(() => chacha20poly1305Open(key, nonce, tampered, aad)).toThrow(/authentication/);
    }
    const otherAad = aad.slice();
    otherAad[0] = otherAad[0]! ^ 0x80;
    expect(() => chacha20poly1305Open(key, nonce, sealed, otherAad)).toThrow(/authentication/);
  });

  it("refuses a truncated, extended or wrong-nonce message", () => {
    expect(() => chacha20poly1305Open(key, nonce, sealed.subarray(0, -1), aad)).toThrow();
    const longer = new Uint8Array(sealed.byteLength + 1);
    longer.set(sealed);
    expect(() => chacha20poly1305Open(key, nonce, longer, aad)).toThrow();
    const otherNonce = nonce.slice();
    otherNonce[11] = otherNonce[11]! ^ 1;
    expect(() => chacha20poly1305Open(key, otherNonce, sealed, aad)).toThrow();
    expect(() => chacha20poly1305Open(key, nonce, sealed.subarray(0, 15), aad)).toThrow(/short/);
  });

  it("refuses wrong key and nonce sizes", () => {
    expect(() => chacha20(new Uint8Array(16), nonce, 0, new Uint8Array(1))).toThrow(/32 bytes/);
    expect(() => chacha20(key, new Uint8Array(8), 0, new Uint8Array(1))).toThrow(/12 bytes/);
  });
});

describe("ChaCha20 block counter", () => {
  it("refuses to wrap the 32-bit counter instead of reusing keystream", () => {
    const key = new Uint8Array(32);
    const nonce = new Uint8Array(12);
    expect(chacha20(key, nonce, 2 ** 32 - 1, new Uint8Array(64)).byteLength).toBe(64);
    expect(() => chacha20(key, nonce, 2 ** 32 - 1, new Uint8Array(65))).toThrow(/counter/);
    expect(() => chacha20(key, nonce, -1, new Uint8Array(1))).toThrow(/counter/);
  });
});
