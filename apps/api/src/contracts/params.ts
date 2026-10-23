/**
 * Path params and query fragments shared by contract files.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { CursorField } from "../schemas";

/** `{projectId}` path param. */
export const ProjectParams = z.object({ projectId: z.string() });

/** `{serviceId}` path param. */
export const ServiceParams = z.object({ serviceId: z.string() });

/** `{deploymentId}` path param. */
export const DeploymentParams = z.object({ deploymentId: z.string() });

/** `{buildId}` path param. */
export const BuildParams = z.object({ buildId: z.string() });

/** `{environmentId}` path param. */
export const EnvironmentParams = z.object({ environmentId: z.string() });

/** `{teamId}` path param. */
export const TeamParams = z.object({ teamId: z.string() });

/** Selects the environment a per-environment resource belongs to. */
export const EnvironmentQuery = z.object({ environment_id: z.string() });

/** Log page size; larger than other lists because lines are small. */
const LogLimitField = z.coerce.number().int().min(1).max(1000).default(200);

/** Cursor pagination for log pages; see `LogPageSchema`. */
export const LogQuery = z.object({ cursor: CursorField, limit: LogLimitField });
