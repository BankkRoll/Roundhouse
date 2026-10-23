import { describe, expect, it } from "vitest";
import {
  ProviderApiError,
  ProviderError,
  ProviderNetworkError,
  ProviderTimeoutError,
} from "../src/errors";
import {
  abortableSleep,
  collect,
  encodeQuery,
  type FetchLike,
  HttpClient,
  type HttpClientConfig,
  MAX_PAGES,
  pollUntil,
  retryAfterSeconds,
} from "../src/http";
import { T0, virtualClock } from "./helpers";

/** A scripted API: each call takes the next response (or throws it). */
function scripted(responses: (Response | Error | (() => Response))[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift() ?? new Response("{}", { status: 200 });
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  return { fetch, calls };
}

const ok = (body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers });
const fail = (status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ code: `e${status}` }), { status, headers });

function parseError(status: number, text: string): ProviderApiError {
  const code =
    status === 429
      ? "rate_limited"
      : status >= 500
        ? "unavailable"
        : status === 409
          ? "conflict"
          : "unknown";
  const body = text ? (JSON.parse(text) as { code?: string }) : {};
  return new ProviderApiError({
    provider: "hetzner",
    status,
    code,
    providerCode: body.code ?? `http_${status}`,
    message: "x",
    // The "rejected" conflict models Hetzner's retryable `conflict`.
    retry: body.code === "rejected" ? "always" : undefined,
  });
}

function client(fetch: FetchLike, config: Partial<HttpClientConfig> = {}) {
  const clock = virtualClock();
  const http = new HttpClient({
    provider: "hetzner",
    baseUrl: "https://api.example.com/v1/",
    headers: { authorization: "Bearer t" },
    parseError,
    fetch,
    ...clock.transport,
    ...config,
  });
  return { http, clock };
}

describe("request basics", () => {
  it("sends auth, JSON, user agent, and repeated array query params", async () => {
    const { fetch, calls } = scripted([ok({ a: 1 })]);
    const { http } = client(fetch);
    expect(
      await http.request("POST", "/x", {
        body: { k: "v" },
        query: { id: [1, 2], skip: undefined },
      }),
    ).toEqual({ a: 1 });
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.example.com/v1/x?id=1&id=2");
    const h = new Headers(init.headers);
    expect(h.get("authorization")).toBe("Bearer t");
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("user-agent")).toMatch(/^roundhouse-providers\//);
    expect(init.body).toBe('{"k":"v"}');
  });

  it("returns undefined for empty bodies and exposes headers with send", async () => {
    const { fetch } = scripted([new Response(null, { status: 204 }), ok({}, { "x-a": "1" })]);
    const { http } = client(fetch);
    expect(await http.request("DELETE", "/x")).toBeUndefined();
    expect((await http.send("GET", "/x")).headers.get("x-a")).toBe("1");
  });

  it("encodes queries", () => {
    expect(encodeQuery(undefined)).toBe("");
    expect(encodeQuery({ a: undefined })).toBe("");
    expect(encodeQuery({ a: true, b: "x y" })).toBe("?a=true&b=x+y");
  });
});

