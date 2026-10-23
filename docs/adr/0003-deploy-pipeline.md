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
(by spec hash), and removes containers labelled `roundhouse.managed=true` that
are no longer listed. Containers run with `no-new-privileges`, all
capabilities dropped except those listed, a PID limit, and memory/CPU limits.
Each environment of a project gets its own Docker bridge network; see
"Environment networks" below.

The agent reports `workload_status` on every change and with each hello.
Runtime logs ship as batched `logs` frames (at most 64 KiB, flushed every
second), and the agent keeps a bounded on-disk buffer while disconnected.

### Ingress

Caddy runs on every node and is configured only through its admin API on
`localhost:2019` by the agent. Routes map hostnames to containers on their
environment network, resolved through the agent's DNS server so that moving a
route never reloads Caddy; see "Ingress swaps without reloads" below. TLS
mode is set per install:
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
`${{shared.VAR}}`, and built-ins (`PORT`, `ROUNDHOUSE_PUBLIC_DOMAIN`,
`ROUNDHOUSE_PRIVATE_DOMAIN`, `ROUNDHOUSE_ENVIRONMENT`, `ROUNDHOUSE_GIT_COMMIT_SHA`,
`ROUNDHOUSE_SERVICE_NAME`, `ROUNDHOUSE_DEPLOYMENT_ID`) are resolved only when
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
  `PROTOCOL_VERSION` is 2 and `MIN_PROTOCOL_VERSION` is 1. Version 3 is
  described under "Hardening" below.
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

## Rollback semantics

A rollback creates a new deployment that reuses the earlier deployment's image
digest and config version, but resolves variables as they are **now**. Each
deployment seals its own resolved environment when it starts, and a rollback
is a new deployment, so it gets the current service, shared and built-in
values rather than the ones the earlier deployment ran with.

This means a rollback undoes a bad build or config change, not a bad variable
change: to undo a variable change, change the variable back and deploy (or
roll back afterwards). The dashboard's rollback dialog says so before you
confirm.

## Instance settings audit

Instances have no audit log of their own. A change to an instance setting is
recorded as `instance.settings_updated` in every workspace the caller owns
(owners are the only ones who can make it), with the changed keys and their
before and after values, so it shows up in each of those workspaces' audit
logs. A request that changes nothing records nothing.

## Hardening (protocol 3)

Decisions made while hardening Phase 1.

### Environment networks

One network per project let a staging container reach production containers
by IP. Every environment now gets its own bridge network,
`environmentNetworkName(project_id, environment_id)`:
`roundhouse-<project_id>-<environment_id>`, or, when that would exceed the 128
characters the protocol allows for a network name,
`roundhouse-env-<hex SHA-256 of "<project_id>/<environment_id>">`. IDs always
contain `_` and the hash never does, so the two forms cannot collide. TS and
Go compute the name independently and agree on `fixtures/network-names.json`.
- Private domains (`<service>.<environment>.internal`) are network aliases on
  the environment's network only, so Docker's DNS answers them only inside
  that environment, and Docker's inter-bridge isolation drops traffic between
  environment networks, so another environment's address is unreachable.
- Migration needs no code path of its own: `network` is part of the spec
  hash, so a replica still on `roundhouse-<project_id>` gets a new hash and the
  reconciler replaces it with its usual zero-downtime rollout. The agent then
  removes the old project network once no container uses it. Every replica
  of a node moves in the same pass, so during that one rollout old replicas
  reach old ones and new replicas new ones, but an old replica cannot reach a
  new one by private domain.
- The agent does not second-guess `network`: the control plane is the
  source of truth, and an agent that rewrote it would split a project across
  old and new networks while its control plane is not yet upgraded.

### Node namespace

