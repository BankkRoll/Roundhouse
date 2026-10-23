import { describe, expect, it } from "vitest";
import { ecdsaDerToRaw, ecdsaRawToDer, Oid } from "../src/lib/acme/csr";
import {
  DerTag,
  decodeDer,
  expectTag,
  readBitString,
  readOid,
  readSmallInteger,
  readString,
} from "../src/lib/acme/der";
import {
  base64UrlDecode,
  fromHex,
  pemDecodeAll,
  toArrayBuffer,
  toHex,
} from "../src/lib/acme/encoding";
import {
  createCsr,
  exportPrivateKeyPem,
  generateAccountKey,
  generateCertificateKey,
  isValidHostname,
  jwkThumbprint,
  normalizeHostnames,
} from "../src/lib/acme/index";
import { importAccountKey, signJws } from "../src/lib/acme/jws";

const ECDSA_SHA256 = { name: "ECDSA", hash: "SHA-256" } as const;
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

describe("JWK thumbprint", () => {
  it("matches RFC 7638 §3.1", async () => {
    const jwk = {
      kty: "RSA",
      n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
      e: "AQAB",
      alg: "RS256",
      kid: "2011-04-29",
    };
    expect(await jwkThumbprint(jwk)).toBe("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
  });

  it("ignores private and optional members of an EC key", async () => {
    const key = await generateAccountKey();
    const pub = { kty: key.kty, crv: key.crv, x: key.x, y: key.y };
    expect(await jwkThumbprint({ ...key, key_ops: ["sign"], ext: true })).toBe(
      await jwkThumbprint(pub),
    );
    await expect(jwkThumbprint({ kty: "oct", k: "AA" })).rejects.toThrow();
  });
});

describe("account keys and JWS", () => {
  it("generates a minimal private P-256 JWK", async () => {
    const key = await generateAccountKey();
    expect(Object.keys(key).sort()).toEqual(["crv", "d", "kty", "x", "y"]);
    expect(key).toMatchObject({ kty: "EC", crv: "P-256" });
  });

  it("rejects non-P-256 or public-only keys", async () => {
    const key = await generateAccountKey();
    await expect(importAccountKey({ ...key, d: undefined })).rejects.toThrow(/private EC P-256/);
    await expect(importAccountKey({ ...key, crv: "P-384" })).rejects.toThrow(/private EC P-256/);
  });

  it("signs a verifiable ES256 flattened JWS with the ACME header", async () => {
    const key = await generateAccountKey();
    const signer = await importAccountKey(key);
    const jws = await signJws(
      signer,
      { jwk: signer.publicJwk },
      "nonce-1",
      "https://ca.test/acct",
      {
        termsOfServiceAgreed: true,
      },
    );
    expect(Object.keys(jws).sort()).toEqual(["payload", "protected", "signature"]);
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(jws.protected)));
    expect(header).toEqual({
      alg: "ES256",
      jwk: { kty: "EC", crv: "P-256", x: key.x, y: key.y },
      nonce: "nonce-1",
      url: "https://ca.test/acct",
    });
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(jws.payload)))).toEqual({
      termsOfServiceAgreed: true,
    });
    const sig = base64UrlDecode(jws.signature);
    expect(sig).toHaveLength(64);
    const pub = await crypto.subtle.importKey("jwk", signer.publicJwk, P256, false, ["verify"]);
    const data = new TextEncoder().encode(`${jws.protected}.${jws.payload}`);
    expect(await crypto.subtle.verify(ECDSA_SHA256, pub, toArrayBuffer(sig), data)).toBe(true);
  });

  it("uses kid and an empty payload for POST-as-GET", async () => {
    const signer = await importAccountKey(await generateAccountKey());
    const jws = await signJws(
      signer,
      { kid: "https://ca.test/acct/1" },
      "n",
      "https://ca.test/o/1",
      null,
    );
    expect(jws.payload).toBe("");
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(jws.protected)));
    expect(header.kid).toBe("https://ca.test/acct/1");
    expect(header.jwk).toBeUndefined();
  });
});

describe("ECDSA signature conversion", () => {
  it("round-trips raw and DER, including high-bit and short integers", () => {
    const r = fromHex(`80${"11".repeat(31)}`);
    const s = fromHex(`0000${"7f".repeat(30)}`);
    const raw = new Uint8Array([...r, ...s]);
    const der = ecdsaRawToDer(raw);
    const seq = decodeDer(der);
    expect(toHex(seq.children[0]!.value)).toBe(`0080${"11".repeat(31)}`);
    expect(toHex(seq.children[1]!.value)).toBe("7f".repeat(30));
    expect(ecdsaDerToRaw(der)).toEqual(raw);
    expect(() => ecdsaRawToDer(new Uint8Array(3))).toThrow();
  });
});

