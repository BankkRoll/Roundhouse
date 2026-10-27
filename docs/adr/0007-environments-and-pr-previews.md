# 0007: Environments and PR preview environments

## Status

Proposed.
- Date: 2026-10-22
- Phase: 3
- Protocol: no change
- Depends on: 0003 (GitHub App, webhook, builds), 0004 (database templates,
  restore into a new service), 0005 (node selectors, isolation), 0006
  (change sets).

Names follow the Roundhouse rename (0013, "Naming").

## Context

Environments exist, `production | staging | preview`. Each has its own
Docker network (0003) and, with 0005, its own isolation set across nodes.
`POST /v1/projects/{id}/environments` can copy configs and variables from
another environment. `environments` already has `pr_number` and
`source_branch`. Missing:
- a proper clone that handles volumes and database credentials;
- a diff between environments;
- promotion of a tested change, its exact image included, into
  production;
- deletion;
- automatic per-PR environments.

The GitHub App already requests `pull_requests: write` and
`statuses: write` (`apps/api/src/lib/github.ts`), but it subscribes only
to `installation` and `push`. Webhook deliveries are deduplicated by
`X-GitHub-Delivery` in `github_deliveries`.

GitHub facts (sources at the end):
- **`pull_request` actions** include `opened`, `reopened`, `synchronize`
  (head branch updated), `closed` (merged or not, see
  `pull_request.merged`), `ready_for_review`, `converted_to_draft`,
  `labeled` and `edited`.
- **Payload fields:** `number`, `draft`, `head.sha`, `head.ref`,
  `head.repo.full_name`, `head.repo.fork`, `base.ref`, `base.repo`,
  `user`, `author_association`, and `sender`.
- **Permissions.** Subscribing needs the "Pull requests" read permission.
  Comments are created and updated through the Issues comments API, with
  "Issues" or "Pull requests" write.
- **Delivery.** A 2xx must be returned within 10 s, and failed deliveries
  are not redelivered automatically.
- **Fork PRs.** GitHub Actions withholds secrets from workflows triggered
  by fork PRs, and warns against running untrusted fork code with secrets
  (`pull_request_target`). The same rule applies to any system that builds
  fork code.

## Decision

### Environment lifecycle

**Create and clone.** The body of `POST /v1/projects/{projectId}/environments`
is extended. `copy_from_environment_id` stays as an alias for
`clone.from_environment_id`.

```ts
clone?: {
  from_environment_id: string;
  variables: "all" | "non_secret" | "none";      // default "all"
  volumes: "empty" | "latest_backup";            // default "empty"
  services?: string[];                           // default: every live service
}
```

The clone is built as a change set (0006, `source: "promote"` with
`source_ref` = the source environment) and applied right away. Applying
it creates:
- **Configs.** The latest config version of each service, as version 1 in
  the new environment.
- **Variables**, per `variables`. Exception: the credential variables of
  database templates (0004) are never copied. They are generated fresh,
  because the clone gets a new, empty volume and the image applies
  credentials only at initialisation. References such as
  `${{db.DATABASE_URL}}` therefore resolve to the clone's own database.
- **Volumes.** New volumes of the same size. With `latest_backup`, each
  database service is then restored from its source's latest successful
  backup (0004, restore into the clone's service). Generic volumes are
  created empty.
- **Domains.** Only generated domains, new ones. Custom domains, TCP
  proxies and backup policies are not cloned.
- **Cron.** Cron schedules start paused (0010).

`environments.net_tag` (0005) is assigned on creation, as for every
environment.

**Delete.** `DELETE /v1/environments/{environmentId}` refuses
`kind: "production"`. In one batch it:
- marks every live deployment `removed`;
- sets volumes to `pending_deletion` (72 h grace, 0004);
- deletes domains;
- closes any linked preview.

It then refreshes the affected nodes.

**Diff.** `GET /v1/projects/{projectId}/environments/diff?base=&target=`:

```ts
{
  services: {
    service_id: string; slug: string;
    presence: "both" | "only_base" | "only_target";
    config: DiffEntry[];                 // 0006 DiffEntry, JSON pointers into ServiceConfigSpec
    variables: { key: string; change: "added" | "removed" | "changed" | "same"; secret: boolean }[];
    image: { base: string | null; target: string | null };   // active deployment images (digests)
  }[];
  shared_variables: { key; change; secret }[];
}
```

Secret values are compared by HMAC digest (0006), never decrypted for a
diff. Paths that differ by design are left out:
`networking.generated_domain`, `placement.node_selector`, and template
credential variables.

**Promote.** `POST /v1/environments/{targetEnvironmentId}/promote`:

```ts
{ from_environment_id: string;
  services: string[] | "all";
  include: { config: boolean; variables: "none" | "non_secret" | "all"; image: boolean } }
```

The response is a **change set** in the target environment (`source:
"promote"`). It is never applied by the promote call. It contains:
- `config.patch` ops for the config differences;
- `variable.set`/`variable.delete` ops per `include.variables`;
- with `include.image`, a `deployment.promote { service_id,
  from_deployment_id }` op per service whose source environment has an
  `active` deployment.

Applying `deployment.promote` creates a target deployment with the source
deployment's image **digest**. It does not rebuild (`trigger: "promote"`,
`build_id` copied for traceability) and runs with the target's post-apply
config version. Production can therefore run exactly the bytes that
passed staging. Protected environments (0006) need approval before apply.
`DEPLOYMENT_TRIGGERS` gains `promote`.

