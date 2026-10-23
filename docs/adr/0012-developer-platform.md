# 0012: Developer platform (MCP server, templates, web shell, cost estimator, Hetzner)

## Status

Proposed.
- Date: 2026-10-22
- Phase: 4
- Protocol: version 6 (`exec_*` frames)
- Depends on: 0004 (database templates, age keys), 0005 (drain), 0006
  (change sets, `changes:auto_apply`), 0008 (logs search, metrics), 0010
  (cron config in templates), 0011 (shares protocol 6).

Names follow the Roundhouse rename (0013, "Naming").

## Context

Phase 1 hardening added scoped API tokens (`tok_…`, scopes are RBAC
actions, and a token can do only what both its scopes and its creator's
current role allow). The CLI lists `shell` and `db connect` as "not
available yet". `packages/providers` can list offers and provision servers
whose cloud-init joins the control plane, but nothing in the API or
dashboard uses it; the dashboard's Hetzner tab is disabled. Five pieces
complete the developer surface: an MCP server, templates, a web shell, a
cost estimator, and Hetzner provisioning.

MCP facts (sources at the end):
- **Spec version.** The latest is **2026-07-28**.
  - **Core.** The core is stateless: no `initialize` handshake, no
    `Mcp-Session-Id`. Every request carries
    `_meta.io.modelcontextprotocol/protocolVersion`, and servers MUST
    implement `server/discover`.
  - **Streamable HTTP.** One endpoint, POST only (GET and DELETE answer
    405), with `Accept: application/json, text/event-stream`. Required
    headers: `MCP-Protocol-Version` (matching `_meta`), `Mcp-Method`, and
    `Mcp-Name` for `tools/call`. SSE resumability is removed. Servers
    MUST validate `Origin` (403 when invalid).
  - **Input.** Server-initiated requests are replaced by multi
    round-trip `input_required` results, which also carry elicitation for
    confirmations.
- **Authorization** is OPTIONAL. When present it is OAuth 2.1:
  - The server is a resource server and MUST publish RFC 9728 protected
    resource metadata (a well-known URI or `WWW-Authenticate:
    resource_metadata`).
  - The authorization server publishes RFC 8414 metadata.
  - PKCE S256 is required. RFC 8707 `resource` is required on the
    authorization and token requests.
  - Audience validation is required, and token passthrough is forbidden.
  - Insufficient scope is a 403 `insufficient_scope` with step-up.
  - Client ID Metadata Documents are SHOULD. Dynamic Client Registration
    is MAY and **deprecated**.
- **SDKs.** The TypeScript SDK v2 (`@modelcontextprotocol/server`)
  implements 2026-07-28 and has a Hono adapter. Cloudflare's
  `createMcpHandler` is the recommended stateless path, and `McpAgent` is
  deprecated.

## Decision

### 1. MCP server at `/mcp`

**Transport.** `POST /mcp` follows Streamable HTTP for spec 2026-07-28,
implemented with `@modelcontextprotocol/server` v2 and its Hono adapter,
mounted on the existing router. A spike must confirm that it runs in
workerd; the fallback is Cloudflare's `createMcpHandler`.
- **Stateless.** No session IDs are issued, and cross-call state is passed
  as handles in tool arguments, such as change set IDs. `GET` and `DELETE`
  answer 405.
- **Origin.** A request with an `Origin` other than the control plane's
  own gets 403. Requests without `Origin`, from non-browser clients, are
  allowed.
- **Headers.** A missing or mismatched `MCP-Protocol-Version` gets 400
  (`HeaderMismatch`). Pre-2025-06-18 clients are not supported.
- **Responses.** `application/json` for every tool; no streaming is
  needed. A notification gets 202.
- **Limits.** Bodies are at most 256 KiB. Each principal gets 60 tool
  calls per minute, through the rate-limit binding.

**Authentication.** Every request needs `Authorization: Bearer`.
1. **API tokens** (`tok_…`) work as they do on REST. Their scopes are
   their tools' permissions. Clients that let users set a header use
   this.
