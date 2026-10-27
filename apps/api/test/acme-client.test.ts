import { describe, expect, it } from "vitest";
import { decodeDer } from "../src/lib/acme/der";
import { base64UrlDecode, toArrayBuffer } from "../src/lib/acme/encoding";
import {
  AcmeClient,
  AcmeError,
  createCsr,
  generateAccountKey,
  generateCertificateKey,
  jwkThumbprint,
  parseRetryAfter,
} from "../src/lib/acme/index";
import chainPem from "./fixtures/acme/chain.pem?raw";

const CA = "https://ca.test";
const DIRECTORY = `${CA}/dir`;
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

interface RecordedRequest {
  method: string;
  url: string;
  headers: Headers;
  header?: Record<string, unknown>;
  payload?: unknown;
}

/**
 * A scripted RFC 8555 server behind an injected fetch. It verifies every JWS
 * (signature, nonce, url, jwk/kid) so the client's wire format is checked,
 * and drives one order through pending → ready → valid.
 */
class FakeAcme {
  requests: RecordedRequest[] = [];
  /** Reject this many upcoming signed requests with badNonce. */
  rejectNonces = 0;
  /** Make the next challenge validation fail. */
  failValidation = false;
  /** Scripted replies for a path, consumed before the default handler. */
  overrides = new Map<string, Reply[]>();
  directory: Record<string, unknown> = {
    newNonce: `${CA}/nonce`,
    newAccount: `${CA}/acct`,
    newOrder: `${CA}/order`,
    renewalInfo: `${CA}/ari/`,
    meta: { termsOfService: `${CA}/tos` },
  };

