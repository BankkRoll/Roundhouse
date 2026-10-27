# roundhouse-agent

Runs on each server. Dials out to the control plane over WebSocket, reports
heartbeats, runs the workloads the control plane's desired state lists, routes
traffic to them through Caddy, ships their logs, and builds images on builder
nodes.

## Build

```sh
go build -o bin/roundhouse-agent ./cmd/roundhouse-agent
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o bin/roundhouse-agent-linux-arm64 ./cmd/roundhouse-agent
```

## Use

```sh
roundhouse-agent join --url https://<control-plane> --token <token> [--name <name>] [--builder]
roundhouse-agent run
roundhouse-agent version
```

On servers, use `install/install.sh`, which also sets up Docker and systemd.

| Flag           | Purpose                                                         |
| -------------- | --------------------------------------------------------------- |
| `--config`     | Config path (default `/etc/roundhouse/agent.yaml`)              |
| `--data-dir`   | Credential, identity key, state (default `/var/lib/roundhouse`) |
| `--token-file` | Read the join token from a file instead of argv                 |
| `--force`      | Re-join; the old registration is kept intact if the join fails  |
| `--builder`    | Make this node a builder: local registry and build jobs         |
| `--insecure`   | Allow http/ws to a non-loopback host. Development only.         |

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
  events. Containers labelled `roundhouse.managed=true` carry their workload,
  deployment, service, project, spec hash, generation, routes and drain time,
  so an agent restart mid-rollout loses nothing. Until the first desired
  state after a start arrives, the agent only observes and never removes.
- **Namespace.** Every container and network the agent creates is labelled
  `roundhouse.namespace=<node ID>`, and the agent manages only those, so nodes
  sharing a Docker engine never touch each other's containers. A Phase 1
  container without the label is adopted once its workload ID is in this
  node's desired state, and stays managed until it is removed (adoptions are
  recorded in `<data-dir>/adopted-containers.json`).
- **Rollouts** are zero-downtime: the new container starts, passes its
  health check, Caddy switches to it, the old one drains for `drain_s` (at
  least 2 s, the time Caddy may take to see the switch), then it is removed. An old deployment's replica stays until every desired
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
- **Networks.** Each environment gets its own bridge network,
  `roundhouse-<project_id>-<environment_id>` (hashed when too long), and its
  replicas register their private domain there only: a container reaches its
  own environment's services by name and IP, and no other environment's.
  A service workload naming any other network (another environment's or
  project's, `host`, `bridge`, `none`, `roundhouse-system`,
  `roundhouse-build`) is refused. Networks no longer used are removed, including Phase 1's per-project
  network once every replica has moved off it. Unused images are
  garbage-collected when Docker's disk is 85% full, never one a container
  uses or a desired workload names. Env values live only in Docker's
  container config.
- **System workloads.** With `desired_state.registry` set, the agent runs
  `registry:3.1.2` (pinned by digest) as `sys_registry` on `127.0.0.1:5000`,
  storing blobs in `<data-dir>/registry` or S3. It is recreated if it
  disappears or its config changes, and removed only when unconfigured.

**Ingress** (`internal/ingress`): the agent generates Caddy's JSON config from
the desired routes and loads it through the admin API at `localhost:2019`,
only when it changed, retrying with backoff while Caddy is down and reloading
it if Caddy restarts. Upstream addresses are not in the config: each route
resolves them (cached for 1 s) from `<hash>.upstreams.roundhouse.invalid`, a
name the agent's DNS server on `127.0.0.1:2021` answers with the route's
healthy replicas. Swapping a route to new containers therefore never reloads
Caddy, and never resets a connection; only a new or removed route, a port
change or a TLS change does. The answers are persisted in
`<data-dir>/ingress-upstreams.json` and served from the agent's first
moment, and while the agent restarts Caddy holds requests (up to 5 s) until
it answers again. TLS modes: `acme` (on-demand, gated by the agent's
`127.0.0.1:2020/ask`, which approves only hostnames in the desired routes),
`internal` (Caddy's CA) and `off` (HTTP on :80). Caddy itself must be
installed on the node. After an agent restart, replicas that were already
running keep their routes until their first probe result, and a Caddy
already running the wanted config is not reloaded. See ADR 0003, "Ingress
swaps without reloads".

**Mesh** (`internal/mesh`, `internal/netpol`; ADR 0005): with
`desired_state.mesh` set, the agent creates `wg0` (the kernel module, else
embedded wireguard-go on `/dev/net/tun`; `mesh.mode` in the config forces one
or turns the mesh off) and configures it through wgctrl with the peers and
the preshared keys sealed to the node. The private key lives in
`<data-dir>/wireguard.key` (0600) and never leaves the node; rotations follow
`rotate_key` / `activate_epoch`. Each replica's mesh IP is NATed 1:1 to its
bridge IP, and the `inet roundhouse` nftables table, replaced atomically,
admits cross-node traffic only within an environment (checked on both nodes)
plus ingress from node addresses to routed ports, and marks what it admits so
Docker's forward drops let it through (a `DOCKER-USER` rule on the iptables
backend; `bridge-accept-fwmark` on the nftables one). Containers with
`private_dns` resolve `<service>.<environment>.<project>.internal` through the
agent on the node's `rh-dns0` address, which answers only local containers
and only names of their own environment, and forwards other names to the
host's resolvers. `mesh_status` goes out every 30 s and on change; mesh
failures never stop local workloads.

**Logs** (`internal/logship`): every service container's stdout and stderr is
followed, batched into `logs` frames (≤ 500 lines, ≤ 64 KiB, lines cut at
16 KiB, flushed every second) and, while disconnected, kept in a 16 MiB
ring buffer under `<data-dir>/logs` that is replayed in order on reconnect.
Read positions survive restarts, so no line is shipped twice.

