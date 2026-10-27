/**
 * A typed, minimal client for the Cloudflare APIs the Containers provider
 * uses (ADR 0011 "Facts" and "Deploy and switching"):
 * - Workers scripts: multipart upload, `workers.dev` enablement, delete,
 *   list, and the account's `workers.dev` subdomain;
 * - Durable Object namespaces (to find `(script, AppContainer)`);
 * - Containers applications, rollouts and `instances-v2`;
 * - registry credentials for `registry.cloudflare.com`, and tag listing and
 *   deletion through the registry's Docker Registry HTTP API v2;
 * - Worker routes on the apps zone, and the zone lookup;
 * - the `RH-Warm` request to the script's `workers.dev` address.
 *
 * Every request goes through one transport, swapped out in tests with
 * {@link setCloudflareApiTransport} (the in-process fake in
 * `test/fake-cloudflare.ts` answers all of them). Failures throw
 * {@link CloudflareProviderError}, whose message carries Cloudflare's own
 * error messages verbatim (ADR 0011: "Failures name the Cloudflare API error
 * verbatim") and never the token.
 *
 * TODO: request and response bodies of the Containers and registry calls
 * follow the public API reference and wrangler's usage as of 2026-10-22;
 * they are verified only against the fake until a live account runs
 * `docs/cloudflare-containers.md` "Live verification".
 *
 * @module
 */

/** Cloudflare's API base. */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** The managed registry's host (ADR 0011 "Registry"). */
export const CLOUDFLARE_REGISTRY_HOST = "registry.cloudflare.com";

/** Per-call timeout: a stuck API must not hold a workflow step. */
const CALL_TIMEOUT_MS = 30_000;

/** Longest error text kept; Cloudflare's messages are short, HTML error pages are not. */
const MAX_ERROR_LENGTH = 1000;

let transport: typeof fetch | null = null;

/**
 * Replaces the `fetch` every Cloudflare provider call uses, for tests.
 *
 * @param fn - A fetch implementation, or `null` to restore the global one.
 */
export function setCloudflareApiTransport(fn: typeof fetch | null): void {
  transport = fn;
}

/**
 * The `fetch` provider calls go through.
 *
 * @returns The test transport when set, else the global `fetch`.
 */
export function cloudflareFetch(): typeof fetch {
  return transport ?? fetch;
}

/** One entry of Cloudflare's `errors` array. */
export interface CloudflareErrorEntry {
  code?: number | string;
  message?: string;
}

/** A Cloudflare API call that did not succeed, described in words safe to show. */
export class CloudflareProviderError extends Error {
  override name = "CloudflareProviderError";
  /**
   * @param message - What failed, with Cloudflare's messages verbatim.
   * @param status - HTTP status; 0 when the request never got an answer.
   * @param errors - Cloudflare's `errors` array, when it sent one.
   */
  constructor(
    message: string,
    readonly status: number,
    readonly errors: readonly CloudflareErrorEntry[] = [],
  ) {
    super(message);
  }
}

/** Account, token and (for tests) the API base. */
export interface CloudflareCredentials {
  accountId: string;
  apiToken: string;
  /** Defaults to {@link CLOUDFLARE_API_BASE}. */
  baseUrl?: string;
}

interface Envelope<T> {
  success?: boolean;
  errors?: CloudflareErrorEntry[];
  result?: T;
}

/** A Worker script as listed. */
export interface CloudflareScript {
  id: string;
}

/** A Durable Object namespace as listed. */
export interface DurableObjectNamespace {
  id: string;
  name?: string;
  script?: string;
  class?: string;
}

/** A binding in a script upload's metadata. */
export type ScriptBinding =
  | { type: "durable_object_namespace"; name: string; class_name: string }
  | { type: "service"; name: string; service: string; entrypoint?: string }
  | { type: "secret_text"; name: string; text: string }
  | { type: "plain_text"; name: string; text: string }
  | { type: "analytics_engine"; name: string; dataset: string };

/** `metadata` of a module-syntax script upload. */
export interface ScriptMetadata {
  main_module: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  bindings: ScriptBinding[];
  migrations?: { new_sqlite_classes: string[] };
  tail_consumers?: { service: string }[];
}

/** One module of a script upload. */
export interface ScriptModule {
  name: string;
  content: string;
  /** e.g. `application/javascript+module`. */
  contentType: string;
}

