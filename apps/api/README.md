# @roundhouse/api

Control plane Worker: REST API, auth, agent connections, and the dashboard's
static assets.

## Run

```sh
pnpm --dir ../.. setup:dev        # creates .dev.vars from .dev.vars.example, with a MASTER_KEY
pnpm dev                          # http://127.0.0.1:8787
```

Run `pnpm --filter @roundhouse/web build` first if you want the dashboard
served from here instead of from Vite. Otherwise `dev` and `db:migrate:local`
create an empty `../web/dist`, since wrangler won't start without the assets
directory it is configured with.

## Test

```sh
pnpm test        # integration tests in the Workers runtime (D1, Durable Objects)
pnpm typecheck
```

## Deploy

```sh
pnpm run deploy                    # builds the dashboard, deploys, applies D1 migrations
openssl rand -base64 32 | npx wrangler secret put MASTER_KEY
npx wrangler secret put PUBLIC_ORIGIN   # e.g. https://cp.example.com
```

The first deploy creates the D1 database, so `wrangler.jsonc` has no
`database_id`. Migrations run after the deploy for that reason.

### Bindings

| Binding                           | Kind           | What                                                        |
| --------------------------------- | -------------- | ----------------------------------------------------------- |
| `DB`                              | D1             | Control-plane metadata                                      |
| `LOGS`                            | R2             | Log chunks (`roundhouse-logs`, created on the first deploy) |
| `DEPLOY_WORKFLOW`                 | Workflow       | `DeployWorkflow`, one instance per deployment               |
| `NODE_CONNECTION`                 | Durable Object | One per node: the agent's socket                            |
| `PROJECT_ROOM`                    | Durable Object | One per project: the dashboard's realtime socket            |
| `AUDIT_CHAIN`                     | Durable Object | One per install: hash-chains audit entries in `seq` order   |
| `KEY_ROTATION_WORKFLOW`           | Workflow       | `KeyRotationWorkflow`, re-seals stored secrets              |
| `PROVISION_WORKFLOW`              | Workflow       | `ProvisionWorkflow`, one-click cloud servers                |
| `AUTH_LIMITER`, `WEBHOOK_LIMITER` | Rate limit     | Secret-accepting endpoints; GitHub webhooks                 |
| `MCP_LIMITER`                     | Rate limit     | MCP tool calls, 60 a minute per token                       |
| `METRICS`                         | Analytics      | Metrics dataset; optional                                   |
| `ASSETS`                          | Static assets  | The dashboard build                                         |