2. **OAuth 2.1**, with the control plane as its own authorization server,
   implemented on D1. `@cloudflare/workers-oauth-provider` requires KV,
   and these tokens must be the same principals the RBAC layer already
   understands, so the library is not used.
   - **Protected resource metadata** at
     `/.well-known/oauth-protected-resource/mcp` and at the root:
     `{ resource: "https://<cp>/mcp", authorization_servers: ["https://<cp>"], scopes_supported: [...ACTIONS without instance:manage], bearer_methods_supported: ["header"] }`.
     A 401 carries
     `WWW-Authenticate: Bearer resource_metadata="https://<cp>/.well-known/oauth-protected-resource/mcp", scope="projects:read services:read"`.
   - **Authorization server metadata** at
     `/.well-known/oauth-authorization-server`:
     - `issuer`, `authorization_endpoint: /oauth/authorize`,
       `token_endpoint: /oauth/token`, `revocation_endpoint: /oauth/revoke`;
     - `response_types_supported: ["code"]`,
       `grant_types_supported: ["authorization_code", "refresh_token"]`;
     - `code_challenge_methods_supported: ["S256"]`,
       `token_endpoint_auth_methods_supported: ["none"]`;
     - `client_id_metadata_document_supported: true`,
       `authorization_response_iss_parameter_supported: true`.
   - **Clients.** Either pre-registered by an owner (Settings →
     Integrations), or a **Client ID Metadata Document**: `client_id` is
     an `https` URL. The server fetches it (≤ 64 KiB, 5 s, no redirects,
     cached 24 h) and requires its `client_id` to equal the URL and every
     `redirect_uri` to match exactly. DCR is not offered.
   - **`/oauth/authorize`** requires a browser session. It validates
     `resource == https://<cp>/mcp`, PKCE S256 and `state`, then shows a
     consent page: the client's name, logo and domain, a workspace picker,
     a scope preset (Read, or Deploy, which is the `deploy` token preset
     plus `changes:auto_apply` only if ticked), and an expiry. It returns
     `code` and `iss`.
   - **`/oauth/token`** checks PKCE and the single-use code (60 s), and
     issues:
     - an **access token**: an `api_tokens` row with `kind = 'oauth'`,
       `audience = 'https://<cp>/mcp'`, 1 h expiry, and the consented
       scopes, capped by the user's role at use time as for every token;
     - a **refresh token**: rotating, single use, 30-day sliding. Reuse
       revokes the whole grant.
   - **Audience.** OAuth access tokens are accepted **only** on `/mcp`.
     REST refuses them with 401, because their audience is the MCP
     resource. `tok_` tokens have no audience and work on both.
   - **Insufficient scope.** A tool needing a missing scope returns 403
     with
     `WWW-Authenticate: Bearer error="insufficient_scope", scope="<needed>", resource_metadata="…"`.

