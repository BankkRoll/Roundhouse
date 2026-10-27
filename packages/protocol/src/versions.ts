/**
 * Protocol versions and the per-feature gates the control plane checks
 * before sending a frame or field. Mirrored by the constants at the top of
 * `go/messages.go`.
 *
 * ADR 0013 planned one version per phase (Phase 2 = 4, 3 = 5, 4 = 6). Version
 * 4 went to sealed environments (ADR 0014) when the security branch merged
 * first, so every phase moved up by one (ADR 0015):
 *
 * | Version | Phase      | Gates                                                    |
 * | ------- | ---------- | -------------------------------------------------------- |
 * | 2       | 1          | workloads, builds                                        |
 * | 3       | 1          | `build_cancel`, secret build args                        |
 * | 4       | ADR 0014   | sealed env and build secrets                             |
 * | 5       | 2          | mesh, volumes, backups, `db_query`, signing-key rollover |
 * | 6       | 3          | jobs, metrics, certificates                              |
 * | 7       | 3, 4       | preview build isolation; exec (web shell), image push    |
 *
 * @module
 */

/**
 * Current wire protocol version, sent by agents in `hello`.
 *
 * - Version 2 (Phase 1) is additive: every version 1 frame is still valid,
 *   and a version 1 agent still decodes version 2 `desired_state`. It is
 *   bumped anyway because the control plane must know whether an agent
 *   understands `build_job`, runs workloads, and reports statuses and logs.
 * - Version 3 is additive too: `build_cancel`, `build_job.secret_build_args`
 *   and `build_result.cancelled`. See {@link BUILD_CANCEL_PROTOCOL_VERSION}
 *   and {@link SECRET_BUILD_ARGS_PROTOCOL_VERSION}.
 * - Version 4 (ADR 0014) replaces `WorkloadSpec.env` with `env_sealed`, adds
 *   `build_job.build_secrets_sealed`, `project_id` and `service_id`, and
 *   `hello.encryption_key`. See {@link SEALED_ENV_PROTOCOL_VERSION}.
 * - Version 5 (Phase 2, ADRs 0004, 0005, 0014 §13): the WireGuard mesh,
 *   route workloads, volumes and mounts, `exec` probes, `stop_first`,
 *   published ports, backup/restore/copy frames, `db_query`, `task` logs,
 *   `volume_status`, and signing-key rollover.
 * - Version 6 (Phase 3, ADRs 0008, 0009, 0010): `job_*`, `metrics`,
 *   `cert_*`, wildcard routes, HSTS, `desired_state.ingress`, and the
 *   `managed` TLS mode.
 * - Version 7 (Phase 3, ADRs 0007 and 0014 section 14): `build_job.isolation`.
 *   See {@link PREVIEW_BUILDS_PROTOCOL_VERSION}.
 * - Version 7 (Phase 4, ADRs 0011, 0012): `exec_*` (web shell) and
 *   `image_push`/`image_push_result`. The edge gateway (ADR 0011) has no
 *   frames yet: Workers VPC is in beta and needs a live account to design
 *   against.
 *
 * Every field or frame added after version 4 is optional on the wire or a new
 * frame type, so agents from {@link MIN_PROTOCOL_VERSION} up keep working:
 * the control plane sends each only at or above its gate.
 */
export const PROTOCOL_VERSION = 7;

/**
 * Oldest `hello.protocol_version` the control plane accepts. An older
 * agent's `hello` is answered with close code 4002 (`agent_outdated`). ADR
 * 0013 raises it to N−1 with each phase's release; the contracts for Phases 2
 * and 3 land together, so it stays where it is until those releases ship.
 */
export const MIN_PROTOCOL_VERSION = 3;

/**
 * First protocol version whose agents run workloads and builds. Every
 * accepted agent is past it; {@link SEALED_ENV_PROTOCOL_VERSION} is the gate
 * that matters for placement now.
 */
export const WORKLOADS_PROTOCOL_VERSION = 2;

