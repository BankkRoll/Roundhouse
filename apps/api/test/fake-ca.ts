/**
 * A small ACME CA behind an injected `fetch`, for the certificate pipeline
 * tests. Unlike the scripted server in `acme-client.test.ts` (which checks
 * the client's wire format) it validates challenges for real through hooks
 * and issues a genuine ECDSA-signed certificate for the CSR's key and names,
 * so stored chains parse, cover their hostnames and carry an ARI ID.
 *
 * All key material is generated per test run; nothing here is a credential.
 */

import { ecdsaRawToDer } from "../src/lib/acme/csr";
import {
  decodeDer,
  derBitString,
  derExplicit,
  derImplicit,
  derInteger,
  derOctetString,
  derOid,
  derSequence,
  derSet,
  derUtf8String,
  encodeTlv,
} from "../src/lib/acme/der";
import { base64UrlDecode, pemEncode, toArrayBuffer, utf8 } from "../src/lib/acme/encoding";

export const CA_ORIGIN = "https://ca.test";
export const CA_DIRECTORY = `${CA_ORIGIN}/dir`;

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const DAY = 86_400_000;

type ChallengeType = "http-01" | "dns-01";

interface Authz {
  id: string;
  name: string;
  wildcard: boolean;
  token: string;
  status: "pending" | "valid" | "invalid";
  error?: string;
  order: string;
}

interface Order {
  id: string;
  names: string[];
  authzs: string[];
  status: "pending" | "ready" | "processing" | "valid" | "invalid";
  replaces?: string;
  cert?: string;
}

/** Hooks the CA calls to validate challenges, like a real CA's vantage points. */
export interface FakeCaHooks {
  /** HTTP-01: fetch `http://<name>/.well-known/acme-challenge/<token>`; return the body or `null`. */
  http01?(name: string, token: string): Promise<string | null>;
  /** DNS-01: TXT values at `_acme-challenge.<name>`. */
  dns01?(name: string): Promise<string[]>;
}

function utcTime(ms: number): Uint8Array {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const text = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return encodeTlv(0x17, utf8(text));
}

const name = (cn: string, org?: string) =>
  derSequence(
    ...(org ? [derSet(derSequence(derOid("2.5.4.10"), derUtf8String(org)))] : []),
    derSet(derSequence(derOid("2.5.4.3"), derUtf8String(cn))),
  );

