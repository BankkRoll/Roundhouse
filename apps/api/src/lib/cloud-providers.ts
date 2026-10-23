/**
 * The API's side of `@roundhouse/providers`: the one place that turns a
 * workspace's stored credential into a {@link Provider}.
 *
 * - Sealing and unsealing provider tokens (through `instance-secrets`, so the
 *   key rotation workflow owns their format with every other KEK secret).
 * - Keyed token fingerprints for display.
 * - Building a provider client, with a transport seam for tests.
 * - Mapping provider errors onto API errors, and offers onto the wire shape.
 *
 * SECURITY: A plaintext token exists only inside one request or one workflow
 * step: it is unsealed, handed to `createProvider`, and dropped. It is never
 * logged, audited, returned, or put in a workflow step result.
 *
 * @module
 */
import { type Db, providerCredentials } from "@roundhouse/db";
import {
  createProvider,
  isAmbiguous,
  type Offer,
  PROVIDERS,
  type Provider,
  ProviderApiError,
  type ProviderId,
  type TransportOptions,
} from "@roundhouse/providers";
import { and, eq } from "drizzle-orm";
import { ApiError } from "./errors";
import {
  type KeyEnv,
  SealedSchema,
  sealInstanceSecret,
  unsealInstanceSecret,
} from "./instance-secrets";
import { providerFingerprintKey, variableFingerprint } from "./keyring";
import { loadFingerprintSecret } from "./settings";

type CredentialRow = typeof providerCredentials.$inferSelect;

/** `instance_settings`-style key the token AAD is namespaced under. */
const SETTING_KEY = "provider_credential";

// -----------------------------------------------------------------------------
// Sealing
// -----------------------------------------------------------------------------

const aadField = (workspaceId: string, provider: ProviderId, rowId: string) =>
  `${workspaceId}:${provider}:${rowId}`;

/**
 * Seals a provider token for one `provider_credentials` row. The AAD binds
 * workspace, provider and row ID, so a ciphertext copied to another row
 * fails to open.
 *
 * @param keys - The keyring bindings.
 * @param token - Plaintext token.
 * @param where - Workspace, provider and row ID the value is stored under.
 * @returns The sealed value.
 */
export function sealProviderToken(
  keys: KeyEnv,
  token: string,
  where: { workspaceId: string; provider: ProviderId; rowId: string },
) {
  return sealInstanceSecret(
    keys,
    token,
    SETTING_KEY,
    aadField(where.workspaceId, where.provider, where.rowId),
  );
}

/**
 * Opens a stored provider token.
 *
 * @param keys - The keyring bindings.
 * @param row - The credential row.
 * @returns The plaintext token.
 * @throws When the ciphertext doesn't match its row or key.
 */
export function unsealProviderToken(keys: KeyEnv, row: CredentialRow): Promise<string> {
  return unsealInstanceSecret(
    keys,
    SealedSchema.parse(row.tokenSealed),
    SETTING_KEY,
    aadField(row.workspaceId, row.provider, row.id),
  );
}

/**
 * A token's display fingerprint: the first 8 hex characters of HMAC-SHA256
 * under the workspace's provider fingerprint key (`providerFingerprintKey`),
 * the same construction as variable fingerprints. The key derives from the
 * instance fingerprint secret, not `MASTER_KEY`, so a stored fingerprint
 * still matches its token after a master key rotation.
 *
 * SECURITY: Keyed so the stored fingerprint is no offline oracle for the
 * token, even for providers whose tokens are short.
 *
 * @param db - Database client, to load (or create) the fingerprint secret.
 * @param keys - The keyring bindings.
 * @param workspaceId - Owning workspace; part of the derivation.
 * @param token - Plaintext token.
 * @returns 8 lowercase hex characters.
 */
export async function providerTokenFingerprint(
  db: Db,
  keys: KeyEnv,
  workspaceId: string,
  token: string,
): Promise<string> {
  const secret = await loadFingerprintSecret(db, keys);
  const key = await providerFingerprintKey(secret, workspaceId);
  secret.fill(0);
  return variableFingerprint(key, token);
}

/**
 * Loads a workspace's credential for a provider.
 *
 * @param db - Database.
 * @param workspaceId - Workspace.
 * @param provider - Provider.
 * @returns The row, or `undefined` when not connected.
 */
export async function loadCredential(
  db: Db,
  workspaceId: string,
  provider: ProviderId,
): Promise<CredentialRow | undefined> {
  const [row] = await db
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.workspaceId, workspaceId),
        eq(providerCredentials.provider, provider),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Loads and unseals a workspace's credential, or refuses with 409.
 *
 * @param db - Database.
 * @param keys - The keyring bindings.
 * @param workspaceId - Workspace.
 * @param provider - Provider.
 * @returns The row and a client for it.
 * @throws {ApiError} 409 `provider_not_connected`.
 */