/** A container application's configuration (the part rollouts replace). */
export interface ContainerConfiguration {
  image: string;
  instance_type?: string;
}

/** Body of `POST /containers/applications` for a Durable-Object application. */
export interface CreateApplicationBody {
  name: string;
  scheduling_policy: "default";
  instances: number;
  max_instances: number;
  configuration: ContainerConfiguration;
  durable_objects: { namespace_id: string };
  constraints?: { regions?: string[] };
}

/** A container application as the API returns it (fields this code reads). */
export interface ContainerApplication {
  id: string;
  name: string;
  max_instances?: number;
  configuration?: ContainerConfiguration;
  /** Set while a rollout is in progress. */
  active_rollout_id?: string | null;
}

/** Body of `POST …/applications/{id}/rollouts`. */
export interface CreateRolloutBody {
  description: string;
  strategy: "rolling";
  kind: "full_auto";
  step_percentage: number;
  target_configuration: ContainerConfiguration;
}

/** A rollout as the API returns it (fields this code reads). */
export interface ContainerRollout {
  id: string;
  /** `progressing`, `completed`, or a failure such as `failed`, `aborted`, `reverted`. */
  status: string;
  /** Free text the API may set on a failed rollout. */
  status_message?: string;
  error?: string;
}

/** Instances of an application, as `instances-v2` returns them (fields this code reads). */
export interface ContainerInstances {
  instances: { id: string; state?: string; status?: { health?: string } }[];
}

/** Temporary credentials for the managed registry. */
export interface RegistryCredentials {
  registry_host: string;
  username: string;
  password: string;
}

/** A Worker route. */
export interface WorkerRoute {
  id: string;
  pattern: string;
  script?: string;
}

/** A zone. */
export interface Zone {
  id: string;
  name: string;
}

const encodeSegment = (s: string) => encodeURIComponent(s);

/**
 * Describes a failed response in words: Cloudflare's own messages, verbatim,
 * with the token scrubbed in case an error ever echoes it.
 */
function describeFailure(
  what: string,
  status: number,
  errors: readonly CloudflareErrorEntry[],
  token: string,
): string {
  const detail = errors
    .map((e) =>
      e.code !== undefined && e.message
        ? `${e.message} (code ${e.code})`
        : (e.message ?? `code ${e.code}`),
    )
    .filter(Boolean)
    .join("; ");
  const text = `${what}: Cloudflare answered ${status}${detail ? `: ${detail}` : ""}`;
  return (token ? text.split(token).join("[redacted]") : text).slice(0, MAX_ERROR_LENGTH);
}

/** Calls of one account with one token. */
export class CloudflareClient {
  readonly accountId: string;
  private readonly token: string;
  private readonly base: string;

  /**
   * @param credentials - Account ID, API token and optional base URL.
   */
  constructor(credentials: CloudflareCredentials) {
    this.accountId = credentials.accountId;
    this.token = credentials.apiToken;
    this.base = (credentials.baseUrl ?? CLOUDFLARE_API_BASE).replace(/\/+$/, "");
  }

  private get account(): string {
    return `/accounts/${encodeSegment(this.accountId)}`;
  }

  /**
   * One JSON API call, unwrapped from Cloudflare's envelope.
   *
   * @param what - What the call does, for the error message ("Uploading the runtime script").
   */
  private async call<T>(
    what: string,
    method: string,
    path: string,
    body?: unknown,
    init: { form?: FormData } = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await cloudflareFetch()(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: init.form ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      throw new CloudflareProviderError(
        `${what}: Cloudflare API unreachable: ${err instanceof Error ? err.message : "request failed"}`,
        0,
      );
    }
    let parsed: Envelope<T> | null = null;
    try {
      parsed = (await res.json()) as Envelope<T>;
    } catch {
      // A non-JSON answer (an HTML error page) is reported by its status.
    }
    if (!res.ok || parsed?.success === false || !parsed) {
      const errors = parsed?.errors ?? [];
      throw new CloudflareProviderError(
        describeFailure(what, res.status, errors, this.token),
        res.status,
        errors,
      );
    }
    return parsed.result as T;
  }

  // ---------------------------------------------------------------------------
  // Account and token
  // ---------------------------------------------------------------------------

