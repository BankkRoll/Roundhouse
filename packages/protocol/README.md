# @openrail/protocol

Wire protocol between the control plane and agents.

| Path        | What                                                 |
| ----------- | ---------------------------------------------------- |
| `src/`      | zod schemas (source of truth) and Ed25519 envelopes  |
| `schema/`   | Generated JSON Schema. Do not edit                   |
| `fixtures/` | Sample messages both TS and Go tests decode          |
| `go/`       | Go types and envelope verification used by the agent |

## Changing the protocol

1. Edit `src/`.
2. `pnpm gen:schema && pnpm gen:fixtures`
3. Update `go/` to match.
4. `pnpm test` and `go test ./...` in `go/`.

The control plane must accept the previous agent version. Bump
`PROTOCOL_VERSION` for breaking changes. CI fails if `schema/` or
`fixtures/` are stale.
