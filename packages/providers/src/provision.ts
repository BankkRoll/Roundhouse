/**
 * Generic provisioning over an adapter's primitives, and the {@link Provider}
 * every adapter exposes.
 *
 * `provisionServer` steps:
 * 1. validate inputs and build the user data (no API calls);
 * 2. validate the token (invalid vs read-only);
 * 3. look for an existing managed server with this node name (idempotency),
 *    and refuse a name an unmanaged server already uses;
 * 4. check the plan is orderable in the region and pick the image for the
 *    plan's architecture;
 * 5. ensure the default firewall, and the SSH key if one was given;
 * 6. create the server with the managed labels, firewall, key, and user data;
 * 7. wait until it runs; on any failure from here on, including the caller
 *    aborting, delete the server.
 *
 * A create whose response is lost (timeout, network error, gateway error, or
 * an abort while in flight) is recovered by looking the server up by its
 * labels, never by creating a second one. Root passwords that providers
 * return or require are never surfaced: results carry only the
 * provider-neutral {@link CloudServer}.
 *
 * Firewalls and SSH keys are shared, reusable, and free, so they are kept
 * when a later step fails.
 *
 * @module
 */
import { DEFAULT_IMAGE, isSupportedImage, ROLE_FLOORS } from "./catalog";
import { buildUserData, byteLength, validateNodeName } from "./cloud-init";
import { errorMessage, isAmbiguous, isNotFound, ProviderApiError, ProvisionError } from "./errors";
import { defaultFirewall } from "./firewall";
import type { RequestOptions } from "./http";
import { isValidLabelValue, managedLabels } from "./naming";
import type {
  CloudServer,
  CreatedServer,
  DeprovisionInput,
  DeprovisionOptions,
  DeprovisionResult,
  Offer,
  OfferQuery,
  Provider,
  ProviderDriver,
  ProviderImage,
  ProvisionInput,
  ProvisionOptions,
  ProvisionResult,
  ProvisionStep,
} from "./provider";
import { normalizeSshPublicKey } from "./ssh-keys";

/**
 * Creates a server that joins the control plane on first boot. Safe to retry
 * with the same `name`: an existing managed server is returned instead of
 * creating a duplicate (with `created: false`).
 *
 * @param driver - Adapter primitives, built with the user's token.
 * @param input - What to create.
 * @param options - Progress callback, timeouts, and signal.
 * @returns The server and the firewall and key it uses.
 * @throws ProvisionError for refused or failed steps (see `reason`), and
 *   ProviderApiError for API errors before the server exists.
 */
