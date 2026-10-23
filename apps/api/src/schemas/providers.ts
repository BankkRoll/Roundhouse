/**
 * Cloud provider schemas: workspace integrations (write-only API tokens),
 * priced offers, and one-click provisioning runs. Re-exported from
 * `../schemas`.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { PROVIDER_IDS, type ProviderId } from "@roundhouse/providers";

const Millis = z.number().int().openapi({ description: "Unix time in milliseconds" });

/** A cloud provider ID. */
export const ProviderIdSchema = z
  .enum(PROVIDER_IDS as [ProviderId, ...ProviderId[]])
  .openapi("ProviderId");

/** `{workspaceId}` and `{provider}` path params. */
export const ProviderParams = z.object({ workspaceId: z.string(), provider: ProviderIdSchema });

/**
 * A workspace's connection to one provider. Never carries the token: only a
 * keyed fingerprint and its last four characters, to tell tokens apart.
 */
export const ProviderIntegrationSchema = z
  .object({
    provider: ProviderIdSchema,
    display_name: z.string(),
    connected: z.boolean(),
    /** Account name or email the provider reported for the token, when it shares one. */
    account_label: z.string().nullable(),
    token_fingerprint: z.string().nullable(),
    token_last4: z.string().nullable(),
    last_validated_at: Millis.nullable(),
    updated_at: Millis.nullable(),
  })
  .openapi("ProviderIntegration");

/** Body of `PUT …/integrations/{provider}`. */
export const ConnectProviderSchema = z
  .object({
    token: z
      .string()
      .trim()
      .min(16)
      .max(512)
      .regex(/^[\x21-\x7e]+$/, "must be printable ASCII without spaces")
      .openapi({ description: "Provider API token. Write-only: never returned." }),
  })
  .openapi("ConnectProvider");

/** Query of `DELETE …/integrations/{provider}`. */
export const DisconnectProviderQuery = z.object({
  force: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true")
    .openapi({
      description:
        "Disconnect even though servers created with this token still exist; deleting them later then leaves the cloud servers running.",
    }),
});

/** Roles an offer can be filtered for. */
export const OFFER_ROLES = ["node", "builder"] as const;

/** Query of the offers route. */
export const OffersQuery = z.object({
  role: z.enum(OFFER_ROLES).default("node"),
  region: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .optional(),
});

/** One orderable plan in one region, priced as the provider bills it. */
export const OfferSchema = z
  .object({
    id: z.string(),
    plan: z.string(),
    description: z.string(),
    category: z.string().nullable(),
    region: z.string(),
    region_name: z.string(),
    country: z.string().nullable(),
    vcpus: z.number().int(),
    memory_mib: z.number().int(),
    disk_gb: z.number().int(),
    arch: z.enum(["amd64", "arm64"]),
    dedicated: z.boolean(),
    monthly_cents: z.number().int(),
    currency: z.string(),
    included_traffic_tb: z.number().nullable(),
    deprecated: z.boolean(),
    unavailable_after: z.string().nullable(),
  })
  .openapi("ProviderOffer");

/** Response of the offers route. */
export const OffersSchema = z
  .object({
    provider: ProviderIdSchema,
    role: z.enum(OFFER_ROLES),
    offers: z.array(OfferSchema),
    /** Suggestions in order; the first is the default pick. */
    recommendations: z.array(z.object({ offer_id: z.string(), reason: z.string() })),
    fetched_at: Millis,
  })
  .openapi("ProviderOffers");

const PlanOrRegion = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

/** Body of `POST …/nodes/provision`. */
export const ProvisionNodeSchema = z
  .object({
    provider: ProviderIdSchema,
    plan: PlanOrRegion,
    region: PlanOrRegion,
    name: z
      .string()
      .regex(
        /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
        "must be 1-63 lowercase letters, digits or hyphens, not starting or ending with a hyphen",
      ),
    builder: z.boolean().default(false),
  })
  .openapi("ProvisionNode");

/** States of a provisioning run; see `NodeProvisionStatus` in `@roundhouse/db`. */
export const NODE_PROVISION_STATUSES = [
  "queued",
  "creating",
  "booting",
  "joined",
  "failed",
  "cancelled",
  "cleanup_failed",
] as const;

/**
 * A monthly price from a provider's catalogue, recorded when Roundhouse
 * created the server. An estimate: traffic, backups, taxes and price
 * changes are not included, and the provider's invoice is what counts.
 */
export const CostEstimateSchema = z
  .object({
    /** Price in minor units (cents), gross where the provider adds VAT. */
    monthly_cents: z.number().int(),
    /** ISO 4217 currency, e.g. `EUR`. */
    currency: z.string(),
  })
  .openapi("CostEstimate");

/** One one-click provisioning run. */
export const NodeProvisionSchema = z
  .object({
    id: z.string(),
    provider: ProviderIdSchema,
    name: z.string(),
    plan: z.string(),
    region: z.string(),
    builder: z.boolean(),
    status: z.enum(NODE_PROVISION_STATUSES),
    /** Latest adapter step, e.g. `create_server` or `wait_until_running`. */
    step: z.string().nullable(),
    failure_reason: z.string().nullable(),
    failure_message: z.string().nullable(),
    server_id: z.string().nullable(),
    ipv4: z.string().nullable(),
    ipv6: z.string().nullable(),
    /** Set once the agent joined. */
    node_id: z.string().nullable(),
    /** When an operator asked to cancel; the run ends `cancelled` (or `cleanup_failed`). */
    cancel_requested_at: Millis.nullable(),
    /** The chosen plan's catalogue price, once known. */
    estimated_monthly_cost: CostEstimateSchema.nullable(),
    created_at: Millis,
    updated_at: Millis,
    finished_at: Millis.nullable(),
  })
  .openapi("NodeProvision");

/** `{workspaceId}` and `{provisionId}` path params. */
export const ProvisionParams = z.object({ workspaceId: z.string(), provisionId: z.string() });

/** Query of `DELETE …/nodes/{nodeId}`. */
export const RemoveNodeQuery = z.object({
  keep_server: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true")
    .openapi({
      description:
        "For servers Roundhouse provisioned: remove the node but leave the cloud server running.",
    }),
});
