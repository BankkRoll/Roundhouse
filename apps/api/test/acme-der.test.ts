import { describe, expect, it } from "vitest";
import {
  DerTag,
  decodeDer,
  derBitString,
  derBoolean,
  derExplicit,
  derIa5String,
  derImplicit,
  derInteger,
  derNull,
  derOctetString,
  derOid,
  derSequence,
  derSet,
  derUtf8String,
  encodeTlv,
  readBitString,
  readOid,
  readSmallInteger,
  readString,
  readTime,
  readUnsignedInteger,
} from "../src/lib/acme/der";
import {
  base64Decode,
  base64Encode,
  base64UrlDecode,
  base64UrlEncode,
  fromHex,
  pemDecodeAll,
  pemEncode,
  toHex,
} from "../src/lib/acme/encoding";

const hex = (bytes: Uint8Array) => toHex(bytes);

describe("DER encoding", () => {
  it("encodes short and long-form lengths", () => {
    expect(hex(encodeTlv(0x04, new Uint8Array(3)))).toBe("0403000000");
    const long = encodeTlv(0x04, new Uint8Array(200));
    expect(hex(long.subarray(0, 3))).toBe("0481c8");
    const longer = encodeTlv(0x04, new Uint8Array(300));
    expect(hex(longer.subarray(0, 4))).toBe("0482012c");
    expect(decodeDer(longer).value.length).toBe(300);
  });

  it("encodes integers minimally with sign padding", () => {
    expect(hex(derInteger(0))).toBe("020100");
    expect(hex(derInteger(127))).toBe("02017f");
    expect(hex(derInteger(128))).toBe("02020080");
    expect(hex(derInteger(65537))).toBe("0203010001");
    expect(hex(derInteger(fromHex("000001")))).toBe("020101");
    expect(hex(derInteger(fromHex("ff")))).toBe("020200ff");
    expect(hex(derInteger(new Uint8Array()))).toBe("020100");
    expect(() => derInteger(-1)).toThrow();
  });

  it("encodes OIDs (X.690 examples)", () => {
    expect(hex(derOid("1.2.840.10045.2.1"))).toBe("06072a8648ce3d0201");
    expect(hex(derOid("2.5.29.17"))).toBe("0603551d11");
    expect(hex(derOid("1.2.840.113549.1.9.14"))).toBe("06092a864886f70d01090e");
    expect(hex(derOid("2.999.3"))).toBe("0603883703");
    expect(() => derOid("1.40")).toThrow();
    expect(() => derOid("3.1")).toThrow();
    expect(() => derOid("1.2.x")).toThrow();
  });

  it("encodes the simple types", () => {
    expect(hex(derNull())).toBe("0500");
    expect(hex(derBoolean(true))).toBe("0101ff");
    expect(hex(derBoolean(false))).toBe("010100");
    expect(hex(derBitString(fromHex("abcd")))).toBe("030300abcd");
    expect(hex(derOctetString(fromHex("01")))).toBe("040101");
    expect(hex(derUtf8String("é"))).toBe("0c02c3a9");
    expect(hex(derIa5String("a.b"))).toBe("1603612e62");
    expect(() => derIa5String("é")).toThrow();
    expect(hex(derExplicit(0, derInteger(2)))).toBe("a003020102");
    expect(hex(derImplicit(2, fromHex("61")))).toBe("820161");
    expect(hex(derImplicit(0, fromHex("0500"), true))).toBe("a0020500");
  });

  it("sorts SET OF members", () => {
    expect(hex(derSet(derInteger(2), derInteger(1)))).toBe("3106020101020102");
  });
});

