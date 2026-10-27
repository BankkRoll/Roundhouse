# 0015: Phase 2–3 wire contracts

## Status

Accepted.
- Date: 2026-10-23
- Implements the protocol parts of 0004, 0005, 0008, 0009, 0010 and 0014 §13.
- Amends 0013 ("Protocol versions") and, where noted below, the frame
  shapes in those ADRs.

## Context

ADR 0013 asks for one contracts PR per phase, merged before any stream
starts, so feature streams build the agent and control-plane sides in
parallel without touching `packages/protocol`. Two things changed since
0013 was written:
- The security branch merged first and took protocol 4 for sealed
  environments (0014 §6).
- 0014 requires every credential a later frame carries to travel sealed
  to the node, not just under the 60 s credential TTL.

This ADR records the shapes that resulted, where they differ from the source
ADRs, and which stream consumes what. The schemas in `packages/protocol/src`
are the source of truth; this is the map.

## Decision

### Versions

Every phase moves up by one. Phase 4's frames are left to its own contracts
PR.

| Version | Phase    | Gates (TS `*_PROTOCOL_VERSION`, Go `*ProtocolVersion`)   |
| ------- | -------- | -------------------------------------------------------- |
| 4       | ADR 0014 | `SEALED_ENV`                                             |
| 5       | 2        | `MESH`, `VOLUMES`, `BACKUPS`, `DB_QUERY`, `KEY_ROLLOVER` |
| 6       | 3        | `JOBS`, `METRICS`, `CERTS`                               |
| 7       | 4        | reserved: `EXEC`, `IMAGE_PUSH`, `EDGE_GATEWAY`           |

`PROTOCOL_VERSION = 6` (`src/versions.ts`, `go/messages.go`).
`MIN_PROTOCOL_VERSION` stays 3: 0013 raises it to N−1 with each phase's
_release_, and both phases' contracts land at once. Every addition is a new
frame type or an optional field, so agents from 3 up keep decoding what
they are sent; the control plane sends nothing above an agent's version.

### Secrets on the wire

New box purposes, each with an AAD helper in `box.ts` and an `Open*` helper
in `go/boxes.go`:

| Purpose             | Carried in                                                        | AAD binds                        | Plaintext                             |
| ------------------- | ----------------------------------------------------------------- | -------------------------------- | ------------------------------------- |
| `job-env`           | `job_run.workload.env_sealed`                                     | node, run, workload              | `{env, files}`                        |
| `mesh-psks`         | `desired_state.mesh.psks_sealed`                                  | node, generation                 | `{psks: {node_id: key}}`              |
| `registry-upstream` | `desired_state.registry.upstream.password_sealed`                 | node, generation                 | `{password}`                          |
| `backup-parts`      | `parts_sealed` of `backup_job`, `backup_parts`, `volume_copy_out` | node, backup                     | `{parts: [{part_number, url}]}`       |
| `restore`           | `secrets_sealed` of `restore_job`, `volume_copy_in`               | node, restore or migration       | `{download_url, age_identity}`        |
| `db-credential`     | `db_query.credential_sealed`                                      | node, request                    | `{username, password, new_password?}` |
| `cert-key`          | `cert_sync.upserts[].key_sealed`                                  | node, certificate, chain SHA-256 | `{key_pem}`                           |

Always credential-bearing (`CREDENTIAL_FRAME_TYPES`): `backup_job`,
`backup_parts`, `restore_job`, `volume_copy_out`, `volume_copy_in`,
`db_query`, `job_run`. Conditionally: `desired_state` (also with sealed PSKs
or a proxy upstream) and `cert_sync` (with upserts). WireGuard private keys
never leave the node.

### Frames and fields

| Feature (stream)                | Control → agent                                                                                                                                                                                                                                 | Agent → control                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mesh (2A agent, 2C control)     | `desired_state.mesh`; `registry.mode`, `mesh_listen`, `upstream`, `pull_users`; workload `kind: "route"`, `upstreams`, `mesh_ip`, `private_dns`                                                                                                 | `hello.mesh`, `capabilities.ingress`; `mesh_status`, `mesh_key`                                                                                           |
| Volumes, backups, data (2B, 2D) | `desired_state.volumes`; workload `mounts`, `rollout`, `stop_grace_s`, `exec` probes, `ports[].publish`, `publish_allowed_cidrs`; `volume_delete`, `backup_job`, `backup_parts`, `restore_job`, `volume_copy_out`, `volume_copy_in`, `db_query` | `hello.volume_quota`; `volume_status`, `backup_parts_request`, `backup_progress`, `backup_result`, `restore_result`, `db_query_result`; `task` log source |
| Signing-key rollover (2J)       | `welcome.next_keys`, `key_announce`                                                                                                                                                                                                             | `hello.pinned_kids`                                                                                                                                       |
| Cron and pre-deploy (3A)        | `job_run` (workload `kind: "job"`), `job_cancel`                                                                                                                                                                                                | `job_status`; `job` log source                                                                                                                            |
| Metrics (3B)                    | `welcome.metrics_interval_ms`                                                                                                                                                                                                                   | `metrics`                                                                                                                                                 |
| Domains and TLS (3F)            | `tls_mode: "managed"`, `desired_state.ingress` and `certificates`, wildcard route hostnames, route `hsts`, `cert_sync`                                                                                                                          | `cert_ack`, `cert_request`, `cert_status`                                                                                                                 |

