/**
 * ADR 0014 account security routes (security status, re-authentication): `AUTH_ROUTES` in `../contracts/auth`.
 *
 * Owned by the api-auth stream; mounted in `index.ts` already, so adding handlers
 * here needs no change there.
 *
 * @module
 */
import { createRouter } from "../context";

/** Handlers for the routes above; empty until the owning stream registers them. */
export const authSecurityRoutes = createRouter();
