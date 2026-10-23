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

| Command                                             | Purpose                                                  |
| --------------------------------------------------- | -------------------------------------------------------- |
| `login`, `logout`, `whoami`                         | Manage the session of a profile                          |
| `init`, `link`, `unlink`                            | Bind the directory to a project, environment and service |
| `status`                                            | Linked project and service, latest deployment, domains   |
| `open [--dashboard]`                                | Open the service URL or the dashboard                    |
| `deploy [--wait]`                                   | Deploy the latest config                                 |
| `logs [-f] [--build] [--deployment] [--since] [-n]` | Show and follow logs                                     |
| `rollback [deployment]`, `cancel [deployment]`      | Steer deployments                                        |
| `vars [get\|set\|unset\|import\|export]`            | Service (or `--shared`) variables                        |
| `run -- <cmd>`                                      | Run a local command with the service's variables         |
| `projects list\|create\|delete`                     | Projects; deletes need the typed slug                    |
| `templates list\|show\|deploy`                      | Built-in templates; deploy as a new project or into one  |
| `services list\|create\|delete`                     | Services; deletes need the typed slug                    |
| `domain [--all]`                                    | The service's domains                                    |
| `servers list\|add [--provider]`                    | Servers; `add` prints the install command, or provisions |
| `servers remove <server> [--keep-server] [-y]`      | Remove a server; deletes a provisioned cloud server too  |
| `servers cancel <provision-id> [--no-wait]`         | Cancel a provisioning run and delete what it created     |
| `tokens list\|create\|revoke`                       | Workspace API tokens for CI and scripts                  |
| `version`, `completion`                             | Build info, shell completion                             |
| `up`, `shell`, `db connect`                         | Not available on the control plane yet (exit 10)         |

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
