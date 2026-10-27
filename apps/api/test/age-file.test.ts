/**
 * The age v1 file format the control plane writes shell recordings in:
 * ChaCha20-Poly1305 against RFC 8439's vectors, a file `filippo.io/age`
 * wrote (`fixtures/age/file.json`) decrypting here, round trips across
 * STREAM chunk boundaries, and refusals of tampered files and other keys.
 */
import { describe, expect, it } from "vitest";
import { generateAgeKeyPair } from "../src/lib/age";
import { ageDecrypt, ageEncrypt } from "../src/lib/age-file";
import { chacha20poly1305Open, chacha20poly1305Seal, poly1305 } from "../src/lib/chacha20-poly1305";
import cctv from "./fixtures/age/cctv.json";
import file from "./fixtures/age/file.json";
import keypair from "./fixtures/age/keypair.json";

const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

describe("ChaCha20-Poly1305 (RFC 8439)", () => {
  it("matches the Poly1305 vector of section 2.5.2", () => {
    const key = hex("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b");
    const tag = poly1305(key, new TextEncoder().encode("Cryptographic Forum Research Group"));
    expect(toHex(tag)).toBe("a8061dc1305136c6c22b8baf0c0127a9");
  });

  it("matches the AEAD vector of section 2.8.2 and refuses a flipped bit", () => {
    const key = hex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
    const nonce = hex("070000004041424344454647");
    const aad = hex("50515253c0c1c2c3c4c5c6c7");
    const plaintext = new TextEncoder().encode(
      "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
    );
    const sealed = chacha20poly1305Seal(key, nonce, plaintext, aad);
    expect(toHex(sealed.subarray(0, 16))).toBe("d31a8d34648e60db7b86afbc53ef7ec2");
    expect(toHex(sealed.subarray(-16))).toBe("1ae10b594f09e26a7e902ecbd0600691");
    expect(chacha20poly1305Open(key, nonce, sealed, aad)).toEqual(plaintext);
    const tampered = sealed.slice();
    tampered[3] = tampered[3]! ^ 1;
    expect(() => chacha20poly1305Open(key, nonce, tampered, aad)).toThrow(/authentication/);
  });
});

describe("age files", () => {
  it("decrypts a file filippo.io/age wrote", async () => {
    const plain = await ageDecrypt(keypair.identity, fromBase64(file.file_base64));
    expect(new TextDecoder().decode(plain)).toBe(file.line.repeat(file.repeat));
  });

  it("round-trips across chunk boundaries", async () => {
    for (const size of [0, 1, 65_535, 65_536, 65_537, 200_000]) {
      const data = Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) & 0xff);
      const sealed = await ageEncrypt(keypair.recipient, data);
      expect(new TextDecoder().decode(sealed.subarray(0, 32))).toMatch(
        /^age-encryption\.org\/v1\n-> X25519 /,
      );
      expect(await ageDecrypt(keypair.identity, sealed), String(size)).toEqual(data);
    }
  });

  it("refuses another identity, a tampered payload and a truncated file", async () => {
    const data = new TextEncoder().encode("x".repeat(70_000));
    const sealed = await ageEncrypt(keypair.recipient, data);
    const other = await generateAgeKeyPair();
    await expect(ageDecrypt(other.identity, sealed)).rejects.toThrow(/no identity matched/);
    const tampered = sealed.slice();
    tampered[tampered.length - 20] = tampered[tampered.length - 20]! ^ 1;
    await expect(ageDecrypt(keypair.identity, tampered)).rejects.toThrow(/^age: /);
    // Dropping the final chunk leaves a full chunk not marked last.
    await expect(
      ageDecrypt(keypair.identity, sealed.subarray(0, sealed.length - (70_000 - 65_536) - 16)),
    ).rejects.toThrow(/^age: /);
  });
});

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("C2SP CCTV age vectors", () => {
  it.each(cctv.vectors)("$name: $expect", async (v) => {
    const raw = fromBase64(v.file);
    const sealed = v.compressed ? await inflate(raw) : raw;
    if (v.expect === "success") {
      const plain = await ageDecrypt(v.identity, sealed);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", plain));
      expect(toHex(digest)).toBe(v.payload);
    } else {
      // NOTE: ageDecrypt releases no plaintext on any failure, so CCTV's
      // "payload released before the error" check holds trivially.
      await expect(ageDecrypt(v.identity, sealed)).rejects.toThrow(/^age: /);
    }
  });
});
