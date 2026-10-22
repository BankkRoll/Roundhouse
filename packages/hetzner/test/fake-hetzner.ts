/**
 * In-memory Hetzner Cloud API for tests, exposed as a `fetch` function.
 *
 * Implements the endpoints the package uses with the documented behaviour:
 * bearer auth (`401 unauthorized`), read-only tokens (`403 forbidden` on
 * writes), pagination via `meta.pagination`, `RateLimit-*` headers, label
 * selectors, name uniqueness (`409 uniqueness_error`), the 32 KiB `user_data`
 * limit, and actions that finish after a configurable number of polls.
 *
 * Faults are injected with {@link FakeHetzner.intercept}.
 *
 * @module
 */
import type { FetchLike } from "../src/client";
import type { Action, Firewall, Image, Location, Server, ServerType, SshKey } from "../src/types";
import {
  action,
  server as buildServer,
  errors,
  IMAGES,
  LOCATIONS,
  pricingDoc,
  SERVER_TYPES,
} from "./fixtures";

/** A request the fake received. */
export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  token: string | null;
}

/** Returns a response to short-circuit a request, or `undefined` to continue. */
export type Interceptor = (
  req: RecordedRequest,
) => Response | undefined | Promise<Response | undefined>;

type Scope = "rw" | "ro";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Builds a Hetzner error response.
 *
 * @param status - HTTP status.
 * @param code - Error code.
 * @param message - Message.
 * @param details - Details object.
 * @returns The response.
 */
export function apiError(
  status: number,
  code: string,
  message = code,
  details: unknown = null,
): Response {
  return json(status, { error: { code, message, details } });
}

/** Evaluates a Hetzner label selector against labels (the subset the package uses). */
export function matchesSelector(labels: Record<string, string>, selector: string): boolean {
  return selector
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .every((expr) => {
      let m = /^([^!=]+)!=(.*)$/.exec(expr);
      if (m) return labels[m[1]!] !== m[2];
      m = /^([^!=]+)==?(.*)$/.exec(expr);
      if (m) return labels[m[1]!] === m[2];
      if (expr.startsWith("!")) return !(expr.slice(1) in labels);
      return expr in labels;
    });
}

/** In-memory Hetzner Cloud project. */
export class FakeHetzner {
  readonly tokens = new Map<string, Scope>([
    ["rw-token", "rw"],
    ["ro-token", "ro"],
  ]);
  serverTypes: ServerType[] = structuredClone(SERVER_TYPES);
  locations: Location[] = structuredClone(LOCATIONS);
  images: Image[] = structuredClone(IMAGES);
  readonly servers = new Map<number, Server>();
  readonly firewalls = new Map<number, Firewall>();
  readonly sshKeys = new Map<number, SshKey>();
  readonly actions = new Map<number, Action & { pollsLeft: number; fail?: boolean }>();
  readonly requests: RecordedRequest[] = [];
  /** Server-side page size cap; Hetzner's is 50. */
  maxPerPage = 50;
  /** Polls before a new action finishes. */
  actionPolls = 2;
  /** Commands whose actions end in `error`. */
  failCommands = new Set<string>();
  /** Rate limit reported in headers. */
  rateLimit = { limit: 3600, remaining: 3600, reset: 1_800_000_000 };

  private interceptors: Interceptor[] = [];
  private nextId = 1000;

  /** `fetch` bound to this fake. */
  readonly fetch: FetchLike = (input, init) => this.handle(input, init);

  /**
   * Adds a fault injector; it runs before routing, in insertion order.
   *
   * @param fn - Interceptor.
   */
  intercept(fn: Interceptor): void {
    this.interceptors.push(fn);
  }

  /** Requests other than GET. */
  get mutations(): RecordedRequest[] {
    return this.requests.filter((r) => r.method !== "GET");
  }

  /**
   * Adds a server directly.
   *
   * @param s - Server to store.
   * @returns The server.
   */
  addServer(s: Server): Server {
    this.servers.set(s.id, s);
    return s;
  }

  private id(): number {
    return this.nextId++;
  }

  private newAction(command: string, resourceId: number): Action {
    const a = { ...action(this.id(), command), resources: [{ id: resourceId, type: "server" }] };
    this.actions.set(a.id, {
      ...a,
      pollsLeft: this.actionPolls,
      fail: this.failCommands.has(command),
    });
    return a;
  }

