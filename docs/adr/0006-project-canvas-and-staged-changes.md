# 0006: Project canvas and staged changes

## Status

Proposed.

- Date: 2026-10-22
- Phase: 2
- Depends on: 0003. Used by 0004 (adding a database), 0007 (promote), and
  0012 (MCP, templates).

Names follow the Roundhouse rename: `roundhouse.*` labels, `ROUNDHOUSE_*`
built-ins. See 0013, "Naming".

## Context

Phase 1 edits are immediate. `PATCH /v1/services/{id}` inserts config
version N+1, `PUT .../variables` rewrites variables, and a deploy is a
separate click. That leaves three gaps:

- A real change touches several services at once: add a database, point
  `api` at it, raise `worker` replicas. Each edit lands, and may deploy, on
  its own, so the project passes through states nobody intended.
- Nobody can review a change before it ships, and two people editing the
  same service overwrite each other. `expected_version` exists on the API,
  but the dashboard gives no way to resolve the conflict it reports.
- Templates (0012), promotion (0007) and MCP clients (0012) all need to
  *propose* a change for a human to accept. Without a first-class proposal
  object, each would invent its own.

The project page is a list today. Railway-style projects are read as a
graph: which service talks to which. The graph is already derivable,
because `variableDependencies` in `packages/shared/src/variables.ts` turns
`${{db.DATABASE_URL}}` references into service edges.

## Decision

### Canvas data model

**Nodes** are the project's live services. **Positions** are per project,
not per environment, so the same service sits in the same place in every
environment. Positions are cosmetic, so they are not staged and not
versioned per edit.

