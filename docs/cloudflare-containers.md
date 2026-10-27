# Cloudflare Containers

A service can run on Cloudflare Containers in your own Cloudflare account
instead of on your nodes (ADR 0011). It keeps Roundhouse's variables,
deployments, rollbacks and audit log. This page covers setup, what the
provider does, and what has only been tested against a fake Cloudflare API.

## Setup

1. **Plan.** Containers need the Workers Paid plan on the account.
2. **Apps domain.** Set the apps domain under Settings → Domains & TLS. Its
   zone (the apps domain, or a parent of it) must be in the same Cloudflare
   account, and `*.<apps_domain>` must be **proxied** (orange cloud): Worker
   routes only run on proxied hostnames. If the apps domain is one level
   below the zone apex, edge TLS for the wildcard needs Advanced
   Certificate Manager.
3. **API token.** Create an account API token with:
   - Account → Workers Scripts → Edit
   - Zone → Workers Routes → Edit, on the apps domain's zone
   - Account → Containers → Edit
   - Account → Account Analytics → Read

   Zone → Zone → Read on the apps zone is also needed to find the zone.
4. **Connect.** Settings → Cloudflare (or `PUT /v1/instance/cloudflare`)
   with the account ID, the token and `apps_domain_proxied: true`. The token
   is checked against the account, then sealed; it is never shown again.
   `POST /v1/instance/cloudflare/verify` re-runs the checks.

The provider is off until this is done: switching a service to Cloudflare
fails with `422 provider_ineligible` (rule `not_configured`).

## Switching a service

Stage a config change with `placement.provider` and `placement.cloudflare`,
then apply it (or `PATCH /v1/services/{id}` with `environment_id`):

```json
{
  "type": "config.patch",
  "service": "svc_…",
  "patch": {
    "placement": {
      "provider": "cloudflare",
      "cloudflare": { "max_instances": 3, "sleep_after": "10m", "instance_type": "basic" }
    }
  }
}
```

- `instance_type` is optional: the smallest type that fits `resources` is
  used. `max_instances` (1–100) is the pool size and replaces
  `deploy.replicas`. `sleep_after` is 1m–24h. `regions` (up to 16) are
  passed as placement constraints.
- The apply refuses with `422 provider_ineligible`, listing every failing
  rule: not an `app` service (`kind`), no `networking.port` (`port`), a
  volume (`volume`, including one staged in the same change set), a TCP
  proxy (`tcp_proxy`), a custom domain not in Cloudflare-for-SaaS mode
  (`domains`), resources larger than the instance type or any type
  (`resources`), and the instance setting (`not_configured`). The rules are
  checked again when the deployment starts.
- A provider change is audited as `service.provider_changed` (from, to),
  besides `change_set.applied`.
- `GET /v1/services/{id}/cloudflare?environment_id=` shows the checklist,
  warnings (a reference to a database's `DATABASE_URL`, unreachable from
  Cloudflare), the runtime script, routes, instance counts and the
  Cloudflare deployments.

## What a deployment does

1. **Image.** A git build is copied by the builder that built it from its
   local registry to `registry.cloudflare.com/<account>/<script>:<deployment>`
   (`image_push`, agent protocol 7 or later; an older builder fails the
   deployment with `builder_outdated`). The registry login is minted for
   15 minutes and sealed to that builder. Images from Docker Hub, Amazon ECR
   and Google Artifact Registry are used directly; any other registry fails
   the deployment (deploy from git, or publish the image to one of those).
2. **Script.** One Worker script per service and environment,
   `rh-<hash>`, runs the runtime in `apps/api/src/cf-runtime/`. Each deploy
   uploads it with a new generation, which also replaces its runtime token.
3. **Application.** The first deploy creates the container application;
   later ones start a rollout and wait for it (up to 10 minutes).
4. **Warm-up.** The script's `workers.dev` address is called with a signed
   `RH-Warm` header until the health path (the HTTP health check's path, or
   `/`) answers 2xx. Without that header the address answers 404.
5. **Routes.** `<hostname>/*` → the script for the generated hostname and
   every verified SaaS custom domain.
6. **Drain.** When nodes served the service before, their replicas keep
   running for `drain_s` (at least 30 s) before they are removed.

Containers never get variables from Cloudflare secrets: on a cold start the
runtime asks the control plane through a service binding
(`RuntimeEnv.resolveEnv`), with a token bound to the current generation.

**Rollback** to an earlier Cloudflare deployment re-uploads the script and
rolls out that deployment's image tag, without pushing. The 5 newest tags
are kept per script. **Rollback** to a node deployment is a switch back.

**Switching back** to nodes deploys on nodes first. Once the replicas are
healthy, the Worker routes are deleted (traffic falls through to your
ingress nodes), and after `drain_s` (at least 30 s) the application's
`max_instances` goes to 0. The script and application are deleted 24 hours
later; switching back to Cloudflare before then reuses them.

`deploy.replicas = 0` stops serving on Cloudflare (routes removed,
`max_instances` 0) without deleting anything.

## Limitations

- **No volumes, no TCP proxy.** Container disks are ephemeral and inbound
  traffic is HTTP through the Worker only.
- **No TCP to node databases.** A container can't reach Postgres, Redis or
  other TCP services on your nodes; the status route warns about
  `DATABASE_URL` references.
- **`mount_as_file` variables** are not passed: there is no file mount.
- **Container stdout is not collected.** The runtime script's own console
  output and exceptions are stored as `system` log lines of the deployment
  (through `tail()`); the app's own output is only in the Cloudflare
  dashboard's container logs.
- **Not implemented in this release:** the edge gateway and the
  `cloudflare.mesh_access` flag (HTTP from containers to services on nodes
  through Workers VPC), the registry storage meter (always `null`), and
  copying images from other registries through a builder.

## Verified only against the fake API

The control plane is tested against an in-process fake of the Cloudflare
API (`apps/api/test/fake-cloudflare.ts`). These need a live account
before a release that touches the provider:

- **Containers request and response bodies:** `POST
  /containers/applications` (`name`, `scheduling_policy`, `instances`,
  `max_instances`, `configuration.image`, `configuration.instance_type`,
  `durable_objects.namespace_id`, `constraints.regions`), `POST
  …/rollouts` (`description`, `strategy: "rolling"`, `kind:
  "full_auto"`, `step_percentage`, `target_configuration`), rollout
  progress read from `active_rollout_id` on the application and `status`
  on `GET …/rollouts/{id}`, and `PATCH` with `max_instances: 0`.
- **`instances-v2`:** the `instances[].state` / `status.health` fields
  the instance count reads.
- **Registry:** the credentials response (`username` defaults to `v1`
  when absent), whether a pushed `linux/amd64` image is accepted, and tag
  listing and deletion through the Docker Registry API on
  `registry.cloudflare.com` (garbage collection is best effort and only
  logs on failure).
- **Script upload:** that the metadata (`main_module`, the five bindings
  including the `service` binding with `entrypoint: "RuntimeEnv"`,
  `migrations.new_sqlite_classes` on the first upload only,
  `tail_consumers`) is accepted, and that the `AppContainer` namespace is
  listed under `script`/`class` right after.
- **Token checks:** that the token verification endpoint and the listing
  calls fail for a token missing each permission; Account Analytics Read
  is not checked.
- **Direct image references:** whether `docker.io/library/nginx:1.27`
  (the form sent) and ECR/Artifact Registry references pull without
  credentials.
- **Behaviour:** scale to zero, cold-start latency, route takeover and
  propagation time (the 30 s drain minimum), and container stdout.
