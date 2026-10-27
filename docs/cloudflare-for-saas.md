# Cloudflare for SaaS custom domains

Status: implemented (2026-10-27). This page describes how ADR 0009's
"Cloudflare for SaaS mode" works as built, and what it needs. The control
plane side is `apps/api/src/lib/domains/saas.ts`; the origin firewall is the
agent's `inet roundhouse` table (`agent/internal/netpol`).

In this mode a customer points their hostname at Cloudflare instead of at
the ingress servers. Cloudflare terminates TLS at its edge, issues the edge
certificate, absorbs attacks, and connects to the install's servers with
the customer's hostname as SNI and `Host`.

## What it needs

- **A SaaS zone** in the operator's Cloudflare account, on a plan with
  Cloudflare for SaaS, and an API token with SSL and Certificates → Edit and
  DNS → Edit on that zone.
- **The `managed` TLS mode.** The zone runs Full (strict), so each server
  presents a certificate for the custom hostname. The control plane issues
  it over HTTP-01 (Cloudflare passes `/.well-known/acme-challenge/` through
  for tokens it did not issue) and hands it to every ingress server.
  Otherwise: 409 `saas_requires_managed_tls`.
- **The mesh, ready on every ingress server.** Cloudflare may send a
  hostname's traffic to any server in the origin record, so every ingress
  server must route every hostname of its workspace, which only meshed,
  ready servers do (ADR 0005, route-only workloads). Every live ingress
  server of the install must be meshed, ready, online, at
  `CERTS_PROTOCOL_VERSION` and have a public IP. Otherwise: 409
  `saas_requires_mesh`, naming each server and why.

## Setting it up

`PUT /v1/instance/domains` (Settings → Domains & TLS; instance admins, a
fresh browser session):

```json
{
  "custom_domains_mode": "cloudflare_saas",
  "saas": {
    "zone_id": "<32 hex>",
    "api_token": "<token>",
    "enterprise": false,
    "ingress_firewall": "off"
  }
}
```

1. The token is checked against the zone: the zone, its custom hostnames
   and its DNS records must all be readable (422 `cloudflare_saas_invalid`).
   It is sealed under the master key (setting `saas`, field `api_token`),
   never returned, never audited, and re-wrapped by key rotation.
2. The gates above run.
3. The control plane writes proxied records in the SaaS zone:
   - `origin.<zone>`: A/AAAA of every eligible ingress server of the
     install. This is the fallback origin.
   - `origin-<workspace>.<zone>`: A/AAAA of that workspace's eligible
     ingress servers. Each custom hostname is created with it as
     `custom_origin_server`, so a hostname only ever reaches its own
     workspace's servers (workspaces never share servers).
   - `customers.<zone>`: CNAME to `origin.<zone>`. Customers CNAME to it.
4. `PUT /zones/{zone}/custom_hostnames/fallback_origin` with
   `origin.<zone>`. Activation takes minutes; the minute tick reads it
   until Cloudflare reports `active`, and sets it again if setup failed at
   Cloudflare.

`GET /v1/instance/domains` reports `custom_domains`: the mode, the zone
(without its token), `cname_target`, `fallback_origin`, the fallback's
status and errors, and `quota: { used, included: 100 }` for the "N of 100
included hostnames used; then $0.10/hostname/month" meter.

`saas: null` removes the zone and returns to `direct`; it is refused with
409 `saas_in_use` while any custom domain is still served through it.
Existing domains keep their mode when `custom_domains_mode` changes.

## Adding a domain

In SaaS mode, `POST /v1/services/{id}/domains` (and change sets) does:
1. `POST /zones/{zone}/custom_hostnames` with
   `{ hostname, ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } }, custom_origin_server: "origin-<workspace>.<zone>" }`,
   then `GET` it, because the create answer may omit the validation
   records. A Cloudflare failure is 502 `cloudflare_unavailable` and
   nothing is stored.
2. Stores `cf_custom_hostname_id`, `cf_status`, `cf_ssl_status`,
   `cf_errors` and `cf_dcv`, with `mode: "cloudflare_saas"`.
