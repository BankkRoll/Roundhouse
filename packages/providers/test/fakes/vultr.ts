/**
 * In-memory Vultr API v2.
 *
 * Documented behaviour it models: `{error, status}` errors, cursor
 * pagination via `meta.links.next` (`""` on the last page), exact-match
 * `tag` and `label` filters, firewall groups identified only by description
 * with rules added separately, `202` creates that return `default_password`,
 * instances that go `pending` → `active`, and `204` deletes. A read-only key
 * is modelled as a sub-user with only `subscriptions_view`.
 *
 * @module
 */
import { VULTR_TAGS } from "../../src/vultr/mapping";
import type {
  VultrFirewallGroup,
  VultrFirewallRule,
  VultrInstance,
  VultrOs,
  VultrPlan,
  VultrRegion,
  VultrSshKey,
} from "../../src/vultr/types";
import {
  accountDoc,
  docCreatedInstance,
  errors,
  instance,
  OS_LIST,
  PLANS,
  REGIONS,
} from "../fixtures/vultr";
import { FakeApi, json, type RecordedRequest, type SeedServer } from "./base";

/**
 * Builds a Vultr error response.
 *
 * @param status - HTTP status.
 * @param error - Message.
 * @returns The response.
 */
export function vultrError(status: number, error: string): Response {
  return json(status, { error, status });
}

/** The root password the fake returns from `POST /instances`. */
export const VULTR_DEFAULT_PASSWORD = docCreatedInstance.default_password!;

let uuidSeq = 0;
function uuid(): string {
  uuidSeq++;
  return `4f0f12e5-1f84-404f-aa84-${uuidSeq.toString(16).padStart(12, "0")}`;
}

/** In-memory Vultr account. */
export class FakeVultr extends FakeApi {
  protected readonly prefix = "/v2";
  plans: VultrPlan[] = structuredClone(PLANS);
  regions: VultrRegion[] = structuredClone(REGIONS);
  osList: VultrOs[] = structuredClone(OS_LIST);
  readonly instances = new Map<string, VultrInstance & { polls: number }>();
  readonly groups = new Map<string, VultrFirewallGroup>();
  readonly rules = new Map<string, VultrFirewallRule[]>();
  readonly sshKeys = new Map<string, VultrSshKey>();
  /** ACLs of the read/write key's user. */
  acls: string[] = [...accountDoc.account.acls];
  /** Largest `per_page` accepted; Vultr's is 500. */
  maxPerPage = 500;
  /** Items actually returned per page, to force several pages in tests. */
  pageCap = 500;
  override readonly secrets = [VULTR_DEFAULT_PASSWORD];

  seedServer(spec: SeedServer): string {
    const id = uuid();
    this.instances.set(id, {
      ...instance({ id, label: spec.name, tags: VULTR_TAGS.encode(spec.labels) }),
      polls: 0,
    });
    return id;
  }

  serverIds(): string[] {
    return [...this.instances.keys()];
  }

  firewallCount(): number {
    return this.groups.size;
  }

  sshKeyCount(): number {
    return this.sshKeys.size;
  }

  isCreate(req: RecordedRequest): boolean {
    return req.method === "POST" && req.path === "/instances";
  }

  isDelete(req: RecordedRequest): boolean {
    return req.method === "DELETE" && req.path.startsWith("/instances/");
  }

  errorResponse(status: number, message = "error"): Response {
    return vultrError(status, message);
  }

  protected unauthorized(): Response {
    return json(401, errors.unauthorized);
  }

  protected forbidden(): Response {
    return vultrError(403, "Unauthorized action.");
  }

  /** Cursor pages: the cursor is the base64 of the next start index. */
  private page<T>(key: string, items: T[], req: RecordedRequest): Response {
    const perPage = Number(req.query.get("per_page") ?? 100);
    if (!(perPage >= 1 && perPage <= this.maxPerPage)) return json(400, errors.per_page);
    const cursor = req.query.get("cursor");
    const start = cursor ? Number(atob(cursor).replace("next__", "")) : 0;
    const end = start + Math.min(perPage, this.pageCap);
    return json(200, {
      [key]: items.slice(start, end),
      meta: {
        // Vultr's own `total` is unreliable on some lists; the adapter must not use it.
        total: items.length + 1,
        links: {
          next: end < items.length ? btoa(`next__${end}`) : "",
          prev: start > 0 ? btoa(`prev__${start}`) : "",
        },
      },
    });
  }

  private view(i: VultrInstance & { polls: number }): VultrInstance {
    const { polls: _p, ...pub } = i;
    return structuredClone(pub);
  }

