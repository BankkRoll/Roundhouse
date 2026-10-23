/**
 * In-memory Hetzner Cloud API.
 *
 * Implements the endpoints the adapter uses with the documented behaviour:
 * bearer auth (`401 unauthorized`), read-only tokens (`403 forbidden` on
 * writes), pagination via `meta.pagination`, `RateLimit-*` headers, label
 * selectors, name uniqueness (`409 uniqueness_error`), the 32 KiB `user_data`
 * limit, and actions that finish after a configurable number of polls.
 *
 * @module
 */
import type {
  Action,
  Firewall,
  Image,
  Location,
  Server,
  ServerType,
  SshKey,
} from "../../src/hetzner/types";
import {
  action,
  server as buildServer,
  errors,
  IMAGES,
  LOCATIONS,
  pricingDoc,
  SERVER_TYPES,
} from "../fixtures/hetzner";
import { FakeApi, json, type RecordedRequest, type SeedServer } from "./base";

/**
 * Builds a Hetzner error response.
 *
 * @param status - HTTP status.
 * @param code - Error code.
 * @param message - Message.
 * @param details - Details object.
 * @returns The response.
 */
export function hetznerError(
  status: number,
  code: string,
  message = code,
  details: unknown = null,
): Response {
  return json(status, { error: { code, message, details } });
}

/** Evaluates a Hetzner label selector against labels (the subset the adapter uses). */
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

/** The root password the fake returns from `POST /servers`. */
export const HETZNER_ROOT_PASSWORD = "YItygq1v3GYjjMomLaKc";

/** In-memory Hetzner Cloud project. */
export class FakeHetzner extends FakeApi {
  protected readonly prefix = "/v1";
  serverTypes: ServerType[] = structuredClone(SERVER_TYPES);
  locations: Location[] = structuredClone(LOCATIONS);
  images: Image[] = structuredClone(IMAGES);
  readonly servers = new Map<number, Server>();
  readonly firewalls = new Map<number, Firewall>();
  readonly sshKeys = new Map<number, SshKey>();
  readonly actions = new Map<number, Action & { pollsLeft: number; fail?: boolean }>();
  /** Server-side page size cap; Hetzner's is 50. */
  maxPerPage = 50;
  /** Commands whose actions end in `error`. */
  failCommands = new Set<string>();
  /** Rate limit reported in headers. */
  rateLimit = { limit: 3600, remaining: 3600, reset: 1_800_000_000 };
  override readonly secrets = [HETZNER_ROOT_PASSWORD];

  /** Adds a server directly. */
  addServer(s: Server): Server {
    this.servers.set(s.id, s);
    return s;
  }

  seedServer(spec: SeedServer): string {
    const id = this.id();
    this.addServer(
      buildServer({ id, name: spec.name, labels: spec.labels, status: spec.status ?? "running" }),
    );
    return String(id);
  }

  serverIds(): string[] {
    return [...this.servers.keys()].map(String);
  }

  firewallCount(): number {
    return this.firewalls.size;
  }

  sshKeyCount(): number {
    return this.sshKeys.size;
  }

  isCreate(req: RecordedRequest): boolean {
    return req.method === "POST" && req.path === "/servers";
  }

  isDelete(req: RecordedRequest): boolean {
    return req.method === "DELETE" && req.path.startsWith("/servers/");
  }

  errorResponse(status: number, message = "error"): Response {
    const code =
      status === 429
        ? "rate_limit_exceeded"
        : status === 504
          ? "timeout"
          : status === 503
            ? "unavailable"
            : "server_error";
    return hetznerError(status, code, message);
  }

  protected unauthorized(): Response {
    return hetznerError(401, "unauthorized", errors.unauthorized.error.message);
  }

  protected forbidden(): Response {
    return hetznerError(403, "forbidden", errors.forbidden.error.message);
  }

  protected override decorate(res: Response): void {
    this.rateLimit.remaining = Math.max(0, this.rateLimit.remaining - 1);
    res.headers.set("RateLimit-Limit", String(this.rateLimit.limit));
    res.headers.set("RateLimit-Remaining", String(this.rateLimit.remaining));
    res.headers.set("RateLimit-Reset", String(this.rateLimit.reset));
  }