export async function provisionServer(
  driver: ProviderDriver,
  input: ProvisionInput,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const step = (s: ProvisionStep) => options.onStep?.(s);
  const req: RequestOptions = { signal: options.signal, timeoutMs: options.timeoutMs };
  const now = driver.clock.now();

  const name = validateNodeName(input.name);
  driver.validateName?.(name);
  const imageName = input.image ?? DEFAULT_IMAGE;
  if (!isSupportedImage(imageName)) {
    throw new ProvisionError("invalid_input", `image ${imageName} is not supported`);
  }
  if (input.workspaceId !== undefined && !isValidLabelValue(input.workspaceId)) {
    throw new ProvisionError("invalid_input", "workspace ID is not a valid label value");
  }
  const role = input.builder ? "builder" : "node";
  const labels = managedLabels({ node: name, role, workspaceId: input.workspaceId ?? null });
  driver.validateLabels?.(labels);
  const sshPublicKey =
    input.sshPublicKey === undefined ? null : normalizeSshPublicKey(input.sshPublicKey);
  const userData = buildUserData({
    controlPlaneUrl: input.controlPlaneUrl,
    joinToken: input.joinToken,
    name,
    builder: input.builder,
    allowLoopbackHttp: input.allowLoopbackHttp,
  });
  if (byteLength(userData) > driver.userDataLimitBytes) {
    throw new ProvisionError(
      "invalid_input",
      `user data exceeds ${driver.displayName}'s ${driver.userDataLimitBytes}-byte limit`,
    );
  }

  step("validate_token");
  const token = await driver.validateToken(req);
  if (!token.valid) {
    throw new ProvisionError("token_invalid", `${driver.displayName} rejected the API token`);
  }
  if (!token.canWrite) {
    const missing = token.missing?.length ? ` (missing: ${token.missing.join(", ")})` : "";
    throw new ProvisionError(
      "token_read_only",
      `the ${driver.displayName} API token cannot create servers${missing}`,
    );
  }

  step("check_existing");
  const reuse = await findReusable(driver, name, req);
  if (reuse) return { server: reuse, created: false, firewallId: null, sshKeyId: null };

  step("check_offer");
  const offer = await driver.getOffer(input.plan, input.region, { ...req, now });
  const floor = ROLE_FLOORS[role];
  if (
    !offer ||
    offer.vcpus < floor.vcpus ||
    offer.memoryMib < floor.memoryMib ||
    offer.diskGb < floor.diskGb
  ) {
    throw new ProvisionError(
      "offer_unavailable",
      `plan ${input.plan} cannot be ordered in ${input.region} for a ${role} right now`,
    );
  }
  const image = await pickImage(driver, imageName, offer, req);

  step("ensure_firewall");
  const firewallId = await driver.ensureFirewall(
    defaultFirewall({ allowSsh: input.allowSsh }),
    req,
  );

  let sshKeyId: string | null = null;
  if (sshPublicKey) {
    step("ensure_ssh_key");
    sshKeyId = await driver.ensureSshKey(sshPublicKey, req);
  }

  step("create_server");
  let created: CreatedServer;
  try {
    created = await driver.createServer(
      {
        name,
        plan: offer.plan,
        region: offer.region,
        imageId: image.id,
        userData,
        labels,
        firewallId,
        sshKeyId,
        sshPublicKey,
      },
      req,
    );
  } catch (e) {
    if (e instanceof ProviderApiError && e.code === "conflict") {
      // Lost a race with a concurrent provision of the same node.
      const raced = await findReusable(driver, name, req);
      if (raced) return { server: raced, created: false, firewallId, sshKeyId };
      throw e;
    }
    const aborted = options.signal?.aborted === true;
    if (isAmbiguous(e) || aborted) {
      // The create may have been applied even though no answer arrived. The
      // lookup ignores the caller's signal, which may already be aborted.
      const [found] = await driver.findManaged({ node: name }, {}).catch(() => []);
      if (found && aborted) throw await cleanUp(driver, found.id, e);
      if (found) {
        try {
          const server = await driver.waitUntilRunning({ server: found }, pollOptions(options));
          step("done");
          return { server, created: true, firewallId, sshKeyId };
        } catch (waitError) {
          throw await cleanUp(driver, found.id, waitError);
        }
      }
    }
    throw e;
  }

  try {
    step("wait_until_running");
    const server = await driver.waitUntilRunning(created, pollOptions(options));
    step("done");
    return { server, created: true, firewallId, sshKeyId };
  } catch (e) {
    throw await cleanUp(driver, created.server.id, e);
  }
}

function pollOptions(options: ProvisionOptions | DeprovisionOptions) {
  return {
    signal: options.signal,
    timeoutMs: options.readyTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
  };
}

async function pickImage(
  driver: ProviderDriver,
  name: string,
  offer: Offer,
  req: RequestOptions,
): Promise<ProviderImage> {
  const images = await driver.listImages({ region: offer.region, arch: offer.arch }, req);
  const image = images.find(
    (i) =>
      i.name === name &&
      i.arch === offer.arch &&
      (i.regions === null || i.regions.includes(offer.region)),
  );
  if (!image) {
    throw new ProvisionError(
      "image_unavailable",
      `image ${name} is not available for ${offer.arch} in ${offer.region}`,
    );
  }
  return image;
}

/**
 * Finds a managed server for `name`, or throws if the name is unusable.
 */