  private async handle(input: string, init: RequestInit): Promise<Response> {
    const url = new URL(input);
    const auth = new Headers(init.headers).get("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const req: RecordedRequest = {
      method: init.method ?? "GET",
      path: url.pathname.replace(/^\/v1/, ""),
      query: url.searchParams,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      token,
    };
    this.requests.push(req);
    if (init.signal?.aborted) throw init.signal.reason;
    for (const fn of this.interceptors) {
      const res = await fn(req);
      if (res) return res;
    }
    const scope = token ? this.tokens.get(token) : undefined;
    if (!scope) return apiError(401, "unauthorized", errors.unauthorized.error.message);
    if (req.method !== "GET" && scope === "ro") {
      return apiError(403, "forbidden", errors.forbidden.error.message);
    }
    this.rateLimit.remaining = Math.max(0, this.rateLimit.remaining - 1);
    const res = this.route(req);
    // An abort that lands while the request is in flight loses the response,
    // even though the change was applied.
    if (init.signal?.aborted) throw init.signal.reason;
    res.headers.set("RateLimit-Limit", String(this.rateLimit.limit));
    res.headers.set("RateLimit-Remaining", String(this.rateLimit.remaining));
    res.headers.set("RateLimit-Reset", String(this.rateLimit.reset));
    return res;
  }

  private page<T>(key: string, items: T[], query: URLSearchParams): Response {
    const perPage = Math.min(Number(query.get("per_page") ?? 25) || 25, this.maxPerPage);
    const page = Math.max(1, Number(query.get("page") ?? 1) || 1);
    const last = Math.max(1, Math.ceil(items.length / perPage));
    return json(200, {
      [key]: items.slice((page - 1) * perPage, page * perPage),
      meta: {
        pagination: {
          page,
          per_page: perPage,
          previous_page: page > 1 ? page - 1 : null,
          next_page: page < last ? page + 1 : null,
          last_page: last,
          total_entries: items.length,
        },
      },
    });
  }

