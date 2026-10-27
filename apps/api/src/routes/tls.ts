/**
 * Settings → Domains & TLS (ADR 0009): `TLS_ROUTES` in `contracts/tls.ts`.
 *
 * - Reading reports the TLS prerequisites live: whether `managed` may be
 *   selected, whether the apps wildcard and wildcard custom domains are
 *   available, and the ingress server count.
 * - Writing checks a Cloudflare token against its zone before sealing it,
 *   and audits which fields changed, never a token.
 * - Changes that affect certificates (the zone, the CA) start the
 *   certificate sync at once instead of at the next tick.
 * - Cloudflare for SaaS (`lib/domains/saas.ts`): the token is checked on
 *   the SaaS zone, switching modes is gated on the managed TLS mode and a
 *   ready mesh on every ingress server, and setup writes the origin records
 *   and sets the fallback origin at once (the minute tick follows it until
 *   Cloudflare reports it active, and retries a failed setup).
 *
 * @module
 */
import {
  CERTIFICATE_KINDS,
  CERTIFICATE_STATUSES,
  certificateDeployments,
  certificates,
  type Db,
} from "@roundhouse/db";
import type { InstanceAction } from "@roundhouse/shared";
import { SAAS_INCLUDED_HOSTNAMES } from "@roundhouse/shared";
import { asc, count, eq, isNotNull, sql } from "drizzle-orm";
import { clientIp, createRouter, requireInstanceAction } from "../context";
import {
  CERTIFICATE_KIND_VALUES,
  CERTIFICATE_STATUS_VALUES,
  getInstanceDomains,
  listCertificates,
  policyOf,
  putInstanceDomains,
} from "../contracts";
import { recordAudit } from "../lib/audit";
import { CloudflareApiError, inZone, verifyZone } from "../lib/certificates/cloudflare-dns";
import { claimDueCertificates, syncCertificates } from "../lib/certificates/schedule";
import {
  acmeAccountUrl,
  dns01Available,
  getAcmeConfig,
  getCloudflareDnsView,
  managedTlsProblems,
  putAcmeConfig,
  sealCloudflareDns,
} from "../lib/certificates/settings";
import { refreshAllNodes } from "../lib/desired-state";
import { INGRESS_HOSTNAME_SETTING } from "../lib/domains/records";
import {
  getCustomDomainsMode,
  getSaasView,
  loadSaasZone,
  prepareSaas,
  putSaas,
  refreshCloudflareIps,
  type SaasZone,
  type StoredSaas,
  saasHostnameCount,
  saasProblems,
  setFallbackOrigin,
  syncOriginRecords,
} from "../lib/domains/saas";
import { ApiError } from "../lib/errors";
import type { OriginEnv } from "../lib/origin";
import { getIngressSettings, getSetting, putSetting, SettingKey } from "../lib/settings";
import { countIngressNodes } from "./instance";

CERTIFICATE_KIND_VALUES satisfies readonly (typeof CERTIFICATE_KINDS)[number][];
CERTIFICATE_KINDS satisfies readonly (typeof CERTIFICATE_KIND_VALUES)[number][];
CERTIFICATE_STATUS_VALUES satisfies readonly (typeof CERTIFICATE_STATUSES)[number][];
CERTIFICATE_STATUSES satisfies readonly (typeof CERTIFICATE_STATUS_VALUES)[number][];

const ms = (d: Date | null) => (d ? +d : null);

/**
 * The Domains & TLS settings as `GET /v1/instance/domains` returns them.
 *
 * @param db - Database client.
 * @param env - Bindings with `PUBLIC_ORIGIN`.
 * @returns The settings.
 */
export async function readDomainSettings(db: Db, env: OriginEnv) {
  const [ingress, ingressHostname, acme, accountUrl, dns, ingressNodes, mode, saas, used] =
    await Promise.all([
      getIngressSettings(db),
      getSetting<unknown>(db, INGRESS_HOSTNAME_SETTING),
      getAcmeConfig(db),
      acmeAccountUrl(db),
      getCloudflareDnsView(db),
      countIngressNodes(db),
      getCustomDomainsMode(db),
      getSaasView(db),
      saasHostnameCount(db),
    ]);
  const problems = managedTlsProblems(env);
  const dns01 = dns01Available(ingress.appsDomain, dns);
  return {
    tls_mode: ingress.tlsMode,
    apps_domain: ingress.appsDomain,
    ingress_hostname: typeof ingressHostname === "string" ? ingressHostname : null,
    ingress_nodes: ingressNodes,
    acme: { directory_url: acme.directory_url, email: acme.email, account_url: accountUrl },
    cloudflare_dns: dns,
    managed: {
      available: problems.length === 0,
      problems,
      apps_wildcard: dns01,
      wildcard_domains: ingress.tlsMode === "managed" && dns01,
    },
    custom_domains: {
      mode,
      saas,
      quota: { used, included: SAAS_INCLUDED_HOSTNAMES },
    },
  };
}