  protected route(req: RecordedRequest): Response {
    const { method, path, query } = req;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const instancePath = /^\/instances\/([\w-]+)$/.exec(path);
    const groupPath = /^\/firewalls\/([\w-]+)$/.exec(path);
    const rulesPath = /^\/firewalls\/([\w-]+)\/rules$/.exec(path);

    if (method === "GET" && path === "/account") {
      const acls = req.token === "ro-token" ? ["subscriptions_view"] : this.acls;
      return json(200, { account: { ...accountDoc.account, acls } });
    }
    if (method === "GET" && path === "/plans") return this.page("plans", this.plans, req);
    if (method === "GET" && path === "/regions") return this.page("regions", this.regions, req);
    if (method === "GET" && path === "/os") return this.page("os", this.osList, req);

    if (method === "GET" && path === "/ssh-keys")
      return this.page("ssh_keys", [...this.sshKeys.values()], req);
    if (method === "POST" && path === "/ssh-keys") {
      if (!body.name || !body.ssh_key) return vultrError(400, "Invalid SSH key.");
      const k: VultrSshKey = {
        id: uuid(),
        date_created: "2026-10-22T00:00:00+00:00",
        name: String(body.name),
        ssh_key: String(body.ssh_key),
      };
      this.sshKeys.set(k.id, k);
      return json(201, { ssh_key: k });
    }

    if (method === "GET" && path === "/firewalls")
      return this.page("firewall_groups", [...this.groups.values()], req);
    if (method === "POST" && path === "/firewalls") {
      const g: VultrFirewallGroup = {
        id: uuid(),
        description: String(body.description ?? ""),
        date_created: `2026-10-22T00:00:${String(this.groups.size).padStart(2, "0")}+00:00`,
        date_modified: "2026-10-22T00:00:00+00:00",
        instance_count: 0,
        rule_count: 0,
        max_rule_count: 50,
      };
      this.groups.set(g.id, g);
      this.rules.set(g.id, []);
      return json(201, { firewall_group: g });
    }
    if (groupPath) {
      const g = this.groups.get(groupPath[1]!);
      if (!g) return json(404, errors.not_found);
      if (method === "PUT") {
        g.description = String(body.description ?? "");
        return json(204, undefined);
      }
      if (method === "DELETE") {
        this.groups.delete(g.id);
        return json(204, undefined);
      }
      if (method === "GET") return json(200, { firewall_group: g });
    }
    if (rulesPath) {
      const g = this.groups.get(rulesPath[1]!);
      if (!g) return json(404, errors.not_found);
      if (method === "GET") return this.page("firewall_rules", this.rules.get(g.id) ?? [], req);
      if (method === "POST") {
        if (
          !body.ip_type ||
          !body.protocol ||
          body.subnet === undefined ||
          body.subnet_size === undefined
        ) {
          return vultrError(400, "Invalid firewall rule.");
        }
        const rule = {
          ...(body as unknown as VultrFirewallRule),
          id: (this.rules.get(g.id)?.length ?? 0) + 1,
          action: "accept" as const,
        };
        this.rules.get(g.id)!.push(rule);
        g.rule_count++;
        return json(201, { firewall_rule: rule });
      }
    }

    if (method === "GET" && path === "/instances") {
      const tag = query.get("tag");
      const label = query.get("label");
      const items = [...this.instances.values()]
        .filter((i) => (!tag || i.tags.includes(tag)) && (!label || i.label === label))
        .map((i) => this.view(i));
      return this.page("instances", items, req);
    }
    if (method === "POST" && path === "/instances") {
      if (!body.region || !body.plan || !body.os_id)
        return vultrError(400, "Invalid instance spec.");
      const plan = this.plans.find((p) => p.id === body.plan);
      if (!plan?.locations.includes(String(body.region)))
        return vultrError(400, "Plan is not available in the selected region.");
      if (typeof body.user_data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.user_data)) {
        return vultrError(400, "user_data must be base64 encoded.");
      }
      const group = body.firewall_group_id
        ? this.groups.get(String(body.firewall_group_id))
        : undefined;
      if (body.firewall_group_id && !group) return vultrError(400, "Invalid firewall group.");
      if (group) group.instance_count++;
      const id = uuid();
      const created: VultrInstance & { polls: number } = {
        ...structuredClone(docCreatedInstance),
        id,
        label: String(body.label ?? ""),
        hostname: String(body.hostname ?? ""),
        region: String(body.region),
        plan: String(body.plan),
        os_id: Number(body.os_id),
        tags: (body.tags as string[]) ?? [],
        firewall_group_id: String(body.firewall_group_id ?? ""),
        polls: 0,
      };
      this.instances.set(id, created);
      return json(202, { instance: this.view(created) });
    }
    if (instancePath) {
      const i = this.instances.get(instancePath[1]!);
      if (!i) return json(404, errors.not_found);
      if (method === "GET") {
        if (i.status === "pending" && !this.neverBoot && ++i.polls >= this.bootPolls) {
          Object.assign(i, {
            status: "active",
            server_status: "ok",
            main_ip: "192.0.2.123",
            v6_main_ip: "2001:db8::123",
          });
        }
        const view = this.view(i);
        delete view.default_password;
        return json(200, { instance: view });
      }
      if (method === "DELETE") {
        this.instances.delete(i.id);
        return json(204, undefined);
      }
    }
    return json(404, errors.not_found);
  }
}
