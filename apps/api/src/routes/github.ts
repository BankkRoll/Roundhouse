/**
 * The instance's GitHub App: creation (manifest flow), installation, the
 * repository picker, and the webhook receiver.
 *
 * Flow: `POST /v1/github/manifest` returns a manifest and a single-use state
 * stored sealed; GitHub redirects to `GET /v1/github/callback?code&state`,
 * which exchanges the code for the App's credentials, stores them sealed and
 * sends the browser on to install the App.
 *
 * Claims (ADR 0014 "Claims"): `POST /v1/github/claims` creates a single-use
 * `github_claim_states` row (10 minutes) and returns the App's install URL
 * with a signed state naming it. GitHub redirects back with
 * `installation_id`, that state and an OAuth code for the installing user.
 * The callback consumes the claim once, and binds the installation to the
 * claim's workspace only when that GitHub user administers the account the
 * App is installed on (the account itself, or an admin of the organization).
 * `DELETE /v1/github/installations/{id}` releases a claim.
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
  githubClaimStates,
  githubDeliveries,
  githubInstallations,
  projects,
  serviceConfigs,
  services,
  workspaces,
} from "@roundhouse/db";
import { type GithubAccountType, newId } from "@roundhouse/shared";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
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
  releaseGithubInstallation,
  startGithubClaim,
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
  exchangeUserCode,
  GITHUB_WEB,
  GithubApiError,
  type GithubInstallationInfo,
  getAuthenticatedUser,
  getInstallation,
  githubAppInfo,
  installationToken,
  listInstallationRepositories,
  loadGithubApp,
  MANIFEST_STATE_TTL_MS,
  normalizeRepoUrl,
  revokeUserToken,
  storeGithubApp,
  userAdministersAccount,
  userCanAccessInstallation,
  verifyWebhookSignature,
} from "../lib/github";
import { getSetting, putSetting, SettingKey } from "../lib/settings";

/** Purpose of signed claim states. */
const CLAIM_STATE = "github-claim";

/** How long a claim (and its install link) stays valid. */
const CLAIM_TTL_MS = 10 * 60 * 1000;

/** Largest webhook body accepted; GitHub caps payloads at 25 MB. */
const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;

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

/**
 * Starts a claim: a single-use row for this workspace and user, and the
 * App's install URL with a signed state naming it.
 */
async function startClaim(c: AppContext, htmlUrl: string, workspaceId: string, userId: string) {
  const id = newId("githubClaim");
  const expiresAt = Date.now() + CLAIM_TTL_MS;
  await c
    .get("db")
    .insert(githubClaimStates)
    .values({ id, workspaceId, userId, expiresAt: new Date(expiresAt) });
  const state = await signState(requireMasterKey(c), CLAIM_STATE, { c: id }, CLAIM_TTL_MS);
  return `${htmlUrl}/installations/new?state=${encodeURIComponent(state)}`;
}

/** Why an installation claim was refused; the dashboard shows each as `?error=`. */
type InstallRejection =
  | "authorization_required"
  | "authorization_failed"
  | "installation_not_accessible"
  | "not_account_admin"
  | "link_used"
  | "link_expired";

async function rejectInstallation(
  c: AppContext,
  input: { workspaceId: string; userId: string; installationId: number; reason: InstallRejection },
) {
  await recordAudit(c.get("db"), {
    workspaceId: input.workspaceId,
    actorType: "user",
    actorId: input.userId,
    action: "github.installation_rejected",
    targetType: "github_installation",
    metadata: { installation_id: input.installationId, reason: input.reason },
    ip: clientIp(c),
  });
  return settingsRedirect(c, { error: input.reason });
}

/**
 * Proves the signed-in GitHub user administers the account `installationId`
 * is on: exchanges the installation redirect's OAuth code, checks that the
 * user can see the installation, then that they are the account or an admin
 * of the organization. The user token is revoked right after.
 */
async function verifyInstallationAdmin(
  app: NonNullable<Awaited<ReturnType<typeof loadGithubApp>>>,
  code: string,
  installationId: number,
): Promise<
  | { ok: true; installation: GithubInstallationInfo }
  | {
      ok: false;
      reason: Exclude<InstallRejection, "authorization_required" | "link_used" | "link_expired">;
    }
  | { ok: false; reason: "installation_not_found" }
