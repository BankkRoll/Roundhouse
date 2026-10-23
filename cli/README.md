# roundhouse CLI

Deploy and manage services on a Roundhouse control plane from your terminal.
It talks to the control plane's REST API and realtime socket only.

## Install

Download a binary for your platform from the release, check it against
`SHA256SUMS`, and put it on your `PATH`:

```sh
sha256sum --ignore-missing -c SHA256SUMS
install -m 0755 roundhouse-linux-amd64 /usr/local/bin/roundhouse
```

Or build from source (Go 1.26):

```sh
go install github.com/BankkRoll/Roundhouse/cli/cmd/roundhouse@latest
cli/scripts/build.sh   # every OS/arch into cli/dist, with SHA256SUMS
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
roundhouse vars import .env
roundhouse vars export --reveal > .env.local
roundhouse run -- npm run dev
```

References (`${{service.VAR}}`, `${{shared.VAR}}`, `${{VAR}}`) are stored as
written. Secrets stay masked unless you pass `--reveal`, and every reveal is
recorded in the audit log. `run` asks the control plane for the service's
environment exactly as a deployment gets it (references resolved, built-ins
such as `PORT` added, secrets in plaintext); that needs the
`variables:reveal` permission and is audited too. The values go to the
child process alone; nothing is written to disk. A control plane too old to
resolve variables makes `run` exit 10.

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
combined with a preset. `run` also needs `variables:reveal`.

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
| `services list\|create\|delete`                     | Services; deletes need the typed slug                    |
| `domain [--all]`                                    | The service's domains                                    |
| `servers list\|add`                                 | Servers; `add` prints the agent install command          |
| `tokens list\|create\|revoke`                       | Workspace API tokens for CI and scripts                  |
| `version`, `completion`                             | Build info, shell completion                             |
| `up`, `shell`, `db connect`                         | Not available on the control plane yet (exit 10)         |

Every command takes `--json`, `--profile`, `--no-input`, `--no-color` and
`--debug` (HTTP traces with credentials redacted). Run
`roundhouse <command> --help` for flags and examples.

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
