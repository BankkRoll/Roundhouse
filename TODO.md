# To do

What is left after the 0.1.0 preview. Each item names where the work lives
and what "done" means. Design background is in [docs/adr](docs/adr).

## Releases

- `agent-v0.1.0` and `cli-v0.1.0` are published, signed and verified by the
  installers. Cut later ones by pushing an `agent-v<x.y.z>` or `cli-v<x.y.z>`
  tag on `main`; the `agent-release` environment asks for an approval before
  signing.

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

- MongoDB 8.0+ can't start on Linux kernels 6.19 to 7.0.13, which the
  ubuntu-24.04 runners now use: its bundled TCMalloc breaks the rseq ABI
  ([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)), fixed in
  kernel 7.0.14. The agent's MongoDB integration tests skip on those
  kernels (`dockertest.SkipIfMongoKernelAffected`), and the scheduler keeps
  MongoDB 8.0+ off such servers. Once the runners reach 7.0.14, check that
  the backup and dbquery MongoDB tests run there again instead of skipping.
- Some dashboard tests time out only when the whole web suite runs on a
  heavily loaded machine; each passes on its own.

## Known and accepted

- `pnpm audit` reports a moderate esbuild advisory (dev server only),
  reached only through the `drizzle-kit` CLI.
