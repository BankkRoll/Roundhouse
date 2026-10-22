# @openrail/hetzner

Creates Hetzner Cloud servers that join a control plane on first boot. The user
pastes a Hetzner API token; the control plane lists live plans and prices,
creates the server with a join token in its cloud-init, and the agent joins
within seconds of boot.

Runtime-agnostic: only `fetch`, `AbortController`, timers, and WebCrypto, so it
runs in the Worker. No dependencies.

```ts
import { HetznerClient, listOffers, recommend, provisionServer } from "@openrail/hetzner";

const hz = new HetznerClient({ token: hetznerToken });
const offers = await listOffers(hz); // live types x locations, gross EUR
const picks = recommend(offers, { role: "app" }); // a few sensible choices
const server = await provisionServer(hz, {
  name: "web-1",
  serverType: picks[0].offer.serverType,
  location: picks[0].offer.location,
  controlPlaneUrl: "https://cp.example.com",
  joinToken, // fresh, from the join-token route
  sshPublicKey, // optional
  workspaceId,
});
// { serverId, ipv4, ipv6, status, created, ... }
```

## Modules

| Export                                                       | What                                                                                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `HetznerClient`                                              | Typed client: pagination, `RateLimit-*` throttling, `429` backoff, timeouts, `AbortSignal`, typed errors, `validateToken()` |
| `listOffers`, `buildOffers`, `recommend`                     | Server types joined with per-location prices; excludes deprecated and unavailable pairs                                     |
| `listSupportedImages`                                        | Ubuntu 22.04/24.04 and Debian 12, amd64 and arm64                                                                           |
| `buildUserData`                                              | `#cloud-config` that runs `install.sh --token-file`                                                                         |
| `defaultFirewallRules`, `ensureFirewall`                     | Inbound 80/tcp, 443/tcp, 443/udp, optional 22/tcp                                                                           |
| `provisionServer`, `deprovisionServer`, `listManagedServers` | Orchestration                                                                                                               |

## provisionServer

Validates input → validates the token (invalid vs read-only) → returns an
existing server labelled `roundhouse.managed=true,roundhouse.node=<name>` if
there is one → checks the type is orderable in the location → ensures the
firewall and SSH key → creates the server → waits for its actions.
- **Idempotent.** Retrying with the same `name` returns the existing server
  (`created: false`). A lost response to the create call is recovered by label,
  never by creating a second server.
- **Cleanup.** If anything fails after the server exists, including the
  caller aborting, the server is deleted and `ProvisionError` is thrown with
  `reason: "failed_cleaned_up"`. If that delete also fails, the reason is
  `failed_cleanup_failed` and `serverId` must be recorded and retried.
- **Errors.** `ProvisionError.reason` is machine-readable (`token_invalid`,
  `token_read_only`, `name_taken`, `server_type_unavailable`, …). API
  failures before the server exists surface as `HetznerApiError` with
  Hetzner's `code` (e.g. `resource_limit_exceeded`).

`deprovisionServer` refuses any server without `roundhouse.managed=true`
(and, with `expectedName`, a different `roundhouse.node`), so a user's own
servers in the same project are never deleted.

## Security

- **Join token in user data.** The token is written by cloud-init to
  `/run/roundhouse/join-token` (root, 0600, tmpfs) and passed to `install.sh`
  with `--token-file`. It is never in `runcmd`, a command line, or the process
  list. The join script deletes cloud-init's root-only copies of the user data
  before joining and shreds the token file on exit, so the token file is the
  only copy on the machine while the join runs.
- **Metadata service.** Hetzner serves user data at
  `http://169.254.169.254/hetzner/v1/userdata` to any process on the server
  for the server's whole life, and cloud-init re-caches it on reboot. This is
  acceptable because the token is single-use and expires 15 minutes after it is
  minted. The join consumes it seconds after first boot, before any workload or
  second user exists, so a copy read later is worthless. Do not put any other
  secret in user data.
- **Transport.** The control plane URL must be `https://`; `install.sh` is
  fetched with `curl --proto '=https' --tlsv1.2`. `allowLoopbackHttp` is a
  development switch for running the user data in a local VM. A Hetzner
  server can never reach your loopback.
- **Root password.** Without an SSH key Hetzner generates a root password and
  returns it once in the create response. This package drops it. Port 22 is
  closed unless `allowSsh` is set.
- **Firewall.** Agents dial out, so there are no control ports. The firewall is
  created once and never rewritten, so operators can tighten it in the console.

## Not hard-coded

Plan names and prices change. `listOffers` reads them live from
`GET /server_types` and `GET /pricing` on every call. Cache for minutes, not
days. `SOURCES.md` lists the documentation each call was checked against.

## Test

```sh
pnpm --filter @openrail/hetzner test
```

The tests run against an in-memory fake of the API (`test/fake-hetzner.ts`)
built from the documented response shapes in `test/fixtures/docs`.
