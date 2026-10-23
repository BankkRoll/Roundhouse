# 0011: Cloudflare Containers provider

## Status

Proposed.
- Date: 2026-10-22
- Phase: 4
- Protocol: version 6 (`image_push`, edge gateway)
- Depends on: 0003 (builds, registry), 0005 (mesh, isolation), 0006
  (staged config), 0009 (Cloudflare API token plumbing, managed TLS,
  SaaS mode).

Names follow the Roundhouse rename (0013, "Naming").

## Context

Every workload runs on nodes the user operates. For stateless HTTP
services, the user's own Cloudflare account can run containers too: no
servers, scale to zero, global placement. The control plane already runs
in that account. The goal is a provider switch per service, `nodes` ↔
`cloudflare`, as one staged setting, with the same deploy, rollback and
variables model.

Facts (sources at the end; this area changes monthly):
- **Status and plan.** Containers have been GA since 2026-04-13, on the
  Workers Paid plan.
- **Model.** A container belongs to a Durable Object class in a Worker
  (`containers[]`: `class_name`, `image`, `max_instances`,
  `instance_type`). Requests reach it only through that Worker or Durable
  Object (`container.fetch`). There is no direct inbound TCP or UDP.
- **REST API.**
  - Containers: `GET/POST /accounts/{id}/containers/applications`,
    `GET/PATCH/DELETE …/applications/{app}`, plus `…/instances-v2`,
    `…/rollouts` and `…/versions`. A Durable-Object application must
    reference an **existing** DO namespace, so the Worker and its DO
    migration are uploaded first through the Scripts API
    (`PUT /accounts/{id}/workers/scripts/{name}`, multipart, `metadata`
    with `main_module`, `bindings`, `migrations`).
  - Worker routes: `POST /zones/{zone}/workers/routes { pattern, script }`.
  - Secrets: `PUT …/scripts/{name}/secrets`.
- **Registry.**
  - Images live at `registry.cloudflare.com/<account_id>/<image>:<tag>`.
    Temporary push and pull credentials come from
    `POST /accounts/{id}/containers/registries/{domain}/credentials`
    (default 15 min).
  - Docker Hub, ECR and Google Artifact Registry images can be pulled
    directly with the `default` scheduling policy, uncached. With the
    `durable_object` policy they must first be copied into the managed
    registry.
  - Image storage is 50 GB per account.
- **Instance types.**

  | Type       | vCPU | Memory  | Disk  |
  | ---------- | ---- | ------- | ----- |
  | lite       | 1/16 | 256 MiB | 2 GB  |
  | basic      | 1/4  | 1 GiB   | 4 GB  |
  | standard-1 | 1/2  | 4 GiB   | 8 GB  |
  | standard-2 | 1    | 6 GiB   | 12 GB |
  | standard-3 | 2    | 8 GiB   | 16 GB |
  | standard-4 | 4    | 12 GiB  | 20 GB |

  Custom types go up to 4 vCPU and 12 GiB, with at least 3 GiB per vCPU.
  Disk is ephemeral.
- **Billing.** Per 10 ms of active time. CPU has been billed on active
  usage only since 2025-11-21.
- **Scale to zero.** `@cloudflare/containers` `Container` has
  `defaultPort`, `sleepAfter` (default `10m`), `envVars`,
  `enableInternet`, `outbound`/`outboundByHost`, `startAndWaitForPorts`,
  and `getRandom` for stateless pools.
  - Cold starts are "often 1–3 s".
  - There is **no autoscaling** yet; `getRandom` over a fixed pool is the
    documented pattern.
- **Outbound.** Internet access is on by default. Outbound handlers
  intercept HTTP and HTTPS on ports 80 and 443 only, and can use every
  Workers binding. Whether raw TCP to arbitrary ports works is not
  documented.
- **Workers VPC** (beta, free during the beta) reaches private networks
  through Cloudflare Tunnel.
  - `vpc_services` bindings cover registered HTTP or TCP services.
  - `vpc_networks` bindings (public beta since 2026-04-14) allow `fetch`,
    and since 2026-06-16 `connect()`, to any host reachable through a
    tunnel.
  - It needs cloudflared 2025.7.0 or later with outbound UDP 7844.
  - No documented integration exists _for containers_. A container's HTTP
    can reach it only through an outbound handler.