> {
  let userToken: string;
  try {
    userToken = await exchangeUserCode(app, code);
  } catch (err) {
    if (err instanceof GithubApiError) return { ok: false, reason: "authorization_failed" };
    throw err;
  }
  try {
    if (!(await userCanAccessInstallation(userToken, installationId))) {
      return { ok: false, reason: "installation_not_accessible" };
    }
    const user = await getAuthenticatedUser(userToken);
    let installation: GithubInstallationInfo;
    try {
      installation = await getInstallation(app, installationId);
    } catch (err) {
      if (err instanceof GithubApiError) return { ok: false, reason: "installation_not_found" };
      throw err;
    }
    if (
      !installation.account ||
      !(await userAdministersAccount(userToken, user, installation.account))
    ) {
      return { ok: false, reason: "not_account_admin" };
    }
    return { ok: true, installation };
  } catch (err) {
    if (err instanceof GithubApiError) return { ok: false, reason: "authorization_failed" };
    throw err;
  } finally {
    await revokeUserToken(app, userToken);
  }
}

const accountTypeOf = (type: string): GithubAccountType =>
  type === "Organization" ? "Organization" : "User";

/**
 * Records an installation GitHub told us about (webhook), unclaimed, or
 * refreshes its account. Never changes who claimed it.
 *
 * @returns The row and whether it was newly created.
 */
async function recordInstallation(
  db: Db,
  installationId: number,
  account: { id?: number; login: string; type: string },
) {
  const values = {
    accountLogin: account.login,
    accountType: accountTypeOf(account.type),
    ...(account.id !== undefined ? { accountId: account.id } : {}),
  };
  const [created] = await db
    .insert(githubInstallations)
    .values({ id: newId("githubInstallation"), installationId, ...values })
    .onConflictDoNothing({ target: githubInstallations.installationId })
    .returning();
  if (created) return { row: created, created: true };
  const [row] = await db
    .update(githubInstallations)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(githubInstallations.installationId, installationId))
    .returning();
  return { row: row!, created: false };
}

/**
 * Claims a verified installation for `workspaceId`: unclaimed, or already
 * this workspace's (which re-verifies a legacy claim). One claimed by
 * another workspace stays theirs until they release it.
 *
 * @returns The claimed row, or `null` when another workspace holds it.
 */
async function claimInstallation(
  db: Db,
  info: GithubInstallationInfo,
  workspaceId: string,
  userId: string,
) {
  const { row, created } = await recordInstallation(
    db,
    info.id,
    info.account ?? { login: "unknown", type: "User" },
  );
  const [claimed] = await db
    .update(githubInstallations)
    .set({ workspaceId, claimedBy: userId, claimedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(githubInstallations.id, row.id),
        or(
          isNull(githubInstallations.workspaceId),
          eq(githubInstallations.workspaceId, workspaceId),
        ),
      ),
    )
    .returning();
  return claimed ? { row: claimed, created } : null;
}

