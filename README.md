# Roundhouse

> [!WARNING]
> **Roundhouse is under active development and not ready for production.**
> The schema, API and agent protocol change without notice, and there are no
> releases yet. Try it, file issues, and watch the repo for the first release.

Roundhouse is a source-available, self-hosted platform for deploying applications, similar in spirit to Railway. The control plane runs on your own Cloudflare account; your workloads run on your own Linux servers.

## Install

1. Deploy the control plane (`apps/api`) to Cloudflare and set its secret:

   ```sh
   pnpm install
   cd apps/api
   npx wrangler d1 create roundhouse          # put the id in wrangler.jsonc
   npx wrangler secret put MASTER_KEY       # openssl rand -base64 32
   pnpm run deploy
   ```

2. Open the Worker URL. The setup wizard asks for the master key and creates
   the admin account.

3. In **Servers → Add server**, copy the command and run it on a Linux host
   (Ubuntu 22.04/24.04, Debian 12):

   ```sh
   curl -fsSL https://<control-plane>/install.sh | sudo bash -s -- --token <token>
   ```

   Tokens are single-use and expire after 15 minutes.

## Templates

**Templates** in the dashboard (or `roundhouse templates list`) are one-click
starting points: Railpack starters (static site, Vite + React, Express,
Node.js HTTP, FastAPI, Go + Gin) and official images (nginx, whoami, Uptime
Kuma, n8n). Deploying one creates a project, or adds services to an existing
one, with their config, variables and a first deploy. Secrets a template
generates are minted on the control plane and stored write-only.

The catalogue is code, in `apps/api/src/lib/template-catalogue.ts`; the
manifest format (`schema_version: 1`, ADR 0012) and its validation live in
`packages/shared/src/template.ts`. Templates that need databases or volumes
are accepted by the format but refused until those features ship.

## Develop

Requires Node 22.19+, pnpm 10, Go 1.26.

```sh
pnpm install
pnpm setup:dev                                     # creates MASTER_KEY, migrates the local DB
pnpm dev                                           # API :8787, dashboard :5173, site :5174
```

```sh
pnpm lint && pnpm typecheck && pnpm test           # TypeScript
go test ./agent/... ./packages/protocol/go/...     # Go
node e2e/agent-smoke.mjs                           # control plane + real agent
pnpm --filter @roundhouse/e2e test:browser           # browser end-to-end
```

## Layout

| Path                | What                                   |
| ------------------- | -------------------------------------- |
| `apps/api`          | Control plane Worker                   |
| `apps/web`          | Dashboard                              |
| `apps/landing`      | Public site, published to GitHub Pages |
| `agent`             | Node agent (Go)                        |
| `install`           | Server install script and systemd unit |
| `packages/protocol` | Control plane ↔ agent wire protocol    |
| `packages/db`       | Database schema and migrations         |
| `packages/shared`   | Constants, IDs, roles                  |
| `packages/ui`       | Dashboard design system                |
| `e2e`               | End-to-end tests                       |
| `docs/adr`          | Architecture decisions                 |

[CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) ·
[Code of conduct](CODE_OF_CONDUCT.md)

## License

[Functional Source License 1.1, Apache 2.0 future license](LICENSE.md)
(FSL-1.1-ALv2). It is source-available, not OSI open source: you may use,
modify and self-host it for any purpose except offering it to others as a
competing commercial product or service. Each release becomes Apache-2.0 two
years after it is published.
