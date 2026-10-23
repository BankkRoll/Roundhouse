/**
 * ADR 0014 instance administration routes (instance admins, instance audit log, chain verification): `INSTANCE_ROUTES` in `../contracts/instance`.
 *
 * Owned by the api-authz-rbac-github stream; mounted in `index.ts` already, so adding handlers
 * here needs no change there.
 *
 * @module
 */
import { createRouter } from "../context";

/** Handlers for the routes above; empty until the owning stream registers them. */
export const instanceAdminRoutes = createRouter();
