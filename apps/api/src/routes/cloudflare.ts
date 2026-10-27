/**
 * The Cloudflare Containers provider routes (ADR 0011), contracts in
 * `contracts/cloudflare.ts`:
 * - Settings → Cloudflare: read, connect (token checked against the
 *   account, then sealed), disconnect (refused while a runtime serves),
 *   verify;
 * - a service's provider status in one environment.
 *
 * SECURITY: the token is write-only. Audit entries name the account and
 * what changed, never the token; check failures carry Cloudflare's
 * messages, which never contain it (the client scrubs it regardless).
 *
 * @module
 */
import { cfDeployments, cfRuntimes, type Db } from "@roundhouse/db";
import { type InstanceAction, serviceProvider } from "@roundhouse/shared";
import { and, desc, eq } from "drizzle-orm";
import { clientIp, createRouter, requireInstanceAction, requireKeys } from "../context";
import {
  type CloudflareSettings,
  deleteInstanceCloudflare,
  getInstanceCloudflare,
  getServiceCloudflare,
  policyOf,
  putInstanceCloudflare,
  verifyInstanceCloudflare,
} from "../contracts";
import { recordAudit } from "../lib/audit";
import { CloudflareClient, CloudflareProviderError } from "../lib/cloudflare/client";
import {
  cloudflareFactsFor,
  cloudflareProblems,
  databaseUrlWarnings,
} from "../lib/cloudflare/eligibility";
import { runtimeOf, workersDevUrl } from "../lib/cloudflare/runtime";
import {
  appsZoneFor,
  clientFor,
  cloudflareAccountView,
  loadCloudflareAccount,
  readCloudflareAccount,
  sealCloudflareAccount,
} from "../lib/cloudflare/settings";
import { ApiError, conflict, notFound } from "../lib/errors";
import { latestConfig, specOf } from "../lib/projects";
import { environmentOf, serviceScope } from "../lib/scope";
import { getIngressSettings, putSetting, SettingKey } from "../lib/settings";

/**
 * Settings → Cloudflare as the API returns it.
 *
 * @param db - Database client.
 * @returns The settings; the token never.
 */
export async function readCloudflareSettings(db: Db): Promise<CloudflareSettings> {
  const view = await cloudflareAccountView(db);
  return {
    configured: view !== null,
    account_id: view?.account_id ?? null,
    workers_subdomain: view?.workers_subdomain ?? null,
    apps_domain_proxied: view?.apps_domain_proxied ?? false,
    apps_zone: view?.apps_zone?.name ?? null,
    token_hint: view?.token_hint ?? null,
    validated_at: view?.validated_at ?? null,
    // TODO: no documented API reports registry usage yet (ADR 0011 "Garbage"); verify live.
    image_storage_bytes: null,
  };
}

/** Whether any service-environment runs on Cloudflare now. */
async function anyActiveRuntime(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ script: cfRuntimes.scriptName })
    .from(cfRuntimes)
    .where(eq(cfRuntimes.status, "active"))
    .limit(1);
  return row !== undefined;
}

