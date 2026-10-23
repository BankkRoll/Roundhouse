import { describe, expect, it } from "vitest";
import { ProviderActionError, ProviderApiError } from "../../src/errors";
import { parseHetznerError } from "../../src/hetzner";
import { hetznerError } from "../fakes/hetzner";
import { errors, server } from "../fixtures/hetzner";
import { setup, hetzner as target } from "../targets";

const make = (o: Parameters<typeof setup>[1] = {}) => {
  const h = setup(target, o);
  return { ...h, client: h.driver.client };
};

describe("pagination", () => {
  it("follows meta.pagination.next_page, 50 per page", async () => {
    const { fake, client } = make();
    for (let i = 1; i <= 120; i++) fake.addServer(server({ id: i, name: `s${i}` }));
    const all = await client.listServers();
    expect(all.map((s) => s.id)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    expect(fake.requests.map((r) => [r.query.get("page"), r.query.get("per_page")])).toEqual([
      ["1", "50"],
      ["2", "50"],
      ["3", "50"],
    ]);
  });

  it("respects a smaller server-side page size", async () => {
    const { fake, client } = make();
    fake.maxPerPage = 2;
    expect(await client.listLocations()).toHaveLength(4);
    expect(fake.requests).toHaveLength(2);
  });

  it("stops on a missing or non-advancing next_page", async () => {
    const { fake, client } = make();
    let calls = 0;
    fake.intercept((r) => {
      if (r.path !== "/locations") return undefined;
      calls++;
      return new Response(
        JSON.stringify({
          locations: [{ id: calls }],
          meta: { pagination: { page: 1, next_page: 1 } },
        }),
      );
    });
    expect(await client.listLocations()).toHaveLength(1);
    expect(calls).toBe(1);
  });
});

describe("rate limiting", () => {
  it("tracks the RateLimit headers", async () => {
    const { fake, client } = make();
    await client.listLocations();
    expect(client.http.rateLimit).toEqual({
      limit: 3600,
      remaining: fake.rateLimit.remaining,
      resetAt: fake.rateLimit.reset * 1000,
    });
  });

  it("retries 429 with backoff no shorter than the refill interval", async () => {
    const { fake, client, clock } = make();
    let n = 0;
    fake.intercept(() => (n++ < 2 ? hetznerError(429, "rate_limit_exceeded") : undefined));
    expect(await client.listLocations()).toHaveLength(4);
    expect(clock.sleeps).toHaveLength(2);
    // 3600/h restores one request per second.
    for (const s of clock.sleeps) expect(s).toBeGreaterThanOrEqual(1000);
    expect(clock.sleeps[1]).toBeGreaterThan(clock.sleeps[0]!);
  });

  it("honours Retry-After", async () => {
    const { fake, client, clock } = make();
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
    expect(clock.sleeps).toEqual([7000]);
  });

  it("waits before sending once RateLimit-Remaining hits 0", async () => {
    const { fake, client, clock } = make();
    fake.rateLimit = { limit: 7200, remaining: 1, reset: Math.floor(clock.now / 1000) + 3600 };
    await client.listLocations();
    expect(client.http.rateLimit.remaining).toBe(0);
    await client.listLocations();
    // 7200/h restores one request every 500 ms.
    expect(clock.sleeps).toEqual([500]);
  });

  it("resends a create rejected with 409 conflict, but not one that hit a gateway timeout", async () => {
    const { fake, client } = make();
    let n = 0;
    fake.intercept((r) =>
      r.method === "POST" && n++ === 0 ? hetznerError(409, "conflict") : undefined,
    );
    await client.createSshKey({ name: "k", public_key: "ssh-ed25519 AAAA" });
    expect(fake.sshKeys.size).toBe(1);

    const { fake: f2, client: c2 } = make();
    f2.intercept((r) => (r.method === "POST" ? hetznerError(504, "timeout") : undefined));
    await expect(c2.createSshKey({ name: "k", public_key: "x" })).rejects.toMatchObject({
      providerCode: "timeout",
    });
    expect(f2.mutations).toHaveLength(1);
  });
});

describe("error mapping", () => {
  it("maps documented error bodies to normalised codes, keeping Hetzner's", () => {
    const cases: [number, unknown, string, string][] = [
      [401, errors.unauthorized, "unauthorized", "unauthorized"],
      [403, errors.forbidden, "forbidden", "forbidden"],
      [422, errors.invalid_input, "invalid_input", "invalid_input"],
      [409, errors.uniqueness_error, "conflict", "uniqueness_error"],
      [403, errors.resource_limit_exceeded, "quota_exceeded", "resource_limit_exceeded"],
      [429, errors.rate_limit_exceeded, "rate_limited", "rate_limit_exceeded"],
      [404, errors.not_found, "not_found", "not_found"],
    ];
    for (const [status, body, code, providerCode] of cases) {
      const e = parseHetznerError(status, JSON.stringify(body));
      expect(e).toMatchObject({ provider: "hetzner", status, code, providerCode });
    }
    expect(parseHetznerError(422, JSON.stringify(errors.invalid_input)).details).toEqual({
      fields: [{ name: "broken_field", messages: ["is too long"] }],
    });
  });

  it("sets the retry policy from Hetzner's code", () => {
    expect(parseHetznerError(409, '{"error":{"code":"conflict","message":""}}').retry).toBe(
      "always",
    );
    expect(parseHetznerError(409, JSON.stringify(errors.uniqueness_error)).retry).toBe("never");
    expect(parseHetznerError(504, '{"error":{"code":"timeout","message":""}}').retry).toBe(
      "idempotent",
    );
    expect(parseHetznerError(500, '{"error":{"code":"bad_gateway","message":""}}').retry).toBe(
      "idempotent",
    );
  });

  it("maps a non-JSON body to http_<status>", () => {
    expect(parseHetznerError(500, "<html>Bad Gateway</html>")).toMatchObject({
      code: "unavailable",
      providerCode: "http_500",
    });
  });
});

describe("validateToken", () => {
  it("probes write access with an invalid POST and creates nothing", async () => {
    const { fake, client } = make();
    expect(await client.validateToken()).toEqual({ valid: true, canWrite: true });
    expect(fake.sshKeys.size).toBe(0);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /locations",
      "POST /ssh_keys",
    ]);
  });

  it("deletes a key if the probe ever created one", async () => {
    const { fake, client } = make();
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
    const { fake, client } = make({ maxRetries: 0 });
    fake.intercept(() => hetznerError(503, "unavailable"));
    await expect(client.validateToken()).rejects.toBeInstanceOf(ProviderApiError);
  });
});

