# Cloudflare for SaaS custom domains: implementation spec

Status: not implemented. This spec turns ADR 0009 ("Custom domains:
Cloudflare for SaaS mode") into a buildable plan, and records why it was
not built together with the direct mode and `managed` TLS, and what the
WireGuard mesh (ADR 0005, built 2026-10-27) changed.

## What the mesh solved, and what still waits

1. **Routing: solved, with a precondition.** The fallback origin is a
   proxied record with A/AAAA records of _every_ ingress server, so
   Cloudflare may connect to any of them. With the mesh on, every meshed,
   ready ingress server of a workspace routes every hostname of it: a
   service without a local replica arrives as a route-only workload whose
   upstreams are its replicas' mesh IPs (`lib/desired-state.ts`,
   `routeWorkloads`). A server that isn't on the mesh, or isn't ready,
   still routes only its own replicas. So the SaaS mode must stay refused
   with 409 `saas_requires_mesh` unless `mesh_enabled` is on and every
   ingress server named in `origin.<zone>` is meshed and ready; the
   record should name only such servers (`servingNodes` in
   `lib/domains/serving.ts` already computes them), and be rewritten when
   readiness changes (the `mesh_status` handler refreshes on readiness
   transitions, which is the hook to use).
2. **Origin firewall: the table exists, the chain doesn't.** The agent
   now owns an `inet roundhouse` nftables table (`agent/internal/netpol`,
   replaced atomically on every change, verified every 30 s). The
   `cloudflare_only` rule belongs there as an `input`-hook chain at
   priority `filter - 1`: accept `tcp dport { 80, 443 }` from a
   `cloudflare` set (IPv4 and IPv6, from `desired_state.ingress.allowed_sources`),
   from loopback and from `@nodes` over `wg0`, and drop the rest of 80/443.
   A drop in our table is final, so Docker's rules can't undo it; the
   control-plane connection is outbound and unaffected. Still to design:
   the protocol field (an `IngressSettings` addition gated on a protocol
   version), how a server without the table (agent below
   `MESH_PROTOCOL_VERSION`) is refused, and the daily refresh of
   Cloudflare's ranges.
3. **Test doubles: still missing.** The ADR's tests use
   `e2e/lib/fake-cloudflare.mjs` and recorded fixtures shared with ADR
   0011. Neither exists. The custom hostname, fallback origin and DNS
   record endpoints need a fake with the documented status sequences before
   any of the API below is written.
4. **Open questions: still open.** Whether apex hostnames work through
   CNAME flattening (Cloudflare calls A records "not a supported setup")
   and whether origins should require Authenticated Origin Pulls.

Items 2 to 4, plus the setup workflow and the dashboard below, are the
remaining work; none of them depends on anything else unbuilt.

## What it builds on

Everything below already exists and is reused unchanged:
- The ownership TXT `_roundhouse.<host>` and the checker schedule
  (`apps/api/src/lib/domains/check.ts`). The ADR keeps the TXT mandatory in
  SaaS mode as well.
- The `managed` certificate pipeline (`apps/api/src/lib/certificates`):
  the origin certificate for each custom hostname is issued over HTTP-01
  and distributed to every ingress server. Cloudflare passes
  `/.well-known/acme-challenge/` through to the origin for tokens it did not
  issue.
- The Cloudflare API client pattern in
  `apps/api/src/lib/certificates/cloudflare-dns.ts` (injectable transport,
  error messages that are safe to show).

## Data model (the next migration after 0021)

```sql
-- domains.mode already exists ('direct' | 'cloudflare_saas').
ALTER TABLE domains ADD COLUMN cf_custom_hostname_id TEXT;
ALTER TABLE domains ADD COLUMN cf_status TEXT;
ALTER TABLE domains ADD COLUMN cf_ssl_status TEXT;
ALTER TABLE domains ADD COLUMN cf_errors TEXT; -- JSON string[]
ALTER TABLE domains ADD COLUMN cf_dcv TEXT;    -- JSON records
```

The instance setting `saas` is
`{ zone_id, zone_name, api_token (sealed, field api_token), cname_target, fallback_origin, enterprise: boolean, ingress_firewall: "off" | "cloudflare_only" }`.
`api_token` is added to `INSTANCE_SECRET_FIELDS` so key rotation re-wraps
it.

