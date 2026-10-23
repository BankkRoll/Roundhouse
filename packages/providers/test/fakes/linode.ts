/**
 * In-memory Linode API v4.
 *
 * Documented behaviour it models: `{errors:[{field,reason}]}` errors,
 * `page`/`page_size` pagination (25-500) with `{data,page,pages,results}`,
 * `X-Filter` equality filters (tags match by membership), `X-OAuth-Scopes`
 * and `X-RateLimit-*` headers, the label and tag rules, `root_pass` being
 * required with an image, base64 `metadata.user_data` up to 65 535 bytes
 * only on `cloud-init` images in `Metadata` regions, unique firewall labels,
 * and Linodes that go `provisioning` → `running`.
 *
 * @module
 */
import { LINODE_TAGS } from "../../src/linode/mapping";
import type {
  Linode,
  LinodeFirewall,
  LinodeImage,
  LinodeRegion,
  LinodeType,
} from "../../src/linode/types";
import { errors, IMAGES, linode, profileDoc, REGIONS, TYPES } from "../fixtures/linode";
import { FakeApi, json, type RecordedRequest, type SeedServer } from "./base";

/**
 * Builds a Linode error response.
 *
 * @param status - HTTP status.
 * @param reason - Reason.
 * @param field - Field, when one is involved.
 * @returns The response.
 */
export function linodeError(status: number, reason: string, field?: string): Response {
  return json(status, { errors: [{ reason, ...(field ? { field } : {}) }] });
}

function matches(item: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) =>
    Array.isArray(item[k]) ? (item[k] as unknown[]).includes(v) : item[k] === v,
  );
}

/** In-memory Linode account. */
export class FakeLinode extends FakeApi {
  protected readonly prefix = "/v4";
  types: LinodeType[] = structuredClone(TYPES);
  regions: LinodeRegion[] = structuredClone(REGIONS);
  images: LinodeImage[] = structuredClone(IMAGES);
  readonly linodes = new Map<
    number,
    Linode & { polls: number; rootPass: string; userData: string }
  >();
  readonly firewalls = new Map<number, LinodeFirewall>();
  /** `X-OAuth-Scopes` per token; `null` omits the header. */
  scopes = new Map<string, string | null>([
    ["rw-token", "*"],
    ["ro-token", "linodes:read_only firewall:read_only images:read_only"],
  ]);
  /** Whether the profile is a restricted user. */
  restricted = false;
  /** Rate limit reported in headers. */
  rateLimit = { limit: 1600, remaining: 1600, reset: 1_800_000_000 };
  /** Root passwords the fake received; they must never surface. */
  override readonly secrets: string[] = [];

  seedServer(spec: SeedServer): string {
    const id = this.id();
    this.linodes.set(id, {
      ...linode({
        id,
        label: spec.name,
        tags: LINODE_TAGS.encode(spec.labels),
        status: spec.status ?? "running",
      }),
      polls: 0,
      rootPass: "",
      userData: "",
    });
    return String(id);
  }

  serverIds(): string[] {
    return [...this.linodes.keys()].map(String);
  }

  firewallCount(): number {
    return this.firewalls.size;
  }

  sshKeyCount(): number {
    return 0;
  }

  isCreate(req: RecordedRequest): boolean {
    // validateToken may probe this endpoint with an empty body; only a labelled body creates.
    return (
      req.method === "POST" &&
      req.path === "/linode/instances" &&
      Boolean((req.body as { label?: unknown })?.label)
    );
  }

  isDelete(req: RecordedRequest): boolean {
    return req.method === "DELETE" && req.path.startsWith("/linode/instances/");
  }

  errorResponse(status: number, message = "error"): Response {
    return linodeError(status, message);
  }

  protected unauthorized(): Response {
    return json(401, errors.unauthorized);
  }

  protected forbidden(): Response {
    return linodeError(403, "Unauthorized");
  }

  protected override decorate(res: Response, req: RecordedRequest): void {
    this.rateLimit.remaining = Math.max(0, this.rateLimit.remaining - 1);
    res.headers.set("X-RateLimit-Limit", String(this.rateLimit.limit));
    res.headers.set("X-RateLimit-Remaining", String(this.rateLimit.remaining));
    res.headers.set("X-RateLimit-Reset", String(this.rateLimit.reset));
    res.headers.set("Retry-After", "60");
    const scopes = req.token ? this.scopes.get(req.token) : undefined;
    if (scopes) res.headers.set("X-OAuth-Scopes", scopes);
  }

  private page<T>(items: T[], req: RecordedRequest): Response {
    const size = Number(req.query.get("page_size") ?? 100);
    if (!(size >= 25 && size <= 500)) return json(400, errors.page_size);
    const page = Math.max(1, Number(req.query.get("page") ?? 1) || 1);
    const raw = req.headers.get("x-filter");
    const filter = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    const kept = filter
      ? items.filter((i) => matches(i as Record<string, unknown>, filter))
      : items;
    const pages = Math.max(1, Math.ceil(kept.length / size));
    return json(200, {
      data: kept.slice((page - 1) * size, page * size),
      page,
      pages,
      results: kept.length,
    });
  }

