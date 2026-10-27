# 0010: Cron jobs

## Status

Accepted; implemented with the changes listed under "Implementation notes".
- Date: 2026-10-22
- Phase: 3
- Protocol: version 5
- Depends on: 0003 (pipeline, logs), 0004 ("Scheduled dispatch"), 0005
  (scheduler). Feeds 0008 (alert rules `cron_failed`, `cron_missed`).

Names follow the Roundhouse rename (0013, "Naming").

## Context

`SERVICE_KINDS` lists `cron`, but a cron service runs like an app today: a
long-lived container that is restarted when it exits. Users need scheduled
one-off containers: run the service's image at a schedule, with its
variables, to completion. They also need history, logs, timeouts and a
clear rule for runs that could not happen. `DeployConfig.pre_deploy_command`
needs the same mechanism (a one-off container before the rollout) and is
not implemented yet.

Cloudflare Cron Triggers fire at minute granularity, in UTC, through one
`scheduled()` handler. Their delivery guarantees (delay, duplicates,
missed runs) are not documented. 0004's dispatch tick is built to
tolerate that: a slot is a row claim, not the tick itself.

## Decision

### Service model

A `kind: "cron"` service is built and deployed like any other. Its
deployment ends `active` **without placing replicas**: it is the _armed_
deployment whose image digest, config version and sealed environment
every run uses. Deploying a new version re-arms it. A run already in
progress keeps its own deployment.

The deploy workflow branches after `resolve-variables` and the build. For
cron services it skips `schedule`, `rollout` and the health wait, and
`finalize` supersedes the previous armed deployment
(`active` → `removed`).

Config gains a part, stored as a new nullable JSON column
`service_configs.cron`:

```ts
interface CronConfig {
  /** 5-field cron or a macro; see "Schedule syntax". */
  schedule: string;
  /** IANA zone the schedule is read in. */
  timezone: string; // default "UTC"
  concurrency: "forbid" | "replace" | "allow"; // default "forbid"
  /** Hard limit per run; the agent kills the container after it. */
  timeout_s: number; // 10..86400, default 3600
  /** How late a run may still start after its slot; later slots are recorded as missed. */
  starting_deadline_s: number; // 0..3600, default 300
  retries: number; // 0..5, default 0
  retry_backoff_s: number; // 10..3600, default 60, doubled per attempt
  /** Runs kept in history per (service, environment). */
  history_limit: number; // 10..1000, default 100
}
```

For `kind: "cron"`:
- `cron` is required, and `deploy.replicas`, `healthcheck`, `networking.port`
  and `generated_domain` are ignored. The API rejects domains and TCP
  proxies with `422 cron_has_no_endpoint`.
- `deploy.start_command` overrides the image command per run, as it does
  for apps.
- `resources` are the per-run limits.

The 0006 op `config.patch` covers `cron`, so schedules are staged and
reviewed like everything else.

### Schedule syntax

`packages/shared/src/cron.ts` exports a pure, dependency-free parser plus
`nextRuns(schedule, timezone, from, count)`. It is the only implementation;
the agent never parses schedules.
- **Fields.** Five, in this order:
  - minute 0–59
  - hour 0–23
  - day of month 1–31
  - month 1–12 or `JAN`–`DEC`
  - day of week 0–7 (0 and 7 are Sunday) or `SUN`–`SAT`
- **Forms.** `*`, a value, `a-b`, `a-b/n`, `*/n`, and comma lists of these.
  Names are case-insensitive.
- **Macros.** `@yearly`/`@annually` (`0 0 1 1 *`), `@monthly`
  (`0 0 1 * *`), `@weekly` (`0 0 * * 0`), `@daily`/`@midnight`
  (`0 0 * * *`), `@hourly` (`0 * * * *`).
- **Day matching.** When both day of month and day of week are restricted
  (neither is `*`), a day matches if **either** matches. This is Vixie
  cron's rule and what users expect from `crontab`.
- **Not supported**, rejected with `422 invalid_schedule` and a position:
  seconds, `?`, `L`, `W`, `#`, `@reboot`, and step values larger than the
  field range.