Rules both languages enforce, beyond formats and limits:
- A mount names a volume listed in the same `desired_state`, owned by the
  workload's own project, environment and service; mount paths are
  absolute, normalised, and never `/`, `/proc`, `/sys`, `/dev` or
  `/run/secrets`.
- Route workloads need the mesh, routes and upstreams, and have no
  environment; job workloads have no ports, routes or probe and never
  restart; only service workloads mount volumes or publish ports.
- `managed` TLS needs `ingress`; mesh addresses lie inside the supernet;
  peers need sealed PSKs.
- A `welcome` or `key_announce` that announces its own envelope `kid` is
  rejected as `malformed` by `verifyEnvelope` and Go's `VerifyEnvelope`.
  Announced keys: at most 2, distinct kids (`SIGNING_KEY_ID_RE`), 32-byte
  public keys, `not_before` in unix seconds, positive.

Spec hash: `mounts`, `private_dns` and `ports[].publish` are hashed;
`rollout`, `stop_grace_s`, `publish_allowed_cidrs`, `mesh_ip` and
`upstreams` are not. Optional arrays that are hashed have `min(1)`, so
TypeScript and Go never disagree over `[]` versus absent.

### Departures from the source ADRs

- **Versions** are 5 and 6, not 4 and 5 (above).
- **Sealed instead of plain**: 0005's `peers[].preshared_key` becomes
  `mesh.psks_sealed`; 0005's registry `upstream.password` becomes
  `password_sealed`; 0004's `parts[].url`, `download_url`, `age_identity`
  and `credential` move into boxes; 0009's `key_pem` becomes `key_sealed`
  with the chain's digest in `sha256`.
- **`job_run`** is always credential-bearing (0010 said only with registry
  credentials), because its environment is a sealed box.
- **Route workloads**: `upstreams` is not hashed (0005 said it was); the
  agent applies it through its upstream DNS, as it does `routes`.
- **TCP proxy sources** travel as `publish_allowed_cidrs` (0004 left the
  field unnamed), unhashed so allowlist edits don't restart the database.
- **`TLS_MODES`** keeps its three operator modes, which `@roundhouse/shared`
  mirrors; `INGRESS_TLS_MODES` adds `managed` for `desired_state.tls_mode`.
  The domains stream adds `managed` to the shared settings when it ships.
- **Agent unions**: `AgentMessageSchema` and `LogSourceSchema` stay the
  Phase 1 sets the node DO's dispatch narrows on; `AgentFrameSchema` and
  `AnyLogSourceSchema` are complete and generate `schema/agent-message.json`.
  The DO moves to them with 0013's frame-table split.
- **`metrics.source`** (`cgroup_v2` or `docker_stats`) carries 0008's
  "approximate (cgroup v1)" note.
- **Copies reuse answers**: `volume_copy_out` is answered by the backup
  frames for its `backup_id`; `volume_copy_in` by `restore_result` with
  `restore_id` = `migration_id`.
- **Queries**: a MongoDB command document is JSON text in `raw.statement`;
  SQL parameters are text or `null`.
- **Hello** gains `volume_quota` (the migration check needs it) and
  `pinned_kids` (0014 §13 reports which kids each node pins).
- **Credential rotation** (amendment, 2026-10-23): `DbOp` gains
  `set_password { user }`, admin mode only. The new password travels only
  in the `db-credential` box as `new_password` (charset `[A-Za-z0-9._~-]`,
  16–256), never in the op, so neither the frame nor the query audit
  carries it. Agents advertise support as `capabilities.db_set_password`.
- **Published ports** (amendment, 2026-10-23): agents that enforce
  `publish_allowed_cidrs` advertise `capabilities.tcp_proxy`; the control
  plane must send `ports[].publish` only to them. The allowlist is an iptables
  chain jumped from `DOCKER-USER` and `INPUT` (ADR 0004, "TCP proxy"),
  not the nftables table 0004 first described. `host_ip: "::"` means dual
  stack (bound on `0.0.0.0` and `::`, rules in both families); the
  control plane sends it only for an allowlist with an IPv6 block.

## Consequences

- Feature streams work against fixed shapes: every new frame has a signed
  fixture whose boxes the Go tests open, and both suites share
  `formats.json` for the hand-written IP, CIDR, endpoint, mount-path and
  wildcard parsers.
- The Go agent advertises `ProtocolVersion` from the protocol package, so
  it now says 6 before its Phase 2–3 handlers exist. Control-plane streams
  gate on the version as specified; agent streams land each handler before
  their control-plane counterpart sends the frame, and the compat e2e of
  each phase checks it.
- Sealing every credential costs one X25519 operation per box on each side,
  in exchange for frames whose capture or storage reveals nothing.

## Open questions

- Should `MIN_PROTOCOL_VERSION` jump straight to 5 when Phase 2 ships,
  dropping protocol 3 and 4 agents together?
- Phase 4 (`exec_*`, `image_push`, `edge_gateway`) needs its own contracts
  pass at version 7, with `image_push` credentials and the edge-gateway
  tunnel token sealed the same way.