describe("actions", () => {
  it("polls until every action succeeds, batching IDs", async () => {
    const { fake, client, clock } = make();
    fake.bootPolls = 3;
    const res = await client.createServer({
      name: "a",
      server_type: "cx23",
      location: "fsn1",
      image: "1",
    });
    const done = await client.waitForActions([res.action, res.next_actions[0]!.id]);
    expect(done.map((x) => x.status)).toEqual(["success", "success"]);
    expect(done.map((x) => x.command)).toEqual(["create_server", "start_server"]);
    expect(clock.sleeps).toEqual([1000, 1500, 2250]);
    const polls = fake.requests.filter((r) => r.path === "/actions");
    expect(polls.every((r) => r.query.getAll("id").length === 2)).toBe(true);
  });

  it("throws ProviderActionError when an action fails or times out", async () => {
    const { fake, client } = make();
    fake.failCommands.add("start_server");
    const res = await client.createServer({
      name: "a",
      server_type: "cx23",
      location: "fsn1",
      image: "1",
    });
    const err = await client.waitForActions(res.next_actions).catch((e: ProviderActionError) => e);
    expect(err).toBeInstanceOf(ProviderActionError);
    expect(err).toMatchObject({ command: "start_server", code: "action_failed" });

    fake.neverBoot = true;
    const res2 = await client.createServer({
      name: "b",
      server_type: "cx23",
      location: "fsn1",
      image: "1",
    });
    const timeout = await client
      .waitForActions([res2.action], { timeoutMs: 10_000 })
      .catch((e: ProviderActionError) => e);
    expect(timeout).toMatchObject({ code: "action_timeout" });
  });

  it("returns already-finished actions without polling", async () => {
    const { fake, client } = make();
    const done = await client.waitForActions([{ id: 1, command: "x", status: "success" } as never]);
    expect(done).toHaveLength(1);
    expect(fake.requests).toHaveLength(0);
  });
});