/** Domains & TLS routes. */
export const tlsRoutes = createRouter()
  .openapi(getInstanceDomains, async (c) => {
    await requireInstanceAction(c, policyOf(getInstanceDomains).action as InstanceAction);
    return c.json(await readDomainSettings(c.get("db"), c.env), 200);
  })
  .openapi(putInstanceDomains, async (c) => {
    const user = await requireInstanceAction(
      c,
      policyOf(putInstanceDomains).action as InstanceAction,
    );
    const body = c.req.valid("json");
    const db = c.get("db");
    const before = await readDomainSettings(db, c.env);
    const changed: string[] = [];
    const statements = [];

    if (body.ingress_hostname !== undefined && body.ingress_hostname !== before.ingress_hostname) {
      statements.push(putSetting(db, INGRESS_HOSTNAME_SETTING, body.ingress_hostname));
      changed.push("ingress_hostname");
    }
    const acme = {
      directory_url: body.acme_directory_url ?? before.acme.directory_url,
      email: body.acme_email === undefined ? before.acme.email : body.acme_email,
    };
    if (acme.directory_url !== before.acme.directory_url || acme.email !== before.acme.email) {
      statements.push(putAcmeConfig(db, acme));
      if (acme.directory_url !== before.acme.directory_url) changed.push("acme_directory_url");
      if (acme.email !== before.acme.email) changed.push("acme_email");
    }
    if (body.cloudflare_dns === null && before.cloudflare_dns) {
      statements.push(putSetting(db, SettingKey.cloudflareDns, null));
      changed.push("cloudflare_dns");
    } else if (body.cloudflare_dns) {
      let zoneName: string;
      try {
        zoneName = await verifyZone({
          zoneId: body.cloudflare_dns.zone_id,
          apiToken: body.cloudflare_dns.api_token,
        });
      } catch (err) {
        throw new ApiError(
          422,
          "cloudflare_dns_invalid",
          err instanceof CloudflareApiError
            ? `The token can't use that zone: ${err.message}`
            : "The token couldn't be checked against Cloudflare; try again.",
        );
      }
      if (before.apps_domain && !inZone(before.apps_domain, zoneName)) {
        throw new ApiError(
          422,
          "cloudflare_dns_invalid",
          `${before.apps_domain} isn't in the zone ${zoneName}; use the apps domain's zone.`,
        );
      }
      const sealed = await sealCloudflareDns(c.env, {
        zoneId: body.cloudflare_dns.zone_id,
        zoneName,
        apiToken: body.cloudflare_dns.api_token,
      });
      statements.push(putSetting(db, SettingKey.cloudflareDns, sealed));
      changed.push("cloudflare_dns");
    }
    let saas: { stored: StoredSaas; zone: SaasZone } | null = null;
    if (body.saas === null && before.custom_domains.saas) {
      if (await saasHostnameCount(db)) {
        throw new ApiError(
          409,
          "saas_in_use",
          "Custom domains are still served through Cloudflare for SaaS; remove them first.",
        );
      }
      statements.push(putSaas(db, null), putSetting(db, SettingKey.customDomainsMode, null));
      changed.push("saas");
    } else if (body.saas) {
      saas = await prepareSaas(db, c.env, body.saas);
      statements.push(putSaas(db, saas.stored));
      changed.push("saas");
    }
    const mode =
      body.saas === null ? "direct" : (body.custom_domains_mode ?? before.custom_domains.mode);
    if (mode !== before.custom_domains.mode) {
      changed.push("custom_domains_mode");
      statements.push(putSetting(db, SettingKey.customDomainsMode, mode));
    }
    const zoneChanged = !!saas && saas.stored.zone_id !== before.custom_domains.saas?.zone_id;
    const setUp =
      mode === "cloudflare_saas" && (before.custom_domains.mode !== mode || zoneChanged);
    const firewall = saas?.stored.ingress_firewall ?? before.custom_domains.saas?.ingress_firewall;
    if (mode === "cloudflare_saas") {
      if (!saas && !before.custom_domains.saas) {
        throw new ApiError(400, "invalid_request", "saas is required for cloudflare_saas");
      }
      if (setUp) {
        const problem = await saasProblems(db, before.tls_mode);
        if (problem) throw problem;
      }
      if (
        firewall === "cloudflare_only" &&
        before.custom_domains.saas?.ingress_firewall !== firewall
      ) {
        try {
          await refreshCloudflareIps(db);
        } catch (err) {
          throw new ApiError(
            422,
            "cloudflare_saas_invalid",
            `Cloudflare's IP ranges couldn't be fetched for the origin firewall: ${
              err instanceof CloudflareApiError ? err.message : "request failed"
            }`,
          );
        }
      }
    }
    if (statements.length) {
      await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
    }
    if (setUp) {
      const live = saas?.zone ?? (await loadSaasZone(db, c.env));
      if (live) {
        try {
          await syncOriginRecords(db, live, { force: true });
          await setFallbackOrigin(db, live);
        } catch (err) {
          // Stored as the fallback origin's errors; the minute tick retries.
          console.warn("saas setup", err instanceof Error ? err.message : "error");
        }
      }
    }
    if (
      changed.includes("custom_domains_mode") ||
      (changed.includes("saas") && firewall !== before.custom_domains.saas?.ingress_firewall)
    ) {
      // The origin firewall rides in every node's desired state.
      await refreshAllNodes(c.env, db);
    }
    const after = await readDomainSettings(db, c.env);
    if (changed.length) {
      await recordAudit(db, {
        workspaceId: null,
        actorType: "user",
        actorId: user.id,
        action: "instance.settings_updated",
        targetType: "instance",
        metadata: {
          changed,
          before: {
            ingress_hostname: before.ingress_hostname,
            acme: { directory_url: before.acme.directory_url, email: before.acme.email },
            cloudflare_zone: before.cloudflare_dns?.zone_name ?? null,
            custom_domains_mode: before.custom_domains.mode,
            saas_zone: before.custom_domains.saas?.zone_name ?? null,
            ingress_firewall: before.custom_domains.saas?.ingress_firewall ?? null,
          },
          after: {
            ingress_hostname: after.ingress_hostname,
            acme: { directory_url: after.acme.directory_url, email: after.acme.email },
            cloudflare_zone: after.cloudflare_dns?.zone_name ?? null,
            custom_domains_mode: after.custom_domains.mode,
            saas_zone: after.custom_domains.saas?.zone_name ?? null,
            ingress_firewall: after.custom_domains.saas?.ingress_firewall ?? null,
          },
        },
        ip: clientIp(c),
      });
      if (
        after.tls_mode === "managed" &&
        changed.some((k) => !["ingress_hostname", "saas", "custom_domains_mode"].includes(k))
      ) {
        await syncCertificates(db);
        await claimDueCertificates(c.env, db);
      }
    }
    return c.json(after, 200);
  })
  .openapi(listCertificates, async (c) => {
    await requireInstanceAction(c, policyOf(listCertificates).action as InstanceAction);
    const db = c.get("db");
    const [rows, deliveries] = await Promise.all([
      db
        .select()
        .from(certificates)
        .orderBy(
          sql`CASE WHEN ${certificates.kind} = 'apps_wildcard' THEN 0 ELSE 1 END`,
          asc(certificates.hostnames),
        ),
      db
        .select({
          id: certificateDeployments.certificateId,
          sent: count(),
          acked: sql<number>`SUM(CASE WHEN ${certificateDeployments.ackedAt} IS NOT NULL AND ${certificateDeployments.sha256} = ${certificates.sha256} THEN 1 ELSE 0 END)`,
        })
        .from(certificateDeployments)
        .innerJoin(certificates, eq(certificates.id, certificateDeployments.certificateId))
        .where(isNotNull(certificates.sha256))
        .groupBy(certificateDeployments.certificateId),
    ]);
    const byId = new Map(deliveries.map((d) => [d.id, d]));
    return c.json(
      {
        certificates: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          hostnames: r.hostnames,
          challenge: r.challenge,
          domain_id: r.domainId,
          status: r.status,
          issuer: r.issuer,
          not_before: ms(r.notBefore),
          not_after: ms(r.notAfter),
          renew_after: ms(r.renewAfter),
          error: r.error,
          failures: r.failures,
          next_attempt_at: ms(r.nextAttemptAt),
          nodes: { acked: Number(byId.get(r.id)?.acked ?? 0), sent: byId.get(r.id)?.sent ?? 0 },
          updated_at: +r.updatedAt,
        })),
      },
      200,
    );
  });