async function findReusable(
  driver: ProviderDriver,
  name: string,
  req: RequestOptions,
): Promise<CloudServer | null> {
  const managed = (await driver.findManaged({ node: name }, req)).filter(
    (s) => s.managed?.node === name,
  );
  const live = managed.find((s) => s.status !== "deleting");
  if (live) return live;
  if (managed[0]) {
    throw new ProvisionError("server_deleting", `server ${name} is being deleted; retry shortly`, {
      serverId: managed[0].id,
    });
  }
  const other = (await driver.findByName(name, req)).find((s) => s.managed?.node !== name);
  if (other) {
    throw new ProvisionError(
      "name_taken",
      `a server named ${name} exists but is not managed by Roundhouse`,
      { serverId: other.id },
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
  driver: ProviderDriver,
  serverId: string,
  cause: unknown,
): Promise<ProvisionError> {
  try {
    await driver.deleteServer(serverId, { wait: false });
    return new ProvisionError(
      "failed_cleaned_up",
      `provisioning failed and server ${serverId} was deleted: ${errorMessage(cause)}`,
      { cause, serverId },
    );
  } catch (deleteError) {
    if (isNotFound(deleteError)) {
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

/**
 * Deletes a managed server. Refuses servers without the
 * `roundhouse.managed=true` marker, and with `expectedName` any whose node
 * label differs, so a user's own servers are never touched. Idempotent: an
 * already-deleted server returns `deleted: false`.
 *
 * @param driver - Adapter primitives.
 * @param input - Server ID and optional expected node name.
 * @param options - Signal, timeout, and polling.
 * @returns Whether a delete happened.
 * @throws ProvisionError `not_managed` when the labels do not match.
 */
export async function deprovisionServer(
  driver: ProviderDriver,
  input: DeprovisionInput,
  options: DeprovisionOptions = {},
): Promise<DeprovisionResult> {
  const req: RequestOptions = { signal: options.signal, timeoutMs: options.timeoutMs };
  const server = await driver.getServer(input.serverId, req);
  if (!server) return { serverId: input.serverId, deleted: false };
  // SECURITY: this check is the only thing between a stale or forged server
  // ID and deleting a user's own machine.
  if (!server.managed) {
    throw new ProvisionError(
      "not_managed",
      `server ${server.id} (${server.name}) is not managed by Roundhouse`,
      { serverId: server.id },
    );
  }
  if (input.expectedName !== undefined && server.managed.node !== input.expectedName) {
    throw new ProvisionError(
      "not_managed",
      `server ${server.id} belongs to node ${server.managed.node}, not ${input.expectedName}`,
      { serverId: server.id },
    );
  }
  try {
    await driver.deleteServer(server.id, { ...pollOptions(options), wait: input.wait !== false });
  } catch (e) {
    if (isNotFound(e)) return { serverId: server.id, deleted: false };
    throw e;
  }
  return { serverId: server.id, deleted: true };
}

// -----------------------------------------------------------------------------
// Provider
// -----------------------------------------------------------------------------

/**
 * Filters a driver's offers for {@link Provider.listOffers}. Pure.
 *
 * @param offers - Every orderable offer.
 * @param query - Role floor, region, and deprecated handling.
 * @returns Matching offers, cheapest first, then by plan and region.
 */
export function filterOffers(offers: Offer[], query: OfferQuery = {}): Offer[] {
  const floor = ROLE_FLOORS[query.role ?? "node"];
  return offers
    .filter(
      (o) =>
        (query.includeDeprecated || !o.deprecated) &&
        (!query.region || o.region === query.region) &&
        o.vcpus >= floor.vcpus &&
        o.memoryMib >= floor.memoryMib &&
        o.diskGb >= floor.diskGb,
    )
    .sort(
      (a, b) =>
        a.price.monthlyCents - b.price.monthlyCents ||
        a.plan.localeCompare(b.plan) ||
        a.region.localeCompare(b.region),
    );
}

/**
 * Wraps adapter primitives in the shared {@link Provider} interface.
 *
 * @param driver - Adapter primitives.
 * @returns The provider.
 * @example
 * const provider = providerFromDriver(new HetznerDriver({ token }));
 */
export function providerFromDriver(driver: ProviderDriver): Provider {
  return {
    id: driver.id,
    displayName: driver.displayName,
    validateToken: (options = {}) => driver.validateToken(options),
    async listOffers(query = {}, options = {}) {
      const now = query.now ?? driver.clock.now();
      return filterOffers(await driver.listOffers({ ...options, now }), query);
    },
    listImages: (filter = {}, options = {}) => driver.listImages(filter, options),
    provision: (input, options) => provisionServer(driver, input, options),
    deprovision: (input, options) => deprovisionServer(driver, input, options),
    getServer: (serverId, options = {}) => driver.getServer(serverId, options),
    async listManaged(filter = {}, options = {}) {
      const servers = await driver.findManaged(filter, options);
      return servers.filter(
        (s) =>
          s.managed !== null &&
          (filter.workspaceId === undefined || s.managed.workspaceId === filter.workspaceId),
      );
    },
  };
}