/** First protocol version whose agents understand `build_cancel`. */
export const BUILD_CANCEL_PROTOCOL_VERSION = 3;

/**
 * First protocol version whose agents honour `build_job.secret_build_args`.
 * A build with secret args is never sent to an older agent.
 */
export const SECRET_BUILD_ARGS_PROTOCOL_VERSION = 3;

/**
 * First protocol version whose agents open sealed boxes: `env_sealed`,
 * `build_job.build_secrets_sealed`, `hello.encryption_key` and the join
 * request's `encryption_public_key`. No workload or build goes to an older
 * agent.
 */
export const SEALED_ENV_PROTOCOL_VERSION = 4;

/**
 * First protocol version whose agents run the WireGuard mesh (ADR 0005):
 * `hello.mesh`, `desired_state.mesh`, `mesh_status`, `mesh_key`, route-only
 * workloads, `mesh_ip`, `private_dns`, `capabilities.ingress` and the
 * registry's `mode`, `mesh_listen`, `upstream` and `pull_users`.
 */
export const MESH_PROTOCOL_VERSION = 5;

/**
 * First protocol version whose agents hold volumes (ADR 0004):
 * `desired_state.volumes`, `mounts`, `rollout`, `stop_grace_s`, `exec`
 * probes, `ports[].publish`, `publish_allowed_cidrs`, `volume_status`,
 * `volume_delete` and `hello.volume_quota`. The scheduler's
 * `minProtocolVersion` keeps volume services off older agents.
 */
export const VOLUMES_PROTOCOL_VERSION = 5;

/**
 * First protocol version whose agents back up and restore (ADR 0004):
 * `backup_job`, `backup_parts`, `restore_job`, `volume_copy_out`,
 * `volume_copy_in` and their answers, and `task` log sources.
 */
export const BACKUPS_PROTOCOL_VERSION = 5;

/** First protocol version whose agents answer `db_query` (ADR 0004). */
export const DB_QUERY_PROTOCOL_VERSION = 5;

/**
 * First protocol version whose agents pin successor signing keys (ADR 0014
 * §13): `welcome.next_keys`, `key_announce` and `hello.pinned_kids`.
 */
export const KEY_ROLLOVER_PROTOCOL_VERSION = 5;

/**
 * First protocol version whose agents run jobs (ADR 0010): `job_run`,
 * `job_cancel`, `job_status`, `job` log sources and `job` workloads.
 */
export const JOBS_PROTOCOL_VERSION = 6;

/**
 * First protocol version whose agents sample containers (ADR 0008). Such an
 * agent sends `metrics` only when `welcome.metrics_interval_ms` is present.
 */
export const METRICS_PROTOCOL_VERSION = 6;

/**
 * First protocol version whose agents take certificates from the control
 * plane (ADR 0009): `cert_sync`, `cert_ack`, `cert_request`, `cert_status`,
 * `desired_state.certificates` and `ingress`, the `managed` TLS mode,
 * wildcard route hostnames and route `hsts`.
 */
export const CERTS_PROTOCOL_VERSION = 6;

/**
 * First protocol version whose agents build `build_job.isolation: "preview"`
 * in a separate per-project preview BuildKit daemon and cache (ADR 0014
 * section 14). A pull request build never goes to an older agent: one
 * would ignore the field and build in the project's regular daemon.
 */
export const PREVIEW_BUILDS_PROTOCOL_VERSION = 7;

/**
 * First protocol version whose agents run web shell sessions (ADR 0012):
 * `exec_open`, `exec_input`, `exec_resize`, `exec_close`, `exec_opened`,
 * `exec_output` and `exec_exit`. The dashboard tells users of older agents
 * to upgrade instead of opening a shell.
 */
export const EXEC_PROTOCOL_VERSION = 7;

/**
 * First protocol version whose builders copy images to another registry
 * (ADR 0011): `image_push` and `image_push_result`. A Cloudflare deploy of
 * a git build with no such builder fails with `builder_outdated`.
 */
export const IMAGE_PUSH_PROTOCOL_VERSION = 7;
