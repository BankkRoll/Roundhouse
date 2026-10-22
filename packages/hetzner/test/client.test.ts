import { describe, expect, it } from "vitest";
import { abortableSleep, HetznerClient } from "../src/client";
import {
  HetznerActionError,
  HetznerApiError,
  HetznerNetworkError,
  HetznerTimeoutError,
} from "../src/errors";
import { apiError } from "./fake-hetzner";
import { errors, server } from "./fixtures";
import { harness } from "./helpers";

describe("transport", () => {
  it("sends bearer auth, JSON, and repeated array query params", async () => {
    const { fake, client } = harness();
    await client.getActions([1, 2]);
    await client.createSshKey({ name: "k", public_key: "ssh-ed25519 AAAA" });
    expect(fake.requests[0]!.token).toBe("rw-token");
    expect(fake.requests[0]!.query.getAll("id")).toEqual(["1", "2"]);
    expect(fake.requests[1]!.body).toEqual({ name: "k", public_key: "ssh-ed25519 AAAA" });
  });

  it("rejects an empty or whitespace token up front", () => {
    expect(() => new HetznerClient({ token: " " })).toThrow(TypeError);
    expect(() => new HetznerClient({ token: "a b" })).toThrow(TypeError);
  });

  it("tracks the RateLimit headers", async () => {
    const { fake, client } = harness();
    await client.listLocations();
    expect(client.rateLimit).toEqual({
      limit: 3600,
      remaining: fake.rateLimit.remaining,
      resetAt: fake.rateLimit.reset * 1000,
    });
  });
});

describe("pagination", () => {
  it("follows meta.pagination.next_page across pages", async () => {
    const { fake, client } = harness();
    for (let i = 1; i <= 120; i++) fake.addServer(server({ id: i, name: `s${i}` }));
    const all = await client.listServers();
    expect(all.map((s) => s.id)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    const pages = fake.requests.map((r) => [r.query.get("page"), r.query.get("per_page")]);
    expect(pages).toEqual([
      ["1", "50"],
      ["2", "50"],
      ["3", "50"],
    ]);
  });

  it("respects a smaller server-side page size", async () => {
    const { fake, client } = harness();
    fake.maxPerPage = 2;
    const locations = await client.listLocations();
    expect(locations).toHaveLength(4);
    expect(fake.requests).toHaveLength(2);
  });

  it("stops on a missing or non-advancing next_page", async () => {
    const { fake, client } = harness();
    let calls = 0;
    fake.intercept((r) => {
      if (r.path !== "/locations") return undefined;
      calls++;
      return new Response(
        JSON.stringify({
          locations: [{ id: calls }],
          meta: { pagination: { page: 1, next_page: 1 } },
        }),
        { status: 200 },
      );
    });
    expect(await client.listLocations()).toHaveLength(1);
    expect(calls).toBe(1);
  });
});

describe("rate limiting", () => {
  it("retries 429 with backoff no shorter than the refill interval", async () => {
    const { fake, client, sleeps } = harness();
    let n = 0;
    fake.intercept(() => (n++ < 2 ? apiError(429, "rate_limit_exceeded") : undefined));
    expect(await client.listLocations()).toHaveLength(4);
    expect(sleeps).toHaveLength(2);
    // 3600/h restores one request per second.
    for (const s of sleeps) expect(s).toBeGreaterThanOrEqual(1000);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]!);
  });

  it("treats a 429 without a JSON body as rate limited", async () => {
    const { fake, client, sleeps } = harness();
    let n = 0;
    fake.intercept(() => (n++ === 0 ? new Response("slow down", { status: 429 }) : undefined));
    await client.listLocations();
    expect(sleeps).toHaveLength(1);
  });

  it("honours Retry-After", async () => {
    const { fake, client, sleeps } = harness();
    let n = 0;
    fake.intercept(() =>
      n++ === 0
        ? new Response(JSON.stringify(errors.rate_limit_exceeded), {
            status: 429,
            headers: { "retry-after": "7" },
          })
        : undefined,
    );
    await client.listLocations();
    expect(sleeps).toEqual([7000]);
  });

  it("retries 429 even for POST, since Hetzner did not act on it", async () => {
    const { fake, client } = harness();
    let n = 0;
    fake.intercept((r) =>
      r.method === "POST" && n++ === 0 ? apiError(429, "rate_limit_exceeded") : undefined,
    );
    await client.createSshKey({ name: "k", public_key: "ssh-ed25519 AAAA" });
    expect(fake.sshKeys.size).toBe(1);
  });

  it("gives up after maxRetries", async () => {
    const { fake, client, sleeps } = harness({ maxRetries: 2 });
    fake.intercept(() => apiError(429, "rate_limit_exceeded"));
    const err = await client.listLocations().catch((e) => e);
    expect(err).toBeInstanceOf(HetznerApiError);
    expect(err.code).toBe("rate_limit_exceeded");
    expect(sleeps).toHaveLength(2);
  });

  it("waits before sending once RateLimit-Remaining hits 0", async () => {
    const { fake, client, sleeps, clock } = harness();
    fake.rateLimit = { limit: 7200, remaining: 1, reset: Math.floor(clock.now / 1000) + 3600 };
    await client.listLocations();
    expect(client.rateLimit.remaining).toBe(0);
    await client.listLocations();
    // 7200/h restores one request every 500 ms.
    expect(sleeps).toEqual([500]);
  });

  it("caps backoff at maxBackoffMs", async () => {
    const { fake, client, sleeps } = harness({ maxRetries: 8, maxBackoffMs: 5000 });
    let n = 0;
    fake.intercept(() => (n++ < 8 ? apiError(429, "rate_limit_exceeded") : undefined));
    await client.listLocations();
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(5000);
  });
});