/** Cloudflare provider routes. */
export const cloudflareRoutes = createRouter()
  .openapi(getInstanceCloudflare, async (c) => {
    await requireInstanceAction(c, policyOf(getInstanceCloudflare).action as InstanceAction);
    return c.json(await readCloudflareSettings(c.get("db")), 200);
  })
  .openapi(putInstanceCloudflare, async (c) => {
    const user = await requireInstanceAction(
      c,
      policyOf(putInstanceCloudflare).action as InstanceAction,
    );
    const body = c.req.valid("json");
    const db = c.get("db");
    const keys = requireKeys(c);
    const before = await readCloudflareAccount(db);
    const client = new CloudflareClient({ accountId: body.account_id, apiToken: body.api_token });
    let workersSubdomain: string;
    let appsZone: Awaited<ReturnType<typeof appsZoneFor>>;
    try {
      // The calls the provider makes, so a token missing a permission is refused now.
      await client.listScripts();
      await client.listApplications();
      workersSubdomain = await client.workersSubdomain();
      appsZone = await appsZoneFor(client, (await getIngressSettings(db)).appsDomain);
      if (appsZone) await client.listRoutes(appsZone.id);
    } catch (err) {
      throw new ApiError(
        422,
        "cloudflare_account_invalid",
        err instanceof CloudflareProviderError
          ? `The token can't be used for Cloudflare Containers: ${err.message}`
          : "The token couldn't be checked against Cloudflare; try again.",
      );
    }
    const appsDomainProxied = body.apps_domain_proxied ?? before?.apps_domain_proxied ?? false;
    const stored = await sealCloudflareAccount(keys, {
      accountId: body.account_id,
      apiToken: body.api_token,
      workersSubdomain,
      appsDomainProxied,
      appsZone,
    });
    await putSetting(db, SettingKey.cloudflareAccount, stored);
    await recordAudit(db, {
      workspaceId: null,
      actorType: "user",
      actorId: user.id,
      action: "instance.settings_updated",
      targetType: "instance",
      metadata: {
        changed: ["cloudflare_account"],
        before: before
          ? {
              account_id: before.account_id,
              apps_domain_proxied: before.apps_domain_proxied,
              token_hint: before.token_hint,
            }
          : null,
        after: {
          account_id: stored.account_id,
          apps_domain_proxied: stored.apps_domain_proxied,
          token_hint: stored.token_hint,
        },
      },
      ip: clientIp(c),
    });
    return c.json(await readCloudflareSettings(db), 200);
  })
  .openapi(deleteInstanceCloudflare, async (c) => {
    const user = await requireInstanceAction(
      c,
      policyOf(deleteInstanceCloudflare).action as InstanceAction,
    );
    const db = c.get("db");
    const before = await readCloudflareAccount(db);
    if (before) {
      if (await anyActiveRuntime(db)) {
        throw conflict(
          "Services still run on Cloudflare; switch them back to nodes before disconnecting the account",
        );
      }
      await putSetting(db, SettingKey.cloudflareAccount, null);
      await recordAudit(db, {
        workspaceId: null,
        actorType: "user",
        actorId: user.id,
        action: "instance.settings_updated",
        targetType: "instance",
        metadata: {
          changed: ["cloudflare_account"],
          before: { account_id: before.account_id, token_hint: before.token_hint },
          after: null,
        },
        ip: clientIp(c),
      });
    }
    return c.json(await readCloudflareSettings(db), 200);
  })
  .openapi(verifyInstanceCloudflare, async (c) => {
    await requireInstanceAction(c, policyOf(verifyInstanceCloudflare).action as InstanceAction);
    const db = c.get("db");
    const account = await loadCloudflareAccount(db, requireKeys(c));
    if (!account) throw conflict("No Cloudflare account is connected");
    const client = clientFor(account);
    const checks: { name: string; ok: boolean; message: string }[] = [];
    const check = async (name: string, run: () => Promise<string>) => {
      try {
        checks.push({ name, ok: true, message: await run() });
      } catch (err) {
        checks.push({
          name,
          ok: false,
          message: err instanceof Error ? err.message : "check failed",
        });
      }
    };
    await check("token", async () => `Token is ${await client.verifyToken()}`);
    await check("workers_scripts", async () => {
      const scripts = await client.listScripts();
      return `Lists ${scripts.length} Workers script(s)`;
    });
    await check("containers", async () => {
      const apps = await client.listApplications();
      return `Lists ${apps.length} container application(s)`;
    });
    await check("workers_subdomain", async () => `${await client.workersSubdomain()}.workers.dev`);
    await check("registry", async () => {
      await client.registryCredentials(["pull"], 1);
      return "Mints registry credentials";
    });
    await check("apps_zone", async () => {
      const zone = await appsZoneFor(client, (await getIngressSettings(db)).appsDomain);
      if (!zone) throw new Error("The apps domain is not in a zone of this account");
      const routes = await client.listRoutes(zone.id);
      return `${zone.name}: lists ${routes.length} Worker route(s)`;
    });
    checks.push({
      name: "apps_domain_proxied",
      ok: account.apps_domain_proxied,
      message: account.apps_domain_proxied
        ? "Marked proxied"
        : "Mark the apps domain proxied once its wildcard record is orange-clouded",
    });
    return c.json({ ok: checks.every((ch) => ch.ok), checks }, 200);
  })
  .openapi(getServiceCloudflare, async (c) => {
    const { serviceId } = c.req.valid("param");
    const query = c.req.valid("query");
    const { service, project } = await serviceScope(
      c,
      serviceId,
      policyOf(getServiceCloudflare).action!,
    );
    const env = await environmentOf(c, project.id, query.environment_id);
    const db = c.get("db");
    const latest = await latestConfig(db, serviceId, env.id);
    if (!latest) throw notFound("Service config");
    const spec = specOf(latest);
    const facts = await cloudflareFactsFor(db, service, env.id, spec);
    const [problems, account, runtime, rows] = await Promise.all([
      cloudflareProblems(db, facts),
      loadCloudflareAccount(db, requireKeys(c)),
      runtimeOf(db, serviceId, env.id),
      db
        .select()
        .from(cfDeployments)
        .where(and(eq(cfDeployments.serviceId, serviceId), eq(cfDeployments.environmentId, env.id)))
        .orderBy(desc(cfDeployments.createdAt))
        .limit(20),
    ]);
    const warnings =
      serviceProvider(spec.placement) === "cloudflare"
        ? await databaseUrlWarnings(db, requireKeys(c), {
            projectId: project.id,
            environmentId: env.id,
            serviceSlug: service.slug,
          })
        : [];
    let instances: { total: number; running: number } | null = null;
    if (runtime?.applicationId && account) {
      try {
        const listed = await clientFor(account).listInstances(runtime.applicationId);
        instances = {
          total: listed.instances.length,
          running: listed.instances.filter(
            (i) => i.state === "running" || i.status?.health === "running",
          ).length,
        };
      } catch {
        instances = null;
      }
    }
    return c.json(
      {
        provider: serviceProvider(spec.placement),
        configured: account !== null,
        eligibility: problems,
        warnings,
        runtime: runtime
          ? {
              script_name: runtime.scriptName,
              status: runtime.status,
              generation: runtime.generation,
              application_id: runtime.applicationId,
              routes: Object.keys(runtime.routeIds).sort(),
              workers_dev_url: account
                ? workersDevUrl(runtime.scriptName, account.workers_subdomain)
                : null,
              instances,
              delete_after: runtime.deleteAfter ? +runtime.deleteAfter : null,
            }
          : null,
        deployments: rows.map((r) => ({
          id: r.id,
          deployment_id: r.deploymentId,
          status: r.status,
          image_ref: r.imageRef,
          image_digest: r.imageDigest,
          instance_type: r.instanceType,
          max_instances: r.maxInstances,
          error: r.error,
          created_at: +r.createdAt,
        })),
      },
      200,
    );
  });
