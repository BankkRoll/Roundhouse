/**
 * Names of the Cloudflare resources of one service-environment (ADR 0011
 * "Runtime Worker" and "Registry path"): the runtime script (which also
 * names the container application and the image repository) and image
 * references.
 *
 * @module
 */
import { CLOUDFLARE_REGISTRY_HOST } from "./client";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * The runtime script's name: `rh-<base32(sha256(service_id "/" environment_id))[0..20]>`.
 *
 * @param serviceId - `svc_…`.
 * @param environmentId - `env_…`.
 * @returns e.g. `rh-mfrggzdfmztwq2lknnwg`.
 * @example
 * await cloudflareScriptName("svc_1", "env_1"); // "rh-…" (23 characters)
 */
export async function cloudflareScriptName(
  serviceId: string,
  environmentId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${serviceId}/${environmentId}`),
  );
  return `rh-${base32(new Uint8Array(digest)).slice(0, 20)}`;
}

/**
 * Where a git build of a deployment is pushed:
 * `registry.cloudflare.com/<account>/<script>:<deployment id, lowercased>`.
 *
 * @param accountId - Cloudflare account ID.
 * @param scriptName - The runtime script.
 * @param deploymentId - `dep_…`.
 * @returns The tagged reference.
 */
export function cloudflareImageTarget(
  accountId: string,
  scriptName: string,
  deploymentId: string,
): string {
  return `${CLOUDFLARE_REGISTRY_HOST}/${accountId}/${scriptName}:${deploymentId.toLowerCase()}`;
}

/**
 * Whether an image reference names a registry Cloudflare pulls from
 * directly (ADR 0011 "Registry"): Docker Hub (including references without
 * a registry host), Amazon ECR, Google Artifact Registry, or the managed
 * registry itself.
 *
 * @param image - An image reference.
 * @returns `true` when it can be used as-is.
 * @example
 * isDirectlyPullable("nginx:1.27"); // true
 * isDirectlyPullable("ghcr.io/acme/api:1"); // false
 */
export function isDirectlyPullable(image: string): boolean {
  const first = image.split("/")[0]!;
  const hasHost =
    image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  if (!hasHost) return true;
  const host = first.toLowerCase();
  return (
    host === "docker.io" ||
    host === "index.docker.io" ||
    host === "registry-1.docker.io" ||
    host === CLOUDFLARE_REGISTRY_HOST ||
    /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$/.test(host) ||
    /^[a-z0-9-]+-docker\.pkg\.dev$/.test(host)
  );
}