  /**
   * Checks the token is active: the account-token endpoint first, then the
   * user-token one (a token may be owned by either).
   *
   * @returns The token's status, e.g. `active`.
   */
  async verifyToken(): Promise<string> {
    try {
      const r = await this.call<{ status?: string }>(
        "Verifying the API token",
        "GET",
        `${this.account}/tokens/verify`,
      );
      return r?.status ?? "unknown";
    } catch (err) {
      if (!(err instanceof CloudflareProviderError) || (err.status !== 404 && err.status !== 401))
        throw err;
      const r = await this.call<{ status?: string }>(
        "Verifying the API token",
        "GET",
        "/user/tokens/verify",
      );
      return r?.status ?? "unknown";
    }
  }

  /** Lists the account's Worker scripts. */
  listScripts(): Promise<CloudflareScript[]> {
    return this.call("Listing Workers scripts", "GET", `${this.account}/workers/scripts`);
  }

  /**
   * The account's `workers.dev` subdomain.
   *
   * @returns e.g. `acme` for `*.acme.workers.dev`.
   */
  async workersSubdomain(): Promise<string> {
    const r = await this.call<{ subdomain?: string }>(
      "Reading the workers.dev subdomain",
      "GET",
      `${this.account}/workers/subdomain`,
    );
    if (!r?.subdomain) {
      throw new CloudflareProviderError(
        "Reading the workers.dev subdomain: the account has none; open Workers & Pages once in the Cloudflare dashboard to create it",
        200,
      );
    }
    return r.subdomain;
  }