- **Resolution.** Schedules have one-minute resolution.
  `ScheduleError { code, message, start, end }` mirrors the variable
  parser's errors.
- **Time zones and DST.** Matching is done in the wall-clock time of
  `timezone`, using `Intl.DateTimeFormat` offsets.
  - A wall time skipped by a spring-forward gap runs once, at the first
    instant after the gap.
  - A wall time repeated by a fall-back change runs once, at its first
    occurrence.
  - An unknown zone is a 422.

### Run state

```sql
CREATE TABLE cron_states (
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  paused INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER,                  -- null while paused or with no armed deployment
  last_scheduled_for INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (service_id, environment_id)
);
CREATE INDEX cron_states_next_idx ON cron_states(next_run_at) WHERE next_run_at IS NOT NULL;

CREATE TABLE cron_runs (
  id TEXT PRIMARY KEY,                                  -- crn_…
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
  trigger TEXT NOT NULL,          -- schedule | manual | retry | pre_deploy
  scheduled_for INTEGER NOT NULL, -- slot time (manual: request time)
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,           -- queued | starting | running | succeeded | failed | timed_out
                                  -- | cancelled | skipped | missed | lost
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  workload_id TEXT,               -- wl_… of the job container
  exit_code INTEGER,
  missed_count INTEGER,           -- for status = missed: slots covered by this record
  error TEXT,
  workflow_instance_id TEXT,
  started_at INTEGER, finished_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX cron_runs_slot_uq ON cron_runs(service_id, environment_id, scheduled_for, attempt)
  WHERE trigger IN ('schedule', 'retry');
CREATE INDEX cron_runs_svc_env_id_idx ON cron_runs(service_id, environment_id, id);
ALTER TABLE log_chunks ADD COLUMN cron_run_id TEXT REFERENCES cron_runs(id) ON DELETE CASCADE;
```

`cron_states.next_run_at` is recomputed with `nextRuns(…, now, 1)`
whenever an armed deployment appears, the schedule or zone changes, or
the state is resumed. Arming does not trigger a run.

### Dispatch and missed runs

The 0004 minute tick has a `cron` claimer. For each `cron_states` row with
`next_run_at <= now` (at most 100 per tick), it:
1. Lists the slots between `next_run_at` and `now` with
   `nextRuns(…, last_scheduled_for, k)`, capped at 1,000.
2. Splits them: the **latest** slot runs if
   `now - slot <= starting_deadline_s`. Every older slot, and the latest
   too when it is past its deadline, is **missed**.
3. Claims the row:
   `UPDATE cron_states SET next_run_at = :next, last_scheduled_for = :latest WHERE … AND next_run_at = :seen`.
   `:next` is the first slot after `now`. Losing the race to another tick
   means doing nothing.
4. In one batch, inserts at most one `missed` run (`missed_count = n`,
   `error = "<n> runs missed between <first> and <last>"`,
   `scheduled_for = first missed slot`) and at most one `queued` run.
   Then it enqueues `{ kind: "cron", id: crn_… }` on `JOBS`.

The rules that follow:
- At most **one catch-up run** happens, however long the control plane or
  the cron trigger was down. Older slots are recorded once, never run.
- Pausing stops everything: no runs, and no missed records while paused.
  Resuming starts at the next future slot.
- Deploying or editing never triggers a run.

### Runner

The `JOBS` consumer starts `CRON_RUN_WORKFLOW` with the run ID as instance
ID.
1. **Concurrency.** Look for a run of the same (service, environment) in
   `starting` or `running`.
   - `forbid`: mark this run `skipped` with
     `error = "previous run crn_… still running"`.
   - `replace`: send `job_cancel` to the running one, wait up to 30 s for
     its `cancelled` status, then continue.
   - `allow`: continue.
2. **Place.** Call `schedule()` with `replicas: 1`, the run's resources,
   `minProtocolVersion: 5` and `requiresRegistry` for git images.
   Running jobs count as allocated on their node: the scheduler snapshot
   adds the resources of every `starting`/`running` run. No node means
   `failed` with `error = "unschedulable: <reason>"`, which then follows
   the retry rules.
