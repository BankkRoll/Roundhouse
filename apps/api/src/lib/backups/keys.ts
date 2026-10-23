/**
 * Per-project backup keys (ADR 0004, "Encryption"): an age X25519 keypair
 * created on a project's first backup. The recipient is stored in clear in
 * `project_keys.backup_recipient`; the identity is sealed under the
 * project's DEK in `backup_identity_sealed` with AAD
 * {@link backupIdentityAad}, so it opens under every master key of the
 * keyring (`MASTER_KEYS_PREVIOUS` included) like any other project secret.
 *
 * @module
 */
import { type Db, projectKeys } from "@roundhouse/db";
import { and, eq, isNull } from "drizzle-orm";
import { ageRecipientOf, generateAgeKeyPair } from "../age";
import { type Sealed, sealWith, unsealWith } from "../crypto";
import type { KeyEnv } from "../keyring";
import { projectKey } from "../variables";

/**
 * AAD of a project's sealed backup identity, binding it to the project.
 *
 * @param projectId - Owning project.
 * @returns `backup-identity:<project>`.
 */
export function backupIdentityAad(projectId: string): string {
  return `backup-identity:${projectId}`;
}

/**
 * The project's age recipient, creating the keypair on first use.
 *
 * Concurrent first backups race on a conditional update; whichever keypair
 * lands is the project's, and the loser's is discarded unused.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @param projectId - The project.
 * @returns `age1…`.
 * @throws When the project has no key row.
 */
export async function ensureBackupRecipient(
  db: Db,
  keys: KeyEnv,
  projectId: string,
): Promise<string> {
  const current = await readRecipient(db, projectId);
  if (current) return current;
  const pair = await generateAgeKeyPair();
  const sealed = await sealWith(
    await projectKey(db, keys, projectId),
    pair.identity,
    backupIdentityAad(projectId),
  );
  await db
    .update(projectKeys)
    .set({ backupRecipient: pair.recipient, backupIdentitySealed: sealed, updatedAt: new Date() })
    .where(and(eq(projectKeys.projectId, projectId), isNull(projectKeys.backupRecipient)));
  const stored = await readRecipient(db, projectId);
  if (!stored) throw new Error("project has no key row");
  return stored;
}

async function readRecipient(db: Db, projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ recipient: projectKeys.backupRecipient })
    .from(projectKeys)
    .where(eq(projectKeys.projectId, projectId))
    .limit(1);
  return row?.recipient ?? null;
}

/**
 * Unseals the project's age identity and checks it still matches the
 * stored recipient, so a swapped column can't hand out the wrong key.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @param projectId - The project.
 * @returns `AGE-SECRET-KEY-1…`, or `null` when the project has never been backed up.
 *   Never log it or keep it longer than needed.
 */
export async function loadBackupIdentity(
  db: Db,
  keys: KeyEnv,
  projectId: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      recipient: projectKeys.backupRecipient,
      sealed: projectKeys.backupIdentitySealed,
    })
    .from(projectKeys)
    .where(eq(projectKeys.projectId, projectId))
    .limit(1);
  if (!row?.recipient || !row.sealed) return null;
  const identity = await unsealWith(
    await projectKey(db, keys, projectId),
    row.sealed as Sealed,
    backupIdentityAad(projectId),
  );
  if ((await ageRecipientOf(identity)) !== row.recipient) {
    throw new Error("backup identity does not match the project's recipient");
  }
  return identity;
}
