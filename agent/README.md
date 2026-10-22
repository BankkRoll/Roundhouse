# openrail-agent

Runs on each server. Dials out to the control plane over WebSocket, reports
heartbeats, runs the workloads the control plane's desired state lists, routes
traffic to them through Caddy, ships their logs, and builds images on builder
nodes.

## Build

```sh
go build -o bin/openrail-agent ./cmd/openrail-agent
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o bin/openrail-agent-linux-arm64 ./cmd/openrail-agent
```

## Use

```sh
openrail-agent join --url https://<control-plane> --token <token> [--name <name>] [--builder]
openrail-agent run
openrail-agent version
```

On servers, use `install/install.sh`, which also sets up Docker and systemd.

| Flag           | Purpose                                                        |
| -------------- | -------------------------------------------------------------- |
| `--config`     | Config path (default `/etc/openrail/agent.yaml`)               |
| `--data-dir`   | Credential, identity key, state (default `/var/lib/openrail`)  |
| `--token-file` | Read the join token from a file instead of argv                |
| `--force`      | Re-join; the old registration is kept intact if the join fails |
| `--builder`    | Make this node a builder: local registry and build jobs        |
| `--insecure`   | Allow http/ws to a non-loopback host. Development only.        |

## Distribution

Signed GitHub releases (`agent-v*` tags) are the only distribution channel;
`install/install.sh` downloads and verifies them. `go install ...@version`
does not work, because `go.mod` uses a `replace` directive to build against the
protocol module in this repository.

## Test

```sh
go test ./...
go vet ./...
```

## Workloads

`run` converges Docker to the latest `desired_state` (`internal/runtime`):
- **Reconcile** every 5 s, immediately on a new generation and on container
  events. Containers labelled `openrail.managed=true` carry their workload,
  deployment, service, project, spec hash, generation, routes and drain time,
  so an agent restart mid-rollout loses nothing. Until the first desired
  state after a start arrives, the agent only observes and never removes.
- **Rollouts** are zero-downtime: the new container starts, passes its
  health check, Caddy switches to it, the old one drains for `drain_s`,
  then it is removed. An old deployment's replica stays until every desired
  replica of the same service on the node is healthy.