3. **Start.** Send `job_run` with a fresh `wl_` workload ID, the armed
   deployment's image and its resolved environment (unsealed from
   `deployments.env_sealed`). Mark the run `starting`.
4. **Wait.** Wait for the `job` event, which the node DO emits on terminal
   `job_status`, until `timeout_s + 300 s`. Without a terminal status, the
   run is `lost` (the node vanished). `lost` counts as a failure for
   retries.
5. **Retry.** On `failed`, `timed_out` or `lost` with
   `attempt <= retries`, insert run `attempt + 1` (`trigger: retry`, same
   `scheduled_for`), sleep `retry_backoff_s × 2^(attempt−1)` with
   `step.sleep`, and enqueue it. `cancelled` and `skipped` are never
   retried.
6. **Trim history.** Delete runs beyond `history_limit`, oldest first;
   their logs go with them through the FK cascade and log retention.

`POST …/cron-runs` (run now) inserts a `manual` run and enqueues it. Run
now ignores `forbid`. A run already in progress is reported back as
`409 run_in_progress` unless `force: true`, which applies `replace`.

`pre_deploy_command` (DeployConfig) uses the same runner. The deploy
workflow inserts a `cron_runs` row with `trigger: pre_deploy` before
`schedule`, waits for it, and fails the deployment with
`pre_deploy_failed` unless it succeeds. That also gives migrations
history and logs. This works for every service kind.

### Protocol (version 5)

Control → agent, signed:

```ts
{ type: "job_run"; ...ControlHeader;
  run_id: IdString;
  workload: WorkloadSpec;      // kind "job" (new WORKLOAD_KINDS value), routes [], ports [],
                               // healthcheck null, restart { policy: "never", max_retries: 0 }, mounts absent
  timeout_s: number;           // 10..86400
  kill_grace_s: number;        // 1..120, default 10
}                              // credential frame when workload.registry_auth is set
{ type: "job_cancel"; ...ControlHeader; run_id: IdString; reason: string }
```

Agent → control:

```ts
{ type: "job_status"; run_id: IdString; workload_id: IdString;
  state: "pulling" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";
  exit_code?: number; started_at?: number; finished_at?: number; message?: string }
```

`LogSource` gains `{ type: "job"; run_id: IdString; workload_id: IdString }`.
The node DO stores job logs like runtime logs, with `log_chunks.cron_run_id`,
and forwards them to `ProjectRoom` under the topic
`{ kind: "cron_run_logs", run_id }`.

The agent runs jobs in `internal/jobs`, separate from the reconciler:
- **Containers.** Job containers carry `roundhouse.kind=job`,
  `roundhouse.run_id` and the namespace label. The reconciler's garbage
  collection skips them, because `desired_state` is a complete list of
  service workloads and jobs are not in it.
- **Hardening and start.** Jobs get the same hardening as service
  workloads, plus `AutoRemove: false`. The agent pulls the image, creates
  the container, starts it, and follows its logs.
- **Timeout.** At `timeout_s`, the agent sends SIGTERM, waits
  `kill_grace_s`, then sends SIGKILL, and reports `timed_out`.
- **Cancel.** `job_cancel` follows the same sequence and reports
  `cancelled`.
- **Restarts.** Runs in flight are persisted in `<data-dir>/jobs.json`
  (run ID, container ID, deadline). After an agent restart, the agent
  re-attaches, enforces the original deadline, and reports the outcome.
  A container that finished while the agent was down is reported from its
  exit code.
- **Cleanup.** The container is removed once its logs are flushed and the
  terminal status is acknowledged by the next heartbeat. At most
  `jobs.max_concurrent` (agent config, default 8) jobs run at once; more
  are answered with `failed`, message `node_busy`, which the scheduler's
  allocation accounting should make rare.

`job_run` is never sent to an agent below `JOBS_PROTOCOL_VERSION = 5`.

### Routes, RBAC, audit

