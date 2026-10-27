/**
 * Service → Settings → Runtime (ADR 0011): whether an app service's replicas run on
 * the instance's servers or on Cloudflare Containers.
 *
 * Choosing Cloudflare shows the eligibility checklist live: the rules that depend on
 * this form and the config (kind, port, resources) are checked here with the shared
 * `cloudflareEligibility`, the rest (volume, TCP proxy, custom domains, image
 * architecture) come from the API. Then the instance type (preselected from the
 * service's resources), the pool size, the idle time before an instance sleeps, and a
 * cost hint. Saving stages `placement.provider` and `placement.cloudflare` as one config
 * change, like every other part of the settings tab. While the service runs on
 * Cloudflare, the section also shows its Worker, instances and routes.
 *
 * @module
 */
import {
  CLOUDFLARE_ELIGIBILITY_RULES,
  CLOUDFLARE_INSTANCE_TYPES,
  type CloudflareEligibilityRule,
  type CloudflareInstanceTypeName,
  type CloudflarePlacement,
  cloudflareEligibility,
  DEFAULT_CLOUDFLARE_SLEEP_AFTER,
  instanceTypeFor,
  MAX_CLOUDFLARE_INSTANCES,
  type PlacementConfig,
  parseSleepAfter,
  type ServiceProvider,
  serviceProvider,
} from "@roundhouse/shared";
import { Badge, SaveBar, Select, SettingsRow, SettingsSection, Skeleton } from "@roundhouse/ui";
import { SegmentedControl } from "@roundhouse/ui/controls";
import { Link } from "@tanstack/react-router";
import { CircleCheckIcon, CircleXIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { SettingsField } from "../../../components/settings-field";
import { errorMessage } from "../../../lib/api/client";
import type { ProviderEligibility, ServiceCloudflare } from "../../../lib/api/cloudflare-client";
import type { Service, ServiceConfig } from "../../../lib/api/deploy-types";
import { formatCpu, formatMemoryMb } from "../../../lib/format";
import { canManageInstance } from "../../../lib/permissions";
import { useServiceCloudflare } from "../../../queries/cloudflare";
import { useMe } from "../../../queries/me";

/** Props for {@link RuntimeSection}. */
export interface RuntimeSectionProps {
  workspaceId: string;
  service: Service;
  config: ServiceConfig;
  environmentId: string;
  canEdit: boolean;
  saving: boolean;
  error: string | undefined;
  /** Stages the placement change (shallow-merged into the saved placement). */
  onSave: (placement: Partial<PlacementConfig>) => void;
}

/** What each eligibility rule checks, as the checklist names it. */
export const ELIGIBILITY_LABELS: Record<CloudflareEligibilityRule, string> = {
  kind: "An app service",
  port: "Listens on an HTTP port",
  volume: "No volume",
  tcp_proxy: "No TCP proxy",
  domains: "Custom domains use Cloudflare for SaaS",
  resources: "Fits an instance type",
  image_arch: "Image has a linux/amd64 variant",
};

/** Rules this form can check itself; the API answers the others. */
const LOCAL_RULES: ReadonlySet<CloudflareEligibilityRule> = new Set(["kind", "port", "resources"]);

/** Billing as Cloudflare documents it for Workers Paid, shown beside the choice. */
export const CLOUDFLARE_COST_HINT =
  "Billed per 10 ms of active time. Workers Paid includes 25 GiB-hours of memory and 375 vCPU-minutes a month.";

function describeType(name: string): string {
  const type = CLOUDFLARE_INSTANCE_TYPES.find((entry) => entry.name === name);
  if (!type) return name;
  return `${type.name} · ${formatCpu(type.cpu_millis)}, ${formatMemoryMb(type.memory_mb)}`;
}

function sleepAfterError(value: string): string | null {
  return parseSleepAfter(value.trim()) === null
    ? "Enter a duration from 1m to 24h, like 90s, 10m or 2h."
    : null;
}

function maxInstancesError(value: string): string | null {
  const number = Number(value);
  return value.trim() === "" ||
    !Number.isInteger(number) ||
    number < 1 ||
    number > MAX_CLOUDFLARE_INSTANCES
    ? `Enter a whole number from 1 to ${MAX_CLOUDFLARE_INSTANCES}.`
    : null;
}

/**
 * Every failed eligibility rule: the local ones computed from the draft, the others as
 * the API reported them.
 *
 * @param service - The service.
 * @param config - Its saved config.
 * @param instanceType - The draft instance type.
 * @param remote - The API's failures, when loaded.
 * @returns Failed rules.
 */
export function eligibilityFailures(
  service: Pick<Service, "kind">,
  config: Pick<ServiceConfig, "networking" | "resources">,
  instanceType: string | undefined,
  remote: readonly ProviderEligibility[],
): ProviderEligibility[] {
  const local = cloudflareEligibility({
    kind: service.kind,
    port: config.networking.port,
    resources: config.resources,
    instanceType,
    hasVolume: false,
    hasTcpProxy: false,
    customDomains: [],
    imageArchitectures: null,
  });
  return [
    ...local.filter((failure) => LOCAL_RULES.has(failure.rule)),
    ...remote.filter((failure) => !LOCAL_RULES.has(failure.rule as CloudflareEligibilityRule)),
  ];
}

function Checklist({
  failures,
  pending,
}: {
  failures: readonly ProviderEligibility[];
  pending: boolean;
}) {
  return (
    <ul aria-label="Cloudflare eligibility" className="grid gap-1.5">
      {CLOUDFLARE_ELIGIBILITY_RULES.map((rule) => {
        const failure = failures.find((entry) => entry.rule === rule);
        const unknown = pending && !LOCAL_RULES.has(rule);
        return (
          <li key={rule} className="flex items-start gap-2 text-sm">
            {failure ? (
              <CircleXIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
            ) : (
              <CircleCheckIcon
                className={`mt-0.5 size-4 shrink-0 ${unknown ? "text-muted-foreground" : "text-success"}`}
                aria-hidden
              />
            )}
            <span className="min-w-0">
              <span className="text-foreground">{ELIGIBILITY_LABELS[rule]}</span>
              <span className="sr-only">
                {failure ? ": fails" : unknown ? ": checking" : ": passes"}
              </span>
              {failure ? (
                <span className="block text-[13px] text-muted-foreground">{failure.message}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function RuntimeStatus({ data }: { data: ServiceCloudflare }) {
  const runtime = data.runtime;
  const latest = data.deployments[0];
  if (!runtime) return null;
  return (
    <>
      <SettingsRow label="Worker" description="The service-environment's runtime Worker script.">
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          <span className="truncate font-mono text-sm text-foreground">{runtime.script_name}</span>
          <Badge tone={runtime.status === "active" ? "success" : "neutral"}>{runtime.status}</Badge>
        </div>
      </SettingsRow>
      <SettingsRow label="Instances" description="Containers awake now, of the pool.">
        <p className="text-sm text-foreground tabular-nums md:text-right">
          {runtime.instances
            ? `${runtime.instances.running} running of ${runtime.instances.total}`
            : "Not reported yet"}
        </p>
      </SettingsRow>
      <SettingsRow label="Routes" description="Hostnames Cloudflare sends to the Worker.">
        {runtime.routes.length ? (
          <ul className="grid gap-0.5 font-mono text-xs text-foreground md:text-right">
            {runtime.routes.map((route) => (
              <li key={route} className="truncate">
                {route}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground md:text-right">None yet</p>
        )}
      </SettingsRow>
      {latest?.status === "failed" && latest.error ? (
        <p role="alert" className="py-3 text-sm text-danger">
          Last rollout failed: <span className="font-mono text-xs">{latest.error}</span>
        </p>
      ) : null}
    </>
  );
}

/**
 * The Runtime section of an app service's settings.
 *
 * @param props - The service, its config, the environment and how to save.
 * @returns The section as its own form.
 */
export function RuntimeSection({
  workspaceId,
  service,
  config,
  environmentId,
  canEdit,
  saving,
  error,
  onSave,
}: RuntimeSectionProps) {
  const placement: PlacementConfig = config.placement;
  const saved = placement.cloudflare;
  const savedProvider = serviceProvider(placement);
  const suggested = instanceTypeFor(config.resources) ?? "standard-4";
  const initial = {
    provider: savedProvider,
    instanceType: saved?.instance_type ?? suggested,
    maxInstances: String(saved?.max_instances ?? 1),
    sleepAfter: saved?.sleep_after ?? DEFAULT_CLOUDFLARE_SLEEP_AFTER,
  };
  const [provider, setProvider] = useState<ServiceProvider>(initial.provider);
  const [instanceType, setInstanceType] = useState<string>(initial.instanceType);
  const [maxInstances, setMaxInstances] = useState(initial.maxInstances);
  const [sleepAfter, setSleepAfter] = useState(initial.sleepAfter);
  const [submitted, setSubmitted] = useState(false);
  const cloudflare = useServiceCloudflare(service.id, environmentId);
  const { data: me } = useMe();
  const typeId = useId();

  const failures = eligibilityFailures(
    service,
    config,
    instanceType,
    cloudflare.data?.eligibility ?? [],
  );
  const configured = cloudflare.data?.configured;
  const errors = {
    maxInstances: maxInstancesError(maxInstances),
    sleepAfter: sleepAfterError(sleepAfter),
  };
  const dirty =
    provider !== initial.provider ||
    (provider === "cloudflare" &&
      (instanceType !== initial.instanceType ||
        maxInstances.trim() !== initial.maxInstances ||
        sleepAfter.trim() !== initial.sleepAfter ||
        !saved));
  const blocker =
    provider !== "cloudflare"
      ? null
      : configured === false
        ? "Cloudflare isn't set up on this instance."
        : failures.length
          ? "Fix the failing checks before switching to Cloudflare."
          : null;

  function reset() {
    setProvider(initial.provider);
    setInstanceType(initial.instanceType);
    setMaxInstances(initial.maxInstances);
    setSleepAfter(initial.sleepAfter);
    setSubmitted(false);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (provider === "nodes") {
      onSave({ provider: "nodes" });
      return;
    }
    if (blocker || errors.maxInstances || errors.sleepAfter) return;
    const next: CloudflarePlacement = {
      ...saved,
      instance_type: instanceType as CloudflareInstanceTypeName,
      max_instances: Number(maxInstances),
      sleep_after: sleepAfter.trim(),
    };
    onSave({ provider: "cloudflare", cloudflare: next });
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Runtime">
      <SettingsSection
        id="runtime"
        title="Runtime"
        description="Where the replicas run: on this instance's servers, or on Cloudflare Containers, which wake on request and sleep when idle."
        className="scroll-mt-20"
      >
        <fieldset disabled={!canEdit} className="min-w-0 divide-y divide-border/70">
          <SettingsRow
            label="Runs on"
            description="Switching moves traffic once the next deploy is healthy."
          >
            <div className="md:flex md:justify-end">
              <SegmentedControl
                label="Runs on"
                value={provider}
                onValueChange={(value) => setProvider(value)}
                options={[
                  { value: "nodes", label: "Nodes" },
                  { value: "cloudflare", label: "Cloudflare" },
                ]}
              />
            </div>
          </SettingsRow>
          {provider === "cloudflare" ? (
            <>
              {configured === false ? (
                <p role="status" className="py-3 text-sm text-warning">
                  Cloudflare isn't set up on this instance.{" "}
                  {canManageInstance(me) ? (
                    <Link
                      to="/w/$workspaceId/cloudflare"
                      params={{ workspaceId }}
                      className="text-accent-text underline-offset-4 outline-none hover:underline focus-visible:underline"
                    >
                      Connect an account in Settings → Cloudflare
                    </Link>
                  ) : (
                    "Ask an instance admin to connect a Cloudflare account."
                  )}
                </p>
              ) : null}
              <SettingsRow
                label="Eligibility"
                description="Cloudflare Containers serve HTTP only and have ephemeral disks."
                control="wide"
              >
                {cloudflare.isError ? (
                  <p className="text-sm text-danger">{errorMessage(cloudflare.error)}</p>
                ) : null}
                <Checklist failures={failures} pending={cloudflare.isPending} />
                {cloudflare.data?.warnings.length ? (
                  <ul aria-label="Cloudflare warnings" className="mt-3 grid gap-1 text-[13px]">
                    {cloudflare.data.warnings.map((warning) => (
                      <li key={warning} className="text-warning">
                        {warning}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </SettingsRow>
              <SettingsRow
                label="Instance type"
                description={`Preselected from the service's resources (${formatCpu(config.resources.cpu_millis)}, ${formatMemoryMb(config.resources.memory_mb)}).`}
                htmlFor={typeId}
              >
                <Select
                  id={typeId}
                  value={instanceType}
                  aria-describedby={`${typeId}-description`}
                  onChange={(event) => setInstanceType(event.target.value)}
                >
                  {CLOUDFLARE_INSTANCE_TYPES.map((type) => (
                    <option key={type.name} value={type.name}>
                      {describeType(type.name)}
                      {type.name === suggested ? " (fits)" : ""}
                    </option>
                  ))}
                </Select>
              </SettingsRow>
              <SettingsField
                label="Max instances"
                description="The pool requests are spread over; each wakes on demand."
                value={maxInstances}
                inputMode="numeric"
                onChange={(event) => setMaxInstances(event.target.value)}
                error={errors.maxInstances}
                inputClassName="w-32 tabular-nums"
              />
              <SettingsField
                label="Sleep after"
                description="Idle time before an instance sleeps. The next request wakes it, with a cold start."
                value={sleepAfter}
                onChange={(event) => setSleepAfter(event.target.value)}
                error={errors.sleepAfter}
                inputClassName="w-32 font-mono"
                spellCheck={false}
              />
              <SettingsRow label="Cost" description={CLOUDFLARE_COST_HINT} />
            </>
          ) : null}
          {savedProvider === "cloudflare" && cloudflare.isPending ? (
            <Skeleton className="my-3 h-16 rounded-md" />
          ) : savedProvider === "cloudflare" && cloudflare.data ? (
            <RuntimeStatus data={cloudflare.data} />
          ) : null}
        </fieldset>
      </SettingsSection>
      {submitted && blocker ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {blocker}
        </p>
      ) : error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {canEdit ? <SaveBar dirty={dirty} saving={saving} onDiscard={reset} /> : null}
    </form>
  );
}
