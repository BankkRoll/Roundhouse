# @roundhouse/api

Control plane Worker: REST API, auth, agent connections, and the dashboard's
static assets.

## Run

```sh
pnpm --dir ../.. setup:dev        # creates .dev.vars with a MASTER_KEY
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
npx wrangler secret put MASTER_KEY
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
| `AUTH_LIMITER`, `WEBHOOK_LIMITER` | Rate limit     | Secret-accepting endpoints; GitHub webhooks                 |
| `MCP_LIMITER`                     | Rate limit     | MCP tool calls, 60 a minute per API token                   |

No secrets beyond `MASTER_KEY`: project data keys, GitHub App credentials and
signing keys are stored in D1, sealed under keys derived from it.

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
| `src/context.ts`                 | Session, RBAC (`requireWorkspace`)                       |
| `src/auth.ts`                    | Better Auth config                                       |
| `src/lib/desired-state.ts`       | A node's desired state, computed from D1                 |
| `src/lib/deployments.ts`         | Status transitions, create/cancel                        |
| `src/lib/variables.ts`           | Encrypted variables and project data keys                |
| `src/lib/github.ts`              | GitHub App: JWTs, tokens, webhooks                       |
| `src/lib/logs.ts`                | Log chunks, redaction, paging                            |
| `src/lib/guards.ts`              | Same-origin check, rate limits                           |
| `src/lib/crypto.ts`              | Key derivation, encryption, tokens                       |
| `test/`                          | Integration tests (`pipeline-helpers.ts`: fake v2 agent) |

OpenAPI: `GET /v1/openapi.json`.

## Notes

- `MASTER_KEY` is the only secret. The auth secret and encryption key are
  derived from it, so rotating it signs everyone out and makes stored secrets
  unreadable.
- Setup requires the master key, so nobody else can claim a fresh deploy.
- Public sign-up is off. Accounts come from setup or invites.

## MCP

Coding agents reach the control plane through a remote MCP server at
`POST https://<control-plane>/mcp` (Streamable HTTP, stateless; protocol
2026-07-28, with 2025-era `initialize` clients served too). It authenticates
only with an API token (`tok_…`, Settings → API tokens) in the
`Authorization` header; cookies are ignored. A token can do through MCP exactly
what it can do over REST: its scopes intersected with its creator's current
role, project grants and environment protection.

| Tool                                                         | Scope                  |
| ------------------------------------------------------------ | ---------------------- |
| `list_workspaces`                                            | `workspace:read`       |
| `list_projects`, `get_project`                               | `projects:read`        |
| `get_service`, `list_deployments`, `get_deployment`          | `services:read`        |
| `read_logs` (newest ≤ 500 lines, redacted at ingest)         | `services:read`        |
| `deploy_service`, `rollback_deployment`, `cancel_deployment` | `deployments:create`   |
| `list_variables` (plain values need `variables:read_plain`)  | `variables:read`       |
| `resolve_variables` (secret-derived keys in `local_keys`)    | `variables:read_plain` |
| `set_variables` (new secrets need `confirm_write_only`)      | `variables:manage`     |
| `list_nodes`                                                 | `nodes:read`           |

There is no tool that reads a secret value, deletes anything, opens a shell or
manages domains, nodes, tokens or members. A missing scope is answered with
`403` and `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`.
Mutations are audited like their REST routes, with `via: "mcp"` and the tool
name in the metadata.

The `read` token preset covers the read tools; `deploy` adds deploying and
variable writes. Add `variables:read_plain` for plain values and
`resolve_variables`.

Claude Code:

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

OAuth sign-in for MCP clients (ADR 0012) is not built yet; use an API token.
