/**
 * Pull request preview tables of the mock database (ADR 0007): per-project preview
 * settings and the previews themselves. Row shapes are the API's own types.
 *
 * The seed configures previews for the storefront project (fork PRs need approval and
 * build on `pool=untrusted`) with four PRs: #42 active, #57 a fork waiting for
 * approval, #61 a fork while that was disabled, and #30 closed.
 *
 * #42's environment `pr-42` (with a withheld secret) is added only by
 * {@link addPreviewEnvironment}, so pages and scenarios that count the storefront's
 * environments keep seeing production alone.
 *
 * @module
 */
import {
  DEFAULT_PREVIEW_APPROVAL_LABEL,
  DEFAULT_PREVIEW_CAPS,
  PREVIEW_LIMITS,
} from "@roundhouse/shared";
import type { Preview, PreviewSettings } from "../lib/api/previews-client";
import type { DeployDb } from "./deploy-db";

/** Saved settings of a project; the API derives the rest. */
export type DbPreviewSettings = Omit<PreviewSettings, "project_id" | "pull_request_events_seen">;

/** Every preview table. */
export interface PreviewsDb {
  /** Saved settings by project id. */
  settings: Record<string, DbPreviewSettings>;
  previews: Preview[];
  /** Whether the instance has received a `pull_request` delivery. */
  pullRequestEventsSeen: boolean;
}

/** Ids of the seeded preview rows, for tests. */
export const PREVIEW_SEED = {
  active: "prv_42",
  pending: "prv_57",
  forkDisabled: "prv_61",
  closed: "prv_30",
  environment: "env_store_pr42",
  activeSha: "4c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
  pendingSha: "b7e6d5c4b3a291807f6e5d4c3b2a1908f7e6d5c4",
  newerSha: "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00",
} as const;

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const PROJECT = "prj_store";
const PRODUCTION = "env_store_prod";
const WEB = "svc_web";

function preview(fields: Partial<Preview> & Pick<Preview, "id" | "pr_number">): Preview {
  const now = Date.now();
  return {
    project_id: PROJECT,
    environment_id: null,
    environment_slug: null,
    repo_full_name: "acme/storefront",
    pr_url: `https://github.com/acme/storefront/pull/${fields.pr_number}`,
    title: `PR ${fields.pr_number}`,
    head_ref: "main",
    head_sha: PREVIEW_SEED.activeSha,
    head_repo_full_name: "acme/storefront",
    is_fork: false,
    withheld: false,
    author_login: "grace",
    author_association: "MEMBER",
    draft: false,
    status: "active",
    approved_sha: null,
    approved_by_login: null,
    last_activity_at: now - HOUR,
    expires_at: null,
    closed_at: null,
    error: null,
    services: [],
    created_at: now - DAY,
    updated_at: now - HOUR,
    ...fields,
  };
}

/**
 * Default settings of a project that never saved any.
 *
 * @returns Unconfigured, disabled settings.
 */
export function defaultPreviewSettings(): DbPreviewSettings {
  return {
    configured: false,
    enabled: false,
    base_environment_id: null,
    services: null,
    ttl_hours: PREVIEW_LIMITS.ttlHours.default,
    max_active: PREVIEW_LIMITS.maxActive.default,
    caps: { ...DEFAULT_PREVIEW_CAPS },
    skip_drafts: true,
    same_repo_secrets: "copy",
    fork_policy: "disabled",
    approval_label: DEFAULT_PREVIEW_APPROVAL_LABEL,
    database_seed: "empty",
    node_selector: {},
    build_node_selector: {},
    comment: true,
    updated_at: null,
  };
}

/**
 * Adds PR #42's preview environment `pr-42` to the Phase 1 tables, with `web`
 * variables where `SESSION_SECRET` was withheld.
 *
 * @param deploy - Seeded Phase 1 tables; the rows are pushed into them.
 * @param now - Reference time.
 */
export function addPreviewEnvironment(deploy: DeployDb, now = Date.now()): void {
  deploy.environments.push({
    id: PREVIEW_SEED.environment,
    project_id: PROJECT,
    name: "pr-42",
    slug: "pr-42",
    kind: "preview",
    pr_number: 42,
    source_branch: "feat/faster-checkout",
    protected: false,
    preview_id: PREVIEW_SEED.active,
    created_at: now - 2 * DAY,
  });
  const variable = {
    scope: "service" as const,
    owner_id: WEB,
    environment_id: PREVIEW_SEED.environment,
    locked: false,
    available_at_build: false,
    mount_as_file: false,
    version: 1,
    updated_at: now - 2 * DAY,
    updated_by: null,
  };
  deploy.variables.push(
    { ...variable, key: "NODE_ENV", value: "production", tier: "plain" },
    { ...variable, key: "SESSION_SECRET", value: "", tier: "secret", withheld: true },
  );
}

/**
 * Builds the preview tables.
 *
 * @param now - Reference time.
 * @returns The preview tables.
 */
export function seedPreviews(now = Date.now()): PreviewsDb {
  return {
    settings: {
      [PROJECT]: {
        ...defaultPreviewSettings(),
        configured: true,
        enabled: true,
        base_environment_id: PRODUCTION,
        fork_policy: "approval",
        build_node_selector: { pool: "untrusted" },
        updated_at: now - 3 * DAY,
      },
    },
    previews: [
      preview({
        id: PREVIEW_SEED.active,
        pr_number: 42,
        title: "Faster checkout",
        head_ref: "feat/faster-checkout",
        environment_id: PREVIEW_SEED.environment,
        environment_slug: "pr-42",
        expires_at: now + 2 * DAY + HOUR,
        services: [
          {
            service_id: WEB,
            slug: "web",
            name: "web",
            url: "https://pr-42-web.preview.example.com",
            deployment_id: "dep_web_pr42",
            status: "active",
            commit_sha: PREVIEW_SEED.activeSha,
          },
        ],
      }),
      preview({
        id: PREVIEW_SEED.pending,
        pr_number: 57,
        title: "Add gift cards",
        head_ref: "gift-cards",
        head_sha: PREVIEW_SEED.pendingSha,
        head_repo_full_name: "mallory/storefront",
        is_fork: true,
        withheld: true,
        author_login: "mallory",
        author_association: "CONTRIBUTOR",
        status: "pending_approval",
        last_activity_at: now - 2 * HOUR,
      }),
      preview({
        id: PREVIEW_SEED.forkDisabled,
        pr_number: 61,
        title: "Typo in footer",
        head_ref: "patch-1",
        head_sha: PREVIEW_SEED.pendingSha,
        head_repo_full_name: null,
        is_fork: true,
        withheld: true,
        author_login: "ghost",
        author_association: "NONE",
        status: "fork_disabled",
        last_activity_at: now - 3 * HOUR,
      }),
      preview({
        id: PREVIEW_SEED.closed,
        pr_number: 30,
        title: "Old experiment",
        status: "closed",
        closed_at: now - 5 * DAY,
        last_activity_at: now - 5 * DAY,
      }),
    ],
    pullRequestEventsSeen: true,
  };
}

/**
 * Empty preview tables, for a fresh install.
 *
 * @returns Tables with no rows.
 */
export function emptyPreviews(): PreviewsDb {
  return { settings: {}, previews: [], pullRequestEventsSeen: false };
}