Every secret, variable and binding, with defaults and production guidance, is
in [docs/configuration.md](../../docs/configuration.md#control-plane);
`.dev.vars.example` lists the same settings for development, and
`test/configuration.test.ts` keeps `src/env.ts`, `wrangler.jsonc`, the example
and that page in agreement. `MASTER_KEY` is the only required secret: project
data keys, GitHub App credentials and signing keys are stored in D1, sealed
under keys derived from it.

## Layout

| Path                             | What                                                     |
| -------------------------------- | -------------------------------------------------------- |
| `src/index.ts`                   | App entry, middleware, error handling                    |
| `src/contracts.ts`               | Phase 1 route contracts (paths, schemas, RBAC, audit)    |
| `src/routes/`                    | One file per resource                                    |
| `src/workflows/deploy.ts`        | The deploy pipeline (build, schedule, roll out)          |
| `src/durable/node-connection.ts` | One Durable Object per node; owns its WebSocket          |
| `src/durable/project-room.ts`    | One Durable Object per project; realtime fan-out         |
| `src/mcp/`                       | MCP server at `/mcp`: transport, auth, tools             |
| `src/mcp/oauth/`                 | OAuth for MCP clients: discovery, `/oauth/*`, consent    |
| `src/context.ts`                 | Session, RBAC (`requireWorkspace`)                       |
| `src/auth.ts`                    | Better Auth config                                       |
| `src/lib/desired-state.ts`       | A node's desired state, computed from D1                 |
| `src/lib/deployments.ts`         | Status transitions, create/cancel                        |
| `src/lib/changes/`               | Change sets: staging, review, apply, canvas (ADR 0006)   |
| `src/lib/variables.ts`           | Encrypted variables and project data keys                |
| `src/lib/github.ts`              | GitHub App: JWTs, tokens, webhooks                       |
| `src/lib/logs.ts`                | Log chunks, redaction, paging                            |
| `src/lib/guards.ts`              | Same-origin check, rate limits                           |
| `src/lib/crypto.ts`              | Key derivation, encryption, tokens                       |
| `test/`                          | Integration tests (`pipeline-helpers.ts`: fake v2 agent) |

OpenAPI: `GET /v1/openapi.json`.

## Notes

- The auth secret and encryption keys are derived from `MASTER_KEY`.
  Rotating it signs everyone out; stored secrets stay readable through
  `MASTER_KEYS_PREVIOUS` until `KeyRotationWorkflow` has re-sealed them (see
  [Rotating the master key](../../docs/configuration.md#rotating-the-master-key)).
- Setup requires the master key, so nobody else can claim a fresh deploy.
- Public sign-up is off. Accounts come from setup or invites.

## MCP

Coding agents reach the control plane through a remote MCP server at
`POST https://<control-plane>/mcp` (Streamable HTTP, stateless; protocol
2026-07-28, with 2025-era `initialize` clients served too). Clients connect
with just that URL and sign in through OAuth (below), or send an API token
(`tok_…`, Settings → API tokens) in the `Authorization` header; cookies are
ignored. Either way a token can do through MCP exactly what it can do over
REST: its scopes intersected with its user's current role, project grants and
environment protection, checked again on every call.

MCP is **off on new installs**. An instance admin turns it on in the
dashboard under Settings → Platform → MCP (`mcp_enabled` in
`PATCH /v1/instance/settings`, which needs a fresh sign-in and is recorded as
`instance.settings_updated`). While it is off, every request to `/mcp` gets
`404` before any authentication: a JSON-RPC error (code `-32000`,
`data.code: "mcp_disabled"`) for a JSON-RPC body, else the API's usual error
body with code `mcp_disabled`.

| Tool                                                            | Scope                  |
| --------------------------------------------------------------- | ---------------------- |
| `list_workspaces`                                               | `workspace:read`       |
| `list_projects`, `get_project`                                  | `projects:read`        |
| `get_service`, `list_deployments`, `get_deployment`             | `services:read`        |
| `read_logs` (newest ≤ 500 lines, redacted at ingest)            | `services:read`        |
| `deploy_service`, `rollback_deployment`, `cancel_deployment`    | `deployments:create`   |
| `list_variables` (plain values need `variables:read_plain`)     | `variables:read`       |
| `resolve_variables` (secret-derived keys in `local_keys`)       | `variables:read_plain` |
| `set_variables` (stages; new secrets need `confirm_write_only`) | `variables:manage`     |
| `stage_config_change` (stages a config patch)                   | `services:manage`      |
| `list_changes` (open change sets, value-free diffs)             | `projects:read`        |
| `apply_changes` (own sets on unprotected environments only)     | `projects:read`        |
| `list_nodes`                                                    | `nodes:read`           |

There is no tool that reads a secret value, deletes anything, opens a shell or
manages domains, nodes, tokens or members. A missing scope is answered with
`403` and `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`.
Mutations are audited like their REST routes, with `via: "mcp"` and the tool
name in the metadata. Variable and config changes are staged into a change
set the token owns (ADR 0006) and come back with a `review_url`;
`apply_changes` applies a set only when the same token staged it, the
environment is not protected and `expected_revision` still matches, and
answers `awaiting_confirmation` otherwise. Applying re-checks every change
against the token's scopes and its owner's role.

The `read` token preset covers the read tools; `deploy` adds deploying and
variable writes. Add `variables:read_plain` for plain values and
`resolve_variables`.

### Signing in with OAuth

An MCP client that supports OAuth needs only the URL. An unauthenticated call
gets `401` with `WWW-Authenticate: Bearer resource_metadata="…"`, and the
client takes it from there:

| Endpoint                                                             | What                                            |
| -------------------------------------------------------------------- | ----------------------------------------------- |
| `GET /.well-known/oauth-protected-resource/mcp` (and without `/mcp`) | RFC 9728 metadata: resource `…/mcp`, scopes     |
| `GET /.well-known/oauth-authorization-server`                        | RFC 8414 metadata                               |
| `GET /oauth/authorize`                                               | Authorization code + PKCE (S256 only)           |
| `POST /oauth/token`                                                  | `authorization_code` and `refresh_token` grants |
| `POST /oauth/revoke`                                                 | RFC 7009; either token ends the whole grant     |
- **Clients** identify themselves with a
  [Client ID Metadata Document](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration):
  `client_id` is an HTTPS URL serving the client's name and redirect URIs. It is
  fetched once a day at most (64 KiB, 5 s, no redirects). There is no dynamic
  client registration and no client secret. Redirect URIs must be HTTPS, or HTTP
  on a loopback address (any port), and match the document exactly.
- **Consent** happens in the dashboard (`/authorize`): the user, signed in,
  sees the client's name and domain, picks a workspace, and ticks which of the
  requested scopes to grant; scopes their role there can't grant are disabled.
- **Tokens**: a 60-second single-use code, then a 1-hour access token (`oat_…`)
  bound to the user, workspace, scopes and the `/mcp` URL (RFC 8707), and a
  30-day rotating refresh token (`ort_…`). Only hashes are stored. A reused
  code or refresh token revokes everything issued under that grant.
- **Audience**: OAuth access tokens work only at `/mcp`; the REST API answers
  them with `401`.
- **Revoking**: Settings → MCP clients lists the clients the user connected,
  in every workspace, and disconnects them. `mcp_client.authorized` and
  `mcp_client.revoked` are audited in the workspace; no code or token value is
  ever logged or audited.
- All of it, discovery included, is off while the `mcp_enabled` instance
  setting is.

Claude Code, with OAuth:

```sh
claude mcp add --transport http roundhouse https://<control-plane>/mcp
```

With an API token instead:

```sh
claude mcp add --transport http roundhouse https://<control-plane>/mcp \
  --header "Authorization: Bearer $ROUNDHOUSE_TOKEN"
```

or in `.mcp.json` (the variable is expanded from the environment):

```json
{
  "mcpServers": {
    "roundhouse": {
      "type": "http",
      "url": "https://<control-plane>/mcp",
      "headers": { "Authorization": "Bearer ${ROUNDHOUSE_TOKEN}" }
    }
  }
}
```

Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "roundhouse": {
      "url": "https://<control-plane>/mcp",
      "headers": { "Authorization": "Bearer tok_…" }
    }
  }
}
```