3. Wildcards: 422 `wildcard_requires_enterprise` unless `saas.enterprise`.
4. Apex hostnames are accepted. The CNAME record's note warns that this
   works only with CNAME flattening or ALIAS at the customer's DNS provider
   (Cloudflare calls apex A records an unsupported setup).

The domain's `records` ask for:
- `CNAME <host> → customers.<zone>` (`routing`);
- the ownership TXT `_roundhouse.<host>` (`ownership`), still required:
  routing on the servers trusts only the control plane's verification;
- Cloudflare's pre-validation records (`cf_dcv`): the
  `ownership_verification` TXT and any certificate TXT, optional, for a
  cutover without downtime.

`GET /v1/domains/{id}` also returns `mode` and
`cf: { status, ssl_status, errors }`, Cloudflare's words for the customer.

Removing a domain deletes its custom hostname first (404 counts as
deleted). Any other failure is 502 `cloudflare_unavailable` and the domain
stays, so a hostname is never left billing and pointing at the install.

## Checks

The domain checker polls `GET /custom_hostnames/{id}` on the direct-mode
schedule (at most `DOMAIN_CHECK_BATCH` domains a minute, far under
Cloudflare's 1,200 requests per 5 minutes per token), resolves the
ownership TXT, and maps:

| Cloudflare                                              | Ownership TXT | Domain `status`                     |
| ------------------------------------------------------- | ------------- | ----------------------------------- |
| `status` pending, any `ssl.status`                      | any           | `pending_dns`                       |
| `status` active                                         | missing       | `pending_verification`              |
| `status` active                                         | ok            | verified, `issuing` (routes go out) |
| `ssl.status` active, origin certificate on every server | ok            | `active`                            |
| `status` blocked/moved/deleted, or 72 h pass            | any           | `failed` with `cf.errors`           |

`verification_errors` and `ssl.validation_errors` are copied into
`cf.errors` verbatim. A Cloudflare outage never fails a domain; the check
retries with backoff. The certificate pipeline moves a SaaS domain to
`active` only once Cloudflare's edge certificate is active too.

## Origin records over time

The minute tick recomputes the eligible servers and rewrites only the
records whose servers changed (the last written set is kept in the
setting), so a server that joins, leaves or stops being ready is added or
dropped within a minute. A record with no eligible server left keeps its
last addresses: stale addresses beat none while a server is briefly
unready.

## Origin firewall

With `ingress_firewall: "cloudflare_only"`, the control plane fetches
Cloudflare's published ranges (`GET https://api.cloudflare.com/client/v4/ips`,
no token) when the setting is turned on (422 `cloudflare_saas_invalid` if
it can't) and then daily, keeps the last good list if a fetch fails or
returns nothing, and sends them in `desired_state.ingress.allowed_sources`
to every server at `CERTS_PROTOCOL_VERSION`. The agent admits TCP 80/443
only from those ranges, from loopback and from other servers over `wg0`, in
an input chain of `inet roundhouse` at priority `filter - 1`, and drops the
rest of 80/443 for IPv4 and IPv6. A drop in that table is final, so
Docker's rules can't undo it. The control-plane connection is outbound and
unaffected.

## Tests

- `apps/api/test/saas.test.ts` runs against an in-process fake of the
  Cloudflare API (`apps/api/test/fake-cloudflare.ts`) with the documented
  status sequences: `pending → active` for hostnames and the fallback
  origin, validation records only on `GET`, 404 on delete counting as
  deleted. It covers the state table, the gates, setup, record moves, the
  hostname lifecycle, failure handling and the firewall ranges.
- `e2e/lib/fake-cloudflare.mjs` is the same fake as an HTTP server for
  end-to-end runs. Pointing a running control plane at it needs an
  override of the API base, which does not exist yet.
- Live verification on a maintainer account before release
  (`scripts/verify-domains-live.mjs`), as ADR 0009 requires, is still owed.