**Builds** (`internal/builds`) run one at a time on builder nodes; extra jobs
fail at once with a `build_result`, and a running build is cancelled on
shutdown. A `build_cancel` stops a build at once (BuildKit drops the step,
git and Railpack are killed) and answers it with a result marked
`cancelled`; a job that arrives while a cancelled build winds down waits
for it rather than being refused.

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

They include the properties the agent promises end to end: two environments
of one project cannot reach each other by IP or private domain
(`TestEnvironmentsAreIsolated`), and 200 back-to-back route swaps under
request loops lose or reset no request and never reload Caddy
(`TestSwapsNeverReloadCaddy`). `TestMeshTwoNodes` runs the real agent on two
`docker:29-dind` nodes (kernel and userspace WireGuard) against a fake
control plane: an environment reaches its replica on the other node by
private name, another environment gets NXDOMAIN and no route, and a node's
ingress address reaches only routed ports.

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
   environment, and the build as BuildKit secrets. Dockerfile builds get
   plain build args as `ARG`s, but args the job marks secret
   (`secret_build_args`) only as BuildKit secrets with the arg's name as ID
   (`RUN --mount=type=secret,id=NAME,env=NAME`), so they never reach the
   image or its history.
3. **Build.** BuildKit runs rootless, one daemon per project
   (`sys_buildkitd-<project>`, `moby/buildkit:v0.34.1-rootless` pinned by
   digest), since its cache mounts can't be scoped to a tenant inside one
   daemon. Daemons start on demand, at most two run (the least recently used
   stops first), each stops after 10 idle minutes and is limited to 4 GiB,
   2 CPUs and 4096 PIDs. They sit on their own bridge network
   `roundhouse-build`, each with its cache in its own
   `roundhouse-buildkit-<project>` volume, capped by BuildKit's GC and a
   periodic prune; the cache all projects shared before is removed. It has no network
   listener: the agent reaches it with the BuildKit Go client over
   `buildctl dial-stdio`, run through the Docker exec API. Dockerfile builds
   use BuildKit's built-in frontend; Railpack builds use
   `ghcr.io/railwayapp/railpack-frontend:v0.43.0`, pinned by digest.
   Where AppArmor restricts unprivileged user namespaces (Ubuntu 23.10+),
   rootless BuildKit cannot start unconfined, so `sys_buildkitd` runs under
   the `roundhouse-buildkit` profile that `install.sh` loads: the agent uses
   it when `/sys/kernel/security/apparmor/profiles` lists it or, when that is
   unreadable, when the engine can start a container under it, and
   `unconfined` otherwise. `ROUNDHOUSE_BUILDKIT_APPARMOR_PROFILE` overrides
   the choice (for example with a site-specific profile). If BuildKit still
   fails to create its user namespace, the build error says how to load the
   profile; the next build picks it up without restarting the agent.
4. **Push.** BuildKit pushes `<image_repository>:<build_id>` and the
   `cache_key`'s registry cache through a proxy the agent opens on the build
   network's gateway for that build only. It requires a random per-build
   password, which only the build's session hands out, and allows only that
   build's repositories. The agent then reads the manifest digest back from
   the registry.

Output streams as batched `logs` frames, with the git token, every secret
build arg and every sealed build secret redacted (also base64, hex,
percent- and JSON-encoded; names are never guessed at). Sealed build
secrets (`build_secrets_sealed`) are opened with the node's X25519 key and
reach the build only as BuildKit secrets with the key as ID. One build runs at a
time, the job's `timeout_s` (capped by `Options.Timeout`) is enforced, and
errors are written for the person who pushed the code.

### Integration tests

`internal/builder` has integration tests (build tag `integration`) that run
against a real Docker Engine: they start `registry:3`, `sys_buildkitd` and a
local git smart-HTTP server, then build and push a Dockerfile app from a
private repository, a Node.js app with Railpack (and run it), and check a
failing build, a missing Dockerfile, a timeout, a cancellation (stopped in
milliseconds, nothing left running in BuildKit, the next build runs at once),
secret build args (absent from the image config, its history and the logs),
path escapes and build network isolation.

```sh
agent/internal/builder/testdata/integration.sh -v
```

The script runs the tests in `golang:1.26.10-bookworm` on the engine's host
network with the Docker socket mounted, after installing the pinned Railpack
CLI. It works on Linux and from Git Bash on Windows with Docker Desktop
(`-v //var/run/docker.sock:/var/run/docker.sock`, with `MSYS_NO_PATHCONV=1`).
It uses `127.0.0.1:5055` for the registry and `5056` for the proxy, and
removes `sys_buildkitd` and its network afterwards unless
`ROUNDHOUSE_IT_KEEP=1`.

## Notes

- Control messages are Ed25519-signed. The agent verifies the bytes before
  parsing, and rejects messages for another node or past expiry (60s grace,
  corrected for clock skew).
- If disconnected, the agent keeps running current workloads and reconnects
  with backoff.
- Desired states carry secrets and are never written to disk; only the
  generation is. After a restart the agent applies the control plane's
  current state even if its generation equals the persisted one.
- Web shell sessions (`internal/shell`, ADR 0012) exec only into this
  node's own running service workloads, as the container's user. Docker
  never ends a TTY exec when its client goes away, so closing a session
  sends SIGHUP and then SIGKILL by host PID. That needs the host PID
  namespace: the systemd install has it; an agent run in a container must
  be started with `--pid=host`, or closed shells keep running until they
  exit on their own (the agent logs a warning naming the session).
- Builders copy images to another registry for `image_push`
  (`internal/imagepush`, ADR 0011) without unpacking them; the target's
  login is opened only for the push and never logged or stored.
