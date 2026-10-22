/**
 * High-level provisioning: create a server that joins the control plane, and
 * delete it safely.
 *
 * `provisionServer` steps:
 * 1. validate inputs and build the user data (no API calls);
 * 2. validate the token (invalid vs read-only);
 * 3. look for an existing managed server with this node name (idempotency);
 * 4. check the server type is orderable in the location and resolve the image;
 * 5. ensure the default firewall, and the SSH key if one was given;
 * 6. create the server with labels, firewall, key, and user data;
 * 7. wait for its actions; on any failure from here on, delete the server.
 *
 * Firewalls and SSH keys are shared, reusable, and free, so they are kept
 * when a later step fails.
 *
 * @module
 */
import { DEFAULT_IMAGE, SUPPORTED_IMAGES, type SupportedImageName } from "./catalog";
import type { HetznerClient, RequestOptions } from "./client";
import { buildUserData, validateNodeName } from "./cloud-init";
import {
  errorMessage,
  HetznerApiError,
  HetznerNetworkError,
  HetznerTimeoutError,
  ProvisionError,
} from "./errors";
import { ensureFirewall } from "./firewall";
import {
  isManaged,
  isValidLabelValue,
  LABEL_MANAGED,
  LABEL_NODE,
  LABEL_ROLE,
  LABEL_WORKSPACE,
  nodeSelector,
  validateExtraLabels,
} from "./labels";
import { ensureSshKey, normalizeSshPublicKey } from "./ssh-keys";
import type { Action, Server, ServerStatus } from "./types";

/** Input to {@link provisionServer}. */
export interface ProvisionInput {
  /** Node name; also the Hetzner server name and the idempotency key. */
  name: string;
  /** Server type name from an offer, e.g. `cpx22`. */
  serverType: string;
  /** Location name from an offer, e.g. `fsn1`. */
  location: string;
  /** OS image. Default `ubuntu-24.04`. */
  image?: SupportedImageName;
  /** Control plane origin; see {@link buildUserData}. */
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
  /** Extra labels; keys may not use the `roundhouse.` prefix. */
  labels?: Record<string, string>;
}

/** Progress steps reported through {@link ProvisionOptions.onStep}. */
export type ProvisionStep =
  | "validate_token"
  | "check_existing"
  | "check_server_type"
  | "ensure_firewall"
  | "ensure_ssh_key"
  | "create_server"
  | "wait_for_actions"
  | "done";

/** Options for {@link provisionServer}. */
export interface ProvisionOptions extends RequestOptions {
  /** Called as each step starts, e.g. to stream progress to the dashboard. */
  onStep?: (step: ProvisionStep) => void;
  /** Overall limit for the creation actions, in ms. Default 600 000. */
  actionTimeoutMs?: number;
  /** First action poll delay, in ms. Default 1 000. */
  pollIntervalMs?: number;
}

/** Result of {@link provisionServer}. */
export interface ProvisionResult {
  serverId: number;
  name: string;
  status: ServerStatus;
  /** Public IPv4 address, or `null` when disabled. */
  ipv4: string | null;
  /** The server's IPv6 address (`<prefix>::1`), or `null`. */
  ipv6: string | null;
  /** The server's IPv6 /64, e.g. `2001:db8::/64`, or `null`. */
  ipv6Network: string | null;
  location: string;
  serverType: string;
  /** Firewall ID; `null` only when an existing server was reused. */
  firewallId: number | null;
  sshKeyId: number | null;
  /** `false` when a managed server with this name already existed. */
  created: boolean;
}

/**
 * The address Hetzner's images configure on the server: the first host of
 * its /64.
 *
 * @param network - IPv6 network such as `2001:db8::/64`.
 * @returns E.g. `2001:db8::1`.
 */
export function ipv6HostAddress(network: string): string {
  const prefix = network.split("/")[0]!;
  return prefix.endsWith("::") ? `${prefix}1` : prefix;
}

