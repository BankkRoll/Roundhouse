# 0008: Observability (metrics, logs explorer, alerts)

## Status

Proposed.
- Date: 2026-10-22
- Phase: 3
- Protocol: version 5 (`metrics` frame)
- Depends on: 0003 (log pipeline), 0004 ("Scheduled dispatch", the `JOBS`
  queue), 0005 (node lifecycle), 0010 (cron events).

Names follow the Roundhouse rename (0013, "Naming").

## Context

Today:
- **Metrics.** The agent reports node-level usage in each heartbeat (every
  10 s), and the node DO writes one Analytics Engine data point per
  heartbeat (`METRICS`, dataset `roundhouse_metrics`, `indexes: [nodeId]`,
  `blobs: [nodeId, "node"]`). Nothing measures containers, and nothing
  queries the dataset.
- **Logs** are NDJSON chunks in R2, indexed in `log_chunks` by service,
  deployment or build and time. The API pages them by deployment. There is
  no search across services, levels or text.
- **Alerts.** There are none.

Facts (sources at the end):
- **Analytics Engine writes.** `writeDataPoint` takes 20 blobs, 20 doubles
  and 1 index (≤ 96 bytes). Blobs total ≤ 16 KB. At most 250 data points
  per invocation. Data is kept 3 months.
- **Sampling.** Writes are sampled equitably per index value, and reads
  use adaptive sampling. Correct aggregates weight by `_sample_interval`
  (count is `sum(_sample_interval)`).
- **SQL API.** `POST /accounts/{id}/analytics_engine/sql` with a bearer
  token holding "Account Analytics Read". It supports `toStartOfInterval`,
  `quantileExactWeighted` and `FORMAT JSON`.
- **Billing** is not active yet. The planned Paid allowance is 10M writes
  and 1M queries per month.
- **Local development.** In `wrangler dev`, Analytics Engine bindings are
  stubs (writes are dropped, there is no SQL), and the dataset cannot be a
  remote binding.
- **Email.** Cloudflare Email Service can send to arbitrary recipients
  only on Workers Paid with an onboarded sending domain (public beta since
  2026-04-16). The docs contradict each other on verified-only bindings.

## Decision

### Metrics

**Agent sampling** (`internal/metrics`). Every 15 s, the agent reads each
managed container's cgroup v2 files directly. That is cheap: no Docker
stats stream per container. It finds the cgroup through
`/proc/<init pid>/cgroup` and supports both the `systemd` and `cgroupfs`
drivers.

| Field                                 | Source                                                | Sent as                              |
| ------------------------------------- | ----------------------------------------------------- | ------------------------------------ |
| `cpu_millis`                          | Δ`cpu.stat usage_usec` / Δt                           | average millicores over the interval |
| `mem_bytes`                           | `memory.current` − `memory.stat inactive_file`        | working set at sample time           |
| `mem_limit_bytes`                     | `memory.max` (`max` → node total)                     |                                      |
| `net_rx_bytes`, `net_tx_bytes`        | `/proc/<pid>/net/dev`, every interface except `lo`, Δ | bytes in the interval                |
| `disk_read_bytes`, `disk_write_bytes` | `io.stat rbytes/wbytes`, summed, Δ                    | bytes in the interval                |
| `pids`                                | `pids.current`                                        |                                      |
| `restarts`                            | agent's restart counter, Δ                            |                                      |

On a cgroup v1 host, the agent falls back to
`GET /containers/{id}/stats?stream=false&one-shot=true`, and the dashboard
notes "approximate (cgroup v1)". The first sample after a container
starts carries no deltas.

**Protocol (version 5).** A new agent → control frame, at most one per
second, normally one every 15 s:

```ts
{
  type: "metrics";
  ts: number; // sample time, unix ms
  interval_ms: number; // 15000 nominal
  samples: {
    workload_id: IdString;
    cpu_millis: number;
    mem_bytes: number;
    mem_limit_bytes: number;
    net_rx_bytes: number;
    net_tx_bytes: number;
    disk_read_bytes: number;
    disk_write_bytes: number;
    pids: number;
    restarts: number;
  }
  []; // ≤ MAX_STATUSES_PER_HELLO (160)
}
```