| Method and path                                                      | RBAC                 | Audit                |
| -------------------------------------------------------------------- | -------------------- | -------------------- |
| `GET /v1/cron/preview?schedule=&timezone=&count=`                    | `projects:read`      | none                 |
| `GET /v1/services/{serviceId}/cron-runs?environment_id=&cursor=`     | `services:read`      | none                 |
| `GET /v1/cron-runs/{runId}`                                          | `services:read`      | none                 |
| `GET /v1/cron-runs/{runId}/logs`                                     | `services:read`      | none                 |
| `POST /v1/services/{serviceId}/cron-runs` `{environment_id, force?}` | `deployments:create` | `cron.run_triggered` |
| `POST /v1/cron-runs/{runId}/cancel`                                  | `deployments:create` | `cron.run_cancelled` |
| `POST /v1/services/{serviceId}/cron/pause` `{environment_id}`        | `services:manage`    | `cron.paused`        |
| `POST /v1/services/{serviceId}/cron/resume` `{environment_id}`       | `services:manage`    | `cron.resumed`       |

`GET /v1/cron/preview` returns the next `count` (≤ 10) run instants, or a
`ScheduleError`. The dashboard calls it while the user types.

Realtime: `ProjectRoom` gains `cron_run.updated { run: CronRun }`, sent to
every socket of the project.

New ID prefix: `crn`. `DEPLOYMENT_EVENT_TYPES` gains `pre_deploy_started`
and `pre_deploy_finished`.

### Dashboard

- **Create.** New service → Cron job: source, schedule field with live
  "At 03:00, every day (Europe/Berlin) · next: Thu 23 Oct 03:00", timezone
  picker, and a timeout.
- **Canvas.** A cron node shows a clock icon, the next run, and the last
  run's status.
- **Service → Runs tab.** A table of runs (status chip, trigger, slot
  time, start, duration, exit code, node). `missed` rows read "12 runs
  missed (control plane unavailable 09:02–09:13)". A row opens the logs
  drawer, live while running.
- **Actions.** Run now, Cancel, Pause / Resume.

## Security

- Runs use the armed deployment's sealed environment and the same
  container hardening as services. A job is no more privileged than its
  service.
- `job_run` is signed and, when it carries registry credentials, expires
  within 60 s. `job_cancel` is signed and addressed to one run.
- Run now and Cancel need `deployments:create`, the same as deploying the
  code. Schedule changes go through staged changes (0006) and their RBAC.
- Schedules cannot run more often than once a minute, so per-service load
  is bounded. Concurrency `allow` with a long timeout is the operator's
  explicit choice. The dashboard warns when `timeout_s` exceeds the
  interval under `allow`.

## Testing strategy

- **Unit (TS).** The parser and `nextRuns` over a shared vector file
  `packages/shared/test/cron-vectors.json`:
  - every field form, names, macros, and day-of-month OR day-of-week;
  - DST in `America/New_York`, `Europe/London` and `Australia/Lord_Howe`
    (30-minute DST);
  - 29 February;
  - invalid input with positions.

  The dispatch claimer is tested with a fake clock: one catch-up run,
  `missed_count`, the paused state, and a lost claim race.
- **API** (vitest-pool-workers): every concurrency mode, retries with
  backoff (fake step clock), `lost` after the deadline, history trimming,
  and run now with and without `force`.
- **Agent integration.** A job exits 0 → `succeeded`; exit 3 →
  `failed (3)`; `sleep 600` with `timeout_s: 5` → `timed_out` within
  `5 + kill_grace_s`; a cancel; and an agent restart mid-run, which
  re-attaches and reports the outcome.