- **Local development.** `wrangler dev` runs containers in the local
  Docker. No official fake of the Containers REST API exists.
- **Workers limits.** 500 scripts per account on Paid. 128 environment
  variables or secrets per Worker, each at most 5 KB.

## Decision

### Eligibility and settings

`PlacementConfig` gains a provider:

```ts
interface PlacementConfig {
  node_selector: Record<string, string>;
  provider: "nodes" | "cloudflare"; // default "nodes"
  cloudflare?: {
    instance_type: "lite" | "basic" | "standard-1" | "standard-2" | "standard-3" | "standard-4";
    max_instances: number; // 1..100; the getRandom pool size
    sleep_after: string; // "1m".."24h", default "10m"
    regions?: string[]; // `constraints`, when set
  };
}
```

A service may use `provider: "cloudflare"` only if all of these hold. The
apply-time validation in 0006 enforces them, with
`422 provider_ineligible` and the failing rule:
- `kind: "app"`;
- `networking.port` set;
- no volume;
- no TCP proxy;
- every domain is generated, or a SaaS-mode custom domain (0009);
- `resources` fit the instance type (`cpu_millis` and `memory_mb` ≤ the
  type's), or the type is derived from `resources` when it is omitted;
- the image is `linux/amd64`, recorded by the builder from the manifest.
  The amd64 requirement is to be confirmed (see "Open questions").

`deploy.replicas` is ignored; `max_instances` takes its role. A
`replicas` of 0 disables the provider without deleting anything.

The instance setting `cloudflare_account` holds the account ID and an API
token (sealed). The token needs Workers Scripts Edit, Workers Routes Edit
on the apps zone, Containers Edit, and Account Analytics Read. Setup
validates it by listing scripts and applications, and stores the
`workers.dev` subdomain.

The provider also requires the apps domain to be **proxied** through
Cloudflare. Worker routes only run on proxied hostnames. The setting
`apps_domain_proxied: true` makes the control plane create the
`*.<apps_domain>` record proxied (0009 `managed` mode). Edge TLS for a
wildcard one level below a zone apex needs Advanced Certificate Manager,
and the dashboard explains this when the apps domain is not the zone
apex.

### Runtime Worker

Each Cloudflare-provider service-environment gets one Worker script:
- **Name:** `rh-<base32(sha256(service_id "/" environment_id))[0..20]>`.
- **Code:** a generic runtime bundle, `apps/cf-runtime/`, built with the
  control plane and embedded in it as a text module.
- **Bindings:**
  - `APP`: a Durable Object namespace of class `AppContainer`, a
    `Container` subclass.
  - `CONTROL`: a service binding to the control-plane Worker's
    `RuntimeEnv` entrypoint.
  - `RH_RUNTIME_TOKEN`: a `secret_text`.
  - `RH_CONFIG`: a `plain_text` holding JSON
    `{ service_id, environment_id, port, max_instances, sleep_after, hostnames, health_path }`.
  - `METRICS`: the Analytics Engine dataset.

The script is uploaded with `migrations: { new_sqlite_classes: ["AppContainer"] }`
the first time.

```ts
// apps/cf-runtime/src/index.ts (shape)
export class AppContainer extends Container<Env> {
  defaultPort = config.port;
  sleepAfter = config.sleep_after;
  enableInternet = true;
  static outboundByHost = {
    /* "*.internal": meshGateway, see "Reaching node services" */
  };
  override async fetch(req: Request) {
    if (!(await this.getState()).status.startsWith("running")) {
      const { env, deployment_id } = await this.env.CONTROL.resolveEnv(this.env.RH_RUNTIME_TOKEN);
      await this.startAndWaitForPorts({ startOptions: { envVars: env } });
    }
    return this.containerFetch(req);
  }
}
export default {
  async fetch(req, env) {
    if (!config.hostnames.includes(new URL(req.url).hostname))
      return new Response("no route", { status: 404 });
    const started = Date.now();
    const res = await getRandom(env.APP, config.max_instances).then((c) => c.fetch(req));
    env.METRICS.writeDataPoint(/* edge_request row: status, latency */);
    return res;
  },
};
```

**Environment variables are never stored in Cloudflare Worker secrets.**
That would hit the 128-variable and 5 KB limits, and would leave every
resolved secret at rest in another product. `RuntimeEnv` is a
`WorkerEntrypoint` on the control plane, reachable only through service
bindings in the same account, never over HTTP. `resolveEnv(token)`:
1. verifies `token = HMAC-SHA256(derive(master, "runtime-token"), service_id "|" environment_id "|" generation)`,
   where `generation` is bumped on every Cloudflare deploy and on disable;
2. unseals the active Cloudflare deployment's `env_sealed`;
3. returns `{ env, deployment_id }`.

A cold start costs one RPC. The returned values live only in the
container's environment.

### Registry path

- **Git builds.** The builder pushes to its local registry as in 0003.
  The deploy workflow then mints push credentials
  (`POST /accounts/{id}/containers/registries/registry.cloudflare.com/credentials`
  with `push`, 15 min) and sends the builder a signed, credential-carrying
  frame (protocol 6):

  ```ts
  { type: "image_push"; ...ControlHeader; push_id: IdString;
    source: string;                    // "127.0.0.1:5000/prj_…/svc_…@sha256:…"
    target: string;                    // "registry.cloudflare.com/<account>/rh-<hash>:<deployment_id>"
    platform: "linux/amd64";
    username: string; password: string }
  ```

  The agent copies the manifest and blobs registry-to-registry with
  `go-containerregistry` (`remote.Write`), streaming with no local
  unpack. It answers `image_push_result { push_id, ok, digest?, error?,
  bytes? }`, and logs go out as a `task` log source.
- **Image sources** on `docker.io`, ECR or Google Artifact Registry are
  referenced directly (the `default` scheduling policy pulls them without
  caching). Any other registry is copied through a builder node like a
  git build.
- **Garbage.** After a successful deploy, the workflow keeps the last 5
  tags per script, which is what rollback needs, and deletes older ones.
  Image storage is capped at 50 GB per account, and Settings shows usage.

### Deploy and switching

The deploy workflow (0003) branches on `placement.provider` after
`resolve-variables` and the build. Steps for `cloudflare`:
1. **push**: `image_push`, or a direct reference.
2. **script**: upload or update the runtime script with the new
   `RH_CONFIG`, and rotate `RH_RUNTIME_TOKEN` (new generation). On first
   creation, look up the DO namespace ID of `(script, AppContainer)`.
3. **application**: `POST /containers/applications` the first time
   (`durable_objects.namespace_id`, `configuration.image`,
   `instance_type`, `max_instances`, `constraints`). Otherwise
   `POST …/applications/{id}/rollouts` with the new image. Wait for the
   rollout to finish, polling `GET …/applications/{id}` (≤ 10 min).
4. **warm**: request `https://<script>.<workers.dev subdomain><health_path>`
   with header `RH-Warm: <HMAC>`, which the runtime accepts once per
   generation. This starts one instance and checks the health path.
   `workers.dev` is enabled for the script so warm-up does not depend on
   routes. The runtime answers 404 on `workers.dev` to anything without a
   valid warm header.
5. **route**: for each hostname, `POST /zones/{zone}/workers/routes
   { pattern: "<host>/*", script }`, idempotent through a list-then-create.
   From here the edge sends traffic to the Worker instead of the origin
   (the ingress nodes).
6. **finalize**: mark the deployment `active` and the previous one
   `removed`. If the previous one ran on nodes, wait `drain_s` (≥ 30 s,
   for route propagation), then remove its placements.

**Switching back** to `nodes`: deploy to nodes with the normal pipeline
first, and wait until healthy. Then delete the Worker routes, so traffic
falls through to the origin. After `drain_s`, set the application's
`max_instances` to 0. The script and application are deleted 24 h later
by the minute tick, so a quick switch back reuses them.

**Rollback** to an earlier Cloudflare deployment re-runs steps 2, 3 and 5
with that deployment's tag (still in the registry), with no push.
Rollback to an earlier node deployment is the switch back.

```sql
CREATE TABLE cf_deployments (
  id TEXT PRIMARY KEY,                    -- cfd_…
  deployment_id TEXT NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  script_name TEXT NOT NULL, namespace_id TEXT, application_id TEXT,
  image_ref TEXT NOT NULL, image_digest TEXT,
  runtime_generation INTEGER NOT NULL,
  route_ids TEXT,                         -- JSON {hostname: route_id}
  status TEXT NOT NULL,                   -- pushing | uploading | rolling_out | warming | routing | active | removed | failed
  error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

`DEPLOYMENT_EVENT_TYPES` gains `image_pushed`, `cf_rollout_started`,
`cf_rollout_finished` and `routes_switched`.

### Reaching node services

Findings that set the scope:
- Container outbound HTTP or HTTPS on ports 80 and 443 can be intercepted
  by `outboundByHost`, and the handler can call a `vpc_networks` binding.
  Workers VPC reaches a tunnel-attached network.
- Raw TCP from a container (Postgres on 5432) can neither be intercepted
  nor routed through VPC by any documented path.

Decision for Phase 4:
- **HTTP to node services: supported, behind an experimental flag**
  (`cloudflare.mesh_access`, because Workers VPC is in beta).
  - **Gateway.** One or more nodes labelled
    `roundhouse.io/edge-gateway=true` run `sys_cloudflared`, a system
    workload pinned by digest (≥ 2025.7.0). It uses a remotely managed
    tunnel that the control plane creates through the Tunnel API, and its
    token is a credential in `desired_state.edge_gateway`.
  - **Exposure.** The tunnel publishes exactly one private address, the
    agent's **edge gateway** on `10.200.N.3:8443`. The gateway is an HTTP
    reverse proxy in the agent.
  - **Request path.** The runtime Worker's outbound handler for
    `*.internal` rewrites a request for
    `http://<svc>.<env>.<project>.internal:<port>/…` to the gateway. It
    adds `RH-Target: <svc>.<env>.<project>.internal:<port>` and
    `RH-Auth: <HMAC token for (environment_id, generation)>`, then calls
    `env.MESH.fetch()`, a `vpc_networks` binding by `tunnel_id`.
  - **Policy.** The gateway accepts a request only if `RH-Auth` is valid
    for the environment named in `RH-Target`. It resolves the target with
    the private DNS (0005) _as that environment_, and forwards over the
    mesh with the gateway node's own address. Receiving nodes admit
    gateway traffic through a per-environment set `gw_<tag>` that the
    control plane fills with gateway addresses for environments that have
    Cloudflare-provider services. Environment isolation therefore holds
    across the edge.
- **TCP (databases) from a Cloudflare container: not supported in
  Phase 4.**
  - Validation warns when a Cloudflare-provider service references a
    database's `DATABASE_URL`.
  - The TCP proxy (0004) needs a source allowlist, and Cloudflare
    container egress addresses are not fixed, so it is not a safe
    substitute.
  - Revisit if containers gain TCP outbound interception or a VPC
    integration.

Protocol 6:
- `desired_state.edge_gateway?: { listen: string; tunnel_token: string /* credential */; tokens: { env_tag: number; key_id: string; secret_hash: string }[] }`.
- The `sys_cloudflared` system workload, derived by the agent like
  `sys_registry`.

### Observability

- **Requests.** The runtime Worker writes one Analytics Engine row per
  request (`blob1: "edge_request"`, status class, latency) to the 0008
  dataset. The service's Metrics tab shows requests, latency p50/p95
  (`quantileExactWeighted`) and errors for Cloudflare-provider
  deployments.
- **Instances.** `GET …/applications/{id}/instances-v2` populates the
  instance count, polled every 60 s while the service page is open.
- **Logs.** The runtime script declares the control plane as a
  `tail_consumer`. The control plane's `tail()` handler stores Worker-side
  console output and exceptions as `system`-stream log lines of the
  deployment. **Container stdout is not covered** by any documented
  programmatic path. Live verification is required, and the dashboard
  links to the Cloudflare dashboard's container logs until then.

### Routes, RBAC, audit

| Method and path                                             | RBAC                                     | Audit                                                                |
| ----------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `GET`, `PUT /v1/instance/cloudflare`                        | `instance:manage` (session only)         | `instance.settings_updated`                                          |
| `POST /v1/instance/cloudflare/verify`                       | `instance:manage`                        | none                                                                 |
| `GET /v1/services/{serviceId}/cloudflare?environment_id=`   | `services:read`                          | none (status, instances, script)                                     |
| Provider switch: `config.patch` `placement.provider` (0006) | `services:manage` + `deployments:create` | `service.provider_changed` (per apply, besides `change_set.applied`) |

There are no new RBAC actions. New ID prefix: `cfd`.

### Dashboard

- **Service → Settings → Runtime.** A Nodes / Cloudflare segmented
  control. Choosing Cloudflare shows the eligibility checklist live
  (port, no volume, domains, image arch), the instance type (preselected
  from resources), max instances, sleep after, and a cost hint ("billed
  per 10 ms active; included: 25 GiB-h memory, 375 vCPU-min / month").
  Saving stages a change (0006).
- **During a switch**, the deployment timeline shows push → script →
  rollout → warm → routes → drain. Failures name the Cloudflare API error
  verbatim.
- **Settings → Cloudflare.** Account ID, token with a scope check, apps
  domain proxied status, the `workers.dev` subdomain, the image storage
  meter, and the edge gateway toggle (experimental) with gateway node
  selection.

## Security

- The Cloudflare API token is sealed, set from a session only, and scoped
  to what the provider uses.
- **Resolved environments.** They never leave the control plane except to
  a container through a same-account service binding, authenticated by a
  per-generation HMAC token that is rotated on every deploy and on
  disable.
- **`workers.dev`** answers only warm-up requests carrying a
  per-generation HMAC, so the script is not a second public entry point.
- **Registry credentials** are minted per push, live 15 minutes, travel
  in a 60 s signed frame, and are never written to disk by the agent.
- **Edge gateway access** is per environment: an HMAC token bound to one
  environment, checked by the gateway, plus receiving-node policy. A
  compromised runtime Worker of environment E reaches only E's services,
  as a node in E could.
- **Rollback** keeps working without network access to the builder,
  because tags stay in Cloudflare's registry.

## Testing strategy

What can be verified locally and what only live:

| Behaviour                                                                                                            | Local / CI                                                                                                                                                                                                                                                            | Live only                                           |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Runtime Worker: host check, `getRandom` pool, cold start through `resolveEnv`, warm-up auth, AE writes               | `wrangler dev` runs `apps/cf-runtime` with a container from a local image (Docker), plus the control plane as a second local Worker for the service binding                                                                                                           |                                                     |
| Deploy workflow orchestration (push → script → application → rollout → warm → routes → drain), switch back, rollback | **fake Cloudflare API** (`e2e/lib/fake-cloudflare.mjs`): Scripts upload (validates multipart metadata and migrations), DO namespace list, containers applications and rollouts with a scripted state progression, registry credentials, Workers routes, `workers.dev` | ✓ the real API's acceptance of our bodies           |
| Image copy to a registry with temporary credentials                                                                  | agent integration test copying to a local `registry:3` with htpasswd, standing in for `registry.cloudflare.com`                                                                                                                                                       | ✓ the real registry's auth flow and arch checks     |
| Edge gateway policy                                                                                                  | agent integration: gateway with HMAC check and environment-scoped resolution; the cloudflared hop is skipped                                                                                                                                                          | ✓ Workers VPC `vpc_networks.fetch` through a tunnel |
| Scale to zero, cold-start latency, route takeover latency, container stdout logs                                     | —                                                                                                                                                                                                                                                                     | ✓                                                   |
- **Real-stack e2e** (`e2e/phase4/cloudflare-provider.test.mjs`, with the
  fake API and `wrangler dev` for the runtime):
  1. A Next.js app on nodes, then switch to `cloudflare` through a change
     set. The fake API records the script upload, the application create
     and the route creates in order. Requests to the hostname through the
     local runtime Worker reach the container, and the node placements
     are removed after the drain.
  2. Switching back: node replicas are healthy _before_ the routes are
     deleted, with no failed request in a request loop at the runtime
     Worker and Caddy (the harness flips its "edge" from Worker to Caddy
     when the fake deletes the route).
  3. A rollback to the previous Cloudflare deployment issues a rollout
     with the old tag and no `image_push`.
  4. Ineligible configs (a volume, a TCP proxy, a direct-mode custom
     domain) give `422 provider_ineligible` at apply.
- **Live verification** (`scripts/verify-cloudflare-provider.mjs`, a
  maintainer account, run before each release that touches this code)
  covers the full flow on a real account and records the API responses,
  which then refresh the fake's fixtures.

## Rollout and compat

- **Protocol 6** (with 0012). `IMAGE_PUSH_PROTOCOL_VERSION = 6` and
  `EDGE_GATEWAY_PROTOCOL_VERSION = 6`. Builders below v6 cannot push, so
  the switch fails with `builder_outdated`.
- **Feature flag.** The provider is off until `cloudflare_account` is
  configured. The edge gateway is an extra experimental flag.
- **No change** to node-provider services.

## Consequences

- Stateless HTTP services can run on Cloudflare with one staged setting,
  keeping Roundhouse's variables, rollbacks and audit.
- **Dependence on fast-moving APIs.** The Containers REST API and Workers
  VPC are new and change monthly. The fake is only as good as the last
  live verification, which is why that verification is part of the
  release checklist.
- **Feature gaps.** Cloudflare-provider services have fewer features: no
  volumes, no TCP to node databases, no per-container CPU or memory
  metrics, and container stdout only in Cloudflare's dashboard for now.

## Open questions (need a live account)

- The exact request bodies `POST /containers/applications` and
  `…/rollouts` accept for Durable-Object applications, and how rollout
  progress is reported.
- Whether Containers accept only `linux/amd64` images. arm64 builders
  would then need cross-builds (BuildKit `--platform`) for
  Cloudflare-provider services.
- Whether raw TCP egress to arbitrary ports works from a container with
  `enableInternet`.
- Container stdout: is it available through Tail Workers, Logpush or an
  API?
- Edge certificate coverage when the apps domain is one level below the
  zone apex (Advanced Certificate Manager requirement), and how long route
  propagation takes.
- Workers VPC GA timing and pricing after the beta.

## Sources

- Containers GA (2026-04-13), https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/; overview (Workers Paid required), https://developers.cloudflare.com/containers/ (updated 2026-10-12)
- Wrangler `containers[]` configuration, https://developers.cloudflare.com/workers/wrangler/configuration/ (updated 2026-10-20)
- Containers REST API (applications, instances-v2, rollouts, versions), https://developers.cloudflare.com/api/resources/containers/ and https://developers.cloudflare.com/api/resources/containers/subresources/applications/methods/create/ (retrieved 2026-10-22)
- Registry, push, credentials, third-party registries, https://developers.cloudflare.com/workers/wrangler/commands/containers/ (updated 2026-04-23); image management, https://developers.cloudflare.com/containers/platform-details/image-management/ (updated 2026-09-30)
- Instance types and limits, https://developers.cloudflare.com/containers/platform-details/limits/ (updated 2026-10-21); pricing, https://developers.cloudflare.com/containers/pricing/ (updated 2026-10-05)
- `Container` class, https://developers.cloudflare.com/containers/container-package/ (updated 2026-09-30); low-level `ctx.container`, https://developers.cloudflare.com/containers/api/durable-object-container/ (updated 2026-09-30)
- Architecture, cold starts, inbound only through a Worker, https://developers.cloudflare.com/containers/platform-details/architecture/ (updated 2026-09-30); no autoscaling yet, https://developers.cloudflare.com/containers/beta-info/ (updated 2026-10-05)
- Outbound traffic and handlers (80/443 only), https://developers.cloudflare.com/containers/platform-details/outbound-traffic/ (updated 2026-10-12)
- Workers VPC, https://developers.cloudflare.com/workers-vpc/ (updated 2026-10-12); VPC services, https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/ (updated 2026-10-12); VPC networks, https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/ (updated 2026-10-15); tunnel requirements, https://developers.cloudflare.com/workers-vpc/configuration/tunnel/ (updated 2026-04-22); limits, https://developers.cloudflare.com/workers-vpc/reference/limits/
- Cloudflare Tunnel, https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/ (updated 2026-08-04)
- Local development with Docker, https://developers.cloudflare.com/containers/local-dev/ (updated 2026-09-30)
- Scripts upload API and metadata, https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/ and https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/; routes API, https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/create/; secrets API, https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/; service bindings (same account, RPC), https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/ (all retrieved 2026-10-22)
- Workers limits (500 scripts, 128 variables of 5 KB each on Paid), https://developers.cloudflare.com/workers/platform/limits/ (updated 2026-10-12)