  private route(req: RecordedRequest): Response {
    const { method, path, query } = req;
    const q = (k: string) => query.get(k);
    const byLabels = <T extends { labels: Record<string, string> }>(items: T[]) => {
      const sel = q("label_selector");
      return sel ? items.filter((i) => matchesSelector(i.labels, sel)) : items;
    };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sshKeyPath = /^\/ssh_keys\/(\d+)$/.exec(path);
    const applyPath = /^\/firewalls\/(\d+)\/actions\/apply_to_resources$/.exec(path);
    const serverPath = /^\/servers\/(\d+)$/.exec(path);
    const powerPath = /^\/servers\/(\d+)\/actions\/(poweron|poweroff|shutdown|reboot|reset)$/.exec(
      path,
    );

    if (method === "GET" && path === "/locations")
      return this.page("locations", this.locations, query);
    if (method === "GET" && path === "/pricing") return json(200, pricingDoc);
    if (method === "GET" && path === "/server_types") {
      const name = q("name");
      return this.page(
        "server_types",
        this.serverTypes.filter((t) => !name || t.name === name),
        query,
      );
    }
    if (method === "GET" && path === "/images") {
      const items = this.images.filter(
        (i) =>
          (!q("type") || i.type === q("type")) &&
          (!q("status") || i.status === q("status")) &&
          (!q("name") || i.name === q("name")) &&
          (!q("architecture") || i.architecture === q("architecture")),
      );
      return this.page("images", items, query);
    }

    if (method === "GET" && path === "/ssh_keys") {
      const items = byLabels([...this.sshKeys.values()]).filter(
        (k) => !q("name") || k.name === q("name"),
      );
      return this.page("ssh_keys", items, query);
    }
    if (method === "POST" && path === "/ssh_keys") {
      const name = String(body.name ?? "");
      const key = String(body.public_key ?? "");
      if (!name || !key) {
        return apiError(422, "invalid_input", "invalid input", {
          fields: [{ name: name ? "public_key" : "name", messages: ["is required"] }],
        });
      }
      const dup = [...this.sshKeys.values()].find(
        (k) =>
          k.name === name ||
          k.public_key.split(" ").slice(0, 2).join(" ") === key.split(" ").slice(0, 2).join(" "),
      );
      if (dup) return json(409, errors.uniqueness_error);
      const k: SshKey = {
        id: this.id(),
        name,
        public_key: key,
        fingerprint: "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff",
        labels: (body.labels as Record<string, string>) ?? {},
        created: "2026-10-22T00:00:00Z",
      };
      this.sshKeys.set(k.id, k);
      return json(201, { ssh_key: k });
    }
    if (method === "DELETE" && sshKeyPath) {
      return this.sshKeys.delete(Number(sshKeyPath[1]))
        ? json(204, undefined)
        : apiError(404, "not_found");
    }

    if (method === "GET" && path === "/firewalls") {
      const items = byLabels([...this.firewalls.values()]).filter(
        (f) => !q("name") || f.name === q("name"),
      );
      return this.page("firewalls", items, query);
    }
    if (method === "POST" && path === "/firewalls") {
      const name = String(body.name ?? "");
      if ([...this.firewalls.values()].some((f) => f.name === name)) {
        return apiError(409, "uniqueness_error", "name is already used", {
          fields: [{ name: "name" }],
        });
      }
      const f: Firewall = {
        id: this.id(),
        name,
        labels: (body.labels as Record<string, string>) ?? {},
        created: "2026-10-22T00:00:00Z",
        rules: (body.rules as Firewall["rules"]) ?? [],
        applied_to: [],
      };
      this.firewalls.set(f.id, f);
      return json(201, { firewall: f, actions: [] });
    }
    if (method === "POST" && applyPath) {
      const f = this.firewalls.get(Number(applyPath[1]));
      if (!f) return apiError(404, "not_found");
      const a = this.newAction("apply_firewall", f.id);
      return json(201, { actions: [a] });
    }

    if (method === "GET" && path === "/servers") {
      const items = byLabels([...this.servers.values()]).filter(
        (s) => (!q("name") || s.name === q("name")) && (!q("status") || s.status === q("status")),
      );
      return this.page("servers", items, query);
    }
    if (method === "POST" && path === "/servers") {
      const name = String(body.name ?? "");
      if ([...this.servers.values()].some((s) => s.name === name)) {
        return apiError(409, "uniqueness_error", "server name is already used", {
          fields: [{ name: "name" }],
        });
      }
      if (
        typeof body.user_data === "string" &&
        new TextEncoder().encode(body.user_data).byteLength > 32 * 1024
      ) {
        return apiError(422, "invalid_input", "user_data too long", {
          fields: [{ name: "user_data" }],
        });
      }
      const type = this.serverTypes.find((t) => t.name === body.server_type);
      const loc = this.locations.find((l) => l.name === body.location);
      if (!type || !loc) return apiError(422, "invalid_input", "unknown server type or location");
      const id = this.id();
      const s = buildServer({
        id,
        name,
        status: "initializing",
        labels: (body.labels as Record<string, string>) ?? {},
        server_type: type,
        location: loc,
      });
      this.servers.set(id, s);
      const create = this.newAction("create_server", id);
      const start = this.newAction("start_server", id);
      return json(201, {
        server: s,
        action: create,
        next_actions: [start],
        root_password: "YItygq1v3GYjjMomLaKc",
      });
    }
    if (serverPath) {
      const s = this.servers.get(Number(serverPath[1]));
      if (!s) return apiError(404, "not_found", errors.not_found.error.message);
      if (method === "GET") return json(200, { server: s });
      if (method === "DELETE") {
        this.servers.delete(s.id);
        return json(200, { action: this.newAction("delete_server", s.id) });
      }
    }
    if (method === "POST" && powerPath) {
      const s = this.servers.get(Number(powerPath[1]));
      if (!s) return apiError(404, "not_found");
      return json(201, { action: this.newAction(`${powerPath[2]}_server`, s.id) });
    }

    if (method === "GET" && path === "/actions") {
      const ids = query.getAll("id").map(Number);
      if (ids.length === 0)
        return apiError(410, "deprecated_api_endpoint", "listing all actions was removed");
      const out: Action[] = [];
      for (const id of ids) {
        const a = this.actions.get(id);
        if (!a) continue;
        if (a.status === "running") {
          a.pollsLeft--;
          if (a.pollsLeft <= 0) {
            a.status = a.fail ? "error" : "success";
            a.progress = 100;
            a.finished = "2026-10-22T00:01:00Z";
            if (a.fail) a.error = { code: "action_failed", message: `${a.command} failed` };
            if (!a.fail && a.command === "start_server") {
              const s = this.servers.get(a.resources[0]!.id);
              if (s) s.status = "running";
            }
          }
        }
        const { pollsLeft: _p, fail: _f, ...pub } = a;
        out.push(structuredClone(pub));
      }
      return json(200, { actions: out });
    }

    return apiError(404, "not_found", `no route for ${method} ${path}`);
  }
}