An agent sharing a Docker engine with another node used to manage, and
garbage-collect, every `roundhouse.managed=true` container. Every container and
network an agent creates is now labelled `roundhouse.namespace=<node ID>`, and
the agent manages only those. A Phase 1 container (no namespace) is adopted
once its workload ID is in this node's desired state, which the control plane
only puts there for workloads it placed on the node. The adoption is recorded
in `<data-dir>/adopted-containers.json`, so an adopted container is still
drained and removed after its workload is dropped, across restarts too.
Unlabelled containers whose workload is not desired are never touched.

### Build cancel

`build_cancel { build_id }` is a signed control frame. The control plane
sends it when a deployment is cancelled or superseded while building, and
when the deploy workflow fails a deployment whose build still runs (on the
build timeout, for example). The agent's dispatcher cancels the build's
context: the solve is cancelled and BuildKit drops the running step, git and
Railpack are killed by process group, and the job is answered with a failed
`build_result` carrying `cancelled: true`, which the control plane records as
a `cancelled` build. A job that arrives while a cancelled build is still
winding down waits for it instead of being refused as busy, so a redeploy
right after a cancel builds at once. A cancel for a build the node has not
seen yet is remembered (bounded); one for a finished build is ignored.

### Secret build args

`BuildConfig.secret_build_args` names the build args whose values are secret
(additive; it must name keys of `build_args`), and
`build_job.secret_build_args` carries the names. The Dockerfile builder
passes those args only as BuildKit secrets, with the arg's name as the
secret ID, read with `RUN --mount=type=secret,id=NAME,env=NAME`: a build arg
would be recorded in every later history entry (`|1 NAME=value`). Railpack
already passes every arg as a secret. The builder redacts marked values from
build output whatever their name, and keeps the name-based heuristic as a
fallback for args nobody marked.

### Protocol 3 and version gating

`PROTOCOL_VERSION` is 3 and `MIN_PROTOCOL_VERSION` stays 1, since every
version so far is additive. The control plane never sends `build_cancel`
below `BUILD_CANCEL_PROTOCOL_VERSION` (3), and never sends a `build_job` with
`secret_build_args` below `SECRET_BUILD_ARGS_PROTOCOL_VERSION` (3): a version
2 agent would ignore the field and bake the values into the image, so such a
deployment fails and asks for the builder to be upgraded instead.

### Ingress swaps without reloads

Every Caddy config change through the admin API, a whole `POST /load` or a
granular `PATCH`, provisions new apps and shuts the old HTTP servers down. A
connection whose first request the old server reads after its shutdown began
is closed without an answer: about one request in 5,000 under a request
loop, at every upstream swap.

Options considered, after reading Caddy's documentation and the source of
the version we pin (2.11.7, `modules/caddyhttp/reverseproxy`):
- **A stable per-route local upstream that the agent proxies and switches
  atomically.** Swaps would be a pointer change in the agent, but the agent
  joins the data path: an agent restart or crash drops every request.
  Rejected.
- **Dynamic upstreams with the `srv` source.** It has a `grace_period` that
  keeps stale answers while the DNS server is down, but SRV targets are
  hostnames that Caddy resolves again at dial time through the system
  resolver, which knows nothing about container addresses. Rejected.
- **Dynamic upstreams with the `a` source, against a DNS server the agent
  runs on loopback.** Chosen.

Each route (host and path prefix) gets, per container port, the name
`<hash>.upstreams.roundhouse.invalid.`: `.invalid` is reserved (RFC 6761), so
the name can never leak to a public resolver, and the trailing dot stops a
search domain being appended. The route's reverse proxy has
`dynamic_upstreams` `{"source": "a", "name": …, "port": …, "refresh": "1s",
"resolver": {"addresses": ["127.0.0.1:2021"]}, "versions": {"ipv4": true}}`
(a `multi` source while a route spans two ports) and no static upstreams. The
agent answers those names authoritatively over UDP and TCP with the replicas
the runtime picks, and refuses every other name.
- Caddy's config now depends only on the routes, their ports and the TLS
  mode, so a full `/load` happens only when a hostname or path is added or
  removed, a route's port changes, or the TLS mode changes; never for a swap.
  A swap changes only the DNS answer, which Caddy picks up within the 1 s
  refresh, so a replaced container keeps serving for at least `SwitchDelay`
  (2 s) after routes leave it, whatever its `drain_s`.
