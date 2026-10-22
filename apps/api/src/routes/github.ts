/**
 * The instance's GitHub App: creation (manifest flow), installation, the
 * repository picker, and the webhook receiver.
 *
 * Flow: `POST /v1/github/manifest` returns a manifest and a single-use state
 * stored sealed; GitHub redirects to `GET /v1/github/callback?code&state`,
 * which exchanges the code for the App's credentials, stores them sealed and
 * sends the browser on to install the App. GitHub then redirects back with
 * `installation_id` and our signed install state, binding the installation
 * to the workspace that started it.
 *
 * The webhook verifies `X-Hub-Signature-256` over the raw bytes before
 * parsing anything, records each `X-GitHub-Delivery` once, tracks
 * installations, and deploys production services tracking a pushed branch.
 *
 * @module
 */
import {
  type Db,
  environments,
  githubDeliveries,
  githubInstallations,
  projects,
  serviceConfigs,
  services,
  workspaces,
} from "@openrail/db";
import { type GithubAccountType, newId } from "@openrail/shared";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import {
  type AppContext,
  clientIp,
  createRouter,
  originOf,
  requireMasterKey,
  requireUser,
  requireWorkspace,
} from "../context";
import {
  createGithubManifest,
  getGithubStatus,
  githubCallback,
  githubWebhook,
  listGithubRepositories,
  policyOf,
} from "../contracts";
import { recordAudit } from "../lib/audit";
import {
  constantTimeEqual,
  type Sealed,
  seal,
  signState,
  unseal,
  verifyState,
} from "../lib/crypto";
import { createDeployment } from "../lib/deployments";
import { ApiError, conflict, notFound } from "../lib/errors";
import {
  buildManifest,
  exchangeManifestCode,
  GITHUB_WEB,
  GithubApiError,
  getInstallation,
  githubAppInfo,
  installationToken,
  listInstallationRepositories,
  loadGithubApp,
  MANIFEST_STATE_TTL_MS,
  normalizeRepoUrl,
  storeGithubApp,
  verifyWebhookSignature,
} from "../lib/github";
import { getSetting, putSetting, SettingKey } from "../lib/settings";

/** Purpose of signed install states. */
const INSTALL_STATE = "github-install";

/** How long an install link stays valid. */
const INSTALL_STATE_TTL_MS = 60 * 60 * 1000;

/** Largest webhook body accepted; GitHub caps payloads at 25 MB. */
const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;

/** How long delivery IDs are kept for replay protection. */
const DELIVERY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Dashboard page the setup callback returns to. */
export const GITHUB_SETTINGS_PATH = "/settings/github";

interface StoredManifestState {
  state: Sealed;
  workspace_id: string;
  user_id: string;
  expires_at: number;
}

const manifestStateAad = `setting:${SettingKey.githubManifestState}`;

function settingsRedirect(c: AppContext, params: Record<string, string>) {
  return c.redirect(`${originOf(c)}${GITHUB_SETTINGS_PATH}?${new URLSearchParams(params)}`, 302);
}

async function installUrl(c: AppContext, htmlUrl: string, workspaceId: string, userId: string) {
  const state = await signState(
    requireMasterKey(c),
    INSTALL_STATE,
    { w: workspaceId, u: userId },
    INSTALL_STATE_TTL_MS,
  );
  return `${htmlUrl}/installations/new?state=${encodeURIComponent(state)}`;
}

/**
 * Records an installation, or refreshes its account. A new one is claimed by
 * `workspaceId` (if given); one claimed by another workspace stays theirs.
 *
 * @returns The row and whether it was newly created.
 */
async function upsertInstallation(
  db: Db,
  installationId: number,
  account: { login: string; type: string },
  workspaceId: string | null,
) {
  const accountType: GithubAccountType = account.type === "Organization" ? "Organization" : "User";
  const [created] = await db
    .insert(githubInstallations)
    .values({
      id: newId("githubInstallation"),
      installationId,
      accountLogin: account.login,
      accountType,
      workspaceId,
    })
    .onConflictDoNothing({ target: githubInstallations.installationId })
    .returning();
  if (created) return { row: created, created: true };
  const [row] = await db
    .update(githubInstallations)
    .set({
      accountLogin: account.login,
      accountType,
      updatedAt: new Date(),
      ...(workspaceId
        ? { workspaceId: sql`COALESCE(${githubInstallations.workspaceId}, ${workspaceId})` }
        : {}),
    })
    .where(eq(githubInstallations.installationId, installationId))
    .returning();
  return { row: row!, created: false };
}