export async function connectedProvider(
  db: Db,
  keys: KeyEnv,
  workspaceId: string,
  provider: ProviderId,
): Promise<{ row: CredentialRow; client: Provider }> {
  const row = await loadCredential(db, workspaceId, provider);
  if (!row) {
    throw new ApiError(
      409,
      "provider_not_connected",
      `Connect ${PROVIDERS[provider].displayName} to this workspace first`,
    );
  }
  return { row, client: providerClient(provider, await unsealProviderToken(keys, row)) };
}

// -----------------------------------------------------------------------------
// Clients
// -----------------------------------------------------------------------------

let transportOverride: TransportOptions | null = null;

/**
 * Replaces the HTTP transport every provider client uses, e.g. with an
 * in-memory fake API's `fetch`. Pass `null` to restore the real one.
 *
 * SECURITY: Never wired to configuration or a request: adapters must only
 * talk to their fixed API hosts, and `baseUrl` is deliberately not exposed.
 *
 * @param options - Transport options (`fetch`, `sleep`, retries), or `null`.
 */
export function setProviderTransport(options: TransportOptions | null): void {
  transportOverride = options;
}

/**
 * A client for one provider with a plaintext token.
 *
 * @param provider - Provider ID.
 * @param token - Plaintext token; held only by the returned client.
 * @returns The provider.
 */
export function providerClient(provider: ProviderId, token: string): Provider {
  return createProvider(provider, {
    ...(transportOverride ?? {}),
    token,
    userAgent: "roundhouse-control-plane",
  });
}

// -----------------------------------------------------------------------------
// Errors and wire shapes
// -----------------------------------------------------------------------------

/**
 * Maps an error from a provider call made with a stored token onto an API
 * error. Provider messages are kept (they never contain our token).
 *
 * @param provider - Provider called.
 * @param err - What it threw.
 * @returns The error to throw.
 */
export function providerFailure(provider: ProviderId, err: unknown): ApiError {
  const name = PROVIDERS[provider].displayName;
  if (err instanceof ApiError) return err;
  if (err instanceof ProviderApiError) {
    switch (err.code) {
      case "unauthorized":
        return new ApiError(
          409,
          "provider_token_invalid",
          `${name} rejected the stored token; connect it again`,
        );
      case "forbidden":
        return new ApiError(
          409,
          "provider_read_only",
          `${name} refused the request with the stored token: ${err.message}`,
        );
      case "rate_limited":
        return new ApiError(
          429,
          "rate_limited",
          `${name} is rate limiting requests; retry shortly`,
        );
      default:
        return new ApiError(502, "upstream_error", `${name} API error: ${err.message}`);
    }
  }
  if (isAmbiguous(err)) {
    return new ApiError(502, "upstream_error", `${name} did not answer in time; retry shortly`);
  }
  return new ApiError(502, "upstream_error", `${name} request failed`);
}

/**
 * Serialises an offer.
 *
 * @param o - Offer from `listOffers`.
 * @returns The wire shape (`ProviderOffer`).
 */
export function toApiOffer(o: Offer) {
  return {
    id: o.id,
    plan: o.plan,
    description: o.description,
    category: o.category,
    region: o.region,
    region_name: o.regionName,
    country: o.country,
    vcpus: o.vcpus,
    memory_mib: o.memoryMib,
    disk_gb: o.diskGb,
    arch: o.arch,
    dedicated: o.dedicated,
    monthly_cents: o.price.monthlyCents,
    currency: o.price.currency,
    included_traffic_tb: o.includedTrafficTb,
    deprecated: o.deprecated,
    unavailable_after: o.unavailableAfter,
  };
}

/**
 * Serialises a workspace's integration with a provider.
 *
 * @param provider - Provider.
 * @param row - Its credential, or `undefined` when not connected.
 * @returns The wire shape (`ProviderIntegration`); never the token.
 */
export function toApiIntegration(provider: ProviderId, row: CredentialRow | undefined) {
  return {
    provider,
    display_name: PROVIDERS[provider].displayName,
    connected: row !== undefined,
    account_label: row?.accountLabel ?? null,
    token_fingerprint: row?.fingerprint ?? null,
    token_last4: row?.tokenLast4 ?? null,
    last_validated_at: row ? +row.validatedAt : null,
    updated_at: row ? +row.updatedAt : null,
  };
}
