# @roundhouse/protocol

Wire protocol between the control plane and agents.

| Path        | What                                                                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`      | zod schemas (source of truth), limits, spec hash, envelopes; one module per Phase 2–4 feature (`data`, `mesh`, `jobs`, `metrics`, `certs`, `signing-keys`, `exec`, `image-push`) |
| `schema/`   | Generated JSON Schema. Do not edit                                                                                                                                               |
| `fixtures/` | Sample messages both TS and Go tests decode                                                                                                                                      |
| `go/`       | Go types, decoding, validation, spec hash, envelope checks                                                                                                                       |

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
- `sealed-box.json`: X25519 sealed boxes (RFC 7748 keys) that both sides
  open and re-seal to identical bytes; `encryption-key.json`: a node's
  encryption key signed by its identity key (ADR 0014).
- `redaction.json`: the strings `redactionNeedles` (in `@roundhouse/shared`)
  and Go's `RedactionNeedles` must produce for a set of secrets.
- `formats.json`: inputs and expected results of the hand-written format
  helpers (`isIPv6`, `isCidr`, `isHostPort`, `isSafeMountPath`,
  `isRouteHostname`, …), which both sides must reproduce.
- Phase 2–3 signed frames (`signed-desired-state-phase2.json`,
  `signed-desired-state-phase3.json`, `signed-welcome-next-keys.json`,
  `signed-key-announce.json`, `signed-backup-job.json`, …): every new
  control frame, with real sealed boxes the Go tests open.

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

The control plane accepts `MIN_PROTOCOL_VERSION` through `PROTOCOL_VERSION`
(today 3 through 7). A `hello` below the minimum is closed with code 4002
(`agent_outdated`). ADR 0013 planned one version per phase; sealed
environments took 4 first, so each phase moved up by one (ADR 0015):

| Version | Phase    | Gates (TS / Go)                                                                                      | Adds                                                                                                                                                                                                                                             |
| ------- | -------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2       | 1        | `WORKLOADS_` / `WorkloadsProtocolVersion`                                                            | workloads, builds, statuses, logs                                                                                                                                                                                                                |
| 3       | 1        | `BUILD_CANCEL_`, `SECRET_BUILD_ARGS_`                                                                | `build_cancel`, secret build args                                                                                                                                                                                                                |
| 4       | ADR 0014 | `SEALED_ENV_`                                                                                        | `env_sealed`, `build_secrets_sealed`, `hello.encryption_key`                                                                                                                                                                                     |
| 5       | 2        | `MESH_`, `VOLUMES_`, `BACKUPS_`, `DB_QUERY_`, `KEY_ROLLOVER_` (`MeshProtocolVersion`, …)             | mesh, route workloads, volumes and mounts, `exec` probes, `stop_first`, publish, backup/restore/copy, `db_query`, `task` logs, `volume_status`, key rollover                                                                                     |
| 6       | 3        | `JOBS_`, `METRICS_`, `CERTS_` (`JobsProtocolVersion`, …)                                             | `job_*`, `metrics`, `cert_*`, wildcard routes, `hsts`, `desired_state.ingress` and `certificates`, `managed` TLS                                                                                                                                 |
| 7       | 3, 4     | `PREVIEW_BUILDS_`, `EXEC_`, `IMAGE_PUSH_` (`PreviewBuildsProtocolVersion`, `ExecProtocolVersion`, …) | `build_job.isolation` (preview builds, ADR 0007), `exec_open`, `exec_input` (sealed keystrokes), `exec_resize`, `exec_close`, `exec_opened`, `exec_output`, `exec_exit`, `image_push` (sealed login), `image_push_result`; edge gateway reserved |

`MIN_PROTOCOL_VERSION` rises to N−1 with each phase's release, not with
its contracts. Bump `PROTOCOL_VERSION`, in both `src/versions.ts` and
`go/messages.go`, when:
- a change is breaking; or
- the control plane must know whether an agent understands something new
  before sending it. Version 2 gates `build_job` and workload placement.
  Version 3 gates `build_cancel`, which a version 2 agent would drop, and
  `build_job.secret_build_args`, which it would ignore and then bake the
  secret values into the image. Version 4 replaces `WorkloadSpec.env` with
  the sealed `env_sealed` and seals build secrets (ADR 0014), so workloads
  and builds go only to agents at `SEALED_ENV_PROTOCOL_VERSION` that
  registered an encryption key.

Give each gated feature its own constant (see the table) and check it where
the control plane sends the frame or field. Purely additive optional fields
that an older agent may safely ignore need no bump. Changes to the envelope
or signing scheme need an ADR.

`AgentMessageSchema` is the Phase 1 set of agent frames the node DO
dispatches today; `AgentFrameSchema` is every agent frame (and generates
`schema/agent-message.json`). Likewise `LogSourceSchema` and
`AnyLogSourceSchema`. The DO moves to the complete unions with ADR 0013's
frame-table split.

### Credentials on the wire

A control frame carrying a credential (git token, registry password, object
storage keys, or a sealed box: every workload's `env_sealed` and a build
job's `build_secrets_sealed`) must have `exp - iat <= CREDENTIAL_FRAME_TTL_MS` (60 s). The
schemas reject longer-lived ones; `carriesCredentials` tells the sender which
TTL applies.

Every secret a Phase 2–3 frame carries travels in a sealed box with its own
purpose and AAD helper (`src/box.ts`, `go/boxes.go`): `job-env`
(`jobEnvAad`), `mesh-psks`, `registry-upstream`, `backup-parts` (presigned
part URLs), `restore` (download URL and age identity), `db-credential`, and
`cert-key`. Frames that always carry one are listed in
`CREDENTIAL_FRAME_TYPES`; `desired_state` also counts with sealed mesh PSKs
or a proxy registry upstream, and `cert_sync` with any upsert.
