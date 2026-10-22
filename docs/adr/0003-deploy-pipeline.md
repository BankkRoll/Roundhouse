# 0003: Deploy pipeline (projects, builds, deployments, ingress, logs)

## Status

Accepted.

## Context

Phase 0 connects servers. Phase 1 makes them run software: a push or a click
turns into a running container behind HTTPS, with logs, variables, and
rollback. The pieces (control plane, agent, builder, ingress, dashboard) are
built in parallel, so their contracts are fixed here.

## Decisions

### Resources

`workspace → project → environment → service`. Every project gets a
`production` environment on creation. A service has one **config version**
per environment; configs are immutable rows and a deployment references the
exact version it ran with, so rollback and diffs are exact.

Service sources:

| `source.type` | Meaning                                       | Build                                                    |
| ------------- | --------------------------------------------- | -------------------------------------------------------- |
| `image`       | Run a public or private image reference as-is | none                                                     |
| `git`         | Clone a repository at a commit                | Railpack, or a Dockerfile when `build.dockerfile` is set |

Git access uses a GitHub App when one is installed for the repository, and
falls back to anonymous HTTPS for public repositories, so every flow is
testable without a GitHub account.

### Pipeline

A deployment moves through
`queued → building → deploying → active` (or `failed`, `crashed`,
`cancelled`, and later `removed` / `rolled_back` once superseded).
1. **Create**: snapshot the config version, create `deployments` and
   (for git) `builds` rows.
2. **Build**: send a signed `build_job` to a node with `capabilities.builder`.
   The builder clones, builds with BuildKit, pushes to its local registry,
   and answers with `build_result` (image digest) or failure. Build logs stream
   as `logs` frames.
3. **Schedule**: a pure function chooses nodes (filter: online, docker,
   free memory; score: bin-packing with a spread penalty for replicas).
   Memory is never overcommitted; CPU may be up to 2x.
4. **Roll out**: bump each target node's `desired_generation` and push
   `desired_state` with the new workloads alongside the old ones. The agent
   starts the new container, waits for its health check, switches the Caddy
   route, then removes the old container after a drain period.
5. **Finalize**: when every replica reports `healthy`, mark the deployment
   `active` and the previous one `removed`.

The pipeline is a Cloudflare Workflow so each step retries and survives
isolate restarts. Waiting for a build or for health uses Workflow events
emitted from the node's Durable Object. Timeouts mark the deployment
`failed` with a reason.

Rollback creates a new deployment from an earlier deployment's image digest
and config version; it skips the build.

### Agent workloads

`desired_state.workloads[]` is the complete list for the node. The agent
converges Docker to it: it creates what is missing, recreates what changed
(by spec hash), and removes containers labelled `openrail.managed=true` that
are no longer listed. Containers run with `no-new-privileges`, all
capabilities dropped except those listed, a PID limit, and memory/CPU limits.
Each project gets a Docker bridge network `openrail-<project_id>`.

The agent reports `workload_status` on every change and with each hello.
Runtime logs ship as batched `logs` frames (at most 64 KiB, flushed every
second), and the agent keeps a bounded on-disk buffer while disconnected.

### Ingress

Caddy runs on every node and is configured only through its admin API on
`localhost:2019` by the agent. Routes map hostnames to a container's IP and
port on the project network. TLS mode is set per install:
- `acme`: on-demand certificates; Caddy's `ask` endpoint is served by the
  agent on `127.0.0.1:2020` and allows only hostnames in its desired routes.
- `internal`: Caddy's local CA (development and tests).
- `off`: plain HTTP (tests).

Generated domains are `<service>-<environment>-<4 chars>.<apps_domain>`.
`apps_domain` is an instance setting (for local development,
`127.0.0.1.nip.io`).

### Registry

The builder node runs a CNCF `distribution` registry as a system workload,
listening on `127.0.0.1:5000`, with filesystem storage by default and S3
(R2) when configured. Phase 1 places builds and workloads on nodes that can
reach that registry: the builder itself, or any node once the WireGuard mesh
(Phase 2) exposes the registry privately. Images are referenced by digest.

### Variables

