/**
 * ADR 0014 master key routes (status, rotation): `KEY_ROUTES` in `../contracts/keys`.
 *
 * Owned by the api-secrets-crypto stream; mounted in `index.ts` already, so adding handlers
 * here needs no change there.
 *
 * @module
 */
import { createRouter } from "../context";

/** Handlers for the routes above; empty until the owning stream registers them. */
export const keyRoutes = createRouter();
