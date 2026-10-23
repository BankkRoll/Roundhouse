/**
 * Linode (Akamai) adapter: implements the shared driver primitives.
 *
 * Quirks:
 * - Tags are 3-50 character strings, so labels are stored as
 *   `roundhouse.node=web-1` (see {@link LINODE_TAGS}); with the 16-character
 *   `roundhouse.node=` prefix, node names are limited to 34 characters here.
 *   Restricted users cannot tag Linodes at all.
 * - Linode labels must start with a letter, be 3-64 characters, and not
 *   repeat `-`, `_`, or `.`, which narrows the shared node-name rule.
 * - User data travels as `metadata.user_data` (base64) and works only on
 *   images with the `cloud-init` capability in regions with `Metadata`;
 *   offers and images are filtered to those.
 * - Prices can differ by region (`region_prices`), in USD. All plans are amd64.
 * - A cloud firewall is attached atomically with `firewall_id`. It drops
 *   inbound by default and accepts outbound. Firewalls have tags, so the
 *   managed one is recognised by its tags.
 * - `root_pass` is required with an image even when SSH keys are given. The
 *   adapter generates a random 48-character password, sends it once, and
 *   keeps no copy. SSH keys are passed inline (`authorized_keys`), so no key
 *   object is created.
 *
 * @module
 */
import type { Arch } from "../catalog";
import { toBase64 } from "../cloud-init";
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
import { LinodeClient, type LinodeClientOptions } from "./client";
import {
  buildLinodeOffers,
  filterLinodeImages,
  fromLinode,
  LINODE_TAG_LENGTH,
  LINODE_TAGS,
  toLinodeRules,
} from "./mapping";
import type { LinodeFirewall } from "./types";

/** Linode's user data limit: 65 535 bytes before base64. */
export const LINODE_USER_DATA_LIMIT = 65_535;

const LABEL = /^[a-zA-Z][a-zA-Z0-9._-]{2,63}$/;
const PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*-_=+";

/**
 * A random root password that meets Linode's strength check: 48 characters
 * from upper, lower, digit, and symbol classes, at least one of each.
 *
 * @returns The password.
 */
export function randomRootPassword(): string {
  const classes = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z0-9]/];
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(48));
    // 256 is not a multiple of the alphabet size; rejecting high bytes keeps
    // the distribution uniform.
    const limit = 256 - (256 % PASSWORD_CHARS.length);
    const chars = [...bytes]
      .filter((b) => b < limit)
      .map((b) => PASSWORD_CHARS[b % PASSWORD_CHARS.length]);
    const password = chars.join("");
    if (password.length >= 40 && classes.every((c) => c.test(password))) return password;
  }
}

/** Linode implementation of {@link ProviderDriver}. */
export class LinodeDriver implements ProviderDriver {
  /** Provider ID. */
  readonly id = "linode" as const;
  /** Name for the UI. */
  readonly displayName = "Akamai Cloud (Linode)";
  /** Linode's documented user data limit. */
  readonly userDataLimitBytes = LINODE_USER_DATA_LIMIT;
  /** Typed API client. */
  readonly client: LinodeClient;

  /** @param options - Token and transport tuning. */
  constructor(options: LinodeClientOptions) {
    this.client = new LinodeClient(options);
  }

  /** Sleep and clock of the HTTP client. */
  get clock() {
    return this.client.http;
  }

  /**
   * Applies Linode's label rule on top of the shared node-name rule.
   *
   * @param name - A valid node name.
   * @throws ProvisionError `invalid_input`.
   */
  validateName(name: string): void {
    if (!LABEL.test(name) || /--|__|\.\./.test(name)) {
      throw new ProvisionError(
        "invalid_input",
        `node name ${name} is not a valid Linode label: 3-64 characters, starting with a letter, without repeated '-'`,
      );
    }
  }

