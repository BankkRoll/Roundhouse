# roundhouse CLI

Deploy and manage services on a Roundhouse control plane from your terminal.
It talks to the control plane's REST API and realtime socket only.

## Install

Linux and macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/BankkRoll/Roundhouse/main/install/install-cli.sh | sh
```

The script picks the archive for your OS and architecture from the newest
`cli-v*` release, verifies the Ed25519 signature on `SHA256SUMS` against the
release key pinned in it, checks the archive against `SHA256SUMS`, and
installs `roundhouse` to `/usr/local/bin` (as root) or `~/.local/bin`.
`--version 0.1.0` pins a release and `--dir <path>` picks the directory. The
signature check needs OpenSSL 3; on macOS that is `brew install openssl@3`.
All options are in [docs/configuration.md](../docs/configuration.md#cli-installer).

By hand, or on Windows: download `roundhouse-<os>-<arch>.tar.gz` (`.zip` for
Windows), `SHA256SUMS` and `SHA256SUMS.sig` from the
[release](https://github.com/BankkRoll/Roundhouse/releases), then

```sh
openssl pkeyutl -verify -pubin -inkey cli-release.pub -rawin \
  -in SHA256SUMS -sigfile SHA256SUMS.sig       # the key pinned in install-cli.sh
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf roundhouse-linux-amd64.tar.gz roundhouse
install -m 0755 roundhouse /usr/local/bin/roundhouse
```

Each release also has build provenance
(`gh attestation verify roundhouse-linux-amd64.tar.gz --repo BankkRoll/Roundhouse`)
and a CycloneDX SBOM per archive; see
[infra/release-signing.md](../infra/release-signing.md).

Or build from source (Go 1.26):

```sh
go install github.com/BankkRoll/Roundhouse/cli/cmd/roundhouse@latest
cli/scripts/build.sh             # every OS/arch into cli/dist, with SHA256SUMS
ARCHIVE=1 cli/scripts/build.sh   # release archives; a clean checkout of a tag rebuilds them exactly
```

Shell completion: `roundhouse completion bash|zsh|fish|powershell --help`.

## Log in

```sh
roundhouse login --url https://roundhouse.example.com
roundhouse whoami
```

The password is read without echo. The session cookie is stored in
`credentials.json` (mode 0600) under your OS config directory
(`~/.config/roundhouse`, `~/Library/Application Support/roundhouse`,
`%AppData%\roundhouse`); a warning is printed if the file becomes readable by
others. Keep several control planes apart with `--profile staging`.

On Git Bash (mintty) stdin is not a console, so pipe the password with
`--password-stdin` or run `winpty roundhouse login`.

With two-factor authentication on, `login` then asks for the 6-digit code
from your authenticator app, or one of your backup codes; pass it with
`--code` when there is no terminal to prompt on. After 5 failed attempts the
account is locked for a while (30 seconds, doubling up to an hour), and
`login` says how long.

When the control plane refreshes your session, the CLI saves the new cookie
to `credentials.json`; when it ends the session, the CLI forgets it and asks
you to log in again.

For CI and scripts, use an API token instead of logging in; see
[API tokens](#api-tokens).

## Link a directory

```sh
roundhouse init                     # create a project and link to it
roundhouse link                     # or pick an existing one interactively
roundhouse link --project shop --service api --environment production
```

This writes `.roundhouse/config.json` (IDs only, no secrets) and offers to
add it to `.gitignore`. Commands find the link from any subdirectory; flags
such as `--service` and `--environment` override it per command.

## Templates

```sh
roundhouse templates list
roundhouse templates show n8n
roundhouse templates deploy n8n --input WEBHOOK_URL=https://n8n.example.com --yes
roundhouse templates deploy whoami --linked --environment staging --no-deploy
roundhouse init --template n8n --input ADMIN_PASSWORD=- --yes < password.txt
```

`templates deploy` creates a project from a template (`--name`, `--slug`,
`--workspace`) and starts each service's first deployment unless
`--no-deploy` is given. With `--linked`, `--project` or `--environment` it
adds the services to that project instead. `--input KEY=VALUE` sets an
input (`-` reads stdin); required inputs left out are asked for on a
terminal, secret ones without echo, and fail with exit 12 in scripts.
Generated and secret variables are write-only, so the CLI asks first;
`--yes` confirms. `templates show` lists them by name only. A template
needing a feature the control plane lacks exits 6. `init --template` does
the same as a new-project deploy and links the directory.

## Deploy and follow

```sh
roundhouse deploy --wait            # exit 8 if it fails
roundhouse logs -f                  # history, then live lines
roundhouse logs --build -f          # build output of the latest deployment
roundhouse logs --since 30m --json  # NDJSON
roundhouse rollback                 # to the deployment before the current one
roundhouse status
```

## Metrics

```sh
roundhouse metrics                          # last hour of the linked service
roundhouse metrics --range 24h -m cpu,memory
roundhouse metrics --from 2026-10-21T09:00:00Z --to 2026-10-21T12:00:00Z
roundhouse metrics --replicas               # one row per replica
roundhouse metrics summary                  # every service, last 5 minutes
roundhouse servers metrics web-1 --range 7d
roundhouse metrics --json                   # the API response as is
```

Each metric shows its latest value, average and peak over the range, with
the service's limit where it has one: CPU in millicores (`1000m` is one
core) and as a share of the limit, memory in binary units, network and disk
as rates. `--range` takes `1h`, `6h`, `24h`, `7d` or `30d`; `--from` and
`--to` take a duration ago (`90m`, `2d`) or a time, and the range may span
90 days. `-m` repeats or takes a comma-separated list; `network` and `disk`
select both directions. On a terminal each row ends with a sparkline of the
range (peaks per bar, so short spikes stay visible); piped output has none.

A note on stderr says when the control plane keeps metrics for 48 hours
only (its D1 fallback, without Analytics Engine) or when some samples are
approximate (Docker stats on a cgroup v1 host). `--json` carries both as
`short_retention` and `approximate`; points are `[t_ms, value]`, with
`null` for a step without samples.

## Databases

```sh
roundhouse db create --engine postgres      # also mysql, redis (Valkey), mongodb
roundhouse db list                          # engines, volumes, usage
roundhouse db info                          # volume and connection references
roundhouse db query "SELECT id, email FROM users LIMIT 10"
roundhouse db query 'SELECT * FROM orders WHERE user_id = $1' --param 42
roundhouse db tables --namespace public
roundhouse db volume resize --size-mb 20480 # grow only
roundhouse db volume delete --yes           # data removed after 72 hours
roundhouse db volume undelete
```

`db create` adds a database service with a volume in every environment and
generated credentials stored as write-only secrets. Other services reference
them, e.g. `roundhouse vars set 'DATABASE_URL=${{postgres.DATABASE_URL}}'`;
`db info` lists those references and never a value. Commands act on
`--service`, else the linked service when it is a database, else the
project's only database, and ask when there are several.

`db query` is read-only: it runs as the database's read-only principal in a
read-only transaction, one statement at a time (SQL with `--param` values, a
JSON command document for MongoDB, a command line for Valkey and Redis).
Results print as a table with control characters escaped and long cells
shortened; the row count, timing, truncation (`--max-rows`, up to 1000) and
engine notices go to stderr. `--json` prints the API's result as is. An
engine error (a syntax error, a refused write) exits 1. The control plane
audits every statement and never stores results.

### Backups

```sh
roundhouse db backups list
roundhouse db backups run --wait
roundhouse db backups policy                # schedule, next runs, retention
roundhouse db backups policy set --schedule "0 2 * * *" --keep-last 14 --max-age-days 30
roundhouse db backups restore bak_01J9Z6Y4M0V8 --mode in_place --confirm postgres --wait
roundhouse db backups restore bak_01J9Z6Y4M0V8 --mode new_service --slug postgres-copy
roundhouse db backups download bak_01J9Z6Y4M0V8 --decrypt -o shop.rhbk.zst
```

Schedules are five-field cron in UTC. Manual backups are pinned, so
`--keep-last` never prunes them. Without a backup bucket (an instance admin
sets one under Settings → Backups) backup commands exit 6 with
`backup_storage_not_configured`.

`restore` asks for the database's slug (`--confirm` in scripts); `in_place`
takes a safety backup first unless `--skip-safety-backup` is given.
`new_service` adds a new database (`--slug`, default
`<slug>-restore-<yyyymmdd>`; `--environment`, default the backup's) and
restores into it, leaving the original untouched; only a dump restores this
way, so a snapshot of a service that is not a database exits 7 with
`restore_mode_unsupported`.
Restoring and decrypting need a recent sign-in: on `reauth_required` (exit
4) run `roundhouse login` again. API tokens never qualify.

`download` fetches the encrypted object straight from object storage,
without the control plane's credential, verifies its SHA-256, and writes it
with `0600` permissions under a temporary name that is renamed only once it
checks out. `--decrypt` fetches the project's backup key (audited) and
decrypts with [age](https://age-encryption.org) as it downloads; the key is
never printed or saved. The result is a zstd-compressed RHBK1 archive
(`packages/protocol/rhbk.md`). `-o -` writes to stdout; an existing file is
replaced only with `--force`.

### Moving volumes, TCP proxies and credential rotation

```sh
roundhouse db volume move --list-targets    # servers, why not, estimated downtime
roundhouse db volume move --to edge-2 --wait
roundhouse db volume migrations
roundhouse db tcp-proxy                     # endpoint, status, allowlist
roundhouse db tcp-proxy enable --allow 203.0.113.7 --allow 198.51.100.0/24
roundhouse db tcp-proxy disable --yes
roundhouse db rotate-credentials --principal app --principal readonly
roundhouse db rotations
```

`volume move` copies the volume to another server through the backup
bucket and redeploys the service there; the service is down for the whole
copy. A server that cannot take the volume is listed with its reason, and
`--wait` prints each phase as the move goes. It asks for the service's slug
(`--confirm` or `--yes` in scripts).

`tcp-proxy enable` publishes the service's port on its server behind a
source allowlist (`--allow`, repeatable; every other source is dropped).
`0.0.0.0/0` is refused unless `--allow-open` is given, which prints a
warning: the port is then reachable from the whole internet and
unencrypted unless the client and the database negotiate TLS.

`rotate-credentials` sets new passwords in the database, stores them as
write-only secrets and redeploys the database and every service using them;
no password is printed. A rotation left `running` by an interrupted call is
finished by running the command again. Moving, publishing and rotating need
a recent sign-in, like restores.

## Variables

```sh
roundhouse vars
roundhouse vars set NODE_ENV=production 'DATABASE_URL=${{db.DATABASE_URL}}'
roundhouse vars set --secret STRIPE_KEY=- < stripe.key
roundhouse vars set --secret --build NPM_TOKEN=- < npm-token.txt
roundhouse vars import .env
roundhouse vars export > .env.example
roundhouse run -- npm run dev
```

Every variable is `plain` or `secret`. Secrets are write-only: nothing, the
CLI included, can read a secret's value back, so `vars` and `vars get` show
`<secret fp:xxxxxxxx>` (a fingerprint: equal values have equal
fingerprints) and `vars export` leaves secrets out, naming them on stderr.
The control plane picks a new variable's tier from its name and value
(`API_KEY` or a `sk_live_…` value becomes secret, `VITE_…` stays plain);
`--secret` and `--plain` override it where the tier isn't locked. When it
would make a value secret that you didn't mark, `vars set` asks first; pass
`--yes` in scripts. `--build` passes a variable to builds (secrets as
BuildKit secrets, read with `RUN --mount=type=secret,id=KEY`), and
`--mount-as-file` delivers it as `/run/secrets/KEY`. A bare `KEY` without
`=VALUE` changes only these settings.

References (`${{service.VAR}}`, `${{shared.VAR}}`, `${{VAR}}`) are stored as
written. `run` asks the control plane for the service's plain environment
as a deployment gets it (references resolved, built-ins
such as `PORT` added); that needs the `variables:read_plain` permission and
is audited. Secret values never leave the control plane: secrets, and
variables whose value references one, come from a local env file instead
(`--env-file`, default `.env`, which may be absent), and a warning names any
it does not set. The values go to the child process alone; nothing is
written to disk. A control plane too old to resolve variables makes `run`
exit 10.

## API tokens

API tokens authenticate CI and scripts without a login. Each belongs to one
workspace and carries scopes (RBAC actions such as `services:read` or
`deployments:create`); a request outside its workspace is a 404 (exit 5),
one outside its scopes a 403 (exit 4). Creating and revoking tokens needs
`tokens:manage`.

```sh
roundhouse tokens create --name ci --preset deploy             # 90 days by default
roundhouse tokens create --name grafana --preset read --expires never
roundhouse tokens create --name audit --scope workspace:read --scope audit:read --expires 30d
roundhouse tokens list
roundhouse tokens revoke ci                                     # asks; --yes in scripts
```

Presets: `read` is `workspace:read`, `projects:read`, `services:read`,
`variables:read` and `nodes:read`; `deploy` adds `services:manage`,
`deployments:create` and `variables:manage`. `--scope` may be repeated and
combined with a preset. `run` also needs `variables:read_plain`.

`create` prints the secret, alone, to stdout (or as `secret` with `--json`);
it is shown once and cannot be retrieved later. The workspace is the linked
one, `--workspace`, or your only one.

In CI, set the control plane and the token, link with flags, and deploy:

```sh
export ROUNDHOUSE_URL=https://roundhouse.example.com
export ROUNDHOUSE_TOKEN=tok_…        # from your CI's secret store
roundhouse link --project shop --service api --gitignore=false
roundhouse deploy --wait
```

`ROUNDHOUSE_TOKEN` overrides the profile's session. A value starting with
`tok_` is sent as `Authorization: Bearer`; any other value is taken as a
session token (the `value` in `credentials.json`) and sent as the session
cookie. `roundhouse whoami` shows which token is in use and its scopes.

## Commands

| Command                                                  | Purpose                                                   |
| -------------------------------------------------------- | --------------------------------------------------------- |
| `login`, `logout`, `whoami`                              | Manage the session of a profile                           |
| `init`, `link`, `unlink`                                 | Bind the directory to a project, environment and service  |
| `status`                                                 | Linked project and service, latest deployment, domains    |
| `open [--dashboard]`                                     | Open the service URL or the dashboard                     |
| `deploy [--wait]`                                        | Deploy the latest config                                  |
| `logs [-f] [--build] [--deployment] [--since] [-n]`      | Show and follow logs                                      |
| `metrics [--range\|--from --to] [-m] [--replicas]`       | Service CPU, memory, network and disk over a range        |
| `metrics summary`                                        | Every service's current CPU and memory                    |
| `rollback [deployment]`, `cancel [deployment]`           | Steer deployments                                         |
| `vars [get\|set\|unset\|import\|export]`                 | Service (or `--shared`) variables                         |
| `run -- <cmd>`                                           | Run a local command with the service's variables          |
| `projects list\|create\|delete`                          | Projects; deletes need the typed slug                     |
| `templates list\|show\|deploy`                           | Built-in templates; deploy as a new project or into one   |
| `services list\|create\|delete`                          | Services; deletes need the typed slug                     |
| `domain [--all]`                                         | The service's domains                                     |
| `servers list\|add [--provider]`                         | Servers; `add` prints the install command, or provisions  |
| `servers remove <server> [--keep-server] [-y]`           | Remove a server; deletes a provisioned cloud server too   |
| `servers cancel <provision-id> [--no-wait]`              | Cancel a provisioning run and delete what it created      |
| `servers metrics <server> [--range] [-m]`                | A server's CPU, memory, disk and load                     |
| `db create\|list\|info\|query\|tables`                   | Database services and read-only queries                   |
| `db volume [resize\|move\|migrations\|delete\|undelete]` | A database's volume; moves it between servers             |
| `db tcp-proxy [show\|enable\|disable]`                   | Publish a database's port behind a source allowlist       |
| `db rotate-credentials`, `db rotations`                  | Rotate database passwords; redeploy everything using them |
| `db backups list\|run\|policy\|restore\|download`        | Backups, schedules, restores, decrypted downloads         |
| `tokens list\|create\|revoke`                            | Workspace API tokens for CI and scripts                   |
| `version`, `completion`                                  | Build info, shell completion                              |
| `up`, `shell`, `db connect`                              | Not available on the control plane yet (exit 10)          |

Every command takes `--json`, `--profile`, `--no-input`, `--no-color` and
`--debug` (HTTP traces with credentials redacted). Run
`roundhouse <command> --help` for flags and examples. Environment variables
(`ROUNDHOUSE_URL`, `ROUNDHOUSE_TOKEN`, `ROUNDHOUSE_PROFILE`,
`ROUNDHOUSE_CONFIG_DIR`, `NO_COLOR`) and files are listed in
[docs/configuration.md](../docs/configuration.md#cli).

### Cloud servers

`servers add --provider hetzner` creates a server on a provider connected in
the dashboard and waits until it joins. Ctrl-C only stops watching: the
server is still being created, and the CLI prints the
`roundhouse servers cancel <provision-id>` command that stops the run,
revokes its join token and deletes whatever it created.

`servers list` shows an estimated monthly cost for servers Roundhouse
provisioned, and a total per currency. The figure is the plan's price in the
provider's catalogue when the server was created: it leaves out traffic,
backups, taxes and later price changes, so the provider's invoice is what
counts.

`servers remove <server>` asks for confirmation (pass `-y` in scripts; without
a TTY it is a usage error otherwise). For a provisioned server it deletes the
cloud server as well, unless `--keep-server` is given. If the provider is no
longer connected the API refuses with `provider_not_connected` and keeps the
server listed: reconnect the provider, or pass `--keep-server` and delete the
cloud server in the provider's console.

## Scripting

Results go to stdout, progress and prompts to stderr. Without a TTY there is
no colour, no spinner and no prompt: a missing value fails with exit 12 and
names the flag to pass. Errors with `--json` are JSON on stderr.

| Exit | Meaning                                               |
| ---- | ----------------------------------------------------- |
| 0    | OK                                                    |
| 1    | Other error                                           |
| 2    | Usage error                                           |
| 3    | Not signed in, or the session expired                 |
| 4    | Forbidden by your role                                |
| 5    | Not found                                             |
| 6    | Conflict (e.g. nothing to cancel)                     |
| 7    | Invalid input (e.g. a malformed `${{` reference)      |
| 8    | A watched deployment failed, crashed or was cancelled |
| 9    | Directory not linked                                  |
| 10   | Not available on this control plane yet               |
| 11   | Network or server error                               |
| 12   | Input required in non-interactive mode                |
| 13   | Cloud server provisioning failed                      |
| 130  | Interrupted                                           |

## Security notes

- TLS certificates are always verified. Plain `http://` is accepted only for
  a loopback control plane and only with `--insecure`.
- Redirects are never followed, so the session cookie is only sent to the
  control plane you logged in to.
- The API rejects cross-origin mutations by `Origin`
  (`apps/api/src/lib/guards.ts`). The CLI sends no `Origin` on `/v1`
  requests, which that guard allows. It sends the control plane's own
  origin where it is required: the realtime WebSocket upgrade with a
  session cookie, and Better Auth's sign-out.
- Session cookies set by a response are only ever saved for the profile's
  own session; requests made with an API token ignore `Set-Cookie`.
- `logs -f` follows over the realtime socket (as a CLI client, left out of
  presence) and reconnects with backoff when it drops. It stops when the
  control plane closes it for good: 4401 (session or token invalid or
  expired, exit 3), 4403 (access lost, exit 4), 4404 (project not found,
  exit 5) or a protocol error (1008/1009, exit 1).

## Development

```sh
go test ./...                 # unit and command tests against a fake API
go test ./internal/cli -update  # rewrite golden files after an intended change
scripts/gen-openapi.sh        # refresh the API's OpenAPI snapshot
```

`internal/api/openapi_test.go` checks every route the CLI calls, and every
field of its wire types, against that snapshot.
