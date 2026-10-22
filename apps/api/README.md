# @openrail/api

Control plane Worker: REST API, auth, agent connections, and the dashboard's
static assets.

## Run

```sh
cp .dev.vars.example .dev.vars    # MASTER_KEY=$(openssl rand -base64 32)
pnpm db:migrate:local
pnpm dev                          # http://127.0.0.1:8787
```

Run `pnpm --filter @openrail/web build` first if you want the dashboard
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

## Layout

| Path                             | What                                            |
| -------------------------------- | ----------------------------------------------- |
| `src/index.ts`                   | App entry, middleware, error handling           |
| `src/routes/`                    | One file per resource                           |
| `src/durable/node-connection.ts` | One Durable Object per node; owns its WebSocket |
| `src/context.ts`                 | Session, RBAC (`requireWorkspace`)              |
| `src/auth.ts`                    | Better Auth config                              |
| `src/lib/guards.ts`              | Same-origin check, rate limits                  |
| `src/lib/crypto.ts`              | Key derivation, encryption, tokens              |
| `test/`                          | Integration tests                               |

OpenAPI: `GET /v1/openapi.json`.

## Notes

- `MASTER_KEY` is the only secret. The auth secret and encryption key are
  derived from it, so rotating it signs everyone out and makes stored secrets
  unreadable.
- Setup requires the master key, so nobody else can claim a fresh deploy.
- Public sign-up is off. Accounts come from setup or invites.