- **Real-stack e2e** (`e2e/phase3/cron.test.mjs`). `wrangler dev` runs
  with `--test-scheduled`, and the harness fires the scheduled handler
  over HTTP every 15 s, so minutes pass quickly. The control plane takes a
  `DISPATCH_NOW_OFFSET_MS` test variable that advances its clock.
  1. A busybox cron `*/1 * * * *` printing `$GREETING`: two `succeeded`
     runs with the variable in their logs.
  2. `sleep 120` with `timeout_s: 10` → `timed_out`. With `forbid`, the
     next slot is `skipped` while it runs.
  3. Stop `wrangler dev` for 5 simulated minutes, then start it: exactly
     one `missed` record with `missed_count` ≥ 3, then one catch-up run.
  4. Run now while a run is in progress → 409; with `force` → the old run
     is `cancelled` and the new one runs.
  5. `pre_deploy_command: "node migrate.js"` failing → deployment `failed`
     with reason `pre_deploy_failed`, and the previous deployment still
     serving.

## Rollout and compat

- **Protocol 5.** `PROTOCOL_VERSION = 5`, `MIN_PROTOCOL_VERSION = 4`.
  `JOBS_PROTOCOL_VERSION = 5`. Until a node runs a v5 agent, cron runs
  fail with `unschedulable: agent_outdated`, which the dashboard explains.
- **Existing cron services.** Existing `kind: "cron"` services, which run
  as long-lived containers today, keep their config without `cron`. On
  their first deploy after the upgrade, the API requires a schedule
  (`422 cron_schedule_required`), and the dashboard shows a banner on such
  services.
- **Migration.** Additive: two tables and two columns.

## Consequences

- Cron jobs and pre-deploy commands share one runner, one history model
  and one log path.
- Runs depend on the control plane: if it is down, runs don't happen, and
  they are recorded as missed when it returns. Running a scheduler on the
  nodes would avoid that, at the cost of a second source of truth and of
  duplicate runs after partitions. That trade is not made.

## Implementation notes

Where the implementation differs from the text above:
- **Protocol.** Jobs ship in protocol 6 (`JOBS_PROTOCOL_VERSION = 6`, ADR
  0015), and `job_run` is always a credential frame because its environment
  is a sealed `job-env` box bound to the node, run and workload (ADR 0014).
- **No `JOBS` queue.** The claimer and run now start `CronRunWorkflow`
  directly. The run ID is the instance ID, so a repeated start is a no-op,
  and a later tick re-starts `queued` runs whose start failed. Scheduled and
  retry runs get IDs derived from their slot and attempt, so overlapping
  ticks collapse into one run as well as one row.
- **Routes.** The preview is `GET /v1/projects/{projectId}/cron/preview`, so
  `projects:read` has a project to check. `GET /v1/services/{serviceId}/cron`
  returns the schedule state (paused, next slot, armed deployment) that the
  dashboard and CLI show.
- **Pre-deploy runs** take the service's `cron.timeout_s`, or 3,600 s when
  it has no cron part, never retry, and ignore the concurrency policy. The
  deployment's events `pre_deploy_started` and `pre_deploy_finished` carry
  the run ID; cancelling the deployment cancels its run.
- **Endpoints.** A cron service gets no generated domain, and adding a
  custom one is `422 cron_has_no_endpoint`.

## Open questions

- Should the runner prefer the node that ran the previous run, for warm
  image caches? The scheduler is deterministic, so it usually does
  already.
- Should runs be retained by age as well as by count?

## Sources

- Cron Triggers: one-minute schedules, UTC, `controller.cron`, account limits, https://developers.cloudflare.com/workers/configuration/cron-triggers/ (updated 2026-10-17); `scheduled()` handler, https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ (retrieved 2026-10-22)
- Workers limits (cron CPU time on Paid: 30 s for intervals under 1 h), https://developers.cloudflare.com/workers/platform/limits/ (updated 2026-10-12)
- Workflows `step.sleep`/`waitForEvent` and limits, https://developers.cloudflare.com/workflows/build/events-and-parameters/ and https://developers.cloudflare.com/workflows/reference/limits/ (updated 2026-09-21)
- Queues batching and retries, https://developers.cloudflare.com/queues/configuration/batching-retries/ (retrieved 2026-10-22)
- Vixie cron day-of-month/day-of-week OR semantics, crontab(5), https://man7.org/linux/man-pages/man5/crontab.5.html (retrieved 2026-10-22)