  #nonce = 0;
  #validNonces = new Set<string>();
  #accounts = new Map<string, JsonWebKey>();
  #orders = new Map<
    string,
    { status: string; identifiers: { type: string; value: string }[]; authzs: string[] }
  >();
  #authzs = new Map<
    string,
    { status: string; value: string; token: string; order: string; challenge: string }
  >();

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const record: RecordedRequest = { method, url, headers };
    this.requests.push(record);
    const reply = await this.#handle(url, method, init, record);
    const out = new Headers(reply.headers);
    if (method !== "GET") out.set("replay-nonce", this.#issueNonce());
    if (reply.body !== undefined && !out.has("content-type")) {
      out.set(
        "content-type",
        reply.status >= 400 ? "application/problem+json" : "application/json",
      );
    }
    const body =
      reply.body === undefined
        ? null
        : typeof reply.body === "string"
          ? reply.body
          : JSON.stringify(reply.body);
    return new Response(method === "HEAD" ? null : body, { status: reply.status, headers: out });
  }) as typeof fetch;

  #issueNonce(): string {
    const nonce = `nonce${++this.#nonce}`;
    this.#validNonces.add(nonce);
    return nonce;
  }

  async #handle(
    url: string,
    method: string,
    init: RequestInit | undefined,
    record: RecordedRequest,
  ): Promise<Reply> {
    const path = new URL(url).pathname;
    if (path === "/dir") return { status: 200, body: this.directory };
    if (path === "/nonce") return { status: method === "HEAD" ? 200 : 204 };
    if (path.startsWith("/ari/")) {
      const scripted = this.overrides.get("/ari")?.shift();
      return scripted ?? { status: 404, body: { type: "urn:ietf:params:acme:error:malformed" } };
    }
    if (method !== "POST")
      return { status: 405, body: { type: "urn:ietf:params:acme:error:malformed" } };

    const jws = JSON.parse(String(init?.body));
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(jws.protected)));
    record.header = header;
    record.payload =
      jws.payload === "" ? "" : JSON.parse(new TextDecoder().decode(base64UrlDecode(jws.payload)));
    if (record.headers.get("content-type") !== "application/jose+json") {
      return { status: 415, body: { type: "urn:ietf:params:acme:error:malformed" } };
    }
    if (header.url !== url) return problem(401, "unauthorized", "url mismatch");
    if (!this.#validNonces.delete(header.nonce)) return problem(400, "badNonce", "unknown nonce");
    if (this.rejectNonces > 0) {
      this.rejectNonces--;
      return problem(400, "badNonce", "JWS has an invalid anti-replay nonce");
    }
    const jwk = header.jwk ?? this.#accounts.get(header.kid);
    if (!jwk || header.alg !== "ES256") return problem(401, "unauthorized", "unknown key");
    const key = await crypto.subtle.importKey("jwk", jwk, P256, false, ["verify"]);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      toArrayBuffer(base64UrlDecode(jws.signature)),
      new TextEncoder().encode(`${jws.protected}.${jws.payload}`),
    );
    if (!ok) return problem(403, "unauthorized", "bad signature");

    const scripted = this.overrides.get(path)?.shift();
    if (scripted) return scripted;
    return this.#route(path, header, record.payload);
  }

  async #route(path: string, header: Record<string, unknown>, payload: unknown): Promise<Reply> {
    const p = payload as Record<string, unknown>;
    if (path === "/acct") {
      if (!header.jwk) return problem(400, "malformed", "newAccount needs jwk");
      const thumb = await jwkThumbprint(header.jwk as JsonWebKey);
      const kid = `${CA}/acct/${thumb}`;
      const existing = this.#accounts.has(kid);
      this.#accounts.set(kid, header.jwk as JsonWebKey);
      return {
        status: existing ? 200 : 201,
        headers: { location: kid },
        body: { status: "valid", ...p },
      };
    }
    if (!header.kid || header.jwk) return problem(400, "malformed", "expected kid");
    if (path === "/order") {
      const id = `o${this.#orders.size + 1}`;
      const identifiers = p.identifiers as { type: string; value: string }[];
      const authzs = identifiers.map((ident, i) => {
        const authz = `${id}a${i}`;
        this.#authzs.set(authz, {
          status: "pending",
          value: ident.value.replace(/^\*\./, ""),
          token: `tok_${authz}`,
          order: id,
          challenge: `${authz}c`,
        });
        return authz;
      });
      this.#orders.set(id, { status: "pending", identifiers, authzs });
      return { status: 201, headers: { location: `${CA}/o/${id}` }, body: this.#orderBody(id) };
    }
    const [, kind, id] = path.split("/");
    if (kind === "o" && id)
      return { status: 200, headers: { "retry-after": "3" }, body: this.#orderBody(id) };
    if (kind === "a" && id) return { status: 200, body: this.#authzBody(id) };
    if (kind === "c" && id) {
      const authzId = id.slice(0, -1);
      const authz = this.#authzs.get(authzId)!;
      authz.status = this.failValidation ? "invalid" : "valid";
      const order = this.#orders.get(authz.order)!;
      if (authz.status === "invalid") order.status = "invalid";
      else if (order.authzs.every((a) => this.#authzs.get(a)?.status === "valid"))
        order.status = "ready";
      return { status: 200, body: this.#authzBody(authzId).challenges[0] };
    }
    if (kind === "fin" && id) {
      const order = this.#orders.get(id)!;
      if (order.status !== "ready")
        return problem(
          403,
          "orderNotReady",
          'Order\'s status ("invalid") is not acceptable for finalization',
        );
      decodeDer(base64UrlDecode(String(p.csr)));
      order.status = "valid";
      return { status: 200, body: this.#orderBody(id) };
    }
    if (kind === "cert")
      return {
        status: 200,
        headers: { "content-type": "application/pem-certificate-chain" },
        body: chainPem.replace(/\n/g, "\r\n"),
      };
    return problem(404, "malformed", "not found");
  }

  #orderBody(id: string) {
    const order = this.#orders.get(id)!;
    return {
      status: order.status,
      identifiers: order.identifiers,
      authorizations: order.authzs.map((a) => `${CA}/a/${a}`),
      finalize: `${CA}/fin/${id}`,
      ...(order.status === "valid" ? { certificate: `${CA}/cert/${id}` } : {}),
      ...(order.status === "invalid"
        ? {
            error: { type: "urn:ietf:params:acme:error:unauthorized", detail: "validation failed" },
          }
        : {}),
    };
  }

  #authzBody(id: string) {
    const authz = this.#authzs.get(id)!;
    return {
      status: authz.status,
      identifier: { type: "dns", value: authz.value },
      challenges: [
        {
          type: "http-01",
          url: `${CA}/c/${authz.challenge}`,
          token: authz.token,
          status: authz.status === "pending" ? "pending" : authz.status,
          ...(authz.status === "invalid"
            ? {
                error: {
                  type: "urn:ietf:params:acme:error:connection",
                  detail: "Connection refused",
                },
              }
            : {}),
        },
      ],
    };
  }
}

function problem(
  status: number,
  type: string,
  detail: string,
  extra: Record<string, unknown> = {},
): Reply {
  return { status, body: { type: `urn:ietf:params:acme:error:${type}`, detail, status, ...extra } };
}

async function setup(opts: { register?: boolean } = {}) {
  const server = new FakeAcme();
  const accountKey = await generateAccountKey();
  const client = new AcmeClient({ directoryUrl: DIRECTORY, accountKey, fetch: server.fetch });
  if (opts.register !== false) await client.register();
  return { server, accountKey, client };
}

describe("AcmeClient order flow", () => {
  it("registers, orders, validates, finalizes and downloads", async () => {
    const { server, accountKey, client } = await setup({ register: false });
    const kid = await client.register({ contact: ["mailto:ops@example.com"] });
    expect(kid).toMatch(/^https:\/\/ca\.test\/acct\//);
    expect(client.accountUrl).toBe(kid);
    const newAccount = server.requests.find((r) => r.url === `${CA}/acct`)!;
    expect(newAccount.header).toMatchObject({
      alg: "ES256",
      url: `${CA}/acct`,
      jwk: { kty: "EC", crv: "P-256" },
    });
    expect(newAccount.header?.kid).toBeUndefined();
    expect(newAccount.payload).toEqual({
      termsOfServiceAgreed: true,
      contact: ["mailto:ops@example.com"],
    });
    expect(newAccount.headers.get("user-agent")).toMatch(/roundhouse-acme/);

    expect(await client.register()).toBe(kid);

    const order = await client.newOrder(["Shop.Example.com", "shop.example.com"]);
    expect(order.url).toBe(`${CA}/o/o1`);
    expect(order.status).toBe("pending");
    const placed = server.requests.at(-1)!;
    expect(placed.header).toMatchObject({ kid, url: `${CA}/order` });
    expect(placed.payload).toEqual({ identifiers: [{ type: "dns", value: "shop.example.com" }] });

    const authz = await client.getAuthorization(order.authorizations[0]!);
    expect(server.requests.at(-1)!.payload).toBe("");
    expect(authz.identifier.value).toBe("shop.example.com");
    const challenge = authz.challenges.find((c) => c.type === "http-01")!;
    const thumbprint = await jwkThumbprint(accountKey);
    expect(await client.keyAuthorization(challenge.token)).toBe(`${challenge.token}.${thumbprint}`);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${challenge.token}.${thumbprint}`),
    );
    expect(base64UrlDecode(await client.dns01Value(challenge.token))).toEqual(
      new Uint8Array(digest),
    );

    const answered = await client.respondToChallenge(challenge.url);
    expect(server.requests.at(-1)!.payload).toEqual({});
    expect(answered.status).toBe("valid");

    const ready = await client.getOrder(order.url);
    expect(ready.status).toBe("ready");
    expect(client.lastRetryAfterMs).toBe(3000);

    const keys = await generateCertificateKey();
    const finalized = await client.finalize(
      ready.finalize,
      await createCsr(keys, ["shop.example.com"]),
    );
    expect(finalized.status).toBe("valid");
    expect(typeof (server.requests.at(-1)!.payload as { csr: string }).csr).toBe("string");

    const pem = await client.downloadCertificate(finalized.certificate!);
    expect(server.requests.at(-1)!.headers.get("accept")).toBe("application/pem-certificate-chain");
    expect(pem).toBe(chainPem.replace(/\r\n/g, "\n"));
    expect(pem.endsWith("-----END CERTIFICATE-----\n")).toBe(true);
    expect(pem.includes("\r")).toBe(false);

    expect(server.requests.filter((r) => r.method === "HEAD")).toHaveLength(1);
    expect(server.requests.filter((r) => r.url === DIRECTORY)).toHaveLength(1);
  });

  it("resumes from serialisable state without re-registering", async () => {
    const { server, accountKey, client } = await setup();
    const order = await client.newOrder(["a.example.com"]);
    const resumed = new AcmeClient({
      directoryUrl: DIRECTORY,
      accountKey: JSON.parse(JSON.stringify(accountKey)),
      accountUrl: client.accountUrl,
      fetch: server.fetch,
    });
    expect((await resumed.getOrder(order.url)).status).toBe("pending");
    expect(server.requests.filter((r) => r.url === `${CA}/acct`)).toHaveLength(1);
  });

  it("sends replaces for ARI renewals", async () => {
    const { server, client } = await setup();
    await client.newOrder(["a.example.com"], { replaces: "aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE" });
    expect(server.requests.at(-1)!.payload).toMatchObject({
      replaces: "aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE",
    });
  });

  it("surfaces a failed validation and refuses finalization", async () => {
    const { server, client } = await setup();
    server.failValidation = true;
    const order = await client.newOrder(["bad.example.com"]);
    const authz = await client.getAuthorization(order.authorizations[0]!);
    await client.respondToChallenge(authz.challenges[0]!.url);
    const after = await client.getAuthorization(order.authorizations[0]!);
    expect(after.status).toBe("invalid");
    expect(after.challenges[0]!.error?.detail).toBe("Connection refused");
    const invalid = await client.getOrder(order.url);
    expect(invalid.status).toBe("invalid");
    expect(invalid.error?.type).toBe("urn:ietf:params:acme:error:unauthorized");
    const err = await client
      .finalize(
        invalid.finalize,
        await createCsr(await generateCertificateKey(), ["bad.example.com"]),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcmeError);
    expect((err as AcmeError).is("orderNotReady")).toBe(true);
    expect((err as AcmeError).status).toBe(403);
  });

  it("requires registration before kid-signed requests", async () => {
    const { client } = await setup({ register: false });
    await expect(client.getOrder(`${CA}/o/o1`)).rejects.toThrow(/register/);
  });
});

describe("AcmeClient nonces", () => {
  it("retries badNonce with the fresh nonce the rejection carries", async () => {
    const { server, client } = await setup();
    server.rejectNonces = 2;
    const order = await client.newOrder(["a.example.com"]);
    expect(order.status).toBe("pending");
    const posts = server.requests.filter((r) => r.url === `${CA}/order`);
    expect(posts).toHaveLength(3);
    expect(new Set(posts.map((p) => p.header?.nonce)).size).toBe(3);
    expect(server.requests.filter((r) => r.method === "HEAD")).toHaveLength(1);
  });

  it("gives up after three badNonce rejections", async () => {
    const { server, client } = await setup();
    server.rejectNonces = 3;
    const err = await client.newOrder(["a.example.com"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcmeError);
    expect((err as AcmeError).type).toBe("urn:ietf:params:acme:error:badNonce");
    expect(server.requests.filter((r) => r.url === `${CA}/order`)).toHaveLength(3);
  });

  it("fetches a nonce with HEAD when the pool is empty", async () => {
    const server = new FakeAcme();
    const fetchNoNonce = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await server.fetch(input, init);
      if (init?.method === "HEAD") return res;
      const stripped = new Headers(res.headers);
      stripped.delete("replay-nonce");
      return new Response(res.body, { status: res.status, headers: stripped });
    }) as typeof fetch;
    const client = new AcmeClient({
      directoryUrl: DIRECTORY,
      accountKey: await generateAccountKey(),
      fetch: fetchNoNonce,
    });
    await client.register();
    await client.newOrder(["a.example.com"]);
    expect(server.requests.filter((r) => r.method === "HEAD")).toHaveLength(2);
  });
});

describe("AcmeClient errors", () => {
  it("parses problem documents with subproblems", async () => {
    const { server, client } = await setup();
    const subproblems = [
      {
        type: "urn:ietf:params:acme:error:rejectedIdentifier",
        detail: 'This CA will not issue for "evil.example"',
        identifier: { type: "dns", value: "evil.example" },
      },
    ];
    server.overrides.set("/order", [
      problem(400, "rejectedIdentifier", "Some identifiers were rejected", { subproblems }),
    ]);
    const err = (await client
      .newOrder(["evil.example", "ok.example"])
      .catch((e: unknown) => e)) as AcmeError;
    expect(err).toBeInstanceOf(AcmeError);
    expect(err.name).toBe("AcmeError");
    expect(err.type).toBe("urn:ietf:params:acme:error:rejectedIdentifier");
    expect(err.status).toBe(400);
    expect(err.detail).toBe("Some identifiers were rejected");
    expect(err.subproblems).toEqual(subproblems);
    expect(err.retryAfterMs).toBeNull();
    expect(err.message).toContain("Some identifiers were rejected");
  });

  it("honours Retry-After in seconds and as an HTTP date", async () => {
    const { server, client } = await setup();
    server.overrides.set("/order", [
      {
        ...problem(429, "rateLimited", "too many certificates"),
        headers: { "retry-after": "120" },
      },
      {
        ...problem(503, "serverInternal", "maintenance"),
        headers: { "retry-after": new Date(Date.now() + 3_600_000).toUTCString() },
      },
    ]);
    const limited = (await client
      .newOrder(["a.example.com"])
      .catch((e: unknown) => e)) as AcmeError;
    expect(limited.is("rateLimited")).toBe(true);
    expect(limited.retryAfterMs).toBe(120_000);
    const down = (await client.newOrder(["a.example.com"]).catch((e: unknown) => e)) as AcmeError;
    expect(down.retryAfterMs).toBeGreaterThan(3_590_000);
    expect(down.retryAfterMs).toBeLessThanOrEqual(3_600_000);
  });

  it("wraps non-problem error responses", async () => {
    const { server, client } = await setup();
    server.overrides.set("/order", [
      { status: 502, body: "<html>bad gateway</html>", headers: { "content-type": "text/html" } },
    ]);
    const err = (await client.newOrder(["a.example.com"]).catch((e: unknown) => e)) as AcmeError;
    expect(err.type).toBe("urn:roundhouse:acme:http502");
    expect(err.status).toBe(502);
    expect(err.detail).not.toContain("html");
  });

  it("rejects malformed success bodies", async () => {
    const { server, client } = await setup();
    server.overrides.set("/order", [
      { status: 201, body: { status: "pending" }, headers: { location: `${CA}/o/x` } },
    ]);
    const err = (await client.newOrder(["a.example.com"]).catch((e: unknown) => e)) as AcmeError;
    expect(err.type).toBe("urn:roundhouse:acme:malformedResponse");
  });

  it("times out stalled requests", async () => {
    const stalled = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const client = new AcmeClient({
      directoryUrl: DIRECTORY,
      accountKey: await generateAccountKey(),
      fetch: stalled,
      timeoutMs: 20,
    });
    const err = (await client.register().catch((e: unknown) => e)) as AcmeError;
    expect(err).toBeInstanceOf(AcmeError);
    expect(err.type).toBe("urn:roundhouse:acme:transport");
    expect(err.detail).toMatch(/timed out/);
  });

  it("caps response bodies", async () => {
    const huge = (async () => new Response("x".repeat(2 << 20), { status: 200 })) as typeof fetch;
    const client = new AcmeClient({
      directoryUrl: DIRECTORY,
      accountKey: await generateAccountKey(),
      fetch: huge,
    });
    await expect(client.directory()).rejects.toThrow(/too large/);
  });
});

describe("AcmeClient URL policy", () => {
  it("requires https unless allowInsecure is set", async () => {
    const accountKey = await generateAccountKey();
    expect(() => new AcmeClient({ directoryUrl: "http://ca.test/dir", accountKey })).toThrow(
      /https/,
    );
    expect(() => new AcmeClient({ directoryUrl: "not a url", accountKey })).toThrow(/invalid/);
    expect(
      () => new AcmeClient({ directoryUrl: "http://ca.test/dir", accountKey, allowInsecure: true }),
    ).not.toThrow();
  });

  it("rejects a directory or Location that downgrades to http", async () => {
    const server = new FakeAcme();
    server.directory.newOrder = "http://ca.test/order";
    const client = new AcmeClient({
      directoryUrl: DIRECTORY,
      accountKey: await generateAccountKey(),
      fetch: server.fetch,
    });
    await expect(client.directory()).rejects.toThrow(/malformed directory|https/);

    const ok = await setup();
    ok.server.overrides.set("/order", [
      {
        status: 201,
        headers: { location: "http://ca.test/o/x" },
        body: { status: "pending", identifiers: [], authorizations: [], finalize: `${CA}/fin/x` },
      },
    ]);
    await expect(ok.client.newOrder(["a.example.com"])).rejects.toThrow(/https/);
  });
});

describe("AcmeClient renewalInfo", () => {
  it("returns the suggested window and Retry-After", async () => {
    const { server, client } = await setup({ register: false });
    server.overrides.set("/ari", [
      {
        status: 200,
        headers: { "retry-after": "21600" },
        body: {
          suggestedWindow: { start: "2027-02-01T00:00:00Z", end: "2027-02-03T00:00:00Z" },
          explanationURL: `${CA}/why`,
        },
      },
    ]);
    const info = await client.renewalInfo("aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE");
    expect(info).toEqual({
      start: Date.UTC(2027, 1, 1),
      end: Date.UTC(2027, 1, 3),
      retryAfterMs: 21_600_000,
    });
    const req = server.requests.at(-1)!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`${CA}/ari/aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE`);
  });

  it("returns null without ARI support or for an unusable window", async () => {
    const { server, client } = await setup({ register: false });
    server.overrides.set("/ari", [
      {
        status: 200,
        body: { suggestedWindow: { start: "2027-02-03T00:00:00Z", end: "2027-02-01T00:00:00Z" } },
      },
      { status: 200, body: { suggestedWindow: { start: "soon" } } },
    ]);
    expect(await client.renewalInfo("AA.AA")).toBeNull();
    expect(await client.renewalInfo("AA.AA")).toBeNull();

    const noAri = new FakeAcme();
    delete noAri.directory.renewalInfo;
    const plain = new AcmeClient({
      directoryUrl: DIRECTORY,
      accountKey: await generateAccountKey(),
      fetch: noAri.fetch,
    });
    expect(await plain.renewalInfo("AA.AA")).toBeNull();
  });

  it("throws server errors and rejects malformed ids", async () => {
    const { client } = await setup({ register: false });
    await expect(client.renewalInfo("AA.AA")).rejects.toBeInstanceOf(AcmeError);
    await expect(client.renewalInfo("../x")).rejects.toThrow(/invalid ARI/);
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and dates", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter(" 30 ", now)).toBe(30_000);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("Wed, 31 Dec 2025 00:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeNull();
  });
});
