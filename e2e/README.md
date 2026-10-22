# @openrail/e2e

Tests the real stack: `wrangler dev` + the built dashboard + a real agent.

```sh
node agent-smoke.mjs              # join, heartbeat, offline detection (no browser)

pnpm --filter @openrail/web build
pnpm exec playwright install chromium   # once
pnpm test:browser                 # setup → add server → invite, in Chromium
```

`serve.mjs` starts a throwaway control plane with fresh local state.
Screenshots go to `screenshots/`. Both run in CI.
