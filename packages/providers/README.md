# @roundhouse/providers

One-click provisioning: the user pastes a cloud API token, picks a plan, and
the control plane creates a server whose cloud-init joins it to the
workspace at first boot. Hetzner Cloud, DigitalOcean, Vultr, and Linode
(Akamai) are supported behind one interface, so the API and dashboard never
contain provider-specific code.

Bring-your-own servers need no adapter. The user runs `install.sh` or pastes
the user data from `buildUserData` into any cloud's "user data" field. Only
one-click provisioning goes through this package.

Runtime-agnostic: only `fetch`, `AbortController`, timers, and WebCrypto, so
it runs in Workers. No dependencies.

```ts
import { createProvider, PROVIDERS, recommend } from "@roundhouse/providers";

const provider = createProvider("digitalocean", { token }); // unsealed per request
const check = await provider.validateToken(); // { valid, canWrite, missing?, account? }
const offers = await provider.listOffers({ role: "node" }); // live plans x regions, cents
const [pick] = recommend(offers, { regions: ["fra1", "ams3"] });
const { server, created } = await provider.provision(
  {
    name: "web-1", // node name and idempotency key
    plan: pick.offer.plan,
    region: pick.offer.region,
    controlPlaneUrl: "https://cp.example.com",
    joinToken, // fresh, single-use, from the join-token route
    workspaceId,
  },
  { onStep: (step) => stream(step), signal },
);
// later: await provider.deprovision({ serverId: server.id, expectedName: "web-1" });
```

## The interface

| `Provider`                                      | What it does                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `id`, `displayName`                             | `hetzner`, `digitalocean`, `vultr`, `linode`                                                               |
| `validateToken()`                               | `{ valid, canWrite, missing?, account? }` without side effects; `missing` names absent scopes or ACLs      |
| `listOffers({ role, region })`                  | `Offer[]`: plan, region, vCPU, RAM MiB, disk GB, arch, dedicated, monthly cents and currency, deprecation  |
| `listImages({ region, arch })`                  | Ubuntu 24.04, Ubuntu 22.04, and Debian 12, per architecture                                                |
| `provision(input, { onStep, signal })`          | Idempotent by node name; cleans up after any failure once the server exists; never returns a root password |
| `deprovision({ serverId, expectedName })`       | Refuses servers without `roundhouse.managed=true` or with a different node name                            |
| `getServer(id)`, `listManaged({ workspaceId })` | Normalised `CloudServer`s for reconciling against the nodes table                                          |

Errors are typed and provider-neutral. `ProviderApiError.code` is one of
`unauthorized`, `forbidden`, `rate_limited`, `not_found`, `quota_exceeded`,
`invalid_input`, `unavailable`, `conflict`, or `unknown`, with the raw
`providerCode` kept. `ProviderTimeoutError` and `ProviderNetworkError` mean
no answer arrived. `ProvisionError.reason` is one of `token_invalid`,
`token_read_only`, `invalid_input`, `offer_unavailable`, `image_unavailable`,
`name_taken`, `server_deleting`, `failed_cleaned_up`,
`failed_cleanup_failed`, or `not_managed`, and `serverId` is set when a
server is involved. On `failed_cleanup_failed` the server may still bill, so
record `serverId` and retry `deprovision`.

`PROVIDERS` holds each provider's token link, docs, and least-privilege
scopes for the connect dialog.

## How provisioning works

`provision.ts` owns every safety rule. Adapters supply small primitives
(`ProviderDriver`).
1. Validate the input and build the user data before any API call.
2. Validate the token.
3. Find a managed server with this node name and reuse it; refuse a name an
   unmanaged server uses.
4. Check that the plan can be ordered in the region, and pick the image for
   the plan's architecture.
5. Ensure the shared default firewall (and the SSH key, if one is given).
6. Create the server with the managed labels or tags.
7. Wait until it runs.

If anything fails after step 6, including the caller aborting, the server is
deleted. When the create response is lost (a timeout, a network error, a
gateway error, or an abort mid-flight), the server is found by its labels
rather than created twice.

Labels are stable and must never change: `roundhouse.managed=true`,
`roundhouse.node`, `roundhouse.role`, `roundhouse.workspace`, and
`roundhouse.firewall`, the same keys `@roundhouse/hetzner` wrote. Providers
with plain tags store `roundhouse.node=web-1` (Vultr, Linode) or
`roundhouse:node:web-1` (DigitalOcean, whose tags forbid `.` and `=`).

## Per-provider notes

| Provider     | Labels                       | Prices                                | Firewall                                                                   | Root password                             | Name limits                               |
| ------------ | ---------------------------- | ------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| Hetzner      | key/value labels             | per location, gross, project currency | attached at create; outbound open                                          | returned once, dropped                    | unique per project                        |
| DigitalOcean | `roundhouse:key:value` tags  | uniform, USD                          | targets a tag the droplet is created with; adapter adds allow-all outbound | emailed if no SSH key given               | not unique (adapter still refuses)        |
| Vultr        | `key=value` tags             | per region (`location_cost`), USD     | group by description, rules added after; attached at create                | `default_password`, dropped               | not unique (adapter still refuses)        |
| Linode       | `key=value` tags, 3-50 chars | per region (`region_prices`), USD     | `firewall_id` at create; tagged                                            | required; random, sent once, kept nowhere | letter first, 3-64 chars; node names ≤ 34 |