The agent stops sending it to a control plane that has not acknowledged
v5 in `welcome`. That is the existing version handshake: the control
plane never asks a v4 agent for it, and a v5 agent sends it only when
`welcome.metrics_interval_ms` (new, optional) is present.

**Write path.** The node DO resolves each `workload_id` to its owners
(cached 30 s, like log owners) and writes one Analytics Engine data point
per sample in the `roundhouse_metrics` dataset. The node heartbeat moves
to the same layout. The layout is fixed in
`packages/shared/src/metrics-layout.ts` and never reordered; new fields
append.

| Column               | Container row                                                                                                   | Node row                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `index1`             | `service_id`                                                                                                    | `node_id`                                                         |
| `blob1`              | `"container"`                                                                                                   | `"node"`                                                          |
| `blob2`              | `workspace_id`                                                                                                  | `workspace_id`                                                    |
| `blob3`              | `project_id`                                                                                                    | `""`                                                              |
| `blob4`              | `environment_id`                                                                                                | `""`                                                              |
| `blob5`              | `service_id`                                                                                                    | `""`                                                              |
| `blob6`              | `deployment_id`                                                                                                 | `""`                                                              |
| `blob7`              | `workload_id`                                                                                                   | `""`                                                              |
| `blob8`              | `node_id`                                                                                                       | `node_id`                                                         |
| `double1`–`double10` | cpu_millis, cpu_limit_millis, mem_bytes, mem_limit_bytes, net_rx, net_tx, disk_read, disk_write, pids, restarts | cpu_percent, —, mem_used, mem_total, —, —, —, —, disk_used, load1 |
| `double11`           | `interval_s`                                                                                                    | `interval_s`                                                      |

Indexing on `service_id` makes write-time sampling fair per service. One
`metrics` frame is at most 160 points, inside the 250-points-per-invocation
cap. At 15 s, a container produces about 173k points a month. 50
containers stay under the planned 10M monthly allowance, and the dashboard
shows the projection in Settings → Usage.

**Query path.** A `MetricsStore` interface (`apps/api/src/lib/metrics/`)
has two implementations:
- **`AnalyticsEngineStore`** (production). It needs the Worker variable
  `CF_ACCOUNT_ID` and the secret `CF_ANALYTICS_TOKEN` (Account Analytics
  Read), both set by the deploy script. It builds SQL from a typed
  `MetricsQuery`, never from user text. Every interpolated value is a
  validated ID (`ID_RE`) or an integer. Example:

  ```sql
  SELECT toStartOfInterval(timestamp, INTERVAL '60' SECOND) AS t, blob7 AS workload,
         sum(double1 * _sample_interval) / sum(_sample_interval) AS cpu
  FROM roundhouse_metrics
  WHERE index1 = 'svc_…' AND blob1 = 'container' AND blob4 = 'env_…'
    AND timestamp >= toDateTime(1761100000) AND timestamp < toDateTime(1761103600)
  GROUP BY t, workload ORDER BY t FORMAT JSON
  ```

  Memory is averaged and maxed with the same weighting. Network and disk
  rates are `sum(x × _sample_interval) / step_s`.
- **`D1MetricsStore`** (development, tests, and installs without an
  analytics token). With `METRICS_BACKEND=d1`, the DO also writes samples
  to a D1 table `metrics_samples` (same columns, 48 h retention, pruned by
  the hourly job), and an equivalent SQLite query answers. The dashboard
  marks it "short retention".

**Resolution.** The step is chosen from the range: ≤ 1 h → 15 s; ≤ 6 h →
60 s; ≤ 24 h → 5 min; ≤ 7 d → 30 min; ≤ 30 d → 2 h; ≤ 90 d → 6 h. That
keeps every chart at 360 points or fewer. Results are cached in the Cache
API for 30 s, keyed by the query.

