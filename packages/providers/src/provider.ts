/**
 * The one interface the API and dashboard use for every cloud provider.
 *
 * - {@link Provider}: what callers use. Token checks, the priced catalogue,
 *   supported images, idempotent provisioning, guarded deprovisioning, and
 *   reconciliation listings, all with provider-neutral types.
 * - {@link ProviderDriver}: what an adapter implements. Small primitives
 *   (list, find, ensure, create, wait, delete) that the generic orchestration
 *   in `provision.ts` composes, so safety rules live in one place.
 * - {@link PROVIDERS} and {@link createProvider}: the registry and factory.
 *
 * Server IDs are strings everywhere, because Vultr's are UUIDs while the
 * others' are integers.
 *
 * @module
 */
import type { Arch, NodeRole, SupportedImageName } from "./catalog";
import { createDigitalOceanProvider } from "./digitalocean";
import type { ProviderId } from "./errors";
import type { FirewallSpec } from "./firewall";
import { createHetznerProvider } from "./hetzner";
import type { PollOptions, RequestOptions, TransportOptions } from "./http";
import { createLinodeProvider } from "./linode";
import type { ManagedIdentity } from "./naming";
import { createVultrProvider } from "./vultr";

export type { ProviderId } from "./errors";

// -----------------------------------------------------------------------------
// Values callers see
// -----------------------------------------------------------------------------

/** The account a token belongs to, as far as the provider reveals it. */
export interface AccountInfo {
  /** Provider account or user ID. */
  id?: string;
  /** Account email. */
  email?: string;
  /** Account, team, or user name. */
  name?: string;
}

/** Result of {@link Provider.validateToken}. */
export interface TokenCheck {
  /** `false` when the provider rejected the token. */
  valid: boolean;
  /** Whether the token can create servers, firewalls, and keys. */
  canWrite: boolean;
  /** Account details, when the token can read them. */
  account?: AccountInfo;
  /**
   * Scopes or permissions the token lacks for provisioning, when the
   * provider reports them (Linode scopes, Vultr ACLs).
   */
  missing?: string[];
}

/** One orderable plan in one region, priced. */
export interface Offer {
  /** Provider that sells it. */
  provider: ProviderId;
  /** Unique within a provider: `<plan>@<region>`. */
  id: string;
  /** Plan to order, e.g. `cpx22`, `s-2vcpu-4gb`, `vc2-2c-4gb`, `g6-standard-2`. */
  plan: string;
  /** Human-readable plan description. */
  description: string;
  /** Provider category, e.g. `"Shared vCPU"` or `"standard"`, when given. */
  category: string | null;
  /** Region or location ID to order in, e.g. `fsn1`, `nyc3`, `ewr`, `us-east`. */
  region: string;
  /** Human-readable region name, e.g. `Falkenstein` or `New York 3`. */
  regionName: string;
  /** ISO 3166-1 alpha-2 country, when known. */
  country: string | null;
  /** vCPU count. */
  vcpus: number;
  /** Memory in MiB. */
  memoryMib: number;
  /** Local disk in GB. */
  diskGb: number;
  /** CPU architecture. */
  arch: Arch;
  /** Dedicated (not shared) vCPUs. */
  dedicated: boolean;
  /** Monthly price as the provider bills it, in minor units. */
  price: {
    /** Monthly price cap in cents (gross where the provider adds VAT). */
    monthlyCents: number;
    /** ISO 4217 currency, e.g. `EUR` or `USD`. */
    currency: string;
  };
  /** Included outbound traffic in TB, when the provider says. */
  includedTrafficTb: number | null;
  /** The provider recommends this plan in this region. */
  recommended: boolean;
  /** Announced for removal but still orderable. */
  deprecated: boolean;
  /** RFC 3339 time it stops being orderable, when announced. */
  unavailableAfter: string | null;
}

/** Filter for {@link Provider.listOffers}. */
export interface OfferQuery {
  /** Only offers that meet the installer's floor for this role. Default `node`. */
  role?: NodeRole;
  /** Only this region. */
  region?: string;
  /** Include deprecated but orderable offers (flagged). Default `false`. */
  includeDeprecated?: boolean;
  /** Current unix ms, for deprecation dates. */
  now?: number;
}