describe("transient failures", () => {
  it("retries idempotent requests on 502/504", async () => {
    const { fake, client } = harness();
    let n = 0;
    fake.intercept(() =>
      n++ === 0 ? apiError(502, "bad_gateway") : n === 2 ? apiError(504, "timeout") : undefined,
    );
    expect(await client.listLocations()).toHaveLength(4);
  });

  it("does not retry POST on a gateway error, because it may have been applied", async () => {
    const { fake, client } = harness();
    fake.intercept((r) => (r.method === "POST" ? apiError(504, "timeout") : undefined));
    await expect(client.createSshKey({ name: "k", public_key: "x" })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(fake.mutations).toHaveLength(1);
  });

  it("retries 409 conflict for any method", async () => {
    const { fake, client } = harness();
    let n = 0;
    fake.intercept((r) =>
      r.method === "POST" && n++ === 0 ? apiError(409, "conflict") : undefined,
    );
    await client.createSshKey({ name: "k", public_key: "ssh-ed25519 AAAA" });
    expect(fake.sshKeys.size).toBe(1);
  });

  it("maps fetch failures to HetznerNetworkError and retries GETs", async () => {
    let n = 0;
    const { client } = harness({
      fetch: async () => {
        if (n++ === 0) throw new TypeError("connection reset");
        return new Response(
          JSON.stringify({ locations: [], meta: { pagination: { next_page: null } } }),
        );
      },
    });
    expect(await client.listLocations()).toEqual([]);
    const { client: once } = harness({
      maxRetries: 0,
      fetch: async () => {
        throw new TypeError("connection reset");
      },
    });
    await expect(once.listLocations()).rejects.toBeInstanceOf(HetznerNetworkError);
  });

  it("times out a hung request", async () => {
    const hang = (_: string, init: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    const { client } = harness({ fetch: hang, timeoutMs: 10, maxRetries: 0 });
    const err = await client.listLocations().catch((e) => e);
    expect(err).toBeInstanceOf(HetznerTimeoutError);
    expect(err.timeoutMs).toBe(10);
  });

  it("propagates the caller's abort reason, also during backoff", async () => {
    const { fake, client } = harness({ sleep: abortableSleep, baseBackoffMs: 60_000 });
    fake.intercept(() => apiError(429, "rate_limit_exceeded"));
    const ctrl = new AbortController();
    const p = client.listLocations({ signal: ctrl.signal });
    setTimeout(() => ctrl.abort(new Error("user cancelled")), 5);
    await expect(p).rejects.toThrow("user cancelled");

    const pre = new AbortController();
    pre.abort(new Error("already"));
    await expect(client.listLocations({ signal: pre.signal })).rejects.toThrow("already");
  });
});

describe("error mapping", () => {
  it("maps documented error bodies", async () => {
    const { fake, client } = harness();
    fake.intercept((r) => {
      if (r.path === "/ssh_keys" && r.method === "POST")
        return new Response(JSON.stringify(errors.invalid_input), { status: 422 });
      if (r.path === "/firewalls")
        return new Response(JSON.stringify(errors.resource_limit_exceeded), { status: 403 });
      return undefined;
    });
    const invalid = await client.createSshKey({ name: "a", public_key: "b" }).catch((e) => e);
    expect(invalid).toBeInstanceOf(HetznerApiError);
    expect(invalid.status).toBe(422);
    expect(invalid.code).toBe("invalid_input");
    expect(invalid.fields).toEqual([{ name: "broken_field", messages: ["is too long"] }]);
    const limit = await client.listFirewalls().catch((e) => e);
    expect(limit.code).toBe("resource_limit_exceeded");
    expect(limit.isForbidden).toBe(false);
    expect(limit.details).toEqual({ limits: [{ name: "project_limit" }] });
  });

  it("maps 401, 403, and 404", async () => {
    const { client: bad } = harness({ token: "nope" });
    expect((await bad.listLocations().catch((e) => e)).isUnauthorized).toBe(true);
    const { client: ro } = harness({ token: "ro-token" });
    expect((await ro.deleteServer(1).catch((e) => e)).isForbidden).toBe(true);
    const { client } = harness();
    const nf = await client.getServer(999).catch((e) => e);
    expect(nf.isNotFound).toBe(true);
    expect(nf.code).toBe("not_found");
  });

  it("maps a non-JSON error body to http_<status>", async () => {
    const { fake, client } = harness({ maxRetries: 0 });
    fake.intercept(() => new Response("<html>Bad Gateway</html>", { status: 500 }));
    const err = await client.listLocations().catch((e) => e);
    expect(err.code).toBe("http_500");
    expect(err.status).toBe(500);
  });
});

describe("validateToken", () => {
  it("reports an invalid token", async () => {
    const { client } = harness({ token: "nope" });
    expect(await client.validateToken()).toEqual({ valid: false });
  });

  it("reports a read-only token", async () => {
    const { client } = harness({ token: "ro-token" });
    expect(await client.validateToken()).toEqual({ valid: true, canWrite: false });
  });

  it("reports a read/write token without creating anything", async () => {
    const { fake, client } = harness();
    expect(await client.validateToken()).toEqual({ valid: true, canWrite: true });
    expect(fake.sshKeys.size).toBe(0);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /locations",
      "POST /ssh_keys",
    ]);
  });

  it("deletes a key if the probe ever created one", async () => {
    const { fake, client } = harness();
    fake.intercept((r) => {
      if (r.method === "POST" && r.path === "/ssh_keys") {
        fake.sshKeys.set(5, { id: 5 } as never);
        return new Response(JSON.stringify({ ssh_key: { id: 5 } }), { status: 201 });
      }
      return undefined;
    });
    expect(await client.validateToken()).toEqual({ valid: true, canWrite: true });
    expect(fake.sshKeys.size).toBe(0);
  });

  it("throws on server errors instead of guessing", async () => {
    const { fake, client } = harness({ maxRetries: 0 });
    fake.intercept(() => apiError(503, "unavailable"));
    await expect(client.validateToken()).rejects.toBeInstanceOf(HetznerApiError);
  });
});