describe("DER decoding", () => {
  it("round-trips a nested structure", () => {
    const encoded = derSequence(
      derInteger(fromHex("87654321")),
      derOid("2.5.4.3"),
      derSet(derUtf8String("shop.example.com")),
      derExplicit(3, derSequence(derBoolean(true), derNull())),
      derBitString(fromHex("00ff")),
    );
    const root = decodeDer(encoded);
    expect(root.tag).toBe(DerTag.SEQUENCE);
    expect(root.constructed).toBe(true);
    expect(root.raw).toEqual(encoded);
    const [int, oid, set, explicit, bits] = root.children;
    expect(hex(readUnsignedInteger(int!))).toBe("87654321");
    expect(hex(int!.value)).toBe("0087654321");
    expect(readOid(oid!)).toBe("2.5.4.3");
    expect(readString(set!.children[0]!)).toBe("shop.example.com");
    expect(explicit!.tag).toBe(0xa3);
    expect(explicit!.children[0]!.children).toHaveLength(2);
    expect(hex(readBitString(bits!))).toBe("00ff");
  });

  it("round-trips OIDs including large arcs", () => {
    for (const oid of [
      "1.2.840.113549.1.9.14",
      "2.999.3",
      "0.9.2342.19200300.100.1.25",
      "1.3.6.1.4.1.44947.1.1.1",
    ]) {
      expect(readOid(decodeDer(derOid(oid)))).toBe(oid);
    }
  });

  it("reads small integers", () => {
    for (const n of [0, 1, 127, 128, 255, 256, 65535, 2 ** 40]) {
      expect(readSmallInteger(decodeDer(derInteger(n)))).toBe(n);
    }
  });

  it("rejects negative integers", () => {
    expect(() => readUnsignedInteger(decodeDer(fromHex("020180")))).toThrow(/negative/);
  });

  it("is strict about framing", () => {
    expect(() => decodeDer(fromHex("0403aabb"))).toThrow(/truncated/);
    expect(() => decodeDer(fromHex("040100ff"))).toThrow(/trailing/);
    expect(() => decodeDer(fromHex("0480"))).toThrow(/indefinite/);
    expect(() => decodeDer(fromHex(`048105${"00".repeat(5)}`))).toThrow(/non-minimal/);
    expect(() => decodeDer(fromHex(`04820005${"00".repeat(5)}`))).toThrow(/non-minimal/);
    expect(() => decodeDer(fromHex("1f0100"))).toThrow(/high-tag/);
    expect(() => decodeDer(fromHex("0485ffffffffff"))).toThrow(/too large/);
    expect(() => decodeDer(new Uint8Array())).toThrow(/truncated/);
    expect(() => readBitString(decodeDer(fromHex("03020100")))).toThrow(/unused/);
  });

  it("bounds nesting depth", () => {
    let nested = derNull();
    for (let i = 0; i < 40; i++) nested = derSequence(nested);
    expect(() => decodeDer(nested)).toThrow(/too deep/);
  });

  it("parses UTCTime and GeneralizedTime", () => {
    const utc = (s: string) => decodeDer(encodeTlv(DerTag.UTC_TIME, new TextEncoder().encode(s)));
    const gen = (s: string) =>
      decodeDer(encodeTlv(DerTag.GENERALIZED_TIME, new TextEncoder().encode(s)));
    expect(readTime(utc("261001000000Z"))).toBe(Date.UTC(2026, 9, 1));
    expect(readTime(utc("991231235959Z"))).toBe(Date.UTC(1999, 11, 31, 23, 59, 59));
    expect(readTime(gen("20500101120000Z"))).toBe(Date.UTC(2050, 0, 1, 12));
    expect(() => readTime(utc("2610010000Z"))).toThrow();
    expect(() => readTime(gen("20500101120000+0100"))).toThrow();
  });

  it("decodes the string types", () => {
    const bmp = decodeDer(encodeTlv(DerTag.BMP_STRING, fromHex("00410042")));
    expect(readString(bmp)).toBe("AB");
    const printable = decodeDer(encodeTlv(DerTag.PRINTABLE_STRING, fromHex("5553")));
    expect(readString(printable)).toBe("US");
    expect(() => readString(decodeDer(derNull()))).toThrow();
  });
});

describe("encodings", () => {
  it("base64url matches RFC 4648 vectors", () => {
    expect(base64UrlEncode("")).toBe("");
    expect(base64UrlEncode("f")).toBe("Zg");
    expect(base64UrlEncode("fo")).toBe("Zm8");
    expect(base64UrlEncode("foobar")).toBe("Zm9vYmFy");
    expect(base64UrlEncode(fromHex("fbff"))).toBe("-_8");
    expect(hex(base64UrlDecode("-_8"))).toBe("fbff");
    expect(hex(base64UrlDecode("-_8="))).toBe("fbff");
    expect(() => base64UrlDecode("a+b")).toThrow();
  });

  it("base64 round-trips large inputs", () => {
    const big = new Uint8Array(100_000).map((_, i) => i & 0xff);
    expect(base64Decode(base64Encode(big))).toEqual(big);
    expect(() => base64Decode("@@@")).toThrow();
  });

  it("hex round-trips and validates", () => {
    expect(hex(fromHex("00AbFF"))).toBe("00abff");
    expect(() => fromHex("abc")).toThrow();
    expect(() => fromHex("zz")).toThrow();
  });

  it("PEM armours at 64 columns and decodes CRLF input", () => {
    const der = new Uint8Array(100).fill(7);
    const pem = pemEncode("CERTIFICATE", der);
    const lines = pem.trimEnd().split("\n");
    expect(lines[0]).toBe("-----BEGIN CERTIFICATE-----");
    expect(lines[1]).toHaveLength(64);
    expect(pem.endsWith("-----END CERTIFICATE-----\n")).toBe(true);
    const crlf = `junk\r\n${pem.replace(/\n/g, "\r\n")}${pem}`;
    expect(pemDecodeAll(crlf, "CERTIFICATE")).toEqual([der, der]);
    expect(pemDecodeAll(pem, "PRIVATE KEY")).toEqual([]);
  });
});