/** A supported OS image on a provider. */
export interface ProviderImage {
  /** Value to create a server with (an ID, slug, or name). */
  id: string;
  /** Supported image name. */
  name: SupportedImageName;
  /** Architecture it boots on. */
  arch: Arch;
  /** Provider description, e.g. `Ubuntu 24.04 LTS x64`. */
  description: string;
  /** Announced for removal but still usable. */
  deprecated: boolean;
  /** Regions it is available in, or `null` for every region. */
  regions: string[] | null;
}

/** Normalised server lifecycle state. */
export type ServerStatus = "provisioning" | "running" | "stopped" | "deleting" | "unknown";

/** A server as any provider describes it. */
export interface CloudServer {
  /** Provider. */
  provider: ProviderId;
  /** Provider's server ID, as a string. */
  id: string;
  /** Server name or label. */
  name: string;
  /** Normalised state. */
  status: ServerStatus;
  /** The provider's own state, for display. */
  providerStatus: string;
  /** Public IPv4, or `null` while unassigned. */
  ipv4: string | null;
  /** Public IPv6 host address, or `null`. */
  ipv6: string | null;
  /** Region or location ID. */
  region: string;
  /** Plan ID. */
  plan: string;
  /** RFC 3339 creation time, when known. */
  createdAt: string | null;
  /** Labels decoded from the provider's labels or tags. */
  labels: Record<string, string>;
  /** Identity from the managed labels, or `null` for servers Roundhouse does not manage. */
  managed: ManagedIdentity | null;
}

/** Input to {@link Provider.provision}. */
export interface ProvisionInput {
  /** Node name; also the server name and the idempotency key. */
  name: string;
  /** Plan from an offer. */
  plan: string;
  /** Region from an offer. */
  region: string;
  /** OS image. Default `ubuntu-24.04`. */
  image?: SupportedImageName;
  /** Control plane origin; see `buildUserData`. */
  controlPlaneUrl: string;
  /** Fresh single-use join token. */
  joinToken: string;
  /** Join as a builder. */
  builder?: boolean;
  /** DEV ONLY: see `UserDataInput.allowLoopbackHttp`. */
  allowLoopbackHttp?: boolean;
  /** OpenSSH public key to install for root. */
  sshPublicKey?: string;
  /** Open 22/tcp in the firewall. Default `false`. */
  allowSsh?: boolean;
  /** Recorded as the `roundhouse.workspace` label. */
  workspaceId?: string;
}

/** Progress steps reported through {@link ProvisionOptions.onStep}. */
export type ProvisionStep =
  | "validate_token"
  | "check_existing"
  | "check_offer"
  | "ensure_firewall"
  | "ensure_ssh_key"
  | "create_server"
  | "wait_until_running"
  | "done";

/** Options for {@link Provider.provision}. */
export interface ProvisionOptions extends RequestOptions {
  /** Called as each step starts, e.g. to stream progress to the dashboard. */
  onStep?: (step: ProvisionStep) => void;
  /** Overall limit for the server to reach `running`, in ms. Default 600 000. */
  readyTimeoutMs?: number;
  /** First poll delay while waiting, in ms. Default 1 000. */
  pollIntervalMs?: number;
}

/** Result of {@link Provider.provision}. */
export interface ProvisionResult {
  /** The server. Never contains a root password. */
  server: CloudServer;
  /** `false` when a managed server with this name already existed. */
  created: boolean;
  /** Firewall ID; `null` only when an existing server was reused. */
  firewallId: string | null;
  /** SSH key ID, or `null` when none was given or the provider takes keys inline. */
  sshKeyId: string | null;
}

/** Input to {@link Provider.deprovision}. */
export interface DeprovisionInput {
  /** Provider's server ID. */
  serverId: string;
  /**
   * When set, the server's node label must equal it, which guards against a
   * stale or mistyped ID pointing at a different managed server.
   */
  expectedName?: string;
  /** Wait until the provider confirms the delete. Default `true`. */
  wait?: boolean;
}

/** Result of {@link Provider.deprovision}. */
export interface DeprovisionResult {
  /** Provider's server ID. */
  serverId: string;
  /** `false` when the server was already gone. */
  deleted: boolean;
}

/** Options for {@link Provider.deprovision}. */
export interface DeprovisionOptions extends RequestOptions {
  /** Overall limit for the delete to finish, in ms. Default 600 000. */
  readyTimeoutMs?: number;
  /** First poll delay while waiting, in ms. Default 1 000. */
  pollIntervalMs?: number;
}

