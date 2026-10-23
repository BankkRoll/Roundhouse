/**
 * In-memory DigitalOcean API v2.
 *
 * Documented behaviour it models: `{id, message}` errors, read-only tokens
 * (`403 forbidden` on writes), `page`/`per_page` pagination with
 * `links.pages.next`, `ratelimit-*` headers, the tag grammar (and the
 * `{error, root_causes}` body for bad tags), firewalls that may only target
 * existing tags, `202` creates tracked by actions, `204` deletes, and the
 * 64 KiB `user_data` limit.
 *
 * @module
 */
import { DIGITALOCEAN_TAG, DIGITALOCEAN_TAGS } from "../../src/digitalocean/mapping";
import type {
  DoAction,
  DoDroplet,
  DoFirewall,
  DoImage,
  DoRegion,
  DoSize,
  DoSshKey,
} from "../../src/digitalocean/types";
import { accountDoc, droplet, errors, IMAGES, REGIONS, SIZES } from "../fixtures/digitalocean";
import { FakeApi, json, type RecordedRequest, type SeedServer } from "./base";

/**
 * Builds a DigitalOcean error response.
 *
 * @param status - HTTP status.
 * @param id - Error id.
 * @param message - Message.
 * @returns The response.
 */
export function doError(status: number, id: string, message = id): Response {
  return json(status, { id, message });
}

/** In-memory DigitalOcean account. */
export class FakeDigitalOcean extends FakeApi {
  protected readonly prefix = "/v2";
  sizes: DoSize[] = structuredClone(SIZES);
  regions: DoRegion[] = structuredClone(REGIONS);
  images: DoImage[] = structuredClone(IMAGES);
  readonly droplets = new Map<number, DoDroplet>();
  readonly firewalls = new Map<string, DoFirewall>();
  readonly sshKeys = new Map<number, DoSshKey>();
  readonly tags = new Set<string>();
  readonly actions = new Map<number, DoAction & { pollsLeft: number }>();
  /** Server-side page size cap; DigitalOcean's is 200. */
  maxPerPage = 200;
  /** Rate limit reported in headers. */
  rateLimit = { limit: 5000, remaining: 5000, reset: 1_800_000_000 };
  /** The root password is emailed, never returned, so nothing can leak. */
  override readonly secrets: string[] = [];
  private fwSeq = 0;

  seedServer(spec: SeedServer): string {
    const id = this.id();
    this.droplets.set(
      id,
      droplet({ id, name: spec.name, tags: DIGITALOCEAN_TAGS.encode(spec.labels) }),
    );
    return String(id);
  }

  serverIds(): string[] {
    return [...this.droplets.keys()].map(String);
  }

  firewallCount(): number {
    return this.firewalls.size;
  }

  sshKeyCount(): number {
    return this.sshKeys.size;
  }

  isCreate(req: RecordedRequest): boolean {
    // validateToken probes this endpoint with an empty body; only a named body creates.
    return (
      req.method === "POST" &&
      req.path === "/droplets" &&
      Boolean((req.body as { name?: unknown })?.name)
    );
  }

  isDelete(req: RecordedRequest): boolean {
    return req.method === "DELETE" && req.path.startsWith("/droplets");
  }

  errorResponse(status: number, message = "error"): Response {
    const id =
      status === 429 ? "too_many_requests" : status >= 500 ? "server_error" : "bad_request";
    return doError(status, id, message);
  }

  protected unauthorized(): Response {
    return json(401, errors.unauthorized);
  }

  protected forbidden(): Response {
    return json(403, errors.forbidden);
  }

  protected override decorate(res: Response): void {
    this.rateLimit.remaining = Math.max(0, this.rateLimit.remaining - 1);
    res.headers.set("ratelimit-limit", String(this.rateLimit.limit));
    res.headers.set("ratelimit-remaining", String(this.rateLimit.remaining));
    res.headers.set("ratelimit-reset", String(this.rateLimit.reset));
  }

  private page<T>(key: string, items: T[], req: RecordedRequest): Response {
    const perPage = Math.min(Number(req.query.get("per_page") ?? 20) || 20, this.maxPerPage);
    const page = Math.max(1, Number(req.query.get("page") ?? 1) || 1);
    const last = Math.max(1, Math.ceil(items.length / perPage));
    const link = (p: number) =>
      `https://api.digitalocean.com/v2${req.path}?page=${p}&per_page=${perPage}`;
    const pages: Record<string, string> = {};
    if (page < last) {
      pages.next = link(page + 1);
      pages.last = link(last);
    }
    if (page > 1) {
      pages.first = link(1);
      pages.prev = link(page - 1);
    }
    return json(200, {
      [key]: items.slice((page - 1) * perPage, page * perPage),
      links: { pages },
      meta: { total: items.length },
    });
  }

  private tick(a: DoAction & { pollsLeft: number }): void {
    if (a.status !== "in-progress" || this.neverBoot) return;
    a.pollsLeft--;
    if (a.pollsLeft > 0) return;
    a.status = "completed";
    a.completed_at = "2026-10-22T00:01:00Z";
    const d = a.resource_id === null ? undefined : this.droplets.get(a.resource_id);
    if (d) {
      d.status = "active";
      d.networks = droplet({ id: d.id, name: d.name }).networks;
    }
  }

