# Roundhouse

> [!WARNING]
> **Roundhouse is under active development and not ready for production.**
> The schema, API and agent protocol change without notice, and there are no
> releases yet. Try it, file issues, and watch the repo for the first release.

Roundhouse is a source-available, self-hosted platform for deploying applications, similar in spirit to Railway. The control plane runs on your own Cloudflare account; your workloads run on your own Linux servers.

## Features

| Feature                         | What it does                                                   | Status                                                       |
| ------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| **Deploy**                      |                                                                |                                                              |
| Services from Git               | Push to a branch, get a build and a deploy                     | Available                                                    |
| Any language                    | Railpack detects the stack, or your Dockerfile is used         | Available                                                    |
| Zero-downtime deploys           | Traffic moves only after the new container is healthy          | Available                                                    |
| Rollbacks                       | Redeploy an earlier image, no rebuild                          | Available                                                    |
| PR previews                     | An environment and URL per pull request                        | In progress                                                  |
| Cron jobs                       | Run a service on a schedule                                    | Available                                                    |
| Cloud servers                   | Create servers on Hetzner, DigitalOcean, Vultr or Linode       | Available                                                    |
| **Data**                        |                                                                |                                                              |
| Databases                       | Postgres, MySQL, Valkey/Redis and MongoDB as services          | Available                                                    |
| Volumes                         | Persistent storage mounted into a service                      | Available                                                    |
| Backups                         | Scheduled database backups to R2 in your account               | Available                                                    |
| **Networking**                  |                                                                |                                                              |
| Private networking              | WireGuard mesh; services reach each other at `.internal` names | Partial — single server today; cross-server mesh in progress |
| Domains & HTTPS                 | A generated domain or your own, certificates by Caddy          | Available                                                    |
| **Observability**               |                                                                |                                                              |
| Logs                            | Build and runtime logs, streamed live                          | Available                                                    |
| Metrics                         | CPU, memory and requests per service                           | Available                                                    |
| Servers & live usage            | Join a Linux box with one command, watch CPU, RAM and disk     | Available                                                    |
| **Developer tools**             |                                                                |                                                              |
| Project canvas & staged changes | See every service, stage changes, review, deploy               | Available                                                    |
| Environments                    | Production plus staging or more, each with its own config      | Available                                                    |
| Shared variables                | Define a value once, reference it from every service           | Available                                                    |
| CLI                             | Deploy, tail logs and manage variables from a terminal         | Available                                                    |
| Templates                       | Start from a ready-made stack                                  | Available                                                    |
| MCP server                      | Coding agents act through a scoped API, with OAuth sign-in     | Available                                                    |
| **Security**                    |                                                                |                                                              |
| Signed control channel          | Agents dial out and verify every Ed25519-signed message        | Available                                                    |
| Audit log                       | Who did what and when                                          | Available                                                    |
| Members & roles                 | Owner, admin, member and viewer across workspaces              | Available                                                    |

## Install

1. Deploy the control plane (`apps/api`) to your Cloudflare account and set
   its secrets. The first deploy creates the D1 database, R2 bucket and
   Durable Objects; there are no IDs to copy.

   ```sh
   pnpm install
   cd apps/api
   pnpm run deploy
   openssl rand -base64 32 | npx wrangler secret put MASTER_KEY   # keep a copy offline
   npx wrangler secret put PUBLIC_ORIGIN                          # e.g. https://cp.example.com
   ```

   Every link, cookie, OAuth address and same-origin check is built from
   `PUBLIC_ORIGIN`, never from the request's `Host` header; until it is set,
   the API answers `503 public_origin_missing`. Every setting, and how to
   rotate the master key, is in [docs/configuration.md](docs/configuration.md).

2. Open that URL. The setup wizard asks for the master key, creates the admin
   account, then asks the admin to turn on two-factor authentication.

3. In **Servers → Add server**, copy the command and run it on a Linux host
   (Ubuntu 22.04/24.04, Debian 12):

   ```sh
   curl -fsSL https://<control-plane>/install.sh | sudo bash -s -- --token <token>
   ```

   Tokens are single-use and expire after 15 minutes. Installer options are in
   [install/README.md](install/README.md).

4. Optionally, install the CLI on your workstation (Linux and macOS; Windows
   from the [releases](https://github.com/BankkRoll/Roundhouse/releases)):

   ```sh
   curl -fsSL https://raw.githubusercontent.com/BankkRoll/Roundhouse/main/install/install-cli.sh | sh
   ```

   It verifies the release signature and checksum; see
   [cli/README.md](cli/README.md).

## Account security

- **Two-factor authentication** (an authenticator app, plus ten single-use
  backup codes) is required for instance admins and workspace owners and
  admins: until they turn it on, they can look around but not change
  anything. Anyone can turn it on under **Settings → Security**, which
  also lists your sessions and signs other devices out. An instance admin
  can reset the second factor of someone who lost their device.
- **Sign-in lockout**: after 5 failed attempts in 24 hours an account is
  locked for 30 seconds, doubling with each further failure up to an hour.
  Wrong passwords and wrong codes count alike, and unknown addresses lock
  the same way. An instance admin can lift a lock early
  (`POST /v1/instance/sign-in-lockouts/clear`).
- **Audit**: sign-ins, failed sign-ins, lockouts, sign-outs, two-factor
  changes and session revocations are recorded in the instance audit log.
  Entries carry a hash of the email address, never a password or a code.
- **Rotating `MASTER_KEY`** signs everyone out. Keep the old key in
  `MASTER_KEYS_PREVIOUS` until the key rotation has finished; two-factor
  secrets are re-encrypted under the new key with everything else.
- **Signing-key compromise**: if the control plane's signing key may have
  leaked, every node must re-join; follow
  [docs/runbooks/emergency-rejoin.md](docs/runbooks/emergency-rejoin.md).

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
pnpm setup:dev                                     # writes apps/api/.dev.vars, migrates the local DB
pnpm dev                                           # API :8787, dashboard :5173, site :5174
```

```sh
pnpm lint && pnpm typecheck && pnpm test           # TypeScript
go test ./agent/... ./cli/... ./packages/protocol/go/...  # Go
node e2e/agent-smoke.mjs                           # control plane + real agent
pnpm --filter @roundhouse/e2e test:browser         # browser end-to-end
```

Development settings live in `apps/api/.dev.vars`, created from
[`.dev.vars.example`](apps/api/.dev.vars.example); test knobs are listed in
[docs/configuration.md](docs/configuration.md#development-and-tests).

## Layout

| Path                | What                                   |
| ------------------- | -------------------------------------- |
| `apps/api`          | Control plane Worker                   |
| `apps/web`          | Dashboard                              |
| `apps/landing`      | Public site, published to GitHub Pages |
| `agent`             | Node agent (Go)                        |
| `cli`               | `roundhouse` CLI (Go)                  |
| `install`           | Node and CLI installers, systemd unit  |
| `packages/protocol` | Control plane ↔ agent wire protocol    |
| `packages/db`       | Database schema and migrations         |
| `packages/shared`   | Constants, IDs, roles                  |
| `packages/ui`       | Dashboard design system                |
| `e2e`               | End-to-end tests                       |
| `docs`              | Configuration, ADRs, runbooks          |
| `infra`             | Release signing                        |

[CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) ·
[Code of conduct](CODE_OF_CONDUCT.md)

## License

[Functional Source License 1.1, Apache 2.0 future license](LICENSE.md)
(FSL-1.1-ALv2). It is source-available, not OSI open source: you may use,
modify and self-host it for any purpose except offering it to others as a
competing commercial product or service. Each release becomes Apache-2.0 two
years after it is published.