| Method and path                                                                  | RBAC            | Notes                                            |
| -------------------------------------------------------------------------------- | --------------- | ------------------------------------------------ |
| `GET /v1/services/{serviceId}/metrics?environment_id=&from=&to=&metrics=&group=` | `services:read` | `group: service \| replica`                      |
| `GET /v1/projects/{projectId}/metrics/summary?environment_id=`                   | `projects:read` | latest 5-min average per service, for the canvas |
| `GET /v1/workspaces/{workspaceId}/nodes/{nodeId}/metrics?from=&to=`              | `nodes:read`    |                                                  |

The response is `{ step_s, limits: { cpu_millis, memory_bytes }, series:
[{ metric, workload_id?, points: [[t_ms, value | null]] }] }`.

### Logs explorer

**Ingest additions**, in the node DO, where lines are already parsed and
redacted:
- **Level detection.** Each stored line gains `lvl`:
  1. A JSON line with a string `level`, `severity` or `lvl` key is
     normalised to `trace | debug | info | warn | error | fatal`.
  2. Otherwise, a leading token
     `[?(TRACE|DEBUG|INFO|WARN(ING)?|ERR(OR)?|FATAL|CRIT(ICAL)?|PANIC)]?`
     (case-insensitive) is mapped the same way.
  3. Otherwise `lvl` is absent. `stderr` alone does not mean error.
- **Chunk counts.** `log_chunks` gains `environment_id`, `error_count` and
  `warn_count`, plus an index on `(project_id, environment_id, first_ts)`.

**Query syntax** (`packages/shared/src/log-query.ts`, a pure parser with
error positions). Terms are AND-ed:

| Term                            | Meaning                                                               |
| ------------------------------- | --------------------------------------------------------------------- |
| `service:api`                   | service slug (repeatable: OR within the field)                        |
| `deployment:dep_…`              | deployment ID                                                         |
| `replica:wl_…`                  | workload                                                              |
| `level:error`, `level:>=warn`   | detected level; `>=` uses the order trace<debug<info<warn<error<fatal |
| `stream:stderr`                 | stdout, stderr, system                                                |
| `@status:500`                   | top-level key of a JSON line, string or number equality               |
| `timeout`, `"connection reset"` | case-insensitive substring                                            |
| `-term`                         | negation of any term above                                            |

Regular expressions are not supported. Workers cannot bound regex
backtracking, and a pathological pattern over millions of lines is a CPU
denial of service.

**Execution.** `POST /v1/projects/{projectId}/logs/search`:

```ts
{ environment_id; query; from: number; to: number; limit?: number /* ≤ 500, default 200 */; cursor?: string }
```

- **Window.** `to − from` is at most 24 h, and the dashboard pages
  backwards one window at a time.
- **Scan order.** The Worker selects candidate chunks from D1 (project,
  environment, the service filter resolved to IDs, time overlap), newest
  first. It skips chunks whose `error_count`/`warn_count` rule out a
  `level:` filter.
- **Fetch and filter.** It fetches up to 6 chunks concurrently from R2,
  stream-parses the NDJSON, filters, and stops at `limit` matches or at
  the **scan budget**: 300 chunks or 64 MiB of raw NDJSON per request.
- **Response.** `{ lines, next_cursor, scanned: { chunks, bytes, until_ts }, complete }`.
  `complete: false` with a cursor means the budget ran out before the
  window did, and the dashboard shows "Scanned to 14:02 · Continue".

**Saved searches.**

