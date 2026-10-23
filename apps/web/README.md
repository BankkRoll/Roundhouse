# @roundhouse/web

Dashboard SPA (React, TanStack Router + Query, Tailwind). In production the
API Worker serves the built files.

## Run

```sh
pnpm --filter @roundhouse/api dev   # API on :8787
pnpm dev                          # http://localhost:5173, proxies /v1 and /api
```

## Test

```sh
pnpm test         # Vitest + Testing Library, API mocked with MSW
pnpm typecheck
pnpm build        # → dist/
```

## Layout

| Path              | What                                                         |
| ----------------- | ------------------------------------------------------------ |
| `src/routes/`     | File-based routes (`routeTree.gen.ts` generated)             |
| `src/features/`   | Pages and their components, by area                          |
| `src/components/` | App-level building blocks shared by several pages            |
| `src/queries/`    | TanStack Query hooks, one file per resource                  |
| `src/lib/`        | Typed API client, guards, formatting and other helpers       |
| `src/mocks/`      | MSW handlers; `contract.test.ts` checks them against the API |
| `public/_headers` | Security headers (CSP) for the deployed assets               |

## Notes

- The CSP forbids inline scripts and third-party requests. Fonts are
  self-hosted.
- Generic, app-agnostic components belong in `packages/ui`. Components that need the
  router, queries or dashboard copy (layouts, form fields, dialogs) live in
  `src/components`.
- `pnpm build` emits hidden source maps into `sourcemaps/` (gitignored) instead of
  `dist/`, so the Worker never serves them.
- `/` is the public landing page; the app lives under `/dashboard` and
  `/w/...`.
- Bundled fonts (Inter, JetBrains Mono) are OFL-1.1; their licenses ship in
  `public/licenses/`.
