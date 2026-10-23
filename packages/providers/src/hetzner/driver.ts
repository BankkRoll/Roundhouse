/**
 * Hetzner Cloud adapter: implements the shared driver primitives.
 *
 * Quirks:
 * - Labels are real key/value labels, so the managed labels are stored as
 *   is and looked up with label selectors.
 * - Prices are per location, gross of the project owner's VAT, in the
 *   project's currency (`GET /pricing`).
 * - Firewalls, SSH keys, and user data are attached atomically at create.
 * - Server names are unique per project.
 * - Without an SSH key Hetzner generates a root password and returns it once
 *   in the create response; it is dropped here.
 * - Server creation is tracked with actions polled via `GET /actions?id=`.
 *
 * @module
 */
import type { Arch } from "../catalog";
import { isConflict, isNotFound, ProviderActionError, ProvisionError } from "../errors";
import type { FirewallSpec } from "../firewall";
import { type PollOptions, pollUntil, type RequestOptions } from "../http";
import {
  isManaged,
  isValidLabelValue,
  LABEL_FIREWALL,
  LABEL_MANAGED,
  LABEL_NODE,
  LABEL_WORKSPACE,
} from "../naming";
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
import { HetznerClient, type HetznerClientOptions } from "./client";
import {
  buildHetznerOffers,
  filterHetznerImages,
  fromHetznerServer,
  toHetznerArch,
  toHetznerRules,
} from "./mapping";
import type { Action, Firewall } from "./types";

/** Hetzner's limit for `user_data` (documented on `POST /servers`). */
export const HETZNER_USER_DATA_LIMIT = 32 * 1024;

/** Hetzner Cloud implementation of {@link ProviderDriver}. */
export class HetznerDriver implements ProviderDriver {
  /** Provider ID. */
  readonly id = "hetzner" as const;
  /** Name for the UI. */
  readonly displayName = "Hetzner Cloud";
  /** Hetzner's documented user data limit. */
  readonly userDataLimitBytes = HETZNER_USER_DATA_LIMIT;
  /** Typed API client. */
  readonly client: HetznerClient;

  /** @param options - Token and transport tuning. */
  constructor(options: HetznerClientOptions) {
    this.client = new HetznerClient(options);
  }

  /** Sleep and clock of the HTTP client. */
  get clock() {
    return this.client.http;
  }

