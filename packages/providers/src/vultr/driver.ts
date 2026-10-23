/**
 * Vultr adapter: implements the shared driver primitives.
 *
 * Quirks:
 * - Tags are free-form strings with no documented grammar, so labels are
 *   stored as `roundhouse.node=web-1` (see {@link VULTR_TAGS}) and found with
 *   the exact-match `tag` filter.
 * - Prices differ by region (`location_cost` overrides), in USD. All plans
 *   are amd64.
 * - Firewall groups have only a free-text description: no labels and no
 *   filter. The managed group is recognised by an exact description
 *   (`roundhouse-default roundhouse.managed=true`). Rules are added one by
 *   one after the group exists, so a group is created under a "pending"
 *   description and renamed only once every rule is in; a crash midway
 *   leaves a pending group that the next call deletes and replaces.
 * - Firewall group, SSH keys, and user data (base64) are attached at create.
 * - The create response carries `default_password` for ten minutes; it is
 *   dropped here.
 * - Instance labels are not unique; the adapter still refuses a label an
 *   unmanaged instance uses.
 * - There are no action objects; readiness is polled from the instance's
 *   `status` and `power_status`.
 *
 * @module
 */
import type { Arch } from "../catalog";
import { toBase64 } from "../cloud-init";
import { isConflict, isNotFound, ProviderActionError } from "../errors";
import type { FirewallSpec } from "../firewall";
import { type PollOptions, pollUntil, type RequestOptions } from "../http";
import { LABEL_MANAGED, LABEL_NODE, LABEL_WORKSPACE } from "../naming";
import type {
  CloudServer,
  CreatedServer,
  CreateServerSpec,
  Offer,
  ProviderDriver,
  ProviderImage,
  TokenCheck,
} from "../provider";
import { sameSshKey, sshKeyName } from "../ssh-keys";
import { VultrClient, type VultrClientOptions } from "./client";
import {
  buildVultrOffers,
  filterVultrImages,
  fromVultrInstance,
  toVultrRules,
  VULTR_TAGS,
} from "./mapping";

/**
 * Size cap for Vultr user data. Vultr documents none for user data (only
 * 64 KB for startup scripts), so the shared cloud-init cap applies.
 */
export const VULTR_USER_DATA_LIMIT = 16 * 1024;

/**
 * Descriptions that mark the managed firewall group, complete or still
 * being filled.
 *
 * @param name - Firewall name from the spec, e.g. `roundhouse-default`.
 * @returns The two descriptions.
 */
export function vultrFirewallDescriptions(name: string): { ready: string; pending: string } {
  return { ready: `${name} ${LABEL_MANAGED}=true`, pending: `${name} ${LABEL_MANAGED}=pending` };
}

/** Vultr implementation of {@link ProviderDriver}. */
export class VultrDriver implements ProviderDriver {
  /** Provider ID. */
  readonly id = "vultr" as const;
  /** Name for the UI. */
  readonly displayName = "Vultr";
  /** See {@link VULTR_USER_DATA_LIMIT}. */
  readonly userDataLimitBytes = VULTR_USER_DATA_LIMIT;
  /** Typed API client. */
  readonly client: VultrClient;

  /** @param options - Key and transport tuning. */
  constructor(options: VultrClientOptions) {
    this.client = new VultrClient(options);
  }

  /** Sleep and clock of the HTTP client. */
  get clock() {
    return this.client.http;
  }

  /** See {@link ProviderDriver.validateToken}. */
  validateToken(options: RequestOptions): Promise<TokenCheck> {
    return this.client.validateToken(options);
  }

  /** See {@link ProviderDriver.listOffers}. */
  async listOffers(options: RequestOptions & { now: number }): Promise<Offer[]> {
    const req = { signal: options.signal, timeoutMs: options.timeoutMs };
    const [plans, regions] = await Promise.all([
      this.client.listPlans(req),
      this.client.listRegions(req),
    ]);
    return buildVultrOffers(plans, regions);
  }

  /** See {@link ProviderDriver.getOffer}. */
  async getOffer(
    plan: string,
    region: string,
    options: RequestOptions & { now: number },
  ): Promise<Offer | null> {
    return (
      (await this.listOffers(options)).find((o) => o.plan === plan && o.region === region) ?? null
    );
  }

  /** See {@link ProviderDriver.listImages}. */
  async listImages(
    filter: { region?: string; arch?: Arch },
    options: RequestOptions,
  ): Promise<ProviderImage[]> {
    if (filter.arch === "arm64") return [];
    return filterVultrImages(await this.client.listOs(options));
  }

