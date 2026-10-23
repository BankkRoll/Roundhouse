# Contributing

For anything larger than a bug fix, open an issue first so the approach can be
agreed before you write code. Design decisions are recorded in
[`docs/adr`](docs/adr).

## Setup

Requires Node 22.19+, pnpm 10 (via Corepack), and Go (version in `go.work`). On
Windows, PowerShell, Git Bash, and WSL 2 all work.

```sh
corepack enable
pnpm install
pnpm setup:dev                    # creates MASTER_KEY in apps/api/.dev.vars, migrates the local DB
pnpm dev                          # API :8787, dashboard :5173
```

`pnpm setup:dev` prints the master key; the setup wizard asks for it once.

Local D1 and Durable Object state lives in `apps/api/.wrangler/`; delete it to
start fresh.

### Running an agent locally

Complete setup at `http://localhost:5173/dashboard`, create a token under
**Servers → Add server**, then from the repo root:

```sh
go run ./agent/cmd/roundhouse-agent join --url http://localhost:8787 \
  --token <token> --config ./.dev/agent.yaml
go run ./agent/cmd/roundhouse-agent run --config ./.dev/agent.yaml
```

`node e2e/agent-smoke.mjs` runs the same loop unattended.

## Checks

CI runs these on every pull request:

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
go vet ./agent/... ./packages/protocol/go/...
go test -race ./agent/... ./packages/protocol/go/...
node e2e/agent-smoke.mjs
pnpm --filter @roundhouse/e2e test:browser
```

`pnpm format` applies Biome's formatting and safe fixes.

## Conventions

- [Conventional Commits](https://www.conventionalcommits.org/): `feat`, `fix`,
  `docs`, `chore`, `ci`, `refactor`, `test`, `perf`, with an optional scope
  (`fix(agent): ...`). Imperative subject, no trailing period; the body
  explains why.
- No tool or bot attribution trailers or footers. `Co-Authored-By:` is for
  human co-authors only.
- Every behaviour change needs a test; bug fixes need a test that fails
  without the fix.
- Exported TypeScript symbols have JSDoc; exported Go identifiers have doc
  comments. Comments explain why, not what.
- Keep PRs focused. Mechanical changes go in their own PR.

## Database migrations

Edit `packages/db/src/schema`, run `pnpm --filter @roundhouse/db generate`, review
the SQL, and commit the schema, `.sql` file, and `meta/` snapshot together.
Migrations must work with the previous control plane release: add columns as
nullable or with defaults, and remove or rename only in a later release.

## Protocol changes

Control planes must support agents one version behind. See
[`packages/protocol/README.md`](packages/protocol/README.md). Prefer additive
changes, never require a field older agents don't send, and record changes to
the signed envelope in an ADR.

## Releases

Maintainers cut agent releases by pushing an `agent-vX.Y.Z` tag and CLI
releases with a `cli-vX.Y.Z` tag; see
[`infra/release-signing.md`](infra/release-signing.md).

## Licensing

The project is licensed under [FSL-1.1-ALv2](LICENSE.md). By contributing you
agree your contribution is distributed under that license, including its
Apache-2.0 future license.

Participation is governed by the [code of conduct](CODE_OF_CONDUCT.md).
