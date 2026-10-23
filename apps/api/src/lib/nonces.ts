/**
 * Single-use values, such as the nonce inside a signed GitHub install state.
 * Signed states are otherwise replayable until they expire.
 *
 * @module
 */
import { consumedNonces, type Db } from "@roundhouse/db";

/**
 * Redeems a single-use value. The first redemption wins, atomically; the row
 * is kept until `expiresAt` (after which the value is refused anyway) and
 * pruned by the retention job.
 *
 * @param db - Database client.
 * @param purpose - Namespace, e.g. `github-install`.
 * @param nonce - The value being redeemed.
 * @param expiresAt - When the value stops being valid on its own, unix ms.
 * @returns `true` the first time, `false` for a replay.
 */
export async function consumeNonce(
  db: Db,
  purpose: string,
  nonce: string,
  expiresAt: number,
): Promise<boolean> {
  const [row] = await db
    .insert(consumedNonces)
    .values({ id: `${purpose}:${nonce}`, expiresAt: new Date(expiresAt) })
    .onConflictDoNothing()
    .returning({ id: consumedNonces.id });
  return row !== undefined;
}
