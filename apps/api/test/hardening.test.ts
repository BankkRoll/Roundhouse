/**
 * Regression tests for the ADR 0014 findings that this contracts pass already
 * closes. Each security stream adds its own blocks here (one `describe` per
 * finding) as it lands.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, install } from "./helpers";

describe("cache: API and auth responses are never stored", () => {
  it.each(["/v1/setup", "/v1/me", "/v1/does-not-exist", "/api/auth/get-session"])(
    "sets no-store, private and varies on Cookie for %s",
    async (path) => {
      const res = await call(path);
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(res.headers.get("vary")?.toLowerCase()).toContain("cookie");
    },
  );
});

describe("F3: instance:manage comes from the instance-admin flag only", () => {
  it("makes the setup user an instance admin", async () => {
    const { userId } = await install();
    const row = await env.DB.prepare("SELECT instance_admin FROM users WHERE id = ?")
      .bind(userId)
      .first<{ instance_admin: number }>();
    expect(row?.instance_admin).toBe(1);
  });

  it("refuses instance settings to a workspace owner who isn't an instance admin", async () => {
    const { owner, userId } = await install();
    await env.DB.prepare("UPDATE users SET instance_admin = 0 WHERE id = ?").bind(userId).run();
    expect((await owner.request("/v1/instance/settings")).status).toBe(403);
  });
});