  /** See {@link ProviderDriver.getServer}. */
  async getServer(serverId: string, options: RequestOptions): Promise<CloudServer | null> {
    if (!/^[0-9a-f-]{36}$/i.test(serverId)) return null;
    try {
      return fromVultrInstance(await this.client.getInstance(serverId, options));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  /** Lists by the most specific tag, then keeps instances whose labels match every filter. */
  async findManaged(
    filter: { node?: string; workspaceId?: string },
    options: RequestOptions,
  ): Promise<CloudServer[]> {
    const tag =
      filter.node !== undefined
        ? VULTR_TAGS.tag(LABEL_NODE, filter.node)
        : filter.workspaceId !== undefined
          ? VULTR_TAGS.tag(LABEL_WORKSPACE, filter.workspaceId)
          : VULTR_TAGS.tag(LABEL_MANAGED, "true");
    const instances = await this.client.listInstances({ tag }, options);
    return instances
      .map(fromVultrInstance)
      .filter(
        (s) =>
          s.managed !== null &&
          (filter.node === undefined || s.managed.node === filter.node) &&
          (filter.workspaceId === undefined || s.managed.workspaceId === filter.workspaceId),
      );
  }

  /** See {@link ProviderDriver.findByName}. */
  async findByName(name: string, options: RequestOptions): Promise<CloudServer[]> {
    return (await this.client.listInstances({ label: name }, options))
      .filter((i) => i.label === name)
      .map(fromVultrInstance);
  }

  /**
   * Finds the complete managed group by description, or builds one: create
   * under the pending description, add every rule, then rename. Leftover
   * pending groups with no instances are deleted first.
   */
  async ensureFirewall(spec: FirewallSpec, options: RequestOptions): Promise<string> {
    const { ready, pending } = vultrFirewallDescriptions(spec.name);
    const groups = await this.client.listFirewallGroups(options);
    const existing = groups
      .filter((g) => g.description === ready)
      .sort((a, b) => a.date_created.localeCompare(b.date_created))[0];
    if (existing) return existing.id;
    for (const stale of groups.filter((g) => g.description === pending && g.instance_count === 0)) {
      await this.client.deleteFirewallGroup(stale.id, options).catch(() => {});
    }
    const group = await this.client.createFirewallGroup(pending, options);
    try {
      for (const rule of toVultrRules(spec.rules)) {
        await this.client.createFirewallRule(group.id, rule, options);
      }
      await this.client.updateFirewallGroup(group.id, ready, options);
    } catch (e) {
      await this.client.deleteFirewallGroup(group.id).catch(() => {});
      throw e;
    }
    return group.id;
  }

  /** Reuses a key with the same material, or uploads it. */
  async ensureSshKey(normalizedKey: string, options: RequestOptions): Promise<string> {
    const find = async () =>
      (await this.client.listSshKeys(options)).find((k) => sameSshKey(k.ssh_key, normalizedKey));
    const existing = await find();
    if (existing) return existing.id;
    try {
      const key = await this.client.createSshKey(
        { name: await sshKeyName(normalizedKey), ssh_key: normalizedKey },
        options,
      );
      return key.id;
    } catch (e) {
      if (!isConflict(e)) throw e;
      const raced = await find();
      if (raced) return raced.id;
      throw e;
    }
  }

  /** See {@link ProviderDriver.createServer}. */
  async createServer(spec: CreateServerSpec, options: RequestOptions): Promise<CreatedServer> {
    const instance = await this.client.createInstance(
      {
        region: spec.region,
        plan: spec.plan,
        os_id: Number(spec.imageId),
        label: spec.name,
        hostname: spec.name,
        tags: VULTR_TAGS.encode(spec.labels),
        user_data: toBase64(spec.userData),
        enable_ipv6: true,
        sshkey_id: spec.sshKeyId === null ? undefined : [spec.sshKeyId],
        firewall_group_id: spec.firewallId,
        backups: "disabled",
        activation_email: false,
      },
      options,
    );
    // NOTE: instance.default_password is the root password. fromVultrInstance
    // drops it: never logged, stored, or returned.
    return { server: fromVultrInstance(instance) };
  }

  /** Polls the instance until it is active, powered on, and has an IPv4 address. */
  waitUntilRunning(created: CreatedServer, options: PollOptions): Promise<CloudServer> {
    const id = created.server.id;
    return pollUntil(
      this.clock,
      async () => {
        const s = fromVultrInstance(await this.client.getInstance(id, { signal: options.signal }));
        return s.status === "running" && s.ipv4 !== null ? s : undefined;
      },
      {
        ...options,
        onTimeout: () =>
          new ProviderActionError(
            "vultr",
            id,
            "create",
            "action_timeout",
            "instance did not become active",
          ),
      },
    );
  }

  /** Deletes the instance and, when asked, waits until it is gone. */
  async deleteServer(serverId: string, options: PollOptions & { wait: boolean }): Promise<void> {
    await this.client.deleteInstance(serverId, { signal: options.signal });
    if (!options.wait) return;
    await pollUntil(
      this.clock,
      async () => {
        try {
          await this.client.getInstance(serverId, { signal: options.signal });
          return undefined;
        } catch (e) {
          if (isNotFound(e)) return true;
          throw e;
        }
      },
      {
        ...options,
        onTimeout: () =>
          new ProviderActionError(
            "vultr",
            serverId,
            "destroy",
            "action_timeout",
            "instance was not deleted in time",
          ),
      },
    );
  }
}
