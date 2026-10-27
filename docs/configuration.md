# Configuration

Every setting Roundhouse reads, per component: what it does, whether it is a
secret, its default and where it is set. Settings not listed here do not
exist; if you find one in the code that is missing, that is a bug in this
page (`apps/api/test/configuration.test.ts` catches it for the control plane).

Roundhouse keeps configuration small on purpose. Almost everything an
operator changes (GitHub App, cloud providers, MCP, instance settings) lives
in the control plane's database, sealed under keys derived from
`MASTER_KEY`, and is managed in the dashboard. What remains below is what has
to exist before the dashboard can start, plus development knobs.
- [Control plane](#control-plane): secrets, variables, bindings
- [Dashboard](#dashboard) and [landing site](#landing-site)
- [Node agent](#node-agent): config file, flags, environment
- [Node installer](#node-installer) and [CLI installer](#cli-installer)
- [CLI](#cli): environment and files
- [Development and tests](#development-and-tests)
- [CI and releases](#ci-and-releases)
- [What must never be committed](#what-must-never-be-committed)

Runbooks: [emergency re-join after a signing-key compromise](runbooks/emergency-rejoin.md).

## Control plane

The control plane is a Cloudflare Worker (`apps/api`). Its settings are
Worker secrets or plain-text variables, typed in `apps/api/src/env.ts`. All
are optional at deploy time; the setup wizard refuses to run until
`MASTER_KEY` is set.

### Secrets

| Name                   | Required | Purpose                                                                                                                             |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `MASTER_KEY`           | yes      | Base64 of 32 random bytes. The root of every key: the auth secret, the key-encryption key for project data keys, instance secrets.  |
| `MASTER_KEYS_PREVIOUS` | no       | Comma-separated base64 keys that `MASTER_KEY` replaced, newest first. Set only during a [rotation](#rotating-the-master-key).       |
| `CF_ANALYTICS_TOKEN`   | no       | Cloudflare API token with Account Analytics Read, for reading metrics back from Analytics Engine. Without it metrics use D1 (48 h). |

Set them with Wrangler, which prompts for the value so it never reaches your
shell history:

```sh
cd apps/api
openssl rand -base64 32 | npx wrangler secret put MASTER_KEY
npx wrangler secret list
```

Keep an offline copy of `MASTER_KEY` (a password manager or a sealed backup).
Without it, every sealed value in the database (variables, GitHub App
credentials, provider tokens) is unrecoverable.

### Variables

| Name               | Default                                | Purpose                                                                                                                                                                                                                                                                                                   |
| ------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`    | required                               | The control plane's public origin, e.g. `https://cp.example.com` (https, no path). The only source of absolute URLs, cookies and the same-origin check (ADR 0014); without it the API answers `503 public_origin_missing`.                                                                                |
| `ROUNDHOUSE_DEV`   | unset                                  | `1` in local development only: uses the request's origin when `PUBLIC_ORIGIN` is unset, allows `http://` OAuth issuers and provider callbacks, and lets agents run workloads over `ws://`. Never set it in production.                                                                                    |
| `CF_ACCOUNT_ID`    | unset                                  | Cloudflare account ID, needed with `CF_ANALYTICS_TOKEN` to query the Analytics Engine SQL API.                                                                                                                                                                                                            |
| `METRICS_BACKEND`  | auto                                   | `d1` forces the short-retention D1 metrics store; `analytics_engine` refuses to fall back. Unset uses Analytics Engine when `CF_ACCOUNT_ID` and `CF_ANALYTICS_TOKEN` are set, D1 otherwise.                                                                                                               |
| `DNS_RESOLVER_URL` | `https://cloudflare-dns.com/dns-query` | DNS-over-HTTPS JSON endpoint for custom-domain checks, e.g. one that sees split-horizon records. Google's resolver is always the fallback.                                                                                                                                                                |
| `GITHUB_API_URL`   | `https://api.github.com`               | GitHub REST API origin for every App call (tokens, commit statuses, PR comments, labels, collaborator checks): GitHub Enterprise, or a fake GitHub in end-to-end tests. Must be `https://` (plain `http://` only with `ROUNDHOUSE_DEV=1`); a malformed value fails GitHub calls rather than falling back. |

Variables can be set as secrets too (`wrangler secret put PUBLIC_ORIGIN`),
which is the simplest way to keep them out of `wrangler.jsonc`. Plain-text
variables set in the Cloudflare dashboard survive `pnpm run deploy` because
`wrangler.jsonc` sets `keep_vars: true`.

### Test and development knobs

Leave these unset in production. The test suites and `.dev.vars` use them to
make slow paths fast.

| Name                       | Default | Purpose                                                                   |
| -------------------------- | ------- | ------------------------------------------------------------------------- |
| `ROLLOUT_TIMEOUT_S`        | `600`   | Seconds a rollout waits for healthy replicas; accepted from 10 up to 600. |
| `PROVISION_JOIN_TIMEOUT_S` | `600`   | Seconds a provisioned cloud server gets to join before the run fails.     |
| `PROVISION_JOIN_POLL_S`    | `10`    | Seconds between join checks while provisioning.                           |
| `METRICS_INTERVAL_MS`      | `15000` | Agent metrics sampling interval, in ms (1000 to 300000).                  |

### Bindings

Declared in `apps/api/wrangler.jsonc`. `pnpm run deploy` creates the D1
database, the R2 bucket, the Durable Object namespaces and the Workflows on
the first deploy; there are no IDs to copy.

| Binding                     | Kind             | Purpose                                                                 |
| --------------------------- | ---------------- | ----------------------------------------------------------------------- |
| `DB`                        | D1               | Control-plane metadata (`roundhouse`), migrations in `packages/db`      |
| `LOGS`                      | R2               | Log chunks (`roundhouse-logs`)                                          |
| `ASSETS`                    | Static assets    | The dashboard build (`apps/web/dist`)                                   |
| `NODE_CONNECTION`           | Durable Object   | One per node: the agent's socket                                        |
| `PROJECT_ROOM`              | Durable Object   | One per project: the dashboard's realtime socket                        |
| `AUDIT_CHAIN`               | Durable Object   | One per install: hash-chains audit entries                              |
| `DEPLOY_WORKFLOW`           | Workflow         | The deploy pipeline, one instance per deployment                        |
| `KEY_ROTATION_WORKFLOW`     | Workflow         | Re-seals stored secrets under the current master key                    |
| `PROVISION_WORKFLOW`        | Workflow         | One-click cloud server provisioning                                     |
| `BACKUP_WORKFLOW`           | Workflow         | One database or volume backup per instance                              |
| `RESTORE_WORKFLOW`          | Workflow         | One restore per instance                                                |
| `VOLUME_MIGRATION_WORKFLOW` | Workflow         | One move of a volume between nodes per instance                         |
| `CERT_WORKFLOW`             | Workflow         | One certificate order per attempt (managed TLS, ADR 0009)               |
| `CRON_RUN_WORKFLOW`         | Workflow         | One cron run per instance (ADR 0010)                                    |
| `PREVIEW_WORKFLOW`          | Workflow         | Pull request previews: one instance per delivery and project (ADR 0007) |
| `AUTH_LIMITER`              | Rate limit       | 10 a minute per IP on secret-accepting endpoints and agent connects     |
| `WEBHOOK_LIMITER`           | Rate limit       | 300 a minute per IP on the GitHub webhook receiver                      |
| `MCP_LIMITER`               | Rate limit       | 60 a minute per token on MCP tool calls                                 |
| `ACME_LIMITER`              | Rate limit       | 60 a minute per IP on the public ACME HTTP-01 responder                 |
| `METRICS`                   | Analytics Engine | Metrics dataset (`roundhouse_metrics`); optional, absent in development |

Two cron triggers run in the same Worker: hourly retention (`17 * * * *`),
which also applies backup retention, and a minute tick that seals the audit
chain, checks custom domains, starts certificate orders and renewals (managed
TLS), starts scheduled backups, sends volume deletions past their grace
period, expires idle PR previews, admits queued ones, and removes torn-down
preview environments once their volumes are gone.

### Stored in the database, not in the environment

These are configured in the dashboard and sealed in D1, so there are no
environment variables for them: the GitHub App (created from a manifest in the
dashboard), cloud provider tokens (Hetzner, DigitalOcean, Vultr, Linode),
instance settings such as MCP on/off and backup storage (an S3-compatible
bucket; its secret access key is sealed and write-only), and every
project's variables.

Settings → Domains & TLS holds the TLS settings (ADR 0009):
- **TLS mode.** `acme` (each server's Caddy orders its own certificates;
  one ingress server only), `managed` (the control plane orders every
  certificate and hands it to the servers; any number of ingress servers),
  `internal` or `off`. `managed` needs `PUBLIC_ORIGIN` to be the
  control plane's `https://` origin: servers forward ACME HTTP-01
  challenges to `GET /v1/acme/http-01/{token}` there.
- **ACME CA.** Let's Encrypt production by default; any RFC 8555 directory
  URL works, and an optional contact address. The account key is created on
  the first order and sealed.
- **Cloudflare DNS.** A zone ID and an API token with Zone → DNS → Edit and
  Zone → Zone → Read on the apps domain's zone, sealed and write-only. It
  lets the control plane answer DNS-01: one `*.<apps_domain>` certificate
  covers every generated hostname, and wildcard custom domains become
  possible. Without it each generated hostname gets its own certificate,
  under Let's Encrypt's limit of 50 new certificates per registered domain a
  week.
- **Ingress hostname.** The name customers CNAME their domains to, kept by
  you as A/AAAA records of the ingress servers. Without it they CNAME to the
  service's generated hostname.

Every ingress server runs Caddy, but until the WireGuard mesh exists a
server routes a hostname only to replicas running on it. DNS for a custom
domain must point at servers that run the service; the dashboard and
`roundhouse domain` list exactly those when some servers don't.

### PR previews

Each project's previews are configured under Project → Previews
(`GET`/`PUT /v1/projects/{projectId}/preview-settings`, ADR 0007). Nothing
is set in the environment. Previews are off until enabled.

| Setting               | Default                                          | Purpose                                                                                                                                                                          |
| --------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | `false`                                          | Create a preview environment per pull request against a tracked branch.                                                                                                          |
| `base_environment_id` | production                                       | The environment previews copy configs and variables from. Never a preview environment.                                                                                           |
| `services`            | every git service                                | Git services built at the PR's head; a PR matches when one of them tracks its base repository and branch through the delivering installation. Other services deploy as they are. |
| `ttl_hours`           | `72`                                             | Hours without activity before a preview is torn down (`expired`); 1 to 720. A later push recreates it.                                                                           |
| `max_active`          | `5`                                              | Previews creating or running at once; 1 to 50. Further ones wait as `queued_limit` and start when one ends.                                                                      |
| `caps`                | 1 replica, 1000 mCPU, 1024 MiB, 1024 MiB volumes | Upper bounds per preview service; never raises a base value.                                                                                                                     |
| `skip_drafts`         | `true`                                           | Draft PRs get no preview; converting to draft tears it down.                                                                                                                     |
| `same_repo_secrets`   | `copy`                                           | `omit` gives same-repository PRs placeholders instead of secrets, like forks.                                                                                                    |
| `fork_policy`         | `disabled`                                       | `approval`: a fork PR builds only after someone with write access approves its exact head commit (label or dashboard); every push needs a new approval.                          |
| `approval_label`      | `roundhouse:preview`                             | The label that approves a fork PR's head. The sender's permission is checked with GitHub's collaborators API.                                                                    |
| `build_node_selector` | `{}`                                             | Required with `fork_policy: approval`: labels of the builder nodes fork code builds on. They never build the project's other environments, and other builds avoid them.          |
| `node_selector`       | `{}`                                             | Merged into every preview service's placement.                                                                                                                                   |
| `comment`             | `true`                                           | Keep one comment per PR with each service's status and URL. Comments and statuses never carry variable values or build output.                                                   |

A fork preview, or any preview with `same_repo_secrets: omit`, gets empty
placeholders (`withheld`) for every secret variable, every plain one whose
value looks like a credential or resolves through a secret, and every build
secret. Its databases start empty with fresh credentials. Every preview
builds in a separate per-project preview BuildKit daemon and cache, which
needs agents at protocol version 7.

GitHub Apps created before previews must subscribe to the **Pull request**
event in the App's settings; the Previews page says so until a
`pull_request` delivery arrives.

### Rotating the master key

Rotation keeps the install readable throughout (ADR 0014 "Rotation"):
1. Generate a new key. Set `MASTER_KEYS_PREVIOUS` to the current key,
   prepended to any earlier ones, then set `MASTER_KEY` to the new key:

   ```sh
   npx wrangler secret put MASTER_KEYS_PREVIOUS   # the old key (old,older,… if any)
   openssl rand -base64 32 | npx wrangler secret put MASTER_KEY
   ```

   Values sealed under the previous keys stay readable. Everyone is signed
   out, because the auth secret is derived from `MASTER_KEY`.
2. As an instance admin, start the re-seal with
   `POST /v1/instance/keys/rotate` (it needs a fresh sign-in and is audited).
   `KeyRotationWorkflow` moves every sealed value to the new key in batches.
3. Poll `GET /v1/instance/keys`. When `previous_keys_removable` is `true`,
   remove the old keys and destroy their copies:

   ```sh
   npx wrangler secret delete MASTER_KEYS_PREVIOUS
   ```

Never drop `MASTER_KEYS_PREVIOUS` before step 3: anything still sealed under
an old key becomes unreadable.

## Dashboard

`apps/web` reads no environment variables at build time; everything it needs
comes from the control plane's API at runtime, and production builds are
served by the Worker itself (`ASSETS`). In development the Vite server
proxies `/v1` (WebSockets included) and `/api` to `wrangler dev` on
`http://127.0.0.1:8787`.

## Landing site

| Name           | Default | Purpose                                                                |
| -------------- | ------- | ---------------------------------------------------------------------- |
| `LANDING_BASE` | `/`     | Vite `base` for `apps/landing`; `pages.yml` sets the GitHub Pages path |

## Node agent

The agent (`roundhouse-agent`) is configured by `roundhouse-agent join`,
which `install.sh` runs. You do not normally edit anything by hand.

### Config file

`/etc/roundhouse/agent.yaml` on Linux (`--config` to change it; a per-user
directory on other systems, for development). Written mode 0600 by `join`.
Unknown keys are rejected. An annotated example is
[`install/agent.example.yaml`](../install/agent.example.yaml).

| Key                   | Required | Purpose                                                                                          |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `control_plane_url`   | yes      | The control plane's `https://` origin                                                            |
| `node_id`             | yes      | Assigned at join                                                                                 |
| `connect_url`         | yes      | `wss://` URL of the control socket; same host and port as `control_plane_url`                    |
| `control_public_key`  | yes      | The control plane's Ed25519 public key, pinned at join                                           |
| `control_key_id`      | no       | Its envelope key id, pinned by the agent from the first verified welcome                         |
| `credential_file`     | yes      | Path of the bearer credential (secret, 0600)                                                     |
| `identity_key_file`   | yes      | Path of the node's Ed25519 private key (secret, 0600)                                            |
| `encryption_key_file` | no       | Path of the node's X25519 private key, which opens sealed env (secret, 0600); created if missing |
| `state_file`          | yes      | State that must survive restarts                                                                 |
| `data_dir`            | no       | Log buffer, registry storage, build checkouts. Default: the directory of `state_file`            |
| `builder`             | no       | `true` on build nodes (`join --builder`)                                                         |
| `insecure`            | no       | `true` allows plaintext to a non-loopback control plane (`join --insecure`). Testing only        |
| `ingress.certs_dir`   | no       | Where managed-TLS certificates are written for Caddy. Default `/var/lib/roundhouse-certs`        |

The secret files live in `/var/lib/roundhouse` (`--data-dir` to change it).
The config file itself holds no secrets.

### Commands and flags

| Command | Flag           | Purpose                                                                         |
| ------- | -------------- | ------------------------------------------------------------------------------- |
| `join`  | `--url`        | Control plane URL (required)                                                    |
| `join`  | `--token-file` | File holding the single-use join token; preferred over `--token`                |
| `join`  | `--token`      | The join token itself; visible in the process list                              |
| `join`  | `--name`       | Node display name (default: hostname)                                           |
| `join`  | `--config`     | Config file to write (default above)                                            |
| `join`  | `--data-dir`   | Where the credential, keys and state go (default `/var/lib/roundhouse`)         |
| `join`  | `--builder`    | Make this a build node                                                          |
| `join`  | `--force`      | Replace an existing joined config                                               |
| `join`  | `--insecure`   | Allow plaintext `http://`/`ws://` to a non-loopback control plane. Testing only |
| `run`   | `--config`     | Config file to read (the systemd unit passes `/etc/roundhouse/agent.yaml`)      |

### Environment

| Name                                    | Purpose                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ROUNDHOUSE_JOIN_TOKEN`                 | Join token for `join` when neither `--token` nor `--token-file` is given (secret)                                                         |
| `ROUNDHOUSE_DEV`                        | `1` lets the agent run workloads and builds over plaintext `ws://`. Development only                                                      |
| `ROUNDHOUSE_BUILDKIT_APPARMOR_PROFILE`  | AppArmor profile for the BuildKit container, overriding detection of the `roundhouse-buildkit` profile                                    |
| `DOCKER_HOST`                           | Docker Engine endpoint (default: `unix:///var/run/docker.sock`)                                                                           |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | Outbound proxy, passed to git and Railpack during builds (lowercase forms too). Nothing else from the agent's environment reaches a build |

To set these under systemd, use a drop-in (`systemctl edit roundhouse-agent`)
with `Environment=` lines; do not edit the unit file, which `install.sh`
replaces on every run.

## Node installer

`install.sh`, served by the control plane at `/install.sh`, installs the
agent, Docker, Caddy and (on builders) Railpack, then joins. See
[`install/README.md`](../install/README.md).

| Option             | Purpose                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ |
| `--token <t>`      | Single-use join token from the dashboard                                             |
| `--token-file <p>` | Read the join token from a file (cloud-init, automation)                             |
| `--name <n>`       | Node display name (default: hostname)                                                |
| `--url <u>`        | Control plane URL (default: the origin that served the script)                       |
| `--version <v>`    | Agent version (default: the version the control plane pins, else the latest release) |
| `--rejoin`         | Re-register a host that has already joined                                           |
| `--builder`        | Make this node a builder                                                             |
| `--binary <p>`     | Development only: install a local agent binary without signature verification        |

| Environment                      | Default                                                     | Purpose                                                            |
| -------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `ROUNDHOUSE_DOWNLOAD_BASE`       | `https://github.com/BankkRoll/Roundhouse/releases/download` | Release mirror with the GitHub layout (`<base>/agent-v<v>/`)       |
| `ROUNDHOUSE_SKIP_OS_CHECK`       | unset                                                       | `1` installs on an unsupported distribution                        |
| `ROUNDHOUSE_INSTALL_SOURCE_ONLY` | unset                                                       | `1` makes sourcing the script define its functions only; for tests |

`uninstall.sh` takes no options.

## CLI installer

`install/install-cli.sh` installs the `roundhouse` CLI on Linux and macOS from
a signed `cli-v*` release. See [`cli/README.md`](../cli/README.md#install).

| Option / environment                       | Default                                                     | Purpose                                                            |
| ------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `--version <v>` / `ROUNDHOUSE_CLI_VERSION` | newest `cli-v*` release that is not a prerelease            | CLI version to install                                             |
| `--dir <path>` / `ROUNDHOUSE_INSTALL_DIR`  | `/usr/local/bin` as root, else `~/.local/bin`               | Install directory                                                  |
| `--insecure-skip-signature`                | off                                                         | Skip the signature on `SHA256SUMS` (the checksum is still checked) |
| `ROUNDHOUSE_DOWNLOAD_BASE`                 | `https://github.com/BankkRoll/Roundhouse/releases/download` | Release mirror (`<base>/cli-v<v>/`); needs an explicit version     |
| `ROUNDHOUSE_INSTALL_SOURCE_ONLY`           | unset                                                       | `1` makes sourcing the script define its functions only; for tests |

## CLI

| Environment             | Purpose                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `ROUNDHOUSE_URL`        | Control plane URL, overriding the profile's                                          |
| `ROUNDHOUSE_TOKEN`      | API token (`tok_…`) for CI and scripts, overriding the profile's session (secret)    |
| `ROUNDHOUSE_PROFILE`    | Profile to use when `--profile` is not given                                         |
| `ROUNDHOUSE_CONFIG_DIR` | Where `credentials.json` lives (default: `roundhouse` under the OS config directory) |
| `NO_COLOR`              | Any value disables colour, as does `TERM=dumb`                                       |
| `CI`                    | Any value disables prompts, as `--no-input` does                                     |

| File                            | Purpose                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `<config dir>/credentials.json` | Profiles: URL and session cookie (secret, written 0600; the CLI warns if others can read it)                             |
| `.roundhouse/config.json`       | A directory's link to a workspace, project, environment and service. IDs only, no secrets; `link` offers to gitignore it |

The config directory is `~/.config/roundhouse` on Linux (or
`$XDG_CONFIG_HOME/roundhouse`), `~/Library/Application Support/roundhouse` on
macOS and `%AppData%\roundhouse` on Windows.

## Development and tests

`pnpm setup:dev` copies `apps/api/.dev.vars.example` to `apps/api/.dev.vars`
with a fresh `MASTER_KEY`, and `wrangler dev` reads it. The example lists
every control-plane setting above, with development values.

There is no root `.env` or `.env.example`: nothing in the repository loads
one. The scripts and test suites below read the process environment
directly, and every variable has a working default, so they run with none
set.

| Name                           | Used by                                   | Default                 | Purpose                                            |
| ------------------------------ | ----------------------------------------- | ----------------------- | -------------------------------------------------- |
| `DEV_API_PORT`                 | `scripts/dev-node.mjs` (`pnpm dev:node`)  | `8787`                  | Port of the local control plane the dev node joins |
| `SMOKE_PORT`                   | `e2e/agent-smoke.mjs`                     | `8799`                  | `wrangler dev` port for the agent smoke test       |
| `E2E_PORT`                     | `e2e/serve.mjs`, browser tests            | `8798`                  | `wrangler dev` port for the browser tests          |
| `PHASE1_PORT`                  | `e2e/phase1/run.mjs`                      | `8797`                  | `wrangler dev` port for the Phase 1 suite          |
| `PHASE1_GIT_PORT`              | Phase 1 suite                             | `18443`                 | Test git server port                               |
| `PHASE1_ROLLOUT_TIMEOUT_S`     | Phase 1 suite                             | `60`                    | Passed to the control plane as `ROLLOUT_TIMEOUT_S` |
| `PHASE1_UI`                    | Phase 1 suite                             | `1`                     | `0` skips the dashboard spec                       |
| `PHASE1_SKIP_WEB_BUILD`        | Phase 1 suite                             | unset                   | `1` reuses the existing `apps/web/dist`            |
| `PHASE1_KEEP`                  | Phase 1 suite                             | unset                   | `1` leaves the stack running                       |
| `PHASE1_KEEP_BUILD_CACHE`      | Phase 1 suite                             | unset                   | `1` keeps BuildKit's cache volume between runs     |
| `PHASE1_STACK`                 | Phase 1 tests                             | set by `run.mjs`        | Path of the running stack's description; internal  |
| `CI`                           | Playwright configs                        | unset                   | Any value switches to CI reporters                 |
| `ROUNDHOUSE_IT_KEEP`           | `agent/internal/builder` integration test | unset                   | `1` keeps the test's containers for inspection     |
| `VERSION`, `COMMIT`            | `cli/scripts/build.sh`                    | from git                | Version and commit stamped into the CLI            |
| `TARGETS`, `OUT_DIR`           | `cli/scripts/build.sh`                    | all targets, `cli/dist` | What to build and where                            |
| `ARCHIVE`, `SOURCE_DATE_EPOCH` | `cli/scripts/build.sh`                    | unset, commit time      | `1` writes the release archives; their timestamp   |

The end-to-end suites write their own throwaway `.dev.vars.e2e`,
`.dev.vars.smoke` and `.dev.vars.phase1` with fixed test keys and delete them
afterwards; the API tests set their bindings in `apps/api/vitest.config.ts`.

## CI and releases

| Secret                      | Where                       | Used by                               | Purpose                                                      |
| --------------------------- | --------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| `AGENT_RELEASE_SIGNING_KEY` | environment `agent-release` | `.github/workflows/release-agent.yml` | Ed25519 PEM key that signs agent `SHA256SUMS`                |
| `CLI_RELEASE_SIGNING_KEY`   | environment `cli-release`   | `.github/workflows/release-cli.yml`   | Ed25519 PEM key that signs CLI `SHA256SUMS`                  |
| `GITHUB_TOKEN`              | provided by Actions         | every workflow                        | Scoped per job by `permissions:`; releases use it to publish |

Both signing keys are environment secrets, never repository secrets, behind
required reviewers and tag-only deployment rules. Generating, installing and
rotating them is described in
[`infra/release-signing.md`](../infra/release-signing.md). No workflow uses
repository variables (`vars.*`), and `ci.yml` and `security.yml` use no
secrets.

## What must never be committed

`.gitignore` excludes `.dev.vars*` and `.env*` everywhere, except the
`*.example` templates. In particular, never commit or paste into an issue:
- `MASTER_KEY` or `MASTER_KEYS_PREVIOUS`, or a filled-in `.dev.vars`;
- a node's `credential`, `identity*.key` or `encryption*.key` files;
- the CLI's `credentials.json`, or an API token (`tok_…`);
- a release signing key (`*-release.key`).

If one leaks: rotate the master key as [above](#rotating-the-master-key);
delete the node in the dashboard and re-join it; revoke the token
(`roundhouse tokens revoke`); for a signing key, follow "Compromise" in
`infra/release-signing.md`.
