# 0009: Custom domains and TLS

## Status

Proposed.
- Date: 2026-10-22
- Phase: 3
- Protocol: version 5
- Depends on: 0003 ("Ingress", TLS modes, `ask`), 0005 (cross-node ingress:
  every ingress node carries every route), 0006 (staged `domain.*` ops),
  0008 (domain alerts). 0011 reuses the Cloudflare DNS and API plumbing.

Names follow the Roundhouse rename (0013, "Naming").

## Context

Phase 1 has generated domains only. `domains.type` already allows `custom`,
with `verification_status` and `tls_status`. TLS modes are `acme`
(Caddy on-demand, gated by the agent's `127.0.0.1:2020/ask`, which allows
only hostnames in the node's desired routes), `internal` and `off`.

Three problems appear as soon as there are custom domains or more than one
node:
1. **HTTP-01 and TLS-ALPN-01 break across ingress nodes.** With 0005,
   every ingress node serves every route, and DNS may point a hostname at
   several of them. Each node's Caddy keeps its ACME state on local disk,
   so a validation request can land on a node that did not place the order
   and fail.
2. **Let's Encrypt limits bite generated domains.** There are 50 new
   certificates per registered domain per 7 days. Every generated
   hostname shares one registered domain (the apps domain), so on-demand
   issuance caps an install at about 50 new services a week. There are
   also 5 duplicate certificates per identical name set per 7 days, so N
   ingress nodes each issuing for the same name exhausts that limit.
3. **Hijacking.** A hostname must not route to a tenant just because its
   DNS points at the platform. A dangling CNAME left by a previous tenant
   would otherwise be claimable.

Facts (sources at the end):
- **Caddy on-demand TLS.** The `permission` module `http` with `endpoint`
  replaces the deprecated `ask` field; Caddy sends `?domain=`. A permission
  module is mandatory, and the old `interval`/`burst` rate limits were
  removed.
- **Let's Encrypt rate limits** are as above. Renewals using ARI are exempt
  from all limits. Expiry emails ended 2025-06-04, and OCSP ended
  2025-08-06.
- **Certificate lifetimes.** 90 days by default. The `classic` profile goes
  to 64 days from 2027-02-10 and 45 days from 2028-02-16.
- **Cloudflare for SaaS custom hostnames.**
  - API: `POST/GET/PATCH/DELETE /zones/{zone}/custom_hostnames`, plus
    `GET/PUT/DELETE /zones/{zone}/custom_hostnames/fallback_origin`.
  - DCV: `ssl.method` is `http`, `txt` or `email`. Pre-validation is
    available through `ownership_verification` and
    `ownership_verification_http`. A POST response may omit the DCV
    tokens, so follow it with a GET.
  - Ready means `status` and `ssl.status` are both `active`.
  - The fallback origin must be a proxied A, AAAA or CNAME record in the
    SaaS zone. Per-hostname `custom_origin_server` is on all plans, but SNI
    rewrite is Enterprise-only.
  - With the fallback origin, both SNI and Host are the custom hostname,
    and Full (strict) needs an origin certificate matching it.
  - Pricing: 100 hostnames included on Free, Pro and Business, then $0.10
    each, up to 50,000. Wildcard custom hostnames and apex proxying are
    Enterprise. A records are "not a supported setup".
  - API limit: 1,200 requests per 5 min per token.
- **Origin CA** certificates are trusted only by Cloudflare and cover only
  hostnames in your own zones, so they cannot cover customers' hostnames.
- **HSTS.** RFC 6797. Preloading requires `max-age` ≥ 31536000,
  `includeSubDomains`, `preload`, and an HTTP → HTTPS redirect on the same
  host.

## Decision

### Certificate strategy

The control plane becomes the ACME client for everything except the
single-node default. Certificates are issued once and distributed to every
ingress node. That fixes multi-node validation, duplicates and rate limits
in one place.

| TLS mode (`tls_mode`) | Generated domains                                                  | Custom domains                                                   | Use                         |
| --------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------- |
| `acme` (existing)     | Caddy on-demand per node, gated by `ask`                           | Caddy on-demand per node                                         | one ingress node only       |
| `managed` (new)       | one **wildcard** `*.<apps_domain>` via DNS-01 (Cloudflare DNS API) | control-plane ACME, HTTP-01 (or DNS-01 delegation for wildcards) | any number of ingress nodes |
| `internal`, `off`     | unchanged (development, tests)                                     | same                                                             |                             |

`acme` stays for the simplest install. Selecting it with more than one
ingress node is refused: `409 acme_mode_single_ingress_only`. The
dashboard explains the fix (switch to `managed`).

**`managed` mode prerequisites.** The apps domain's zone must be in the
user's Cloudflare account, and there must be an API token with Zone → DNS →
Edit on it. This is the instance setting `cloudflare_dns: { zone_id,
api_token (sealed) }`. The control plane already runs in that account, so
this is the common case. Without it, `managed` covers only custom domains,
and generated domains fall back to per-name HTTP-01 through the same path.
The dashboard shows the 50-per-week warning in that case.

**ACME client** (`apps/api/src/lib/acme/`, WebCrypto only).
- **Protocol.** RFC 8555 with ES256 account keys, against Let's Encrypt
  production by default. The directory URL is an instance setting, which
  is how tests point it at Pebble.
- **Account key.** Sealed in `instance_settings` (`acme_account`).
- **Orders** run in `CERT_WORKFLOW`, instance ID `cer-<id>-<attempt>`:
  1. new order;
  2. authorizations;
  3. challenge setup;
  4. ready poll, then a CSR (ECDSA P-256 key generated in the Worker);
  5. finalize, then download the chain.

  The new private key is sealed under the KEK with AAD `certificate:<id>`.
- **Challenges.**
  - **DNS-01** for `*.<apps_domain>`: create TXT
    `_acme-challenge.<apps_domain>` through the Cloudflare DNS API, wait
    until DoH sees it, then answer. The record is deleted afterwards.
  - **HTTP-01** for a custom name: store the key authorization in
    `acme_challenges` (token → key authorization, 1 h TTL). Every ingress
    node's Caddy proxies `http://<host>/.well-known/acme-challenge/<token>`
    for **managed hosts** to the control plane's public
    `GET /v1/acme/http-01/{token}`, so whichever node the validation
    reaches answers correctly. The upstream URL and Host are in
    `desired_state.ingress.acme_challenge_upstream`.
  - **DNS-01 delegation** for a custom wildcard `*.example.com` (direct
    mode only): the customer adds the CNAME
    `_acme-challenge.example.com` → `<domain_id>.acme.<apps_domain>`, and
    the control plane writes the TXT at the target in its own zone.
- **Renewal** is driven by ARI (`renewalInfo`, which is exempt from rate
  limits), falling back to "one third of the lifetime remaining". The
  code never assumes 90 days. The minute tick claims certificates whose
  `renew_after <= now`.

**Distribution to nodes (protocol 5).**
- **Manifest.** `desired_state.certificates: { id, sha256, not_after }[]`
  (≤ 4096) lists what an ingress node must hold. It is small, so the
  desired state stays small.
- **Bodies** travel in a separate signed, credential-carrying frame (60 s
  TTL):

  ```ts
  { type: "cert_sync"; ...ControlHeader;
    upserts: { id: IdString; hostnames: string[]; cert_pem: string; key_pem: string; not_after: number }[];  // ≤ 32 per frame
    removes: IdString[] }
  ```

- The agent writes each certificate to `<data-dir>/certs/<id>.pem` (0600,
  root) and sends `cert_ack { ids: string[] }`. On a manifest mismatch,
  for example after a restart or a missed frame, it sends
  `cert_request { ids: string[] }`, and the node DO answers with
  `cert_sync`.
- The agent's Caddy config lists the files under
  `apps.tls.certificates.load_files` and keeps managed hosts out of Caddy's
  own automation (`automatic_https.skip_certificates`).
- **Reload cost.** Adding a certificate for a _new_ hostname rides the
  `/load` that adding the route already causes, which ADR 0003 permits. A
  **renewal** for an existing hostname is the only extra reload. The agent
  batches renewals, at most one load every 10 min. At 64–90-day lifetimes
  that is a handful of loads a day even with thousands of domains.

### Custom domains: direct mode

A custom hostname is added with `POST /v1/services/{serviceId}/domains`
or the staged op `domain.add`. It moves through:

```
pending_dns → pending_verification → issuing → active
         ↘ failed (DNS or verification not seen in 72 h; re-check resumes it)
```

1. **Records.** The response lists the records the customer must create:
   - **Routing.** `CNAME <host> → <ingress_hostname>`, where
     `ingress_hostname` is an instance setting such as
     `ingress.<apps_domain>`, kept by the operator (or by the control
     plane in `managed` mode) as A/AAAA records to every ingress node's
     public IP. For an apex, `A`/`AAAA` to those IPs, or the DNS
     provider's ALIAS/flattening to `ingress_hostname`.
   - **Ownership.** `TXT _roundhouse.<host> = "rh-verify=<token>"`, where
     the token is 32 random bytes in hex. It is **always required** before
     a hostname is routed, so a dangling CNAME cannot be claimed.
   - **Wildcards** additionally need the `_acme-challenge` CNAME
     delegation (managed mode only).
2. **Checks.** The checker (`lib/domains/check.ts`) resolves through DoH
   JSON: `DNS_RESOLVER_URL`, default `https://cloudflare-dns.com/dns-query`,
   then `https://dns.google/resolve` on failure. It runs at add time, then
   1, 2, 5, 10 and 30 min after, then hourly, through the minute tick, and
   on `POST …/check` (at most once a minute per domain). Routing is
   correct when the CNAME chain reaches `ingress_hostname`, or every A/AAAA
   answer is an ingress node's IP. Ownership is correct when the TXT value
   matches.
3. **Verified.** Once both are correct, the domain enters every ingress
   node's routes, in the next `desired_state`.
4. **TLS.**
   - `managed`: issue through HTTP-01 (or DNS-01 delegation), then
     distribute. `tls_status` is `issued` when every ingress node has
     acked the certificate.
   - `acme`: the agent's permission endpoint now admits the host, and
     Caddy issues on the first handshake. The agent then makes one TLS
     handshake to `127.0.0.1:443` with that SNI to trigger issuance
     immediately, and reports
     `cert_status { hostname, state: "issued" | "failed" | "pending", issuer?, not_after?, error? }`.
     Errors come from Caddy's `tls` logger, which the agent configures to
     write to `net` `127.0.0.1:2022`, where it listens.

### Custom domains: Cloudflare for SaaS mode

Selected per install with `custom_domains.mode: "cloudflare_saas"`.
Prerequisites: a **SaaS zone** in the user's account, and a token with
SSL and Certificates → Edit and DNS → Edit on it. Both go in the instance
setting `saas: { zone_id, api_token (sealed), cname_target, fallback_origin }`.

**Setup** (`PUT /v1/instance/domains`):
1. Create the proxied records `fallback_origin`
   (`origin.<saas zone>`, A/AAAA to every ingress node; the list is updated
   when ingress nodes change) and `cname_target`
   (`customers.<saas zone>`, CNAME to the fallback origin).
2. `PUT /zones/{zone}/custom_hostnames/fallback_origin`, then poll until
   `status: "active"`.
3. Optionally set `ingress_firewall: "cloudflare_only"`. The agent then
   accepts 80/443 only from Cloudflare's published IP ranges, distributed
   in `desired_state.ingress.allowed_sources`, enforced by a final drop in
   `inet roundhouse`.

**Adding a hostname:**
1. `POST /zones/{zone}/custom_hostnames` with
   `{ hostname, ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } }`,
   then `GET` it for the DCV records. Store `cf_custom_hostname_id`.
2. The customer creates `CNAME <host> → <cname_target>`. Before the
   cutover they may also add the `ownership_verification` TXT
   (pre-validation, no downtime).
3. The checker polls `GET /custom_hostnames/{id}` on the same schedule
   as direct mode, and mirrors `status`, `ssl.status` and
   `verification_errors`.
4. **Origin TLS.** Cloudflare connects to the fallback origin with SNI and
   Host set to the custom hostname. The zone runs **Full (strict)**, so the
   origin presents a certificate for the custom hostname, issued by the
   managed ACME path with HTTP-01. Cloudflare passes
   `/.well-known/acme-challenge/` through to the origin for tokens it did
   not issue itself.

   The ownership TXT (`_roundhouse`) is still required, on top of
   Cloudflare's own verification, because routing on the nodes trusts
   only the control plane's verification.
5. `active` once Cloudflare reports `status` and `ssl.status` both
   `active` and the origin certificate is on every ingress node.

**Limits enforced.**
- Wildcard custom hostnames return `422 wildcard_requires_enterprise`
  unless `saas.enterprise: true`.
- Apex hostnames are accepted with a warning: they work only if the
  customer's DNS offers CNAME flattening or ALIAS.
- The control plane keeps under Cloudflare's API rate limit: one checker
  pass for at most 200 hostnames a minute.
- The dashboard shows "N of 100 included hostnames used; then
  $0.10/hostname/month" from the count.

### HSTS and redirects

- Every HTTPS route in `acme`, `managed` and SaaS modes gets
  `Strict-Transport-Security: max-age=31536000`, added by a Caddy
  `headers` handler on the HTTPS server only. Plain HTTP on :80 redirects
  to HTTPS for the same host (existing behaviour), and never sends the
  header (RFC 6797 §7.2).
- In `internal` and `off` there is no HSTS.
- Generated domains always get the default: no `includeSubDomains`, no
  `preload`.
- Custom domains have `hsts: { enabled: boolean; max_age: number;
  include_subdomains: boolean; preload: boolean }`, defaulting to enabled,
  31536000, false, false. `preload: true` requires `include_subdomains`,
  `max_age >= 31536000` and an apex hostname, and the dashboard requires a
  typed confirmation, because preload is effectively irreversible.
- `WorkloadRoute` gains `hsts?: { max_age; include_subdomains; preload } | null`,
  which is not in the spec hash.

### Protocol (version 5)

- **Routes.** `HostnameString` for routes accepts one leading `*.` label:
  `WILDCARD_HOSTNAME_RE`, mirrored in Go. Caddy's host matcher supports
  it.
- **Ingress settings.** `desired_state.ingress?: { acme_challenge_upstream: { url: string; host: string } | null; allowed_sources: string[] | null; managed_hosts: string[] }`.
- **Certificates.** `desired_state.certificates` as above.
- **TLS mode.** `TLS_MODES` gains `managed`.
- **New frames:**
  - control → agent: `cert_sync`;
  - agent → control: `cert_ack`, `cert_request`, `cert_status`.
- **Gates.** None of this is ever sent to a v4 agent. In `managed` mode the
  scheduler marks v4 nodes `ingress: false` (`capabilities.ingress` is
  overridden), so they receive no routes.

### Data model

```sql
ALTER TABLE domains ADD COLUMN mode TEXT NOT NULL DEFAULT 'direct';      -- direct | cloudflare_saas
ALTER TABLE domains ADD COLUMN status TEXT NOT NULL DEFAULT 'pending_dns';
ALTER TABLE domains ADD COLUMN verification_token TEXT;
ALTER TABLE domains ADD COLUMN dns_status TEXT NOT NULL DEFAULT 'unknown'; -- unknown | ok | missing | wrong_target
ALTER TABLE domains ADD COLUMN dns_observed TEXT;                          -- JSON last answers
ALTER TABLE domains ADD COLUMN certificate_id TEXT REFERENCES certificates(id) ON DELETE SET NULL;
ALTER TABLE domains ADD COLUMN cert_not_after INTEGER;
ALTER TABLE domains ADD COLUMN cf_custom_hostname_id TEXT;
ALTER TABLE domains ADD COLUMN cf_status TEXT;
ALTER TABLE domains ADD COLUMN cf_ssl_status TEXT;
ALTER TABLE domains ADD COLUMN hsts TEXT;                                  -- JSON
ALTER TABLE domains ADD COLUMN error TEXT;
ALTER TABLE domains ADD COLUMN check_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE domains ADD COLUMN last_checked_at INTEGER;
ALTER TABLE domains ADD COLUMN next_check_at INTEGER;

CREATE TABLE certificates (
  id TEXT PRIMARY KEY,                    -- cer_…
  hostnames TEXT NOT NULL,                -- JSON string[]
  kind TEXT NOT NULL,                     -- apps_wildcard | custom
  status TEXT NOT NULL,                   -- pending | issued | failed | renewing | revoked
  key_sealed TEXT, chain_pem TEXT,
  not_before INTEGER, not_after INTEGER, renew_after INTEGER,
  ari_cert_id TEXT, order_url TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE acme_challenges (
  token TEXT PRIMARY KEY, key_authorization TEXT NOT NULL,
  certificate_id TEXT NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE certificate_deployments (
  certificate_id TEXT NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL, acked_at INTEGER,
  PRIMARY KEY (certificate_id, node_id)
);
```

`domains.hostname` stays globally unique. Adding a hostname another
workspace already holds returns `409 domain_taken`, unless that domain has
been `failed` for over 7 days, in which case the old row is replaced.
Verification is always per row, so a takeover still needs the new TXT.

### Routes, RBAC, audit

| Method and path                                      | RBAC                             | Audit                              |
| ---------------------------------------------------- | -------------------------------- | ---------------------------------- |
| `GET /v1/services/{serviceId}/domains` (exists)      | `services:read`                  | none                               |
| `POST /v1/services/{serviceId}/domains`              | `domains:manage`                 | `domain.added`                     |
| `GET /v1/domains/{domainId}`                         | `services:read`                  | none                               |
| `PATCH /v1/domains/{domainId}` `{target_port, hsts}` | `domains:manage`                 | `domain.updated`                   |
| `POST /v1/domains/{domainId}/check`                  | `domains:manage`                 | none                               |
| `DELETE /v1/domains/{domainId}`                      | `domains:manage`                 | `domain.removed`                   |
| `GET`, `PUT /v1/instance/domains`                    | `instance:manage` (session only) | `instance.settings_updated`        |
| `GET /v1/acme/http-01/{token}`                       | public                           | none (rate-limited per IP, 60/min) |

System audit actions: `domain.verified`, `domain.failed`,
`certificate.issued`, `certificate.renewed`, `certificate.failed`. The
last two also feed 0008 (`domain_failed`, `cert_expiring`).

`GET /v1/domains/{id}` returns:

```ts
{ domain: Domain; status; records: { type: "CNAME" | "A" | "AAAA" | "TXT"; name: string; value: string;
    purpose: "routing" | "ownership" | "acme_delegation" | "cf_dcv"; state: "ok" | "missing" | "wrong" }[];
  tls: { status; issuer: string | null; not_after: number | null; nodes: { node_id; acked: boolean }[] };
  cf?: { status; ssl_status; errors: string[] } }
```

New RBAC action: `domains:manage` (owner, admin, member). New ID prefix:
`cer`.

### Dashboard

- **Service → Networking → Domains.** Add domain, then a records table with
  copy buttons and a live state per record, "Check now", and a status
  stepper (DNS → Ownership → Certificate → Active) with the exact error at
  the failing step, such as "TXT `_roundhouse.app.example.com` not found;
  last checked 2 min ago". There is an HSTS panel, with a preload
  confirmation.
- **Settings → Domains & TLS.** Pick the TLS mode with prerequisites
  checked live (Cloudflare token scopes, zone found, ingress node count);
  enter the SaaS zone; the hostname quota meter; the certificate list with
  expiry and renewal state.

## Security

- **Hijack protection.** No hostname is routed without the per-domain TXT
  token, which the control plane checks, in both modes. Changing ownership
  requires a fresh token.
- **Keys.** Private keys are generated in the Worker, sealed at rest,
  shipped only in credential frames (60 s TTL) to ingress nodes, and
  stored 0600 on disk.
  - Removing an ingress node drops it from future `cert_sync` frames.
    Certificates it held stay valid until expiry; its keys are not
    revoked automatically. Revocation is a manual `POST` (future).
- **Challenges.** The public HTTP-01 endpoint reveals only key
  authorizations for live tokens, which are public by design in ACME. It
  is rate-limited and returns 404 otherwise. The `ask` / permission
  endpoint stays loopback-only (0003).
- **HSTS** is on by default for every HTTPS route. Preload needs explicit,
  typed consent.
- `ingress_firewall: "cloudflare_only"` hides origins in SaaS mode.
- **Credentials.** The Cloudflare tokens are scoped to the zones they
  need, sealed, and set from a session only (`instance:manage`).

## Testing strategy

- **Unit.**
  - DNS check evaluation (CNAME chains, apex A sets, wrong targets).
  - Status transitions.
  - HSTS validation rules.
  - Renew-after computation (ARI window, one-third fallback).
  - Wildcard hostname regex, TS and Go vectors.
  - Caddy config golden files for managed hosts (challenge proxy before
    the redirect, `load_files`, HSTS headers).
- **ACME** against **Pebble** (`ghcr.io/letsencrypt/pebble`, pinned by
  digest) with `pebble-challtestsrv` as its DNS. The ACME client is tested
  end to end in vitest with a Node test helper: HTTP-01, DNS-01 through a
  fake Cloudflare DNS API that writes to challtestsrv, and a failed
  validation. Pebble's README does not document ARI, so ARI parsing is
  unit-tested against RFC 9773 examples, and the one-third fallback runs
  against Pebble.
- **Fake Cloudflare API** (`e2e/lib/fake-cloudflare.mjs`, shared with
  0011). It covers DNS records, custom hostnames and the fallback origin,
  with the documented status sequences. Responses are recorded from the
  API reference into `e2e/fixtures/cloudflare/*.json`.
- **Real-stack e2e** (`e2e/phase3/domains.test.mjs`, two ingress nodes,
  Pebble, challtestsrv as DNS resolver through a DoH shim,
  `DNS_RESOLVER_URL` pointed at it):
  1. `managed` mode: the wildcard `*.apps.test` is issued through DNS-01
     and acked by both nodes. Generated hostnames serve HTTPS from either
     node, verified against Pebble's root, with an HSTS header on HTTPS
     and none on the HTTP redirect.
  2. Add `shop.customer.test`: `pending_dns` until challtestsrv gets the
     CNAME, `pending_verification` until the TXT, then `issuing`. Pebble's
     HTTP-01 validation is served by **node B**, although the order was
     placed by the control plane, and the status becomes `active` with
     both nodes acked.
  3. A dangling CNAME without the TXT is never routed: 404 `no route`,
     and the ask/permission endpoint denies it in `acme` mode.
  4. Renewal: force `renew_after` into the past. A new certificate is
     distributed, and each node does exactly one extra Caddy load.
  5. SaaS mode against the fake Cloudflare API: the custom hostname moves
     `pending → active`, the fallback origin is set, and the dashboard's
     records table shows the DCV records.
  6. `acme` mode with two ingress nodes is refused with
     `409 acme_mode_single_ingress_only`.
- **Live only.** Real Let's Encrypt issuance and real Cloudflare for SaaS
  behaviour (DCV timing, Full (strict) with a fallback origin) are
  verified with `scripts/verify-domains-live.mjs` on a maintainer account
  before each release that touches this code.

## Rollout and compat

- **Protocol 5** (with 0008 and 0010): `CERTS_PROTOCOL_VERSION = 5`.
- **Existing `acme` installs** with one node keep working unchanged, and
  their existing custom-domain-free routes are untouched. Switching to
  `managed` is an explicit action. On the switch, the wildcard is issued
  first, then routes flip to it in one `/load` per node.
- **Migration** is additive. Existing generated domains get
  `status = 'active'` and `verification_status = 'verified'`.

## Consequences

- One certificate pipeline serves all nodes and both modes. It avoids
  Let's Encrypt's duplicate and per-domain limits, and makes status
  observable from the control plane.
- The control plane now holds TLS private keys. They are sealed like
  other secrets, but their loss would allow impersonation until expiry.
- `managed` mode depends on the apps domain being on Cloudflare DNS for
  the wildcard. Other DNS providers get per-name certificates, under the
  50-per-week limit.

## Implementation notes

Built (2026-10-27): direct mode, `managed` TLS with the control-plane ACME
client, HSTS, wildcards through DNS-01, `cert_status` reporting, and the
agent's certificate store. Where the build differs from the decision above:
- **Routing and the mesh.** Every ingress server runs Caddy. Without the
  WireGuard mesh (0005) a server routes a hostname only to replicas running
  on it, so DNS guidance names the servers that run the service (A/AAAA
  records of exactly those when others don't), and `tls.nodes` counts
  only those servers. With the mesh on (built 2026-10-27), every meshed,
  ready ingress server routes every hostname of its workspace through
  route-only workloads to the replicas' mesh IPs, so the guidance names all
  of them and DNS may point at any or all ingress servers
  (`lib/domains/serving.ts`).
- **Certificate files.** Caddy runs as its own user, so certificates are
  written to `/var/lib/roundhouse-certs/<id>.pem` (`ingress.certs_dir`),
  mode 0640 in a `root:caddy` setgid directory that `install.sh` creates,
  not 0600 root in the data directory.
- **Challenge proxy scope.** Caddy proxies HTTP-01 challenges for every
  exact hostname a server routes, not only `managed_hosts`: a host becomes
  managed only once its certificate can be served, so its first order needs
  the proxy already. Caddy still answers its own on-demand challenges first.
- **Data model.** Migration 0017 adds `domains.hsts` and `tls_issuer`,
  `tls_not_before`, `tls_not_after`, `tls_error`, `tls_updated_at`
  instead of `certificate_id`/`cert_not_after` (a domain's certificate
  is found through `certificates.domain_id`, or the apps wildcard).
  `certificates` gains `kind = 'generated'` (one generated hostname when
  there is no wildcard), `challenge`, `pending_key_sealed`, `sha256`,
  `issuer`, `failures` and `next_attempt_at`; `acme_challenges` records
  DNS-01 records to delete; `domain_tls_reports` keeps each server's
  `cert_status` in `acme` mode.
- **Settings.** `GET`/`PUT /v1/instance/domains` hold the ingress
  hostname, the CA directory and contact, and `cloudflare_dns`;
  `GET /v1/instance/certificates` lists certificates. The TLS mode stays on
  `PATCH /v1/instance/settings`. `managed` needs an `https`
  `PUBLIC_ORIGIN` (422 `managed_tls_unavailable` otherwise).
- **HTTPS probe.** Kept only as the fallback for servers older than
  `CERTS_PROTOCOL_VERSION`, which send no `cert_status`.
- **Cloudflare for SaaS** is built (2026-10-27); see
  [how it works](../cloudflare-for-saas.md). Where it differs from the
  section above:
  - **Gates.** It needs the `managed` TLS mode (409
    `saas_requires_managed_tls`) and every ingress server of the install
    meshed, ready, online and with a public IP (409 `saas_requires_mesh`):
    Cloudflare may send any hostname to any server in the origin record.
  - **One origin per workspace.** Besides the fallback origin
    `origin.<zone>`, each workspace gets `origin-<workspace>.<zone>` with
    its own ingress servers, and its hostnames are created with it as
    `custom_origin_server`. With one shared fallback, a server would get
    hostnames of workspaces it can't route (workspaces never share servers).
  - **No setup workflow.** Setup writes the records and sets the fallback
    origin in the request; the minute tick follows the fallback until
    `active` (and sets it again after a failed setup), rewrites origin
    records when the eligible servers change, and re-reads Cloudflare's IP
    ranges daily. `SAAS_SETUP_WORKFLOW` was not needed.
  - **Data model.** `domains` gains `cf_custom_hostname_id`, `cf_status`,
    `cf_ssl_status`, `cf_errors` and `cf_dcv` (migration 0021); the zone,
    sealed token, fallback state and last written origin records live in the
    `saas` instance setting, the mode in `custom_domains_mode`, the ranges
    in `cloudflare_ips`.
  - **Removal fails closed.** A domain whose custom hostname Cloudflare
    can't delete stays (502 `cloudflare_unavailable`), so nothing is left
    billing and pointing at the install.
  - **Origin firewall.** `desired_state.ingress.allowed_sources` (already
    in protocol 6) carries the ranges; the agent enforces them in
    `inet roundhouse`.
- **Tests.** The order pipeline runs against Pebble
  (`apps/api/test-node`) and against an in-process CA in the Workers
  suite. Cross-node routing is covered by the mesh tests (API unit tests
  for route-only workloads and the agent's two-node integration test).

## Decided after the fact

- **Apex hostnames in SaaS mode** are accepted, with a warning on the
  routing record that they work only with CNAME flattening or ALIAS at the
  customer's DNS provider, as Cloudflare's own documentation says (it calls
  apex A records "not a supported setup"). The live check before release
  covers a flattened apex.
- **Authenticated Origin Pulls** are not in v1. Full (strict) already
  binds Cloudflare's connection to a certificate for the hostname, and with
  `ingress_firewall: "cloudflare_only"` only Cloudflare's ranges reach
  80/443. AOP would also stop another Cloudflare account from reaching the
  origin through Cloudflare's ranges; it needs Cloudflare's client CA in
  Caddy's TLS connection policy, and is the next step if that matters.

## Open questions

- Should `www` ↔ apex redirects be offered as a domain type? Users ask for
  it; it is a small Caddy handler.
- Short-lived (6-day) certificates would remove revocation concerns, at
  the cost of constant distribution. Revisit once lifetimes drop to 45
  days in 2028.

## Sources

- Caddy on-demand TLS: `permission` module `http` (`ask` deprecated), `?domain=`, mandatory permission module, https://raw.githubusercontent.com/caddyserver/caddy/master/modules/caddytls/ondemand.go and https://raw.githubusercontent.com/caddyserver/caddy/master/modules/caddytls/automation.go (v2.11.7, retrieved 2026-10-22); `interval`/`burst` removed, https://caddyserver.com/docs/caddyfile/options (retrieved 2026-10-22); internal issuance throttle, https://caddyserver.com/docs/automatic-https (retrieved 2026-10-22)
- Let's Encrypt rate limits (50 per registered domain per 7 days, 5 duplicates per 7 days, 300 orders per 3 h, ARI exempt), https://letsencrypt.org/docs/rate-limits/ (updated 2026-08-05)
- Let's Encrypt lifetimes and profiles, https://letsencrypt.org/docs/cert-lifetimes/ and https://letsencrypt.org/2025/12/02/from-90-to-45 (retrieved 2026-10-22); short-lived certificates GA, https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability; end of expiry emails, https://letsencrypt.org/2025/06/26/expiration-notification-service-has-ended; end of OCSP, https://letsencrypt.org/2025/08/06/ocsp-service-has-reached-end-of-life
- Custom hostnames API, https://developers.cloudflare.com/api/resources/custom_hostnames/ and https://developers.cloudflare.com/api/resources/custom_hostnames/methods/create/ (retrieved 2026-10-22); fallback origin, https://developers.cloudflare.com/api/resources/custom_hostnames/subresources/fallback_origin/ (retrieved 2026-10-22)
- Cloudflare for SaaS getting started (GET after POST for DCV, readiness), https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/ (updated 2026-06-19); hostname validation, https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/ (updated 2026-06-19); custom origin and SNI rewrite, https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/custom-origin/ (updated 2026-06-19); connection details (SNI/Host), https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/reference/connection-details/ (updated 2026-04-16); apex proxying, https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/apex-proxying/; plans and pricing, https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/ (updated 2026-08-14)
- Full (strict) hostname matching, https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/ (updated 2026-07-09); Origin CA scope, https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/ (updated 2026-08-14)
- API rate limits, https://developers.cloudflare.com/fundamentals/api/reference/limits/ (retrieved 2026-10-22)
- DoH JSON API, https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/ (retrieved 2026-10-22)
- Caddy `automatic_https.skip_certificates` (names stay in automatic HTTPS but certificates are not managed), https://raw.githubusercontent.com/caddyserver/caddy/master/modules/caddyhttp/autohttps.go (retrieved 2026-10-22)
- Pebble and pebble-challtestsrv images on GHCR, https://github.com/letsencrypt/pebble (retrieved 2026-10-22)
- HSTS, RFC 6797, https://www.rfc-editor.org/rfc/rfc6797; preload requirements, https://hstspreload.org/ (retrieved 2026-10-22)
