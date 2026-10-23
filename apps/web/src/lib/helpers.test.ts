import { PRODUCT_NAME, ROLES } from "@roundhouse/shared";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "../queries/keys";
import { ApiError } from "./api/client";
import { formatDocumentTitle } from "./document-title";
import { generateMasterKey, MASTER_KEY_COMMAND } from "./master-key";
import { assignableRoles, canCreateWorkspace } from "./permissions";
import { isApplePlatform } from "./platform";
import { createQueryClient, shouldRetry } from "./query-client";
import { safeRedirect } from "./safe-redirect";

describe("generateMasterKey", () => {
  it("returns 32 random bytes as base64 by default", () => {
    const key = generateMasterKey();
    expect(key).toHaveLength(44);
    expect(key).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(atob(key)).toHaveLength(32);
  });

  it("honours a custom length", () => {
    expect(atob(generateMasterKey(16))).toHaveLength(16);
  });

  it("does not repeat", () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateMasterKey()));
    expect(keys.size).toBe(50);
  });

  it("uses the platform CSPRNG", () => {
    const spy = vi.spyOn(crypto, "getRandomValues");
    generateMasterKey();
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("documents the wrangler command", () => {
    expect(MASTER_KEY_COMMAND).toBe("npx wrangler secret put MASTER_KEY");
  });
});

describe("safeRedirect", () => {
  it.each(["/", "/w/ws_1/servers", "/w/ws_1/servers?tab=1#x", "/invite/tok_1"])(
    "keeps same-origin path %s",
    (path) => {
      expect(safeRedirect(path)).toBe(path);
    },
  );

  it.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "w/ws_1",
    "/w/ws_1\u0000",
    "/w/ws_1\n",
    "",
    "/login",
    "/login?redirect=/x",
    "/setup",
  ])("rejects %j", (path) => {
    expect(safeRedirect(path)).toBe("/dashboard");
  });

  it("rejects non-strings and uses the fallback", () => {
    expect(safeRedirect(undefined)).toBe("/dashboard");
    expect(safeRedirect(42, "/home")).toBe("/home");
  });
});

describe("shouldRetry", () => {
  it("retries network errors and 5xx up to twice", () => {
    expect(shouldRetry(0, new ApiError(0, "network_error", ""))).toBe(true);
    expect(shouldRetry(1, new ApiError(503, "x", ""))).toBe(true);
    expect(shouldRetry(2, new ApiError(503, "x", ""))).toBe(false);
  });

  it("never retries client errors or unknown errors", () => {
    expect(shouldRetry(0, new ApiError(401, "unauthorized", ""))).toBe(false);
    expect(shouldRetry(0, new ApiError(404, "not_found", ""))).toBe(false);
    expect(shouldRetry(0, new Error("boom"))).toBe(false);
  });
});

describe("createQueryClient", () => {
  it("calls onUnauthorized when a query fails with 401", async () => {
    const onUnauthorized = vi.fn();
    const client = createQueryClient({ onUnauthorized, retry: false });
    await client
      .fetchQuery({
        queryKey: ["x"],
        queryFn: () => Promise.reject(new ApiError(401, "unauthorized", "")),
      })
      .catch(() => {});
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("leaves a 401 on /v1/me to the route guards", async () => {
    const onUnauthorized = vi.fn();
    const client = createQueryClient({ onUnauthorized, retry: false });
    await client
      .fetchQuery({
        queryKey: queryKeys.me,
        queryFn: () => Promise.reject(new ApiError(401, "unauthorized", "")),
      })
      .catch(() => {});
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("calls onUnauthorized when a mutation fails with 401 but not for 403", async () => {
    const onUnauthorized = vi.fn();
    const client = createQueryClient({ onUnauthorized });
    const run = (status: number) =>
      client
        .getMutationCache()
        .build(client, { mutationFn: () => Promise.reject(new ApiError(status, "x", "")) })
        .execute(undefined)
        .catch(() => {});
    await run(403);
    expect(onUnauthorized).not.toHaveBeenCalled();
    await run(401);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});

describe("canCreateWorkspace", () => {
  const user = (instance_admin?: boolean) => ({
    user: { id: "usr_1", name: "U", email: "u@example.com", image: null, instance_admin },
  });

  it("allows instance admins only", () => {
    expect(canCreateWorkspace(user(true))).toBe(true);
  });

  it("refuses everyone else, workspace owners included, and unknown sessions", () => {
    expect(canCreateWorkspace(user(false))).toBe(false);
    expect(canCreateWorkspace(user())).toBe(false);
    expect(canCreateWorkspace(undefined)).toBe(false);
  });
});

describe("isApplePlatform", () => {
  const nav = (fields: Record<string, unknown>) =>
    ({ userAgent: "", ...fields }) as unknown as Navigator;

  it("prefers User-Agent Client Hints", () => {
    expect(isApplePlatform(nav({ userAgentData: { platform: "macOS" } }))).toBe(true);
    expect(
      isApplePlatform(nav({ userAgentData: { platform: "Windows" }, userAgent: "Macintosh" })),
    ).toBe(false);
  });

  it("falls back to the user agent string", () => {
    expect(isApplePlatform(nav({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0)" }))).toBe(true);
    expect(isApplePlatform(nav({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }))).toBe(false);
    expect(isApplePlatform(undefined)).toBe(false);
  });
});

describe("formatDocumentTitle", () => {
  it("joins the parts with the product name and skips blanks", () => {
    expect(formatDocumentTitle("Servers", "Nightjar Labs")).toBe(
      `Servers · Nightjar Labs · ${PRODUCT_NAME}`,
    );
    expect(formatDocumentTitle("Sign in", undefined, " ")).toBe(`Sign in · ${PRODUCT_NAME}`);
  });
});

describe("assignableRoles", () => {
  it("lets owners assign every role", () => {
    expect(assignableRoles("owner", ROLES)).toEqual(["owner", "admin", "member", "viewer"]);
  });

  it("keeps admins from granting ownership", () => {
    expect(assignableRoles("admin", ROLES)).toEqual(["admin", "member", "viewer"]);
  });

  it("gives members and viewers nothing", () => {
    expect(assignableRoles("member", ROLES)).toEqual([]);
    expect(assignableRoles("viewer", ROLES)).toEqual([]);
    expect(assignableRoles(undefined, ROLES)).toEqual([]);
  });
});