### PR previews

#### Settings

```sql
CREATE TABLE preview_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  base_environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  services TEXT,                          -- JSON string[] | null = every git service of the base env
  ttl_hours INTEGER NOT NULL DEFAULT 72,  -- 1..720, since last activity
  max_active INTEGER NOT NULL DEFAULT 5,  -- 1..50
  caps TEXT NOT NULL,                     -- JSON {replicas:1, cpu_millis:1000, memory_mb:1024, volume_mb:1024}
  skip_drafts INTEGER NOT NULL DEFAULT 1,
  same_repo_secrets TEXT NOT NULL DEFAULT 'copy',   -- copy | omit
  fork_policy TEXT NOT NULL DEFAULT 'disabled',     -- disabled | approval
  approval_label TEXT NOT NULL DEFAULT 'roundhouse:preview',
  database_seed TEXT NOT NULL DEFAULT 'empty',      -- empty | latest_backup (never for forks)
  node_selector TEXT NOT NULL DEFAULT '{}',         -- merged into every preview service's placement
  build_node_selector TEXT NOT NULL DEFAULT '{}',   -- builder nodes for fork builds
  comment INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE preview_environments (
  id TEXT PRIMARY KEY,                    -- prv_…
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  repo_full_name TEXT NOT NULL, pr_number INTEGER NOT NULL,
  head_ref TEXT NOT NULL, head_sha TEXT NOT NULL,
  head_repo_full_name TEXT,               -- null when the fork was deleted
  is_fork INTEGER NOT NULL,
  author_login TEXT NOT NULL, author_association TEXT NOT NULL,
  status TEXT NOT NULL,   -- pending_approval | fork_disabled | queued_limit | creating | active
                          -- | failed | expired | closed
  approved_sha TEXT, approved_by_login TEXT,
  github_comment_id INTEGER,
  last_event_at INTEGER NOT NULL,         -- pull_request.updated_at of the last applied event
  last_activity_at INTEGER NOT NULL, expires_at INTEGER,
  closed_at INTEGER, error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX preview_environments_pr_uq ON preview_environments(project_id, repo_full_name, pr_number);
CREATE INDEX preview_environments_expiry_idx ON preview_environments(expires_at) WHERE status = 'active';
ALTER TABLE environments ADD COLUMN preview_id TEXT REFERENCES preview_environments(id) ON DELETE SET NULL;
```

#### Webhook intake

- `GITHUB_APP_EVENTS` gains `pull_request`.
- The webhook route already verifies `X-Hub-Signature-256` in constant
  time and deduplicates deliveries. For `pull_request` it matches
  projects, enqueues `{ kind: "preview_event", delivery_id, project_id }`
  on `JOBS` with the payload fields it needs (≤ 4 KiB, never the whole
  payload), and returns 202 well inside GitHub's 10 s.
- **Matching.** A project matches when previews are enabled and at least
  one service in scope has a `GitSource` whose normalized `repo_url`
  equals `base.repo.clone_url` and whose `branch` equals `base.ref`. The
  `github_installation_id` must belong to the delivering installation.
- **Ordering.** The consumer starts `PREVIEW_WORKFLOW` with instance ID
  `prv-<project_id>-<pr_number>-<delivery_id>`. The workflow takes a
  per-PR order key: an event is applied only if
  `pull_request.updated_at >= last_event_at`. Older events are dropped as
  stale, which covers out-of-order deliveries.

