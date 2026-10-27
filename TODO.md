# To do

What is left before the first release. Each item names where the work lives
and what "done" means. Design background is in [docs/adr](docs/adr).

## Data recovery and point-in-time restore

On branch `feat/volumes-next` (migration 0024, protocol version 8), not yet in
`main`. Read the branch's last commit message before picking it up.

Done on the branch:

- Protocol 8: base backups, WAL archiving, WAL fetch and `restore_job.pitr`,
  with sealed URLs and the 60-second credential lifetime.
- Agent: `pg_basebackup` base backups, the `walship` WAL uploader, and
  point-in-time restore into a network-less container. An integration test
  restores real Postgres 18 to three different points.
- Control plane: abandoned-copy cleanup after the old server returns,
  opt-in automatic recovery policies, WAL streams, restorable windows and
  `POST /v1/services/{id}/pitr/restore`.

Left:

1. API tests for PITR: turning it on and off, the `wal_archive` and
   `wal_fetch` handlers, the restorable window, the restore route (including
   `422 pitr_target_unavailable` and future times), stream restart after a
   restore, and WAL retention.
2. Dashboard: MSW handlers and contract-test scenarios for the five new
   routes (the contract test fails until they exist), the recovery-policy
   setting, a PITR picker showing the window, and cleanup status on the
   volume panel, with component tests.
3. CLI: regenerate the OpenAPI snapshot (`bash cli/scripts/gen-openapi.sh`)
   and add commands for PITR status and restore, recovery policy and
   abandoned copies.
4. MCP: read-only tools for PITR status, recovery policy and abandoned
   copies.
5. Docs: `docs/configuration.md`, the ADR 0004 implementation notes (PITR is
   Postgres-only; MySQL binlog PITR is not built; Valkey and MongoDB are not
   supported), and the README rows, which say "In progress" until then.
6. Merge `main` into the branch, fold migration 0024 into
   `packages/db/migrations/meta/0018_snapshot.json`, then run every suite,
   the agent integration suite with `-race`, and the phase 1 end-to-end test.

## CI to confirm on GitHub's runners

These fixes landed without a GitHub run behind them; check them on the first
CI run after they reach `main`:

- `TestMeshTwoNodes` now tags the image ID that `docker load` prints, because
  the runner's classic image store and the nodes' containerd store name
  images differently. Reproduced and fixed locally only.
- MongoDB 8.0 sometimes never became ready on runner image `20261025.353.1`
  (Linux 7.0 kernel). The cause is unconfirmed; test containers now print
  their log tail on failure. If it is the kernel, real nodes on that kernel
  are affected too.

## Needs live verification

- Cloudflare Containers: tested against a fake API only (README says
  "Preview").
- Cloudflare for SaaS custom hostnames: tested against a fake API only.

## Decisions to confirm

- ADR 0012 now lets MCP drain and resume servers (not add or remove them).
  Revert the `drain_node` and `resume_node` tools if MCP should never touch
  servers.

## Known and accepted

- `pnpm audit` reports a moderate esbuild advisory (dev server only),
  reached only through the `drizzle-kit` CLI.

## Smaller follow-ups

- The phase 1 end-to-end test once dropped 1 of 2,990 requests during the
  agent-restart step on a heavily loaded machine; watch for a repeat.
- Release: no tagged release exists yet. Cut the first CLI and agent release
  through the `cli-release` and `agent-release` environments.