  /**
   * Checks every encoded tag against Linode's length limits.
   *
   * @param labels - Managed labels.
   * @throws ProvisionError `invalid_input`.
   */
  validateLabels(labels: Record<string, string>): void {
    for (const tag of LINODE_TAGS.encode(labels)) {
      if (tag.length < LINODE_TAG_LENGTH.min || tag.length > LINODE_TAG_LENGTH.max) {
        throw new ProvisionError(
          "invalid_input",
          `tag ${tag} exceeds Linode's ${LINODE_TAG_LENGTH.max}-character tag limit`,
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
    const [types, regions] = await Promise.all([
      this.client.listTypes(req),
      this.client.listRegions(req),
    ]);
    return buildLinodeOffers(types, regions);
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
    return filterLinodeImages(await this.client.listPublicImages(options));
  }

  /** See {@link ProviderDriver.getServer}. */
  async getServer(serverId: string, options: RequestOptions): Promise<CloudServer | null> {
    if (!/^\d+$/.test(serverId)) return null;
    try {
      return fromLinode(await this.client.getLinode(Number(serverId), options));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  /** Lists by the most specific tag, then keeps Linodes whose labels match every filter. */
  async findManaged(
    filter: { node?: string; workspaceId?: string },
    options: RequestOptions,
  ): Promise<CloudServer[]> {
    const tag =
      filter.node !== undefined
        ? LINODE_TAGS.tag(LABEL_NODE, filter.node)
        : filter.workspaceId !== undefined
          ? LINODE_TAGS.tag(LABEL_WORKSPACE, filter.workspaceId)
          : LINODE_TAGS.tag(LABEL_MANAGED, "true");
    const linodes = await this.client.listLinodes({ tags: tag }, options);
    return linodes
      .map(fromLinode)
      .filter(
        (s) =>
          s.managed !== null &&
          (filter.node === undefined || s.managed.node === filter.node) &&
          (filter.workspaceId === undefined || s.managed.workspaceId === filter.workspaceId),
      );
  }

  /** See {@link ProviderDriver.findByName}. */
  async findByName(name: string, options: RequestOptions): Promise<CloudServer[]> {
    return (await this.client.listLinodes({ label: name }, options))
      .filter((l) => l.label === name)
      .map(fromLinode);
  }

  /**
   * Finds the firewall by its unique label; it is managed when its tags say
   * so and name the same variant. Otherwise creates it, recovering from a
   * concurrent create through the label's uniqueness.
   */
  async ensureFirewall(spec: FirewallSpec, options: RequestOptions): Promise<string> {
    const find = async (): Promise<LinodeFirewall | undefined> =>
      (await this.client.listFirewalls({ label: spec.name }, options)).find(
        (f) => f.label === spec.name,
      );
    const ours = (fw: LinodeFirewall) => {
      const labels = LINODE_TAGS.decode(fw.tags ?? []);
      return labels[LABEL_MANAGED] === "true" && labels[LABEL_FIREWALL] === spec.variant;
    };
    const refuse = () =>
      new ProvisionError(
        "name_taken",
        `a firewall named ${spec.name} exists but is not managed by Roundhouse`,
      );
    const existing = await find();
    if (existing) {
      if (ours(existing)) return String(existing.id);
      throw refuse();
    }
    try {
      const fw = await this.client.createFirewall(
        {
          label: spec.name,
          rules: toLinodeRules(spec.rules),
          tags: LINODE_TAGS.encode({ [LABEL_MANAGED]: "true", [LABEL_FIREWALL]: spec.variant }),
        },
        options,
      );
      return String(fw.id);
    } catch (e) {
      if (!isConflict(e)) throw e;
      const raced = await find();
      if (raced && ours(raced)) return String(raced.id);
      throw refuse();
    }
  }

  /** Keys are passed inline at create, so there is nothing to upload. */
  async ensureSshKey(): Promise<null> {
    return null;
  }

  /** See {@link ProviderDriver.createServer}. */
  async createServer(spec: CreateServerSpec, options: RequestOptions): Promise<CreatedServer> {
    const linode = await this.client.createLinode(
      {
        label: spec.name,
        region: spec.region,
        type: spec.plan,
        image: spec.imageId,
        // NOTE: required by the API; generated, sent once, and never kept.
        root_pass: randomRootPassword(),
        authorized_keys: spec.sshPublicKey === null ? undefined : [spec.sshPublicKey],
        tags: LINODE_TAGS.encode(spec.labels),
        firewall_id: Number(spec.firewallId),
        metadata: { user_data: toBase64(spec.userData) },
        booted: true,
      },
      options,
    );
    return { server: fromLinode(linode) };
  }

  /** Polls the Linode until it is running. */
  waitUntilRunning(created: CreatedServer, options: PollOptions): Promise<CloudServer> {
    const id = Number(created.server.id);
    return pollUntil(
      this.clock,
      async () => {
        const s = fromLinode(await this.client.getLinode(id, { signal: options.signal }));
        return s.status === "running" ? s : undefined;
      },
      {
        ...options,
        onTimeout: () =>
          new ProviderActionError(
            "linode",
            String(id),
            "linode_create",
            "action_timeout",
            "Linode did not boot in time",
          ),
      },
    );
  }

  /** Deletes the Linode and, when asked, waits until it is gone. */
  async deleteServer(serverId: string, options: PollOptions & { wait: boolean }): Promise<void> {
    const id = Number(serverId);
    await this.client.deleteLinode(id, { signal: options.signal });
    if (!options.wait) return;
    await pollUntil(
      this.clock,
      async () => {
        try {
          await this.client.getLinode(id, { signal: options.signal });
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
            "linode",
            serverId,
            "linode_delete",
            "action_timeout",
            "Linode was not deleted in time",
          ),
      },
    );
  }
}