function toResult(
  server: Server,
  extra: { firewallId: number | null; sshKeyId: number | null; created: boolean },
): ProvisionResult {
  const v6 = server.public_net.ipv6?.ip ?? null;
  return {
    serverId: server.id,
    name: server.name,
    status: server.status,
    ipv4: server.public_net.ipv4?.ip ?? null,
    ipv6: v6 ? ipv6HostAddress(v6) : null,
    ipv6Network: v6,
    location: server.location.name,
    serverType: server.server_type.name,
    ...extra,
  };
}

function isAmbiguous(e: unknown): boolean {
  return (
    e instanceof HetznerTimeoutError ||
    e instanceof HetznerNetworkError ||
    (e instanceof HetznerApiError && e.isAmbiguousTransient)
  );
}

/**
 * Creates a server that joins the control plane on first boot. Safe to
 * retry with the same `name`: an existing managed server is returned instead
 * of creating a duplicate (with `created: false`).
 *
 * @param api - Client built with the user's Hetzner token.
 * @param input - What to create.
 * @param options - Progress callback, timeouts, and signal.
 * @returns The server's ID, addresses, and status.
 * @throws ProvisionError for refused or failed steps (see `reason`), and
 *   HetznerApiError for API errors before the server exists.
 * @example
 * const result = await provisionServer(new HetznerClient({ token }), {
 *   name: "web-1",
 *   serverType: "cpx22",
 *   location: "fsn1",
 *   controlPlaneUrl: "https://cp.example.com",
 *   joinToken,
 * });
 */
