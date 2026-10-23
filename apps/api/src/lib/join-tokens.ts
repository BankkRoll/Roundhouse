/**
 * Single-use node join tokens: minting (only the hash is stored) and
 * revoking an unused one. Shared by the join-token route and one-click
 * provisioning, which puts a fresh token into the server's user data.
 *
 * @module
 */
import { type Db, nodeJoinTokens } from "@roundhouse/db";
import { JOIN_TOKEN_TTL_MS, newId } from "@roundhouse/shared";
import { and, eq, isNull } from "drizzle-orm";
import { hashToken, randomToken } from "./crypto";

/** A freshly minted join token. */
export interface MintedJoinToken {
  /** `njt_…` row ID. */
  id: string;
  /** The plaintext token. Shown once; never stored or logged. */
  token: string;
  expiresAt: Date;
}

/**
 * Mints a single-use join token valid for `JOIN_TOKEN_TTL_MS`.
 *
 * @param db - Database.
 * @param input - Owning workspace and the user who asked for it.
 * @returns The token and its row ID.
 */
export async function mintJoinToken(
  db: Db,
  input: { workspaceId: string; createdBy: string | null },
): Promise<MintedJoinToken> {
  const token = randomToken("njt");
  const id = newId("joinToken");
  const expiresAt = new Date(Date.now() + JOIN_TOKEN_TTL_MS);
  await db.insert(nodeJoinTokens).values({
    id,
    workspaceId: input.workspaceId,
    tokenHash: await hashToken(token),
    createdBy: input.createdBy,
    expiresAt,
  });
  return { id, token, expiresAt };
}

/**
 * Expires a join token unless a node already used it. Idempotent.
 *
 * @param db - Database.
 * @param id - Token row ID.
 * @returns Whether an unused token was revoked.
 */
export async function revokeJoinToken(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(nodeJoinTokens)
    .set({ expiresAt: new Date(0) })
    .where(and(eq(nodeJoinTokens.id, id), isNull(nodeJoinTokens.usedAt)))
    .returning({ id: nodeJoinTokens.id });
  return rows.length > 0;
}