DigitalOcean, Vultr, and Linode are amd64 only. Linode user data needs a
`cloud-init` image in a region with the `Metadata` capability, so offers and
images are filtered to those. A Linode token's scopes are read from
`X-OAuth-Scopes`, and a restricted Linode user cannot tag Linodes, so such a
user cannot provision. More detail is in each `src/<provider>/driver.ts`
header, and the sources are in `SOURCES.md`.

## Security model

- **Provider tokens.** The API stores them sealed, unseals one per request,
  and passes it to `createProvider`. This package never logs, stores, or
  returns a token. Ask for least privilege:

  | Provider     | Create a token                                                                                                                                        | Grant                                                                                                                                                                                     |
  | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Hetzner      | [Project → Security → API tokens](https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/)                                           | Read & Write. Tokens are scoped to one project, so use a dedicated project.                                                                                                               |
  | DigitalOcean | [API → Tokens](https://cloud.digitalocean.com/account/api/tokens) ([docs](https://docs.digitalocean.com/reference/api/create-personal-access-token/)) | Custom scopes: `droplet:create,read,delete`, `firewall:create,read`, `tag:create,read`, `ssh_key:create,read`, `image:read`, `sizes:read`, `regions:read`, `actions:read`, `account:read` |
  | Vultr        | [Account → API](https://console.vultr.com/settings/#settingsapi)                                                                                      | An API-only sub-user with `provisioning`, `subscriptions`, and `firewall`. The key's IP access control must allow the control plane's egress.                                             |
  | Linode       | [Profile → API Tokens](https://cloud.linode.com/profile/tokens) ([docs](https://techdocs.akamai.com/linode-api/reference/get-started))                | Linodes Read/Write, Firewalls Read/Write, Images Read Only, and nothing else. The user must be unrestricted.                                                                              |

- **The join token in user data.** cloud-init writes it to
  `/run/roundhouse/join-token` (root, 0600, tmpfs) and `install.sh` reads it
  with `--token-file`. It never appears in `runcmd`, a command line, or the
  process list. The join script deletes cloud-init's cached copies before
  joining and shreds the token file on exit.
- **The exposure window.** Every provider keeps serving user data from its
  link-local metadata service for the server's whole life (Linode behind a
  local token request anyone on the box can make), and the provider API can
  return it to anyone holding the provider token. This is acceptable only
  because the join token is single-use and expires 15 minutes after it is
  minted. The join consumes it seconds after first boot, before any
  workload or second user exists, so a copy read later is worthless. Never
  put any other secret in user data.
- **Transport.** The control plane URL must be `https://`, and `install.sh`
  is fetched with `curl --proto '=https' --tlsv1.2`. `allowLoopbackHttp` is
  a development switch only.
- **Firewall.** Agents dial out, so there are no control ports. Inbound is
  limited to 80/tcp, 443/tcp, 443/udp, and 22/tcp only with `allowSsh`. Each
  managed firewall is created once and never rewritten, so operators can
  tighten it in the console.
- **Deletion.** `deprovision` deletes only servers carrying the managed
  marker and, with `expectedName`, the right node label. Contradictory
  managed tags make a server read as unmanaged.

## Adding a provider

1. Add the ID to `ProviderId` in `src/errors.ts` and an entry to `PROVIDERS`
   and `createProvider` in `src/provider.ts`.
2. Create `src/<provider>/` containing:
   - `types.ts` for the wire types;
   - `client.ts`, built on `HttpClient`, with auth, the error mapper to
     normalised codes and retry policy, pagination, rate-limit headers, and
     `validateToken`;
   - `mapping.ts` with pure offer, image, server, and firewall mappings and
     a `TagCodec` if it has tags;
   - `driver.ts` implementing `ProviderDriver`;
   - `index.ts`.
3. Map the neutral `FirewallSpec` to its firewall, making sure egress stays
   open. Decide how a managed firewall is recognised.
4. Pick a tag format the provider accepts, and enforce its limits in
   `validateName`/`validateLabels`.
5. Never surface a root password. Never retry a create on an ambiguous
   failure. `deleteServer` must throw `not_found` when the server is gone.
6. Verify every endpoint against the provider's current docs and record the
   sources, with dates, in `SOURCES.md`.
7. Add fixtures from the docs in `test/fixtures/<provider>/` (with a
   README), a fake in `test/fakes/`, and a target in `test/targets.ts`. The
   adapter is done when `test/conformance.test.ts` passes unchanged and its
   own tests cover its quirks.

## Test

```sh
pnpm --filter @roundhouse/providers test
```

Tests run against in-memory fakes of each API (`test/fakes/`) built from
documented response shapes (`test/fixtures/<provider>/`). The conformance
suite runs the same behavioural tests against all four adapters.
