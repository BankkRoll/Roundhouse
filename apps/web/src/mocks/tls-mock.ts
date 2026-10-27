/**
 * MSW handlers for Settings → Domains & TLS (`apps/api/src/routes/tls.ts`) against the
 * in-memory {@link db}, plus the certificate sync the TLS mode change runs.
 *
 * There is no CA or Cloudflare here: a token containing `invalid` is refused by the
 * "zone", whose name is the apps domain's last two labels, and every certificate the
 * sync wants is issued at once, except for hostnames starting `fail-`, which fail.
 *
 * @module
 */
import { HttpResponse, http } from "msw";
import { PutInstanceDomainsBody, TLS_ROUTES } from "../../../api/src/contracts";
import type { Certificate, InstanceDomainSettings } from "../lib/api/tls-client";
import {
  apiError,
  currentUser,
  invalid,
  recordAudit,
  requireFreshSession,
  unauthorized,
} from "./common";
import { db, nextId } from "./db";

const DAY = 86_400_000;
const LIFETIME_MS = 90 * DAY;

const path = (name: keyof typeof TLS_ROUTES) =>
  `*${TLS_ROUTES[name].path.replace(/\{([^}]+)\}/g, ":$1")}`;

function requireAdmin(): Response | null {
  const user = currentUser();
  if (!user) return unauthorized();
  return user.instance_admin
    ? null
    : apiError(403, "forbidden", "Only instance admins can perform instance:manage");
}

function inZone(name: string, zone: string): boolean {
  return name === zone || name.endsWith(`.${zone}`);
}

/** Whether DNS-01 can issue for the apps domain: a zone is set and holds it. */
function dns01(): boolean {
  const apps = db.deploy.instance.apps_domain;
  const zone = db.deploy.tls.cloudflare_dns;
  return Boolean(apps && zone && inZone(apps, zone.zone_name));
}

/**
 * The settings as `GET /v1/instance/domains` returns them.
 *
 * @returns The settings.
 */
export function domainSettingsView(): InstanceDomainSettings {
  const { instance, tls } = db.deploy;
  const problems = [...tls.managed_problems];
  return {
    tls_mode: instance.tls_mode,
    apps_domain: instance.apps_domain,
    ingress_hostname: tls.ingress_hostname,
    // NOTE: Mock nodes never opt out of ingress, so every server counts.
    ingress_nodes: db.nodes.length,
    acme: { ...tls.acme },
    cloudflare_dns: tls.cloudflare_dns
      ? {
          zone_id: tls.cloudflare_dns.zone_id,
          zone_name: tls.cloudflare_dns.zone_name,
          updated_at: tls.cloudflare_dns.updated_at,
        }
      : null,
    managed: {
      available: problems.length === 0,
      problems,
      apps_wildcard: dns01(),
      wildcard_domains: instance.tls_mode === "managed" && dns01(),
    },
    custom_domains: {
      mode: tls.custom_domains_mode,
      saas: tls.saas ? (({ api_token: _, ...rest }) => rest)(tls.saas) : null,
      quota: {
        used: db.deploy.domains.filter((d) => d.mode === "cloudflare_saas").length,
        included: 100,
      },
    },
  };
}

/** Whether wildcard custom domains can be added now. */
export function wildcardDomainsAllowed(): boolean {
  return domainSettingsView().managed.wildcard_domains;
}

function issue(
  kind: Certificate["kind"],
  hostnames: string[],
  domainId: string | null,
  now: number,
): Certificate {
  const challenge =
    kind === "apps_wildcard" || hostnames[0]!.startsWith("*.") ? "dns-01" : "http-01";
  const servers = db.nodes.length;
  if (hostnames.some((name) => name.replace(/^\*\./, "").startsWith("fail-"))) {
    return {
      id: nextId("crt"),
      kind,
      hostnames,
      challenge,
      domain_id: domainId,
      status: "failed",
      issuer: null,
      not_before: null,
      not_after: null,
      renew_after: null,
      error: `The CA couldn't validate ${hostnames[0]}: the challenge answer wasn't reachable.`,
      failures: 1,
      next_attempt_at: now + 10 * 60_000,
      nodes: { acked: 0, sent: 0 },
      updated_at: now,
    };
  }
  return {
    id: nextId("crt"),
    kind,
    hostnames,
    challenge,
    domain_id: domainId,
    status: "issued",
    issuer: "Let's Encrypt R11",
    not_before: now,
    not_after: now + LIFETIME_MS,
    renew_after: now + (LIFETIME_MS * 2) / 3,
    error: null,
    failures: 0,
    next_attempt_at: now + (LIFETIME_MS * 2) / 3,
    nodes: { acked: servers, sent: servers },
    updated_at: now,
  };
}