| Action                                   | Effect                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `opened`, `reopened`, `ready_for_review` | Upsert the preview. Drafts are ignored while `skip_drafts`. Then **gate** (below), then **create**                                                                                                                             |
| `synchronize`                            | Update `head_sha` and `last_activity_at`. Gate, then **deploy** git services at `head.sha`, cancelling in-flight preview deployments of the old SHA                                                                            |
| `labeled` with `approval_label`          | If `sender`'s `permission` from `GET /repos/{o}/{r}/collaborators/{sender}/permission` is `write` or `admin` (GitHub maps `maintain` to `write`), set `approved_sha = head.sha` and `approved_by_login`. Then create or deploy |
| `converted_to_draft`                     | With `skip_drafts`: delete the environment, status `closed`, until `ready_for_review`                                                                                                                                          |
| `edited` with a changed `base.ref`       | Close if the new base is not tracked; else nothing                                                                                                                                                                             |
| `closed`                                 | Delete the environment (merged or not), status `closed`, update the comment                                                                                                                                                    |

**Gate.**
- Same-repo PRs (`head.repo.full_name == base.repo.full_name`) pass.
- Fork PRs, and PRs whose `head.repo` is null, are treated as forks:
  - `fork_policy: "disabled"`: status `fork_disabled` and a comment that
    explains it.
  - `fork_policy: "approval"`: they pass only when
    `approved_sha == head.sha`. On every `synchronize` from a fork, the
    approval lapses. The control plane removes the label
    (`DELETE /repos/{o}/{r}/issues/{n}/labels/{label}`), sets
    `pending_approval`, and comments that the new commits need approval.

**Create.**
1. **Count.** If `max_active` previews are already `creating` or `active`,
   set `queued_limit` and comment. The minute tick promotes the oldest
   `queued_limit` preview whenever a slot frees.
2. **Environment.** Create `kind: "preview"`, `slug: "pr-<n>"`,
   `pr_number`, `source_branch = head.ref`, `preview_id`, through a
   system change set (`source: "preview"`) cloned from
   `base_environment_id` with these overrides:
   - **Git services in scope** deploy `head.sha` from the **base**
     repository URL. The builder fetches exactly that commit, and GitHub
     serves fork PR commits from the base repository (`refs/pull/<n>/head`),
     so fork code is fetched with the base installation's token, minted
     narrowed to `{ repositories: [repo], permissions: { contents: "read" } }`.
   - **Image services** are cloned as-is.
   - **Database templates** get new services with fresh credentials and
     an empty volume. `latest_backup` seeding applies only to same-repo
     PRs; **forks always get empty databases**.
   - **Caps.** `replicas = min(r, caps.replicas)`; CPU and memory are
     clamped; volume `size_mb` is clamped to `caps.volume_mb`; TCP
     proxies, custom domains and backup policies are dropped; cron
     schedules are paused; `placement.node_selector` is merged with
     `node_selector`.
   - **Variables**: see "Secrets".
3. **Deploy and report.** Apply with `deploy: "affected"`, set
   `expires_at = now + ttl`, and upsert the comment and commit status.

**Deploy on `synchronize`.** A system change set in the preview
environment carrying a `config.patch` for nothing but the git services'
target commit. Deployments use `trigger: "push"` with `commit_sha`. The
cancel of superseded preview builds reuses `build_cancel`.

**Expiry.** The minute tick deletes `active` previews past `expires_at`
(status `expired`, comment updated). A later `synchronize` or `reopened`
recreates the preview.

#### Secrets

This is the rule the whole feature is built around: **a preview built
from a fork never receives a secret that exists outside that preview.**
- **Same-repo PRs** (`same_repo_secrets: "copy"`, the default): variables
  are cloned as in a normal clone. Their authors already have write access
  to the repository and its deploy pipeline.
- **Fork PRs**, and same-repo PRs when `same_repo_secrets: "omit"`:
  - Every `tier: "secret"` variable (ADR 0014), service and shared, is
    replaced by an empty placeholder marked `withheld: true`. Plain
    variables that resolve through a secret count as secret here too
    (ADR 0014 section 14). References still resolve,
    to `""`, so a deployment doesn't fail on an unknown reference. The
    dashboard shows "withheld from preview".
    `variables.withheld INTEGER NOT NULL DEFAULT 0` is the new column.
  - Secret build args (`secret_build_args`) are withheld the same way.
  - Database credentials are freshly generated for the preview, so they
    are preview-only secrets and allowed.
  - Builds run on builders matching `build_node_selector`, when one is
    set. The dashboard recommends a dedicated builder node for
    `fork_policy: "approval"`, because fork build steps execute untrusted
    code on it.
  - The git token used for the fetch is narrowed to `contents: read` on
    the one repository and expires within an hour (0003). It is never
    exposed to build steps; that is already the builder's guarantee.