/**
 * A cloud provider, behind one interface.
 *
 * @example
 * const provider = createProvider("hetzner", { token });
 * const check = await provider.validateToken();
 * if (!check.canWrite) throw new Error("needs a read/write token");
 * const [offer] = await provider.listOffers({ role: "node" });
 * const { server } = await provider.provision({
 *   name: "web-1",
 *   plan: offer.plan,
 *   region: offer.region,
 *   controlPlaneUrl: "https://cp.example.com",
 *   joinToken,
 * });
 */
export interface Provider {
  /** Provider ID. */
  readonly id: ProviderId;
  /** Name for the UI, e.g. `Hetzner Cloud`. */
  readonly displayName: string;

  /**
   * Checks the token without side effects.
   *
   * @param options - Signal and timeout.
   * @returns Whether it is valid and can write, and the account when visible.
   */
  validateToken(options?: RequestOptions): Promise<TokenCheck>;

  /**
   * Lists orderable plans per region with live prices, cheapest first.
   *
   * @param query - Role floor, region, and deprecated handling.
   * @param options - Signal and timeout.
   * @returns Offers the installer can run on.
   */
  listOffers(query?: OfferQuery, options?: RequestOptions): Promise<Offer[]>;

  /**
   * Lists supported OS images (Ubuntu 24.04/22.04, Debian 12) per architecture.
   *
   * @param filter - Optional region and architecture.
   * @param options - Signal and timeout.
   * @returns Supported images.
   */
  listImages(
    filter?: { region?: string; arch?: Arch },
    options?: RequestOptions,
  ): Promise<ProviderImage[]>;

  /**
   * Creates a server that joins the control plane on first boot. Idempotent
   * by node name; cleans up after any failure once the server exists.
   *
   * @param input - What to create.
   * @param options - Progress callback, signal, and timeouts.
   * @returns The server; never a root password.
   * @throws ProvisionError for refused or failed steps, and ProviderApiError
   *   for API errors before the server exists.
   */
  provision(input: ProvisionInput, options?: ProvisionOptions): Promise<ProvisionResult>;

  /**
   * Deletes a managed server. Refuses servers without the managed marker or
   * with a different node name.
   *
   * @param input - Server ID and the expected node name.
   * @param options - Signal and timeouts.
   * @returns Whether a delete happened.
   * @throws ProvisionError `not_managed`.
   */
  deprovision(input: DeprovisionInput, options?: DeprovisionOptions): Promise<DeprovisionResult>;

  /**
   * Reads one server, managed or not.
   *
   * @param serverId - Provider's server ID.
   * @param options - Signal and timeout.
   * @returns The server, or `null` when it does not exist.
   */
  getServer(serverId: string, options?: RequestOptions): Promise<CloudServer | null>;

  /**
   * Lists servers Roundhouse manages, for reconciling against the nodes table.
   *
   * @param filter - Optional workspace ID.
   * @param options - Signal and timeout.
   * @returns Managed servers.
   */
  listManaged(filter?: { workspaceId?: string }, options?: RequestOptions): Promise<CloudServer[]>;
}

// -----------------------------------------------------------------------------
// The adapter contract
// -----------------------------------------------------------------------------

/** What `provision.ts` asks an adapter to create. */
export interface CreateServerSpec {
  /** Validated node name. */
  name: string;
  /** Plan ID. */
  plan: string;
  /** Region ID. */
  region: string;
  /** Image value from {@link ProviderImage.id}. */
  imageId: string;
  /** cloud-init user data, plain text; the adapter encodes it if needed. */
  userData: string;
  /** Managed labels to store as labels or tags. */
  labels: Record<string, string>;
  /** Firewall from {@link ProviderDriver.ensureFirewall}. */
  firewallId: string;
  /** Key from {@link ProviderDriver.ensureSshKey}, or `null`. */
  sshKeyId: string | null;
  /** Normalised public key, for providers that take keys inline, or `null`. */
  sshPublicKey: string | null;
}

/** A server the adapter just created, plus whatever it needs to wait for it. */
export interface CreatedServer {
  /** The server as the create response described it. */
  server: CloudServer;
  /** Adapter-private state for {@link ProviderDriver.waitUntilRunning}, e.g. action IDs. */
  pending?: unknown;
}