describe("retries and idempotency", () => {
  it("retries a 429 for every method, since the provider did not act", async () => {
    const { fetch, calls } = scripted([fail(429), ok()]);
    const { http, clock } = client(fetch);
    await http.request("POST", "/servers", { body: {} });
    expect(calls).toHaveLength(2);
    expect(clock.sleeps).toHaveLength(1);
  });

  it("retries an error the adapter marks as rejected (retry: always) for POST", async () => {
    const { fetch, calls } = scripted([new Response('{"code":"rejected"}', { status: 409 }), ok()]);
    const { http } = client(fetch);
    await http.request("POST", "/x", { body: {} });
    expect(calls).toHaveLength(2);
  });

  it("retries gateway errors for idempotent methods only", async () => {
    const get = scripted([fail(502), fail(503), fail(504), ok()]);
    await client(get.fetch).http.request("GET", "/x");
    expect(get.calls).toHaveLength(4);
    const post = scripted([fail(504)]);
    const err = await client(post.fetch)
      .http.request<never>("POST", "/x", { body: {} })
      .catch((e: ProviderApiError) => e);
    expect(err).toBeInstanceOf(ProviderApiError);
    expect(err.retry).toBe("idempotent");
    expect(post.calls).toHaveLength(1);
  });

  it("does not retry other errors", async () => {
    const { fetch, calls } = scripted([fail(500), fail(400)]);
    const { http } = client(fetch);
    await expect(http.request("GET", "/x")).rejects.toMatchObject({ status: 500 });
    await expect(http.request("GET", "/x")).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(2);
  });

  it("retries network errors for GET but never for POST", async () => {
    const get = scripted([new TypeError("reset"), ok({ v: 1 })]);
    expect(await client(get.fetch).http.request("GET", "/x")).toEqual({ v: 1 });
    const post = scripted([new TypeError("reset")]);
    const err = await client(post.fetch)
      .http.request<never>("POST", "/x", { body: {} })
      .catch((e: ProviderNetworkError) => e);
    expect(err).toBeInstanceOf(ProviderNetworkError);
    expect(err.provider).toBe("hetzner");
    expect(post.calls).toHaveLength(1);
  });

  it("times out a hung request", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    const { http } = client(hang, { timeoutMs: 10, maxRetries: 0 });
    const err = await http.request<never>("GET", "/x").catch((e: ProviderTimeoutError) => e);
    expect(err).toBeInstanceOf(ProviderTimeoutError);
    expect(err.timeoutMs).toBe(10);
  });

  it("gives up after maxRetries and caps every backoff", async () => {
    const { fetch } = scripted(Array.from({ length: 10 }, () => fail(429)));
    const { http, clock } = client(fetch, { maxRetries: 8, maxBackoffMs: 5000 });
    await expect(http.request("GET", "/x")).rejects.toMatchObject({ code: "rate_limited" });
    expect(clock.sleeps).toHaveLength(8);
    expect(Math.max(...clock.sleeps)).toBeLessThanOrEqual(5000);
  });

  it("backs off exponentially with equal jitter", async () => {
    const { fetch } = scripted([fail(503), fail(503), fail(503), ok()]);
    const { http, clock } = client(fetch, { baseBackoffMs: 1000 });
    await http.request("GET", "/x");
    // random() = 0.5: half the delay plus a quarter.
    expect(clock.sleeps).toEqual([750, 1500, 3000]);
  });
});

