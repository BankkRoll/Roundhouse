/**
 * Pull request previews (ADR 0007, bound by ADR 0014 section 14), end to
 * end through the Worker with a fake GitHub (`fake-github.ts`): signed
 * `pull_request` deliveries create, update and tear down preview
 * environments; fork PRs are gated behind an approval checked with
 * GitHub's collaborators API; withheld previews get no secret, secret-
 * derived value or build secret; builds run in the preview isolation on
 * the right builders; `max_active` and the TTL hold; and no comment,
 * status, audit entry or response carries a secret.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import {
  type BuildJob,
  type ControlMessage,
  PREVIEW_BUILDS_PROTOCOL_VERSION,
} from "@roundhouse/protocol";
import {
  ACTIONS,
  AUDIT_ACTIONS,
  canApprovePreview,
  clampPreviewConfig,
  defaultServiceConfig,
  gatePreview,
  projectRoleCan,
} from "@roundhouse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PREVIEW_ROUTES, policyOf } from "../src/contracts";
import { app } from "../src/index";
import { runMinuteTick } from "../src/lib/dispatch";
import { admitPreview } from "../src/lib/previews/engine";
import { parsePullRequestEvent } from "../src/lib/previews/events";
import { renderPreviewComment } from "../src/lib/previews/github";
import { loadPreviewSettings } from "../src/lib/previews/settings";
import { planPreviewVariables } from "../src/lib/previews/variables";
import { findPreview } from "../src/lib/previews/view";
import { openVariable, projectKey } from "../src/lib/variables";
import {
  deliver,
  FAKE_INSTALLATION_TOKEN,
  type FakeGithub,
  fakeGithub,
  seedGithub,
} from "./fake-github";
import opened from "./fixtures/github/pull-request-opened.json";
import { addMember, type Client, eventually, install, joinNode } from "./helpers";
import {
  connectWorkloadAgent,
  createProject,
  createService,
  type FakeWorkloadAgent,
  settleDeployments,
} from "./pipeline-helpers";

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: `${{…}}` is variable-reference syntax, not a template.
const HEAD = "1111111111111111111111111111111111111111";
const NEXT = "3333333333333333333333333333333333333333";
const LATER = "4444444444444444444444444444444444444444";

// Fake values only: shaped so the classifier treats them as described, and
// so no scanner mistakes them for real credentials.
const API_KEY = "test-api-key-not-real-0001";
const BUILD_TOKEN = "test-build-token-not-real-01";
const STRIPE_KEY = "test-stripe-key-not-real";
const HIGH_ENTROPY = "notreal-Zq8vT3mR7xK2pL9wN4cB6hJ1";
const SECRETS = [API_KEY, BUILD_TOKEN, STRIPE_KEY, HIGH_ENTROPY];

const TEST_TIMEOUT_MS = 60_000;

let gh: FakeGithub;
let introspectors: Awaited<ReturnType<typeof introspectWorkflow>>[] = [];

beforeEach(async () => {
  gh = fakeGithub();
  introspectors = [
    await introspectWorkflow(env.PREVIEW_WORKFLOW),
    await introspectWorkflow(env.DEPLOY_WORKFLOW),
  ];
});

afterEach(async () => {
  await settlePreviews();
  await settleDeployments(20_000);
  for (const i of introspectors) await i.dispose();
  gh.restore();
});

/** Waits for every preview workflow instance started so far to end. */
async function settlePreviews() {
  for (const instance of await introspectors[0]!.get()) {
    try {
      await instance.waitForStatus("complete");
    } catch {
      // An errored instance has ended too.
    }
  }
}

// -----------------------------------------------------------------------------
// Payloads
// -----------------------------------------------------------------------------

type Payload = typeof opened & {
  label?: { name: string };
  changes?: { base?: { ref: { from: string } } };
};

let clock = Date.parse("2026-10-27T09:00:00Z");

/** A `pull_request` delivery derived from GitHub's documented `opened` example. */
function pr(
  o: {
    action?: string;
    number?: number;
    sha?: string;
    fork?: boolean | "deleted";
    draft?: boolean;
    merged?: boolean;
    label?: string;
    sender?: string;
    senderType?: string;
    baseRef?: string;
    previousBaseRef?: string;
    updatedAt?: number;
  } = {},
): Payload {
  const p = structuredClone(opened) as Payload;
  const number = o.number ?? 7;
  clock += 1000;
  p.action = o.action ?? "opened";
  p.number = number;
  p.pull_request.number = number;
  p.pull_request.html_url = `https://github.com/acme/shop/pull/${number}`;
  p.pull_request.head.sha = o.sha ?? HEAD;
  p.pull_request.draft = o.draft ?? false;
  p.pull_request.merged = o.merged ?? false;
  p.pull_request.updated_at = new Date(o.updatedAt ?? clock).toISOString();
  if (o.baseRef) p.pull_request.base.ref = o.baseRef;
  if (o.fork) {
    p.pull_request.user = { login: "mallory", id: 6666, type: "User" };
    p.pull_request.author_association = "NONE";
    p.pull_request.head.ref = "patch-1";
    p.pull_request.head.label = "mallory:patch-1";
    (p.pull_request.head as { repo: unknown }).repo =
      o.fork === "deleted"
        ? null
        : { ...p.pull_request.head.repo, full_name: "mallory/shop", fork: true };
    p.sender = { login: "mallory", id: 6666, type: "User" };
  }
  if (o.sender) p.sender = { login: o.sender, id: 777, type: o.senderType ?? "User" };
  if (o.label) p.label = { name: o.label };
  if (o.previousBaseRef) p.changes = { base: { ref: { from: o.previousBaseRef } } };
  return p;
}

// -----------------------------------------------------------------------------
// Stage
// -----------------------------------------------------------------------------

interface Stage {
  owner: Client;
  workspaceId: string;
  projectId: string;
  prodId: string;
  webId: string;
  dbId: string;
  agent: FakeWorkloadAgent;
  ghi: string;
}

async function ok<T>(res: Promise<{ status: number; body: T }>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
}

/**
 * A project with a git service tracking `acme/shop@main` through the claimed
 * installation, a Postgres database, and variables of every kind in
 * production, plus a builder agent new enough for preview builds.
 */