/**
 * Primitives an adapter implements. `provision.ts` composes them; adapters
 * never decide on safety (idempotency, cleanup, the deprovision check).
 */
export interface ProviderDriver {
  /** Provider ID. */
  readonly id: ProviderId;
  /** Name for the UI. */
  readonly displayName: string;
  /** Largest user data the provider accepts, in bytes of the plain document. */
  readonly userDataLimitBytes: number;
  /** Sleep and clock, normally the HTTP client's, for polling. */
  readonly clock: { sleep: (ms: number, signal?: AbortSignal) => Promise<void>; now: () => number };

  /**
   * Rejects names the provider would refuse, beyond the shared DNS-label rule.
   *
   * @param name - A valid node name.
   * @throws ProvisionError `invalid_input`.
   */
  validateName?(name: string): void;
  /**
   * Rejects managed labels the provider cannot store, e.g. a tag over its
   * length limit or with a forbidden character.
   *
   * @param labels - The labels the server would carry.
   * @throws ProvisionError `invalid_input`.
   */
  validateLabels?(labels: Record<string, string>): void;
  /** See {@link Provider.validateToken}. */
  validateToken(options: RequestOptions): Promise<TokenCheck>;
  /**
   * Every offer, including deprecated ones (flagged) but excluding ones that
   * cannot be ordered now. No role floor applied.
   */
  listOffers(options: RequestOptions & { now: number }): Promise<Offer[]>;
  /**
   * One plan in one region, or `null` when unknown or not orderable there.
   * Deprecated-but-orderable plans are returned.
   */
  getOffer(
    plan: string,
    region: string,
    options: RequestOptions & { now: number },
  ): Promise<Offer | null>;
  /** Supported images, optionally narrowed to a region and architecture. */
  listImages(
    filter: { region?: string; arch?: Arch },
    options: RequestOptions,
  ): Promise<ProviderImage[]>;
  /** One server, or `null` when it does not exist. */
  getServer(serverId: string, options: RequestOptions): Promise<CloudServer | null>;
  /**
   * Managed servers, optionally for one node name or workspace. Must return
   * only servers whose labels decode as managed.
   */
  findManaged(
    filter: { node?: string; workspaceId?: string },
    options: RequestOptions,
  ): Promise<CloudServer[]>;
  /** Every server with exactly this name, managed or not. */
  findByName(name: string, options: RequestOptions): Promise<CloudServer[]>;
  /**
   * Finds or creates the managed firewall for `spec`.
   *
   * @returns The firewall ID.
   * @throws ProvisionError `name_taken` when an unmanaged firewall holds the name.
   */
  ensureFirewall(spec: FirewallSpec, options: RequestOptions): Promise<string>;
  /**
   * Finds or uploads a key.
   *
   * @returns The key ID, or `null` when the provider takes keys inline at create.
   */
  ensureSshKey(normalizedKey: string, options: RequestOptions): Promise<string | null>;
  /**
   * Creates the server. Must not be retried by the adapter on ambiguous
   * failures; `provision.ts` recovers those by label lookup.
   */
  createServer(spec: CreateServerSpec, options: RequestOptions): Promise<CreatedServer>;
  /**
   * Waits until the server runs.
   *
   * @throws ProviderActionError when it fails or does not finish in time.
   */
  waitUntilRunning(created: CreatedServer, options: PollOptions): Promise<CloudServer>;
  /**
   * Deletes a server.
   *
   * @throws ProviderApiError `not_found` when it is already gone.
   */
  deleteServer(serverId: string, options: PollOptions & { wait: boolean }): Promise<void>;
}

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

/** Static facts about a provider, for the dashboard's connect dialog. */
export interface ProviderInfo {
  /** Provider ID. */
  id: ProviderId;
  /** Name for the UI. */
  displayName: string;
  /** Where the user creates a token. */
  tokenUrl: string;
  /** Documentation for creating the token. */
  tokenDocsUrl: string;
  /** The least-privilege scopes or permissions provisioning needs, as the provider names them. */
  requiredScopes: string[];
  /** One-line guidance shown next to the token field. */
  tokenHint: string;
  /** API documentation the adapter was verified against. */
  apiDocsUrl: string;
}