describe("Retry-After and rate-limit headers", () => {
  it("honours Retry-After in seconds and as an HTTP date", async () => {
    const date = new Date(T0 + 9_000).toUTCString();
    const { fetch } = scripted([
      fail(429, { "retry-after": "7" }),
      fail(429, { "retry-after": date }),
      ok(),
    ]);
    const { http, clock } = client(fetch);
    await http.request("GET", "/x");
    expect(clock.sleeps[0]).toBe(7000);
    expect(clock.sleeps[1]).toBeGreaterThanOrEqual(1000);
    expect(clock.sleeps[1]).toBeLessThanOrEqual(9000);
  });

  it("parses Retry-After", () => {
    const h = (v: string) => new Headers({ "retry-after": v });
    expect(retryAfterSeconds(h("12"), 0)).toBe(12);
    expect(retryAfterSeconds(h(new Date(60_000).toUTCString()), 0)).toBe(60);
    expect(retryAfterSeconds(h("soon"), 0)).toBeNull();
    expect(retryAfterSeconds(new Headers(), 0)).toBeNull();
  });

  const linear = {
    limitHeader: "ratelimit-limit",
    remainingHeader: "ratelimit-remaining",
    resetHeader: "ratelimit-reset",
    resetUnit: "epoch-seconds" as const,
    windowMs: 3_600_000,
    refill: "linear" as const,
  };

  it("tracks the headers and waits one refill interval once the budget is spent", async () => {
    const reset = String(Math.floor(T0 / 1000) + 3600);
    const { fetch } = scripted([
      ok({}, { "ratelimit-limit": "7200", "ratelimit-remaining": "0", "ratelimit-reset": reset }),
      ok(),
    ]);
    const { http, clock } = client(fetch, { rateLimit: linear });
    await http.request("GET", "/x");
    expect(http.rateLimit).toEqual({ limit: 7200, remaining: 0, resetAt: Number(reset) * 1000 });
    await http.request("GET", "/x");
    // 7200/h refills one request every 500 ms.
    expect(clock.sleeps).toEqual([500]);
  });

  it("waits for the window to reset with a fixed-window limit", async () => {
    const reset = String(Math.floor(T0 / 1000) + 20);
    const { fetch } = scripted([
      ok(
        {},
        { "x-ratelimit-limit": "20", "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset },
      ),
      ok(),
    ]);
    const { http, clock } = client(fetch, {
      rateLimit: {
        limitHeader: "x-ratelimit-limit",
        remainingHeader: "x-ratelimit-remaining",
        resetHeader: "x-ratelimit-reset",
        resetUnit: "epoch-seconds",
        windowMs: 60_000,
        refill: "window",
      },
    });
    await http.request("GET", "/x");
    await http.request("GET", "/x");
    expect(clock.sleeps).toEqual([20_000]);
  });

  it("supports a reset given in seconds from now", async () => {
    const { fetch } = scripted([
      ok({}, { "ratelimit-limit": "10", "ratelimit-remaining": "3", "ratelimit-reset": "5" }),
    ]);
    const { http } = client(fetch, { rateLimit: { ...linear, resetUnit: "delta-seconds" } });
    await http.request("GET", "/x");
    expect(http.rateLimit.resetAt).toBe(T0 + 5000);
  });

  it("uses at least the refill interval to back off a 429", async () => {
    const reset = String(Math.floor(T0 / 1000) + 3600);
    const { fetch } = scripted([
      fail(429, {
        "ratelimit-limit": "3600",
        "ratelimit-remaining": "5",
        "ratelimit-reset": reset,
      }),
      ok(),
    ]);
    const { http, clock } = client(fetch, { rateLimit: linear, baseBackoffMs: 100 });
    await http.request("GET", "/x");
    expect(clock.sleeps).toEqual([1000]);
  });
});

describe("abort", () => {
  it("propagates the caller's abort reason, also during backoff", async () => {
    const { fetch } = scripted(Array.from({ length: 10 }, () => fail(429)));
    const http = new HttpClient({
      provider: "vultr",
      baseUrl: "https://x",
      headers: {},
      parseError,
      fetch,
      sleep: abortableSleep,
      baseBackoffMs: 60_000,
    });
    const ctrl = new AbortController();
    const p = http.request("GET", "/x", { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(new Error("user cancelled")), 5);
    await expect(p).rejects.toThrow("user cancelled");
    const pre = new AbortController();
    pre.abort(new Error("already"));
    await expect(http.request("GET", "/x", { signal: pre.signal })).rejects.toThrow("already");
  });

  it("abortableSleep resolves, and rejects early on abort", async () => {
    await abortableSleep(1);
    const ctrl = new AbortController();
    const p = abortableSleep(60_000, ctrl.signal);
    ctrl.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });
});

describe("pagination", () => {
  it("collects every page", async () => {
    const pages: Record<number, { items: number[]; next: number | null }> = {
      1: { items: [1, 2], next: 2 },
      2: { items: [3], next: null },
    };
    expect(await collect("/x", 1, async (p) => pages[p]!)).toEqual([1, 2, 3]);
  });

  it("stops on a repeated cursor", async () => {
    let calls = 0;
    const items = await collect("/x", "a", async () => {
      calls++;
      return { items: [calls], next: "a" };
    });
    expect(items).toEqual([1]);
  });

  it("throws past the page guard", async () => {
    const err = await collect("/x", 0, async (p) => ({ items: [], next: p + 1 })).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain(String(MAX_PAGES));
  });
});

describe("pollUntil", () => {
  it("polls with growing intervals capped at 5 s", async () => {
    const clock = virtualClock();
    let n = 0;
    const v = await pollUntil(
      { sleep: clock.transport.sleep, now: clock.transport.now },
      async () => (++n === 6 ? "done" : undefined),
      { onTimeout: () => new Error("timeout") },
    );
    expect(v).toBe("done");
    expect(clock.sleeps).toEqual([1000, 1500, 2250, 3375, 5000]);
  });

  it("throws the timeout error after the deadline", async () => {
    const clock = virtualClock();
    const err = await pollUntil(
      { sleep: clock.transport.sleep, now: clock.transport.now },
      async () => undefined,
      { timeoutMs: 3000, onTimeout: () => new Error("too slow") },
    ).catch((e) => e);
    expect(err.message).toBe("too slow");
  });
});