/** GitHub App routes. */
export const githubRoutes = createRouter()
  .openapi(getGithubStatus, async (c) => {
    const { workspace_id } = c.req.valid("query");
    const m = await requireWorkspace(c, workspace_id, policyOf(getGithubStatus).action!);
    const db = c.get("db");
    const app = await githubAppInfo(db);
    const rows = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.workspaceId, workspace_id))
      .orderBy(asc(githubInstallations.accountLogin));
    return c.json(
      {
        configured: app !== null,
        app: app
          ? {
              id: app.id,
              slug: app.slug,
              name: app.name,
              html_url: app.htmlUrl,
              install_url: await installUrl(c, app.htmlUrl, workspace_id, m.user.id),
            }
          : null,
        installations: rows.map((r) => ({
          id: r.id,
          installation_id: r.installationId,
          account_login: r.accountLogin,
          account_type: r.accountType,
          workspace_id: r.workspaceId,
          created_at: +r.createdAt,
        })),
      },
      200,
    );
  })
  .openapi(createGithubManifest, async (c) => {
    const body = c.req.valid("json");
    const m = await requireWorkspace(c, body.workspace_id, policyOf(createGithubManifest).action!);
    const masterKey = requireMasterKey(c);
    const db = c.get("db");
    if (await githubAppInfo(db)) throw conflict("A GitHub App already exists for this instance");

    const origin = originOf(c);
    const state = crypto.randomUUID();
    const stored: StoredManifestState = {
      state: await seal(masterKey, state, manifestStateAad),
      workspace_id: body.workspace_id,
      user_id: m.user.id,
      expires_at: Date.now() + MANIFEST_STATE_TTL_MS,
    };
    await putSetting(db, SettingKey.githubManifestState, stored);
    // GitHub App names are global; a short random suffix avoids collisions
    // between installs and stays within the 34-character limit.
    const host = new URL(origin).hostname.split(".")[0]!.slice(0, 16);
    const suffix = [...crypto.getRandomValues(new Uint8Array(3))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const target = body.organization
      ? `${GITHUB_WEB}/organizations/${body.organization}/settings/apps/new`
      : `${GITHUB_WEB}/settings/apps/new`;
    return c.json(
      {
        manifest: buildManifest(origin, `OpenRail ${host} ${suffix}`),
        state,
        post_url: `${target}?state=${encodeURIComponent(state)}`,
      },
      200,
    );
  })
  .openapi(githubCallback, async (c) => {
    const query = c.req.valid("query");
    const user = await requireUser(c);
    const masterKey = requireMasterKey(c);
    const db = c.get("db");

    if (query.code) {
      const stored = await getSetting<StoredManifestState>(db, SettingKey.githubManifestState);
      if (!stored || stored.expires_at < Date.now()) {
        throw new ApiError(400, "invalid_token", "The GitHub setup link expired; start again");
      }
      const expected = await unseal(masterKey, stored.state, manifestStateAad);
      if (!(await constantTimeEqual(query.state, expected))) {
        throw new ApiError(400, "invalid_token", "The GitHub setup state does not match");
      }
      await requireWorkspace(c, stored.workspace_id, "instance:manage");
      // Single use: gone before the exchange, so a replayed callback fails.
      await putSetting(db, SettingKey.githubManifestState, null);
      let app: Awaited<ReturnType<typeof exchangeManifestCode>>;
      try {
        app = await exchangeManifestCode(query.code);
      } catch (err) {
        if (err instanceof GithubApiError) return settingsRedirect(c, { error: "exchange_failed" });
        throw err;
      }
      await storeGithubApp(db, masterKey, app);
      await recordAudit(db, {
        workspaceId: stored.workspace_id,
        actorType: "user",
        actorId: user.id,
        action: "github.app_created",
        targetType: "github_app",
        targetId: String(app.id),
        metadata: { slug: app.slug, owner: app.owner?.login ?? null },
        ip: clientIp(c),
      });
      return c.redirect(await installUrl(c, app.html_url, stored.workspace_id, user.id), 302);
    }

    if (query.installation_id !== undefined) {
      const state = await verifyState(masterKey, INSTALL_STATE, query.state);
      if (!state || typeof state.w !== "string") {
        throw new ApiError(400, "invalid_token", "The GitHub install link expired; start again");
      }
      if (state.u !== user.id) {
        throw new ApiError(403, "forbidden", "This install link was started by another user");
      }
      const workspaceId = state.w;
      await requireWorkspace(c, workspaceId, policyOf(githubCallback).action!);
      if (query.setup_action === "request") return settingsRedirect(c, { status: "requested" });
      const app = await loadGithubApp(db, masterKey);
      if (!app) throw new ApiError(400, "github_not_configured", "No GitHub App is configured");
      let info: Awaited<ReturnType<typeof getInstallation>>;
      try {
        // SECURITY: `installation_id` comes from the browser. Asking GitHub
        // with the App's own JWT proves the installation is of our App.
        info = await getInstallation(app, query.installation_id);
      } catch (err) {
        if (err instanceof GithubApiError) {
          return settingsRedirect(c, { error: "installation_not_found" });
        }
        throw err;
      }
      const { row, created } = await upsertInstallation(
        db,
        info.id,
        info.account ?? { login: "unknown", type: "User" },
        workspaceId,
      );
      if (row.workspaceId !== workspaceId) {
        return settingsRedirect(c, { error: "installation_claimed" });
      }
      await recordAudit(db, {
        workspaceId,
        actorType: "user",
        actorId: user.id,
        action: "github.installation_added",
        targetType: "github_installation",
        targetId: row.id,
        metadata: { installation_id: info.id, account: row.accountLogin, created },
        ip: clientIp(c),
      });
      return settingsRedirect(c, { status: "installed" });
    }
    throw new ApiError(400, "invalid_request", "Expected code or installation_id");
  })
  .openapi(listGithubRepositories, async (c) => {
    const query = c.req.valid("query");
    await requireWorkspace(c, query.workspace_id, policyOf(listGithubRepositories).action!);
    const db = c.get("db");
    const app = await loadGithubApp(db, requireMasterKey(c));
    if (!app) throw new ApiError(400, "github_not_configured", "No GitHub App is configured");
    const installs = await db
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.workspaceId, query.workspace_id),
          ...(query.installation_id ? [eq(githubInstallations.id, query.installation_id)] : []),
        ),
      );
    if (query.installation_id && !installs.length) throw notFound("Installation");
    const repositories = [];
    for (const inst of installs) {
      try {
        const { token } = await installationToken(app, inst.installationId, {
          permissions: { metadata: "read" },
        });
        for (const r of await listInstallationRepositories(token)) {
          repositories.push({
            id: r.id,
            full_name: r.full_name,
            private: r.private,
            default_branch: r.default_branch,
            clone_url: r.clone_url,
            installation_id: inst.id,
          });
        }
      } catch (err) {
        // A suspended or uninstalled installation shouldn't hide the others.
        if (!(err instanceof GithubApiError)) throw err;
        console.warn("listing repositories failed", inst.installationId, err.message);
      }
    }
    repositories.sort((a, b) => a.full_name.localeCompare(b.full_name));
    return c.json({ repositories }, 200);
  })
  .openapi(githubWebhook, async (c) => {
    const headers = c.req.valid("header");
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_WEBHOOK_BYTES) {
      throw new ApiError(413, "payload_too_large", "Webhook payload too large");
    }
    const raw = await c.req.arrayBuffer();
    if (raw.byteLength > MAX_WEBHOOK_BYTES) {
      throw new ApiError(413, "payload_too_large", "Webhook payload too large");
    }
    const db = c.get("db");
    const app = await loadGithubApp(db, requireMasterKey(c));
    if (!app) throw new ApiError(401, "unauthorized", "No GitHub App is configured");
    // SECURITY: Nothing is parsed or looked up from the body before this.
    if (!(await verifyWebhookSignature(app.webhookSecret, raw, headers["x-hub-signature-256"]))) {
      throw new ApiError(401, "invalid_signature", "Webhook signature does not match");
    }
    const [fresh] = await db
      .insert(githubDeliveries)
      .values({ id: headers["x-github-delivery"], event: headers["x-github-event"] })
      .onConflictDoNothing()
      .returning();
    if (!fresh) return c.body(null, 202);
    // Redeliveries happen within days; older IDs only need to outlive them.
    await db
      .delete(githubDeliveries)
      .where(lt(githubDeliveries.createdAt, new Date(Date.now() - DELIVERY_RETENTION_MS)));

    try {
      const payload = JSON.parse(new TextDecoder().decode(raw)) as WebhookPayload;
      await handleEvent(c, headers["x-github-event"], headers["x-github-delivery"], payload);
    } catch (err) {
      // Let GitHub's redelivery retry a delivery we failed to process.
      await db
        .delete(githubDeliveries)
        .where(eq(githubDeliveries.id, headers["x-github-delivery"]));
      if (err instanceof SyntaxError) {
        throw new ApiError(400, "invalid_request", "Webhook body is not JSON");
      }
      throw err;
    }
    return c.body(null, 202);
  });