```sql
ALTER TABLE api_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'api';   -- api | oauth
ALTER TABLE api_tokens ADD COLUMN audience TEXT;
ALTER TABLE api_tokens ADD COLUMN oauth_grant_id TEXT REFERENCES oauth_grants(id) ON DELETE CASCADE;
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,                     -- oac_… (pre-registered) or sha256 of the CIMD URL
  client_id TEXT NOT NULL UNIQUE,          -- the CIMD URL, or a generated id for pre-registered
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,   -- pre-registered only
  name TEXT NOT NULL, logo_uri TEXT, redirect_uris TEXT NOT NULL,  -- JSON
  metadata TEXT, fetched_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  scopes TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, resource TEXT NOT NULL,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,                     -- oag_…
  client_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL, refresh_token_hash TEXT NOT NULL UNIQUE, refresh_expires_at INTEGER NOT NULL,
  last_used_at INTEGER, revoked_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

**Tools.** All of them call the same service functions as the REST routes,
so RBAC, validation and audit are shared. Inputs are zod schemas exported
as JSON Schema 2020-12. Outputs carry `structuredContent` plus a JSON
`TextContent` copy. Annotations follow the spec. Tool results include
user-generated text (logs, commit messages), and the tool descriptions say
so.

| Tool                  | Scope(s)                                 | Annotations                  | Behaviour                                                                     |
| --------------------- | ---------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `list_projects`       | `projects:read`                          | readOnly, idempotent         | projects of the token's workspace, with summary status                        |
| `get_project`         | `projects:read`                          | readOnly, idempotent         | environments, services, latest deployment per service                         |
| `list_deployments`    | `services:read`                          | readOnly, idempotent         | paged                                                                         |
| `get_deployment`      | `services:read`                          | readOnly, idempotent         | with events and placements                                                    |
| `read_logs`           | `services:read`                          | readOnly, idempotent         | newest ≤ 500 lines of a deployment or build (redacted)                        |
| `search_logs`         | `services:read`                          | readOnly, idempotent         | 0008 query syntax, ≤ 24 h window, ≤ 200 lines                                 |
| `get_metrics`         | `services:read`                          | readOnly, idempotent         | 0008 summary series                                                           |
| `list_variables`      | `variables:read`                         | readOnly, idempotent         | keys; values only for non-secret variables                                    |
| `list_templates`      | `projects:read`                          | readOnly, idempotent         | official and workspace templates                                              |
| `get_change_set`      | `projects:read`                          | readOnly, idempotent         | ops and masked diffs                                                          |
| `deploy_service`      | `deployments:create`                     | not readOnly, not idempotent | deploys the latest config; returns the deployment ID                          |
| `rollback_deployment` | `deployments:create`                     | destructive                  | as `POST …/rollback`; the result repeats 0003's rollback semantics            |
| `add_database`        | `services:manage`, `variables:manage`    | not readOnly                 | **stages** a database (0004) in a new change set                              |
| `set_variables`       | `variables:manage`                       | not readOnly                 | **stages** `variable.set`/`delete` ops; values marked secret by `secret_keys` |
| `stage_config_change` | `services:manage`                        | not readOnly                 | **stages** a `config.patch`                                                   |
| `deploy_template`     | `services:manage`, `variables:manage`    | not readOnly                 | **stages** a rendered template                                                |
| `apply_change_set`    | every op's action + `changes:auto_apply` | destructive                  | see below                                                                     |

Never exposed: revealing secrets, deleting anything, the shell, database
queries, domains, nodes, tokens and members. These need a human in the
dashboard.

**Confirmation.** Staging tools return
`{ change_set_id, revision, summary, review_url }`, where `review_url` is
the dashboard's review panel. `apply_change_set` applies only when **all**
of the following hold; otherwise it returns
`{ status: "awaiting_confirmation", review_url }`, not an error:
- the token carries `changes:auto_apply`;
- the change set was created by the same token, or the same OAuth grant;
- the target environment is not `protected` (0006);
- `expected_revision` matches.

An MCP client may also ask its user through elicitation (`input_required`
with a form "Apply 3 changes to production?"). That is a convenience for
the client's own human-in-the-loop. **The server never treats an
elicitation answer as authorization**, because the server cannot verify
who answered.

**Audit.** Mutations are audited with their existing actions,
`actor_type: "token"`, and `metadata.via = "mcp"`, plus the tool name and
the OAuth client ID. Reads are not audited, as for REST. New actions:
`oauth.client_registered`, `oauth.grant_created`, `oauth.grant_revoked`.

### 2. Templates

**Format.** `packages/shared/src/template.ts` exports `TemplateSchema`
(zod) and `renderTemplate`. A `template.json`:

```ts
{
  schema_version: 1,
  slug: string,                 // SlugField
  name: string, description: string /* ≤ 500 */, icon?: string /* https URL or "builtin:<name>" */,
  tags: string[] /* ≤ 10 */, docs_url?: string,
  inputs?: { key: string /* ENV_KEY_RE */; label: string; description?: string;
             type: "string" | "secret" | "number" | "boolean" | "select";
             required: boolean; default?: string; options?: string[] }[],
  services: {
    ref: string,                // slug-shaped; the default service slug; unique; never "shared" or "input"
    name: string, kind: "app" | "database" | "cron", icon?: string,
    source: { type: "image"; image: string }            // official templates: digest-pinned required
          | { type: "git"; repo_url: string; branch: string; root_dir?: string }
          | { type: "database"; engine: Engine; version?: string },
    config?: ServiceConfigPatch,                         // build, deploy, resources, healthcheck, networking, cron
    variables?: Record<string, string | {
      value?: string;                                    // may contain ${{<ref>.VAR}}, ${{shared.VAR}}, ${{input.KEY}}
      generate?: { bytes: number /* 16..64 */; encoding: "base64url" | "hex" };
      secret?: boolean; description?: string }>,
    volume?: { mount_path: string; size_mb: number },
    domains?: { generated: boolean },
    connects_to?: string[],                              // refs; explicit canvas edges (0006)
    position?: { x: number; y: number },
  }[],
  shared_variables?: Record<string, …same as variables>,
}
```

Validation goes beyond the shape:
- refs are unique;
- every `${{ref.VAR}}` names a ref and a variable it defines, or a
  built-in;
- `${{input.KEY}}` names a declared input;
- no reference cycles (`resolveVariables` dry run);
- database services take no `config.source` override;
- `type: "secret"` inputs and `generate` produce secret variables.

**Rendering.** `renderTemplate(template, { inputs, existingSlugs })`
returns `StagedOp[]` (0006):
1. a `service.create` per service, with `ref: "new:<n>"`, slugs
   deduplicated with -2, -3 against `existingSlugs`, and references
   rewritten to the final slugs;
2. `variable.set` ops, with `generate` values minted in the Worker
   (`crypto.getRandomValues`) and `${{input.KEY}}` substituted;
3. `volume.set`, and `edge` creation for `connects_to`.

The result is a change set with `source: "template"` and
`source_ref: "<template id>@<version>"`. The user reviews and applies it
as usual. `DEPLOYMENT_TRIGGERS.template` already exists.

**Official directory.** `templates/<slug>/` in this repository holds
`template.json`, `README.md` and `icon.svg`. The build compiles them into
`templates/index.json`, embedded in the control plane, so no network
fetch happens at runtime. CI (`pnpm templates:check`) validates every
template, requires image digests, renders each against a fake project,
and resolves every image digest against its registry, weekly. The
nightly e2e deploys the `nextjs-postgres` template.

**Publishing.**

```sql
CREATE TABLE templates (
  id TEXT PRIMARY KEY,                    -- tpl_…
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,   -- null: published instance-wide
  slug TEXT NOT NULL, version INTEGER NOT NULL, manifest TEXT NOT NULL,
  visibility TEXT NOT NULL,               -- workspace | instance
  published_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX templates_ws_slug_version_uq ON templates(workspace_id, slug, version);
```

`POST /v1/projects/{projectId}/export-template` drafts a manifest from a
project:
- Images are pinned by their active digest. Git sources are kept.
- Configs are kept.
- Non-secret variable values are kept as written, references included.
- **Secret values are never exported.** A database template's generated
  credentials become `generate`, and every other secret becomes a
  required `secret` input.

The draft is returned for editing, then published with
`POST /v1/workspaces/{ws}/templates`.

| Method and path                                                                                         | RBAC                                                              | Audit                                                    |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| `GET /v1/workspaces/{ws}/templates`                                                                     | `projects:read`                                                   | none                                                     |
| `GET /v1/templates/{slugOrId}?version=`                                                                 | `projects:read`                                                   | none                                                     |
| `POST /v1/projects/{projectId}/templates/deploy` `{template, version?, environment_id, inputs, apply?}` | `services:manage`, `variables:manage` (+ op actions on apply)     | `change_set.created` (`change_set.applied` when `apply`) |
| `POST /v1/workspaces/{ws}/projects/from-template`                                                       | `projects:manage` + the above                                     | `project.created`, `change_set.applied`                  |
| `POST /v1/projects/{projectId}/export-template`                                                         | `projects:read`, `variables:read`                                 | none                                                     |
| `POST /v1/workspaces/{ws}/templates`                                                                    | `templates:publish` (instance visibility: also `instance:manage`) | `template.published`                                     |
| `DELETE /v1/templates/{templateId}`                                                                     | `templates:publish`                                               | `template.deleted`                                       |

### 3. Web shell

**Protocol (version 6).** Control → agent frames are signed. Input is
signed too: every control frame is, and an Ed25519 signature per 20 ms
input batch is cheap.

```ts
{ type: "exec_open"; ...ControlHeader; session_id: IdString; workload_id: IdString;
  command: string[];          // default ["/bin/sh", "-c", "command -v bash >/dev/null && exec bash -l || exec sh -l"]
  tty: true; cols: number; rows: number;   // 1..1000 / 1..500
  env: Record<string, string>;             // { TERM: "xterm-256color" }; ≤ 8 vars
  user: string | null;                     // container user override; null = image user
  idle_timeout_s: number;                  // default 900
  max_duration_s: number }                 // default 28800
{ type: "exec_input"; ...ControlHeader; session_id; seq: number; data: string /* base64, ≤ 16 KiB */ }
{ type: "exec_resize"; ...ControlHeader; session_id; cols; rows }
{ type: "exec_close"; ...ControlHeader; session_id; reason: "user" | "idle" | "revoked" | "shutdown" }
```

Agent → control:

```ts
{ type: "exec_opened"; session_id }
{ type: "exec_output"; session_id; seq: number; data: string /* base64, ≤ 32 KiB */ }   // ≤ 64 frames/s per session
{ type: "exec_exit"; session_id; exit_code: number | null;
  reason: "exited" | "closed" | "idle_timeout" | "max_duration" | "error"; message?: string }
```

**Agent** (`internal/shell`).
- **Open.** `POST /containers/{id}/exec` with `Tty`, `AttachStdin`,
  `AttachStdout` and `AttachStderr`, then a hijacked `start`. Output is
  coalesced into frames every 20 ms.
- **Ordering.** Input is applied in `seq` order; duplicates and gaps are
  dropped.
- **Resize.** `POST /exec/{id}/resize`.
- **Close.** Docker does not kill an exec when its client disconnects. On
  close, timeout or agent shutdown, the agent reads `Pid` from
  `GET /exec/{id}/json`, sends SIGHUP, then SIGKILL after 5 s.
- **Timeouts.** The agent enforces `idle_timeout_s` (no input) and
  `max_duration_s` itself, as well as the control plane. At most 4
  sessions run per node.

**Relay.** `GET /v1/workloads/{workloadId}/shell?cols=&rows=` is a
WebSocket.
- The Worker authenticates: a session cookie with Origin checked, or a
  `tok_` with the `shell:open` scope for the CLI. OAuth tokens are
  refused. It then checks `shell:open` on the workload's workspace.
- The Worker forwards the upgrade to the workload's `NodeConnection` DO
  with a viewer header. Browser sockets terminate in the node DO, the
  only place that can talk to the agent.
- The DO keeps a session map in WebSocket attachments (hibernation-safe).
- **Data frames:**
  - browser → DO: binary frames carry input bytes, and JSON text frames
    carry `{ type: "resize", cols, rows }` and `{ type: "close" }`;
  - DO → browser: binary output, and `{ type: "exit", code, reason }`.
- The DO batches input every 20 ms. It buffers at most 1 MiB of output
  per slow browser, then drops output and writes `\r\n[output truncated]\r\n`.
- When the browser disconnects, the session closes after 30 s. There is
  no resume in v1.
- The DO re-checks membership and role every 60 s
  (`REALTIME_RECHECK_INTERVAL_MS`) and closes with
  `exec_close { reason: "revoked" }` when either lapses.

**Recording.** The instance setting `shell_recording` is
`"metadata" | "full"`, default `"full"`.
- In `full`, the DO records an asciicast v2 stream (header, `[t, "o", data]`
  and `[t, "i", data]` events), compresses it with zstd, and encrypts it
  to the project's age recipient (0004).
- It writes the result to R2 at
  `shell/<project>/<yyyy>/<mm>/<session>.cast.zst.age`: one object
  ≤ 16 MiB, then rolling parts.
- Retention is 30 days (setting `shell_recording_retention_days`).
- The terminal prints a banner at start: "This session is recorded."

```sql
CREATE TABLE shell_sessions (
  id TEXT PRIMARY KEY,                    -- shl_…
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL, service_id TEXT NOT NULL, workload_id TEXT NOT NULL,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL, token_id TEXT REFERENCES api_tokens(id) ON DELETE SET NULL,
  client_ip TEXT, command TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT, exit_code INTEGER,
  bytes_in INTEGER NOT NULL DEFAULT 0, bytes_out INTEGER NOT NULL DEFAULT 0,
  recording_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

| Method and path                                      | RBAC                                              | Audit                          |
| ---------------------------------------------------- | ------------------------------------------------- | ------------------------------ |
| `GET /v1/workloads/{workloadId}/shell` (WebSocket)   | `shell:open`                                      | `shell.opened`, `shell.closed` |
| `GET /v1/workspaces/{ws}/shell-sessions?project_id=` | `audit:read`                                      | none                           |
| `GET /v1/shell-sessions/{sessionId}/recording`       | `audit:read` + `shell:open`                       | `shell.recording_viewed`       |
| `POST /v1/shell-sessions/{sessionId}/terminate`      | `shell:open` (others' sessions: `members:manage`) | `shell.terminated`             |

`shell:open` is new, held by owner and admin. A shell exposes the
container's environment, so it is as sensitive as `variables:reveal`.

**Frontend.** `@xterm/xterm` with `addon-fit` and `addon-web-links` in a
service drawer tab, "Shell". There is a replica picker, a status line
(node, user, recording on), and the idle countdown from 60 s before the
idle timeout. The CLI's `roundhouse shell [--replica]` uses the same
endpoint with raw TTY mode, replacing its "not available yet" exit 10.

### 4. Cost estimator

**Node cost.** `nodes.monthly_cost` (decimal string), `cost_currency`
(ISO 4217) and `cost_source` (`hetzner | manual | none`). Hetzner nodes
take `price_monthly.gross` for their server type and location, recorded at
provisioning and refreshed daily from `GET /server_types`. Other nodes are
priced by the operator (`PATCH …/nodes/{id}`, `nodes:manage`).

**Allocation** (`packages/shared/src/costs.ts`, pure).
1. **Node capacity** is `C_cpu = cores × 1000` (no overcommit) and
   `C_mem = memoryMb`.
2. **Each live placement's raw share** is
   `0.5 × mem/C_mem + 0.5 × cpu/C_cpu`. Running cron jobs count while
   they run.
3. **Normalize.** CPU overcommit can push the raw sum on a node above 1.
   Shares are then divided by `max(1, Σ raw)`, so a node's total never
   exceeds its cost.
4. **Service cost** is `Σ share × node_monthly_cost`. The remainder of
   each node is **idle capacity**, shown, never hidden.
5. **Accrual.** The hourly job accrues `share × cost / 730` per (day,
   service, environment, currency) into `cost_accruals`. "Last 30 days"
   is real accrual. "Current run-rate" is the instantaneous projection.
6. **Storage** is shown separately: backup bytes × the setting
   `r2_storage_price_per_gb_month`, which the operator sets; no default
   price is hard-coded. Cloudflare-provider services (0011) show
   "billed by Cloudflare (usage)".
7. **Currencies are never mixed.** Totals are per currency.

```sql
ALTER TABLE nodes ADD COLUMN monthly_cost TEXT;
ALTER TABLE nodes ADD COLUMN cost_currency TEXT;
ALTER TABLE nodes ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'none';
ALTER TABLE nodes ADD COLUMN provider_server_id TEXT;
CREATE TABLE cost_accruals (
  day TEXT NOT NULL, workspace_id TEXT NOT NULL, project_id TEXT, environment_id TEXT, service_id TEXT,
  node_id TEXT NOT NULL, kind TEXT NOT NULL,          -- service | idle
  currency TEXT NOT NULL, amount_micros INTEGER NOT NULL,
  PRIMARY KEY (day, node_id, kind, service_id, environment_id, currency)
);
```

| Method and path                                                                   | RBAC                          | Audit          |
| --------------------------------------------------------------------------------- | ----------------------------- | -------------- |
| `GET /v1/workspaces/{ws}/costs?group=project\|service\|node&period=run_rate\|30d` | `nodes:read`, `projects:read` | none           |
| `PATCH /v1/workspaces/{ws}/nodes/{nodeId}` `{monthly_cost, cost_currency}`        | `nodes:manage`                | `node.updated` |

The dashboard has a Usage page (stacked bars by project, with preview
environments split out, per-node idle callouts), a per-service cost on the
service page, and the node cost field.

### 5. Hetzner in the API and dashboard

The package exists (`packages/providers`): typed client, `listOffers` and
`recommend`, `buildUserData` (the token goes into a tmpfs file, never
argv), idempotent `provisionServer` with cleanup on failure, and
`deprovisionServer`, which refuses servers not labelled
`roundhouse.managed=true`. The README defines the library flow, and this
section adds the routes and workflow around it.

```sql
CREATE TABLE provider_credentials (
  id TEXT PRIMARY KEY,                    -- pcr_…
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                 -- hetzner
  token_sealed TEXT NOT NULL,             -- AAD "provider:<workspace>:<provider>", sealed under the KEK
  read_only INTEGER NOT NULL, validated_at INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX provider_credentials_ws_provider_uq ON provider_credentials(workspace_id, provider);
CREATE TABLE node_provisions (
  id TEXT PRIMARY KEY,                    -- prov_…
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, name TEXT NOT NULL, server_type TEXT NOT NULL, location TEXT NOT NULL, image TEXT,
  builder INTEGER NOT NULL DEFAULT 0, labels TEXT NOT NULL DEFAULT '{}',
  server_id INTEGER, ipv4 TEXT, ipv6 TEXT,
  status TEXT NOT NULL,   -- queued | creating | booting | joined | failed | failed_cleanup_failed | cancelled
  reason TEXT,            -- ProvisionError.reason or join_timeout
  join_token_id TEXT REFERENCES node_join_tokens(id) ON DELETE SET NULL,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
ALTER TABLE node_join_tokens ADD COLUMN provision_id TEXT REFERENCES node_provisions(id) ON DELETE SET NULL;
```

`PROVISION_WORKFLOW` (instance ID `prov_…`):
1. Mint a join token (15 min) linked to the provision.
2. `provisionServer(hz, { name, serverType, location, controlPlaneUrl, joinToken, sshPublicKey, workspaceId, allowSsh, builder })`
   with a 5 min `AbortSignal`, then record `server_id` and the IPs.
   `ProvisionError.reason` maps to `failed` with that reason. On
   `failed_cleanup_failed`, the server ID is kept, and the minute tick
   retries `deprovisionServer` until it succeeds, raising a `node_offline`
   class alert meanwhile.
3. `waitForEvent("node_joined")`, up to 10 min. The join route emits it
   when it consumes a token that has a `provision_id`.
4. On join: set the node's `provider = 'hetzner'`, `region = location`,
   `provider_server_id`, labels and costs, and mark the provision
   `joined`.
5. On timeout: `deprovisionServer(hz, server_id, { expectedName: name })`,
   then `failed (join_timeout)`. The dashboard suggests `allow_ssh` to
   debug.

| Method and path                                                      | RBAC               | Audit                                |
| -------------------------------------------------------------------- | ------------------ | ------------------------------------ |
| `GET /v1/workspaces/{ws}/providers`                                  | `nodes:read`       | none                                 |
| `PUT /v1/workspaces/{ws}/providers/hetzner` `{token}` (session only) | `providers:manage` | `provider.connected`                 |
| `DELETE /v1/workspaces/{ws}/providers/hetzner` `{force?}`            | `providers:manage` | `provider.disconnected`              |
| `GET /v1/workspaces/{ws}/providers/hetzner/offers?role=app\|builder` | `nodes:manage`     | none (Cache API, 10 min)             |
| `GET /v1/workspaces/{ws}/providers/hetzner/images`                   | `nodes:manage`     | none                                 |
| `POST /v1/workspaces/{ws}/nodes/provision`                           | `nodes:manage`     | `node.provision_requested`           |
| `GET /v1/workspaces/{ws}/node-provisions/{provisionId}`              | `nodes:read`       | none                                 |
| `POST /v1/workspaces/{ws}/node-provisions/{provisionId}/cancel`      | `nodes:manage`     | `node.provision_cancelled`           |
| `DELETE /v1/workspaces/{ws}/nodes/{nodeId}?deprovision=true&force=`  | `nodes:manage`     | `node.removed`, `node.deprovisioned` |
- **Body** of `POST /nodes/provision`:
  `{ provider: "hetzner", name, server_type, location, image?, ssh_public_key?, allow_ssh?, builder?, labels? }`.
  A read-only Hetzner token gets `409 provider_read_only` before anything
  is created.
- **Deprovisioning** a node drains it first (0005). Volume-pinned
  services block the delete with `409 node_has_volumes` unless `force`.
- **Firewall.** `defaultFirewallRules` gains `51820/udp` for the mesh
  (0005).
- **RBAC.** `providers:manage` is new, held by owner and admin. A stored
  Hetzner token can create billable servers.

**Dashboard.** The Add server → **Hetzner** tab is enabled:
1. Connect a token, with the scope checked and read-only rejected.
2. Choose a role (app or builder), then cards from `recommend` with live
   gross prices and currency, a location, and an optional SSH key.
3. Provision, then a live stepper: creating → booting → joined, with the
   reason on failure.

The node detail page shows provider, server type, location and monthly
cost, and adds Deprovision.

## Security

- **MCP.**
  - OAuth follows the 2026-07-28 spec: S256 PKCE, resource indicators,
    `iss` in responses, audience-bound tokens accepted only by `/mcp`, no
    passthrough, rotating refresh tokens with reuse detection.
  - CIMD fetches are bounded, redirect-free and HTTPS-only.
  - Consent always names the client's domain.
  - The tool set excludes secret reveal, deletion, shell and data
    access, and staged changes need a human unless a token was explicitly
    granted `changes:auto_apply` for its own sets on unprotected
    environments.
- **Templates** cannot carry secrets out of a project. Export turns
  secrets into inputs or generators, and rendering mints new secrets.
- **Shell.**
  - Admin-level by default.
  - Every frame is signed, input is sequenced, and the agent kills the
    process on close because Docker would not.
  - Sessions have idle and duration limits, are re-checked for
    membership every minute, are fully audited, and are recorded,
    encrypted per project, by default.
- **Hetzner tokens** are sealed per workspace and set from a session
  only. Join tokens in user data follow `packages/providers`'s documented
  handling: single use, 15 minutes, tmpfs.
- **Costs** expose no secrets. Node prices are visible to `nodes:read`.

## Testing strategy

- **MCP.**
  - Conformance: the official TypeScript client SDK (v2) runs in vitest
    against the Worker (vitest-pool-workers). It covers `server/discover`,
    the protocol-version header mismatch, the Origin 403, GET 405, every
    tool's input validation, `insufficient_scope` step-up, and
    `apply_change_set` returning `awaiting_confirmation` without
    `changes:auto_apply`.
  - OAuth end to end in vitest: CIMD client (served by a test fetch
    mock), authorize with a session, consent, token, refresh rotation,
    reuse detection revoking the grant, an audience mismatch on REST
    (401), and a wrong `resource` (400).
- **Templates.**
  - Schema tests and render snapshots for every official template.
  - Reference checking.
  - Slug collision suffixing.
  - A property test: export then render keeps every non-secret value
    and never emits a secret value.
- **Shell.**
  - Go unit: seq ordering, idle and duration timers, kill-on-close (a
    fake Docker server returning a Pid).
  - Agent integration: open `sh`, run `echo $RH_TEST`, resize, then
    close and assert the exec process is gone (`ps` in the container).
  - Frame fixtures shared by TS and Go.
- **Costs.** Pure unit tests: normalization under CPU overcommit, idle
  remainder, multi-currency separation, and accrual over a simulated day.
- **Hetzner.** The existing fake (`packages/providers/test/fakes/hetzner.ts`)
  backs workflow tests: success, read-only token, `resource_limit_exceeded`,
  cleanup failure retried by the tick, and join timeout leading to
  deprovision.
- **Real-stack e2e** (`e2e/phase4/`):
  1. **MCP.** An MCP SDK client with a `tok_` token: `list_projects`,
     `add_database` (staged), `apply_change_set` →
     `awaiting_confirmation`. A second token with `changes:auto_apply`
     applies its own set, and Postgres goes active on the agent.
     `read_logs` shows redacted secrets.
  2. **Templates.** Deploy `nextjs-postgres` from the official directory
     into a new project: two services, a solid canvas edge, the app
     reaching its database. Export it and confirm no secret values are in
     the manifest.
  3. **Shell** (Playwright with xterm): open a shell on the app, type
     `printenv PORT`, see the value, resize the window, close. Then
     `shell.opened`/`shell.closed` are in the audit log, the R2 recording
     exists, and its decrypted cast contains the command. An idle timeout
     with `idle_timeout_s: 10` closes the session.
  4. **Hetzner.** The fake Hetzner server's create hook parses the
     cloud-init `write_files` token and starts a dind node container
     running `roundhouse-agent join --token-file`. The provision reaches
     `joined`, the node appears with its cost, and the usage page shows
     the service share and idle capacity. Deprovisioning drains the node
     and deletes the fake server.

## Rollout and compat

- **Protocol 6.** `PROTOCOL_VERSION = 6`, `MIN_PROTOCOL_VERSION = 5`.
  `EXEC_PROTOCOL_VERSION = 6`. Agents below it show "Shell needs agent ≥
  v6" on the Shell tab.
- **MCP** is on by default. Owners can disable it with the instance
  setting `mcp_enabled: false`.
- **OAuth tokens** live in `api_tokens`, so revocation, listing and the
  "Connected apps" view reuse the token machinery.
- **Hetzner** is opt-in per workspace.
- **Migrations** are additive.

## Consequences

- External agents, templates and humans all change projects through the
  same reviewed object (0006), and the server never trusts a client's
  claim of human approval.
- The control plane becomes an OAuth authorization server, which is new
  security-critical code. It is kept minimal: no DCR, no implicit flow,
  no client secrets.
- Shell recording stores sensitive transcripts by default. They are
  encrypted per project and retained for 30 days, and owners can lower
  recording to metadata only.

## Open questions

- Does `@modelcontextprotocol/server` v2's Hono adapter run unmodified in
  workerd, and does Cloudflare's `createMcpHandler` implement every
  2026-07-28 requirement (`server/discover`, `Mcp-Method` validation,
  `input_required`)? A spike decides between them.
- Should 2025-11-25 clients (with `initialize`) be served on the same
  endpoint during the transition, as the spec allows (MAY)? The answer
  depends on what the chosen SDK supports.
- Should shell sessions survive a browser reconnect, keeping the exec
  alive for a resume token? Not in v1.
- Should the cost estimator weight disk (volumes) as a third resource?

## Sources

- MCP 2026-07-28 release, https://blog.modelcontextprotocol.io/posts/2026-07-28/ (2026-07-28); spec and changelog, https://modelcontextprotocol.io/specification/latest and https://modelcontextprotocol.io/specification/latest/changelog (retrieved 2026-10-22)
- Streamable HTTP (POST only, required headers, Origin, no resumability), https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http (retrieved 2026-10-22)
- Authorization (OAuth 2.1, RFC 9728, RFC 8414, PKCE S256, RFC 8707, audience, `insufficient_scope`), https://modelcontextprotocol.io/specification/latest/basic/authorization and https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery; client registration (CIMD SHOULD, DCR deprecated), https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration; security considerations, https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations (retrieved 2026-10-22)
- Tools and annotations, https://modelcontextprotocol.io/specification/2026-07-28/server/tools; elicitation via `input_required`, https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation (retrieved 2026-10-22)
- TypeScript SDK v2, https://github.com/modelcontextprotocol/typescript-sdk (retrieved 2026-10-22); Cloudflare transport guidance (`createMcpHandler`, `McpAgent` deprecated), https://developers.cloudflare.com/agents/model-context-protocol/transport/ (updated 2026-07-27); `workers-oauth-provider` (requires `OAUTH_KV`), https://github.com/cloudflare/workers-oauth-provider (retrieved 2026-10-22)
- Docker exec API (hijack, resize, `Pid`, no kill on disconnect), Engine API swagger at moby tag docker-v29.9.2 (retrieved 2026-10-22)
- Hetzner `GET /server_types` prices (`price_monthly.gross/net` decimal strings, per-location `included_traffic`), https://docs.hetzner.cloud/cloud.spec.json (retrieved 2026-10-22); package sources, `packages/providers/SOURCES.md` (checked 2026-10-22)
