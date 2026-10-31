# To do

What is left before the first release. Each item names where the work lives
and what "done" means. Design background is in [docs/adr](docs/adr).

## Release

- No tagged release exists yet. Cut the first CLI and agent release through
  the `cli-release` and `agent-release` environments, which hold the signing
  keys. The installers already pin the release public keys.

## Needs live verification

These are covered by tests against fakes only:
- Cloudflare Containers (the README says "Preview").
- Cloudflare for SaaS custom hostnames.
- Point-in-time restore against a real R2 bucket: the agent's integration
  test archives WAL to a fake S3 endpoint and restores real Postgres 18 from
  it; the upload and fetch URLs the control plane signs have not been used
  against R2 itself.

## Not built

- Point-in-time restore for MySQL (binlog archiving). Valkey/Redis and
  MongoDB have no point-in-time restore. ADR 0004 records why.
- PITR assumes Postgres's default 16 MiB WAL segments, which the templates
  never change.

## Watch in CI

- MongoDB 8.0 sometimes never became ready on runner image `20261025.353.1`
  (Linux 7.0 kernel). It has passed since, so the cause is unconfirmed; test
  containers print their log tail on failure. If it is the kernel, real
  nodes on that kernel are affected too.
- Some dashboard tests time out only when the whole web suite runs on a
  heavily loaded machine; each passes on its own.

## Known and accepted

- `pnpm audit` reports a moderate esbuild advisory (dev server only),
  reached only through the `drizzle-kit` CLI.