// -----------------------------------------------------------------------------
// Webhook events
// -----------------------------------------------------------------------------

/** The fields of GitHub webhook payloads this receiver reads. */
interface WebhookPayload {
  action?: string;
  installation?: { id: number; account?: { login: string; type: string } | null };
  ref?: string;
  after?: string;
  deleted?: boolean;
  repository?: { clone_url?: string; html_url?: string; full_name?: string };
  head_commit?: { message?: string; author?: { name?: string } } | null;
}

async function handleEvent(
  c: AppContext,
  event: string,
  delivery: string,
  payload: WebhookPayload,
): Promise<void> {
  const db = c.get("db");
  if (event === "installation" || event === "installation_repositories") {
    const inst = payload.installation;
    if (!inst) return;
    if (event === "installation" && payload.action === "deleted") {
      await db.delete(githubInstallations).where(eq(githubInstallations.installationId, inst.id));
      return;
    }
    if (!inst.account) return;
    const { row, created } = await upsertInstallation(db, inst.id, inst.account, null);
    if (created) {
      await recordAudit(db, {
        workspaceId: row.workspaceId,
        actorType: "system",
        actorId: null,
        action: "github.installation_added",
        targetType: "github_installation",
        targetId: row.id,
        metadata: { installation_id: inst.id, account: inst.account.login, delivery },
      });
    }
    return;
  }
  if (event === "push") await handlePush(c, delivery, payload);
}

