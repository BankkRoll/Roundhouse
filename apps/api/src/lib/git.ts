/**
 * Resolves a branch to a commit over git's smart HTTP protocol (the request
 * `git ls-remote` makes), so any https host works, not just GitHub, and
 * public repositories need no credentials or API rate limit.
 *
 * @module
 */

/** Largest ref advertisement read; repositories with more refs than this fit are rejected. */
const MAX_ADVERTISEMENT_BYTES = 8 * 1024 * 1024;

const SHA_RE = /^[a-f0-9]{40}([a-f0-9]{24})?$/;

/**
 * Parses a smart-HTTP ref advertisement (`info/refs?service=git-upload-pack`).
 *
 * @param body - Raw response body.
 * @returns Ref name → object ID.
 * @throws When the body is not a pkt-line stream.
 */
export function parseRefAdvertisement(body: string): Map<string, string> {
  const refs = new Map<string, string>();
  let i = 0;
  while (i + 4 <= body.length) {
    const len = Number.parseInt(body.slice(i, i + 4), 16);
    if (Number.isNaN(len)) throw new Error("malformed pkt-line");
    if (len === 0) {
      i += 4;
      continue;
    }
    if (len < 4 || i + len > body.length) throw new Error("malformed pkt-line");
    const line = body.slice(i + 4, i + len).replace(/\n$/, "");
    i += len;
    if (line.startsWith("#")) continue;
    const [ref] = line.split("\0");
    const space = ref!.indexOf(" ");
    if (space === -1) continue;
    const sha = ref!.slice(0, space);
    const name = ref!.slice(space + 1);
    if (SHA_RE.test(sha)) refs.set(name, sha);
  }
  return refs;
}

/**
 * Finds the commit a branch points to.
 *
 * @param repoUrl - `https://` clone URL.
 * @param branch - Branch name, without `refs/heads/`.
 * @param token - GitHub installation token for private repositories.
 * @returns The full commit SHA, or `null` when the branch doesn't exist.
 * @throws When the server can't be reached or refuses access.
 */
export async function resolveBranch(
  repoUrl: string,
  branch: string,
  token?: string,
): Promise<string | null> {
  const url = `${repoUrl.replace(/\/+$/, "")}/info/refs?service=git-upload-pack`;
  const headers: Record<string, string> = { "user-agent": "roundhouse" };
  if (token) headers.authorization = `Basic ${btoa(`x-access-token:${token}`)}`;
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) {
    throw new Error(`git server answered ${res.status} for ${repoUrl}`);
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_ADVERTISEMENT_BYTES) throw new Error("ref advertisement too large");
  const body = await res.text();
  if (body.length > MAX_ADVERTISEMENT_BYTES) throw new Error("ref advertisement too large");
  return parseRefAdvertisement(body).get(`refs/heads/${branch}`) ?? null;
}