async function stage(settings: Record<string, unknown> = {}, labels?: Record<string, string>) {
  const { owner, workspaceId } = await install();
  const ghi = await seedGithub(workspaceId);
  await ok(
    owner.json("/v1/instance/settings", { method: "PATCH", json: { apps_domain: "apps.test" } }),
  );
  const joined = await joinNode(owner, workspaceId, { name: "builder-1" });
  if (labels) {
    await ok(
      owner.json(`/v1/workspaces/${workspaceId}/nodes/${joined.node_id}/labels`, {
        method: "PUT",
        json: { labels },
      }),
    );
  }
  const agent = await connectWorkloadAgent(
    joined,
    {},
    {
      protocol_version: PREVIEW_BUILDS_PROTOCOL_VERSION,
    },
  );
  const project = await createProject(owner, workspaceId, { name: "Shop" });
  const prodId = project.environments[0]!.id;
  const web = await createService(owner, project.id, {
    name: "web",
    source: {
      type: "git",
      repo_url: "https://github.com/acme/shop",
      branch: "main",
      root_dir: ".",
      github_installation_id: ghi,
    },
    config: { networking: { port: 8080, generated_domain: true } },
  });
  const db = await ok(
    owner.json<{ service: { id: string } }>(`/v1/projects/${project.id}/databases`, {
      method: "POST",
      json: { engine: "postgres", environment_id: prodId, slug: "db", deploy: false },
    }),
    201,
  );
  await ok(
    owner.json(`/v1/services/${web.service.id}/variables?environment_id=${prodId}`, {
      method: "PUT",
      json: {
        set: [
          { key: "API_KEY", value: API_KEY, tier: "secret" },
          { key: "BUILD_TOKEN", value: BUILD_TOKEN, tier: "secret", available_at_build: true },
          { key: "PUBLIC_NAME", value: "Acme Shop", tier: "plain" },
          { key: "SESSION_SALT", value: HIGH_ENTROPY, tier: "plain" },
          { key: "CHECKOUT_URL", value: "https://pay.example.com/?k=${{shared.STRIPE_KEY}}" },
          { key: "DATABASE_URL", value: "${{db.DATABASE_URL}}", tier: "plain" },
        ],
        confirm_write_only: true,
      },
    }),
  );
  await ok(
    owner.json(`/v1/projects/${project.id}/variables?environment_id=${prodId}`, {
      method: "PUT",
      json: {
        set: [
          { key: "STRIPE_KEY", value: STRIPE_KEY, tier: "secret" },
          { key: "REGION", value: "eu", tier: "plain" },
        ],
        confirm_write_only: true,
      },
    }),
  );
  await ok(
    owner.json(`/v1/projects/${project.id}/preview-settings`, {
      method: "PUT",
      json: { enabled: true, base_environment_id: prodId, ...settings },
    }),
  );
  return {
    owner,
    workspaceId,
    projectId: project.id,
    prodId,
    webId: web.service.id,
    dbId: db.service.id,
    agent,
    ghi,
  } satisfies Stage;
}

interface PreviewBody {
  id: string;
  pr_number: number;
  status: string;
  environment_id: string | null;
  environment_slug: string | null;
  head_sha: string;
  is_fork: boolean;
  withheld: boolean;
  approved_sha: string | null;
  error: string | null;
  services: {
    slug: string;
    url: string | null;
    status: string | null;
    deployment_id: string | null;
  }[];
}

async function previews(s: Stage, status: "open" | "all" = "all") {
  return (
    await ok(
      s.owner.json<{ previews: PreviewBody[] }>(
        `/v1/projects/${s.projectId}/previews?status=${status}`,
      ),
    )
  ).previews;
}

/** Waits until the project's preview of PR `number` satisfies `check`. */
function previewWhere(s: Stage, check: (p: PreviewBody) => boolean, number = 7) {
  return eventually(
    async () => (await previews(s)).find((x) => x.pr_number === number && check(x)),
    30_000,
  );
}

const isBuildJob = (m: ControlMessage): m is BuildJob => m.type === "build_job";

/** The rows of one deployment's build, with the deployment's status. */
async function deploymentsIn(environmentId: string) {
  return (
    await env.DB.prepare(
      `SELECT d.id, d.status, d.service_id, b.commit_sha, b.untrusted, b.node_id
       FROM deployments d LEFT JOIN builds b ON b.id = d.build_id
       WHERE d.environment_id = ? ORDER BY d.id`,
    )
      .bind(environmentId)
      .all<{
        id: string;
        status: string;
        service_id: string;
        commit_sha: string | null;
        untrusted: number | null;
        node_id: string | null;
      }>()
  ).results;
}

function comments(number = 7) {
  return gh.comments.get(`acme/shop#${number}`) ?? [];
}

// -----------------------------------------------------------------------------
// Pure rules
// -----------------------------------------------------------------------------

