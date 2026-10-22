import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { db, PASSWORD, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { server } from "../../mocks/server";
import { ApiError, api, errorMessage, isApiError, request } from "./client";

describe("request", () => {
  it("parses JSON and sends cookies and JSON headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    let seen: Request | undefined;
    server.use(
      http.post("*/v1/echo", async ({ request: req }) => {
        seen = req;
        return HttpResponse.json({ got: await req.json() });
      }),
    );
    const result = await request<{ got: unknown }>("POST", "/v1/echo", { body: { a: 1 } });
    expect(result).toEqual({ got: { a: 1 } });
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: "POST", credentials: "include" });
    expect(seen?.headers.get("content-type")).toBe("application/json");
    expect(seen?.headers.get("accept")).toBe("application/json");
    fetchSpy.mockRestore();
  });

  it("omits content-type when there is no body", async () => {
    let contentType: string | null = "unset";
    server.use(
      http.get("*/v1/echo", ({ request: req }) => {
        contentType = req.headers.get("content-type");
        return HttpResponse.json({});
      }),
    );
    await request("GET", "/v1/echo");
    expect(contentType).toBeNull();
  });

  it("resolves to undefined for 204 No Content", async () => {
    server.use(http.delete("*/v1/thing", () => new HttpResponse(null, { status: 204 })));
    await expect(request("DELETE", "/v1/thing")).resolves.toBeUndefined();
  });

  it("resolves to undefined for an empty 200 body", async () => {
    server.use(http.post("*/v1/thing", () => new HttpResponse("", { status: 200 })));
    await expect(request("POST", "/v1/thing")).resolves.toBeUndefined();
  });

  it("turns a non-JSON 2xx body into an ApiError instead of a SyntaxError", async () => {
    server.use(
      http.get("*/v1/me", () => new HttpResponse("<!doctype html><html></html>", { status: 200 })),
    );
    const error = await request("GET", "/v1/me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 200, code: "invalid_response" });
  });

  it("serialises query parameters and skips empty ones", async () => {
    let url: URL | undefined;
    server.use(
      http.get("*/v1/search", ({ request: req }) => {
        url = new URL(req.url);
        return HttpResponse.json({});
      }),
    );
    await request("GET", "/v1/search", {
      query: { cursor: "aud 1/2", limit: 50, skip: undefined, none: null, blank: "" },
    });
    expect(url?.searchParams.get("cursor")).toBe("aud 1/2");
    expect(url?.searchParams.get("limit")).toBe("50");
    expect([...(url?.searchParams.keys() ?? [])]).toEqual(["cursor", "limit"]);
  });

  it("throws an ApiError built from the error envelope", async () => {
    server.use(
      http.post("*/v1/setup", () =>
        HttpResponse.json(
          { error: { code: "already_setup", message: "Setup is already done." } },
          { status: 409 },
        ),
      ),
    );
    const error = await request("POST", "/v1/setup", { body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: "ApiError",
      status: 409,
      code: "already_setup",
      message: "Setup is already done.",
    });
  });

  it("falls back to http_<status> when the body is not the envelope", async () => {
    server.use(
      http.get("*/v1/me", () =>
        HttpResponse.json({ detail: "nope" }, { status: 500, statusText: "Internal Server Error" }),
      ),
    );
    const error = await request("GET", "/v1/me").catch((e: unknown) => e);
    expect(error).toMatchObject({
      status: 500,
      code: "http_500",
      message: "Internal Server Error",
    });
  });

  it("reads Better Auth's flat { code, message } errors", async () => {
    server.use(
      http.post("*/api/auth/sign-in/email", () =>
        HttpResponse.json(
          { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
          { status: 401 },
        ),
      ),
    );
    const error = await api.signIn({ email: "a@example.com", password: "x" }).catch((e) => e);
    expect(error).toMatchObject({
      status: 401,
      code: "invalid_email_or_password",
      message: "Invalid email or password",
    });
  });

  it("handles non-JSON error bodies such as a proxy's HTML 502", async () => {
    server.use(
      http.get("*/v1/me", () => new HttpResponse("<html>Bad gateway</html>", { status: 502 })),
    );
    const error = await request("GET", "/v1/me").catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, code: "http_502" });
    expect((error as ApiError).message).toMatch(/502|Bad Gateway/i);
  });

  it("rejects envelopes with the wrong field types", async () => {
    server.use(
      http.get("*/v1/me", () =>
        HttpResponse.json({ error: { code: 7, message: null } }, { status: 400 }),
      ),
    );
    const error = await request("GET", "/v1/me").catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 400, code: "http_400" });
  });

  it("maps network failures to status 0 / network_error", async () => {
    server.use(http.get("*/v1/me", () => HttpResponse.error()));
    const error = await request("GET", "/v1/me").catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: "network_error" });
  });

  it("rethrows aborts untouched so TanStack Query can cancel quietly", async () => {
    server.use(http.get("*/v1/me", () => new Promise(() => {})));
    const controller = new AbortController();
    const pending = request("GET", "/v1/me", { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as Error).name).toBe("AbortError");
  });
});

