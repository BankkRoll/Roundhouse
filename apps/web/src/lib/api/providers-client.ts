/**
 * Typed endpoint functions for cloud providers: connecting a workspace with a write-only
 * API token, listing priced offers, and one-click provisioning runs. Every call goes
 * through {@link request}, like `api`.
 *
 * @module
 */
import type { ProviderId } from "@roundhouse/providers";
import { request } from "./client";
import type {
  NodeProvision,
  OfferRole,
  ProviderIntegration,
  ProviderOffers,
  ProvisionNodeBody,
} from "./providers-types";

const seg = encodeURIComponent;

/**
 * Cloud provider endpoints, one per route in `PROVIDER_ROUTES`.
 *
 * @example
 * const { integrations } = await providersApi.listIntegrations("ws_123");
 */
export const providersApi = {
  /**
   * Lists every provider and whether this workspace is connected to it.
   *
   * @param workspaceId - Workspace id.
   * @param signal - Abort signal.
   * @returns One integration per provider.
   */
  listIntegrations: (workspaceId: string, signal?: AbortSignal) =>
    request<{ integrations: ProviderIntegration[] }>(
      "GET",
      `/v1/workspaces/${seg(workspaceId)}/integrations`,
      { signal },
    ),
  /**
   * Stores (or replaces) the workspace's token for a provider after the API checks it.
   * Fails with 400 `provider_token_invalid` or 409 `provider_read_only`.
   *
   * @param workspaceId - Workspace id.
   * @param provider - Provider id.
   * @param token - The provider API token. Sent once, never returned.
   * @returns The integration, without the token.
   */
  connect: (workspaceId: string, provider: ProviderId, token: string) =>
    request<ProviderIntegration>(
      "PUT",
      `/v1/workspaces/${seg(workspaceId)}/integrations/${seg(provider)}`,
      { body: { token } },
    ),
  /**
   * Deletes the stored token. 409 `conflict` while servers created with it still exist,
   * unless `force`.
   *
   * @param workspaceId - Workspace id.
   * @param provider - Provider id.
   * @param force - Disconnect anyway, leaving those servers unmanaged.
   * @returns Resolves on 204.
   */
  disconnect: (workspaceId: string, provider: ProviderId, force = false) =>
    request<void>("DELETE", `/v1/workspaces/${seg(workspaceId)}/integrations/${seg(provider)}`, {
      query: { force: force ? "true" : undefined },
    }),
  /**
   * Lists a provider's offers for a role, with recommendations. 409
   * `provider_not_connected` before a token is stored.
   *
   * @param workspaceId - Workspace id.
   * @param provider - Provider id.
   * @param role - `node` or `builder`; builders get larger floors.
   * @param signal - Abort signal.
   * @returns Offers, recommendations and when they were fetched.
   */
  listOffers: (workspaceId: string, provider: ProviderId, role: OfferRole, signal?: AbortSignal) =>
    request<ProviderOffers>(
      "GET",
      `/v1/workspaces/${seg(workspaceId)}/providers/${seg(provider)}/offers`,
      { query: { role }, signal },
    ),
  /**
   * Starts provisioning a server that joins this workspace on first boot.
   *
   * @param workspaceId - Workspace id.
   * @param body - Provider, plan, region, node name and builder flag.
   * @returns The queued run; poll it with {@link providersApi.getProvision}.
   */
  provision: (workspaceId: string, body: ProvisionNodeBody) =>
    request<NodeProvision>("POST", `/v1/workspaces/${seg(workspaceId)}/nodes/provision`, {
      body,
    }),
  /**
   * Lists recent provisioning runs, newest first.
   *
   * @param workspaceId - Workspace id.
   * @param signal - Abort signal.
   * @returns Every unfinished run plus the last day's.
   */
  listProvisions: (workspaceId: string, signal?: AbortSignal) =>
    request<{ provisions: NodeProvision[] }>(
      "GET",
      `/v1/workspaces/${seg(workspaceId)}/node-provisions`,
      { signal },
    ),
  /**
   * Reads one provisioning run.
   *
   * @param workspaceId - Workspace id.
   * @param provisionId - Run id.
   * @param signal - Abort signal.
   * @returns The run.
   */
  getProvision: (workspaceId: string, provisionId: string, signal?: AbortSignal) =>
    request<NodeProvision>(
      "GET",
      `/v1/workspaces/${seg(workspaceId)}/node-provisions/${seg(provisionId)}`,
      { signal },
    ),
};