- **Hardening:** `no-new-privileges`, all capabilities dropped except
  `CHOWN DAC_OVERRIDE FOWNER KILL NET_BIND_SERVICE SETGID SETUID` (what
  images need to start as root and step down; `NET_RAW`, `MKNOD` and the
  rest of Docker's default set are not granted), PID, memory (no swap) and
  CPU limits, json-file logs rotated at 3 × 10 MB. Docker's restart policy
  is `no`: the agent restarts containers itself with crash-loop backoff
  (1 s doubling to 5 min) so it sees and reports every crash.
- **Health** is probed by the agent from the host: `http` (GET, 2xx/3xx),
  `tcp`, or `none`, honouring `start_period_s`, `interval_s`, `timeout_s`
  and `retries` like Docker's `HEALTHCHECK`.
- Each project gets the bridge network `openrail-<project_id>`. Unused images
  are garbage-collected when Docker's disk is 85% full, never one a
  container uses or a desired workload names. Env values live only in
  Docker's container config.
- **System workloads.** With `desired_state.registry` set, the agent runs
  `registry:3.1.2` (pinned by digest) as `sys_registry` on `127.0.0.1:5000`,
  storing blobs in `<data-dir>/registry` or S3. It is recreated if it
  disappears or its config changes, and removed only when unconfigured.

**Ingress** (`internal/ingress`): the agent generates Caddy's whole JSON config
from the routes of healthy replicas and loads it through the admin API at
`localhost:2019`, only when it changed, retrying with backoff while Caddy is
down and reloading it if Caddy restarts. TLS modes: `acme` (on-demand, gated
by the agent's `127.0.0.1:2020/ask`, which approves only hostnames in the
desired routes), `internal` (Caddy's CA) and `off` (HTTP on :80). Caddy itself
must be installed on the node. After an agent restart, replicas that were
already running keep their routes until their first probe result, so a
restart never empties Caddy's config.

**Logs** (`internal/logship`): every service container's stdout and stderr is
followed, batched into `logs` frames (≤ 500 lines, ≤ 64 KiB, lines cut at
16 KiB, flushed every second) and, while disconnected, kept in a 16 MiB
ring buffer under `<data-dir>/logs` that is replayed in order on reconnect.
Read positions survive restarts, so no line is shipped twice.

**Builds** (`internal/builds`) run one at a time on builder nodes; extra jobs
fail at once with a `build_result`, and a running build is cancelled on
shutdown.

### Integration tests

The Docker, runtime, ingress and log tests have an `integration` build tag
and drive the local Docker Engine (pulling `traefik/whoami`, `busybox`,
`caddy` and `registry`). They run inside a `golang:1.26` container that
shares the Docker socket, since they reach containers by IP:

```sh
agent/test/integration.sh              # all of them
agent/test/integration.sh -run Caddy -v
```

The script works on Linux and from Git Bash on Windows with Docker Desktop.
Everything it creates is labelled and removed afterwards.

## Builder

On builder nodes (`join --builder`), `internal/builder` turns a `build_job`
into an image in the local registry and answers with `build_result`.
1. **Fetch.** The system `git` shallow-fetches exactly `commit_sha` into
   `<data-dir>/builds/<build_id>-*`, deleted after every build. A token
   travels as an `http.<origin>/.extraHeader` in `GIT_CONFIG_*` environment
   variables: never in argv, `.git/config` or logs. Only `https://` is
   allowed, redirects are refused when a token is sent, and no user or
   system git config, credential helper or hook applies. Symlinks that leave
   the checkout are deleted, and `context_dir` and `dockerfile_path` must
   resolve inside it.
2. **Plan.** Railpack builds run `railpack prepare` (CLI installed by
   `install.sh`). Build args reach it by name (`--env NAME`), values via its
   environment, and the build as BuildKit secrets.
3. **Build.** BuildKit runs rootless as `sys_buildkitd`
   (`moby/buildkit:v0.34.1-rootless`, pinned by digest) on its own bridge
   network `openrail-build`, with its cache in the `openrail-buildkit`
   volume, capped by BuildKit's GC and a periodic prune. It has no network
   listener: the agent reaches it with the BuildKit Go client over
   `buildctl dial-stdio`, run through the Docker exec API. Dockerfile builds
   use BuildKit's built-in frontend; Railpack builds use
   `ghcr.io/railwayapp/railpack-frontend:v0.43.0`, pinned by digest.
4. **Push.** BuildKit pushes `<image_repository>:<build_id>` and the
   `cache_key`'s registry cache through a proxy the agent opens on the build
   network's gateway for that build only. It requires a random per-build
   password, which only the build's session hands out, and allows only that
   build's repositories. The agent then reads the manifest digest back from
   the registry.

Output streams as batched, redacted `logs` frames. One build runs at a time,
the job's `timeout_s` (capped by `Options.Timeout`) is enforced, and errors
are written for the person who pushed the code.

### Integration tests

`internal/builder` has integration tests (build tag `integration`) that run
against a real Docker Engine: they start `registry:3`, `sys_buildkitd` and a
local git smart-HTTP server, then build and push a Dockerfile app from a
private repository, a Node.js app with Railpack (and run it), and check a
failing build, a missing Dockerfile, a timeout, a cancellation, path escapes
and build network isolation.

```sh
agent/internal/builder/testdata/integration.sh -v
```

The script runs the tests in `golang:1.26.10-bookworm` on the engine's host
network with the Docker socket mounted, after installing the pinned Railpack
CLI. It works on Linux and from Git Bash on Windows with Docker Desktop
(`-v //var/run/docker.sock:/var/run/docker.sock`, with `MSYS_NO_PATHCONV=1`).
It uses `127.0.0.1:5055` for the registry and `5056` for the proxy, and
removes `sys_buildkitd` and its network afterwards unless
`OPENRAIL_IT_KEEP=1`.

## Notes

- Control messages are Ed25519-signed. The agent verifies the bytes before
  parsing, and rejects messages for another node or past expiry (60s grace,
  corrected for clock skew).
- If disconnected, the agent keeps running current workloads and reconnects
  with backoff.
- Desired states carry secrets and are never written to disk; only the
  generation is. After a restart the agent applies the control plane's
  current state even if its generation equals the persisted one.