```sql
CREATE TABLE canvas_layouts (
  project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  positions   TEXT NOT NULL,        -- JSON {"svc_…": {"x": int, "y": int}}
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

**Edges** come from two sources:

- `kind: "reference"` edges are derived on read from
  `variableDependencies(...)` over the environment's *current* variables,
  plus any staged ones (rendered dashed while staged). They are never
  stored.
- `kind: "explicit"` edges come from the "connects to" action. They cover
  dependencies that no variable expresses, such as a hard-coded URL or a
  queue. They are stored per project:

```sql
CREATE TABLE service_edges (
  id               TEXT PRIMARY KEY,                 -- edg_…
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_service_id  TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  to_service_id    TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK (from_service_id <> to_service_id)
);
CREATE UNIQUE INDEX service_edges_pair_uq ON service_edges(from_service_id, to_service_id);
```

Explicit edges are display data and template data (0012). They do not
change networking: every service of an environment can already reach every
other one (0005).

New ID prefixes: `edg` (edge), `chs` (change set), `stg` (staged change).

### Staged changes

A **change set** is a reviewable batch of operations against one
environment. A **staged change** is one operation in it, holding its diff.

```sql
CREATE TABLE change_sets (
  id              TEXT PRIMARY KEY,                  -- chs_…
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id  TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,       -- open | applying | applied | discarded | failed
  is_draft        INTEGER NOT NULL DEFAULT 0,  -- the environment's shared dashboard draft
  source          TEXT NOT NULL,       -- dashboard | api | mcp | template | promote | preview
  source_ref      TEXT,                -- template id, source environment id, token id
  title           TEXT,
  revision        INTEGER NOT NULL DEFAULT 1,  -- bumped on every op change
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_token TEXT REFERENCES api_tokens(id) ON DELETE SET NULL,
  approved_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at     INTEGER,
  applied_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  applied_at      INTEGER,
  error           TEXT,                -- JSON {code, message, details}
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- One shared draft per environment; other sets (templates, MCP, promote) are separate.
CREATE UNIQUE INDEX change_sets_draft_uq ON change_sets(environment_id)
  WHERE status = 'open' AND is_draft = 1;
CREATE INDEX change_sets_env_status_idx ON change_sets(environment_id, status, id);

CREATE TABLE staged_changes (
  id             TEXT PRIMARY KEY,                   -- stg_…
  change_set_id  TEXT NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,     -- apply order
  target_key     TEXT NOT NULL,        -- coalescing key, see below
  op             TEXT NOT NULL,        -- JSON StagedOp; secret values sealed
  base           TEXT NOT NULL,        -- JSON versions the op was staged against
  diff           TEXT NOT NULL,        -- JSON DiffEntry[] for display
  status         TEXT NOT NULL,        -- pending | conflicted | applied
  conflict       TEXT,                 -- JSON, when conflicted
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX staged_changes_target_uq ON staged_changes(change_set_id, target_key);

ALTER TABLE deployments ADD COLUMN change_set_id TEXT REFERENCES change_sets(id) ON DELETE SET NULL;
ALTER TABLE environments ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;
```

`DEPLOYMENT_TRIGGERS` gains `change_set`.

#### Operations

`packages/shared/src/changes.ts` holds the zod schema `StagedOpSchema`, a
discriminated union on `type`. The API, dashboard, MCP server and template
renderer all import it. Services created in the same set are addressed by
`ref`, a `new:<n>` temporary reference that resolves at apply time.

| `type`                 | Fields                                                                                                                | `target_key`                   | RBAC action         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------- |
| `service.create`       | `ref`, `name`, `slug?`, `kind`, `icon?`, `source`, `config?` (ServiceConfigPatch), `database?` (0004 template engine) | `create:<ref>`                 | `services:manage`   |
| `service.update`       | `service_id`, `name?`, `slug?`, `icon?`                                                                               | `service:<id>`                 | `services:manage`   |
| `service.delete`       | `service_id`                                                                                                          | `service:<id>`                 | `services:manage`   |
| `config.patch`         | `service` (id or ref), `patch` (ServiceConfigPatch)                                                                   | `config:<svc>`                 | `services:manage`   |
| `variable.set`         | `scope`, `service?`, `key`, `value` (sealed), `is_secret`                                                             | `var:<svc\|shared>:<KEY>`      | `variables:manage`  |
| `variable.delete`      | `scope`, `service?`, `key`                                                                                            | `var:<svc\|shared>:<KEY>`      | `variables:manage`  |
| `volume.set`           | `service`, `mount_path`, `size_mb` (0004)                                                                             | `volume:<svc>`                 | `services:manage`   |
| `volume.delete`        | `service`                                                                                                             | `volume:<svc>`                 | `services:manage`   |
| `domain.add`           | `service`, `hostname`, `target_port` (0009)                                                                           | `domain:<hostname>`            | `domains:manage`    |
| `domain.remove`        | `domain_id`                                                                                                           | `domain:<hostname>`            | `domains:manage`    |
| `tcp_proxy.set`        | `service`, `container_port`, `enabled` (0004)                                                                         | `tcp:<svc>:<port>`             | `services:manage`   |
| `backup_policy.set`    | `service`, policy fields (0004)                                                                                       | `backup:<svc>`                 | `backups:manage`    |
| `deployment.promote`   | `service_id`, `from_deployment_id` (0007)                                                                             | `promote:<svc>`                | `deployments:create`|

Staging an op whose `target_key` already exists in the set **coalesces**:
`config.patch` patches deep-merge, the newer one winning per JSON pointer,
and every other op replaces the older one. A `service.delete` drops the
service's other ops from the set. Staging `variable.set` after a staged
`variable.delete` of the same key replaces it. A set holds at most
`MAX_STAGED_OPS = 100` ops.

`base` records what the op was staged against:
`{ "config_version": 7 }` for config, `{ "variable_version": 3 }` or
`{ "variable_version": null }` (absent) for variables, and
`{ "service_updated_at": <ms> }` for service metadata.

`diff` is a list of `{ path, before, after }` entries, where `path` is a JSON
pointer such as `/deploy/replicas` or `/variables/DATABASE_URL`, computed when
the op is staged. Secret variable values are never in `diff`. The entry is
`{ path, before: { secret: true, set: bool }, after: { secret: true, changed: bool } }`,
and `changed` comes from comparing HMAC-SHA256 digests under a key derived
from the project DEK (purpose `variable-digest`), so nothing is decrypted
for display. Staged values are sealed under the project DEK with AAD
`staged:<stg_id>`. Responses show them only as the masked form, and
`POST /v1/change-sets/{id}/reveal` (needs `variables:reveal`, audited as
`variables.revealed`) shows them in plaintext.

#### Conflicts

Direct edits (`PATCH /v1/services/{id}`, `PUT .../variables`, CLI, CI) stay
and keep working. They advance versions, which is how a staged op ends up
stale. Apply and the explicit `rebase` route check every op:

1. **No drift**: the current version equals `base`. The op applies as is.
2. **Drift that merges**: for `config.patch`, compute the pointers the
   concurrent change touched, `diff(config@base, config@current)`. If they
   don't intersect the op's pointers, rewrite `base` to current and
   continue.
3. **Real conflict**: the same pointer or variable changed on both sides,
   or the target was deleted. The op becomes `conflicted` with
   `conflict = { theirs: <current value or masked>, base_version, current_version }`.
   Apply refuses with `409 change_set_conflict` and lists every conflicted op.

`POST /v1/change-sets/{id}/ops/{opId}/resolve { "keep": "mine" | "theirs" }`
settles a conflict. `mine` rebases the op onto the current version and keeps
its values. `theirs` drops the op. Both bump `revision`.

#### Apply

`POST /v1/change-sets/{id}/apply { expected_revision, deploy: "affected" | "none" }`
runs `planApply` (pure, in `packages/shared/src/changes.ts`, unit-tested)
and then commits:

1. **Lock.** `UPDATE change_sets SET status='applying', revision=revision+1
   WHERE id=? AND status='open' AND revision=?`. If no row changes, the
   result is `409 change_set_changed`: someone edited the set after the
   caller reviewed it.
2. **Authorize.** The caller must hold every op's action, checked with
   `can(role, action)`. A token must also carry each action as a scope. If
   the environment is `protected`, the set also needs `approved_by` to be
   set, to someone other than the last op author and other than the
   applier. Approval is `POST /v1/change-sets/{id}/approve`, which needs
   `changes:approve` (admin and above).
3. **Rebase.** Run the conflict check above. Any conflict reverts the set
   to `open` and returns 409.
4. **Validate the result**, not the ops: build the post-apply model
   (services, latest configs, variables) in memory and check slug
   uniqueness, `resolveVariables` for every affected service (unknown
   references and cycles are `422 invalid_references` with
   `VariableError[]`), 0004's volume rules (one replica, recreate
   strategy), 0007's preview caps, and limits.
5. **Commit** with one `db.batch()`, which D1 runs as a single transaction.
   The batch holds the service inserts and updates, config versions N+1
   (one per changed service, all parts in one row), variable writes with
   bumped `version`, volume, domain and edge rows, the new
   `deployments(status='queued', trigger='change_set', change_set_id)` rows,
   every staged change set to `applied`, the set set to `applied`, and the
   audit rows. If the batch fails, a second statement returns the set to
   `open` with `error`.
6. **Start pipelines.** After commit, create a `DEPLOY_WORKFLOW` instance
   per deployment, using the deployment ID as the instance ID. An instance
   that already exists is not an error. If the Worker dies between commit
   and here, the minute tick (0004, "Scheduled dispatch") starts every
   `queued` deployment older than 60 s that has no
   `workflow_instance_id`.

`deploy: "affected"`, the default, deploys:

- every service whose config, own variables or volume changed;
- every service whose *resolved* environment changes because a variable it
  references changed. This is computed with `variableDependencies` over the
  post-apply model.

Database services created in the set deploy before the services that
reference them. The workflows run concurrently anyway; ordering only means
the dependency's workflow is started first. `deploy: "none"` writes
versions without deploying, as `PATCH` does today.

Applying is all-or-nothing in D1. Deployments then succeed or fail
individually, as in 0003. A failed deployment does not undo the applied
config. The service keeps serving its previous deployment, and the
dashboard links the set to its deployments.

#### Routes

All routes go in `apps/api/src/contracts.ts` under a new
`// Change sets` section.

| Method and path                                          | RBAC action                         | Audit                               |
| -------------------------------------------------------- | ----------------------------------- | ----------------------------------- |
| `GET /v1/projects/{projectId}/canvas?environment_id=`    | `projects:read`                     | none                                |
| `PATCH /v1/projects/{projectId}/canvas/layout`           | `services:manage`                   | none (cosmetic, see below)          |
| `POST /v1/projects/{projectId}/edges`                    | `services:manage`                   | `canvas.edge_added`                 |
| `DELETE /v1/projects/{projectId}/edges/{edgeId}`         | `services:manage`                   | `canvas.edge_removed`               |
| `GET /v1/environments/{environmentId}/change-sets`       | `projects:read`                     | none                                |
| `POST /v1/environments/{environmentId}/change-sets`      | `services:manage`                   | `change_set.created`                |
| `GET /v1/environments/{environmentId}/draft`             | `projects:read`                     | none                                |
| `POST /v1/environments/{environmentId}/draft/ops`        | each op's action                    | none (the apply is audited)         |
| `GET /v1/change-sets/{changeSetId}`                      | `projects:read`                     | none                                |
| `POST /v1/change-sets/{changeSetId}/ops`                 | each op's action                    | none                                |
| `DELETE /v1/change-sets/{changeSetId}/ops/{opId}`        | `services:manage`                   | none                                |
| `POST /v1/change-sets/{changeSetId}/ops/{opId}/resolve`  | the op's action                     | none                                |
| `POST /v1/change-sets/{changeSetId}/rebase`              | `services:manage`                   | none                                |
| `POST /v1/change-sets/{changeSetId}/approve`             | `changes:approve`                   | `change_set.approved`               |
| `POST /v1/change-sets/{changeSetId}/apply`               | every op's action                   | `change_set.applied` + per-op¹      |
| `POST /v1/change-sets/{changeSetId}/discard`             | `services:manage`                   | `change_set.discarded`              |
| `POST /v1/change-sets/{changeSetId}/reveal`              | `variables:reveal`                  | `variables.revealed`                |
| `PATCH /v1/environments/{environmentId}` `{protected}`   | `projects:manage`                   | `environment.updated`               |

¹ The existing per-resource audit actions: `service.created`,
`service.updated`, `service.deleted`, `variables.updated`,
`deployment.created`. Each carries `change_set_id` in `metadata`, so the
audit log reads as one batch.

Mutating op routes take `expected_revision`, and a stale value gets `409
change_set_changed` with the current revision, so a client editing an old
view refetches first. Layout writes are excluded from the audit log on
purpose. They are cosmetic and fire on every drag, and the audit log
records changes to what runs.

New RBAC actions:

- `changes:approve`: owner and admin.
- `changes:auto_apply`: owner, admin and member. It lets an API token apply
  a set it created without a human; see 0012. A browser session never
  needs it.

New audit actions: `change_set.created`, `change_set.approved`,
`change_set.applied`, `change_set.discarded`, `canvas.edge_added`,
`canvas.edge_removed` and `environment.updated`.

#### Realtime and multiplayer

`ProjectRoom` already fans out `service.updated` and `presence`. It gains
the following, with schemas in `apps/api/src/schemas.ts`.

Server → browser:

- `change_set.updated { change_set: ChangeSetSummary }`: id, status,
  revision, op count, conflicted count, and the ops' masked diffs. Sent
  after every op mutation, rebase, approve and apply.
- `change_set.applied { change_set_id, deployment_ids: string[] }`.
- `canvas.layout_updated { positions, version, by_user_id }`.
- `presence { users: PresenceUser[] }`, where `PresenceUser` gains
  `environment_id`, `selection: string[]` (service IDs, at most 32),
  `editing: { service_id, part } | null`, and a stable `color` index
  (0–11) derived from the user ID.

Browser → server:

- `presence.update { environment_id, selection, editing }`. The room keeps
  only the latest per socket, accepts at most 10 per second per socket
  (extras are dropped), and broadcasts presence at most every 100 ms.

There are no locks. Two people can edit the same field. The second edit to
reach a staged op coalesces over the first, and the realtime update shows
who did it. Edits through different paths, staged and direct, meet in the
conflict check. The draft is shared, so a collaborator's staged edit is
visible in everyone's review panel within one broadcast.

### Dashboard

React Flow, `@xyflow/react` 12.x (MIT), in
`apps/web/src/features/canvas/`.

- **Layout.** The canvas is the project page's main view, and the existing
  service list is a toggle with full parity: every action on the canvas
  can be done from the list. Clicking a node opens the service drawer
  (settings, variables, deployments, logs). Edits in the drawer stage into
  the environment draft instead of saving immediately. Whether the old
  "save now" behaviour stays available is settled below.
- **Staged bar.** A bottom bar reads "N staged changes · Review · Discard".
  Review opens a panel with a per-service grouped diff table (`path`,
  before, after; secrets shown as "changed"), the conflicted ops, each
  with Keep mine / Take theirs, and the services that will deploy. The
  Apply button is disabled while any op is conflicted or, on a protected
  environment, until the set is approved.
- **Presence.** Avatars sit in the header. Other users' selections show as
  coloured node outlines, and an "Ada is editing variables" badge appears
  on the node.
- **Performance.** These follow React Flow's performance guide.
  - Custom node and edge types are declared at module level and wrapped in
    `React.memo`.
  - `data` carries only `serviceId`. Each node reads its status through a
    selector on the TanStack Query cache, so a deployment update re-renders
    one node, not the graph.
  - No component depends on the full `nodes` array, and selection is kept
    in a separate store.
  - `onlyRenderVisibleElements` is on above 150 services.
  - Positions persist on `onNodeDragStop`, debounced by 500 ms and sent with
    `expected_version`. A `409` refetches and keeps the local position.
  - A service without a stored position is placed by a deterministic
    layered layout: depth from edges times 320 px across, index times
    160 px down. This needs no layout library.
- **Accessibility.** These use React Flow's built-in support.
  - `nodesFocusable` and `edgesFocusable` are on. Tab moves between nodes,
    Enter opens the drawer, arrow keys move the focused node (persisted like
    a drag), and Escape clears the selection.
  - `ariaLabelConfig` carries localised strings.
  - Each node has an `aria-label` such as "api, app service, active, 2
    replicas, 1 staged change".
  - Status is never shown by colour alone; an icon and text accompany it.
  - Deployment status changes are announced in a polite live region,
    coalesced to one announcement per 2 s.
  - Edges don't animate under `prefers-reduced-motion`.
  - The list view is the documented alternative for screen-reader users.

## Security

- RBAC is checked against the op, not the route. A member can stage
  variable changes but not approve a protected set. Staging never
  escalates, because apply rechecks every op against the applier's
  current role and the token's scopes.
- On a protected environment, the author cannot approve their own set, and
  the approver cannot also be the applier.
- Staged secret values are sealed at rest with a row-bound AAD, masked in
  every response and realtime frame, and kept out of the audit log. The
  audit log gets keys only, as for `variables.updated` today.
- `expected_revision` on apply means a set is applied exactly as reviewed.
  A change that slips in between review and apply forces another review.
- Presence frames are size-capped and rate-limited per socket, and they
  carry only IDs, never values.

## Testing strategy

- **Unit** (`packages/shared`): op coalescing, the three-way config merge
  (property tests: disjoint pointers always merge, overlapping ones always
  conflict), `planApply` affected-service computation including transitive
  references, and temp-ref resolution.
- **API** (vitest-pool-workers):
  - RBAC per op, approvals on protected environments, and token scopes.
  - A stale `expected_revision`.
  - Atomicity: inject a failing statement into the batch and assert that
    nothing was written and the set is back to `open`.
  - The reconciler starts workflows for orphaned `queued` deployments.
- **Web** (vitest + msw): staged bar, review panel, conflict resolution,
  keyboard moves, and axe checks on the canvas.
- **Real-stack e2e** (`e2e/phase2/canvas.spec.ts`, Playwright, two browser
  contexts as two users of one workspace, on the Phase 2 stack):
  1. User A creates `whoami` and a Postgres service in one draft, sets
     `api`'s `DATABASE_URL=${{db.DATABASE_URL}}`, and sees a dashed
     reference edge.
  2. User B sees A's avatar, A's selection outline and the draft count
     update live.
  3. B changes `api` replicas directly through the API. A's set still
     applies, because the change merges on a different pointer.
  4. B then changes the same variable directly. A's apply gets 409, A picks
     Keep mine, and applies.
  5. Every affected service reaches `active` on the real agent, and the
     edge turns solid.
  6. The environment is marked protected. A cannot apply until B approves,
     and B cannot approve their own set.
  7. A keyboard-only pass moves a node with arrow keys, reloads, and the
     position has persisted.

## Rollout and compat

- No protocol change. The migration is additive (new tables and two
  columns).
- Existing routes keep their semantics, so the CLI and CI tokens are
  unaffected. Dashboard edits move to staging behind a per-workspace flag
  `staged_changes` that defaults to on for new workspaces. Existing ones
  switch it on from Settings, and the flag is removed one release later.
- `ProjectRoom` ignores unknown client messages today. An older dashboard
  that sends no `presence.update` simply shows as present without
  selection.

## Consequences

- One object now carries a change from proposal to deployments, and 0007,
  0012 and 0004 build on it instead of each inventing one.
- Every dashboard edit takes one more step (Apply). Single-service edits
  can be applied from the drawer in one click, which applies the draft.
- Two edit paths now coexist (staged and direct), so the conflict check
  carries real weight and is tested as such.

## Open questions

- Should positions be per environment for previews whose services differ?
  Proposed answer: no. A preview shows the base project's layout, and
  services missing from it fall back to automatic placement.
- Should a "Save now" toggle remain for single fields on unprotected
  environments? The flag above makes it possible. Decide once there is
  usage data.
- Should live cursors be shared? This ADR shares presence and selection
  only. Cursors add 10 frames per second per user for little review value.

## Sources

- React Flow performance guide, https://reactflow.dev/learn/advanced-use/performance (retrieved 2026-10-22)
- React Flow accessibility, https://reactflow.dev/learn/advanced-use/accessibility (retrieved 2026-10-22)
- `@xyflow/react` releases (12.12.0 latest), https://github.com/xyflow/xyflow/releases (retrieved 2026-10-22); license MIT, https://github.com/xyflow/xyflow/blob/main/LICENSE
- `onlyRenderVisibleElements`, https://reactflow.dev/api-reference/react-flow (retrieved 2026-10-22)
- D1 batch statements run as one transaction, https://developers.cloudflare.com/d1/worker-api/d1-database/#batch (retrieved 2026-10-22)