```sql
CREATE TABLE saved_log_searches (
  id TEXT PRIMARY KEY,                    -- lsq_…
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, query TEXT NOT NULL,
  environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE,
  shared INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

**Live tail.** The `ProjectRoom` topic `{ kind: "service_logs", service_id,
environment_id, level?: ">=warn", stream? }` forwards matching lines live.
The room applies only the level and stream filters; text filters are
applied in the browser.

| Method and path                                 | RBAC                                                     | Audit |
| ----------------------------------------------- | -------------------------------------------------------- | ----- |
| `POST /v1/projects/{projectId}/logs/search`     | `services:read`                                          | none  |
| `GET /v1/projects/{projectId}/saved-searches`   | `services:read`                                          | none  |
| `POST /v1/projects/{projectId}/saved-searches`  | `services:read` (`shared: true` needs `services:manage`) | none  |
| `PATCH`, `DELETE /v1/saved-searches/{searchId}` | owner of the search, or `services:manage` for shared     | none  |

### Alerts

**Rules.**

```sql
CREATE TABLE alert_rules (
  id TEXT PRIMARY KEY,                    -- alr_…
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,       -- null: workspace scope (nodes)
  environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE,
  service_id TEXT REFERENCES services(id) ON DELETE CASCADE,       -- null: every service in scope
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  params TEXT NOT NULL,                   -- JSON, per type (below)
  severity TEXT NOT NULL DEFAULT 'warning',   -- info | warning | critical
  for_s INTEGER NOT NULL DEFAULT 0,       -- condition must hold this long before firing
  resolve_after_s INTEGER NOT NULL DEFAULT 300,
  repeat_interval_s INTEGER NOT NULL DEFAULT 14400,  -- reminders while firing; 0 = never
  enabled INTEGER NOT NULL DEFAULT 1,
  next_eval_at INTEGER,                   -- polled types only
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE alert_rule_channels (rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE, PRIMARY KEY (rule_id, channel_id));
```

| `type`               | Kind    | `params`                                                                                                                                                               | Fires when / resolves when                                        |
| -------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `deployment_failed`  | event   | `{}`                                                                                                                                                                   | a deployment ends `failed` / the next one is `active`             |
| `deployment_crashed` | event   | `{}`                                                                                                                                                                   | `active → crashed` / back to `active` or superseded               |
| `node_offline`       | event   | `{ node_id? }`                                                                                                                                                         | node `offline` / `online`                                         |
| `service_degraded`   | event   | `{}`                                                                                                                                                                   | 0005 `service.degraded` / `service.recovered`                     |
| `backup_failed`      | event   | `{}`                                                                                                                                                                   | backup `failed` / next backup `succeeded`                         |
| `cron_failed`        | event   | `{ consecutive: 1..10 }`                                                                                                                                               | N consecutive failed, timed-out or lost runs / a run succeeds     |
| `cron_missed`        | event   | `{}`                                                                                                                                                                   | a `missed` record / next run succeeds                             |
| `domain_failed`      | event   | `{}`                                                                                                                                                                   | 0009 verification or certificate `failed` / `issued`              |
| `cert_expiring`      | event   | `{ days: 1..30 }`                                                                                                                                                      | `cert_not_after − now < days` (0009) / renewed                    |
| `volume_usage`       | polled  | `{ percent: 50..99 }`                                                                                                                                                  | `used_bytes / size ≥ percent` / below `percent − 5`               |
| `metric_threshold`   | polled  | `{ metric: "cpu_pct_limit" \| "mem_pct_limit" \| "restarts" \| "net_rx_bps" \| "net_tx_bps", agg: "avg" \| "max", window_s: 60..3600, op: ">" \| "<", value: number }` | condition holds for `for_s` / false for `resolve_after_s`         |
| `log_match`          | counted | `{ query: string /* log-query subset: service, level, stream, text */, count: 1..100000, window_s: 60..3600 }`                                                         | matches in the window ≥ `count` / < `count` for `resolve_after_s` |

**Evaluation.**
- **Event rules.** The code that observes the event calls
  `signalAlert(env, AlertSignal)`, which enqueues
  `{ kind: "alert_signal", … }` on `JOBS`. The callers are the deploy
  workflow, the node DO, the backup and cron workflows, and the 0009
  checker. The consumer finds matching enabled rules by scope and applies
  the state machine.
- **Polled rules.** The minute tick (0004) claims rules with
  `next_eval_at <= now`. It evaluates every `metric_threshold` rule of a
  project with **one** `MetricsStore` query per (project, metric), over
  the longest window, grouped by service. `volume_usage` is read from the
  `volumes` table. Rules are evaluated every 60 s.
- **Counted rules.** The node DO compiles the enabled `log_match` rules of
  each (project, environment, service) it ingests for (cached 30 s) and
  counts matches per rule per minute in DO storage. On its alarm (≤ every
  10 s) it emits `{ kind: "alert_signal", type: "log_count", rule_id,
  minute, count }`. The consumer upserts
  `alert_counters(rule_id, minute, count)` (summed across nodes, because
  replicas may sit on several), and the minute tick evaluates the window
  sum. Counters older than 2 h are pruned.

**State, deduplication and flapping.**

```sql
CREATE TABLE alert_states (
  rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  target_key TEXT NOT NULL,             -- "svc_…" | "node_…" | "dep_…" | "vol_…" | "dom_…"
  state TEXT NOT NULL,                  -- ok | pending | firing
  since INTEGER NOT NULL, last_value REAL, last_eval_at INTEGER NOT NULL,
  transitions TEXT NOT NULL DEFAULT '[]',   -- JSON unix-ms of state changes in the last 30 min
  flapping INTEGER NOT NULL DEFAULT 0,
  incident_id TEXT,
  PRIMARY KEY (rule_id, target_key)
);
CREATE TABLE incidents (
  id TEXT PRIMARY KEY,                  -- inc_…
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  rule_id TEXT REFERENCES alert_rules(id) ON DELETE SET NULL,
  target_key TEXT NOT NULL, severity TEXT NOT NULL,
  status TEXT NOT NULL,                 -- open | resolved
  title TEXT NOT NULL, details TEXT,    -- JSON (values, links); never secrets or log text beyond 512 bytes
  occurrences INTEGER NOT NULL DEFAULT 1,
  acknowledged_by TEXT REFERENCES users(id) ON DELETE SET NULL, acknowledged_at INTEGER,
  opened_at INTEGER NOT NULL, resolved_at INTEGER, last_notified_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX incidents_open_uq ON incidents(rule_id, target_key) WHERE status = 'open';
```

- **Transitions.**
  - `ok → pending` when the condition becomes true.
  - `pending → firing` after `for_s`; at once when `for_s = 0`.
  - `firing → ok` after the resolve condition holds for
    `resolve_after_s`, or immediately on an event rule's counter-event.
  - Event incidents with no counter-event auto-resolve after 24 h.
- **Deduplication.** At most one open incident per (rule, target),
  enforced by the partial unique index. A repeat while firing increments
  `occurrences` and notifies nobody. Reminders go out every
  `repeat_interval_s` while firing, unless the incident is acknowledged.
- **Flapping.** Four or more state changes within 30 min set
  `flapping = 1`. The channels get one "flapping" notification, and
  transition notifications are suppressed. When there has been no
  transition for 15 min, `flapping` clears, and one notification reports
  the current state.
- **Notifications** go out on: firing, resolved, reminder, flapping
  start, and flapping end.

**Channels.**

```sql
CREATE TABLE notification_channels (
  id TEXT PRIMARY KEY,                  -- nch_…
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                   -- email | discord | slack | webhook
  name TEXT NOT NULL,
  config_sealed TEXT NOT NULL,          -- JSON sealed under the KEK, AAD "channel:<id>"
  enabled INTEGER NOT NULL DEFAULT 1,
  last_success_at INTEGER, last_error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  incident_id TEXT REFERENCES incidents(id) ON DELETE CASCADE, event TEXT NOT NULL,
  status TEXT NOT NULL,                 -- pending | sent | failed
  attempts INTEGER NOT NULL DEFAULT 0, response_status INTEGER, error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

Delivery goes through `JOBS` (`kind: "notify"`, one message per channel
per event). Failures retry with `retry({ delaySeconds })`: 30 s, 2 min,
10 min, 30 min, 1 h, then 1 h up to 8 attempts. After that the delivery
goes to the DLQ and is marked `failed`. Each channel is rate-limited to 20
deliveries per minute, and beyond that, incidents are summarised into one
message.

| `type`    | `config` (sealed)                                        | Request                                                                                                      |
| --------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `email`   | `{ to: string[] \| { roles: Role[] } }`                  | through the instance's `EmailProvider`                                                                       |
| `discord` | `{ webhook_url }` (`https://discord.com/api/webhooks/…`) | `POST` `{ content, embeds: [{ title, description, color, fields, url, timestamp }] }`, content ≤ 2,000 chars |
| `slack`   | `{ webhook_url }` (`https://hooks.slack.com/…`)          | `POST` `{ text, blocks }`                                                                                    |
| `webhook` | `{ url (https), secret (32 random bytes, base64url) }`   | `POST` JSON, signed (below)                                                                                  |

**Generic webhook format.**
- **Body:**
  `{ "id": "<delivery id>", "type": "incident.firing" | "incident.resolved" | "incident.reminder" | "incident.flapping" | "incident.flapping_ended" | "channel.test", "created_at": <ms>, "workspace_id", "incident": {...}, "rule": {...} }`.
- **Headers:** `Content-Type: application/json`,
  `User-Agent: Roundhouse-Webhooks/1`, `Roundhouse-Event`,
  `Roundhouse-Delivery`, and
  `Roundhouse-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
- **Receivers** must recompute the signature over the raw bytes, compare
  in constant time, and reject `|now − t| > 300 s`.
- `packages/shared/test/webhook-signature.json` holds the test vectors and
  the docs include verifiers.
- **Transport.** Only `https://` URLs are accepted, plus `http://` to
  loopback with the Worker variable `ALLOW_HTTP_WEBHOOKS=1`, for
  development. Timeout 10 s, redirects not followed; a 2xx is success.

**Email providers.** `EmailProvider { send({ to, subject, text, html }): Promise<{ id }> }`
is selected by the instance setting `email_provider`:
- `cloudflare`: the `send_email` binding of Cloudflare Email Service.
  Workers Paid, onboarded sending domain.
- `resend`, `postmark`: their HTTP APIs, with an API key sealed in the
  setting.
- `log`: development. It writes to `dev_outbox` in D1 and to the console.

There is no default provider. Until one is configured, email channels
cannot be created (`409 email_provider_not_configured`). The same
provider sends invites when configured.

**In-app inbox.**

```sql
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,                  -- inb_…
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  incident_id TEXT REFERENCES incidents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT,
  read_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX inbox_items_user_idx ON inbox_items(user_id, read_at, id);
CREATE TABLE notification_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  inbox TEXT NOT NULL DEFAULT 'all',    -- all | critical | none
  PRIMARY KEY (user_id, workspace_id)
);
```

On firing, resolved and flapping, the consumer fans out one inbox item to
each workspace member who can read the project and whose preference
allows the severity. Items older than 90 days are pruned hourly.
`ProjectRoom` pushes `inbox.new { item }` to sockets of the target user;
otherwise the dashboard polls every 60 s.

**Routes.**

| Method and path                                            | RBAC                              | Audit                                       |
| ---------------------------------------------------------- | --------------------------------- | ------------------------------------------- |
| `GET`, `POST /v1/workspaces/{ws}/alert-rules`              | `alerts:read` / `alerts:manage`   | `alert_rule.created`                        |
| `PATCH`, `DELETE /v1/alert-rules/{ruleId}`                 | `alerts:manage`                   | `alert_rule.updated` / `alert_rule.deleted` |
| `GET /v1/workspaces/{ws}/incidents?status=&project_id=`    | `alerts:read`                     | none                                        |
| `POST /v1/incidents/{incidentId}/acknowledge`              | `alerts:manage`                   | `incident.acknowledged`                     |
| `POST /v1/incidents/{incidentId}/resolve`                  | `alerts:manage`                   | `incident.resolved_manually`                |
| `GET`, `POST /v1/workspaces/{ws}/notification-channels`    | `alerts:read` / `channels:manage` | `channel.created`                           |
| `PATCH`, `DELETE /v1/notification-channels/{channelId}`    | `channels:manage`                 | `channel.updated` / `channel.deleted`       |
| `POST /v1/notification-channels/{channelId}/test`          | `channels:manage`                 | `channel.tested`                            |
| `POST /v1/notification-channels/{channelId}/reveal-secret` | `channels:manage`                 | `channel.secret_revealed`                   |
| `GET /v1/notification-channels/{channelId}/deliveries`     | `channels:manage`                 | none                                        |
| `GET /v1/me/inbox?workspace_id=&unread=`                   | session                           | none                                        |
| `POST /v1/me/inbox/read` `{ ids \| all }`                  | session                           | none                                        |
| `GET`, `PUT /v1/me/notification-preferences?workspace_id=` | session                           | none                                        |

New RBAC actions:
- `alerts:read`: every role.
- `alerts:manage`: owner, admin and member.
- `channels:manage`: owner and admin. Channel configs hold webhook URLs,
  which are credentials.

New ID prefixes: `alr`, `inc`, `nch`, `inb`, `lsq`.

### Dashboard

- **Service → Metrics.** CPU (with limit line), memory (working set, limit
  line), network, disk and restarts. A range picker offers 1 h, 6 h,
  24 h, 7 d and 30 d, plus per-replica toggles. Charts read the
  `dataviz` tokens, light and dark.
- **Canvas.** Each node shows a CPU and memory sparkline from
  `/metrics/summary`, refreshed every 60 s.
- **Logs explorer** (project level). Query bar with autocomplete for
  fields, service slugs and levels; time range; results newest first with
  level colouring and a JSON pretty-print toggle; "Scanned to …
  Continue"; Live toggle; saved searches sidebar; "Create alert from
  search" pre-fills a `log_match` rule.
- **Alerts** (workspace settings and per project). Rules list with state
  badges; a rule editor with a preview ("would have fired 3 times in the
  last 24 h", for polled metric rules); incidents with Acknowledge /
  Resolve; channels with Test and the delivery log.
- **Bell icon** with the unread inbox count; the inbox panel; preferences.

## Security

- Metrics SQL is generated from typed input with validated IDs and
  integers only. The analytics token is read-only and lives as a Worker
  secret.
- Log search runs only over the caller's project. Redaction already
  happened at ingest, so search can't surface a known secret value. The
  scan budget and the absence of regex bound CPU per request.
- Channel configs (webhook URLs, secrets) are sealed at rest. Revealing a
  webhook secret is audited, and the secret is shown once at creation.
- Outbound webhooks are signed with a timestamp to prevent replay, are
  HTTPS-only, follow no redirects, and carry no secrets, variables or log
  text beyond a 512-byte excerpt for `log_match`.
- Inbox items are fanned out only to members who can read the project at
  fan-out time. Reading an item re-checks membership.

## Testing strategy

- **Unit (TS).**
  - The log-query parser (positions, negation, `level:>=`).
  - Level detection.
  - The metrics SQL builder: snapshot tests, plus an injection test
    proving that every non-ID input is rejected before SQL exists.
  - Parsing of **recorded** Analytics Engine JSON responses
    (`apps/api/test/fixtures/analytics-engine/*.json`).
  - The alert state machine as property tests: one open incident per
    target, flapping enters at the 4th transition within 30 min and exits
    after 15 quiet min, reminders respect acknowledgement.
  - Webhook signature vectors.
- **Unit (Go).** The cgroup reader against fixture trees
  (`internal/metrics/testdata/cgroup-{systemd,cgroupfs,v1}`), and delta
  arithmetic across counter resets on restart.
- **Agent integration.** A container running `yes > /dev/null` with
  `cpu_millis: 500` reports 400–520 millicores. A 300 MiB allocation
  shows in `mem_bytes`.
- **Real-stack e2e** (`e2e/phase3/observability.test.mjs`, with
  `METRICS_BACKEND=d1`, `email_provider=log`, and a local webhook
  receiver container standing in for Discord, Slack and generic
  webhooks):
  1. A CPU burner service: the metrics API reports CPU near its limit
     within 60 s, per replica and per service.
  2. A service writes 50,000 lines across 20+ chunks, one containing
     `ERROR upstream timeout`. `level:error "timeout"` finds it, skipping
     chunks with `error_count = 0` (asserted through `scanned.chunks`).
     Then save the search and reload it.
  3. A `metric_threshold` rule (`mem_pct_limit > 80`, `for_s: 60`): a
     memory hog fires one incident. The webhook receiver gets
     `incident.firing` with a valid signature, Discord and Slack payloads
     match the schema snapshots, an email lands in `dev_outbox`, and an
     inbox item appears. Stopping the hog delivers `incident.resolved`.
  4. Flapping: toggling the condition 5 times in 10 min gives exactly one
     `incident.flapping` delivery, and no per-transition deliveries.
  5. A `deployment_failed` rule fires on a broken build and resolves on
     the next successful deploy.
  6. The webhook receiver returns 500 three times: deliveries retry and
     then succeed, and the delivery log shows 4 attempts.
- **Live only.** The SQL API against a real dataset (sampling, latency) is
  checked by `scripts/verify-analytics-engine.mjs`, run by maintainers
  with a token. It is not in CI.

## Rollout and compat

- **Protocol 5** (shared with 0010). The `metrics` frame is gated by
  `welcome.metrics_interval_ms`. v4 agents send none, and their containers
  show no metrics.
- **Datasets.** The dataset name changes to `roundhouse_metrics` with the
  new layout. The old `roundhouse_metrics` points are not migrated; node
  history restarts once.
- **Configuration.** `CF_ACCOUNT_ID` and `CF_ANALYTICS_TOKEN` are optional.
  Without them the store falls back to D1, with 48 h retention, and Settings
  explains how to add the token.

## Consequences

- Container-level charts, cross-service log search and alerting arrive
  without any new infrastructure beyond the Cloudflare account.
- Log search is a scan, so it is bounded but not instant across days.
  Chunk-level counts make the common `level:error` search fast. Anything
  more (full-text indexes) is future work.
- Polled metric alerts cost one Analytics Engine query per (project,
  metric) per minute: 43k queries per month per project with such rules,
  well inside the planned 1M allowance for small installs. The dashboard
  shows the projection.

## Open questions

- Should a per-chunk bloom filter of tokens, stored in D1, speed up text
  search? It costs write time in the node DO, so measure first.
- Should metrics be downsampled into D1 for retention beyond Analytics
  Engine's 3 months?
- Email Service's documentation is inconsistent about arbitrary
  recipients. Verify on a live account before recommending `cloudflare`
  as the default provider.

## Sources

- Analytics Engine limits (20 blobs, 20 doubles, 1 index ≤ 96 B, 16 KB of blobs, 250 points per invocation, 3-month retention), https://developers.cloudflare.com/analytics/analytics-engine/limits/ (updated 2026-04-23)
- Sampling and `_sample_interval`, https://developers.cloudflare.com/analytics/analytics-engine/sampling/ (updated 2026-04-23)
- SQL API endpoint, auth and columns, https://developers.cloudflare.com/analytics/analytics-engine/sql-api/ (updated 2026-10-02); statements, https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/statements/; aggregate functions, https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/aggregate-functions/; date-time functions, https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/date-time-functions/ (retrieved 2026-10-22)
- Pricing (not yet billed; planned allowances), https://developers.cloudflare.com/analytics/analytics-engine/pricing/ (updated 2026-04-23)
- Querying from a Worker, https://developers.cloudflare.com/analytics/analytics-engine/worker-querying/ (updated 2026-04-23)
- Local dev stubs, https://github.com/cloudflare/workers-sdk/pull/6666 (merged 2024-09-10); no remote binding, https://developers.cloudflare.com/workers/local-development/ (updated 2026-10-22)
- Queues retries, delays and DLQ, https://developers.cloudflare.com/queues/configuration/batching-retries/ and https://developers.cloudflare.com/queues/configuration/dead-letter-queues/ (retrieved 2026-10-22)
- Email Service (public beta 2026-04-16, Paid for arbitrary recipients), https://developers.cloudflare.com/email-service/ (updated 2026-10-15), https://developers.cloudflare.com/email-service/platform/limits/, https://developers.cloudflare.com/email-service/configuration/send-bindings/ (updated 2026-10-15)
