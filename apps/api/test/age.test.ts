/**
 * age X25519 keys: Bech32 encodings against `fixtures/age/keypair.json`
 * (cross-checked with filippo.io/age), checksums, and generation.
 */
import { AGE_IDENTITY_RE, AGE_RECIPIENT_RE } from "@roundhouse/protocol";
import { describe, expect, it } from "vitest";
import {
  ageRecipientOf,
  bech32Decode,
  bech32Encode,
  encodeAgeIdentity,
  encodeAgeRecipient,
  generateAgeKeyPair,
} from "../src/lib/age";
import fixture from "./fixtures/age/keypair.json";

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (h) => Number.parseInt(h, 16));

describe("age keys", () => {
  it("encodes the fixture's keys exactly as filippo.io/age does", async () => {
    expect(encodeAgeIdentity(bytes(fixture.private_key_hex))).toBe(fixture.identity);
    expect(encodeAgeRecipient(bytes(fixture.public_key_hex))).toBe(fixture.recipient);
    expect(await ageRecipientOf(fixture.identity)).toBe(fixture.recipient);
    expect(fixture.identity).toMatch(AGE_IDENTITY_RE);
    expect(fixture.recipient).toMatch(AGE_RECIPIENT_RE);
  });

  it("verifies Bech32 checksums both ways", () => {
    const id = bech32Decode(fixture.identity);
    expect(id.hrp).toBe("age-secret-key-");
    expect([...id.bytes]).toEqual([...bytes(fixture.private_key_hex)]);
    const r = bech32Decode(fixture.recipient);
    expect(r.hrp).toBe("age");
    expect([...r.bytes]).toEqual([...bytes(fixture.public_key_hex)]);

    // Any single changed character breaks the checksum.
    const last = fixture.recipient.at(-1) === "q" ? "p" : "q";
    expect(() => bech32Decode(fixture.recipient.slice(0, -1) + last)).toThrow(/checksum/);
    const mid = fixture.recipient.length >> 1;
    const swapped =
      fixture.recipient.slice(0, mid) +
      (fixture.recipient[mid] === "q" ? "p" : "q") +
      fixture.recipient.slice(mid + 1);
    expect(() => bech32Decode(swapped)).toThrow(/checksum/);
    expect(() =>
      bech32Decode(`${fixture.recipient.slice(0, 10).toUpperCase()}${fixture.recipient.slice(10)}`),
    ).toThrow(/mixed-case/);
    // BIP 173's reference vector.
    expect(bech32Encode("a", new Uint8Array())).toBe("a12uel5l");
  });

  it("refuses a recipient where an identity is expected", async () => {
    await expect(ageRecipientOf(fixture.recipient)).rejects.toThrow();
    await expect(ageRecipientOf(fixture.identity.toLowerCase())).rejects.toThrow();
  });

  it("generates distinct, self-consistent keypairs", async () => {
    const a = await generateAgeKeyPair();
    const b = await generateAgeKeyPair();
    expect(a.identity).toMatch(AGE_IDENTITY_RE);
    expect(a.recipient).toMatch(AGE_RECIPIENT_RE);
    expect(await ageRecipientOf(a.identity)).toBe(a.recipient);
    expect(a.identity).not.toBe(b.identity);
  });
});