const ZERO_SHA = /^0+$/;

async function handlePush(c: AppContext, delivery: string, payload: WebhookPayload) {
  const db = c.get("db");
  const ref = payload.ref ?? "";
  const sha = payload.after ?? "";
  if (payload.deleted || !ref.startsWith("refs/heads/") || ZERO_SHA.test(sha)) return;
  if (!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) return;
  const branch = ref.slice("refs/heads/".length);
  const urls = new Set(
    [payload.repository?.clone_url, payload.repository?.html_url]
      .filter((u): u is string => !!u)
      .map(normalizeRepoUrl),
  );
  if (!urls.size) return;

  const installation = payload.installation
    ? await db.query.githubInstallations.findFirst({
        where: eq(githubInstallations.installationId, payload.installation.id),
      })
    : undefined;

  const latestVersion = sql`(SELECT MAX(c2.version) FROM service_configs c2 WHERE c2.service_id = ${serviceConfigs.serviceId} AND c2.environment_id = ${serviceConfigs.environmentId})`;
  const rows = await db
    .select({
      serviceId: services.id,
      projectId: services.projectId,
      workspaceId: projects.workspaceId,
      environmentId: environments.id,
      source: serviceConfigs.source,
    })
    .from(services)
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .innerJoin(
      environments,
      and(eq(environments.projectId, services.projectId), eq(environments.kind, "production")),
    )
    .innerJoin(
      serviceConfigs,
      and(
        eq(serviceConfigs.serviceId, services.id),
        eq(serviceConfigs.environmentId, environments.id),
      ),
    )
    .where(
      and(
        isNull(services.deletedAt),
        isNull(projects.deletedAt),
        isNull(workspaces.deletedAt),
        eq(serviceConfigs.version, latestVersion),
        sql`json_extract(${serviceConfigs.source}, '$.type') = 'git'`,
        sql`json_extract(${serviceConfigs.source}, '$.branch') = ${branch}`,
      ),
    );

  for (const r of rows) {
    if (r.source.type !== "git" || !urls.has(normalizeRepoUrl(r.source.repo_url))) continue;
    // SECURITY: A push only deploys services that reach the repository
    // through this installation, or public-source services in the workspace
    // that claimed it, never another workspace's.
    const viaInstallation = r.source.github_installation_id;
    if (
      viaInstallation
        ? viaInstallation !== installation?.id
        : r.workspaceId !== installation?.workspaceId
    ) {
      continue;
    }
    const deployment = await createDeployment(
      { db, env: c.env },
      {
        projectId: r.projectId,
        serviceId: r.serviceId,
        environmentId: r.environmentId,
        trigger: "push",
        triggeredBy: null,
        origin: originOf(c),
        commit: {
          sha,
          message: payload.head_commit?.message?.slice(0, 1000) ?? null,
          author: payload.head_commit?.author?.name?.slice(0, 200) ?? null,
        },
      },
    );
    await recordAudit(db, {
      workspaceId: r.workspaceId,
      actorType: "system",
      actorId: null,
      action: "deployment.created",
      targetType: "deployment",
      targetId: deployment.id,
      metadata: {
        service_id: r.serviceId,
        environment_id: r.environmentId,
        trigger: "push",
        commit_sha: sha,
        branch,
        delivery,
      },
      ip: clientIp(c),
    });
  }
}