export async function provisionServer(
  api: HetznerClient,
  input: ProvisionInput,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const step = (s: ProvisionStep) => options.onStep?.(s);
  const req: RequestOptions = { signal: options.signal, timeoutMs: options.timeoutMs };

  const name = validateNodeName(input.name);
  const image = input.image ?? DEFAULT_IMAGE;
  if (!(SUPPORTED_IMAGES as readonly string[]).includes(image)) {
    throw new ProvisionError("invalid_input", `image ${image} is not supported`);
  }
  const labels: Record<string, string> = {};
  try {
    Object.assign(labels, validateExtraLabels(input.labels ?? {}));
  } catch (e) {
    throw new ProvisionError("invalid_input", errorMessage(e), { cause: e });
  }
  if (input.workspaceId !== undefined) {
    if (!isValidLabelValue(input.workspaceId)) {
      throw new ProvisionError("invalid_input", "workspace ID is not a valid label value");
    }
    labels[LABEL_WORKSPACE] = input.workspaceId;
  }
  labels[LABEL_MANAGED] = "true";
  labels[LABEL_NODE] = name;
  labels[LABEL_ROLE] = input.builder ? "builder" : "node";
  if (input.sshPublicKey !== undefined) normalizeSshPublicKey(input.sshPublicKey);
  const userData = buildUserData({
    controlPlaneUrl: input.controlPlaneUrl,
    joinToken: input.joinToken,
    name,
    builder: input.builder,
    allowLoopbackHttp: input.allowLoopbackHttp,
  });

  step("validate_token");
  const token = await api.validateToken(req);
  if (!token.valid) throw new ProvisionError("token_invalid", "Hetzner rejected the API token");
  if (!token.canWrite) {
    throw new ProvisionError(
      "token_read_only",
      "the Hetzner API token is read-only; create a Read & Write token",
    );
  }

  step("check_existing");
  const reuse = await findReusable(api, name, req);
  if (reuse) return toResult(reuse, { firewallId: null, sshKeyId: null, created: false });

  step("check_server_type");
  const [type] = await api.listServerTypes({ name: input.serverType }, req);
  const at = type?.locations.find((l) => l.name === input.location);
  const gone = at?.deprecation && Date.parse(at.deprecation.unavailable_after) <= Date.now();
  if (!type || !at?.available || gone) {
    throw new ProvisionError(
      "server_type_unavailable",
      `server type ${input.serverType} cannot be ordered in ${input.location} right now`,
    );
  }
  const [img] = await api.listImages(
    { type: "system", status: "available", name: image, architecture: type.architecture },
    req,
  );
  if (!img) {
    throw new ProvisionError(
      "image_unavailable",
      `image ${image} is not available for ${type.architecture}`,
    );
  }

  step("ensure_firewall");
  const firewall = await ensureFirewall(api, { allowSsh: input.allowSsh }, req);

  let sshKeyId: number | null = null;
  if (input.sshPublicKey) {
    step("ensure_ssh_key");
    sshKeyId = (await ensureSshKey(api, input.sshPublicKey, req)).id;
  }

  step("create_server");
  let server: Server;
  let actions: Action[];
  try {
    const res = await api.createServer(
      {
        name,
        server_type: type.name,
        location: input.location,
        image: String(img.id),
        ssh_keys: sshKeyId === null ? undefined : [sshKeyId],
        firewalls: [{ firewall: firewall.id }],
        user_data: userData,
        labels,
        start_after_create: true,
        public_net: { enable_ipv4: true, enable_ipv6: true },
      },
      req,
    );
    // NOTE: res.root_password is set when no SSH key is given. It is
    // deliberately dropped: never logged, stored, or returned.
    server = res.server;
    actions = [res.action, ...res.next_actions];
  } catch (e) {
    if (e instanceof HetznerApiError && e.code === "uniqueness_error") {
      // Lost a race with a concurrent provision of the same node.
      const raced = await findReusable(api, name, req);
      if (raced) return toResult(raced, { firewallId: firewall.id, sshKeyId, created: false });
      throw e;
    }
    const aborted = options.signal?.aborted === true;
    if (isAmbiguous(e) || aborted) {
      // The create may have been applied even though no answer arrived. The
      // lookup ignores the caller's signal, which may already be aborted.
      const [created] = await api
        .listServers({ labelSelector: nodeSelector(name) })
        .catch(() => [] as Server[]);
      if (created && aborted) throw await cleanUp(api, created.id, e);
      if (created) return toResult(created, { firewallId: firewall.id, sshKeyId, created: true });
    }
    throw e;
  }

  try {
    step("wait_for_actions");
    await api.waitForActions(actions, {
      signal: options.signal,
      timeoutMs: options.actionTimeoutMs,
      pollIntervalMs: options.pollIntervalMs,
    });
    const fresh = await api.getServer(server.id, req);
    step("done");
    return toResult(fresh, { firewallId: firewall.id, sshKeyId, created: true });
  } catch (e) {
    throw await cleanUp(api, server.id, e);
  }
}

/**
 * Finds a managed server for `name`, or throws if the name is unusable.
 */
async function findReusable(
  api: HetznerClient,
  name: string,
  req: RequestOptions,
): Promise<Server | null> {
  const [managed] = await api.listServers({ labelSelector: nodeSelector(name) }, req);
  if (managed) {
    if (managed.status === "deleting") {
      throw new ProvisionError(
        "server_deleting",
        `server ${name} is being deleted; retry shortly`,
        {
          serverId: managed.id,
        },
      );
    }
    return managed;
  }
  const [other] = await api.listServers({ name }, req);
  if (other) {
    throw new ProvisionError(
      "name_taken",
      `a server named ${name} exists but is not managed by Roundhouse`,
      {
        serverId: other.id,
      },
    );
  }
  return null;
}

/**
 * Deletes a server this call created, after a later step failed.
 *
 * The caller's signal is not used: it may be the reason for the failure, and
 * the delete must still go out.
 */