  protected route(req: RecordedRequest): Response {
    const { method, path, query } = req;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const dropletPath = /^\/droplets\/(\d+)$/.exec(path);
    const actionPath = /^\/actions\/(\d+)$/.exec(path);
    const firewallPath = /^\/firewalls\/([\w-]+)$/.exec(path);

    if (method === "GET" && path === "/account") return json(200, accountDoc);
    if (method === "GET" && path === "/sizes") return this.page("sizes", this.sizes, req);
    if (method === "GET" && path === "/regions") return this.page("regions", this.regions, req);
    if (method === "GET" && path === "/images") {
      const type = query.get("type");
      return this.page("images", type === "distribution" ? this.images : [], req);
    }

    if (method === "POST" && path === "/tags") {
      const name = String(body.name ?? "");
      if (!DIGITALOCEAN_TAG.test(name)) return json(400, errors.tags_bad_request);
      this.tags.add(name);
      return json(201, { tag: { name, resources: { count: 0 } } });
    }

    if (method === "GET" && path === "/account/keys")
      return this.page("ssh_keys", [...this.sshKeys.values()], req);
    if (method === "POST" && path === "/account/keys") {
      const key = String(body.public_key ?? "");
      if (!body.name || !key) return json(422, errors.unprocessable_entity);
      const material = key.split(" ").slice(0, 2).join(" ");
      if (
        [...this.sshKeys.values()].some(
          (k) => k.public_key.split(" ").slice(0, 2).join(" ") === material,
        )
      ) {
        return doError(422, "unprocessable_entity", "SSH Key is already in use on your account");
      }
      const k: DoSshKey = {
        id: this.id(),
        name: String(body.name),
        public_key: key,
        fingerprint: "3b:16:bf:e4",
      };
      this.sshKeys.set(k.id, k);
      return json(201, { ssh_key: k });
    }

    if (method === "GET" && path === "/firewalls")
      return this.page("firewalls", [...this.firewalls.values()], req);
    if (method === "GET" && firewallPath) {
      const fw = this.firewalls.get(firewallPath[1]!);
      return fw ? json(200, { firewall: fw }) : json(404, errors.not_found);
    }
    if (method === "POST" && path === "/firewalls") {
      const name = String(body.name ?? "");
      const inbound = (body.inbound_rules as DoFirewall["inbound_rules"]) ?? [];
      const outbound = (body.outbound_rules as DoFirewall["outbound_rules"]) ?? [];
      if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+$/.test(name) || inbound.length + outbound.length === 0) {
        return json(422, errors.unprocessable_entity);
      }
      const tags = (body.tags as string[]) ?? [];
      if (tags.some((t) => !this.tags.has(t)))
        return doError(422, "unprocessable_entity", "tag does not exist");
      const id = `bb4b2611-3d72-467b-8602-${String(++this.fwSeq).padStart(12, "0")}`;
      const fw: DoFirewall = {
        id,
        name,
        status: "waiting",
        inbound_rules: inbound,
        outbound_rules: outbound,
        created_at: "2026-10-22T00:00:00Z",
        droplet_ids: [],
        tags,
      };
      this.firewalls.set(id, fw);
      return json(202, { firewall: fw });
    }

    if (method === "GET" && path === "/droplets") {
      const tag = query.get("tag_name");
      const name = query.get("name");
      const items = [...this.droplets.values()].filter(
        (d) =>
          (!tag || d.tags.includes(tag)) && (!name || d.name.toLowerCase() === name.toLowerCase()),
      );
      return this.page("droplets", items, req);
    }
    if (method === "DELETE" && path === "/droplets") {
      // Documented: deletes every droplet with the tag. The adapter must never send it.
      for (const d of [...this.droplets.values()]) {
        if (d.tags.includes(query.get("tag_name") ?? "")) this.droplets.delete(d.id);
      }
      return json(204, undefined);
    }
    if (method === "POST" && path === "/droplets") {
      if (!body.name || !body.size || !body.image) return json(422, errors.unprocessable_entity);
      const tags = (body.tags as string[]) ?? [];
      if (tags.some((t) => !DIGITALOCEAN_TAG.test(t))) return json(400, errors.tags_bad_request);
      if (
        typeof body.user_data === "string" &&
        new TextEncoder().encode(body.user_data).byteLength > 64 * 1024
      ) {
        return json(422, errors.unprocessable_entity);
      }
      const size = this.sizes.find((s) => s.slug === body.size);
      if (!size?.regions.includes(String(body.region))) {
        return doError(422, "unprocessable_entity", "size is not available in this region");
      }
      for (const t of tags) this.tags.add(t);
      const id = this.id();
      const d = droplet({
        id,
        name: String(body.name),
        status: "new",
        networks: { v4: [], v6: [] },
        tags,
        size_slug: size.slug,
        region: { slug: String(body.region), name: String(body.region) },
      });
      this.droplets.set(id, d);
      const actionId = this.id();
      this.actions.set(actionId, {
        id: actionId,
        status: "in-progress",
        type: "create",
        started_at: "2026-10-22T00:00:00Z",
        completed_at: null,
        resource_id: id,
        resource_type: "droplet",
        pollsLeft: this.bootPolls,
      });
      return json(202, {
        droplet: d,
        links: {
          actions: [
            {
              id: actionId,
              rel: "create",
              href: `https://api.digitalocean.com/v2/actions/${actionId}`,
            },
          ],
        },
      });
    }
    if (dropletPath) {
      const d = this.droplets.get(Number(dropletPath[1]));
      if (!d) return json(404, errors.not_found);
      if (method === "GET") {
        // The droplet progresses whether or not anyone polls its action.
        for (const a of this.actions.values()) if (a.resource_id === d.id) this.tick(a);
        return json(200, { droplet: d });
      }
      if (method === "DELETE") {
        this.droplets.delete(d.id);
        return json(204, undefined);
      }
    }
    if (method === "GET" && actionPath) {
      const a = this.actions.get(Number(actionPath[1]));
      if (!a) return json(404, errors.not_found);
      this.tick(a);
      const { pollsLeft: _p, ...pub } = a;
      return json(200, { action: pub });
    }
    return doError(404, "not_found", `no route for ${method} ${path}`);
  }
}