/** Options for {@link createProvider}. */
export interface ProviderOptions extends TransportOptions {
  /** The user's API token. Never logged or returned. */
  token: string;
  /** API base URL override, for tests and proxies. */
  baseUrl?: string;
}

/**
 * Every supported provider, with what the connect dialog needs: where to
 * create a token and the least-privilege permissions to give it.
 */
export const PROVIDERS: Readonly<Record<ProviderId, ProviderInfo>> = {
  hetzner: {
    id: "hetzner",
    displayName: "Hetzner Cloud",
    tokenUrl: "https://console.hetzner.cloud/projects",
    tokenDocsUrl: "https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/",
    requiredScopes: ["Read & Write"],
    tokenHint:
      "Open the project, then Security → API tokens → Generate API token with Read & Write. Tokens are scoped to one project; use a project for Roundhouse servers.",
    apiDocsUrl: "https://docs.hetzner.cloud/reference/cloud",
  },
  digitalocean: {
    id: "digitalocean",
    displayName: "DigitalOcean",
    tokenUrl: "https://cloud.digitalocean.com/account/api/tokens",
    tokenDocsUrl: "https://docs.digitalocean.com/reference/api/create-personal-access-token/",
    requiredScopes: [
      "account:read",
      "actions:read",
      "droplet:create",
      "droplet:read",
      "droplet:delete",
      "firewall:create",
      "firewall:read",
      "image:read",
      "regions:read",
      "sizes:read",
      "ssh_key:create",
      "ssh_key:read",
      "tag:create",
      "tag:read",
    ],
    tokenHint:
      "Generate New Token → Custom Scopes, and select the scopes listed. Full Access also works but grants more than provisioning needs.",
    apiDocsUrl: "https://docs.digitalocean.com/reference/api/digitalocean/",
  },
  vultr: {
    id: "vultr",
    displayName: "Vultr",
    tokenUrl: "https://console.vultr.com/settings/#settingsapi",
    tokenDocsUrl: "https://www.vultr.com/api/#section/Authentication",
    requiredScopes: ["provisioning", "subscriptions", "firewall"],
    tokenHint:
      "Vultr keys carry the permissions of their user. Prefer an API-only sub-user with the provisioning, subscriptions, and firewall permissions. The key's access control must allow the control plane's egress addresses.",
    apiDocsUrl: "https://www.vultr.com/api/",
  },
  linode: {
    id: "linode",
    displayName: "Akamai Cloud (Linode)",
    tokenUrl: "https://cloud.linode.com/profile/tokens",
    tokenDocsUrl: "https://techdocs.akamai.com/linode-api/reference/get-started",
    requiredScopes: ["linodes:read_write", "firewall:read_write", "images:read_only"],
    tokenHint:
      "Create a Personal Access Token with Linodes and Firewalls set to Read/Write and Images to Read Only; everything else can be No Access. The user must be unrestricted to tag Linodes.",
    apiDocsUrl: "https://techdocs.akamai.com/linode-api/reference/api",
  },
};

/** Every provider ID, in display order. */
export const PROVIDER_IDS: readonly ProviderId[] = ["hetzner", "digitalocean", "vultr", "linode"];

/**
 * Whether a string is a supported provider ID.
 *
 * @param id - Candidate, e.g. from a request body.
 * @returns `true` for a key of {@link PROVIDERS}.
 */
export function isProviderId(id: string): id is ProviderId {
  return Object.hasOwn(PROVIDERS, id);
}

/**
 * Creates a provider by ID. The only place that knows which adapter backs
 * which ID, so callers stay provider-neutral.
 *
 * @param id - Provider ID.
 * @param options - The user's token and transport tuning.
 * @returns The provider.
 * @throws TypeError for an empty or malformed token.
 * @example
 * const provider = createProvider(row.provider, { token: await unseal(row.token) });
 * const servers = await provider.listManaged({ workspaceId });
 */
export function createProvider(id: ProviderId, options: ProviderOptions): Provider {
  switch (id) {
    case "hetzner":
      return createHetznerProvider(options);
    case "digitalocean":
      return createDigitalOceanProvider(options);
    case "vultr":
      return createVultrProvider(options);
    case "linode":
      return createLinodeProvider(options);
    default: {
      const unknown: never = id;
      throw new TypeError(`unknown provider ${String(unknown)}`);
    }
  }
}
