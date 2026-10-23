/**
 * What a node's `desired_state` says about TLS (ADR 0009, from
 * `CERTS_PROTOCOL_VERSION`): each route's HSTS header, which hostnames the
 * control plane's certificates serve (`ingress.managed_hosts`), the manifest
 * of those certificates, and where Caddy sends HTTP-01 challenges.
 *
 * A hostname is listed as managed only once a certificate covering it is
 * servable; until then the agent keeps Caddy's on-demand issuance for it, so
 * switching to `managed` or adding a domain never leaves a host without
 * HTTPS. Wildcard hostnames are routed only once theirs exists, since
 * on-demand issuance can't produce a wildcard.
 *
 * @module
 */
import type { Db } from "@roundhouse/db";
import {
  type CertificateRef,
  type IngressSettings,
  MAX_CERTIFICATES_PER_NODE,
  MAX_MANAGED_HOSTS,
  type RouteHsts,
} from "@roundhouse/protocol";
import { DEFAULT_HSTS, type DomainHsts, isWildcardHostname, type TlsMode } from "@roundhouse/shared";
import { configuredOrigin, type OriginEnv } from "../origin";
import { type CertificateRow, certificatesForDomains, servable } from "./coverage";

/** Path of the public HTTP-01 responder; Caddy appends the token. */
export const HTTP01_PATH = "/v1/acme/http-01";

/** A verified domain routed on a node. */
export interface RoutedDomain {
  id: string;
  hostname: string;
  type: string;
  hsts: DomainHsts | null;
}

/**
 * The HSTS header a route carries: none outside `acme` and `managed` (no
 * publicly trusted certificate, RFC 6797 §7.2 forbids sending it then), a
 * custom domain's own policy, else the default.
 *
 * @param d - The routed domain.
 * @param tlsMode - The install's TLS mode.
 * @returns The route's `hsts`, or `null` for none.
 */
export function routeHsts(d: RoutedDomain, tlsMode: TlsMode): RouteHsts | null {
  if (tlsMode !== "acme" && tlsMode !== "managed") return null;
  const policy = d.type === "custom" && d.hsts ? d.hsts : DEFAULT_HSTS;
  if (!policy.enabled) return null;
  return {
    max_age: policy.max_age,
    include_subdomains: policy.include_subdomains,
    preload: policy.preload,
  };
}

/** The TLS parts of one node's desired state. */
export interface NodeTls {
  /** Hostnames that may be routed; wildcards only with a servable certificate. */
  routable: Set<string>;
  ingress: IngressSettings;
  certificates: CertificateRef[];
  /** The managed hostnames each manifest entry serves. */
  hostsByCertificate: Map<string, string[]>;
}

/**
 * Computes the TLS parts of a node's desired state.
 *
 * @param db - Database client.
 * @param env - Bindings with `PUBLIC_ORIGIN`, the challenge upstream.
 * @param routed - Verified domains whose services run on the node.
 * @param tlsMode - The install's TLS mode.
 * @returns Routable hostnames, ingress settings and the certificate manifest.
 */
export async function nodeTls(
  db: Db,
  env: OriginEnv,
  routed: readonly RoutedDomain[],
  tlsMode: TlsMode,
): Promise<NodeTls> {
  const managed = tlsMode === "managed";
  const certs = managed ? await certificatesForDomains(db, routed) : new Map<string, CertificateRow>();
  const routable = new Set<string>();
  const managedHosts: string[] = [];
  const manifest = new Map<string, CertificateRef>();
  const hostsByCertificate = new Map<string, string[]>();
  for (const d of routed) {
    const cert = certs.get(d.id);
    const ready = !!cert && servable(cert);
    if (isWildcardHostname(d.hostname) && !ready) continue;
    routable.add(d.hostname);
    if (!ready || managedHosts.length >= MAX_MANAGED_HOSTS) continue;
    if (!manifest.has(cert.id) && manifest.size >= MAX_CERTIFICATES_PER_NODE) continue;
    managedHosts.push(d.hostname);
    manifest.set(cert.id, { id: cert.id, sha256: cert.sha256!, not_after: +cert.notAfter! });
    hostsByCertificate.set(cert.id, [...(hostsByCertificate.get(cert.id) ?? []), d.hostname]);
  }
  const origin = configuredOrigin(env);
  const upstream =
    managed && origin?.startsWith("https://")
      ? { url: `${origin}${HTTP01_PATH}`, host: new URL(origin).hostname }
      : null;
  return {
    routable,
    ingress: {
      acme_challenge_upstream: upstream,
      allowed_sources: null,
      managed_hosts: [...new Set(managedHosts)].sort(),
    },
    certificates: [...manifest.values()].sort((a, b) => a.id.localeCompare(b.id)),
    hostsByCertificate,
  };
}