describe("api endpoints", () => {
  it("encodes path segments", async () => {
    let pathname = "";
    server.use(
      http.get("*/v1/workspaces/:ws/nodes/:node", ({ request: req }) => {
        pathname = new URL(req.url).pathname;
        return HttpResponse.json({});
      }),
    );
    await api.getNode("ws/../x", "node?1");
    expect(pathname).toBe("/v1/workspaces/ws%2F..%2Fx/nodes/node%3F1");
  });

  it("unwraps nothing: list endpoints return the documented envelope", async () => {
    const { nodes } = await api.listNodes(WORKSPACE_ID);
    expect(nodes.map((node) => node.name)).toEqual(["fsn-1", "hel-1"]);
  });

  it("signs in and out through Better Auth with JSON bodies", async () => {
    signInAs(null);
    const bodies: unknown[] = [];
    server.events.on("request:start", async ({ request: req }) => {
      if (new URL(req.url).pathname.startsWith("/api/auth/")) {
        bodies.push(await req.clone().json());
      }
    });
    const { user } = await api.signIn({ email: USERS.admin.email, password: PASSWORD });
    expect(user.id).toBe(USERS.admin.id);
    expect(db.sessionUserId).toBe(USERS.admin.id);
    await api.signOut();
    expect(db.sessionUserId).toBeNull();
    expect(bodies).toEqual([{ email: USERS.admin.email, password: PASSWORD }, {}]);
    server.events.removeAllListeners();
  });

  it("surfaces 401 for signed-out callers", async () => {
    server.use(
      http.get("*/v1/me", () =>
        HttpResponse.json({ error: { code: "unauthorized", message: "Sign in" } }, { status: 401 }),
      ),
    );
    await expect(api.getMe()).rejects.toMatchObject({ status: 401 });
  });

  it("passes cursor and limit to the audit log", async () => {
    let url: URL | undefined;
    server.use(
      http.get("*/v1/workspaces/:ws/audit-logs", ({ request: req }) => {
        url = new URL(req.url);
        return HttpResponse.json({ items: [], next_cursor: null });
      }),
    );
    await api.listAuditLogs(WORKSPACE_ID, { cursor: "aud_9", limit: 25 });
    expect(url?.searchParams.get("cursor")).toBe("aud_9");
    expect(url?.searchParams.get("limit")).toBe("25");
  });
});

describe("isApiError", () => {
  const error = new ApiError(403, "forbidden", "No");

  it("narrows ApiError instances", () => {
    expect(isApiError(error)).toBe(true);
    expect(isApiError(new Error("x"))).toBe(false);
    expect(isApiError({ status: 403, code: "forbidden" })).toBe(false);
    expect(isApiError(null)).toBe(false);
  });

  it("matches by status or by code", () => {
    expect(isApiError(error, 403)).toBe(true);
    expect(isApiError(error, 401)).toBe(false);
    expect(isApiError(error, "forbidden")).toBe(true);
    expect(isApiError(error, "not_found")).toBe(false);
  });
});

describe("errorMessage", () => {
  it("prefers the error's message", () => {
    expect(errorMessage(new ApiError(400, "x", "Bad input"))).toBe("Bad input");
  });

  it("falls back for empty or non-error values", () => {
    expect(errorMessage(new Error(""))).toBe("Something went wrong.");
    expect(errorMessage("boom", "Fallback")).toBe("Fallback");
    expect(errorMessage(undefined)).toBe("Something went wrong.");
  });
});