- **Withheld status is sticky.** A preview environment created as a fork
  preview keeps `withheld` variables even if the PR later becomes a
  same-repo PR, which cannot happen on GitHub anyway. Changing a withheld
  variable in a preview requires `variables:manage` and is audited.

#### GitHub feedback

- **One comment per (PR, project)**, created with
  `POST /repos/{o}/{r}/issues/{n}/comments` and updated with
  `PATCH /repos/{o}/{r}/issues/comments/{id}`. The body starts with the
  marker `<!-- roundhouse-preview:<project_id> -->`, so a lost
  `github_comment_id` is recovered by listing comments. It holds a table
  of service, status, URL and commit, a "last updated" time, and the
  expiry. It never contains variable values or internal hostnames.
- **Commit status** `roundhouse/preview/<project-slug>` on `head.sha`:
  `pending` → `success`/`failure` with `target_url` = the preview's
  dashboard page.
- `GITHUB_API_URL` (Worker variable, default `https://api.github.com`)
  makes every GitHub call target configurable, for the fake in tests.

### Routes, RBAC, audit

| Method and path                                             | RBAC                                                                   | Audit                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| `POST /v1/projects/{projectId}/environments` (create/clone) | `environments:manage`                                                  | `environment.created` (+ `environment.cloned`) |
| `DELETE /v1/environments/{environmentId}`                   | `environments:manage` (preview: also `previews:manage` if `protected`) | `environment.deleted`                          |
| `GET /v1/projects/{projectId}/environments/diff`            | `projects:read`                                                        | none                                           |
| `POST /v1/environments/{environmentId}/promote`             | `environments:manage`                                                  | `environment.promote_proposed`                 |
| `GET`, `PUT /v1/projects/{projectId}/preview-settings`      | `projects:read` / `previews:manage`                                    | `preview.settings_updated`                     |
| `GET /v1/projects/{projectId}/previews`                     | `projects:read`                                                        | none                                           |
| `POST /v1/previews/{previewId}/approve`                     | `previews:manage`                                                      | `preview.approved`                             |
| `POST /v1/previews/{previewId}/redeploy`                    | `deployments:create`                                                   | `deployment.created`                           |
| `DELETE /v1/previews/{previewId}`                           | `environments:manage`                                                  | `preview.deleted`                              |
- `environments:manage` (new) is held by owner, admin and member. It
  replaces `projects:manage` on environment creation, which becomes
  member-level, as staging is day-to-day work. Production can never be
  created or deleted through it.