/** GitHub App routes. */
export const githubRoutes = createRouter()
  .openapi(getGithubStatus, async (c) => {
    const { workspace_id } = c.req.valid("query");
    await requireWorkspace(c, workspace_id, policyOf(getGithubStatus).action!);
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
              install_url: `${app.htmlUrl}/installations/new`,
            }
          : null,
        installations: rows.map((r) => ({
          id: r.id,
          installation_id: r.installationId,
          account_login: r.accountLogin,
          account_type: r.accountType,
          workspace_id: r.workspaceId,
          verified: r.claimedBy !== null,
          claimed_at: r.claimedAt ? +r.claimedAt : null,
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
        manifest: buildManifest(origin, `Roundhouse ${host} ${suffix}`),
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

    if (query.installation_id === undefined && query.code) {
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
      await storeGithubApp(db, c.env, app);
      await recordAudit(db, {
        workspaceId: null,
        actorType: "user",
        actorId: user.id,
        action: "github.app_created",
        targetType: "github_app",
        targetId: String(app.id),
        metadata: { slug: app.slug, owner: app.owner?.login ?? null },
        ip: clientIp(c),
      });
      return c.redirect(await startClaim(c, app.html_url, stored.workspace_id, user.id), 302);
    }

    if (query.installation_id !== undefined) {
      const state = await verifyState(masterKey, CLAIM_STATE, query.state);
      const claimId = typeof state?.c === "string" ? state.c : null;
      const [claim] = claimId
        ? await db
            .select()
            .from(githubClaimStates)
            .where(eq(githubClaimStates.id, claimId))
            .limit(1)
        : [];
      if (!claim) {
        throw new ApiError(400, "invalid_token", "The GitHub install link expired; start again");
      }
      if (claim.userId !== user.id) {
        throw new ApiError(403, "forbidden", "This install link was started by another user");
      }
      const workspaceId = claim.workspaceId;
      const installationId = query.installation_id;
      await requireWorkspace(c, workspaceId, policyOf(githubCallback).action!);
      if (query.setup_action === "request") return settingsRedirect(c, { status: "requested" });
      const app = await loadGithubApp(db, c.env);
      if (!app) throw new ApiError(400, "github_not_configured", "No GitHub App is configured");
      const reject = (reason: InstallRejection) =>
        rejectInstallation(c, { workspaceId, userId: user.id, installationId, reason });
      // SECURITY: The state is a bearer link until it expires; redeeming the
      // claim once stops a captured callback URL from being replayed.
      const now = new Date();
      const [consumed] = await db
        .update(githubClaimStates)
        .set({ consumedAt: now, updatedAt: now })
        .where(
          and(
            eq(githubClaimStates.id, claim.id),
            isNull(githubClaimStates.consumedAt),
            gt(githubClaimStates.expiresAt, now),
          ),
        )
        .returning({ id: githubClaimStates.id });
      if (!consumed) return reject(claim.consumedAt ? "link_used" : "link_expired");
      // SECURITY: `installation_id` comes from the browser, so on its own it
      // would let anyone claim any installation of our App (and deploy its
      // private repositories). The OAuth code proves which GitHub user came
      // back, and GitHub tells us whether they administer its account.
      if (!query.code) return reject("authorization_required");
      const verified = await verifyInstallationAdmin(app, query.code, installationId);
      if (!verified.ok) {
        if (verified.reason === "installation_not_found") {
          return settingsRedirect(c, { error: "installation_not_found" });
        }
        return reject(verified.reason);
      }
      const claimed = await claimInstallation(db, verified.installation, workspaceId, user.id);
      if (!claimed) return settingsRedirect(c, { error: "installation_claimed" });
      await recordAudit(db, {
        workspaceId,
        actorType: "user",
        actorId: user.id,
        action: "github.installation_added",
        targetType: "github_installation",
        targetId: claimed.row.id,
        metadata: {
          installation_id: verified.installation.id,
          account: claimed.row.accountLogin,
          account_id: claimed.row.accountId,
          created: claimed.created,
          verified: true,
        },
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
    requireMasterKey(c);
    const app = await loadGithubApp(db, c.env);
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
  .openapi(startGithubClaim, async (c) => {
    const { workspace_id } = c.req.valid("json");
    const m = await requireWorkspace(c, workspace_id, policyOf(startGithubClaim).action!);
    const app = await githubAppInfo(c.get("db"));
    if (!app) throw conflict("No GitHub App is configured for this instance");
    return c.json({ install_url: await startClaim(c, app.htmlUrl, workspace_id, m.user.id) }, 200);
  })
  .openapi(releaseGithubInstallation, async (c) => {
    const { installationId } = c.req.valid("param");
    const { workspace_id } = c.req.valid("query");
    const m = await requireWorkspace(c, workspace_id, policyOf(releaseGithubInstallation).action!);
    const db = c.get("db");
    const [released] = await db
      .update(githubInstallations)
      .set({ workspaceId: null, claimedBy: null, claimedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(githubInstallations.id, installationId),
          eq(githubInstallations.workspaceId, workspace_id),
        ),
      )
      .returning();
    if (!released) throw notFound("Installation");
    await recordAudit(db, {
      workspaceId: workspace_id,
      ...m.actor,
      action: "github.installation_released",
      targetType: "github_installation",
      targetId: released.id,
      metadata: { installation_id: released.installationId, account: released.accountLogin },
      ip: clientIp(c),
    });
    return c.body(null, 204);
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
    requireMasterKey(c);
    const app = await loadGithubApp(db, c.env);
    if (!app) throw new ApiError(401, "unauthorized", "No GitHub App is configured");
    // SECURITY: Nothing is parsed or looked up from the body before this.
    if (!(await verifyWebhookSignature(app.webhookSecret, raw, headers["x-hub-signature-256"]))) {
      throw new ApiError(401, "invalid_signature", "Webhook signature does not match");
    }
    // SECURITY: `X-GitHub-Delivery` isn't covered by the signature, so a
    // captured body could be replayed under a fresh ID; the unique body hash
    // stops that.
    const bodyHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const [fresh] = await db
      .insert(githubDeliveries)
      .values({ id: headers["x-github-delivery"], event: headers["x-github-event"], bodyHash })
      .onConflictDoNothing()
      .returning();
    if (!fresh) return c.body(null, 202);

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
  installation?: { id: number; account?: { id?: number; login: string; type: string } | null };
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
    const { row, created } = await recordInstallation(db, inst.id, inst.account);
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
      r.workspaceId !== installation?.workspaceId ||
      (viaInstallation && viaInstallation !== installation.id)
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
