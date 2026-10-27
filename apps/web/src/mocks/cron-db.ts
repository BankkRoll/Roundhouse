/**
 * Cron tables of the mock database (ADR 0010): schedule state per service and
 * environment, runs, and run output. Row shapes are the API's own types.
 *
 * The seed adds a cron service `nightly-report` to the storefront project, deployed in
 * production on `0 3 * * *` in Europe/Berlin, with a week of history: successes, a
 * failure, a missed record, a run no agent could take, and a manual run still going.
 *
 * @module
 */
import { DEFAULT_CRON_CONFIG, nextRuns } from "@roundhouse/shared";
import type { CronRun } from "../lib/api/cron-client";
import type { LogEntry, Service, ServiceConfig } from "../lib/api/deploy-types";
import type { DeployDb } from "./deploy-db";

/** Pause state and last slot of a cron service in one environment. */
export interface DbCronState {
  service_id: string;
  environment_id: string;
  paused: boolean;
  last_scheduled_for: number | null;
}

/** Every cron table. */
export interface CronDb {
  states: DbCronState[];
  runs: CronRun[];
  /** Output by run id, oldest line first. */
  logs: Record<string, LogEntry[]>;
  /** Suffix of the next run id; ids sort by creation like the API's ULIDs. */
  sequence: number;
}

/** Ids of the seeded cron rows, for tests. */
export const CRON_SEED = {
  service: "svc_report",
  slug: "nightly-report",
  deployment: "dep_report_1",
  schedule: "0 3 * * *",
  timezone: "Europe/Berlin",
  succeeded: "crn_s01",
  failed: "crn_s02",
  missed: "crn_s03",
  outdated: "crn_s04",
  lastSucceeded: "crn_s05",
  running: "crn_s06",
} as const;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const P = "env_store_prod";
const PROJECT = "prj_store";

/**
 * Adds the seeded cron service to the Phase 1 tables and builds the cron tables around it.
 *
 * @param deploy - Seeded Phase 1 tables; the service's rows are pushed into them.
 * @param now - Reference time.
 * @returns The cron tables.
 */
export function seedCron(deploy: DeployDb, now = Date.now()): CronDb {
  const service: Service = {
    id: CRON_SEED.service,
    project_id: PROJECT,
    name: CRON_SEED.slug,
    slug: CRON_SEED.slug,
    kind: "cron",
    icon: null,
    created_at: now - 8 * DAY,
    updated_at: now - 8 * DAY,
  };
  const base = deploy.configs.find((row) => row.service_id === "svc_api");
  const source = { type: "image" as const, image: "ghcr.io/acme/report:1.4.0" };
  const config: ServiceConfig = {
    ...(base as ServiceConfig),
    id: "cfg_svc_report_1",
    service_id: service.id,
    environment_id: P,
    version: 1,
    created_by: "usr_ada",
    created_at: service.created_at,
    source,
    deploy: { ...(base as ServiceConfig).deploy, replicas: 1, start_command: "node report.js" },
    healthcheck: null,
    networking: { port: null, generated_domain: false },
    placement: { node_selector: {} },
    cron: {
      ...DEFAULT_CRON_CONFIG,
      schedule: CRON_SEED.schedule,
      timezone: CRON_SEED.timezone,
      retries: 1,
    },
  };
  deploy.services.push(service);
  deploy.configs.push(config);
  const deployedAt = service.created_at + 5 * MINUTE;
  deploy.deployments.push({
    id: CRON_SEED.deployment,
    project_id: PROJECT,
    service_id: service.id,
    environment_id: P,
    config_version: 1,
    build_id: null,
    image: source.image,
    status: "active",
    trigger: "manual",
    triggered_by: "usr_ada",
    rollback_of: null,
    failure_reason: null,
    started_at: deployedAt + 1_000,
    finished_at: deployedAt + 9_000,
    created_at: deployedAt,
    updated_at: deployedAt + 9_000,
  });

  const slots = nextRuns(CRON_SEED.schedule, CRON_SEED.timezone, now - 6 * DAY, 6).filter(
    (slot) => slot < now,
  );
  const slot = (back: number) => slots[slots.length - back] ?? now - back * DAY;
  const run = (id: string, fields: Partial<CronRun> & Pick<CronRun, "status">): CronRun => {
    const scheduledFor = fields.scheduled_for ?? now;
    return {
      id,
      project_id: PROJECT,
      service_id: service.id,
      environment_id: P,
      deployment_id: CRON_SEED.deployment,
      trigger: "schedule",
      scheduled_for: scheduledFor,
      attempt: 1,
      node_id: "node_hel1",
      exit_code: null,
      missed_count: null,
      error: null,
      triggered_by: null,
      started_at: scheduledFor + 2_000,
      finished_at: null,
      created_at: scheduledFor,
      updated_at: scheduledFor,
      ...fields,
    };
  };
  const finished = (scheduledFor: number, seconds: number) => ({
    scheduled_for: scheduledFor,
    finished_at: scheduledFor + 2_000 + seconds * 1000,
    updated_at: scheduledFor + 2_000 + seconds * 1000,
  });
  const missedAt = slot(3);
  const runs = [
    run(CRON_SEED.succeeded, { status: "succeeded", exit_code: 0, ...finished(slot(5), 42) }),
    run(CRON_SEED.failed, { status: "failed", exit_code: 3, ...finished(slot(4), 7) }),
    run(CRON_SEED.missed, {
      status: "missed",
      scheduled_for: missedAt,
      node_id: null,
      started_at: null,
      missed_count: 1,
      error: `1 run missed at ${new Date(missedAt).toISOString()}`,
    }),
    run(CRON_SEED.outdated, {
      status: "failed",
      scheduled_for: slot(2),
      node_id: null,
      started_at: null,
      finished_at: slot(2) + 1_000,
      updated_at: slot(2) + 1_000,
      error: "unschedulable: agent_outdated",
    }),
    run(CRON_SEED.lastSucceeded, { status: "succeeded", exit_code: 0, ...finished(slot(1), 38) }),
    run(CRON_SEED.running, {
      status: "running",
      trigger: "manual",
      triggered_by: "usr_ada",
      scheduled_for: now - 30_000,
      started_at: now - 28_000,
      updated_at: now - 28_000,
    }),
  ];
  const output = (start: number, texts: string[], stream: LogEntry["stream"] = "stdout") =>
    texts.map((text, i) => ({ ts: start + 2_000 + i * 1_000, stream, text }));
  return {
    states: [
      {
        service_id: service.id,
        environment_id: P,
        paused: false,
        last_scheduled_for: slot(1),
      },
    ],
    runs,
    logs: {
      [CRON_SEED.succeeded]: output(slot(5), ["report: 1,204 orders", "report: uploaded"]),
      [CRON_SEED.failed]: [
        ...output(slot(4), ["report: 1,180 orders"]),
        ...output(slot(4) + 1_000, ["error: upload refused (403)"], "stderr"),
      ],
      [CRON_SEED.lastSucceeded]: output(slot(1), ["report: 1,311 orders", "report: uploaded"]),
      [CRON_SEED.running]: output(now - 30_000, ["report: counting orders…"]),
    },
    sequence: 0,
  };
}

/**
 * Empty cron tables, for a fresh install.
 *
 * @returns Tables with no rows.
 */
export function emptyCron(): CronDb {
  return { states: [], runs: [], logs: {}, sequence: 0 };
}