## API

- `GET /v1/instance/domains` gains `custom_domains: { mode: "direct" | "cloudflare_saas", saas: {...without token} | null, quota: { used, included: 100 } }`.
- `PUT /v1/instance/domains` accepts `custom_domains_mode` and
  `saas: { zone_id, api_token, enterprise?, ingress_firewall? } | null`.
  Switching to `cloudflare_saas`:
  1. Checks the token on the zone (`GET /zones/{id}`), with SSL and
     Certificates → Edit and DNS → Edit; 422 `cloudflare_saas_invalid`
     otherwise.
  2. Creates or updates the proxied records `origin.<zone>` (A/AAAA of
     every ingress server, rewritten whenever the set of ingress servers
     changes) and `customers.<zone>` (CNAME to `origin.<zone>`).
  3. `PUT /zones/{id}/custom_hostnames/fallback_origin`, then polls
     `GET` on it until `status: "active"`, from a workflow
     (`SAAS_SETUP_WORKFLOW`), since activation takes minutes.
  4. Refused with 409 `saas_requires_mesh` unless the mesh is on and
     every ingress server is meshed and ready (see item 1 above).
- Adding a domain in SaaS mode:
  1. `POST /zones/{id}/custom_hostnames` with
     `{ hostname, ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } }`,
     then `GET` it, because the POST response may omit the DCV records.
     Stores `cf_custom_hostname_id` and `cf_dcv`.
  2. Wildcards: 422 `wildcard_requires_enterprise` unless `saas.enterprise`.
  3. Apex hostnames are accepted with a warning that they need CNAME
     flattening or ALIAS at the customer's DNS provider.
- Removing a domain deletes the custom hostname
  (`DELETE /zones/{id}/custom_hostnames/{cf_id}`; 404 counts as deleted).
- `GET /v1/domains/{id}` returns
  `cf: { status, ssl_status, errors }` and records with purpose `cf_dcv`.

## State machine

The checker polls `GET /custom_hostnames/{id}` on the direct-mode schedule,
at most 200 hostnames a minute (Cloudflare allows 1,200 requests per 5
minutes per token), and maps:

| Cloudflare                                    | Ownership TXT | Domain `status`                               |
| --------------------------------------------- | ------------- | --------------------------------------------- |
| `status` pending, any `ssl.status`            | any           | `pending_dns`                                 |
| `status` active, `ssl.status` not active      | missing       | `pending_verification`                        |
| `status` active, `ssl.status` not active      | ok            | `issuing` (routes go out; origin cert issued) |
| both active, origin certificate on every node | ok            | `active`                                      |
| `status` blocked/moved/deleted, or 72 h pass  | any           | `failed` with `cf.errors`                     |

`verification_errors` and `ssl.validation_errors` are copied into
`cf.errors` verbatim (they are Cloudflare's words for the customer).

## Agent

- `desired_state.ingress.allowed_sources` carries Cloudflare's published
  IPv4 and IPv6 ranges (fetched daily from `https://api.cloudflare.com/client/v4/ips`)
  when `ingress_firewall` is `cloudflare_only`.
- The agent admits 80/443 only from those ranges, in its own chain, with a
  final drop for the rest of 80/443. Loopback and the control-plane
  connection (outbound) are unaffected.

## Dashboard

- Settings → Domains & TLS: the mode switch, SaaS zone and token
  (write-only), the "N of 100 included hostnames used; then
  $0.10/hostname/month" meter, and the fallback origin's state.
- Domain details: the DCV records with copy buttons and Cloudflare's
  status and errors.

## Tests

- A fake Cloudflare API covering custom hostnames, the fallback origin and
  DNS records, with the documented status sequences
  (`pending → active`, DCV records appearing only on `GET`).
- Unit tests for the state table above, the rate budget and the quota
  meter.
- An e2e run against the fake API on the two-node mesh stack
  (`e2e/phase3`): a custom hostname goes `pending → active`, the
  fallback origin is set, the dashboard shows the DCV records, and a
  request reaching the server without the replica is served over the mesh.
- Live verification on a maintainer account before release
  (`scripts/verify-domains-live.mjs`), as the ADR requires.
