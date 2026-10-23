/**
 * ADR 0014 access-control routes (teams, project grants, environment protection, workspace access settings, effective access): `ACCESS_ROUTES` in `../contracts/access`.
 *
 * Owned by the api-authz-rbac-github stream; mounted in `index.ts` already, so adding handlers
 * here needs no change there.
 *
 * @module
 */
import { createRouter } from "../context";

/** Handlers for the routes above; empty until the owning stream registers them. */
export const accessRoutes = createRouter();
