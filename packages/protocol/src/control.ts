/**
 * Fields and rules every signed control → agent payload shares, kept apart
 * from ./messages so the per-feature frame modules (./data, ./mesh, ./jobs,
 * ./certs, ./signing-keys) can use them without an import cycle.
 *
 * @module
 */
import { z } from "zod";
import { CREDENTIAL_FRAME_TTL_MS } from "./limits";

/** Fields every signed control payload carries to prevent replay and misrouting. */
export const ControlHeader = {
  /** Unique message ID. */
  id: z.string(),
  /** Target node; agents reject payloads addressed to another node. */
  node_id: z.string(),
  /** Issued-at, unix ms. */
  iat: z.number().int().nonnegative(),
  /**
   * Expiry, unix ms. Agents reject expired payloads. At most
   * {@link CREDENTIAL_FRAME_TTL_MS} after `iat` when the frame carries a
   * credential; see `carriesCredentials`.
   */
  exp: z.number().int().nonnegative(),
};

/**
 * Whether a frame's validity window fits the credential TTL.
 *
 * @param m - Any control payload.
 * @returns `true` when `exp - iat <= CREDENTIAL_FRAME_TTL_MS`.
 */
export function isShortLived(m: { iat: number; exp: number }): boolean {
  return m.exp - m.iat <= CREDENTIAL_FRAME_TTL_MS;
}

/** The zod issue raised when a credential-bearing frame lives too long. */
export const SHORT_LIVED_ISSUE = {
  message: `frames carrying credentials must expire within ${CREDENTIAL_FRAME_TTL_MS} ms`,
  path: ["exp"],
};