- `previews:manage` (new) is held by owner and admin.
- System audit actions (actor `system`, or `github` metadata with the
  sender's login): `preview.created`, `preview.gated`, `preview.expired`,
  `preview.closed`.
- `ID_PREFIXES.preview = "prv"`.

Approving in the dashboard (`POST …/approve`) approves the current
`head_sha` exactly like the label does. It also adds the label, so GitHub
shows the decision.

### Dashboard

- **Environment switcher**: Create (blank or clone from, with options),
  Compare (diff view: services × config/variables/image, changed rows
  first), Promote (pick services and parts, then the 0006 review panel),
  Delete (type the slug).
- **Project → Previews**: settings form, and a list of open previews with
  PR link, author, fork badge, status, expiry and Approve / Redeploy /
  Delete.
- **Inside a preview environment**: a banner "Preview for #123 ·
  head `abc1234` · expires in 2 days", with withheld variables marked.

## Security

- **Fork previews are off by default.** With approval on, every new fork
  commit needs a fresh approval by someone with write access, and approval
  pins the exact SHA.
- **No secret crosses into a fork preview:** variables, build args and
  database data are all withheld. The fetch token is read-only, scoped to
  one repository, and short-lived.
- Untrusted builds can be confined to dedicated builder nodes, and preview
  workloads to dedicated nodes, through selectors. 0005 isolation keeps a
  preview from reaching any other environment.
- Webhooks are verified before parsing, deduplicated, and ordered by the
  PR's `updated_at`. The API cannot create or delete a production
  environment.
- Preview caps bound the resources an outside contributor can consume.

## Testing strategy

- **Unit (TS).**
  - Clone planning: template credentials regenerated, cron paused, custom
    domains dropped.
  - Diff with HMAC comparison.
  - Promote op generation.
  - Preview gating, as a table over same-repo, fork, deleted fork, label
    sender permission, and stale SHA.
  - The cap clamp.
  - Stale-event ordering.
- **API** (vitest-pool-workers), with a **fake GitHub API**
  (`apps/api/test/fake-github.ts`, shared with e2e as
  `e2e/lib/fake-github.mjs`). It serves installation tokens, comments,
  statuses, labels and collaborator permissions, from response shapes
  recorded from GitHub's documented examples into
  `e2e/fixtures/github/*.json`. Webhook payload fixtures are adapted from
  GitHub's examples and signed in the test with the instance's webhook
  secret.
- **Real-stack e2e** (`e2e/phase3/previews.test.mjs`). The local HTTPS git
  server gains `refs/pull/<n>/head`, and the stack runs the fake GitHub
  with `GITHUB_API_URL` pointing at it. Nothing needs a GitHub account.
  1. Enable previews for a Next.js + Postgres project.
  2. A signed `pull_request.opened` from the same repository creates
     environment `pr-1`. The app builds at `head.sha`, reaches its own
     fresh Postgres, has the base environment's non-secret and secret
     variables, posts one comment with the URL, and sets a `success`
     commit status.
  3. `synchronize` with a new SHA redeploys, and the comment is updated,
     not duplicated.
  4. A fork PR with `fork_policy: "disabled"` gets status
     `fork_disabled` and no environment. With `approval`: a `labeled`
     event from a `read`-only sender is ignored, and from a `write` sender
     the preview is created.
     - In that preview, `printenv` shows every secret empty and the
       database empty.
     - A further `synchronize` removes the label and sets
       `pending_approval`.
  5. `closed` with `merged: true` deletes the environment, its containers
     and volumes (pending deletion), and updates the comment.
  6. With `max_active: 1`, a second PR is `queued_limit`, and it is
     created when the first closes.
  7. Clone production to staging with `latest_backup`: staging's database
     has production's rows, under its own credentials. Promote
     staging → production with `image: true`: production's new
     deployment has staging's digest and no build.

## How PR previews were built (2026-10-27)

The previews half of this ADR is implemented, with ADR 0014 section 14 on
top. Where the build differs from the text above:
- **No `JOBS` queue.** The webhook starts `PREVIEW_WORKFLOW` directly, one
  instance per delivery and project (`prv-<pr>-<hash>`). Its steps: the
  approver's permission (collaborators API, only for the approval label),
  `apply` (D1 only, ordered by `updated_at`), then label removal, create,
  deploy or teardown, and the comment and status. Dashboard approvals,
  redeploys, the queue and expiry start `action` instances of the same
  workflow.
- **No system change set.** A preview environment is written in one D1
  batch (environment, configs, variables, volumes, the preview link); a
  concurrent create loses on the `pr-<n>` slug and adopts the winner's.
  Generated domains and paused cron states follow idempotently.
- **Teardown keeps the row.** Deleting an environment cascades to its
  volume rows, which the 72 h deletion still needs. Teardown sets
  `environments.retired_at`, renames the slug so `pr-<n>` is free again,
  and hides it from every listing; the minute tick deletes it once its
  volumes are gone. Deployments, domains and cron schedules go at once.
- **Withholding** follows section 14: a variable is withheld when stored
  `secret`, when its value is recognised as a credential (a known format
  or high entropy; a secret-looking name alone doesn't count, since
  `DATABASE_URL = ${{db.DATABASE_URL}}` holds only a reference), or when it
  resolves through one of those. Fresh database credentials never count, so
  references into the preview's own database keep working. The deploy
  workflow blanks every build secret and secret build arg of a withheld
  preview again, and sends a fork build no sealed secrets at all.
- **Builders.** Every preview build carries `build_job.isolation: "preview"`
  (protocol version 7): the agent builds it in `<project>-preview`, a
  daemon and cache of its own, and its cache key differs, so an older agent
  refuses it. Fork code builds only on nodes matching `build_node_selector`
  (required for `fork_policy: approval`) that never built the project's
  other environments; every other build of the project avoids nodes that
  ran its fork code and nodes the selector reserves. Builds record
  `untrusted`. Servers are labelled with
  `PUT /v1/workspaces/{id}/nodes/{nodeId}/labels`, which did not exist.
- **Approval.** `POST …/approve` takes the `head_sha` the approver saw
  (409 `head_moved` otherwise) and records the Roundhouse user's name as
  `approved_by_login`. Bots' labels are ignored; the App's own label
  after a dashboard approval is therefore harmless.
- **Feedback.** The per-deployment commit statuses are not posted in
  preview environments; the aggregated `roundhouse/preview/<project>`
  status and the comment use generic descriptions, never failure reasons.
- **Database seeding.** `database_seed: latest_backup` and a clone's
  `volumes: latest_backup` restore each database from the source's latest
  successful _dump_ through the restore workflow's new-database path, which
  keeps the target's fresh credentials. Snapshots don't qualify (they carry
  the source's passwords). A preview that withholds secrets, every fork
  included, always starts empty; a clone's restore needs `backups:restore`.
- **Environment lifecycle, as built.** Cloning, diff and delete are routes
  of their own (`routes/environments.ts`) on the same copy and retirement
  code previews use, not change sets. `environments:manage` replaces
  `projects:manage` on creation. Delete needs a fresh session and
  `?confirm=<slug>`, `access:manage` for a protected environment, and is
  refused for production and for the base of enabled previews. Promote
  stages `config.patch`, `variable.set`/`delete` and `deployment.promote`
  ops (clients can't stage the latter); applying one creates a deployment
  with `trigger: "promote"`, the source's image by digest and its `build_id`.
- **Public repositories.** A git service without an installation matches PRs
  of its repository too, within the workspace that claimed the delivering
  installation, as push deploys do.
- **Real-stack e2e** is `e2e/phase3/run-previews.mjs` (its own wrangler
  port and `.dev.vars.previews`, a fake GitHub on another port). The
  claim's OAuth step is replaced by an SQL update there; everything else
  runs as in production.
- **`max_active` is hard.** Admission counts the running previews and
  claims the slot in one conditional `UPDATE`, which D1 runs alone.
- Previews never get TCP proxies or credential rotations: both routes
  answer 409 in a preview environment.

## Rollout and compat

- **Protocol 7** adds `build_job.isolation` (ADR 0014 section 14, see "How PR
  previews were built"); pull request builds need agents at 7. The
  migrations are additive.
- **Existing GitHub Apps** must subscribe to `pull_request`. App owners
  change subscribed events in the App's settings, and installations may
  have to accept. The dashboard detects missing deliveries
  (`github_deliveries` never shows `pull_request`) and links to the
  setting. New Apps created by the manifest flow include it.
- **`copy_from_environment_id`** keeps working as an alias for one
  release.

## Consequences

- Teams get Railway-style previews without exposing secrets to outside
  contributors. Fork previews are deliberately less capable.
- Previews multiply resource use. Caps, `max_active`, TTL and node
  selectors are the controls, and the cost estimator (0012) shows preview
  spend separately.

## Open questions

- Should `/roundhouse` slash-command comments (redeploy, approve) be
  supported in addition to labels? That needs `issue_comment` events and
  more parsing surface. Labels are enough for now.
- Should previews be allowed for repositories outside the base repo, such
  as a monorepo's other services from other repos? Not in Phase 3.
- Confirm that a narrowed installation token with `contents: read` can
  shallow-fetch an unadvertised fork-PR commit SHA from the base
  repository on GitHub.com. The builder fetches by SHA. GitHub documents
  `refs/pull/<n>/head`, but not SHA-in-want for it. The fallback is to
  fetch `refs/pull/<n>/head` and verify the SHA.

## Sources

- `pull_request` webhook actions and payload, https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request (retrieved 2026-10-22)
- Webhook best practices (10 s, no automatic redelivery), https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks (retrieved 2026-10-22)
- Collaborator permission endpoint (`admin`/`write`/`read`/`none`; maintain maps to write), https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user (retrieved 2026-10-22)
- Issue comments API (create/update; Issues or Pull requests write; REST version 2026-03-10), https://docs.github.com/en/rest/issues/comments (retrieved 2026-10-22)
- GitHub App permissions for statuses, deployments, checks, https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps (retrieved 2026-10-22)
- Secrets withheld from fork-triggered workflows; `pull_request_target` cautions, https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows and https://docs.github.com/en/actions/reference/security/secure-use (retrieved 2026-10-22)