  /**
   * Checks every label value against Hetzner's grammar.
   *
   * @param labels - Managed labels.
   * @throws ProvisionError `invalid_input`.
   */
  validateLabels(labels: Record<string, string>): void {
    for (const [key, value] of Object.entries(labels)) {
      if (!isValidLabelValue(value)) {
        throw new ProvisionError(
          "invalid_input",
          `label ${key}=${value} is not a valid Hetzner label`,
        );
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
    const [types, locations, pricing] = await Promise.all([
      this.client.listServerTypes({}, req),
      this.client.listLocations(req),
      this.client.getPricing(req),
    ]);
    return buildHetznerOffers(types, locations, pricing, options.now);
  }

  /** See {@link ProviderDriver.getOffer}. */
  async getOffer(
    plan: string,
    region: string,
    options: RequestOptions & { now: number },
  ): Promise<Offer | null> {
    const req = { signal: options.signal, timeoutMs: options.timeoutMs };
    const [types, locations, pricing] = await Promise.all([
      this.client.listServerTypes({ name: plan }, req),
      this.client.listLocations(req),
      this.client.getPricing(req),
    ]);
    const offers = buildHetznerOffers(types, locations, pricing, options.now);
    return offers.find((o) => o.plan === plan && o.region === region) ?? null;
  }

  /** See {@link ProviderDriver.listImages}. */
  async listImages(
    filter: { region?: string; arch?: Arch },
    options: RequestOptions,
  ): Promise<ProviderImage[]> {
    const images = await this.client.listImages(
      {
        type: "system",
        status: "available",
        architecture: filter.arch ? toHetznerArch(filter.arch) : undefined,
      },
      options,
    );
    return filterHetznerImages(images, this.clock.now());
  }

  /** See {@link ProviderDriver.getServer}. */
  async getServer(serverId: string, options: RequestOptions): Promise<CloudServer | null> {
    if (!/^\d+$/.test(serverId)) return null;
    try {
      return fromHetznerServer(await this.client.getServer(Number(serverId), options));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  /** See {@link ProviderDriver.findManaged}. */
  async findManaged(
    filter: { node?: string; workspaceId?: string },
    options: RequestOptions,
  ): Promise<CloudServer[]> {
    const parts = [`${LABEL_MANAGED}=true`];
    if (filter.node !== undefined) parts.push(`${LABEL_NODE}=${filter.node}`);
    if (filter.workspaceId !== undefined) parts.push(`${LABEL_WORKSPACE}=${filter.workspaceId}`);
    const servers = await this.client.listServers({ labelSelector: parts.join(",") }, options);
    return servers.map(fromHetznerServer).filter((s) => s.managed !== null);
  }

  /** See {@link ProviderDriver.findByName}. */
  async findByName(name: string, options: RequestOptions): Promise<CloudServer[]> {
    return (await this.client.listServers({ name }, options)).map(fromHetznerServer);
  }

  /**
   * Finds or creates the managed firewall by its labels. A firewall is
   * created once and never rewritten.
   */
  async ensureFirewall(spec: FirewallSpec, options: RequestOptions): Promise<string> {
    const selector = `${LABEL_MANAGED}=true,${LABEL_FIREWALL}=${spec.variant}`;
    const [existing] = await this.client.listFirewalls({ labelSelector: selector }, options);
    if (existing) return String(existing.id);
    let created: Firewall;
    try {
      created = (
        await this.client.createFirewall(
          {
            name: spec.name,
            labels: { [LABEL_MANAGED]: "true", [LABEL_FIREWALL]: spec.variant },
            rules: toHetznerRules(spec.rules),
          },
          options,
        )
      ).firewall;
    } catch (e) {
      // A concurrent provision may have created it first.
      if (!isConflict(e)) throw e;
      const [byName] = await this.client.listFirewalls({ name: spec.name }, options);
      if (byName && isManaged(byName.labels)) return String(byName.id);
      throw new ProvisionError(
        "name_taken",
        `a firewall named ${spec.name} exists but is not managed by Roundhouse`,
        { cause: e },
      );
    }
    return String(created.id);
  }

  /**
   * Returns the project's copy of a key, uploading it if missing. An existing
   * key with the same material is reused whatever its name.
   */
  async ensureSshKey(normalizedKey: string, options: RequestOptions): Promise<string> {
    const find = async () =>
      (await this.client.listSshKeys(options)).find((k) => sameSshKey(k.public_key, normalizedKey));
    const existing = await find();
    if (existing) return String(existing.id);
    try {
      const key = await this.client.createSshKey(
        {
          name: await sshKeyName(normalizedKey),
          public_key: normalizedKey,
          labels: { [LABEL_MANAGED]: "true" },
        },
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

  /** See {@link ProviderDriver.createServer}. */
  async createServer(spec: CreateServerSpec, options: RequestOptions): Promise<CreatedServer> {
    const res = await this.client.createServer(
      {
        name: spec.name,
        server_type: spec.plan,
        location: spec.region,
        image: spec.imageId,
        ssh_keys: spec.sshKeyId === null ? undefined : [Number(spec.sshKeyId)],
        firewalls: [{ firewall: Number(spec.firewallId) }],
        user_data: spec.userData,
        labels: spec.labels,
        start_after_create: true,
        public_net: { enable_ipv4: true, enable_ipv6: true },
      },
      options,
    );
    // NOTE: res.root_password is set when no SSH key is given. It is
    // deliberately dropped: never logged, stored, or returned.
    return { server: fromHetznerServer(res.server), pending: [res.action, ...res.next_actions] };
  }

  /** Waits for the creation actions, then reads the server. */
  async waitUntilRunning(created: CreatedServer, options: PollOptions): Promise<CloudServer> {
    const id = Number(created.server.id);
    const actions = (created.pending as Action[] | undefined) ?? [];
    if (actions.length > 0) {
      await this.client.waitForActions(actions, options);
      return fromHetznerServer(await this.client.getServer(id, { signal: options.signal }));
    }
    // A server recovered by label lookup has no known actions; poll its status.
    return pollUntil(
      this.clock,
      async () => {
        const s = fromHetznerServer(await this.client.getServer(id, { signal: options.signal }));
        return s.status === "running" ? s : undefined;
      },
      {
        ...options,
        onTimeout: () =>
          new ProviderActionError(
            "hetzner",
            String(id),
            "start_server",
            "action_timeout",
            "did not start in time",
          ),
      },
    );
  }

  /** See {@link ProviderDriver.deleteServer}. */
  async deleteServer(serverId: string, options: PollOptions & { wait: boolean }): Promise<void> {
    const action = await this.client.deleteServer(Number(serverId), { signal: options.signal });
    if (options.wait) await this.client.waitForActions([action], options);
  }
}