/** A CA keyed afresh for each instance. */
export class FakeCa {
  hooks: FakeCaHooks = {};
  /** Certificate lifetime in days. */
  lifetimeDays = 90;
  /** ARI suggested window offsets from issuance, in days; `null` turns ARI off. */
  ari: { startDays: number; endDays: number } | null = { startDays: 50, endDays: 55 };
  orders = new Map<string, Order>();
  authzs = new Map<string, Authz>();
  /** `replaces` of every order placed. */
  replaced: (string | undefined)[] = [];
  requests: string[] = [];
  #nonce = 0;
  #serial = 0x1000;
  #accounts = 0;
  #thumbprints = new Map<string, string>();
  #keys: Promise<CryptoKeyPair> = crypto.subtle.generateKey(P256, true, [
    "sign",
    "verify",
  ]) as Promise<CryptoKeyPair>;
  #issued = new Map<string, number>();

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    this.requests.push(`${method} ${url.pathname}`);
    const headers = new Headers({ "replay-nonce": `n${++this.#nonce}` });
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      for (const [k, v] of Object.entries(extra)) headers.set(k, v);
      headers.set("content-type", status >= 400 ? "application/problem+json" : "application/json");
      return new Response(JSON.stringify(body), { status, headers });
    };
    const path = url.pathname;
    if (path === "/dir") {
      return json(200, {
        newNonce: `${CA_ORIGIN}/nonce`,
        newAccount: `${CA_ORIGIN}/acct`,
        newOrder: `${CA_ORIGIN}/order`,
        ...(this.ari ? { renewalInfo: `${CA_ORIGIN}/ari` } : {}),
      });
    }
    if (path === "/nonce") return new Response(null, { status: 204, headers });
    if (path.startsWith("/ari/")) {
      const issuedAt = this.#issued.get(path.slice(5));
      if (!this.ari || issuedAt === undefined)
        return json(404, { type: "urn:ietf:params:acme:error:malformed" });
      return json(200, {
        suggestedWindow: {
          start: new Date(issuedAt + this.ari.startDays * DAY).toISOString(),
          end: new Date(issuedAt + this.ari.endDays * DAY).toISOString(),
        },
      });
    }
    const jws = JSON.parse(String(init?.body ?? "{}"));
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(jws.protected)));
    const payload = jws.payload
      ? JSON.parse(new TextDecoder().decode(base64UrlDecode(jws.payload)))
      : null;
    if (path === "/acct") {
      const thumb = JSON.stringify([header.jwk.x, header.jwk.y]);
      let kid = this.#thumbprints.get(thumb);
      if (!kid) {
        kid = `${CA_ORIGIN}/acct/${++this.#accounts}`;
        this.#thumbprints.set(thumb, kid);
      }
      return json(201, { status: "valid" }, { location: kid });
    }
    if (path === "/order") {
      const id = `o${this.orders.size + 1}`;
      const names = (payload.identifiers as { value: string }[]).map((i) => i.value);
      this.replaced.push(payload.replaces);
      const authzs = names.map((n, i) => {
        const a: Authz = {
          id: `${id}a${i}`,
          name: n.replace(/^\*\./, ""),
          wildcard: n.startsWith("*."),
          token: `${id}a${i}`.padEnd(32, "x"),
          status: "pending",
          order: id,
        };
        this.authzs.set(a.id, a);
        return a.id;
      });
      this.orders.set(id, { id, names, authzs, status: "pending", replaces: payload.replaces });
      return json(201, this.#orderBody(id), { location: `${CA_ORIGIN}/o/${id}` });
    }
    const [, kind, id] = path.split("/");
    if (kind === "o") return json(200, this.#orderBody(id!), { "retry-after": "1" });
    if (kind === "a") return json(200, this.#authzBody(id!));
    if (kind === "c") {
      const [authzId, type] = id!.split(".") as [string, ChallengeType];
      const a = this.authzs.get(authzId)!;
      await this.#validate(a, type, header.kid);
      const o = this.orders.get(a.order)!;
      if (a.status === "invalid") o.status = "invalid";
      else if (o.authzs.every((x) => this.authzs.get(x)!.status === "valid")) o.status = "ready";
      return json(
        200,
        this.#authzBody(authzId).challenges.find((c) => c.type === type),
      );
    }
    if (kind === "fin") {
      const o = this.orders.get(id!)!;
      if (o.status !== "ready") {
        return json(403, { type: "urn:ietf:params:acme:error:orderNotReady", detail: "not ready" });
      }
      o.cert = await this.#issue(base64UrlDecode(payload.csr), o.names);
      o.status = "valid";
      return json(200, this.#orderBody(id!));
    }
    if (kind === "cert") {
      headers.set("content-type", "application/pem-certificate-chain");
      return new Response(this.orders.get(id!)!.cert!, { status: 200, headers });
    }
    return json(404, { type: "urn:ietf:params:acme:error:malformed", detail: "not found" });
  }) as typeof fetch;

  async #validate(a: Authz, type: ChallengeType, kid: string) {
    const thumb = [...this.#thumbprints.entries()].find(([, k]) => k === kid)?.[0];
    if (!thumb) {
      a.status = "invalid";
      a.error = "unknown account";
      return;
    }
    const [x, y] = JSON.parse(thumb) as [string, string];
    const jwk = JSON.stringify({ crv: "P-256", kty: "EC", x, y });
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(jwk)));
    const thumbprint = btoa(String.fromCharCode(...digest))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const keyAuth = `${a.token}.${thumbprint}`;
    if (type === "http-01") {
      const body = (await this.hooks.http01?.(a.name, a.token)) ?? null;
      a.status = body?.trim() === keyAuth ? "valid" : "invalid";
      if (a.status === "invalid")
        a.error = `Invalid response from http://${a.name}/.well-known/acme-challenge/${a.token}`;
      return;
    }
    const want = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(keyAuth)));
    const value = btoa(String.fromCharCode(...want))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const seen = (await this.hooks.dns01?.(a.name)) ?? [];
    a.status = seen.includes(value) ? "valid" : "invalid";
    if (a.status === "invalid") a.error = `No TXT record found at _acme-challenge.${a.name}`;
  }

  #orderBody(id: string) {
    const o = this.orders.get(id)!;
    return {
      status: o.status,
      identifiers: o.names.map((value) => ({ type: "dns", value })),
      authorizations: o.authzs.map((a) => `${CA_ORIGIN}/a/${a}`),
      finalize: `${CA_ORIGIN}/fin/${id}`,
      ...(o.cert ? { certificate: `${CA_ORIGIN}/cert/${id}` } : {}),
      ...(o.status === "invalid"
        ? {
            error: { type: "urn:ietf:params:acme:error:unauthorized", detail: "validation failed" },
          }
        : {}),
    };
  }

  #authzBody(id: string) {
    const a = this.authzs.get(id)!;
    const challenge = (type: ChallengeType) => ({
      type,
      url: `${CA_ORIGIN}/c/${id}.${type}`,
      token: a.token,
      status: a.status,
      ...(a.status === "invalid"
        ? { error: { type: "urn:ietf:params:acme:error:unauthorized", detail: a.error } }
        : {}),
    });
    return {
      status: a.status,
      identifier: { type: "dns", value: a.name },
      ...(a.wildcard ? { wildcard: true } : {}),
      challenges: a.wildcard ? [challenge("dns-01")] : [challenge("http-01"), challenge("dns-01")],
    };
  }

  async #issue(csrDer: Uint8Array, names: string[]): Promise<string> {
    const keys = await this.#keys;
    const csr = decodeDer(csrDer);
    const spki = csr.children[0]!.children[2]!.raw;
    const serial = ++this.#serial;
    const now = Date.now();
    const san = derSequence(...names.map((n) => derImplicit(2, utf8(n))));
    const aki = derSequence(derImplicit(0, Uint8Array.of(0xca, 0xfe, 0x01)));
    const tbs = derSequence(
      derExplicit(0, derInteger(2)),
      derInteger(serial),
      derSequence(derOid("1.2.840.10045.4.3.2")),
      name("Fake Intermediate", "Roundhouse Test CA"),
      derSequence(utcTime(now - 60_000), utcTime(now + this.lifetimeDays * DAY)),
      derSequence(),
      spki,
      derExplicit(
        3,
        derSequence(
          derSequence(derOid("2.5.29.17"), derOctetString(san)),
          derSequence(derOid("2.5.29.35"), derOctetString(aki)),
        ),
      ),
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keys.privateKey,
        toArrayBuffer(tbs),
      ),
    );
    const cert = derSequence(
      tbs,
      derSequence(derOid("1.2.840.10045.4.3.2")),
      derBitString(ecdsaRawToDer(sig)),
    );
    const serialBytes = Uint8Array.of(...serialBytesOf(serial));
    const ariId = `${b64u(Uint8Array.of(0xca, 0xfe, 0x01))}.${b64u(serialBytes)}`;
    this.#issued.set(ariId, now);
    return pemEncode("CERTIFICATE", cert).replace(/\n/g, "\r\n");
  }
}

function serialBytesOf(n: number): number[] {
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  if ((out[0] ?? 0) & 0x80) out.unshift(0);
  return out;
}

function b64u(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