describe("CSR", () => {
  async function parseCsr(der: Uint8Array) {
    const root = expectTag(decodeDer(der), DerTag.SEQUENCE, "CertificationRequest");
    const [info, alg, sig] = root.children;
    const [version, subject, spki, attrs] = info!.children;
    const ext = attrs!.children[0]!;
    const extensions = ext.children[1]!.children[0]!;
    const san = extensions.children[0]!;
    const sanValue = decodeDer(san.children[1]!.value);
    return {
      info: info!,
      version: readSmallInteger(version!),
      cn: subject!.children.length
        ? readString(subject!.children[0]!.children[0]!.children[1]!)
        : null,
      spki: spki!.raw,
      attrsTag: attrs!.tag,
      extOid: readOid(ext.children[0]!),
      sanOid: readOid(san.children[0]!),
      sans: sanValue.children.map((n) => ({ tag: n.tag, name: new TextDecoder().decode(n.value) })),
      algOid: readOid(alg!.children[0]!),
      algHasParams: alg!.children.length > 1,
      signature: readBitString(sig!),
    };
  }

  it("is a valid self-signed PKCS#10 request with every SAN", async () => {
    const keys = await generateCertificateKey();
    const der = await createCsr(keys, ["Example.com", "*.example.com", "example.com"]);
    const csr = await parseCsr(der);
    expect(csr.version).toBe(0);
    expect(csr.cn).toBe("example.com");
    expect(csr.attrsTag).toBe(0xa0);
    expect(csr.extOid).toBe(Oid.extensionRequest);
    expect(csr.sanOid).toBe(Oid.subjectAltName);
    expect(csr.sans).toEqual([
      { tag: 0x82, name: "example.com" },
      { tag: 0x82, name: "*.example.com" },
    ]);
    expect(csr.algOid).toBe(Oid.ecdsaWithSha256);
    expect(csr.algHasParams).toBe(false);

    const pub = await crypto.subtle.importKey("spki", toArrayBuffer(csr.spki), P256, false, [
      "verify",
    ]);
    const ok = await crypto.subtle.verify(
      ECDSA_SHA256,
      pub,
      toArrayBuffer(ecdsaDerToRaw(csr.signature)),
      toArrayBuffer(csr.info.raw),
    );
    expect(ok).toBe(true);

    const tampered = new Uint8Array(csr.info.raw);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    expect(
      await crypto.subtle.verify(
        ECDSA_SHA256,
        pub,
        toArrayBuffer(ecdsaDerToRaw(csr.signature)),
        tampered,
      ),
    ).toBe(false);
  });

  it("omits the CN when the first name exceeds 64 characters", async () => {
    const long = `${"a".repeat(60)}.example.com`;
    const csr = await parseCsr(await createCsr(await generateCertificateKey(), [long]));
    expect(csr.cn).toBeNull();
    expect(csr.sans).toEqual([{ tag: 0x82, name: long }]);
  });

  it("rejects invalid hostnames", async () => {
    const keys = await generateCertificateKey();
    await expect(createCsr(keys, [])).rejects.toThrow();
    await expect(createCsr(keys, ["a.*.example.com"])).rejects.toThrow(/invalid hostname/);
  });

  it("exports the certificate key as importable PKCS#8 PEM", async () => {
    const keys = await generateCertificateKey();
    const pem = await exportPrivateKeyPem(keys.privateKey);
    expect(pem.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true);
    expect(pem.endsWith("-----END PRIVATE KEY-----\n")).toBe(true);
    const [der] = pemDecodeAll(pem, "PRIVATE KEY");
    const imported = await crypto.subtle.importKey("pkcs8", toArrayBuffer(der!), P256, false, [
      "sign",
    ]);
    expect(imported.type).toBe("private");
  });
});

describe("hostnames", () => {
  it("normalises and de-duplicates", () => {
    expect(
      normalizeHostnames([" Shop.Example.COM. ", "shop.example.com", "*.example.com"]),
    ).toEqual(["shop.example.com", "*.example.com"]);
  });

  it.each([
    "localhost",
    "-a.example.com",
    "a-.example.com",
    "a..example.com",
    "*.*.example.com",
    "a.*.example.com",
    "*example.com",
    "ex ample.com",
    "bücher.example",
    "a_b.example.com",
    `${"a".repeat(64)}.example.com`,
    `${"a.".repeat(127)}com`,
  ])("rejects %j", (name) => {
    expect(isValidHostname(name)).toBe(false);
  });

  it.each(["example.com", "*.example.com", "xn--bcher-kva.example", "a-b.c-d.example"])(
    "accepts %j",
    (name) => {
      expect(isValidHostname(name)).toBe(true);
    },
  );
});
