/**
 * DigitalOcean adapter: implements the shared driver primitives.
 *
 * Quirks:
 * - Tags are plain strings of letters, digits, `:`, `-`, and `_`, so labels
 *   are stored as `roundhouse:managed:true`, `roundhouse:node:<name>`, and so
 *   on (see {@link DIGITALOCEAN_TAGS}). Workspace IDs with `.` cannot be
 *   stored and are rejected.
 * - Prices are uniform across regions, in USD. All droplets are amd64.
 * - Cloud firewalls deny outbound traffic that no rule allows, so the
 *   adapter adds allow-all outbound rules.
 * - The firewall targets a tag (`roundhouse:firewall:<variant>`) that each
 *   droplet is created with, so the droplet is covered without a second
 *   call. DigitalOcean applies firewall changes asynchronously, so coverage
 *   in the first seconds of boot is not guaranteed. Tags must exist before a
 *   firewall can target them.
 * - Droplet names are not unique. The adapter still refuses a name an
 *   unmanaged droplet uses, to keep consoles unambiguous.
 * - Without an SSH key DigitalOcean emails a root password to the account
 *   owner; the API never returns it. Supplying a key avoids the email.
 * - `GET /account/keys` is limited to 10 requests per minute.
 *
 * @module
 */
import type { Arch } from "../catalog";
import { isConflict, isNotFound, ProviderActionError, ProvisionError } from "../errors";
import type { FirewallSpec } from "../firewall";
import { type PollOptions, pollUntil, type RequestOptions } from "../http";
import { LABEL_FIREWALL, LABEL_MANAGED, LABEL_NODE, LABEL_WORKSPACE } from "../naming";
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
import { DigitalOceanClient, type DigitalOceanClientOptions } from "./client";
import {
  buildDigitalOceanOffers,
  DIGITALOCEAN_TAG,
  DIGITALOCEAN_TAGS,
  filterDigitalOceanImages,
  fromDroplet,
  toDigitalOceanRules,
} from "./mapping";

/** DigitalOcean's limit for `user_data` (64 KiB of plain text). */
export const DIGITALOCEAN_USER_DATA_LIMIT = 64 * 1024;

/** DigitalOcean implementation of {@link ProviderDriver}. */
export class DigitalOceanDriver implements ProviderDriver {
  /** Provider ID. */
  readonly id = "digitalocean" as const;
  /** Name for the UI. */
  readonly displayName = "DigitalOcean";
  /** DigitalOcean's documented user data limit. */
  readonly userDataLimitBytes = DIGITALOCEAN_USER_DATA_LIMIT;
  /** Typed API client. */
  readonly client: DigitalOceanClient;

  /** @param options - Token and transport tuning. */
  constructor(options: DigitalOceanClientOptions) {
    this.client = new DigitalOceanClient(options);
  }

  /** Sleep and clock of the HTTP client. */
  get clock() {
    return this.client.http;
  }

  /**
   * Checks every encoded tag against DigitalOcean's tag grammar.
   *
   * @param labels - Managed labels.
   * @throws ProvisionError `invalid_input`.
   */
  validateLabels(labels: Record<string, string>): void {
    for (const tag of DIGITALOCEAN_TAGS.encode(labels)) {
      if (!DIGITALOCEAN_TAG.test(tag)) {
        throw new ProvisionError("invalid_input", `tag ${tag} is not a valid DigitalOcean tag`);
      }
    }
  }

  /** See {@link ProviderDriver.validateToken}. */
  validateToken(options: RequestOptions): Promise<TokenCheck> {
    return this.client.validateToken(options);
  }

  /** See {@link ProviderDriver.listOffers}. */
  async listOffers(options: RequestOptions & { now: number }): Promise<Offer[]> {
    const req = { signal: options.signal, timeoutMs: options.timeoutMs };
    const [sizes, regions] = await Promise.all([
      this.client.listSizes(req),
      this.client.listRegions(req),
    ]);
    return buildDigitalOceanOffers(sizes, regions);
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
    const images = filterDigitalOceanImages(await this.client.listDistributionImages(options));
    return filter.region ? images.filter((i) => i.regions?.includes(filter.region!)) : images;
  }