Values are encrypted with a per-project data key (AES-256-GCM), itself
sealed by the master-derived KEK. References `${{service.VAR}}`,
`${{shared.VAR}}`, and built-ins (`PORT`, `OPENRAIL_PUBLIC_DOMAIN`,
`OPENRAIL_PRIVATE_DOMAIN`, `OPENRAIL_ENVIRONMENT`, `OPENRAIL_GIT_COMMIT_SHA`,
`OPENRAIL_SERVICE_NAME`, `OPENRAIL_DEPLOYMENT_ID`) are resolved only when
building a node's desired state. Cycles and unknown references are errors at
deploy time. Secret values never appear in API responses unless explicitly
revealed (audited) and never in logs: the control plane redacts known
secret values from ingested log lines.

### Logs

The node's Durable Object writes log batches to R2 as NDJSON chunks
(`logs/<project>/<service>/<yyyy>/<mm>/<dd>/<hh>/<chunk>.ndjson`) and indexes
them in D1, and forwards them to the project's `ProjectRoom` Durable Object,
which fans them out to subscribed browsers over a hibernatable WebSocket at
`/v1/projects/:id/realtime`. The same socket carries deployment status
changes.

### GitHub

The setup flow creates a GitHub App through the manifest flow and stores its
credentials sealed in `instance_settings`. Webhooks arrive at
`POST /v1/webhooks/github` and are verified with `X-Hub-Signature-256` in
constant time before parsing. A push to a service's tracked branch creates a
deployment; installation tokens are minted per build and are valid for at most
one hour.

### Contract details

Decisions made while fixing the contracts, which the sections above leave
open:
- **Protocol version 2.** The change is additive, but the control plane must
  not send `build_job` to, or place workloads on, a version 1 agent, so
  `PROTOCOL_VERSION` is 2 and `MIN_PROTOCOL_VERSION` is 1.
- **System workloads are agent-owned.** `desired_state.workloads` lists only
  `service` workloads. A builder node derives its registry and BuildKit
  workloads from `desired_state.registry`, uses the same `WorkloadSpec` type
  with IDs `sys_<name>` and null ownership IDs, and reports their status with
  a null `deployment_id`.
- **Spec hash.** SHA-256 of canonical JSON (sorted keys, nulls dropped,
  integers only, minimal string escaping), excluding `routes`,
  `registry_auth` and `drain_s`: those change without recreating the
  container. TS and Go implement it independently and share test vectors.
- **Credential TTL.** A control frame carrying a git token, a registry
  password or S3 keys expires at most 60 s after issue; the schemas reject
  longer ones.
- **Frame limits.** Agent frames up to 512 KiB encoded; a `logs` frame up to
  500 lines and 64 KiB of line text (16 KiB per line); control frames up to
  4 MiB, the agent's read limit.
- **Local image names.** `127.0.0.1:5000/<project_id>/<service_id>`, with the
  IDs lowercased because registry path components must be.
- **Health without a probe.** A replica with no probe (or `none`) reports
  `healthy` as soon as it runs; otherwise `running` means the probe has not
  passed yet.
- **Deployment states.** A deployment that never becomes healthy is
  `failed`. `crashed` is reachable only from `active`, and returns to
  `active` if the replicas recover.
- **References.** The namespace is the service slug, so `shared` is a
  reserved slug. `${{NAME}}` refers to the same service's variable, then its
  built-ins. A service's own variables override its built-ins. Shared
  variables are injected only where referenced. Resolved values are capped
  at 32 KiB.
- **Scheduling order.** Spreading a service's replicas always beats
  bin-packing; ties go to the lowest node ID, so placement is deterministic.
- **Instance settings.** Instances have no roles; `instance:manage` is held by
  whoever is `owner` of any workspace. A null `apps_domain` disables
  generated domains.
- **Realtime log subscriptions.** Deployment and service updates reach every
  socket of the project; log lines reach only sockets that sent `subscribe`
  for that deployment or build.
- **Log pages.** Log routes return the newest page first, in chronological
  order, with a cursor to older lines; live lines arrive over the socket.

## Consequences

- Every piece can be tested without a GitHub account or a public domain: image
  and public-git sources, `internal`/`off` TLS, and a local registry.
- Multi-node pulls depend on the Phase 2 mesh; until then the scheduler only
  places git-built workloads on nodes that can reach the builder's registry.
- Workflows add a binding the deploy button must provision.
