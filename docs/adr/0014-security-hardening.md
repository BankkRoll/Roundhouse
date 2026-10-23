# 0014: Security hardening (secrets, access control, node sealing, key rollover, audit)

## Status

Accepted. Amends:
- ADR 0002: join and hello carry an encryption key, and the control-plane
  signing key can roll over (section 13).
- ADR 0003: variables, environment networks, secret build args, instance
  settings, `instance:manage`.
- ADR 0007: binding rules for PR previews (section 14).
- ADR 0012: binding rules for the web shell and the MCP server (section 15).
- ADR 0013: this is the ADR 0014 that 0013 reserves for signing-key
  rotation. It also fixes how this work joins 0013's protocol plan (section 6,
  "Protocol gate").

The work lands after Phases 2–4, onto the renamed `main` ("Merging onto
main"). Sections 14 and 15 bind the Phase 3 and 4 builds of previews and the
shell before that merge.

## Context

A security audit on 2026-10-22 found one critical issue and several
high/medium ones; product decisions taken alongside it change how secrets and
access work. This ADR fixes the contracts that six implementation streams
build against in parallel, precisely enough that none of them has to make a
design choice. The streams, their files and the order they land in are at
the end ("Work breakdown").

| ID    | Severity | Finding                                                                                                                                                                                                                    | Section         |
| ----- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| F1    | Critical | A service may name any workspace's `github_installation_id`; `repoToken()` looks it up by ID only and mints an unscoped token for non-github.com URLs; `resolveBranch` sends Basic auth to any host and follows redirects. | GitHub          |
| F3    | High     | `instance:manage` is granted to the owner of _any_ workspace, and any admin can create a workspace and become its owner.                                                                                                   | Instance admin  |
| Cache | Medium   | API and auth responses carry no `Cache-Control`.                                                                                                                                                                           | Cache           |
| H1    | High     | The agent runs service workloads on whatever network the frame names (host, bridge, system networks, another project's).                                                                                                   | Agent           |
| H2    | High     | Local-registry images aren't tied to their project and service; private images may run from the local cache without credentials.                                                                                           | Agent           |
| H3/H4 | High     | One BuildKit cache for all projects; builds and workloads lack seccomp/AppArmor defaults and limits, and reach the cloud metadata endpoint.                                                                                | Agent           |
| M1    | Medium   | Railpack inherits the agent's environment.                                                                                                                                                                                 | Agent           |
| M2    | Medium   | Git refs from frames reach `git` unvalidated and without `--end-of-options`.                                                                                                                                               | Protocol, Agent |
| M3    | Medium   | Two projects can claim the same host and path prefix on one node.                                                                                                                                                          | Agent           |
| M4    | Medium   | The private DNS alias comes from a label, not from IDs.                                                                                                                                                                    | Agent           |
| Gap   | Medium   | One Docker network per project spans every environment.                                                                                                                                                                    | Networks        |
| Gap   | Medium   | `build_job` can't mark build args secret.                                                                                                                                                                                  | Builds          |
| RT    | Medium   | Realtime membership is checked only at subscribe.                                                                                                                                                                          | Realtime        |
| GH    | High     | GitHub installation claims are first-claim-wins.                                                                                                                                                                           | GitHub          |
| WH    | Medium   | Webhook replay is deduped on the unsigned delivery ID only.                                                                                                                                                                | GitHub          |
| AU    | Medium   | The audit log can be rewritten undetected, loses rows with their workspace, and records no sign-ins.                                                                                                                       | Audit log       |
| AUTH  | High     | Origins come from the request `Host`; no per-account lockout; no second factor.                                                                                                                                            | Auth            |

## Decisions

### 1. Access control

Implemented in `packages/shared/src/rbac.ts` (`resolveAccess`, fully tested in
`rbac.test.ts`). The API enforces it; the dashboard uses the same function to
hide what the caller can't do.

#### Three layers

- **Instance**: the `users.instance_admin` flag grants `INSTANCE_ACTIONS`
  (`instance:manage`, `workspaces:create`) and _nothing_ inside workspaces.
- **Workspace**: the member's role (`owner`, `admin`, `member`, `viewer`, as
  before) grants `WORKSPACE_ACTIONS`.
- **Project**: a project role (`project_admin`, `developer`, `deployer`,
  `viewer`) grants `PROJECT_ACTIONS`. A protected environment narrows the
  `ENVIRONMENT_ACTIONS` further.

`variables:reveal` is deleted. `tokens:manage` is kept (owner, admin) so the
API-token work in progress on `main` merges as is.

#### Workspace actions

| Action             | owner | admin | member | viewer |
| ------------------ | :---: | :---: | :----: | :----: |
| `workspace:read`   |   ✓   |   ✓   |   ✓    |   ✓    |
| `workspace:update` |   ✓   |   ✓   |        |        |
| `workspace:delete` |   ✓   |       |        |        |
| `members:read`     |   ✓   |   ✓   |   ✓    |        |
| `members:manage`   |   ✓   |   ✓   |        |        |
| `tokens:manage`    |   ✓   |   ✓   |        |        |
| `nodes:read`       |   ✓   |   ✓   |   ✓    |   ✓    |
| `nodes:manage`     |   ✓   |   ✓   |        |        |
| `audit:read`       |   ✓   |   ✓   |        |        |
| `projects:create`  |   ✓   |   ✓   |        |        |
| `github:manage`    |   ✓   |   ✓   |        |        |

`members:manage` covers invites, roles, removal and **teams**.
`github:manage` claims and releases GitHub installations.

#### Project actions

| Action                 | project_admin | developer | deployer | viewer |
| ---------------------- | :-----------: | :-------: | :------: | :----: |
| `projects:read`        |       ✓       |     ✓     |    ✓     |   ✓    |
| `services:read`        |       ✓       |     ✓     |    ✓     |   ✓    |
| `variables:read`       |       ✓       |     ✓     |    ✓     |   ✓    |
| `variables:read_plain` |       ✓       |     ✓     |    ✓     |        |
| `deployments:create`   |       ✓       |     ✓     |    ✓     |        |
| `services:manage`      |       ✓       |     ✓     |          |        |
| `variables:manage`     |       ✓       |     ✓     |          |        |
| `projects:manage`      |       ✓       |           |          |        |
| `access:manage`        |       ✓       |           |          |        |

Decisions marked "decide" in the brief:
- **Deployer** deploys, redeploys, rolls back, cancels and reads plain values,
  but changes neither config nor variables (any variable, plain or secret).
  Variables change behaviour exactly like config does; a deployer ships what
  a developer configured.
- **Viewer** sees keys, tiers, fingerprints and metadata, never values (not
  even plain ones). Logs (already redacted) stay readable under
  `services:read`.
- `variables:read` = metadata; `variables:read_plain` = plain values. Secret
  values have no action because nobody can read them.

#### Implied roles and defaults

| Workspace role | Implied project role on every project                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| owner, admin   | `project_admin` (always; grants can't lower it)                                                           |
| member         | `workspaces.member_default_project_role`: `none`/`viewer`/`deployer`/`developer`, default **`developer`** |
| viewer         | `workspaces.viewer_default_project_role`: `none`/`viewer`, default **`viewer`**                           |

Defaults reproduce today's powers exactly: members were `developer`
everywhere (services, deployments, variables), admins and owners
`project_admin`. A user's effective role on a project is the **highest** of
the implied role, their direct grant, and the grants of every team they're
in. Grants may raise a workspace viewer or member on one project; they never
give workspace actions. A project the caller has no role on is 404, and
`listProjects` omits it.

#### Teams

Workspace-scoped groups (`teams`: name, slug unique per workspace,
description; `team_members`). A user may be in many teams and must be a
workspace member; removing a member from the workspace deletes their team
memberships and direct grants in the same batch. Managed with
`members:manage`. Teams are principals of grants and of protection rules.

#### Project grants

`project_access_grants (project, principal user|team, role)`, one per
principal and project. Managed with `access:manage` on the project. Owners
and admins are implicitly `project_admin`; a grant to them is accepted but
changes nothing.

#### Environment protection

`environments.protected` and `environments.protection_rules`
(`NULL` = `DEFAULT_PROTECTION_RULES`). A rule exists per operation:

| Operation   | Gates                | Default (protected)           |
| ----------- | -------------------- | ----------------------------- |
| `deploy`    | `deployments:create` | roles `developer`, `deployer` |
| `config`    | `services:manage`    | role `developer`              |
| `variables` | `variables:manage`   | none (project admins only)    |

A rule lists project roles (`developer`, `deployer`), user IDs and team IDs.
A caller passes when **their project role already grants the action** _and_
(they are `project_admin`, or their role, user ID, or one of their teams is
listed). Rules only narrow; `project_admin` always passes, so an admin can't
lock themselves out of an environment they can unprotect. Reads are never
restricted.
- New projects' `production` environment is created **protected**.
- The migration leaves **existing** environments unprotected, so the upgrade
  changes nobody's access; the dashboard shows project admins a "Production
  isn't protected" notice with a one-click fix.
- Deleting a service affects every environment, so it checks
  `services:manage` against **each** environment of the project (all must
  pass). Creating a service has no runtime effect and checks the project only.

#### Resolution

```ts
const access = resolveAccess(
  { userId, workspaceRole, instanceAdmin, teamIds, tokenScopes },
  { settings, grants, protections },
);
access.check("variables:manage", { environmentId }); // { allowed, reason, projectRole }
```

Order: instance actions need the flag (and are never available to API
tokens) → a token must list the action in its scopes → workspace actions
need the workspace role → project actions need `projectId` or
`environmentId` (`scope_required`), an environment present in `protections`
(`unknown_environment`, so forgetting to load protection fails closed) and
of that project (`environment_mismatch`), a project role
(`no_project_access`) that grants the action (`project_role`), and, for an
environment action in a protected environment, the rule
(`environment_protected`). The API maps `no_project_access` to 404 and the
other denials to 403 `forbidden` with the reason in the message.

`can(role, action)` stays as the coarse check under default settings (used
for API token scope validation and by UI with no project in view). Anything
about a specific project must use `resolveAccess`.

API tokens (from `main`): a token's effective access is `resolveAccess` with
the creator as subject and `tokenScopes` set. `API_TOKEN_SCOPES` must
exclude every `INSTANCE_ACTIONS` member (today it excludes only
`instance:manage`; add `workspaces:create` when merging).

### 2. Instance admin (F3)

- `users.instance_admin` (default false). Setup sets it for the setup user
  (done). The migration backfills it for the actor of
  `instance.setup_completed`, or else the earliest owner of a live workspace.
- `requireInstanceAction` checks only the flag (done). Instance actions are
  checked against the flag even when a route also loads a workspace (done
  in `requireWorkspace`).
- Only instance admins create workspaces (`POST /v1/workspaces` checks
  `workspaces:create`) and change instance settings, the GitHub App and
  keys. `/v1/me` reports `user.instance_admin` (done).
- Instance admins manage the flag with `PUT /v1/instance/admins/{userId}`
  (fresh session; the last admin can't be revoked, 409 `last_owner`).
- Instance-level audit entries (`INSTANCE_AUDIT_ACTIONS`, written with
  `workspace_id = NULL`, including `instance.setup_completed` from now on)
  are listed by `GET /v1/instance/audit-logs`, for instance admins only.

### 3. Auth

#### Public origin

`PUBLIC_ORIGIN` (e.g. `https://cp.example.com`) is the only source of
absolute URLs: Better Auth `baseURL` and `trustedOrigins`, invite, install,
join and GitHub manifest/callback URLs, the agent `connect_url`, and the
same-origin guard. `publicOrigin(c)` in `lib/origin.ts` returns it
normalised (scheme, host, port; no path or trailing slash). When it is
unset, requests fail with 503 `public_origin_missing`, except with
`ROUNDHOUSE_DEV=1`, where the request origin is used. The API tests set
`PUBLIC_ORIGIN=https://cp.test` in `vitest.config.ts`. (`originOf` already
delegates to `publicOrigin`; the stub still returns the request origin.)

#### Lockout

Per account, in D1 (`login_attempts`, keyed by SHA-256 hex of
`email.trim().toLowerCase()`, so unknown emails lock identically and no
address is stored). `recordLoginFailure`/`loginLockedForMs` in
`packages/shared/src/auth-policy.ts`: 5 free failures within 24 h, then
30 s, doubling per failure, capped at 1 h. A Better Auth `hooks.before` on
`/sign-in/email` refuses a locked account with 429 `account_locked` and
`retry-after` (seconds) _before_ checking the password; `hooks.after`
records the failure or deletes the row on success. Failed second factors
count too. `POST /v1/auth/reauth` uses the same counter. The per-IP limiter
stays.

#### Sign-in audit

`auth.sign_in_succeeded`, `auth.sign_in_failed` (metadata: `email_hash`,
`reason`), `auth.account_locked`, `auth.two_factor_enabled`,
`auth.two_factor_disabled`, `auth.backup_codes_regenerated`,
`auth.two_factor_failed`, `auth.reauthenticated`: all instance-level
(`workspace_id NULL`), actor the user when known. Never the password or
code.

#### Two-factor

Better Auth 1.7.12 is installed; its `twoFactor` plugin
(`better-auth/plugins`) provides TOTP and backup codes. Configuration:
`issuer: PRODUCT_NAME`, TOTP (6 digits, 30 s), 10 backup codes, no trusted
devices (`trustDeviceMaxAge` unused; the dashboard never offers "remember
this device"). Tables: `users.two_factor_enabled` and `two_factors (id,
secret, backup_codes, user_id → users ON DELETE CASCADE, verified,
failed_verification_count, locked_until, created_at, updated_at)`; Better
Auth encrypts `secret` and `backup_codes` with the auth secret. The drizzle
adapter maps `twoFactor: twoFactors`; `ID_PREFIXES.twoFactor = "tfa"`.

Required for instance admins and every workspace owner or admin
(`isTwoFactorRequired`). The two-factor gate (`lib/two-factor-gate.ts`,
mounted on `/v1/*`) refuses every non-GET request from such a user without
2FA with 403 `two_factor_required`, except `TWO_FACTOR_EXEMPT_PATHS` (setup,
invite acceptance, re-auth, agent join, webhooks). Enrollment happens under
`/api/auth/two-factor/*`, which the gate doesn't cover. Promoting someone to
admin doesn't fail; they hit the gate on their next mutation.

#### Fresh sessions

Policies with `reauth: true` need a session that signed in or called
`POST /v1/auth/reauth` (password + code when 2FA is on; sets
`sessions.reauthenticated_at`) within `REAUTH_WINDOW_MS` (10 min);
otherwise 403 `reauth_required` and the dashboard prompts and retries. API
tokens are never fresh. `requireFreshSession(c)` is implemented in
`lib/fresh-session.ts`. Fresh-session routes: rotate keys, update instance
settings, create the GitHub App manifest, release an installation, change
instance admins, every write under "Access control" routes, member role
changes and removal, invite creation, node join-token creation, workspace
deletion.

### 4. Secrets

#### Tiers

- **plain**: stored encrypted; returned only to callers with
  `variables:read_plain`.
- **secret**: **write-only, forever**. No route returns a secret value to
  anyone, the CLI included; there is no reveal route. Secrets reach only the
  nodes that run or build the service (sealed to them, see "Node sealing").

The reveal routes, contracts, client calls and audit producer are removed
(done). `variables.revealed` stays in `AUDIT_ACTIONS` to label old entries.
**Any "resolve variables for the CLI" route must not return secret values**;
see `resolveServiceVariables` below.

#### Classifier

`classifyVariable(key, value)` in
`packages/shared/src/variable-classifier.ts` (implemented, 175 tests) picks
the default tier, shared by API and dashboard:
1. **Public prefix → plain, locked.** `NEXT_PUBLIC_`, `NUXT_PUBLIC_`,
   `EXPO_PUBLIC_`, `PLASMO_PUBLIC_`, `VITE_`, `PUBLIC_` (SvelteKit, Astro,
   Qwik), `REACT_APP_`, `GATSBY_`, `VUE_APP_`, `STORYBOOK_`, `REDWOOD_ENV_`,
   `SANITY_STUDIO_`, `NG_APP_`; case-sensitive like the frameworks. Each is
   documented in the code with what bundles it. If the value looks like a
   credential (known format or high entropy) the result carries
   `public_prefix_secret_value`, and the API refuses the write (400
   `public_prefix_secret_value`, details list the keys) unless the key is in
   the request's `acknowledge_public`. Supabase anon keys (JWTs with
   `"role":"anon"`) don't warn. Firebase/Google `AIza…` keys do warn: some
   are public by design, some (Gemini) aren't, and an acknowledgement costs
   one click.
2. **Known credential format → secret, locked** (`value_detected`):
   PEM private keys (incl. OpenSSH, PGP), Anthropic `sk-ant-`, OpenAI
   `sk-`/`sk-proj-`/`sk-svcacct-`/`sk-admin-`, Stripe `sk_`/`rk_`
   live/test and `whsec_`, GitHub `ghp_ gho_ ghu_ ghs_ ghr_ github_pat_`,
   AWS `AKIA`/`ASIA` key IDs, Slack `xox[abprs]-` and webhook URLs, Google
   `AIza`, SendGrid `SG.`, Twilio `SK` + 32 hex, npm `npm_`, JWTs (except
   anon), URLs with a userinfo password.
3. **High entropy → secret, unlocked** (`high_entropy`). Decided: entropy
   alone doesn't lock, because false positives (public keys, long IDs) must
   stay overridable. Tokens are split on whitespace and `,;'"\`=:`. UUIDs
   are skipped (identifiers). 40-hex strings are skipped (git SHA-1). Other
   hex needs ≥ 32 chars and ≥ 3.0 bits/char; other tokens need ≥ 24 chars of
   `[A-Za-z0-9+/=_\-.~]`, upper and lower case and a digit, and ≥ 4.0
   bits/char. Values containing a PEM block (certificates, public keys) are
   skipped; private keys are caught by step 2.
4. **Secret-looking name → secret, unlocked** (`secret_name`): word-aware
   (`KEYBOARD_LAYOUT`, `MONKEY`, `MAX_TOKENS` are not; `API_KEY`, `DB_PASS`,
   `DATABASE_URL` are). Names ending in a metadata word (`_PATH`, `_FILE`,
   `_ID`, `_TTL`, `_ISSUER`, …) aren't, except `ACCESS_KEY`. Full word
   lists are in the code.
5. Otherwise **plain** (`default`).

References (`${{…}}`) are ignored when scanning: the referenced variable's
own tier covers it. Secrets shorter than 6 characters carry
`secret_too_short_to_redact`.

`decideVariableTier` turns a classification, the requested tier and the
current tier into the stored tier: locks can't be overridden
(`tier_locked`); without a request an existing secret stays secret; secret →
plain needs the value re-entered (`value_required`); plain → secret works
without a value.

#### Write flow

`PUT …/variables` (`VariablesPutSchema`):

```jsonc
{
  "set": [
    {
      "key": "API_KEY",
      "value": "…",
      "tier": "secret",
      "available_at_build": false,
      "mount_as_file": false,
      "expected_version": 3
    }
  ],
  "delete": ["OLD"],
  "confirm_write_only": true, // required when any key becomes secret
  "acknowledge_public": ["VITE_X"] // required for public_prefix_secret_value
}
```

- `value` omitted = change flags only (existing keys only).
- Any key that is secret after the write but wasn't before needs
  `confirm_write_only: true`; otherwise 400 `confirmation_required` with
  `details[].field` = the keys. The dashboard shows a dialog listing them
  ("These values can never be shown again") and resends.
- Response: `{ variables, warnings }` (`VariablesPutResultSchema`).
- `variables.updated` audit metadata: keys set and deleted, never values.
- Implemented in `lib/variables.ts` with format 1 sealing and no
  fingerprints yet (TODOs for the crypto stream).

#### Fingerprints

`variables.fingerprint` = first 8 hex of HMAC-SHA256(fingerprint key, UTF-8
raw value); fingerprint key = HKDF-SHA256(DEK, salt
`roundhouse/v2/fingerprint`, info `variable-fingerprint:<project_id>`).
Computed for both tiers; shown to every reader with `updated_at` and
`updated_by`. **HMAC, not a plain hash**: fingerprints are visible to
viewers and stored in D1, and a bare hash of a short or guessable secret can
be brute-forced offline from either; with a key only the Worker can derive,
every guess needs the Worker. 32 bits tell values apart at a glance and are
useless as an oracle. Implemented: `fingerprintKey`, `variableFingerprint`
in `lib/keyring.ts` (pinned: DEK `07`×32, project `prj_1`, value `hunter2` →
`8702a7a8`).

`provider_credentials.fingerprint` is built the same way, keyed per
workspace: HKDF-SHA256(fingerprint secret, salt `roundhouse/v2/fingerprint`,
info `provider-fingerprint:<workspace_id>`). Workspaces have no DEK, so the
fingerprint secret is 32 random bytes in `instance_settings.fingerprint_secret`,
sealed as an instance secret and created on first use. Rotation re-wraps it
like the signing key, so fingerprints survive a master key change; a key
derived from `MASTER_KEY` itself would not. Implemented:
`providerFingerprintKey` (pinned: secret `07`×32, workspace `ws_1`, token
`hunter2` → `9fc71e5b`), `loadFingerprintSecret` in `lib/settings.ts`.

#### Secret-derived values

A plain variable whose resolution reaches a secret (`url =
"pg://u:${{db.PASSWORD}}@db"`) is treated as secret wherever resolved values
leave the control plane: `secretDerivedVariables` in
`packages/shared/src/variable-taint.ts` (implemented, tested) finds them. It
applies to the CLI resolve route, to build args, and to the redaction set.

#### CLI

`GET /v1/services/{id}/variables/resolved?environment_id=` (needs
`variables:read_plain`, audits `variables.resolved` with key names) returns
`{ variables, local_keys }`: resolved plain values (built-ins included) and
the keys the CLI must supply from a local `.env` (every secret and every
secret-derived variable). `roundhouse run --env-file <path>` (default
`.env`) merges them, local file winning for `local_keys`, and warns about
missing ones. `vars get`/`vars export` lose `--reveal`; secrets print as
`<secret fp:xxxxxxxx>`.

#### Builds

- `service_configs.build.build_args` stay and are **plain only**. A build
  arg whose value has a known credential format or high entropy, or that
  references a secret or secret-derived variable, is refused at save with
  400 `build_arg_secret`: "API_TOKEN looks secret; make it a secret
  variable with available_at_build and read it with RUN
  --mount=type=secret,id=API_TOKEN". References the save can't check
  (another service's variables) are checked again at deploy and fail the
  deployment with the same message.
- Variables with `available_at_build` reach the build: plain ones as build
  args (a build arg of the same name wins), secrets as **BuildKit secrets**
  (`id` = key) only. Dockerfiles read them with `RUN
  --mount=type=secret,id=KEY`; Railpack gets them as secrets in its plan.
  Default `false` (today's builds get no variables).
- The deploy workflow stores the build inputs as
  `deployments.build_env_sealed` (`{ args, secrets }` under the DEK, AAD
  `deployment-build:v2:<ws>:<prj>:<dep>`) instead of the step output it
  uses today, and seals `secrets` to the builder node in
  `build_job.build_secrets_sealed`.

#### Redaction

- The redaction set of a deployment is frozen with it:
  `deployments.secret_keys` (env keys that are secret or secret-derived)
  selects values from `env_sealed`, plus the `secrets` of
  `build_env_sealed` for build logs. Rows from before the migration
  (`secret_keys IS NULL`) fall back to today's behaviour (current secret
  variables).
- Needles = each value and its standard base64 (padded and not), base64url,
  lower/upper hex, percent-encoding and JSON escaping, ≥ 6 code points,
  longest first: `redactionNeedles`/`redact` in
  `packages/shared/src/redaction.ts`, mirrored by `RedactionNeedles`/
  `Redact` in `packages/protocol/go/redact.go`; both pass
  `packages/protocol/fixtures/redaction.json` (implemented).
- The control plane's 30 s isolate cache of secrets per project is replaced
  by a cache keyed by deployment ID (the set never changes for a
  deployment).
- The agent redacts build output with the job's secret values (not by
  guessing names: `redact.go`'s name heuristics go).

### 5. Crypto

#### Format 2

```jsonc
{ "v": 2, "kid": "c67798f0", "iv": "<12 bytes, base64>", "ct": "<ciphertext‖tag, base64>" }
```

AES-256-GCM, random 96-bit IV per seal. `kid` names the sealing key: a KEK
id for values sealed under the KEK (project DEKs, instance secrets), a DEK
id for values sealed under a DEK. Format 1 (`{ v: 1, iv, ct }`, ADR 0003)
stays readable until rotation has moved everything (`unseal` currently
refuses v2: the crypto stream lifts that).

#### Keyring

- `MASTER_KEY`: current key (base64, ≥ 32 bytes). `MASTER_KEYS_PREVIOUS`:
  optional comma-separated earlier keys, newest first.
- `kid(key)` = first 8 hex of SHA-256(HKDF-SHA256(key, salt
  `roundhouse/v2/kid`, info `kid`, 32 bytes)). Pinned: key `"a"×32` →
  `c67798f0`.
- v2 subkeys: HKDF-SHA256(key, salt `roundhouse/v2/<purpose>`, info
  `<purpose>`, 32 bytes) for `kek`, `state-token`, `auth-secret`. A salt per
  purpose keeps derivations independent.
- The Better Auth secret is derived from the _current_ key: rotating signs
  everyone out (documented in the runbook). State tokens verify under every
  key of the keyring.
- `DEK id` = first 8 hex of SHA-256(raw DEK); `project_keys.kek_kid` and
  `dek_id` mirror the sealed metadata for indexed rotation queries.
- Implemented in `lib/keyring.ts`: `parseKeyring`, `masterKeyId`,
  `keyByKid`, `deriveKeyV2`, `dekId`, and the AAD builders below (pinned
  tests in `test/keyring.test.ts`).

#### AADs (format 2)

| Value                   | AAD                                                                      |
| ----------------------- | ------------------------------------------------------------------------ |
| Variable                | `variable:v2:<ws>:<prj>:<env>:<scope>:<svc\|->:<key>:<row_id>:<version>` |
| Project DEK             | `project-key:v2:<ws>:<prj>`                                              |
| Deployment env          | `deployment-env:v2:<ws>:<prj>:<dep>`                                     |
| Deployment build inputs | `deployment-build:v2:<ws>:<prj>:<dep>`                                   |
| Instance secret         | `setting:v2:<setting_key>:<field\|->`                                    |

Binding `row_id` and `version` stops a row's ciphertext from being copied to
another row or rolled back to an older version of itself. Every write that
bumps `version` re-seals (metadata-only changes included).

Instance secrets (signing key, GitHub App secrets) are sealed only through
`lib/instance-secrets.ts` (`sealInstanceSecret`/`unsealInstanceSecret`,
taking the `KeyEnv` bindings); every caller already goes through it, so the
crypto stream changes the format in one file.

#### Rotation

1. Operator: generate a new key; set `MASTER_KEYS_PREVIOUS` to the old key
   (prepending to any earlier ones); set `MASTER_KEY` to the new key;
   deploy. Everything keeps working (reads try `kid`, then v1 under each
   key); everyone is signed out.
2. Instance admin: `POST /v1/instance/keys/rotate` (fresh session, audits
   `instance.key_rotation_started`; 409 while one runs) or
   `roundhouse admin keys rotate`. It starts `KeyRotationWorkflow` (instance
   ID = rotation ID `krot_…`) and stores
   `instance_settings.key_rotation = { id, state, started_at, finished_at,
   error }`.
3. Workflow steps, each batched (100 rows) and idempotent with
   compare-and-swap on the old ciphertext: `rewrap-dek` (every
   `project_keys` row whose `kek_kid` isn't current), `rewrap-instance`,
   `reseal-variables` (`value_sealed.v = 1`, re-sealed with the v2 AAD at
   the same version, filling `fingerprint`), `reseal-deployments`
   (`env_sealed`, `build_env_sealed` with `v = 1`), `finish` (audits
   `instance.key_rotation_completed`, or `…_failed` on a non-retryable
   error).
4. `GET /v1/instance/keys` (`KeyStatusSchema`) reports current and previous
   kids, remaining rows per kind, the latest run, and
   `previous_keys_removable`. When it is true the operator removes
   `MASTER_KEYS_PREVIOUS`.

### 6. Node sealing

Variables and build secrets travel to nodes inside **sealed boxes**: only the
target node can open them, so neither the wire, the Durable Object's state,
nor a stolen signing key's _past_ frames expose them.

#### Keys

- At enroll the agent generates an **X25519** keypair, separate from its
  Ed25519 identity key, stored raw (32 bytes) in a 0600 file next to the
  credential. The public key goes in `JoinRequest.encryption_public_key`;
  the control plane stores `nodes.encryption_public_key`,
  `encryption_key_id` and `encryption_key_registered_at` (done at join).
- Nodes that joined earlier send `hello.encryption_key = { public_key, kid,
  sig }`, `sig` = the identity key's Ed25519 signature over
  `roundhouse-node-encryption-key:v1:<node_id>:<public_key>`
  (`encryptionKeySignaturePayload`). The control plane verifies it with
  `nodes.identity_public_key` (`verifyNodeEncryptionKey`) and stores it
  **only when the node has none** (audits `node.encryption_key_registered`);
  otherwise ignores it. Replacing a key needs a re-join, so a stolen node
  credential alone can't swap in an attacker's key.
- `kid` = first 16 hex of SHA-256(raw public key) (`nodeEncryptionKeyId`).

#### Scheme (implemented in `packages/protocol/src/box.ts` and `go/box.go`)

```
esk, epk   = fresh X25519 keypair
shared     = X25519(esk, recipient_pk)            // all-zero → reject
okm        = HKDF-SHA256(ikm = shared,
                         salt = epk ‖ recipient_pk (64 bytes),
                         info = "roundhouse-box:v1:" + purpose,
                         L = 44)
key, nonce = okm[0:32], okm[32:44]
ct         = AES-256-GCM(key, nonce, plaintext, aad = UTF-8(aad)) ‖ 16-byte tag
box        = { "v": 1, "kid": kid(recipient_pk), "epk": b64(epk), "ct": b64(ct) }
```

Standard padded base64 throughout. The key is single-use (fresh ephemeral
per box), so the derived nonce is safe. A box for another key fails with
`ErrBoxWrongKey` in Go before decryption, which the agent reports instead of
a generic failure.

| Purpose         | AAD                                                                   | Plaintext                                             |
| --------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| `workload-env`  | `roundhouse-box:v1:workload-env:<node_id>:<workload_id>:<generation>` | `{"env":{…},"files":{…}}` (`SealedWorkloadEnvSchema`) |
| `build-secrets` | `roundhouse-box:v1:build-secrets:<node_id>:<build_id>`                | `{"secrets":{…}}` (`SealedBuildSecretsSchema`)        |

`files` holds `mount_as_file` variables; a key is in `env` or `files`, not
both; together they obey the env limits (256 keys, 64 KiB).

#### Test vectors

`packages/protocol/fixtures/sealed-box.json` (generated by
`scripts/gen-fixtures.ts`, the repo's existing fixture directory rather than
a new `testdata/`): node key = RFC 7748 §6.1 Bob
(`5dab087e…e0eb`, public `3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hbeGdNrfx+FG+IK08=`, kid
`f35e5616160a30bf`), ephemeral = Alice (`77076d0a…2c2a`, epk
`hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=`), X25519 output
`4a5d9d5b…1742` as in the RFC, three cases (env with files, build secrets,
empty env). Both suites open every box and re-seal it to identical bytes;
`encryption-key.json` and `hello-encryption-key.json` pin the signed key;
the signed `desired_state` fixture carries real boxes that the Go tests
open (`TestSignedDesiredStateOpens`), and the signed `build_job` a real
secrets box.

#### Protocol gate

ADR 0013 gives every phase one protocol version, and each control plane
accepts N−1. This work needs a breaking change (plaintext `env` leaves the
wire), so it takes **the version after whatever `main` is at when it merges**.
In this branch that is 4 (`PROTOCOL_VERSION = 4`, `MIN_PROTOCOL_VERSION = 3`).
After Phases 2–4 it will be 7, with `MIN_PROTOCOL_VERSION = 6`. Every feature here
hangs off one gate, `SEALED_ENV_PROTOCOL_VERSION` (Go
`SealedEnvProtocolVersion`), so the merge renumbers one constant and the
fixtures.
- `WorkloadSpec.env` is **gone from the wire**; `env_sealed` (nullable,
  required non-null exactly for `service` workloads) replaces it. In Go,
  `WorkloadSpec.Env` and `SecretFiles` remain as `json:"-"` fields that
  `OpenWorkloadEnv` fills (and system workloads set directly).
- `env_sealed` is excluded from the spec hash. Invariant: **a workload ID's
  environment never changes**; any change of resolved env is a new
  deployment and so new workload IDs. (The agent must therefore put a
  digest of a _system_ workload's env in a label if it wants env changes to
  recreate it.)
- Every `desired_state` with a workload and every `build_job` with
  `build_secrets_sealed` counts as credential-bearing: `exp - iat ≤ 60 s`.
- Agents below `SEALED_ENV_PROTOCOL_VERSION` still connect and report, but
  get no workloads or builds, and the node shows "upgrade agent". Sending
  them plaintext `env` as a fallback would undo the point of sealing, so
  there is none. The control plane additionally gives no workloads
  to a node without an encryption key (done in `buildDesiredState`); the
  scheduler and builder choice must skip such nodes too (TODO, crypto
  stream; `it.todo` in `agent-protocol.test.ts`).
- `ws://`: the agent keeps `--insecure`, but refuses to apply workloads or
  builds received over `ws://` unless `ROUNDHOUSE_DEV=1` (it still connects
  and reports).

#### On the node

The agent hands `env` to Docker. **Residual**: `docker inspect` and the
container's `config.v2.json` show it to root on the node; root on a node is
trusted with that node's workloads. For variables that shouldn't sit there,
`mount_as_file` (opt-in, decided: in scope) delivers the value as
`/run/secrets/<KEY>` instead: the agent writes it to
`/run/roundhouse/secrets/<workload_id>/<KEY>` on the host tmpfs (`/run`;
`/run/roundhouse/secrets` is 0700 root, the per-workload directory 0755,
files 0444), and bind-mounts the per-workload directory read-only at
`/run/secrets`; it deletes the directory with the container.
`docker inspect` shows only the mount path. No `_FILE` variable is injected;
users add a plain `X_FILE=/run/secrets/X` themselves when their image wants
one.

### 7. Networks per environment

The naming is ADR 0003's ("Hardening: environment networks"), byte for byte,
including its hashed long-name form and `fixtures/network-names.json`.
Every replica of a project environment joins
`environmentNetworkName(project_id, environment_id)`, and only that network.
Containers move networks once on upgrade (their spec hash changes), and the
agent's GC removes the unused `roundhouse-*` networks it created.
`ROUNDHOUSE_PRIVATE_DOMAIN` keeps its `<service>.<environment>.internal` form.

**Change to ADR 0003.** 0003 says the agent "does not second-guess
`network`". That was true while one control-plane bug could only misplace a
workload inside its own project. Now the frame is the attacker's best
lever: `host` reaches the unauthenticated Caddy admin API and the
local registry (H1). The agent therefore accepts, for a service workload,
only:
1. the network computed from the workload's own `project_id` and
   `environment_id`, or
2. during the one migration rollout, the legacy `roundhouse-<project_id>` of
   the same project.

Everything else is rejected in protocol validation in both languages, and
again in the runtime. That covers `host`, `bridge`, `none`,
`roundhouse-system`, `roundhouse-build` (`RESERVED_NETWORKS`), and other
projects' and other environments' networks. 0003's concern still holds: the
agent never rewrites `network`, it only refuses. A control plane that isn't
upgraded yet sends form 1 or 2, so nothing splits.

### 8. Agent

- **H1**: enforced by protocol validation (above); the runtime also refuses
  to attach a service workload to any network but that one.
- **H2**: an image under `127.0.0.1:5000/` must be exactly
  `localImageRepository(project_id, service_id)@sha256:<digest>` (validated
  in both languages). A workload with `registry_auth` is always pulled with
  those credentials, never run from the local cache (a cached private image
  could otherwise be reused by a project without access).
- **H3**: one BuildKit daemon per project (state in
  `/var/lib/roundhouse/buildkit/<project_id lowercased>`), started on demand,
  stopped after 10 idle minutes, at most 2 running (LRU). BuildKit cache
  mounts can't be scoped by tenant, so separate daemons are the only real
  isolation. `build_job` now carries `project_id` and `service_id`;
  `image_repository` and `cache_key` (`buildCacheKey` =
  `<project_id>.<service_id>`) must match them (validated).
- **H4**: workloads and build daemons run with Docker's default seccomp and
  AppArmor (`docker-default`) profiles where the host supports them, never
  `unconfined`; build daemons get memory (default 4 GiB), CPU (default 2
  cores) and pids (4096) limits; workload limits come from the spec as
  before. The agent installs, idempotently at start, `DOCKER-USER` rules
  rejecting `169.254.169.254` and `fd00:ec2::254` from every `roundhouse-*`
  bridge, including `roundhouse-build`, where build daemons run (not on the
  host network).
- **M1**: Railpack and `git` run with an allowlisted environment (`PATH`,
  `HOME`, `TMPDIR`, `BUILDKIT_HOST`, and what the job supplies); nothing
  from the agent's own environment.
- **M2**: `source.ref` must pass `isSafeGitRef` (validated in both
  languages); the agent fetches by `commit_sha` and passes
  `--end-of-options` before any ref or URL argument.
- **M3**: when routes of different `project_id`s claim the same hostname and
  path prefix on one node, the agent installs none of them for that key,
  logs a system line and reports it in each affected workload's status
  message. (The control plane's unique hostnames should make this
  unreachable.)
- **M4**: every replica answers to `privateServiceAlias(service_id)`
  (`svc-01j….roundhouse.internal`). The `roundhouse.private_domain` label alias
  is registered only when it passes `IsPrivateDomain` and no other workload
  on the network claims it (lowest workload ID wins).
- Opens `env_sealed` per workload for each frame's generation; a box that
  fails to open leaves the workload `pending` with the reason in its status.

### 9. GitHub (F1, claims, webhooks)

- **Write**: setting `source.github_installation_id` requires the
  installation to be claimed by the service's workspace (400
  `installation_not_in_workspace`), and `repo_url` to be
  `https://github.com/<owner>/<repo>(.git)?` with the repository accessible
  through that installation (400 `repository_not_in_installation`, checked
  with the installation's repository list).
- **Mint** (`repoToken`): re-check the installation's workspace equals the
  deployment's; mint only for github.com URLs, scoped to that one
  repository (`repositories: [repo]`) and the given permissions; never an
  unscoped token. Non-github.com repositories never get credentials.
- **`resolveBranch`**: credentials only for `https://github.com/…`, sent as
  `Authorization: Basic x-access-token:<token>`; `redirect: "manual"`, and
  any 3xx is an error.
- **Claims**: `POST /v1/github/claims` (`github:manage`) creates a
  single-use `github_claim_states` row (10 min) and returns the App's
  install URL with a signed state (purpose `github-claim`, carrying the
  claim ID). The App manifest sets `request_oauth_on_install: true`, so the
  callback receives `installation_id`, `setup_action` and a user `code`.
  The callback consumes the claim (`consumed_at`, once), requires the
  signed-in user to be the claim's user, exchanges `code` with the App's
  client ID/secret for a user token, and claims the installation only if
  that GitHub user administers its account: the account is the user
  (`installation.account.id == user.id`) or the user is an org admin
  (`GET /user/memberships/orgs/{org}` → `role: admin`). Otherwise
  `github.installation_rejected`. Stored: `account_id`, `claimed_by`,
  `claimed_at`. Existing claims (migration sets `claimed_at`, `claimed_by`
  NULL) stay valid and are flagged "unverified" in the dashboard.
  `DELETE /v1/github/installations/{id}` releases a claim.
- **Webhooks**: after the signature check, dedupe on `X-GitHub-Delivery` and
  on SHA-256 of the raw body (`github_deliveries.body_hash`, unique): a
  replay under a fresh delivery ID is ignored.

### 10. Realtime

`ProjectRoom` re-checks access when it's told something changed and closes
affected sockets with `{ "type": "access.revoked", "reason" }` then close
code `4403` (`REALTIME_ACCESS_REVOKED_CLOSE`). Triggers (the writer calls
`PROJECT_ROOM.get(…).revalidate({ userIds? })` after committing): member
removed or role changed, team membership changed, grant changed or
revoked, workspace access settings changed, project deleted, session
revoked or signed out (`reason: "session"`; the room stores the session ID
per socket and checks it still exists). Besides, every socket is
re-validated at most every 60 s on its next message or alarm, so a missed
trigger is bounded.

### 11. Audit log

- **Append-only, hash-chained, one chain per install.** `auditInsert`
  writes `seq = MAX(seq) + 1` in the same statement (D1 runs statements
  serially, so `seq` never collides) inside the action's batch (done). The
  `AuditChain` Durable Object (single instance) then seals rows in `seq`
  order, filling `prev_hash` and `hash`; being the only writer of those
  columns is what prevents forks. It's poked with `waitUntil` after audited
  requests and runs an alarm every minute.
- `hash` = lowercase hex SHA-256 of UTF-8
  `JSON.stringify(["roundhouse-audit:v1", seq, prev_hash, id, workspace_id,
  actor_type, actor_id, action, target_type, target_id, metadata, ip,
  created_at])`, where `metadata` is the column's stored text (or `null`)
  and `created_at` the stored integer, so verification needs no canonical
  JSON of metadata. The first chained entry has `prev_hash` = 64 zeros.
  Entries from before the migration keep `seq` (by ID order) and no hash.
- No `ON DELETE CASCADE`: `audit_logs.workspace_id` is a soft link (no
  foreign key); deleting a workspace keeps its history. The migration
  rebuilt the table accordingly.
- `GET /v1/instance/audit-logs/verify` recomputes the chain and reports the
  first break. The stream may add triggers refusing UPDATE of sealed rows
  and DELETE (D1 supports triggers); they guard against bugs, the chain
  against tampering.
- New actions are in `AUDIT_ACTIONS` (sign-ins, 2FA, access, teams,
  protection, instance admins, keys, encryption keys, tokens).

### 12. Cache

Every `/v1/*` and `/api/auth/*` response gets `Cache-Control: no-store,
private` and `Vary: Cookie` (done, `lib/cache-control.ts`; responses from
Durable Objects are copied to make their headers mutable; 101 upgrades are
left alone).

### 13. Control-plane signing-key rollover

ADR 0002 left rollover as a TODO. ADR 0013 sketched it for Phase 2 and
deferred it to this ADR, so that both key systems are designed once:
- **The keyring** (section 5) covers keys that encrypt data at rest.
- **The signing key** is the Ed25519 key that agents pin to verify frames.

Its private half is an instance secret sealed under the KEK, so
`KeyRotationWorkflow`'s `rewrap-instance` step already moves it when the
master key rotates. Rolling the signing key itself is a separate,
deliberate operation:
- `welcome.next_keys: { kid, public_key, not_before }[]` (at most 2), signed
  by the current key. The agent pins each one next to the current key in its
  0600 key file.
- `POST /v1/instance/signing-keys/rotate`:
  - Needs `instance:manage`, a fresh session and 2FA.
  - Audits `key.rollover_scheduled`.
  - Generates a key, announces it in `welcome` and in a signed
    `key_announce` frame to connected agents, and switches signing at
    `not_before` = now + 24 h.
  - Frames signed by the old key are accepted until the agent has seen one
    signed by the new key after `not_before`; then the old kid is dropped.
- **A suspected key compromise is not a rollover.** An attacker holding the
  old key could announce their own "successor". So emergency replacement
  needs every node to re-join: a new join token, and the operator runs
  `install.sh --rejoin`. This is documented in the runbook, and the
  dashboard flags nodes still pinned to a retired kid.
- `GET /v1/instance/signing-keys` reports the current kid, the announced kids
  and, per node, which kids it has pinned.
- Gate: `SEALED_ENV_PROTOCOL_VERSION` (one gate for this whole ADR).

As implemented (`lib/signing-keys.ts`, `routes/signing-keys.ts`,
`agent/internal/conn/keys.go`, migration `0015`):
- The successor lives in `instance_settings.signing_key_next` (private half
  sealed like `signing_key`, listed in `INSTANCE_SECRET_FIELDS` so
  `KeyRotationWorkflow` re-wraps it). `POST …/rotate` takes an optional
  `delay_hours` (1–720, default 24) and audits `key.rollover_scheduled`.
- Signing is chosen per connection from the kids the agent pins
  (`hello.pinned_kids`, else `nodes.pinned_signing_kids`, recorded at join
  and on every announcement): the successor once due and pinned, else the
  current key, so an agent that missed the announcement keeps verifying and
  catches up from the next `welcome`. Agents accept a successor up to five
  minutes before `not_before` (clock error).
- The overlap ends with `POST /v1/instance/signing-keys/complete` (after
  `not_before`; 409 while nodes don't pin the successor unless `force`):
  the successor becomes `signing_key`, the old private key is deleted and its
  kid kept in `signing_key_retired`; audits `key.rollover_completed`.
  `DELETE /v1/instance/signing-keys/next` withdraws a successor before
  `not_before` (`key.rollover_cancelled`); agents drop it at their next
  `welcome`, whose `next_keys` is always the full set.
- Gate for the wire fields: `KEY_ROLLOVER_PROTOCOL_VERSION` (ADR 0015). Older
  agents are signed with the current key until completion and are then
  flagged for an upgrade and re-join.

Owners: stream 1 (`lib/signing-keys.ts`, `routes/signing-keys.ts`) and
stream 4 (`agent/internal/conn/keys.go`). These are the files 0013's row 2J
names.

### 14. Rules for PR previews (binds ADR 0007)

ADR 0007 already turns fork previews off by default, withholds `is_secret`
variables and secret build args from fork previews, gives forks empty
databases, and expires an approval on every new commit. On top of that:
1. **Withhold by taint, not just by flag.** A plain variable whose value
   resolves through a secret (`${{shared.STRIPE_KEY}}` inside
   `DATABASE_URL`, per `variable-taint.ts`) is withheld too. So is any
   value the classifier marks secret, whatever its stored tier. Withholding
   only `tier = secret` would leak references.
2. **No build secrets in untrusted builds.** Fork builds get no
   `available_at_build` secrets and no registry credentials. They run only
   on builder nodes matched by `build_node_selector`, which must not be the
   nodes that build production for the same project. The per-project
   BuildKit daemon (section 8, H3) is a separate daemon instance for preview
   environments (`<project_id>-preview`), so a fork build can't poison
   production's cache.
3. **Fork code never sees a token.** The base installation's token used to
   fetch `refs/pull/<n>/head` is scoped to that one repository with
   `contents: read`. It is used only by the agent's git fetch and never
   enters the build container. Its frame has the 60 s credential TTL.
4. **Approval is checked on the server.** The approver's permission comes
   from `GET /repos/{o}/{r}/collaborators/{login}/permission`, with an
   installation token, at approval time. The label alone is never trusted.
   An approval binds `approved_sha` and lapses on any new push (as 0007
   says).
5. **Preview containers are sandboxed like production ones:** no cloud
   metadata, an environment network of their own, and default
   seccomp/AppArmor (section 8).
6. **Comments never echo values.** PR comments and status checks carry
   status and URLs only, never variable values or build output.

### 15. Rules for the web shell and MCP server (binds ADR 0012)

ADR 0012 already limits the shell to owner and admin, passes `command` as an
argv array, re-checks role every 60 s, and audits and records sessions. On
top of that:
1. **Who.** `shell:open` is a project action. It resolves through
   `resolveAccess` to `project_admin` on the workload's project, and a
   protected environment's rules must also allow it (new rule key `shell`,
   default project admins only). It requires 2FA enrolled and a fresh
   session (re-auth within 10 min). API tokens with the `shell:open` scope
   work only for users who meet the same bar, and OAuth/MCP tokens never
   (as 0012 says).
2. **What.** The agent execs only into containers that carry its own
   `roundhouse.namespace` and the frame's `workload_id`. It never execs into
   system containers (`sys_*`, BuildKit daemons, Caddy, the registry). It
   always uses the container's configured user, never `Privileged` or
   added capabilities. `command` is validated as an argv array of at most
   32 entries and 4 KiB total. It is never joined into a shell string by the
   control plane or the agent; the default `sh -c` wrapper is a fixed
   constant.
3. **Data.** `exec_input` and `exec_output` are never written to Workers
   logs or the audit log. The audit log records who, which replica, when and
   how long, not keystrokes. Recordings are encrypted (0012's age envelope)
   to a recording key in the keyring (section 5), so rotation covers them.
   Secrets printed in a session are not redacted; a shell is privileged by
   definition, and the dialog says so.
4. **Revocation.** On member removal, role change, session revocation,
   access-grant change or environment-protection change, the relay closes
   open shells immediately (`exec_close { reason: "revoked" }`), in addition
   to 0012's 60 s re-check. It uses the same hook as realtime revocation
   (section 10).
5. **MCP.** The MCP tool set never includes reading secret values
   (there is no API for it any more), the shell, or variable writes that set
   `tier = secret` without the write-only confirmation. Tool results carry
   only plain values, filtered by the token user's access.

## Data model (migration `0004_security_hardening.sql`)

Generated by drizzle-kit, then edited by hand where drizzle can't express it
(marked with comments): the audit table rebuild assigns `seq` with
`ROW_NUMBER() OVER (ORDER BY id)`, `ADD COLUMN … REFERENCES` gets its
`ON DELETE SET NULL`, and the backfills are appended. `drizzle-kit check` and
`generate` report no drift.

| Table / column                                                                                 | Change                                                             |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `users.instance_admin`, `users.two_factor_enabled`                                             | new, default false; backfill instance admin (section 2)            |
| `sessions.reauthenticated_at`                                                                  | new                                                                |
| `two_factors`                                                                                  | new (Better Auth plugin)                                           |
| `login_attempts`                                                                               | new                                                                |
| `workspaces.member_default_project_role`, `viewer_default_project_role`                        | new, defaults `developer` / `viewer`                               |
| `teams`, `team_members`, `project_access_grants`                                               | new                                                                |
| `environments.protected`, `protection_rules`                                                   | new; existing rows unprotected                                     |
| `variables.tier`, `locked`, `fingerprint`, `updated_by`, `available_at_build`, `mount_as_file` | new; `tier` backfilled from `is_secret`, then `is_secret` dropped  |
| `project_keys.kek_kid`, `dek_id`                                                               | new; NULL until rotation                                           |
| `deployments.secret_keys`, `build_env_sealed`                                                  | new                                                                |
| `nodes.encryption_public_key`, `encryption_key_id`, `encryption_key_registered_at`             | new                                                                |
| `github_installations.account_id`, `claimed_by`, `claimed_at`                                  | new; `claimed_at` backfilled for claimed rows                      |
| `github_claim_states`                                                                          | new                                                                |
| `github_deliveries.body_hash`                                                                  | new, unique                                                        |
| `audit_logs`                                                                                   | rebuilt: no FK, `seq` unique, `prev_hash`, `hash`, index on action |

New ID prefixes: `tfa`, `team`, `tmm`, `pag`, `ghc`, `krot`.

**Merge note.** Numbered 0004 here so it sorts after `main`'s
`0003_retention_and_tokens.sql`. At merge it becomes the number after
`main`'s last migration, and its snapshot is regenerated from the merged
schema (see "Merging onto main").

## API surface

New routes are contracts in `apps/api/src/contracts/*` collected in
`SECURITY_ROUTES` (built and checked by `test/contracts.test.ts`; not yet
served). Each stream registers handlers on its router (already mounted in
`index.ts`) and then moves the route into the served set of that test.

| Method | Path                                        | Action                   | Fresh | Request → response                                   | Stream |
| ------ | ------------------------------------------- | ------------------------ | :---: | ---------------------------------------------------- | ------ |
| GET    | `/v1/services/{id}/variables`               | `variables:read`         |       | `?environment_id` → `VariableList`                   | 1      |
| PUT    | `/v1/services/{id}/variables`               | `variables:manage` (env) |       | `VariablesPut` → `VariablesPutResult`                | 1      |
| GET    | `/v1/projects/{id}/variables`               | `variables:read`         |       | `?environment_id` → `VariableList`                   | 1      |
| PUT    | `/v1/projects/{id}/variables`               | `variables:manage` (env) |       | `VariablesPut` → `VariablesPutResult`                | 1      |
| GET    | `/v1/services/{id}/variables/resolved`      | `variables:read_plain`   |       | `?environment_id` → `ResolvedVariables`              | 1      |
| GET    | `/v1/instance/keys`                         | `instance:manage`        |       | → `KeyStatus`                                        | 1      |
| POST   | `/v1/instance/keys/rotate`                  | `instance:manage`        |   ✓   | → 202 `KeyRotationStarted`                           | 1      |
| GET    | `/v1/workspaces/{id}/access-settings`       | `members:read`           |       | → `WorkspaceAccessSettings`                          | 2      |
| PATCH  | `/v1/workspaces/{id}/access-settings`       | `members:manage`         |   ✓   | `WorkspaceAccessSettingsPatch` → settings            | 2      |
| GET    | `/v1/workspaces/{id}/access/me`             | `workspace:read`         |       | → `EffectiveAccess`                                  | 2      |
| GET    | `/v1/workspaces/{id}/teams`                 | `members:read`           |       | → `{ teams: Team[] }`                                | 2      |
| POST   | `/v1/workspaces/{id}/teams`                 | `members:manage`         |   ✓   | `CreateTeam` → 201 `TeamDetail`                      | 2      |
| GET    | `/v1/teams/{teamId}`                        | `members:read`           |       | → `TeamDetail`                                       | 2      |
| PATCH  | `/v1/teams/{teamId}`                        | `members:manage`         |       | `UpdateTeam` → `Team`                                | 2      |
| DELETE | `/v1/teams/{teamId}`                        | `members:manage`         |   ✓   | → 204                                                | 2      |
| PUT    | `/v1/teams/{teamId}/members`                | `members:manage`         |   ✓   | `PutTeamMembers` → `TeamDetail`                      | 2      |
| GET    | `/v1/projects/{id}/access`                  | `access:manage`          |       | → `ProjectAccess`                                    | 2      |
| PUT    | `/v1/projects/{id}/access`                  | `access:manage`          |   ✓   | `PutProjectGrant` → `ProjectAccessGrant`             | 2      |
| DELETE | `/v1/projects/{id}/access/{grantId}`        | `access:manage`          |   ✓   | → 204                                                | 2      |
| GET    | `/v1/environments/{id}/protection`          | `projects:read`          |       | → `EnvironmentProtection`                            | 2      |
| PUT    | `/v1/environments/{id}/protection`          | `access:manage`          |   ✓   | `PutEnvironmentProtection` → `EnvironmentProtection` | 2      |
| GET    | `/v1/instance/admins`                       | `instance:manage`        |       | → `{ admins: InstanceAdmin[] }`                      | 2      |
| PUT    | `/v1/instance/admins/{userId}`              | `instance:manage`        |   ✓   | `PutInstanceAdmin` → `InstanceAdmin`                 | 2      |
| GET    | `/v1/instance/audit-logs`                   | `instance:manage`        |       | `?cursor&limit` → `InstanceAuditPage`                | 2      |
| GET    | `/v1/instance/audit-logs/verify`            | `instance:manage`        |       | → `AuditChainVerification`                           | 2      |
| POST   | `/v1/github/claims`                         | `github:manage`          |       | `StartGithubClaim` → `{ install_url }`               | 2      |
| DELETE | `/v1/github/installations/{installationId}` | `github:manage`          |   ✓   | `?workspace_id` → 204                                | 2      |
| GET    | `/v1/auth/security`                         | signed in                |       | → `SecurityStatus`                                   | 3      |
| POST   | `/v1/auth/reauth`                           | signed in                |       | `Reauth` → `ReauthResult`                            | 3      |

Changed policies of existing routes: `createProject` → `projects:create`;
`getGithubStatus` → `workspace:read`; `githubCallback` → `github:manage`;
`createGithubManifest`, `updateInstanceSettings` → fresh; variable writes
check the environment; `listGithubRepositories` takes `project_id` (with:
`services:manage` there; without: `github:manage`). Phase 0 routes (stream
2): `POST /v1/workspaces` → `workspaces:create`; member role change and
removal, invite creation, join-token creation → fresh; `/v1/me` adds
`user.instance_admin` (done). Removed: both `…/variables/reveal` routes.

Error codes added (`SECURITY_ERROR_CODES` in `@roundhouse/shared`, part of the
API's `ErrorCode`): `two_factor_required`, `reauth_required`,
`account_locked`, `confirmation_required`, `public_prefix_secret_value`,
`tier_locked`, `value_required`, `build_arg_secret`,
`installation_not_in_workspace`, `repository_not_in_installation`,
`node_encryption_key_missing`, `host_conflict`; plus
`public_origin_missing` (503) for stream 3 to add to `ErrorCode`.

## Work breakdown

Each file has exactly one owner. A stream that needs a change in a file it
doesn't own asks the owner. Hot files were pre-split in this pass so
streams don't collide: per-domain contract files under
`apps/api/src/contracts/`, schema files under `apps/api/src/schemas/`,
routers already mounted in `index.ts`, the Durable Object and Workflow
classes already bound in `wrangler.jsonc`, `env.ts` already typed.

| Stream                  | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 api-secrets-crypto    | `apps/api/src/lib/{crypto,keyring,instance-secrets,variables,logs,desired-state,settings}.ts`, `workflows/{deploy,key-rotation}.ts`, `durable/node-connection.ts` (hello key registration, sealing at push), `routes/{variables,keys,agent}.ts`, `contracts/{variables,keys}.ts`, `schemas/{variables,keys}.ts`, a new `assertPlainBuildArgs` in `lib/variables.ts` that stream 2 calls from the service routes, tests `test/{variables,keyring,logs,deploy,agent-protocol,pipeline-helpers}.ts`, `packages/shared/src/{variable-classifier,variable-taint,redaction}.ts`                                                                                                                                                      |
| 2 api-authz-rbac-github | `apps/api/src/context.ts`, `contracts.ts`, `contracts/{policy,params,access,instance}.ts`, `schemas.ts`, `schemas/{access,instance}.ts`, `lib/{scope,guards,github,git,audit,realtime,projects,workspaces,cache-control}.ts`, new `lib/access.ts`, `durable/{project-room,audit-chain}.ts`, `routes/{access,instance-admin,instance,github,projects,services,deployments,workspaces,invites,nodes,audit,realtime,setup}.ts`, `apps/api/wrangler.jsonc`, `apps/api/src/env.ts`, tests `test/{contracts,hardening,security,github,projects,services,workspaces,realtime,instance,nodes}.test.ts`, `packages/shared/src/{rbac,audit,ids,index}.ts`, `packages/db/**` (schema follow-ups and `0004_*` migrations for every stream) |
| 3 api-auth              | `apps/api/src/auth.ts`, `lib/{origin,two-factor-gate,fresh-session,cookies,errors}.ts`, new `lib/lockout.ts`, `routes/auth-security.ts`, `contracts/auth.ts`, `schemas/auth.ts`, `apps/api/vitest.config.ts`, `apps/api/test/setup.test.ts`, new `test/auth*.test.ts`, `packages/shared/src/auth-policy.ts`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 4 agent                 | `agent/**`, `packages/protocol/go/**` beyond this pass's contract (helpers only; shape changes need an ADR amendment), `install/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5 web                   | `apps/web/**`, `packages/ui/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 6 cli                   | `cli/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

`packages/protocol/src/**`, fixtures and generated schema are frozen for
this round (owned by this contract; changes need an ADR amendment). Shared
files with two consumers: `routes/agent.ts` (join) is stream 1's;
`index.ts` is stream 2's and needs no further change; `lib/errors.ts` is
stream 3's (it already includes `SECURITY_ERROR_CODES`). Stream 2 owns
`packages/db`: others send it schema changes, it writes one migration per
landing.

Cross-stream calls, all with fixed signatures from this pass:
`resolveAccess` (shared) — 2 implements the guard, 1 uses it via
`projectScope`/`serviceScope` returning the resolver; `requireFreshSession`
(3, implemented) — 2 calls it for `reauth: true`;
`sealInstanceSecret`/`unsealInstanceSecret` (1) — 2 calls them in
`lib/github.ts` (already wired); `auditInsert`/`recordAudit` (2) — everyone;
`sealWorkloadEnv` (1, in `desired-state.ts`); `publicOrigin` (3) — 2 and 1
call `originOf`.

### Order

All six streams can develop in parallel: every cross-stream signature is
fixed above. Merge order, each rebasing on the previous: 2 (the access guard
and `packages/db`, which the other API streams' routes rely on), 3, 1, 4,
5, 6. A stream needing a schema change sends it to stream 2 early; stream 2
lands one `0004_*` migration per merge.

### Merging onto main

`main` finishes the rename sweep and Phases 2–4 first, then this branch
merges onto it. The order is fixed, and each step is checked before the
next:
1. **Rebase** `security/hardening` onto `main`. Apply the rename (module
   paths, npm scope, product strings) to every file this branch added.
2. **Protocol.** Set `SEALED_ENV_PROTOCOL_VERSION` and `PROTOCOL_VERSION` to
   `main`'s version + 1 and `MIN_PROTOCOL_VERSION` to `main`'s version.
   Regenerate the schema and fixtures, including `sealed-box.json`, whose
   vectors don't depend on the version.
3. **Migration.** Renumber `0004_security_hardening.sql` after `main`'s last
   migration and regenerate its snapshot. Fold in tables that Phases 2–4
   added and that this ADR touches:
   - `variables`, `deployments` and the audit table rebuild;
   - previews' `same_repo_secrets`, which becomes tier- and taint-aware
     (section 14);
   - `shell_sessions`.
4. **Supersede.** ADR 0003's `secret_build_args` (plain values in
   `service_configs`, names marked secret) is replaced by `available_at_build`
   secret variables sealed in `build_secrets_sealed`. The migration moves
   each marked arg into a secret variable of the service's environments and
   removes it from `service_configs`.
5. **Fold the new frames into this ADR's rules.** That means every
   credential-bearing frame Phases 2–4 add: backups with S3 keys, `db_query`,
   `exec_*`, `image_push` credentials, `cert_*` private keys. Each gets the
   60 s credential TTL, and each that carries a secret moves into a sealed
   box with its own purpose string (section 6).
6. **Review.** Run the full test suites, the real-stack end-to-end run and an
   adversarial security review of the merged tree. Only then does the
   user approve the merge commit.

### Already done in this pass

Contracts, schemas, migration, the sealed-env protocol gate with boxes in TS and Go and
interop vectors, `resolveAccess`, classifier, taint, redaction needles,
lockout and freshness helpers, keyring primitives; interim implementations
so everything works end to end: tier-aware variable writes with the
confirmation and public-prefix checks (format 1, no fingerprints), reveal
removed (API, web, mocks, tests), env sealed to the node in desired state,
encryption key stored at join, keyless nodes get no workloads, `seq` on
audit rows, instance-admin flag (setup, `requireInstanceAction`, `/v1/me`,
web `canManageInstance`), `Cache-Control`, environment networks, build jobs
with project/service IDs, the agent tests updated for the new shape.

### Not done (TODO markers in code)

- Stream 1: format 2 sealing and the keyring in `crypto.ts`,
  `instance-secrets.ts`, `variables.ts`; fingerprints; `KeyRotationWorkflow`
  steps; key routes; resolve route; scheduler/builder skipping keyless
  nodes; `hello.encryption_key` registration; `mount_as_file` split and
  `secret_keys`/`build_env_sealed` in the deploy workflow; build-arg
  validation; redaction by deployment; tests `it.todo` in
  `agent-protocol.test.ts`.
- Stream 2: `lib/access.ts` and `resolveAccess` in every scope helper and
  `requireWorkspace`; reauth in the route guard; teams/grants/protection
  routes; `POST /v1/workspaces` gating; instance admin and audit routes;
  `AuditChain.seal`; F1; claims; webhook body hash; realtime revocation;
  instance-level audit entries.
- Stream 3: `publicOrigin` from `PUBLIC_ORIGIN`; two-factor plugin and
  gate; lockout; sign-in audit; security/reauth routes.
- Stream 4: everything in "Agent" and the agent half of "Node sealing".
  The agent compiles and passes its tests but doesn't open `env_sealed`
  yet, and doesn't send an encryption key at join, so a real node gets no
  workloads until this stream lands; the end-to-end suite (`e2e/`) fails
  until then.
- Stream 5: variables UI (tiers, write-only dialog, public-prefix
  acknowledgement using the shared classifier, fingerprints, build/file
  flags), teams/access/protection UI, 2FA enrollment and re-auth prompts,
  instance admin UI, `canCreateWorkspace` → `instance_admin`. The web
  currently sends `confirm_write_only: true` unconditionally (TODO marked).
- Stream 6: the CLI's wire types (`tier` instead of `is_secret`), removal of
  reveal and `--reveal`, `run --env-file`, `admin keys`. The CLI passes its
  own tests against its fake server but doesn't match the new API yet.

### Test status after this pass

All green: `pnpm -r typecheck`; `pnpm -r test` (shared 379, protocol 226,
api 276 + 2 todo, web 515, ui, hetzner, landing); `go test ./...` in
`packages/protocol/go`, `agent`, `cli`; `biome check .`; generated schema
and fixtures current. No test is left intentionally broken; the open items
are the two `it.todo` in `apps/api/test/agent-protocol.test.ts` and the
TODOs above.

## Consequences

- A database dump, a log line, the realtime socket, the wire and a
  compromised control-plane signing key no longer expose secret values;
  only the target node and someone with the master key can.
- Nobody can read a secret back, including the people who set it. Lost
  values must be re-issued at their source. This is the point.
- Upgrading recreates every workload once (network and protocol change),
  signs everyone out after a key rotation, and requires agents at
  `SEALED_ENV_PROTOCOL_VERSION` with an encryption key before anything is
  scheduled on them.
- Owners and admins must enroll a second factor before their next change.
- Access checks need the workspace's grants, teams and protection per
  request; `lib/access.ts` loads them in one batch.

## Product-owner decisions (2026-10-23)

1. **Existing production environments are protected on upgrade.** The
   migration backfill marks environments named `production`/`prod` as
   protected with the default rule set. This supersedes the "leave existing
   environments unprotected" backfill described above; the owning stream must
   update `0004_security_hardening.sql` accordingly.
2. **Deployers are read-only for variables**, in every environment.
3. **High-entropy values** default to secret but stay unlocked.

## Open questions for the product owner

1. **Legacy GitHub claims** (made before the ownership check) stay valid and
   are flagged. Require re-verification within N days instead?
2. **Trusted devices** for 2FA are off. Allow "remember this browser for 30
   days" for non-admins later?