  private newAction(command: string, resourceId: number): Action {
    const a = { ...action(this.id(), command), resources: [{ id: resourceId, type: "server" }] };
    this.actions.set(a.id, {
      ...a,
      pollsLeft: this.bootPolls,
      fail: this.failCommands.has(command),
    });
    return a;
  }

  /** Advances an action by one poll; a finished `start_server` starts its server. */
  private tick(a: Action & { pollsLeft: number; fail?: boolean }): void {
    if (a.status !== "running" || (this.neverBoot && a.command !== "delete_server")) return;
    a.pollsLeft--;
    if (a.pollsLeft > 0) return;
    a.status = a.fail ? "error" : "success";
    a.progress = 100;
    a.finished = "2026-10-22T00:01:00Z";
    if (a.fail) a.error = { code: "action_failed", message: `${a.command} failed` };
    if (!a.fail && a.command === "start_server") {
      const s = this.servers.get(a.resources[0]!.id);
      if (s) s.status = "running";
    }
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

  protected route(req: RecordedRequest): Response {
    const { method, path, query } = req;
    const q = (k: string) => query.get(k);
    const byLabels = <T extends { labels: Record<string, string> }>(items: T[]) => {
      const sel = q("label_selector");
      return sel ? items.filter((i) => matchesSelector(i.labels, sel)) : items;
    };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sshKeyPath = /^\/ssh_keys\/(\d+)$/.exec(path);
    const serverPath = /^\/servers\/(\d+)$/.exec(path);

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
      return this.page("ssh_keys", byLabels([...this.sshKeys.values()]), query);
    }
    if (method === "POST" && path === "/ssh_keys") {
      const name = String(body.name ?? "");
      const key = String(body.public_key ?? "");
      if (!name || !key) {
        return hetznerError(422, "invalid_input", "invalid input", {
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
        : hetznerError(404, "not_found");
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
        return hetznerError(409, "uniqueness_error", "name is already used", {
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

    if (method === "GET" && path === "/servers") {
      const items = byLabels([...this.servers.values()]).filter(
        (s) => !q("name") || s.name === q("name"),
      );
      return this.page("servers", items, query);
    }
    if (method === "POST" && path === "/servers") {
      const name = String(body.name ?? "");
      if ([...this.servers.values()].some((s) => s.name === name)) {
        return hetznerError(409, "uniqueness_error", "server name is already used", {
          fields: [{ name: "name" }],
        });
      }
      if (
        typeof body.user_data === "string" &&
        new TextEncoder().encode(body.user_data).byteLength > 32 * 1024
      ) {
        return hetznerError(422, "invalid_input", "user_data too long", {
          fields: [{ name: "user_data" }],
        });
      }
      const type = this.serverTypes.find((t) => t.name === body.server_type);
      const loc = this.locations.find((l) => l.name === body.location);
      if (!type || !loc)
        return hetznerError(422, "invalid_input", "unknown server type or location");
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
        root_password: HETZNER_ROOT_PASSWORD,
      });
    }
    if (serverPath) {
      const s = this.servers.get(Number(serverPath[1]));
      if (!s) return hetznerError(404, "not_found", errors.not_found.error.message);
      if (method === "GET") {
        // The server progresses whether or not anyone polls its actions.
        for (const a of this.actions.values()) if (a.resources[0]?.id === s.id) this.tick(a);
        return json(200, { server: s });
      }
      if (method === "DELETE") {
        this.servers.delete(s.id);
        return json(200, { action: this.newAction("delete_server", s.id) });
      }
    }

    if (method === "GET" && path === "/actions") {
      const ids = query.getAll("id").map(Number);
      if (ids.length === 0)
        return hetznerError(410, "deprecated_api_endpoint", "listing all actions was removed");
      const out: Action[] = [];
      for (const id of ids) {
        const a = this.actions.get(id);
        if (!a) continue;
        this.tick(a);
        const { pollsLeft: _p, fail: _f, ...pub } = a;
        out.push(structuredClone(pub));
      }
      return json(200, { actions: out });
    }

    return hetznerError(404, "not_found", `no route for ${method} ${path}`);
  }
}
