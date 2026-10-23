/**
 * Workspace creation: slug allocation and the atomic workspace + owner insert.
 *
 * @module
 */
import { type Db, workspaceMembers, workspaces } from "@roundhouse/db";
import { newId, slugify } from "@roundhouse/shared";
import { like } from "drizzle-orm";
import { isUniqueViolation } from "./errors";

/** Retries after a slug collision before giving up. */
const SLUG_RETRIES = 3;
const SUFFIX_LENGTH = 4;
const SLUG_MAX_LENGTH = 40;

/**
 * Picks a slug for `name` that isn't taken, appending `-2`, `-3`, … as needed.
 *
 * @param db - Database client.
 * @param name - Workspace display name.
 * @returns An unused slug.
 */
export async function uniqueSlug(db: Db, name: string): Promise<string> {
  const base = slugify(name, SLUG_MAX_LENGTH);
  const taken = new Set(
    (
      await db
        .select({ slug: workspaces.slug })
        .from(workspaces)
        .where(like(workspaces.slug, `${base}%`))
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function randomSlug(name: string): string {
  const base = slugify(name, SLUG_MAX_LENGTH - SUFFIX_LENGTH - 1);
  const suffix = [...crypto.getRandomValues(new Uint8Array(SUFFIX_LENGTH))]
    .map((b) => (b % 36).toString(36))
    .join("");
  return `${base}-${suffix}`;
}

/**
 * Creates a workspace and makes `ownerId` its owner, atomically.
 *
 * Concurrent creations with the same name can pick the same slug; the loser
 * retries with a short random suffix instead of failing.
 *
 * @param db - Database client.
 * @param name - Display name.
 * @param ownerId - User who becomes owner.
 * @returns The new workspace row.
 */
export async function createWorkspace(db: Db, name: string, ownerId: string) {
  const id = newId("workspace");
  let slug = await uniqueSlug(db, name);
  for (let attempt = 0; ; attempt++) {
    try {
      const [[workspace]] = await db.batch([
        // ADR 0006 "Rollout": new workspaces stage dashboard edits from the start.
        db.insert(workspaces).values({ id, name, slug, stagedChanges: true }).returning(),
        db
          .insert(workspaceMembers)
          .values({ id: newId("member"), workspaceId: id, userId: ownerId, role: "owner" }),
      ]);
      return workspace!;
    } catch (err) {
      if (attempt >= SLUG_RETRIES || !isUniqueViolation(err, "workspaces.slug")) throw err;
      slug = randomSlug(name);
    }
  }
}