  private view(l: Linode & { polls: number; rootPass: string; userData: string }): Linode {
    const { polls: _p, rootPass: _r, userData: _u, ...pub } = l;
    return structuredClone(pub);
  }

  protected route(req: RecordedRequest): Response {
    const { method, path } = req;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const linodePath = /^\/linode\/instances\/(\d+)$/.exec(path);

    if (method === "GET" && path === "/profile")
      return json(200, { ...profileDoc, restricted: this.restricted });
    if (method === "GET" && path === "/linode/types") return this.page(this.types, req);
    if (method === "GET" && path === "/regions") return this.page(this.regions, req);
    if (method === "GET" && path === "/images") return this.page(this.images, req);

    if (method === "GET" && path === "/networking/firewalls")
      return this.page([...this.firewalls.values()], req);
    if (method === "POST" && path === "/networking/firewalls") {
      const label = String(body.label ?? "");
      if (!/^[a-zA-Z][a-zA-Z0-9._-]{2,31}$/.test(label))
        return linodeError(400, "Label must be 3-32 characters", "label");
      if ([...this.firewalls.values()].some((f) => f.label === label)) {
        return linodeError(400, "Label must be unique among your Cloud Firewalls", "label");
      }
      const rules = body.rules as LinodeFirewall["rules"] | undefined;
      if (!rules?.inbound_policy || !rules.outbound_policy)
        return linodeError(400, "rules are required", "rules");
      if ((rules.inbound?.length ?? 0) + (rules.outbound?.length ?? 0) > 25) {
        return linodeError(400, "Too many rules", "rules");
      }
      const fw: LinodeFirewall = {
        id: this.id(),
        label,
        status: "enabled",
        rules,
        tags: (body.tags as string[]) ?? [],
        created: "2026-10-22T00:00:00",
      };
      this.firewalls.set(fw.id, fw);
      return json(200, fw);
    }

    if (method === "GET" && path === "/linode/instances") {
      return this.page(
        [...this.linodes.values()].map((l) => this.view(l)),
        req,
      );
    }
    if (method === "POST" && path === "/linode/instances") {
      const label = String(body.label ?? "");
      if (!body.type || !body.region)
        return linodeError(400, "type and region are required", "type");
      if (!/^[a-zA-Z](?!.*(--|__|\.\.))[a-zA-Z0-9._-]{2,63}$/.test(label)) {
        return linodeError(400, "Label must begin with a letter and be 3-64 characters", "label");
      }
      if ([...this.linodes.values()].some((l) => l.label === label)) {
        return linodeError(400, "Label must be unique among your Linodes", "label");
      }
      if (body.image && !(typeof body.root_pass === "string" && body.root_pass.length >= 7)) {
        return linodeError(400, "root_pass is required", "root_pass");
      }
      const tags = (body.tags as string[]) ?? [];
      if (tags.some((t) => t.length < 3 || t.length > 50))
        return linodeError(400, "Length must be 3-50 characters", "tags");
      const region = this.regions.find((r) => r.id === body.region);
      const type = this.types.find((t) => t.id === body.type);
      if (!region || !type) return linodeError(400, "Region or type not found", "region");
      const metadata = body.metadata as { user_data?: string } | undefined;
      let userData = "";
      if (metadata?.user_data !== undefined) {
        const image = this.images.find((i) => i.id === body.image);
        if (!image?.capabilities.includes("cloud-init"))
          return linodeError(400, "Image does not support Metadata", "metadata");
        if (!region.capabilities.includes("Metadata"))
          return linodeError(400, "Region does not support Metadata", "metadata");
        userData = atob(metadata.user_data);
        if (userData.length > 65_535)
          return linodeError(400, "user_data must not exceed 65535 bytes", "metadata.user_data");
      }
      if (body.firewall_id !== undefined && !this.firewalls.has(Number(body.firewall_id))) {
        return linodeError(400, "Firewall not found", "firewall_id");
      }
      const id = this.id();
      const created = {
        ...linode({
          id,
          label,
          status: "provisioning",
          region: region.id,
          type: type.id,
          image: String(body.image),
          tags,
          ipv4: ["203.0.113.10"],
          ipv6: "2600:3c03::f03c:91ff:fe24:3a2f/128",
        }),
        polls: 0,
        rootPass: String(body.root_pass ?? ""),
        userData,
      };
      this.secrets.push(created.rootPass);
      this.linodes.set(id, created);
      return json(200, this.view(created));
    }
    if (linodePath) {
      const l = this.linodes.get(Number(linodePath[1]));
      if (!l) return linodeError(404, "Not found");
      if (method === "GET") {
        if (l.status === "provisioning" && !this.neverBoot && ++l.polls >= this.bootPolls)
          l.status = "running";
        return json(200, this.view(l));
      }
      if (method === "DELETE") {
        this.linodes.delete(l.id);
        return json(200, {});
      }
    }
    return linodeError(404, "Not found");
  }
}
