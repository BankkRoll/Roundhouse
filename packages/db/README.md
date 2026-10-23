# @roundhouse/db

D1 schema (Drizzle) and migrations.

```sh
pnpm generate                                          # after editing src/schema
pnpm --filter @roundhouse/api db:migrate:local           # apply locally
```

Migrations in `migrations/` are applied by `wrangler d1 migrations apply`
during deploy. Never edit a migration that has shipped; add a new one. CI
fails if the schema has changes without a migration.

Tables used by Better Auth (`src/schema/auth.ts`) must keep Better Auth's
field names.