async function cleanUp(
  api: HetznerClient,
  serverId: number,
  cause: unknown,
): Promise<ProvisionError> {
  try {
    await api.deleteServer(serverId);
    return new ProvisionError(
      "failed_cleaned_up",
      `provisioning failed and server ${serverId} was deleted: ${errorMessage(cause)}`,
      { cause, serverId },
    );
  } catch (deleteError) {
    if (deleteError instanceof HetznerApiError && deleteError.isNotFound) {
      return new ProvisionError(
        "failed_cleaned_up",
        `provisioning failed and server ${serverId} is gone: ${errorMessage(cause)}`,
        { cause, serverId },
      );
    }
    return new ProvisionError(
      "failed_cleanup_failed",
      `provisioning failed (${errorMessage(cause)}) and deleting server ${serverId} also failed: ${errorMessage(deleteError)}`,
      { cause, serverId },
    );
  }
}

// -----------------------------------------------------------------------------
// Deprovision
// -----------------------------------------------------------------------------

/** Input to {@link deprovisionServer}. */
export interface DeprovisionInput {
  serverId: number;
  /**
   * When set, the server's `roundhouse.node` label must equal it, which guards
   * against a stale or mistyped ID pointing at a different managed server.
   */
  expectedName?: string;
  /** Wait for the delete action. Default `true`. */
  wait?: boolean;
}

/** Result of {@link deprovisionServer}. */
export interface DeprovisionResult {
  serverId: number;
  /** `false` when the server was already gone. */
  deleted: boolean;
}

/**
 * Deletes a managed server. Refuses servers without the
 * `roundhouse.managed=true` label, so a user's own servers are never touched.
 * Idempotent: an already-deleted server returns `deleted: false`.
 *
 * @param api - Hetzner client.
 * @param input - Server ID and optional expected node name.
 * @param options - Signal, timeout, and action polling.
 * @returns Whether a delete happened.
 * @throws ProvisionError `not_managed` when the labels do not match.
 */
export async function deprovisionServer(
  api: HetznerClient,
  input: DeprovisionInput,
  options: ProvisionOptions = {},
): Promise<DeprovisionResult> {
  const req: RequestOptions = { signal: options.signal, timeoutMs: options.timeoutMs };
  let server: Server;
  try {
    server = await api.getServer(input.serverId, req);
  } catch (e) {
    if (e instanceof HetznerApiError && e.isNotFound)
      return { serverId: input.serverId, deleted: false };
    throw e;
  }
  if (!isManaged(server.labels)) {
    throw new ProvisionError(
      "not_managed",
      `server ${server.id} (${server.name}) is not managed by Roundhouse`,
      {
        serverId: server.id,
      },
    );
  }
  if (input.expectedName !== undefined && server.labels[LABEL_NODE] !== input.expectedName) {
    throw new ProvisionError(
      "not_managed",
      `server ${server.id} belongs to node ${server.labels[LABEL_NODE] ?? "(none)"}, not ${input.expectedName}`,
      { serverId: server.id },
    );
  }
  let action: Action;
  try {
    action = await api.deleteServer(server.id, req);
  } catch (e) {
    if (e instanceof HetznerApiError && e.isNotFound)
      return { serverId: server.id, deleted: false };
    throw e;
  }
  if (input.wait !== false) {
    await api.waitForActions([action], {
      signal: options.signal,
      timeoutMs: options.actionTimeoutMs,
      pollIntervalMs: options.pollIntervalMs,
    });
  }
  return { serverId: server.id, deleted: true };
}

/**
 * Lists servers this package manages, for reconciling against the nodes table.
 *
 * @param api - Hetzner client.
 * @param filter - Optional workspace ID.
 * @param options - Signal and timeout.
 * @returns Managed servers.
 */
export function listManagedServers(
  api: HetznerClient,
  filter: { workspaceId?: string } = {},
  options: RequestOptions = {},
): Promise<Server[]> {
  const selector =
    filter.workspaceId === undefined
      ? `${LABEL_MANAGED}=true`
      : `${LABEL_MANAGED}=true,${LABEL_WORKSPACE}=${filter.workspaceId}`;
  return api.listServers({ labelSelector: selector }, options);
}