describe("preview rules", () => {
  it("gates forks behind an approval of exactly their head", () => {
    const table: [Parameters<typeof gatePreview>[0], string][] = [
      [{ isFork: false, forkPolicy: "disabled", headSha: "a", approvedSha: null }, "pass"],
      [{ isFork: true, forkPolicy: "disabled", headSha: "a", approvedSha: "a" }, "fork_disabled"],
      [
        { isFork: true, forkPolicy: "approval", headSha: "a", approvedSha: null },
        "pending_approval",
      ],
      [
        { isFork: true, forkPolicy: "approval", headSha: "b", approvedSha: "a" },
        "pending_approval",
      ],
      [{ isFork: true, forkPolicy: "approval", headSha: "a", approvedSha: "a" }, "pass"],
    ];
    for (const [input, want] of table) expect(gatePreview(input), JSON.stringify(input)).toBe(want);
    expect(["admin", "maintain", "write"].every(canApprovePreview)).toBe(true);
    expect(["read", "triage", "none", null, undefined].some(canApprovePreview)).toBe(false);
  });

  it("clamps resources to the caps without raising anything", () => {
    const spec = defaultServiceConfig({ type: "image", image: "nginx:1.27" });
    spec.deploy.replicas = 4;
    spec.resources = { cpu_millis: 4000, memory_mb: 256 };
    spec.placement.node_selector = { zone: "a", pool: "prod" };
    const out = clampPreviewConfig(
      spec,
      { replicas: 1, cpu_millis: 500, memory_mb: 1024, volume_mb: 512 },
      { pool: "preview" },
    );
    expect(out.deploy.replicas).toBe(1);
    expect(out.resources).toEqual({ cpu_millis: 500, memory_mb: 256 });
    expect(out.placement.node_selector).toEqual({ zone: "a", pool: "preview" });
    expect(spec.deploy.replicas).toBe(4);
  });

  it("withholds secrets, credential-looking values and everything resolving through them", () => {
    const base = (
      scope: "service" | "shared",
      serviceId: string | null,
      key: string,
      value: string,
      tier: "plain" | "secret" = "plain",
    ) => ({
      scope,
      serviceId,
      key,
      value,
      tier,
      locked: false,
      availableAtBuild: false,
      mountAsFile: false,
    });
    const input = {
      base: [
        base("service", "svc_web", "API_KEY", API_KEY, "secret"),
        base("service", "svc_web", "SALT", HIGH_ENTROPY),
        base("service", "svc_web", "NAME", "Acme"),
        base("service", "svc_web", "PAY", "x${{shared.STRIPE}}"),
        base("service", "svc_web", "PAY2", "${{web.PAY}}/v2"),
        base("service", "svc_web", "SALTED", "${{SALT}}!"),
        base("service", "svc_web", "DB", "${{db.DATABASE_URL}}"),
        base("service", "svc_db", "POSTGRES_PASSWORD", "copied-password-0001", "secret"),
        base("shared", null, "STRIPE", STRIPE_KEY, "secret"),
        base("shared", null, "REGION", "eu"),
      ],
      slugs: new Map([
        ["svc_web", "web"],
        ["svc_db", "db"],
      ]),
      fresh: [
        {
          serviceId: "svc_db",
          entries: [
            {
              key: "POSTGRES_PASSWORD",
              value: "fresh-password-0001",
              tier: "secret" as const,
              locked: false,
            },
            {
              key: "DATABASE_URL",
              value: "postgres://u:${{db.POSTGRES_PASSWORD}}@db",
              tier: "plain" as const,
              locked: false,
            },
          ],
        },
      ],
    };
    const withheld = planPreviewVariables({ ...input, withhold: true });
    const by = (key: string) => withheld.find((v) => v.key === key)!;
    for (const key of ["API_KEY", "SALT", "PAY", "PAY2", "SALTED", "STRIPE"]) {
      expect(by(key), key).toMatchObject({ withheld: true, value: "" });
    }
    for (const key of ["NAME", "REGION", "DB", "DATABASE_URL"]) {
      expect(by(key).withheld, key).toBe(false);
    }
    expect(by("API_KEY").tier).toBe("secret");
    expect(by("POSTGRES_PASSWORD")).toMatchObject({
      value: "fresh-password-0001",
      withheld: false,
    });
    expect(JSON.stringify(withheld)).not.toContain("copied-password-0001");
    for (const secret of SECRETS) expect(JSON.stringify(withheld)).not.toContain(secret);

    const copied = planPreviewVariables({ ...input, withhold: false });
    expect(copied.find((v) => v.key === "API_KEY")).toMatchObject({
      value: API_KEY,
      withheld: false,
    });
    // Database credentials are never copied, withheld or not.
    expect(copied.find((v) => v.key === "POSTGRES_PASSWORD")!.value).toBe("fresh-password-0001");
  });

  it("parses only the fields it needs, and refuses malformed deliveries", () => {
    const event = parsePullRequestEvent(pr({ fork: true }))!;
    expect(event).toMatchObject({
      action: "opened",
      number: 7,
      head: { sha: HEAD, repo_full_name: "mallory/shop" },
      base: { ref: "main", repo_full_name: "acme/shop", previous_ref: null },
      author: { login: "mallory", association: "NONE" },
      installation_id: 55501234,
    });
    expect(JSON.stringify(event).length).toBeLessThan(4096);
    expect(parsePullRequestEvent(pr({ fork: "deleted" }))!.head.repo_full_name).toBeNull();
    expect(parsePullRequestEvent({ ...pr(), action: "assigned" })).toBeNull();
    // A label is compared with the approval label whole, never cut to fit.
    const long = pr({ action: "labeled", label: `${"x".repeat(50)}y` });
    expect(parsePullRequestEvent(long)!.label).toBeNull();
    expect(
      parsePullRequestEvent(pr({ action: "labeled", label: "roundhouse:preview" }))!.label,
    ).toBe("roundhouse:preview");
    const badSha = pr();
    badSha.pull_request.head.sha = "main";
    expect(parsePullRequestEvent(badSha)).toBeNull();
    const badRepo = pr();
    badRepo.pull_request.base.repo.full_name = "../../etc";
    expect(parsePullRequestEvent(badRepo)).toBeNull();
  });

  it("renders a comment of statuses, links and SHAs only", () => {
    const body = renderPreviewComment({
      projectId: "prj_1",
      projectName: "Shop | <b>",
      status: "active",
      headSha: HEAD,
      approvalLabel: "roundhouse:preview",
      maxActive: 5,
      ttlHours: 72,
      expiresAt: Date.UTC(2026, 9, 30),
      services: [
        {
          service_id: "svc_1",
          slug: "web",
          name: "web",
          url: "https://web-pr-7-ab12.apps.test",
          deployment_id: "dep_1",
          status: "active",
          commit_sha: HEAD,
        },
      ],
      dashboardUrl: "https://cp.test/w/ws/p/prj_1/previews",
      now: Date.UTC(2026, 9, 27),
    });
    expect(body.startsWith("<!-- roundhouse-preview:prj_1 -->")).toBe(true);
    expect(body).toContain(
      "| web | Ready | [web-pr-7-ab12.apps.test](https://web-pr-7-ab12.apps.test) | `1111111` |",
    );
    expect(body).toContain("Shop \\| \\<b\\>");
    expect(body).not.toContain("<b>");
  });
});