  /** See {@link ProviderDriver.getServer}. */
  async getServer(serverId: string, options: RequestOptions): Promise<CloudServer | null> {
    if (!/^\d+$/.test(serverId)) return null;
    try {
      return fromDroplet(await this.client.getDroplet(Number(serverId), options));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  /**
   * Lists by the most specific tag (the API filters by one tag only), then
   * keeps droplets whose decoded labels match every filter.
   */
  async findManaged(
    filter: { node?: string; workspaceId?: string },
    options: RequestOptions,
  ): Promise<CloudServer[]> {
    const tag =
      filter.node !== undefined
        ? DIGITALOCEAN_TAGS.tag(LABEL_NODE, filter.node)
        : filter.workspaceId !== undefined
          ? DIGITALOCEAN_TAGS.tag(LABEL_WORKSPACE, filter.workspaceId)
          : DIGITALOCEAN_TAGS.tag(LABEL_MANAGED, "true");
    const droplets = await this.client.listDroplets({ tag }, options);
    return droplets
      .map(fromDroplet)
      .filter(
        (s) =>
          s.managed !== null &&
          (filter.node === undefined || s.managed.node === filter.node) &&
          (filter.workspaceId === undefined || s.managed.workspaceId === filter.workspaceId),
      );
  }

  /** See {@link ProviderDriver.findByName}. */
  async findByName(name: string, options: RequestOptions): Promise<CloudServer[]> {
    const droplets = await this.client.listDroplets({ name }, options);
    return droplets.map(fromDroplet).filter((s) => s.name.toLowerCase() === name.toLowerCase());
  }

  /**
   * Finds the managed firewall by name and target tag, or creates the tag
   * and then the firewall. A firewall with the name that does not target
   * the tag belongs to the user and is refused.
   */
  async ensureFirewall(spec: FirewallSpec, options: RequestOptions): Promise<string> {
    const tag = DIGITALOCEAN_TAGS.tag(LABEL_FIREWALL, spec.variant);
    const named = (await this.client.listFirewalls(options)).filter((f) => f.name === spec.name);
    const ours = named.find((f) => f.tags.includes(tag));
    if (ours) return ours.id;
    if (named.length > 0) {
      throw new ProvisionError(
        "name_taken",
        `a firewall named ${spec.name} exists but is not managed by Roundhouse`,
      );
    }
    await this.client.ensureTag(tag, options);
    const fw = await this.client.createFirewall(
      { name: spec.name, ...toDigitalOceanRules(spec.rules), tags: [tag] },
      options,
    );
    return fw.id;
  }

  /** Reuses a key with the same material, or uploads it. */
  async ensureSshKey(normalizedKey: string, options: RequestOptions): Promise<string> {
    const find = async () =>
      (await this.client.listSshKeys(options)).find((k) => sameSshKey(k.public_key, normalizedKey));
    const existing = await find();
    if (existing) return String(existing.id);
    try {
      const key = await this.client.createSshKey(
        { name: await sshKeyName(normalizedKey), public_key: normalizedKey },
        options,
      );
      return String(key.id);
    } catch (e) {
      if (!isConflict(e)) throw e;
      const raced = await find();
      if (raced) return String(raced.id);
      throw e;
    }
  }

  /**
   * Creates the droplet with the managed tags plus the firewall's target tag.
   * The firewall's tag is read back so the droplet is covered at creation.
   */
  async createServer(spec: CreateServerSpec, options: RequestOptions): Promise<CreatedServer> {
    const firewall = await this.client.getFirewall(spec.firewallId, options);
    const firewallTag = firewall.tags.find((t) =>
      t.startsWith(DIGITALOCEAN_TAGS.tag(LABEL_FIREWALL, "")),
    );
    if (!firewallTag) {
      throw new ProvisionError(
        "invalid_input",
        `firewall ${spec.firewallId} has no Roundhouse tag`,
      );
    }
    const res = await this.client.createDroplet(
      {
        name: spec.name,
        region: spec.region,
        size: spec.plan,
        image: spec.imageId,
        ssh_keys: spec.sshKeyId === null ? undefined : [Number(spec.sshKeyId)],
        ipv6: true,
        monitoring: false,
        tags: [...DIGITALOCEAN_TAGS.encode(spec.labels), firewallTag],
        user_data: spec.userData,
      },
      options,
    );
    const create = res.links?.actions?.find((a) => a.rel === "create") ?? res.links?.actions?.[0];
    return { server: fromDroplet(res.droplet), pending: create?.id };
  }

  /** Waits for the create action when known, then until the droplet is active. */
  async waitUntilRunning(created: CreatedServer, options: PollOptions): Promise<CloudServer> {
    const id = Number(created.server.id);
    const deadline = this.clock.now() + (options.timeoutMs ?? 600_000);
    if (typeof created.pending === "number")
      await this.client.waitForAction(created.pending, options);
    return pollUntil(
      this.clock,
      async () => {
        const s = fromDroplet(await this.client.getDroplet(id, { signal: options.signal }));
        return s.status === "running" ? s : undefined;
      },
      {
        ...options,
        timeoutMs: Math.max(0, deadline - this.clock.now()),
        onTimeout: () =>
          new ProviderActionError(
            "digitalocean",
            String(id),
            "create",
            "action_timeout",
            "droplet did not become active",
          ),
      },
    );
  }

  /** Deletes by ID and, when asked, waits until the droplet is gone. */
  async deleteServer(serverId: string, options: PollOptions & { wait: boolean }): Promise<void> {
    const id = Number(serverId);
    await this.client.deleteDroplet(id, { signal: options.signal });
    if (!options.wait) return;
    await pollUntil(
      this.clock,
      async () => {
        try {
          await this.client.getDroplet(id, { signal: options.signal });
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
            "digitalocean",
            serverId,
            "destroy",
            "action_timeout",
            "droplet was not deleted in time",
          ),
      },
    );
  }
}
