/**
 * Cloud provider routes: connecting a workspace to a provider with a
 * write-only API token, listing priced offers, and one-click provisioning
 * (ADR 0012 "Hetzner in the API and dashboard", for every adapter in
 * `@roundhouse/providers`).
 *
 * Connecting, disconnecting and provisioning can create or orphan billable
 * servers, so they need a fresh session (`reauth`). Tokens are accepted only
 * from a browser session.
 *
 * @module
 */

import { z } from "@hono/zod-openapi";
import { errors, json, sessionAuth, sessionOnlyAuth, WorkspaceParams } from "../schemas";
import {
  ConnectProviderSchema,
  DisconnectProviderQuery,
  NodeProvisionSchema,
  OffersQuery,
  OffersSchema,
  ProviderIntegrationSchema,
  ProviderParams,
  ProvisionNodeSchema,
  ProvisionParams,
} from "../schemas/providers";
import { defineRoute, session, sessionOnly } from "./policy";

/** Every provider and whether this workspace is connected to it. */
export const listIntegrations = defineRoute(session("nodes:manage"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/integrations",
  tags: ["providers"],
  summary: "List cloud provider integrations",
  security: sessionAuth,
  request: { params: WorkspaceParams },
  responses: {
    200: json(z.object({ integrations: z.array(ProviderIntegrationSchema) })),
    ...errors(401, 403, 404),
  },
});

/** One provider's connection status. Never returns the token. */
export const getIntegration = defineRoute(session("nodes:manage"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/integrations/{provider}",
  tags: ["providers"],
  summary: "Get a cloud provider integration",
  security: sessionAuth,
  request: { params: ProviderParams },
  responses: { 200: json(ProviderIntegrationSchema), ...errors(401, 403, 404) },
});

/**
 * Stores (or replaces) the workspace's token for a provider after checking it
 * with the provider: 400 `provider_token_invalid` when rejected, 409
 * `provider_read_only` when it cannot create servers.
 */
export const connectIntegration = defineRoute(
  sessionOnly("nodes:manage", ["provider.connected"], { reauth: true }),
  {
    method: "put",
    path: "/v1/workspaces/{workspaceId}/integrations/{provider}",
    tags: ["providers"],
    summary: "Connect a cloud provider",
    security: sessionOnlyAuth,
    request: {
      params: ProviderParams,
      body: { required: true, content: { "application/json": { schema: ConnectProviderSchema } } },
    },
    responses: {
      200: json(ProviderIntegrationSchema),
      ...errors(400, 401, 403, 404, 409, 429, 502),
    },
  },
);

/**
 * Deletes the stored token. 409 while servers created with it still exist or
 * are being created, unless `force=true`.
 */
export const disconnectIntegration = defineRoute(
  sessionOnly("nodes:manage", ["provider.disconnected"], { reauth: true }),
  {
    method: "delete",
    path: "/v1/workspaces/{workspaceId}/integrations/{provider}",
    tags: ["providers"],
    summary: "Disconnect a cloud provider",
    security: sessionOnlyAuth,
    request: { params: ProviderParams, query: DisconnectProviderQuery },
    responses: { 204: { description: "Disconnected" }, ...errors(401, 403, 404, 409) },
  },
);

/** Live plans × regions with prices, and the recommended picks. Cached briefly. */
export const listProviderOffers = defineRoute(session("nodes:manage"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/providers/{provider}/offers",
  tags: ["providers"],
  summary: "List a provider's offers",
  security: sessionAuth,
  request: { params: ProviderParams, query: OffersQuery },
  responses: { 200: json(OffersSchema), ...errors(400, 401, 403, 404, 409, 429, 502) },
});

/**
 * Starts provisioning a server that joins this workspace on first boot. The
 * run is tracked as a node provision; poll it until `joined` or `failed`.
 */
export const provisionNode = defineRoute(
  session("nodes:manage", ["node.provision_requested"], { reauth: true }),
  {
    method: "post",
    path: "/v1/workspaces/{workspaceId}/nodes/provision",
    tags: ["providers"],
    summary: "Provision a cloud server",
    security: sessionAuth,
    request: {
      params: WorkspaceParams,
      body: { required: true, content: { "application/json": { schema: ProvisionNodeSchema } } },
    },
    responses: {
      202: json(NodeProvisionSchema, "Started"),
      ...errors(400, 401, 403, 404, 409, 503),
    },
  },
);

/** Recent provisioning runs, newest first: every unfinished one plus the last day's. */
export const listNodeProvisions = defineRoute(session("nodes:read"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/node-provisions",
  tags: ["providers"],
  summary: "List provisioning runs",
  security: sessionAuth,
  request: { params: WorkspaceParams },
  responses: {
    200: json(z.object({ provisions: z.array(NodeProvisionSchema) })),
    ...errors(401, 403, 404),
  },
});

/** One provisioning run. */
export const getNodeProvision = defineRoute(session("nodes:read"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/node-provisions/{provisionId}",
  tags: ["providers"],
  summary: "Get a provisioning run",
  security: sessionAuth,
  request: { params: ProvisionParams },
  responses: { 200: json(NodeProvisionSchema), ...errors(401, 403, 404) },
});

/**
 * Cancels a run that has not finished (`queued`, `creating` or
 * `booting`): stops its workflow, revokes its join token and deletes any
 * server it created. A queued or booting run is `cancelled` (or
 * `cleanup_failed`, when the delete fails) when this returns; a run still
 * creating its server keeps its status, with `cancel_requested_at` set,
 * until the provider call returns and the server can be deleted. Repeating
 * the call returns the run unchanged; a finished run is 409.
 */
export const cancelNodeProvision = defineRoute(
  session("nodes:manage", ["node.provision_cancelled"], { reauth: true }),
  {
    method: "post",
    path: "/v1/workspaces/{workspaceId}/node-provisions/{provisionId}/cancel",
    tags: ["providers"],
    summary: "Cancel a provisioning run",
    security: sessionAuth,
    request: { params: ProvisionParams },
    responses: {
      200: json(NodeProvisionSchema),
      ...errors(401, 403, 404, 409),
    },
  },
);

/** Every cloud provider route, by name. */
export const PROVIDER_ROUTES = {
  listIntegrations,
  getIntegration,
  connectIntegration,
  disconnectIntegration,
  listProviderOffers,
  provisionNode,
  listNodeProvisions,
  getNodeProvision,
  cancelNodeProvision,
} as const;
