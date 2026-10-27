/**
 * Zod schema of `placement.cloudflare` (ADR 0011), kept apart from
 * `../schemas` so the placement schema there only imports it.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import {
  CLOUDFLARE_INSTANCE_TYPE_NAMES,
  type CloudflareInstanceTypeName,
  type CloudflarePlacement,
  MAX_CLOUDFLARE_INSTANCES,
  parseSleepAfter,
  SERVICE_PROVIDERS,
} from "@roundhouse/shared";

/** Most `regions` one service may constrain placement to. */
export const MAX_CLOUDFLARE_REGIONS = 16;

/** Where a service's replicas run. */
export const ServiceProviderSchema = z.enum(SERVICE_PROVIDERS).openapi("ServiceProvider");

/** Per-service Cloudflare Containers settings, used with `provider: "cloudflare"`. */
export const CloudflarePlacementSchema = z
  .object({
    instance_type: z
      .enum(CLOUDFLARE_INSTANCE_TYPE_NAMES as unknown as [CloudflareInstanceTypeName])
      .optional()
      .openapi({ description: "Derived from `resources` when omitted." }),
    max_instances: z
      .number()
      .int()
      .min(1)
      .max(MAX_CLOUDFLARE_INSTANCES)
      .openapi({ description: "Pool size; replaces `deploy.replicas` on Cloudflare." }),
    sleep_after: z
      .string()
      .max(8)
      .refine((v) => parseSleepAfter(v) !== null, {
        message: "expected a duration from 1m to 24h, such as 90s, 10m or 2h",
      }),
    regions: z
      .array(
        z
          .string()
          .min(2)
          .max(16)
          .regex(/^[A-Za-z0-9-]+$/, "expected a region code"),
      )
      .max(MAX_CLOUDFLARE_REGIONS)
      .optional()
      .openapi({ description: "Placement constraints passed as `constraints.regions`." }),
  })
  .openapi("CloudflarePlacement") satisfies z.ZodType<CloudflarePlacement>;
