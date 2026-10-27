# @roundhouse/e2e

Tests the real stack: `wrangler dev` + the built dashboard + a real agent.

```sh
node agent-smoke.mjs              # join, heartbeat, offline detection (no browser)

pnpm --filter @roundhouse/web build
pnpm exec playwright install chromium   # once
pnpm test:browser                 # setup → add server → invite, in Chromium
```

`serve.mjs` starts a throwaway control plane with fresh local state.
Screenshots go to `screenshots/`. Both run in CI.

## Mesh suite (two nodes)

`node e2e/phase3/mesh/run.mjs` (or `pnpm --filter @roundhouse/e2e test:mesh`)
starts `wrangler dev` on port 8798 (`PHASE3_PORT`) and two privileged
`docker:29-dind` nodes on one user-defined network, each running Docker,
Caddy and the real agent, then checks the WireGuard mesh end to end: the
direct tunnel, private names across nodes, ingress over the mesh,
environment isolation, a drain under a request loop, and offline
rescheduling. It needs privileged containers and the WireGuard kernel module
(or `/dev/net/tun` for userspace), and takes about seven minutes. On failure
each node's agent, Caddy, engine and nftables state go to
`e2e/phase3/mesh/.artifacts`. `PHASE3_KEEP=1` leaves the stack running.