  /**
   * Finds a zone by exact name in this account.
   *
   * @param name - e.g. `example.com`.
   * @returns The zone, or `null` when there is none.
   */
  async findZone(name: string): Promise<Zone | null> {
    const zones = await this.call<Zone[]>(
      `Looking up the zone ${name}`,
      "GET",
      `/zones?name=${encodeSegment(name)}&account.id=${encodeSegment(this.accountId)}`,
    );
    return zones.find((z) => z.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Scripts
  // ---------------------------------------------------------------------------

  /**
   * Uploads (creates or replaces) a module-syntax script.
   *
   * @param name - Script name.
   * @param metadata - `metadata` part.
   * @param modules - Module parts; the main module among them.
   */
  async uploadScript(name: string, metadata: ScriptMetadata, modules: ScriptModule[]) {
    const form = new FormData();
    form.set(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      "metadata.json",
    );
    for (const m of modules) {
      form.set(m.name, new Blob([m.content], { type: m.contentType }), m.name);
    }
    await this.call<unknown>(
      "Uploading the runtime script",
      "PUT",
      `${this.account}/workers/scripts/${encodeSegment(name)}`,
      undefined,
      { form },
    );
  }

  /**
   * Turns on the script's `workers.dev` address (previews off), so warm-up
   * does not depend on routes.
   *
   * @param name - Script name.
   */
  async enableWorkersDev(name: string): Promise<void> {
    await this.call<unknown>(
      "Enabling workers.dev for the runtime script",
      "POST",
      `${this.account}/workers/scripts/${encodeSegment(name)}/subdomain`,
      { enabled: true, previews_enabled: false },
    );
  }

  /**
   * Deletes a script and its Durable Object storage.
   *
   * @param name - Script name.
   * @returns `false` when it was already gone.
   */
  async deleteScript(name: string): Promise<boolean> {
    try {
      await this.call<unknown>(
        "Deleting the runtime script",
        "DELETE",
        `${this.account}/workers/scripts/${encodeSegment(name)}?force=true`,
      );
      return true;
    } catch (err) {
      if (err instanceof CloudflareProviderError && err.status === 404) return false;
      throw err;
    }
  }

  /** Lists the account's Durable Object namespaces. */
  listDurableObjectNamespaces(): Promise<DurableObjectNamespace[]> {
    return this.call(
      "Listing Durable Object namespaces",
      "GET",
      `${this.account}/workers/durable_objects/namespaces?per_page=1000`,
    );
  }

  // ---------------------------------------------------------------------------
  // Containers
  // ---------------------------------------------------------------------------

  /** Lists the account's container applications. */
  listApplications(): Promise<ContainerApplication[]> {
    return this.call(
      "Listing container applications",
      "GET",
      `${this.account}/containers/applications`,
    );
  }

  /**
   * Creates a Durable-Object container application.
   *
   * @param body - Name, image, instance type, pool size, namespace.
   */
  createApplication(body: CreateApplicationBody): Promise<ContainerApplication> {
    return this.call(
      "Creating the container application",
      "POST",
      `${this.account}/containers/applications`,
      body,
    );
  }

  /**
   * Reads an application.
   *
   * @param id - Application ID.
   */
  getApplication(id: string): Promise<ContainerApplication> {
    return this.call(
      "Reading the container application",
      "GET",
      `${this.account}/containers/applications/${encodeSegment(id)}`,
    );
  }

  /**
   * Changes an application's settings, e.g. `max_instances`.
   *
   * @param id - Application ID.
   * @param body - Fields to change.
   */
  patchApplication(
    id: string,
    body: { max_instances?: number; constraints?: { regions?: string[] } },
  ): Promise<ContainerApplication> {
    return this.call(
      "Updating the container application",
      "PATCH",
      `${this.account}/containers/applications/${encodeSegment(id)}`,
      body,
    );
  }

  /**
   * Deletes an application.
   *
   * @param id - Application ID.
   * @returns `false` when it was already gone.
   */
  async deleteApplication(id: string): Promise<boolean> {
    try {
      await this.call<unknown>(
        "Deleting the container application",
        "DELETE",
        `${this.account}/containers/applications/${encodeSegment(id)}`,
      );
      return true;
    } catch (err) {
      if (err instanceof CloudflareProviderError && err.status === 404) return false;
      throw err;
    }
  }

  /**
   * Starts a rollout of a new configuration (image).
   *
   * @param id - Application ID.
   * @param body - Target configuration and strategy.
   */
  createRollout(id: string, body: CreateRolloutBody): Promise<ContainerRollout> {
    return this.call(
      "Starting the container rollout",
      "POST",
      `${this.account}/containers/applications/${encodeSegment(id)}/rollouts`,
      body,
    );
  }

  /**
   * Reads one rollout.
   *
   * @param id - Application ID.
   * @param rolloutId - Rollout ID.
   */
  getRollout(id: string, rolloutId: string): Promise<ContainerRollout> {
    return this.call(
      "Reading the container rollout",
      "GET",
      `${this.account}/containers/applications/${encodeSegment(id)}/rollouts/${encodeSegment(rolloutId)}`,
    );
  }

  /**
   * Lists an application's instances.
   *
   * @param id - Application ID.
   */
  listInstances(id: string): Promise<ContainerInstances> {
    return this.call(
      "Listing container instances",
      "GET",
      `${this.account}/containers/applications/${encodeSegment(id)}/instances-v2`,
    );
  }

  /**
   * Mints temporary credentials for the managed registry.
   *
   * @param permissions - `push`, `pull`, or both.
   * @param expirationMinutes - Lifetime; 15 by default.
   */
  async registryCredentials(
    permissions: ("push" | "pull")[],
    expirationMinutes = 15,
  ): Promise<RegistryCredentials> {
    const r = await this.call<Partial<RegistryCredentials>>(
      "Minting registry credentials",
      "POST",
      `${this.account}/containers/registries/${CLOUDFLARE_REGISTRY_HOST}/credentials`,
      { expiration_minutes: expirationMinutes, permissions },
    );
    if (!r?.password) {
      throw new CloudflareProviderError(
        "Minting registry credentials: Cloudflare returned no password",
        200,
      );
    }
    return {
      registry_host: r.registry_host ?? CLOUDFLARE_REGISTRY_HOST,
      // NOTE: wrangler logs in as `v1` when the API leaves the username out.
      username: r.username ?? "v1",
      password: r.password,
    };
  }

  // ---------------------------------------------------------------------------
  // Registry (Docker Registry HTTP API v2)
  // ---------------------------------------------------------------------------

  private async registry(
    what: string,
    creds: RegistryCredentials,
    method: string,
    path: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    let res: Response;
    try {
      res = await cloudflareFetch()(`https://${creds.registry_host}/v2/${path}`, {
        method,
        headers: {
          authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}`,
          ...headers,
        },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      throw new CloudflareProviderError(
        `${what}: registry unreachable: ${err instanceof Error ? err.message : "request failed"}`,
        0,
      );
    }
    if (!res.ok) {
      let errors: CloudflareErrorEntry[] = [];
      try {
        errors = ((await res.json()) as { errors?: CloudflareErrorEntry[] }).errors ?? [];
      } catch {
        // Status alone describes it.
      }
      throw new CloudflareProviderError(
        describeFailure(what, res.status, errors, creds.password),
        res.status,
        errors,
      );
    }
    return res;
  }

  /**
   * Lists the tags of one repository of this account.
   *
   * @param creds - Registry credentials with `pull`.
   * @param repository - Repository name below the account, e.g. `rh-abc…`.
   */
  async listTags(creds: RegistryCredentials, repository: string): Promise<string[]> {
    const res = await this.registry(
      "Listing image tags",
      creds,
      "GET",
      `${this.accountId}/${repository}/tags/list`,
    );
    const body = (await res.json()) as { tags?: string[] | null };
    return body.tags ?? [];
  }

  /**
   * Deletes one tag's manifest (by digest, as the registry API requires).
   *
   * @param creds - Registry credentials with `push`.
   * @param repository - Repository name below the account.
   * @param tag - The tag.
   */
  async deleteTag(creds: RegistryCredentials, repository: string, tag: string): Promise<void> {
    const accept = [
      "application/vnd.oci.image.index.v1+json",
      "application/vnd.docker.distribution.manifest.list.v2+json",
      "application/vnd.oci.image.manifest.v1+json",
      "application/vnd.docker.distribution.manifest.v2+json",
    ].join(", ");
    const head = await this.registry(
      "Reading an image tag",
      creds,
      "HEAD",
      `${this.accountId}/${repository}/manifests/${encodeSegment(tag)}`,
      { accept },
    );
    const digest = head.headers.get("docker-content-digest");
    if (!digest) return;
    await this.registry(
      "Deleting an image tag",
      creds,
      "DELETE",
      `${this.accountId}/${repository}/manifests/${digest}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  /**
   * Lists a zone's Worker routes.
   *
   * @param zoneId - Zone ID.
   */
  listRoutes(zoneId: string): Promise<WorkerRoute[]> {
    return this.call(
      "Listing Worker routes",
      "GET",
      `/zones/${encodeSegment(zoneId)}/workers/routes`,
    );
  }

  /**
   * Creates a Worker route.
   *
   * @param zoneId - Zone ID.
   * @param pattern - e.g. `app.example.com/*`.
   * @param script - Script name.
   */
  createRoute(zoneId: string, pattern: string, script: string): Promise<WorkerRoute> {
    return this.call(
      `Creating the Worker route ${pattern}`,
      "POST",
      `/zones/${encodeSegment(zoneId)}/workers/routes`,
      { pattern, script },
    );
  }

  /**
   * Points an existing Worker route at a script.
   *
   * @param zoneId - Zone ID.
   * @param routeId - Route ID.
   * @param pattern - The route's pattern.
   * @param script - Script name.
   */
  updateRoute(
    zoneId: string,
    routeId: string,
    pattern: string,
    script: string,
  ): Promise<WorkerRoute> {
    return this.call(
      `Updating the Worker route ${pattern}`,
      "PUT",
      `/zones/${encodeSegment(zoneId)}/workers/routes/${encodeSegment(routeId)}`,
      { pattern, script },
    );
  }

  /**
   * Deletes a Worker route.
   *
   * @param zoneId - Zone ID.
   * @param routeId - Route ID.
   * @returns `false` when it was already gone.
   */
  async deleteRoute(zoneId: string, routeId: string): Promise<boolean> {
    try {
      await this.call<unknown>(
        "Deleting a Worker route",
        "DELETE",
        `/zones/${encodeSegment(zoneId)}/workers/routes/${encodeSegment(routeId)}`,
      );
      return true;
    } catch (err) {
      if (err instanceof CloudflareProviderError && err.status === 404) return false;
      throw err;
    }
  }
}

/**
 * Sends the deploy warm-up to a runtime script's `workers.dev` address.
 *
 * @param url - `https://<script>.<subdomain>.workers.dev<health_path>`.
 * @param header - Header name and value (`RH-Warm`).
 * @returns The response status; 0 when unreachable.
 */
export async function sendWarmUp(url: string, header: [string, string]): Promise<number> {
  try {
    const res = await cloudflareFetch()(url, {
      headers: { [header[0]]: header[1] },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    await res.body?.cancel();
    return res.status;
  } catch {
    return 0;
  }
}