describe("actions", () => {
  it("polls until every action succeeds, batching IDs", async () => {
    const { fake, client, sleeps } = harness();
    fake.actionPolls = 3;
    const s = fake.addServer(server({ id: 7, name: "a" }));
    const a = await client.power(s.id, "reboot");
    const b = await client.power(s.id, "shutdown");
    const done = await client.waitForActions([a, b.id]);
    expect(done.map((x) => x.status)).toEqual(["success", "success"]);
    expect(done.map((x) => x.command)).toEqual(["reboot_server", "shutdown_server"]);
    expect(sleeps).toEqual([1000, 1500, 2250]);
    const polls = fake.requests.filter((r) => r.path === "/actions");
    expect(polls.every((r) => r.query.getAll("id").length === 2)).toBe(true);
  });

  it("throws HetznerActionError when an action fails", async () => {
    const { fake, client } = harness();
    fake.failCommands.add("poweron_server");
    fake.addServer(server({ id: 7, name: "a" }));
    const a = await client.power(7, "poweron");
    const err = await client.waitForActions([a]).catch((e) => e);
    expect(err).toBeInstanceOf(HetznerActionError);
    expect(err.command).toBe("poweron_server");
    expect(err.code).toBe("action_failed");
  });

  it("times out", async () => {
    const { fake, client } = harness();
    fake.actionPolls = 1000;
    fake.addServer(server({ id: 7, name: "a" }));
    const a = await client.power(7, "poweron");
    const err = await client.waitForActions([a], { timeoutMs: 10_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(HetznerActionError);
    expect(err.code).toBe("action_timeout");
  });

  it("returns already-finished actions without polling", async () => {
    const { fake, client } = harness();
    const done = await client.waitForActions([{ id: 1, command: "x", status: "success" } as never]);
    expect(done).toHaveLength(1);
    expect(fake.requests).toHaveLength(0);
  });
});
