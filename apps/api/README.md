# @roundhouse/api

Control plane Worker: REST API, auth, agent connections, and the dashboard's
static assets.

## Run

```sh
pnpm --dir ../.. setup:dev        # creates .dev.vars with a MASTER_KEY
pnpm dev                          # http://127.0.0.1:8787
```

Run `pnpm --filter @roundhouse/web build` first if you want the dashboard
served from here instead of from Vite.

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
| `AUTH_LIMITER`, `WEBHOOK_LIMITER` | Rate limit     | Secret-accepting endpoints; GitHub webhooks                 |

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