// -----------------------------------------------------------------------------
// Contracts, settings, RBAC
// -----------------------------------------------------------------------------

describe("preview routes and settings", () => {
  it("serves every route with a coherent policy", () => {
    const live = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    for (const [name, route] of Object.entries(PREVIEW_ROUTES)) {
      const op = (live.paths?.[route.path] as Record<string, Record<string, unknown>>)?.[
        route.method
      ];
      expect(op, name).toBeDefined();
      expect(ACTIONS).toContain(policyOf(route).action);
      for (const a of policyOf(route).audit) expect(AUDIT_ACTIONS).toContain(a);
      if (route.method === "get") expect(policyOf(route).audit, name).toEqual([]);
    }
    expect(policyOf(PREVIEW_ROUTES.approvePreview).action).toBe("previews:manage");
    expect(policyOf(PREVIEW_ROUTES.putPreviewSettings).action).toBe("previews:manage");
    expect(policyOf(PREVIEW_ROUTES.deletePreview).action).toBe("environments:manage");
    expect(projectRoleCan("project_admin", "previews:manage")).toBe(true);
    expect(projectRoleCan("developer", "previews:manage")).toBe(false);
    expect(projectRoleCan("developer", "environments:manage")).toBe(true);
    expect(projectRoleCan("deployer", "environments:manage")).toBe(false);
  });

  it("validates settings and lets only project admins change them", async () => {
    const { owner, workspaceId } = await install();
    const project = await createProject(owner, workspaceId, { name: "Shop" });
    const prodId = project.environments[0]!.id;
    const defaults = await ok(
      owner.json<{ configured: boolean; enabled: boolean; base_environment_id: string }>(
        `/v1/projects/${project.id}/preview-settings`,
      ),
    );
    expect(defaults).toMatchObject({
      configured: false,
      enabled: false,
      base_environment_id: prodId,
    });

    const put = (json: Record<string, unknown>, c: Client = owner) =>
      c.json<{ error?: { code: string } }>(`/v1/projects/${project.id}/preview-settings`, {
        method: "PUT",
        json: { enabled: true, base_environment_id: prodId, ...json },
      });
    expect((await put({ fork_policy: "approval" })).body.error?.code).toBe(
      "build_node_selector_required",
    );
    expect((await put({ services: ["svc_nope"] })).status).toBe(400);
    expect((await put({ base_environment_id: "env_nope" })).status).toBe(400);
    expect((await put({ ttl_hours: 0 })).status).toBe(400);
    expect((await put({ max_active: 51 })).status).toBe(400);
    expect((await put({ approval_label: "a,b" })).status).toBe(400);
    const saved = await put({
      fork_policy: "approval",
      build_node_selector: { pool: "untrusted" },
      max_active: 2,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ configured: true, fork_policy: "approval", max_active: 2 });

    const dev = await addMember(owner, workspaceId, "dev@example.com", "member");
    expect((await put({}, dev)).status).toBe(403);
    expect((await dev.json(`/v1/projects/${project.id}/preview-settings`)).status).toBe(200);
    const audit = await env.DB.prepare(
      "SELECT metadata FROM audit_logs WHERE action = 'preview.settings_updated'",
    ).all<{ metadata: string }>();
    expect(audit.results).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// Webhook intake
// -----------------------------------------------------------------------------

describe("pull_request intake", () => {
  it(
    "refuses unsigned or mis-signed deliveries before parsing them",
    async () => {
      const s = await stage();
      expect((await deliver("pull_request", pr(), { signature: null })).status).toBe(400);
      expect(
        (await deliver("pull_request", pr(), { signature: `sha256=${"0".repeat(64)}` })).status,
      ).toBe(401);
      expect(await previews(s)).toEqual([]);
      expect(await introspectors[0]!.get()).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "builds a same-repository PR at its head, comments once and keeps the comment current",
    async () => {
      const s = await stage();
      const seen = gh.requests.length;
      expect((await deliver("pull_request", pr())).status).toBe(202);
      const active = await previewWhere(
        s,
        (p) =>
          p.status === "active" &&
          p.services.some((x) => x.slug === "web" && x.status === "active"),
      );
      expect(active).toMatchObject({ is_fork: false, withheld: false, environment_slug: "pr-7" });
      const envId = active.environment_id!;

      const environments = await ok(
        s.owner.json<{
          environments: { id: string; kind: string; slug: string; preview_id: string | null }[];
        }>(`/v1/projects/${s.projectId}/environments`),
      );
      expect(environments.environments.find((e) => e.id === envId)).toMatchObject({
        kind: "preview",
        slug: "pr-7",
        preview_id: active.id,
      });

      const job = await s.agent.waitFor(isBuildJob);
      expect(job).toMatchObject({
        isolation: "preview",
        cache_key: `${s.projectId}.${s.webId}.preview`,
        source: { commit_sha: HEAD, ref: "refs/pull/7/head", token: FAKE_INSTALLATION_TOKEN },
      });
      // Same-repository previews copy secrets like a clone (same_repo_secrets: copy).
      expect(s.agent.buildSecrets(job.build_id)).toEqual({ BUILD_TOKEN });
      const tokenScopes = gh.requests
        .slice(seen)
        .filter((r) => r.path.endsWith("/access_tokens"))
        .map((r) => r.body as { repositories?: string[]; permissions?: Record<string, string> });
      for (const scope of tokenScopes) expect(scope.repositories).toEqual(["shop"]);
      expect(tokenScopes).toContainEqual({
        repositories: ["shop"],
        permissions: { contents: "read" },
      });

      const web = active.services.find((x) => x.slug === "web")!;
      expect(web.url).toMatch(/^https:\/\/web-pr-7-[a-z0-9]+\.apps\.test$/);
      await eventually(
        async () =>
          gh.statuses.some((x) => x.state === "success" && x.sha === HEAD) ? true : undefined,
        30_000,
      );
      const status = gh.statuses.find((x) => x.state === "success")!;
      expect(status.context).toBe("roundhouse/preview/shop");
      expect(status.target_url).toBe(
        `https://cp.test/w/${s.workspaceId}/p/${s.projectId}/previews`,
      );
      // The per-deployment status (with failure reasons) is not posted for previews.
      expect(gh.statuses.every((x) => x.context.startsWith("roundhouse/preview/"))).toBe(true);
      await eventually(
        async () => (comments()[0]?.body.includes(web.url!) ? true : undefined),
        30_000,
      );
      expect(comments()).toHaveLength(1);

      // A push redeploys the git service at the new head; the comment is edited, not repeated.
      expect((await deliver("pull_request", pr({ action: "synchronize", sha: NEXT }))).status).toBe(
        202,
      );
      await eventually(async () => {
        const rows = await deploymentsIn(envId);
        return rows.some((r) => r.commit_sha === NEXT && r.status === "active") ? true : undefined;
      }, 30_000);
      await eventually(
        async () => (comments()[0]?.body.includes("`3333333`") ? true : undefined),
        30_000,
      );
      expect(comments()).toHaveLength(1);
      expect(
        gh.requests.filter((r) => r.method === "POST" && r.path.endsWith("/comments")),
      ).toHaveLength(1);

      const audit = await env.DB.prepare(
        "SELECT action, actor_type FROM audit_logs WHERE action LIKE 'preview.%'",
      ).all<{ action: string; actor_type: string }>();
      expect(audit.results).toContainEqual({ action: "preview.created", actor_type: "system" });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "drops events older than the last one applied",
    async () => {
      const s = await stage();
      await deliver("pull_request", pr());
      const first = await previewWhere(s, (p) => p.status === "active");
      await deliver("pull_request", pr({ action: "synchronize", sha: NEXT }));
      await previewWhere(s, (p) => p.head_sha === NEXT);
      await settlePreviews();
      await deliver(
        "pull_request",
        pr({ action: "synchronize", sha: LATER, updatedAt: Date.parse("2026-01-01T00:00:00Z") }),
      );
      await settlePreviews();
      const now = (await previews(s)).find((p) => p.id === first.id)!;
      expect(now.head_sha).toBe(NEXT);
      const rows = await deploymentsIn(now.environment_id!);
      expect(rows.some((r) => r.commit_sha === LATER)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ignores drafts while skip_drafts is on, and PRs against untracked branches",
    async () => {
      const s = await stage();
      await deliver("pull_request", pr({ draft: true }));
      await deliver("pull_request", pr({ number: 8, baseRef: "develop" }));
      await settlePreviews();
      expect(await previews(s)).toEqual([]);
      await deliver("pull_request", pr({ action: "ready_for_review" }));
      await previewWhere(s, (p) => p.status === "active");
    },
    TEST_TIMEOUT_MS,
  );
});

// -----------------------------------------------------------------------------
// Forks
// -----------------------------------------------------------------------------

describe("fork pull requests", () => {
  it(
    "never builds a fork while fork previews are off, and says why",
    async () => {
      const s = await stage();
      await deliver("pull_request", pr({ fork: true }));
      const p = await previewWhere(s, (x) => x.status === "fork_disabled");
      expect(p.environment_id).toBeNull();
      expect(s.agent.received.some(isBuildJob)).toBe(false);
      await eventually(async () => (comments()[0]?.body.includes("turned off") ? true : undefined));
      const gated = await env.DB.prepare(
        "SELECT metadata FROM audit_logs WHERE action = 'preview.gated'",
      ).first<{ metadata: string }>();
      expect(JSON.parse(gated!.metadata)).toMatchObject({
        reason: "fork_disabled",
        github_sender: "mallory",
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "builds a fork only after a collaborator with write access approves its exact head, with every secret withheld",
    async () => {
      const s = await stage(
        { fork_policy: "approval", build_node_selector: { pool: "untrusted" } },
        { pool: "untrusted" },
      );
      await deliver("pull_request", pr({ fork: true }));
      const pending = await previewWhere(s, (x) => x.status === "pending_approval");
      expect(pending.is_fork).toBe(true);
      await eventually(async () =>
        comments()[0]?.body.includes("approves it") ? true : undefined,
      );
      expect(gh.statuses.at(-1)).toMatchObject({ state: "pending", sha: HEAD });

      // The label alone proves nothing: a read-only sender's label is ignored.
      gh.permissions.set("rita", "read");
      await deliver(
        "pull_request",
        pr({ fork: true, action: "labeled", label: "roundhouse:preview", sender: "rita" }),
      );
      await settlePreviews();
      expect(
        gh.requests.some((r) => r.path === "/repos/acme/shop/collaborators/rita/permission"),
      ).toBe(true);
      expect((await previews(s))[0]!.status).toBe("pending_approval");
      // Neither does a sender GitHub doesn't know as a collaborator, nor a label of another name.
      await deliver(
        "pull_request",
        pr({ fork: true, action: "labeled", label: "roundhouse:preview", sender: "nobody" }),
      );
      gh.permissions.set("wes", "write");
      await deliver(
        "pull_request",
        pr({ fork: true, action: "labeled", label: "lgtm", sender: "wes" }),
      );
      await settlePreviews();
      expect((await previews(s))[0]!.status).toBe("pending_approval");
      expect(s.agent.received.some(isBuildJob)).toBe(false);

      await deliver(
        "pull_request",
        pr({ fork: true, action: "labeled", label: "roundhouse:preview", sender: "wes" }),
      );
      const active = await previewWhere(
        s,
        (x) =>
          x.status === "active" &&
          x.services.some((y) => y.slug === "web" && y.status === "active"),
      );
      expect(active).toMatchObject({ approved_sha: HEAD, withheld: true });
      const envId = active.environment_id!;

      // Variables: secrets, credential-looking values and secret-derived values are placeholders.
      const vars = await ok(
        s.owner.json<{
          variables: { key: string; value: string | null; withheld: boolean; tier: string }[];
        }>(`/v1/services/${s.webId}/variables?environment_id=${envId}`),
      );
      const by = (k: string) => vars.variables.find((v) => v.key === k)!;
      for (const k of ["API_KEY", "BUILD_TOKEN", "SESSION_SALT", "CHECKOUT_URL"]) {
        expect(by(k).withheld, k).toBe(true);
      }
      expect(by("SESSION_SALT").value).toBe("");
      expect(by("CHECKOUT_URL").value).toBe("");
      expect(by("PUBLIC_NAME")).toMatchObject({ withheld: false, value: "Acme Shop" });
      expect(by("DATABASE_URL")).toMatchObject({ withheld: false, value: "${{db.DATABASE_URL}}" });
      const shared = await ok(
        s.owner.json<{ variables: { key: string; withheld: boolean }[] }>(
          `/v1/projects/${s.projectId}/variables?environment_id=${envId}`,
        ),
      );
      expect(shared.variables.find((v) => v.key === "STRIPE_KEY")!.withheld).toBe(true);
      expect(shared.variables.find((v) => v.key === "REGION")!.withheld).toBe(false);

      // The database gets fresh credentials, not production's, and they aren't withheld.
      const key = await projectKey(createDb(env.DB), env, s.projectId);
      const password = async (environmentId: string) => {
        const row = await env.DB.prepare(
          "SELECT * FROM variables WHERE service_id = ? AND environment_id = ? AND key = 'POSTGRES_PASSWORD'",
        )
          .bind(s.dbId, environmentId)
          .first<Record<string, unknown>>();
        expect(row?.withheld).toBe(0);
        return openVariable(key, {
          id: row!.id as string,
          projectId: s.projectId,
          environmentId,
          scope: "service",
          serviceId: s.dbId,
          key: "POSTGRES_PASSWORD",
          version: row!.version as number,
          valueSealed: JSON.parse(row!.value_sealed as string),
        } as never);
      };
      const [prodPassword, previewPassword] = [await password(s.prodId), await password(envId)];
      expect(previewPassword).toBeTruthy();
      expect(previewPassword).not.toBe(prodPassword);

      // The build: preview isolation, read-only repo token for git only, no build secret.
      const job = await s.agent.waitFor(isBuildJob);
      expect(job).toMatchObject({
        isolation: "preview",
        cache_key: `${s.projectId}.${s.webId}.preview`,
        source: { commit_sha: HEAD, ref: "refs/pull/7/head" },
      });
      expect(job.build_secrets_sealed).toBeUndefined();
      expect(JSON.stringify(job.build_args)).not.toContain(BUILD_TOKEN);
      const rows = await deploymentsIn(envId);
      expect(rows.find((r) => r.service_id === s.webId)).toMatchObject({ untrusted: 1 });

      // The running workload sees placeholders, and its own database's credentials.
      const desired = s.agent.desired()!;
      expect(desired.workloads.length).toBeGreaterThan(0);
      const seen = JSON.stringify(desired.workloads.map((w) => s.agent.env(w.id) ?? {}));
      for (const secret of [...SECRETS, prodPassword]) expect(seen).not.toContain(secret);

      // A new fork commit outdates the approval: label removed, not built.
      const before = (await deploymentsIn(envId)).length;
      gh.labels.set("acme/shop#7", new Set(["roundhouse:preview"]));
      await deliver("pull_request", pr({ fork: true, action: "synchronize", sha: NEXT }));
      await previewWhere(s, (x) => x.status === "pending_approval" && x.head_sha === NEXT);
      await settlePreviews();
      expect(gh.labels.get("acme/shop#7")?.has("roundhouse:preview")).toBe(false);
      expect((await deploymentsIn(envId)).length).toBe(before);
      expect(comments()).toHaveLength(1);
      await eventually(async () => (comments()[0]?.body.includes("`3333333`") ? true : undefined));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "treats a PR whose fork was deleted as a fork",
    async () => {
      const s = await stage();
      await deliver("pull_request", pr({ fork: "deleted" }));
      await previewWhere(s, (x) => x.status === "fork_disabled" && x.is_fork);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps fork builds off builders of the project's other environments, and the other way round",
    async () => {
      const s = await stage({
        fork_policy: "approval",
        build_node_selector: { pool: "untrusted" },
      });
      // builder-1 has no label: it may build production, never a fork.
      const prod = await ok(
        s.owner.json<{ id: string }>(
          `/v1/services/${s.webId}/deployments?environment_id=${s.prodId}`,
          {
            method: "POST",
            json: { commit_sha: HEAD },
          },
        ),
        201,
      );
      await eventually(async () => {
        const r = await env.DB.prepare("SELECT node_id FROM builds WHERE deployment_id = ?")
          .bind(prod.id)
          .first<{ node_id: string }>();
        return r?.node_id ?? undefined;
      }, 20_000);

      gh.permissions.set("wes", "admin");
      await deliver("pull_request", pr({ fork: true }));
      await previewWhere(s, (x) => x.status === "pending_approval");
      await deliver(
        "pull_request",
        pr({ fork: true, action: "labeled", label: "roundhouse:preview", sender: "wes" }),
      );
      const failed = await eventually(async () => {
        const p = (await previews(s))[0];
        const rows = p?.environment_id ? await deploymentsIn(p.environment_id) : [];
        const web = rows.find((r) => r.service_id === s.webId);
        return web?.status === "failed" ? web : undefined;
      }, 30_000);
      const reason = await env.DB.prepare("SELECT failure_reason FROM deployments WHERE id = ?")
        .bind(failed.id)
        .first<{ failure_reason: string }>();
      expect(reason?.failure_reason).toMatch(/No builder node for fork previews/);

      // A dedicated node for forks: the fork builds there, production never does.
      const joined = await joinNode(s.owner, s.workspaceId, { name: "fork-builder" });
      await ok(
        s.owner.json(`/v1/workspaces/${s.workspaceId}/nodes/${joined.node_id}/labels`, {
          method: "PUT",
          json: { labels: { pool: "untrusted" } },
        }),
      );
      const forkAgent = await connectWorkloadAgent(
        joined,
        {},
        {
          protocol_version: PREVIEW_BUILDS_PROTOCOL_VERSION,
        },
      );
      const p = (await previews(s))[0]!;
      await ok(s.owner.json(`/v1/previews/${p.id}/redeploy`, { method: "POST" }));
      const forkJob = await forkAgent.waitFor(isBuildJob, 20_000);
      expect(forkJob.isolation).toBe("preview");
      const prod2 = await ok(
        s.owner.json<{ id: string }>(
          `/v1/services/${s.webId}/deployments?environment_id=${s.prodId}`,
          {
            method: "POST",
            json: { commit_sha: HEAD },
          },
        ),
        201,
      );
      const node = await eventually(async () => {
        const r = await env.DB.prepare("SELECT node_id FROM builds WHERE deployment_id = ?")
          .bind(prod2.id)
          .first<{ node_id: string }>();
        return r?.node_id ?? undefined;
      }, 20_000);
      expect(node).not.toBe(joined.node_id);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "approves from the dashboard for the head the approver saw, and adds the label",
    async () => {
      const s = await stage(
        { fork_policy: "approval", build_node_selector: { pool: "untrusted" } },
        { pool: "untrusted" },
      );
      await deliver("pull_request", pr({ fork: true }));
      const p = await previewWhere(s, (x) => x.status === "pending_approval");

      const dev = await addMember(s.owner, s.workspaceId, "dev@example.com", "member");
      expect(
        (
          await dev.json(`/v1/previews/${p.id}/approve`, {
            method: "POST",
            json: { head_sha: HEAD },
          })
        ).status,
      ).toBe(403);
      const moved = await s.owner.json<{ error: { code: string } }>(
        `/v1/previews/${p.id}/approve`,
        {
          method: "POST",
          json: { head_sha: NEXT },
        },
      );
      expect(moved.status).toBe(409);
      expect(moved.body.error.code).toBe("head_moved");

      await ok(
        s.owner.json(`/v1/previews/${p.id}/approve`, { method: "POST", json: { head_sha: HEAD } }),
      );
      await previewWhere(s, (x) => x.status === "active" && x.approved_sha === HEAD);
      await eventually(async () =>
        gh.labels.get("acme/shop#7")?.has("roundhouse:preview") ? true : undefined,
      );
      const approved = await env.DB.prepare(
        "SELECT actor_type, metadata FROM audit_logs WHERE action = 'preview.approved'",
      ).first<{ actor_type: string; metadata: string }>();
      expect(approved?.actor_type).toBe("user");
      expect(JSON.parse(approved!.metadata)).toMatchObject({ head_sha: HEAD, via: "dashboard" });
      // Already approved: approving again is a conflict.
      expect(
        (
          await s.owner.json(`/v1/previews/${p.id}/approve`, {
            method: "POST",
            json: { head_sha: HEAD },
          })
        ).status,
      ).toBe(409);
    },
    TEST_TIMEOUT_MS,
  );
});

// -----------------------------------------------------------------------------
// Teardown, limits, expiry
// -----------------------------------------------------------------------------

describe("teardown and limits", () => {
  it(
    "tears everything down when the PR closes, and comes back on reopen",
    async () => {
      const s = await stage();
      await deliver("pull_request", pr());
      const active = await previewWhere(
        s,
        (p) => p.status === "active" && p.services.some((x) => x.status === "active"),
      );
      const envId = active.environment_id!;
      // The database's volume exists while the preview does.
      const volumesBefore = await env.DB.prepare(
        "SELECT status, size_mb FROM volumes WHERE environment_id = ?",
      )
        .bind(envId)
        .all<{ status: string; size_mb: number }>();
      expect(volumesBefore.results.length).toBeGreaterThan(0);
      for (const v of volumesBefore.results) expect(v.size_mb).toBeLessThanOrEqual(1024);

      await deliver("pull_request", pr({ action: "closed", merged: true }));
      const closed = await previewWhere(s, (p) => p.status === "closed");
      expect(closed.environment_id).toBeNull();
      await settlePreviews();
      const rows = await deploymentsIn(envId);
      expect(rows.filter((r) => !["removed", "cancelled", "failed"].includes(r.status))).toEqual(
        [],
      );
      const volumes = await env.DB.prepare(
        "SELECT status, delete_after FROM volumes WHERE environment_id = ?",
      )
        .bind(envId)
        .all<{ status: string; delete_after: number }>();
      for (const v of volumes.results) {
        expect(v.status).toBe("pending_deletion");
        expect(v.delete_after).toBeGreaterThan(Date.now() + 71 * 3_600_000);
      }
      const domains = await env.DB.prepare(
        "SELECT count(*) AS n FROM domains WHERE environment_id = ?",
      )
        .bind(envId)
        .first<{ n: number }>();
      expect(domains?.n).toBe(0);
      const listed = await ok(
        s.owner.json<{ environments: { id: string }[] }>(
          `/v1/projects/${s.projectId}/environments`,
        ),
      );
      expect(listed.environments.some((e) => e.id === envId)).toBe(false);
      expect(
        (
          await s.owner.json(`/v1/services/${s.webId}/deployments?environment_id=${envId}`, {
            method: "POST",
            json: {},
          })
        ).status,
      ).toBe(404);
      await eventually(async () => (comments()[0]?.body.includes("torn down") ? true : undefined));
      const audit = await env.DB.prepare(
        "SELECT metadata FROM audit_logs WHERE action = 'preview.closed'",
      ).first<{ metadata: string }>();
      expect(JSON.parse(audit!.metadata)).toMatchObject({ reason: "merged", merged: true });

      await deliver("pull_request", pr({ action: "reopened" }));
      const back = await previewWhere(s, (p) => p.status === "active" && p.environment_id !== null);
      expect(back.environment_id).not.toBe(envId);
      expect(back.environment_slug).toBe("pr-7");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never publishes a preview's ports or rotates its minted credentials",
    async () => {
      const s = await stage();
      await deliver("pull_request", pr());
      const p = await previewWhere(s, (x) => x.status === "active");
      const envId = p.environment_id!;
      const proxy = await s.owner.json(`/v1/services/${s.dbId}/tcp-proxies`, {
        method: "PUT",
        json: { environment_id: envId, allowed_cidrs: ["203.0.113.0/24"] },
      });
      expect(proxy.status).toBe(409);
      const rotate = await s.owner.json(`/v1/services/${s.dbId}/database/rotate-credentials`, {
        method: "POST",
        json: { environment_id: envId, confirm: "db" },
      });
      expect(rotate.status).toBe(409);
      const rows = await env.DB.prepare("SELECT count(*) AS n FROM tcp_proxies").first<{
        n: number;
      }>();
      expect(rows?.n).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "tears down from the API, for environments:manage only",
    async () => {
      const s = await stage();
      await deliver("pull_request", pr());
      const p = await previewWhere(s, (x) => x.status === "active");
      const viewer = await addMember(s.owner, s.workspaceId, "viewer@example.com", "viewer");
      expect((await viewer.json(`/v1/previews/${p.id}`)).status).toBe(200);
      expect((await viewer.json(`/v1/previews/${p.id}`, { method: "DELETE" })).status).toBe(403);
      const dev = await addMember(s.owner, s.workspaceId, "dev@example.com", "member");
      const res = await ok(dev.json<PreviewBody>(`/v1/previews/${p.id}`, { method: "DELETE" }));
      expect(res).toMatchObject({ status: "closed", environment_id: null });
      const audit = await env.DB.prepare(
        "SELECT actor_type FROM audit_logs WHERE action = 'preview.deleted'",
      ).first<{ actor_type: string }>();
      expect(audit?.actor_type).toBe("user");
      expect((await viewer.json(`/v1/previews/prv_nope`)).status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never admits more than max_active, however many arrive at once",
    async () => {
      const s = await stage({ max_active: 2 });
      const db = createDb(env.DB);
      const settings = (await loadPreviewSettings(db, s.projectId))!;
      const ids: string[] = [];
      for (let n = 1; n <= 6; n++) {
        const id = `prv_TESTADMIT${n}`;
        ids.push(id);
        await env.DB.prepare(
          `INSERT INTO preview_environments (id, project_id, repo_full_name, pr_number, installation_ref,
             head_ref, head_sha, is_fork, author_login, author_association, status,
             last_event_at, last_activity_at, created_at, updated_at)
           VALUES (?, ?, 'acme/shop', ?, ?, 'b', ?, 0, 'mara', 'MEMBER', 'queued_limit', 0, 0, 0, 0)`,
        )
          .bind(id, s.projectId, 100 + n, s.ghi, HEAD)
          .run();
      }
      const rows = await Promise.all(ids.map((id) => findPreview(db, id)));
      const results = await Promise.all(
        rows.map((row) => admitPreview(db, row!, settings, Date.now())),
      );
      expect(results.filter((r) => r.step === "create")).toHaveLength(2);
      const creating = await env.DB.prepare(
        "SELECT count(*) AS n FROM preview_environments WHERE project_id = ? AND status = 'creating'",
      )
        .bind(s.projectId)
        .first<{ n: number }>();
      expect(creating?.n).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "queues previews past max_active and admits them as slots free up",
    async () => {
      const s = await stage({ max_active: 1 });
      await deliver("pull_request", pr({ number: 1 }));
      await previewWhere(s, (p) => p.status === "active", 1);
      await deliver("pull_request", pr({ number: 2 }));
      const queued = await previewWhere(s, (p) => p.status === "queued_limit", 2);
      expect(queued.environment_id).toBeNull();
      await eventually(async () =>
        comments(2)[0]?.body.includes("free preview slot") ? true : undefined,
      );

      await deliver("pull_request", pr({ number: 1, action: "closed" }));
      await previewWhere(s, (p) => p.status === "closed", 1);
      await runMinuteTick(env, Date.now());
      await previewWhere(s, (p) => p.id === queued.id && p.status === "active", 2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "expires previews idle past their TTL, and reaps the environment once its volumes are gone",
    async () => {
      const s = await stage({ ttl_hours: 1 });
      await deliver("pull_request", pr());
      const p = await previewWhere(s, (x) => x.status === "active");
      await settlePreviews();
      await runMinuteTick(env, Date.now() + 2 * 3_600_000);
      const expired = await previewWhere(s, (x) => x.status === "expired");
      expect(expired.environment_id).toBeNull();
      const audit = await env.DB.prepare(
        "SELECT count(*) AS n FROM audit_logs WHERE action = 'preview.expired'",
      ).first<{
        n: number;
      }>();
      expect(audit?.n).toBe(1);
      await eventually(async () => (comments()[0]?.body.includes("expired") ? true : undefined));

      await env.DB.prepare("UPDATE volumes SET status = 'deleted' WHERE environment_id = ?")
        .bind(p.environment_id)
        .run();
      await runMinuteTick(env, Date.now());
      const gone = await env.DB.prepare("SELECT count(*) AS n FROM environments WHERE id = ?")
        .bind(p.environment_id)
        .first<{ n: number }>();
      expect(gone?.n).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

// -----------------------------------------------------------------------------
// Nothing secret leaves
// -----------------------------------------------------------------------------

describe("secrets stay inside", () => {
  it(
    "never puts a value into comments, statuses, audit entries or responses",
    async () => {
      const s = await stage({ same_repo_secrets: "omit" });
      s.agent.behaviour.build = "fail";
      await deliver("pull_request", pr());
      await previewWhere(
        s,
        (p) =>
          p.status === "active" &&
          p.services.some((x) => x.slug === "web" && x.status === "failed"),
      );
      await eventually(
        async () => (gh.statuses.some((x) => x.state === "failure") ? true : undefined),
        30_000,
      );
      await deliver("pull_request", pr({ action: "closed" }));
      await previewWhere(s, (p) => p.status === "closed");
      await settlePreviews();

      const outbound = JSON.stringify(gh.requests.map((r) => r.body));
      const audit = JSON.stringify(
        (await env.DB.prepare("SELECT metadata FROM audit_logs").all<{ metadata: string }>())
          .results,
      );
      const listed = JSON.stringify(await previews(s));
      for (const text of [outbound, audit, listed]) {
        for (const secret of SECRETS) expect(text).not.toContain(secret);
      }
      // Failure reasons, which can quote build errors, never reach GitHub or the list.
      for (const text of [outbound, listed]) expect(text).not.toContain("exit status 1");
      expect(gh.statuses.find((x) => x.state === "failure")!.description).toBe(
        "A preview deployment failed",
      );
    },
    TEST_TIMEOUT_MS,
  );
});
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: see above
