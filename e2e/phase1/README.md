# Phase 1 end-to-end suite

Proves the deploy pipeline works on the real stack: the control plane under
`wrangler dev`, a real Go agent joined as a builder in a Linux container, Docker,
BuildKit, the local registry and Caddy. Nothing is mocked.

```sh
pnpm --filter @openrail/e2e test:phase1      # or: node e2e/phase1/run.mjs
```

## Requirements

- Docker Engine 25+ with the socket at `/var/run/docker.sock`: Linux, or Docker
  Desktop (Linux containers) on Windows/macOS. Host networking must work
  (`docker run --network host`); on Docker Desktop that is the Docker VM's
  network, which is all the suite needs.
- Free on the engine host: ports 80, 443, 2019, 2020, 5000 and 18443
  (`PHASE1_GIT_PORT`). Free on this machine: 8797 (`PHASE1_PORT`).
- Go (to cross-compile the agent), Node 22, `pnpm install` done, and for the
  dashboard spec `pnpm --filter @openrail/e2e exec playwright install chromium`.
- Internet access the first time: base images, the Railpack CLI and BuildKit's
  Railpack frontend are pulled. Hostnames never need DNS.

WARNING: like a real agent, the suite's agent manages every
`openrail.managed=true` container on the engine that has no
`openrail.namespace` label, and teardown removes them. Don't run it against an
engine that hosts a real node.

## How long it takes

3.5 to 4.5 minutes on a 16-core Docker Desktop machine: about 25 s of setup
(dashboard build, images, `wrangler dev`), 3 minutes of API steps (the first
Railpack build takes about 70 s because teardown drops BuildKit's cache, and
step 7b waits out the 60 s rollout timeout), 30 s for the dashboard spec and
teardown. The very first run also pulls base images and the Railpack CLI. CI
allows 40 minutes.

## What it does

`run.mjs` clears leftovers of an earlier run, builds the agent for the
engine's Linux architecture and two images (`fixtures/node`: agent + git +
Railpack, like `install.sh` sets up a builder; `fixtures/tools`: an HTTPS git
server and an HTTP prober), starts the control plane with fresh state and
`ROLLOUT_TIMEOUT_S=60`, Caddy (its own container on the host network, as it is
its own service on a node, so restarting the agent never restarts ingress),
the git server and the prober. Then it runs:

`api.test.mjs` (`node --test`), in order:
1. setup with the master key, sign out and back in, `apps_domain` =
   `127.0.0.1.nip.io`, `tls_mode` = `off`;
2. a join token, the real `join --builder` (with `--insecure` only on Docker
   Desktop, where the control plane is `http://host.docker.internal:8797`),
   the agent comes online and starts `sys_registry`;
3. `traefik/whoami` pinned by digest: active, answers through Caddy, its
   variables and built-ins reach the container (`/?env=true`);
4. a Node.js app from the local git server, built with Railpack: build logs
   stored, the image in the registry by digest, served through Caddy, a
   `${{whoami.GREETING_SOURCE}}` reference resolved, and the app reaching
   whoami at `whoami.production.internal`;
5. a variable change plus a new commit, redeployed while a request loop runs:
   0 failed requests, the old container removed after draining;
6. rollback to the first deployment: active, same image digest, no new build,
   v1 code again (variables are read as they are now, by design);
7. a failing Dockerfile build (`failed`, readable reason, previous one still
   serving), a health check on the wrong port (`failed` after the rollout
   timeout, previous one still serving), a cancel mid-build (`cancelled`), and
   7d, a known bug reported as TODO: a cancelled build keeps running on the
   builder;
8. runtime logs through the API with the secret variable `[REDACTED]`, the
   same over the realtime WebSocket (session cookie, same Origin; another
   Origin is refused);
9. `docker restart` of the agent under a request loop: 0 failed requests,
   containers kept, desired state received again;
10. deleting whoami removes its containers and its route (404 `no route`);
11. `tls_mode` = `internal`: HTTPS verified against Caddy's local root CA
    (fetched from its admin API), plain HTTP redirects.

`ui.spec.ts` (Playwright) then drives the dashboard on the same stack: create
an image service with "Create and deploy", wait for active, read its runtime
logs, redeploy, roll back to the first deployment.

Teardown always runs, also after a failure or Ctrl-C: containers, project
networks, volumes, the agent's data dir on the engine host and the control
plane's state. On failure the agent, Caddy, git server and BuildKit logs, the
live Caddy config, managed containers, `wrangler dev` output and every
deployment's events are written to `e2e/phase1/.artifacts/` (uploaded by CI).
`evidence.json` there has timings, digests and request counts of every run.

## Knobs

| Variable                    | Default | Effect                                                     |
| --------------------------- | ------- | ---------------------------------------------------------- |
| `PHASE1_PORT`               | `8797`  | `wrangler dev` port                                        |
| `PHASE1_GIT_PORT`           | `18443` | git server port on the engine host                         |
| `PHASE1_ROLLOUT_TIMEOUT_S`  | `60`    | control plane rollout timeout (`ROLLOUT_TIMEOUT_S`)        |
| `PHASE1_UI=0`               |         | skip the dashboard spec                                    |
| `PHASE1_SKIP_WEB_BUILD=1`   |         | use the existing `apps/web/dist` instead of rebuilding it  |
| `PHASE1_KEEP=1`             |         | leave the stack up; `node e2e/phase1/teardown.mjs` later   |
| `PHASE1_KEEP_BUILD_CACHE=1` |         | keep BuildKit's cache volume between runs (faster locally) |

## Why it is built this way

- **No DNS.** The prober runs on the engine's host network and sends requests
  to `127.0.0.1` with the generated hostname as `Host` (and SNI), so any
  `apps_domain` works offline.
- **HTTPS git.** The builder only fetches `https://` URLs, so the git server
  serves `git http-backend` over TLS with a throwaway CA, which the node trusts
  through its system store. Deployments pass `commit_sha`: the control plane
  can't reach a git server inside the Docker VM to resolve the branch.
- **Same data path inside and out.** The agent bind-mounts directories of its
  data dir into the registry container, and the engine resolves those on its
  own host, so `/var/lib/openrail-e2e` is mounted at the same path.