/**
 * Mirrors the API's certificate sync: in `managed` mode, one certificate for the apps
 * wildcard (or each generated hostname without DNS-01) and one per verified custom
 * domain; outside it, none.
 *
 * @param now - Current unix ms.
 */
export function syncCertificates(now = Date.now()): void {
  const tls = db.deploy.tls;
  if (db.deploy.instance.tls_mode !== "managed") {
    tls.certificates = [];
    return;
  }
  const wanted: { kind: Certificate["kind"]; hostnames: string[]; domainId: string | null }[] = [];
  const apps = db.deploy.instance.apps_domain;
  if (apps && dns01()) {
    wanted.push({ kind: "apps_wildcard", hostnames: [`*.${apps}`], domainId: null });
  }
  for (const domain of db.deploy.domains) {
    if (domain.type === "generated" && !dns01()) {
      wanted.push({ kind: "generated", hostnames: [domain.hostname], domainId: domain.id });
    } else if (domain.type === "custom" && domain.verification_status === "verified") {
      wanted.push({ kind: "custom", hostnames: [domain.hostname], domainId: domain.id });
    }
  }
  const key = (kind: string, hostnames: string[]) => `${kind}:${hostnames.join(",")}`;
  const kept = new Map(tls.certificates.map((row) => [key(row.kind, row.hostnames), row]));
  tls.certificates = wanted
    .map(
      (want) =>
        kept.get(key(want.kind, want.hostnames)) ??
        issue(want.kind, want.hostnames, want.domainId, now),
    )
    .sort((a, b) =>
      a.kind === "apps_wildcard"
        ? -1
        : b.kind === "apps_wildcard"
          ? 1
          : a.hostnames[0]!.localeCompare(b.hostnames[0]!),
    );
}

/** Domains & TLS handlers. */
export const tlsHandlers = [
  http.get(path("getInstanceDomains"), () => {
    const denied = requireAdmin();
    return denied ?? HttpResponse.json(domainSettingsView());
  }),

  http.put(path("putInstanceDomains"), async ({ request }) => {
    const parsed = PutInstanceDomainsBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return invalid(
        issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid input",
      );
    }
    const denied = requireAdmin() ?? requireFreshSession();
    if (denied) return denied;
    const body = parsed.data;
    const tls = db.deploy.tls;
    const apps = db.deploy.instance.apps_domain;
    const changed: string[] = [];

    if (body.cloudflare_dns) {
      if (body.cloudflare_dns.api_token.includes("invalid")) {
        return apiError(
          422,
          "cloudflare_dns_invalid",
          "The token can't use that zone: Invalid API Token",
        );
      }
      const zoneName = apps ? apps.split(".").slice(-2).join(".") : "example.com";
      tls.cloudflare_dns = {
        zone_id: body.cloudflare_dns.zone_id,
        zone_name: zoneName,
        api_token: body.cloudflare_dns.api_token,
        updated_at: Date.now(),
      };
      changed.push("cloudflare_dns");
    } else if (body.cloudflare_dns === null && tls.cloudflare_dns) {
      tls.cloudflare_dns = null;
      changed.push("cloudflare_dns");
    }
    if (body.ingress_hostname !== undefined && body.ingress_hostname !== tls.ingress_hostname) {
      tls.ingress_hostname = body.ingress_hostname;
      changed.push("ingress_hostname");
    }
    if (
      body.acme_directory_url !== undefined &&
      body.acme_directory_url !== tls.acme.directory_url
    ) {
      tls.acme = { ...tls.acme, directory_url: body.acme_directory_url, account_url: null };
      changed.push("acme_directory_url");
    }
    if (body.acme_email !== undefined && body.acme_email !== tls.acme.email) {
      tls.acme = { ...tls.acme, email: body.acme_email };
      changed.push("acme_email");
    }
    if (changed.length) {
      recordAudit({
        workspaceId: null,
        actorType: "user",
        actorId: currentUser()!.id,
        action: "instance.settings_updated",
        targetType: "instance",
        targetId: "instance",
        metadata: { changed, cloudflare_zone: tls.cloudflare_dns?.zone_name ?? null },
      });
      syncCertificates();
    }
    return HttpResponse.json(domainSettingsView());
  }),

  http.get(path("listCertificates"), () => {
    const denied = requireAdmin();
    return denied ?? HttpResponse.json({ certificates: db.deploy.tls.certificates });
  }),
];