- A route stays in the config while it is desired, even with no healthy
  replica, so a crash-looping replica costs no reloads. Requests to it get a
  503 after `try_duration` rather than a 404.
- With no static upstreams, a failed lookup leaves Caddy with no upstream,
  which it retries for any method (nothing was sent) every 100 ms for the 5 s
  `try_duration`. With static upstreams it would fall back to them, and they
  would be stale after the first swap. So while the agent restarts, requests
  wait for its DNS server instead of failing. The agent persists the answers
  in `<data-dir>/ingress-upstreams.json` and serves them as soon as it
  starts, before its first desired state, and a restarted agent that finds
  Caddy already running the config it wants does not reload it.
- Caddy caches A answers in a process-wide map of 100 entries and evicts a
  random one when it is full. On a node with more routes that costs extra
  lookups over loopback, not correctness.

The ingress integration test `TestSwapsNeverReloadCaddy` swaps a route
between two upstreams 200 times under request loops on fresh and kept-alive
connections: no failed or reset request, one load in total, and no upstream
address in Caddy's config. The Phase 1 end-to-end suite now fails on any
reset (it used to retry one) across five redeploys in a row.

### Log flushes

The node's Durable Object flushed buffered log lines on a `setTimeout`, which
could fire after the environment was torn down, or in tests after the next
test wiped the tables, failing the `log_chunks` foreign key. Flushes now run
on the Durable Object's alarm, whose lifetime the runtime owns, and a chunk
whose deployment or build no longer exists is dropped before anything is
written to R2. A foreign key failure in the window between that check and
the insert deletes the R2 object and is not logged as an error.

### BuildKit and AppArmor's user namespace restriction

Ubuntu 23.10 and later set `kernel.apparmor_restrict_unprivileged_userns=1`,
which stops an unconfined process from creating a usable user namespace.
Rootless BuildKit's rootlesskit needs one, so `sys_buildkitd` under
`apparmor=unconfined` crash-looped (`fork/exec /proc/self/exe: permission
denied`) and every build failed on Ubuntu 24.04 hosts, including GitHub's
runners. BuildKit's docs suggest setting the sysctl to 0; that lifts the
restriction for the whole host, so we do not.

Instead, on builders whose kernel lets AppArmor mediate user namespaces,
`install.sh` writes `/etc/apparmor.d/roundhouse-buildkit`
(`install/roundhouse-buildkit.apparmor`) and loads it with `apparmor_parser
-r`. Following Ubuntu's pattern for applications that need user namespaces,
the profile is `flags=(unconfined)` plus `userns,`: no broader than the
`apparmor=unconfined` BuildKit documents for rootless containers, and it
attaches to no executable, so only a container started with
`apparmor=roundhouse-buildkit` runs under it. A load failure is fatal only
while the restriction is on. `uninstall.sh` unloads and removes it.

The agent picks `sys_buildkitd`'s profile once per process: the
`ROUNDHOUSE_BUILDKIT_APPARMOR_PROFILE` override if set; `unconfined` if the
engine does not report AppArmor; otherwise the profile when
`/sys/kernel/security/apparmor/profiles` lists it, and, when that file cannot
be read (an agent in a container), whether the engine can start a no-op
container under it. The profile is part of the daemon's config hash, so a
change recreates the container. When the daemon still fails with the user
namespace signature, the build error says how to load the profile, and the
next build resolves the profile again. CI's Phase 1 job loads the profile by
calling the installer's own `install_buildkit_apparmor` on the runner.

An enforcing profile scoped to what rootlesskit and buildkitd actually do
would be tighter than either; it is left until it can be tested on real
AppArmor hosts across BuildKit upgrades.
