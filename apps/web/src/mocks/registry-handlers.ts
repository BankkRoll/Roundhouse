/**
 * Mock registry storage routes (`REGISTRY_ROUTES`): instance admins only, fresh
 * session for changes, both secrets write-only. A bucket named `unreachable-…` fails the
 * reachability check.
 *
 * @module
 */
import { HttpResponse, http } from "msw";
import { REGISTRY_ROUTES } from "../../../api/src/contracts";
import type { RegistryStorage, RegistryStorageBody } from "../lib/api/registry-client";
import { apiError, currentUser, unauthorized } from "./common";
import { db } from "./db";

function mswPath(name: keyof typeof REGISTRY_ROUTES): string {
  return `*${REGISTRY_ROUTES[name].path}`;
}

function view(): RegistryStorage {
  const s = db.mesh.registry;
  return {
    type: s ? "s3" : "filesystem",
    endpoint: s?.endpoint ?? null,
    bucket: s?.bucket ?? null,
    region: s?.region ?? null,
    access_key_id: s?.access_key_id ?? null,
    readonly_access_key_id: s?.readonly_access_key_id ?? null,
    secrets_set: !!s,
    updated_at: s?.updated_at ?? null,
  };
}

function guard(change: boolean): Response | null {
  const user = currentUser();
  if (!user) return unauthorized();
  if (!user.instance_admin) {
    return apiError(403, "forbidden", "Only instance admins can perform instance:manage");
  }
  if (change && db.data.knobs.reauthRequired) {
    return apiError(403, "reauth_required", "Confirm your password to continue");
  }
  return null;
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** Every registry storage route. */
export const registryHandlers = [
  http.get(mswPath("getRegistryStorage"), () => guard(false) ?? HttpResponse.json(view())),

  http.put(mswPath("putRegistryStorage"), async ({ request }) => {
    const denied = guard(true);
    if (denied) return denied;
    const body = (await request.json().catch(() => null)) as RegistryStorageBody | null;
    let endpoint: URL | null = null;
    try {
      endpoint = new URL(body?.endpoint ?? "");
    } catch {
      endpoint = null;
    }
    if (
      !body ||
      endpoint?.protocol !== "https:" ||
      (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
      !BUCKET.test(body.bucket ?? "") ||
      !body.access_key_id ||
      !body.readonly_access_key_id
    ) {
      return apiError(400, "invalid_request", "Invalid registry storage");
    }
    const prior = db.mesh.registry;
    const secret = body.secret_access_key ?? prior?.secret_access_key;
    const readonlySecret = body.readonly_secret_access_key ?? prior?.readonly_secret_access_key;
    if (!secret || !readonlySecret) {
      return apiError(400, "invalid_request", "Both secrets are required the first time");
    }
    if (body.bucket.includes("unreachable")) {
      return apiError(
        422,
        "registry_storage_unreachable",
        "The read-write key can't reach the bucket: the bucket could not be reached",
      );
    }
    db.mesh.registry = {
      endpoint: endpoint.origin,
      bucket: body.bucket,
      region: body.region ?? "auto",
      access_key_id: body.access_key_id,
      secret_access_key: secret,
      readonly_access_key_id: body.readonly_access_key_id,
      readonly_secret_access_key: readonlySecret,
      updated_at: Date.now(),
    };
    return HttpResponse.json(view());
  }),

  http.delete(mswPath("deleteRegistryStorage"), () => {
    const denied = guard(true);
    if (denied) return denied;
    db.mesh.registry = null;
    return HttpResponse.json(view());
  }),
];
