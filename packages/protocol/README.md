# @openrail/protocol

Wire protocol between the control plane and agents.

| Path        | What                                                        |
| ----------- | ----------------------------------------------------------- |
| `src/`      | zod schemas (source of truth), limits, spec hash, envelopes |
| `schema/`   | Generated JSON Schema. Do not edit                          |
| `fixtures/` | Sample messages both TS and Go tests decode                 |
| `go/`       | Go types, decoding, validation, spec hash, envelope checks  |

## Changing the protocol

1. Edit `src/`. Size limits and string formats live in `src/limits.ts`.
2. `pnpm gen:schema && pnpm gen:fixtures`
3. Update `go/` to match: the struct, its `Validate()` method, and
   `go/limits.go` for any limit or format.
4. Add a fixture for every new message and wire it into both
   `src/fixtures.test.ts` and `go/fixtures_test.go`.
5. `pnpm test` and `go test ./...` in `go/`.

CI fails if `schema/` or `fixtures/` are stale.

### Fixtures

Hand-written fixtures (`hello.json`, `logs-runtime.json`, …) are plain
messages. Generated ones come from `scripts/gen-fixtures.ts` and are excluded
from formatting in `biome.json`:
- `signed-*.json`: control frames signed with a fixed RFC 8032 test key
  (`desired_state`, `build_job`, `build_cancel`). The Go tests verify the
  signature, decode the payload and re-encode it, so a field that exists on
  only one side fails.
- `spec-hash.json`: workload specs with their canonical text and
  `spec_hash`. Both sides must reproduce both exactly.
- `network-names.json`: `environmentNetworkName` cases, readable and hashed.
  Both sides must produce the same names.

### Go decoding rules

The Go structs encode the zod schema's shape in their tags, and the decoder
enforces it at every nesting level:

| zod           | Go field                          |
| ------------- | --------------------------------- |
| required      | no `omitempty`, non-pointer       |
| `.nullable()` | pointer, no `omitempty`           |
| `.optional()` | `omitempty` (pointer for numbers) |

Keys differing from a field only by case are rejected everywhere. Agent →
control frames also reject unknown fields; control → agent frames ignore
them, so the control plane can add optional fields for newer agents. Value
constraints (ranges, formats, sizes) live in each type's `Validate()`.

### Versions

The control plane accepts `MIN_PROTOCOL_VERSION` through `PROTOCOL_VERSION`:
at least N-1 and N, and older versions for as long as every change since
them is additive (today 1 through 3). Bump `PROTOCOL_VERSION`, in both
`src/messages.ts` and `go/messages.go`, when:
- a change is breaking; or
- the control plane must know whether an agent understands something new
  before sending it. Version 2 gates `build_job` and workload placement.
  Version 3 gates `build_cancel`, which a version 2 agent would drop, and
  `build_job.secret_build_args`, which it would ignore and then bake the
  secret values into the image.

Give each gated feature its own constant (`WORKLOADS_PROTOCOL_VERSION`,
`BUILD_CANCEL_PROTOCOL_VERSION`, `SECRET_BUILD_ARGS_PROTOCOL_VERSION`) and
check it where the control plane sends the frame or field. Purely additive
optional fields that an older agent may safely ignore need no bump. Changes
to the envelope or signing scheme need an ADR.

### Credentials on the wire

A control frame carrying a credential (git token, registry password, object
storage keys) must have `exp - iat <= CREDENTIAL_FRAME_TTL_MS` (60 s). The
schemas reject longer-lived ones; `carriesCredentials` tells the sender which
TTL applies.
