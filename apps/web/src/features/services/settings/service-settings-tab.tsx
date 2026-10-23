import {
  Button,
  DangerZone,
  Input,
  SaveBar,
  Select,
  SettingsLayout,
  SettingsNav,
  SettingsNavGroup,
  SettingsNavItem,
  SettingsRow,
  SettingsSection,
  SettingsStack,
  Skeleton,
  toast,
} from "@roundhouse/ui";
import { Slider, Switch } from "@roundhouse/ui/controls";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { RocketIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { ErrorState } from "../../../components/error-state";
import { FormField } from "../../../components/form-field";
import { SettingsField } from "../../../components/settings-field";
import { errorMessage, isApiError } from "../../../lib/api/client";
import type {
  HealthcheckConfig,
  Service,
  ServiceConfig,
  UpdateServiceBody,
} from "../../../lib/api/deploy-types";
import { formatCpu, formatMemoryMb, formatRelativeTime } from "../../../lib/format";
import { usePermissions } from "../../../lib/permissions";
import { useDeploy } from "../../../queries/deployments";
import { latestDeploymentQueryOptions } from "../../../queries/projects";
import {
  forgetService,
  useDeleteService,
  useServiceConfig,
  useUpdateService,
} from "../../../queries/services";
import {
  branchError,
  gitUrlError,
  imageReferenceError,
  parsePort,
  rootDirError,
} from "../../projects/new-service/source";
import { findService, useProjectEnvironment } from "../../projects/use-project-environment";
import type { ServicePageProps } from "../service-layout";
import { fromPairs, KeyValueEditor, type KeyValuePair, toPairs } from "./key-value-editor";

/** Slider bounds: the API accepts more, but these cover real services with useful steps. */
export const CPU_SLIDER = { min: 100, max: 8000, step: 100 } as const;
/** Memory slider bounds in MiB. */
export const MEMORY_SLIDER = { min: 64, max: 16_384, step: 64 } as const;

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LABEL_KEY = /^[A-Za-z0-9]([A-Za-z0-9._/-]*[A-Za-z0-9])?$/;

type Part = Exclude<
  keyof UpdateServiceBody,
  "environment_id" | "expected_version" | "name" | "slug" | "icon"
>;

interface SaveContext {
  canEdit: boolean;
  saving: Part | null;
  errors: Partial<Record<Part, string>>;
  save: (part: Part, value: UpdateServiceBody[Part]) => void;
}

/** The page's sections in order, for the jump list and the anchors. */
const SECTIONS = [
  { id: "general", label: "General" },
  { id: "source", label: "Source" },
  { id: "build", label: "Build" },
  { id: "deploy", label: "Deploy" },
  { id: "resources", label: "Resources" },
  { id: "healthcheck", label: "Healthcheck" },
  { id: "networking", label: "Networking" },
  { id: "placement", label: "Placement" },
] as const;

/**
 * One part of the config as its own form: the rows, any save error, and a save bar that
 * saves only this part as a new version.
 */
function Section({
  id,
  title,
  description,
  dirty,
  part,
  context,
  onSubmit,
  onReset,
  children,
}: {
  id: string;
  title: string;
  description: ReactNode;
  dirty: boolean;
  part: Part;
  context: SaveContext;
  onSubmit: () => void;
  onReset: () => void;
  children: ReactNode;
}) {
  const error = context.errors[part];
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
  }
  return (
    <form onSubmit={submit} noValidate aria-label={title}>
      <SettingsSection id={id} title={title} description={description} className="scroll-mt-20">
        <fieldset disabled={!context.canEdit} className="min-w-0 divide-y divide-border/70">
          {children}
        </fieldset>
      </SettingsSection>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {context.canEdit ? (
        <SaveBar dirty={dirty} saving={context.saving === part} onDiscard={onReset} />
      ) : null}
    </form>
  );
}

/** A select as a settings row. */
function SelectRow({
  label,
  description,
  value,
  onChange,
  children,
}: {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <SettingsRow label={label} description={description} htmlFor={id}>
      <Select
        id={id}
        value={value}
        aria-describedby={description ? `${id}-description` : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </Select>
    </SettingsRow>
  );
}

function numberError(value: string, min: number, max: number): string | null {
  const number = Number(value);
  return value.trim() === "" || !Number.isInteger(number) || number < min || number > max
    ? `Enter a whole number from ${min} to ${max}.`
    : null;
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  description,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  description?: string;
  suffix?: string;
}) {
  return (
    <SettingsField
      label={suffix ? `${label} (${suffix})` : label}
      description={description}
      value={value}
      inputMode="numeric"
      onChange={(event) => onChange(event.target.value)}
      error={numberError(value, min, max)}
      inputClassName="w-32 tabular-nums"
    />
  );
}

const isWhole = (value: string, min: number, max: number) => numberError(value, min, max) === null;

// -----------------------------------------------------------------------------
// Sections
// -----------------------------------------------------------------------------

function SourceSection({ config, context }: { config: ServiceConfig; context: SaveContext }) {
  const source = config.source;
  const [kind, setKind] = useState(source.type);
  const [image, setImage] = useState(source.type === "image" ? source.image : "");
  const [repoUrl, setRepoUrl] = useState(source.type === "git" ? source.repo_url : "");
  const [branch, setBranch] = useState(source.type === "git" ? source.branch : "main");
  const [rootDir, setRootDir] = useState(source.type === "git" ? source.root_dir : ".");
  const [submitted, setSubmitted] = useState(false);
  const errors =
    kind === "image"
      ? { image: imageReferenceError(image) }
      : {
          repoUrl: gitUrlError(repoUrl),
          branch: branchError(branch),
          rootDir: rootDirError(rootDir),
        };
  const next =
    kind === "image"
      ? { type: "image" as const, image: image.trim() }
      : {
          type: "git" as const,
          repo_url: repoUrl.trim(),
          branch: branch.trim(),
          root_dir: rootDir.trim(),
          ...(source.type === "git" &&
          source.github_installation_id &&
          source.repo_url === repoUrl.trim()
            ? { github_installation_id: source.github_installation_id }
            : {}),
        };
  const dirty = JSON.stringify(next) !== JSON.stringify(source);
  const show = (message: string | null) => (submitted ? message : null);

  return (
    <Section
      id="source"
      title="Source"
      description="Where the code comes from. Git sources deploy on every push to the branch."
      dirty={dirty}
      part="source"
      context={context}
      onReset={() => {
        setKind(source.type);
        setImage(source.type === "image" ? source.image : "");
        setRepoUrl(source.type === "git" ? source.repo_url : "");
        setBranch(source.type === "git" ? source.branch : "main");
        setRootDir(source.type === "git" ? source.root_dir : ".");
        setSubmitted(false);
      }}
      onSubmit={() => {
        setSubmitted(true);
        if (Object.values(errors).some(Boolean)) return;
        context.save("source", next);
      }}
    >
      <SelectRow label="Type" value={kind} onChange={(value) => setKind(value as typeof kind)}>
        <option value="image">Docker image</option>
        <option value="git">Git repository</option>
      </SelectRow>
      {kind === "image" ? (
        <SettingsField
          label="Image"
          description="A registry reference, e.g. ghcr.io/owner/app:tag."
          value={image}
          onChange={(event) => setImage(event.target.value)}
          error={show(errors.image ?? null)}
          inputClassName="font-mono"
          spellCheck={false}
        />
      ) : (
        <>
          <SettingsField
            label="Repository URL"
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            error={show((errors as { repoUrl: string | null }).repoUrl)}
            inputClassName="font-mono"
            spellCheck={false}
          />
          <SettingsField
            label="Branch"
            description="Pushes to this branch deploy."
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            error={show((errors as { branch: string | null }).branch)}
            inputClassName="font-mono"
            spellCheck={false}
          />
          <SettingsField
            label="Root directory"
            description="Where the app lives in a monorepo."
            value={rootDir}
            onChange={(event) => setRootDir(event.target.value)}
            error={show((errors as { rootDir: string | null }).rootDir)}
            inputClassName="font-mono"
            spellCheck={false}
          />
        </>
      )}
    </Section>
  );
}

function BuildSection({ config, context }: { config: ServiceConfig; context: SaveContext }) {
  const build = config.build;
  const [builder, setBuilder] = useState(build.builder);
  const [dockerfile, setDockerfile] = useState(build.dockerfile_path ?? "");
  const [args, setArgs] = useState<KeyValuePair[]>(toPairs(build.build_args));
  const argErrors = Object.fromEntries(
    args.flatMap((pair, index) =>
      pair.key && !VAR_NAME.test(pair.key) ? [[index, "Use letters, digits and _."]] : [],
    ),
  );
  const next = {
    builder,
    ...(builder === "dockerfile" && dockerfile.trim()
      ? { dockerfile_path: dockerfile.trim() }
      : {}),
    build_args: fromPairs(args),
  };
  const current = {
    builder: build.builder,
    ...(build.dockerfile_path ? { dockerfile_path: build.dockerfile_path } : {}),
    build_args: build.build_args,
  };
  const dirty = JSON.stringify(next) !== JSON.stringify(current);
  const isGit = config.source.type === "git";

  return (
    <Section
      id="build"
      title="Build"
      description={
        isGit
          ? "Railpack detects the language and builds without a Dockerfile; choose Dockerfile to use your own."
          : "Image sources run as-is. These settings apply if you switch to a git source."
      }
      dirty={dirty}
      part="build"
      context={context}
      onReset={() => {
        setBuilder(build.builder);
        setDockerfile(build.dockerfile_path ?? "");
        setArgs(toPairs(build.build_args));
      }}
      onSubmit={() => {
        if (Object.keys(argErrors).length > 0) return;
        context.save("build", {
          builder,
          dockerfile_path:
            builder === "dockerfile" && dockerfile.trim() ? dockerfile.trim() : undefined,
          build_args: fromPairs(args),
        });
      }}
    >
      <SelectRow
        label="Builder"
        value={builder}
        onChange={(value) => setBuilder(value as typeof builder)}
      >
        <option value="railpack">Railpack (automatic)</option>
        <option value="dockerfile">Dockerfile</option>
      </SelectRow>
      {builder === "dockerfile" ? (
        <SettingsField
          label="Dockerfile path"
          description="Relative to the root directory."
          value={dockerfile}
          onChange={(event) => setDockerfile(event.target.value)}
          placeholder="Dockerfile"
          inputClassName="font-mono"
          spellCheck={false}
        />
      ) : null}
      <SettingsRow
        label="Build arguments"
        description="Passed to the build as --build-arg. Not available at runtime; use variables for that."
        control="wide"
      >
        <KeyValueEditor
          label="Build arguments"
          hideLegend
          pairs={args}
          onChange={setArgs}
          keyPlaceholder="NODE_VERSION"
          valuePlaceholder="22"
          errors={argErrors}
        />
      </SettingsRow>
    </Section>
  );
}

function DeploySection({ config, context }: { config: ServiceConfig; context: SaveContext }) {
  const deploy = config.deploy;
  const [start, setStart] = useState(deploy.start_command ?? "");
  const [preDeploy, setPreDeploy] = useState(deploy.pre_deploy_command ?? "");
  const [replicas, setReplicas] = useState(String(deploy.replicas));
  const [policy, setPolicy] = useState(deploy.restart_policy);
  const [retries, setRetries] = useState(String(deploy.max_retries));
  const [drain, setDrain] = useState(String(deploy.drain_s));
  const valid = isWhole(replicas, 0, 20) && isWhole(retries, 0, 100) && isWhole(drain, 0, 3600);
  const dirty =
    start !== (deploy.start_command ?? "") ||
    preDeploy !== (deploy.pre_deploy_command ?? "") ||
    replicas !== String(deploy.replicas) ||
    policy !== deploy.restart_policy ||
    retries !== String(deploy.max_retries) ||
    drain !== String(deploy.drain_s);

  return (
    <Section
      id="deploy"
      title="Deploy"
      description="How the service runs once built. Replicas spread across servers when they can."
      dirty={dirty}
      part="deploy"
      context={context}
      onReset={() => {
        setStart(deploy.start_command ?? "");
        setPreDeploy(deploy.pre_deploy_command ?? "");
        setReplicas(String(deploy.replicas));
        setPolicy(deploy.restart_policy);
        setRetries(String(deploy.max_retries));
        setDrain(String(deploy.drain_s));
      }}
      onSubmit={() => {
        if (!valid) return;
        context.save("deploy", {
          start_command: start.trim() || undefined,
          pre_deploy_command: preDeploy.trim() || undefined,
          replicas: Number(replicas),
          restart_policy: policy,
          max_retries: Number(retries),
          drain_s: Number(drain),
        });
      }}
    >
      <SettingsField
        label="Start command"
        description="Overrides the image's command."
        value={start}
        onChange={(event) => setStart(event.target.value)}
        placeholder="Image default"
        inputClassName="font-mono"
        spellCheck={false}
      />
      <SettingsField
        label="Pre-deploy command"
        description="Runs once before the rollout."
        value={preDeploy}
        onChange={(event) => setPreDeploy(event.target.value)}
        placeholder="e.g. npm run migrate"
        inputClassName="font-mono"
        spellCheck={false}
      />
      <NumberField
        label="Replicas"
        description="0 stops the service."
        value={replicas}
        onChange={setReplicas}
        min={0}
        max={20}
      />
      <SelectRow
        label="Restart policy"
        description="When a crashed replica is started again."
        value={policy}
        onChange={(value) => setPolicy(value as typeof policy)}
      >
        <option value="on_failure">On failure</option>
        <option value="always">Always</option>
        <option value="never">Never</option>
      </SelectRow>
      <NumberField
        label="Max retries"
        description="Restarts before the replica is marked crashed."
        value={retries}
        onChange={setRetries}
        min={0}
        max={100}
      />
      <NumberField
        label="Drain"
        suffix="seconds"
        description="Old replicas keep serving this long."
        value={drain}
        onChange={setDrain}
        min={0}
        max={3600}
      />
    </Section>
  );
}

function ResourceControl({
  label,
  description,
  value,
  onChange,
  bounds,
  apiMax,
  format,
  unit,
}: {
  label: string;
  description: string;
  value: number;
  onChange: (value: number) => void;
  bounds: { min: number; max: number; step: number };
  apiMax: number;
  format: (value: number) => string;
  unit: string;
}) {
  const inputId = useId();
  return (
    <SettingsRow
      label={
        <span className="flex items-baseline justify-between gap-3">
          {label}
          <span className="text-sm font-normal text-muted-foreground tabular-nums md:hidden">
            {format(value)}
          </span>
        </span>
      }
      description={description}
      htmlFor={inputId}
    >
      <div className="flex items-center gap-3">
        <Slider
          thumbLabel={label}
          valueText={format(value)}
          min={bounds.min}
          max={bounds.max}
          step={bounds.step}
          value={[Math.min(bounds.max, Math.max(bounds.min, value))]}
          onValueChange={([next]) => {
            if (next !== undefined) onChange(next);
          }}
        />
        <div className="flex shrink-0 items-center gap-1.5">
          <Input
            id={inputId}
            aria-label={`${label} in ${unit === "m" ? "millicores" : unit}`}
            value={String(value)}
            inputMode="numeric"
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isInteger(next) && next >= 0 && next <= apiMax) onChange(next);
            }}
            className="w-20 text-right tabular-nums"
          />
          <span className="w-6 text-xs text-muted-foreground">{unit}</span>
        </div>
      </div>
      <p className="mt-1.5 hidden text-xs text-muted-foreground tabular-nums md:block">
        {format(value)} per replica
      </p>
    </SettingsRow>
  );
}

function ResourcesSection({ config, context }: { config: ServiceConfig; context: SaveContext }) {
  const resources = config.resources;
  const [cpu, setCpu] = useState(resources.cpu_millis);
  const [memory, setMemory] = useState(resources.memory_mb);
  const valid = cpu >= 10 && cpu <= 64_000 && memory >= 16 && memory <= 262_144;
  const dirty = cpu !== resources.cpu_millis || memory !== resources.memory_mb;
  return (
    <Section
      id="resources"
      title="Resources"
      description="Limits per replica. Memory is never overcommitted on a server; CPU may be, up to 2x."
      dirty={dirty}
      part="resources"
      context={context}
      onReset={() => {
        setCpu(resources.cpu_millis);
        setMemory(resources.memory_mb);
      }}
      onSubmit={() => {
        if (valid) context.save("resources", { cpu_millis: cpu, memory_mb: memory });
      }}
    >
      <ResourceControl
        label="CPU"
        description="In millicores: 1000 is one vCPU."
        value={cpu}
        onChange={setCpu}
        bounds={CPU_SLIDER}
        apiMax={64_000}
        format={formatCpu}
        unit="m"
      />
      <ResourceControl
        label="Memory"
        description="The replica is stopped if it goes over."
        value={memory}
        onChange={setMemory}
        bounds={MEMORY_SLIDER}
        apiMax={262_144}
        format={formatMemoryMb}
        unit="MB"
      />
      {!valid ? (
        <p className="py-3 text-xs text-danger">
          CPU must be 10–64000 millicores and memory 16–262144 MB.
        </p>
      ) : null}
    </Section>
  );
}

const DEFAULT_PROBE: HealthcheckConfig = {
  type: "http",
  path: "/healthz",
  interval_s: 10,
  timeout_s: 3,
  retries: 3,
  start_period_s: 5,
};

function TimingField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
}) {
  return (
    <FormField
      label={label}
      value={value}
      inputMode="numeric"
      onChange={(event) => onChange(event.target.value)}
      error={numberError(value, min, max)}
      inputClassName="tabular-nums"
    />
  );
}

function HealthcheckSection({ config, context }: { config: ServiceConfig; context: SaveContext }) {
  const probe = config.healthcheck;
  const base = probe ?? DEFAULT_PROBE;
  const [type, setType] = useState<HealthcheckConfig["type"]>(probe?.type ?? "none");
  const [path, setPath] = useState(base.path ?? "/healthz");
  const [port, setPort] = useState(base.port ? String(base.port) : "");
  const [interval, setInterval] = useState(String(base.interval_s));
  const [timeout, setTimeoutValue] = useState(String(base.timeout_s));
  const [retries, setRetries] = useState(String(base.retries));
  const [startPeriod, setStartPeriod] = useState(String(base.start_period_s));
  const parsedPort = parsePort(port);
  const pathError =
    type === "http" && !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(path)
      ? "Start the path with /."
      : null;
  const valid =
    type === "none" ||
    (!pathError &&
      typeof parsedPort !== "string" &&
      isWhole(interval, 1, 3600) &&
      isWhole(timeout, 1, 300) &&
      isWhole(retries, 0, 100) &&
      isWhole(startPeriod, 0, 3600));
  const next: HealthcheckConfig | null =
    type === "none"
      ? null
      : {
          type,
          ...(type === "http" ? { path } : {}),
          ...(typeof parsedPort === "number" ? { port: parsedPort } : {}),
          interval_s: Number(interval),
          timeout_s: Number(timeout),
          retries: Number(retries),
          start_period_s: Number(startPeriod),
        };
  const dirty = JSON.stringify(next) !== JSON.stringify(probe?.type === "none" ? null : probe);

  return (
    <Section
      id="healthcheck"
      title="Healthcheck"
      description="Traffic moves to a new replica only after its probe passes. Without one, a running container counts as healthy."
      dirty={dirty}
      part="healthcheck"
      context={context}
      onReset={() => {
        setType(probe?.type ?? "none");
        setPath(base.path ?? "/healthz");
        setPort(base.port ? String(base.port) : "");
        setInterval(String(base.interval_s));
        setTimeoutValue(String(base.timeout_s));
        setRetries(String(base.retries));
        setStartPeriod(String(base.start_period_s));
      }}
      onSubmit={() => {
        if (valid) context.save("healthcheck", next);
      }}
    >
      <SelectRow
        label="Probe"
        description="HTTP expects a 2xx or 3xx; TCP only needs the port to accept."
        value={type}
        onChange={(value) => setType(value as typeof type)}
      >
        <option value="none">None</option>
        <option value="http">HTTP</option>
        <option value="tcp">TCP</option>
      </SelectRow>
      {type !== "none" ? (
        <>
          {type === "http" ? (
            <SettingsField
              label="Path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              error={pathError}
              inputClassName="font-mono"
            />
          ) : null}
          <SettingsField
            label="Port"
            description="Defaults to the service port."
            value={port}
            onChange={(event) => setPort(event.target.value)}
            placeholder={config.networking.port ? String(config.networking.port) : "service port"}
            error={typeof parsedPort === "string" ? parsedPort : null}
            inputMode="numeric"
            inputClassName="w-32 tabular-nums"
          />
          <SettingsRow
            label="Timing"
            description="How often to probe, how long to wait, failures allowed, and the grace period after start."
          >
            <div className="grid grid-cols-2 gap-3">
              <TimingField
                label="Interval (s)"
                value={interval}
                onChange={setInterval}
                min={1}
                max={3600}
              />
              <TimingField
                label="Timeout (s)"
                value={timeout}
                onChange={setTimeoutValue}
                min={1}
                max={300}
              />
              <TimingField
                label="Retries"
                value={retries}
                onChange={setRetries}
                min={0}
                max={100}
              />
              <TimingField
                label="Start period (s)"
                value={startPeriod}
                onChange={setStartPeriod}
                min={0}
                max={3600}
              />
            </div>
          </SettingsRow>
        </>
      ) : null}
    </Section>
  );
}

function NetworkingSection({ config, context }: { config: ServiceConfig; context: SaveContext }) {
  const networking = config.networking;
  const [port, setPort] = useState(networking.port === null ? "" : String(networking.port));
  const [generated, setGenerated] = useState(networking.generated_domain);
  const domainId = useId();
  const parsed = parsePort(port);
  const dirty =
    port !== (networking.port === null ? "" : String(networking.port)) ||
    generated !== networking.generated_domain;
  return (
    <Section
      id="networking"
      title="Networking"
      description="The port your app listens on (injected as PORT) and its public hostname."
      dirty={dirty}
      part="networking"
      context={context}
      onReset={() => {
        setPort(networking.port === null ? "" : String(networking.port));
        setGenerated(networking.generated_domain);
      }}
      onSubmit={() => {
        if (typeof parsed === "string") return;
        context.save("networking", {
          port: parsed,
          generated_domain: parsed !== null && generated,
        });
      }}
    >
      <SettingsField
        label="Port"
        description="Leave empty for workers that don't listen."
        value={port}
        onChange={(event) => setPort(event.target.value)}
        error={typeof parsed === "string" ? parsed : null}
        inputMode="numeric"
        inputClassName="w-32 tabular-nums"
      />
      <SettingsRow
        label="Generated domain"
        description={
          parsed === null
            ? "Needs a port."
            : "A hostname under the instance's apps domain, routed to this port."
        }
        htmlFor={domainId}
        control="switch"
      >
        <Switch
          id={domainId}
          aria-describedby={`${domainId}-description`}
          checked={generated && parsed !== null}
          disabled={parsed === null || typeof parsed === "string"}
          onCheckedChange={setGenerated}
        />
      </SettingsRow>
    </Section>
  );
}

function PlacementSection({ config, context }: { config: ServiceConfig; context: SaveContext }) {
  const selector = config.placement.node_selector;
  const [pairs, setPairs] = useState<KeyValuePair[]>(toPairs(selector));
  const errors = Object.fromEntries(
    pairs.flatMap((pair, index) =>
      pair.key && !LABEL_KEY.test(pair.key)
        ? [[index, "Expected a label key like region or roundhouse.io/gpu."]]
        : [],
    ),
  );
  const dirty = JSON.stringify(fromPairs(pairs)) !== JSON.stringify(fromPairs(toPairs(selector)));
  return (
    <Section
      id="placement"
      title="Placement"
      description="Only servers whose labels match every selector run this service."
      dirty={dirty}
      part="placement"
      context={context}
      onReset={() => setPairs(toPairs(selector))}
      onSubmit={() => {
        if (Object.keys(errors).length === 0)
          context.save("placement", { node_selector: fromPairs(pairs) });
      }}
    >
      <SettingsRow
        label="Node selector"
        description="Label pairs a server must carry. Empty runs the service on any server."
        control="wide"
      >
        <KeyValueEditor
          label="Node selector"
          hideLegend
          pairs={pairs}
          onChange={setPairs}
          keyPlaceholder="region"
          valuePlaceholder="eu-central"
          errors={errors}
          max={16}
        />
      </SettingsRow>
    </Section>
  );
}

function GeneralSection({
  service,
  serviceId,
  canEdit,
}: {
  service: Service;
  serviceId: string;
  canEdit: boolean;
}) {
  const update = useUpdateService(serviceId);
  const [name, setName] = useState(service.name);
  const [error, setError] = useState<string | null>(null);
  const dirty = name.trim() !== service.name;
  return (
    <form
      noValidate
      aria-label="General"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) {
          setError("Enter a name.");
          return;
        }
        update.mutate(
          { name: name.trim() },
          {
            onSuccess: () => {
              setError(null);
              toast({ title: "Service renamed", tone: "success" });
            },
            onError: (cause) => setError(errorMessage(cause)),
          },
        );
      }}
    >
      <SettingsSection id="general" title="General" className="scroll-mt-20">
        <SettingsField
          label="Service name"
          description={`Renaming keeps the slug ${service.slug}, so references keep working.`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={error}
          disabled={!canEdit}
        />
      </SettingsSection>
      {canEdit ? (
        <SaveBar
          dirty={dirty}
          saving={update.isPending}
          onDiscard={() => {
            setName(service.name);
            setError(null);
          }}
        />
      ) : null}
    </form>
  );
}

function DeleteServiceSection({
  workspaceId,
  projectId,
  service,
}: {
  workspaceId: string;
  projectId: string;
  service: Service;
}) {
  const remove = useDeleteService(projectId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  return (
    <DangerZone>
      <SettingsRow
        label="Delete service"
        description="Stops every replica, removes its domains, and deletes its deployments and variables."
      >
        <div className="md:flex md:justify-end">
          <Button variant="danger-outline" onClick={() => setConfirming(true)}>
            Delete service
          </Button>
        </div>
      </SettingsRow>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) remove.reset();
        }}
        title={`Delete ${service.name}?`}
        description="Its containers stop on every server. This can't be undone."
        confirmLabel="Delete service"
        confirmText={service.name}
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() =>
          remove.mutate(service.id, {
            onSuccess: async () => {
              setConfirming(false);
              toast({ title: `${service.name} deleted`, tone: "success" });
              // NOTE: Leave first, so the mounted service pages don't refetch into a 404.
              await navigate({
                to: "/w/$workspaceId/p/$projectId",
                params: { workspaceId, projectId },
              });
              forgetService(queryClient, service.id);
            },
          })
        }
      />
    </DangerZone>
  );
}

function SectionNav({ canDelete }: { canDelete: boolean }) {
  return (
    <SettingsNav label="Service settings" className="hidden lg:block">
      <SettingsNavGroup label="On this page">
        {SECTIONS.map((section) => (
          <SettingsNavItem key={section.id} href={`#${section.id}`}>
            {section.label}
          </SettingsNavItem>
        ))}
        {canDelete ? <SettingsNavItem href="#danger-zone">Danger zone</SettingsNavItem> : null}
      </SettingsNavGroup>
    </SettingsNav>
  );
}

/**
 * Every part of a service's config, one form per part. Each save writes a new immutable
 * version (guarded by `expected_version`, so concurrent editors can't overwrite each
 * other) and takes effect on the next deploy, which the notice at the top offers.
 *
 * @param props - Workspace, project and service ids.
 * @returns The tab.
 */
export function ServiceSettingsTab({ workspaceId, projectId, serviceId }: ServicePageProps) {
  const { project, environment } = useProjectEnvironment(projectId);
  const service = findService(project.data, serviceId);
  const config = useServiceConfig(serviceId, environment?.id);
  const latest = useQuery({
    ...latestDeploymentQueryOptions(serviceId, environment?.id ?? ""),
    enabled: Boolean(environment),
  });
  const update = useUpdateService(serviceId);
  const deploy = useDeploy();
  const { can } = usePermissions(workspaceId);
  const [saving, setSaving] = useState<Part | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Part, string>>>({});

  if (config.isPending || !service) {
    return (
      <div className="grid max-w-[50rem] gap-4" aria-busy="true">
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-48 rounded-lg" />
      </div>
    );
  }
  if (config.isError) {
    return (
      <ErrorState message={errorMessage(config.error)} onRetry={() => void config.refetch()} />
    );
  }
  const current = config.data;

  const context: SaveContext = {
    canEdit: can("services:manage"),
    saving,
    errors,
    save: (part, value) => {
      if (!environment) return;
      setSaving(part);
      setErrors((previous) => ({ ...previous, [part]: undefined }));
      update.mutate(
        { environment_id: environment.id, expected_version: current.version, [part]: value },
        {
          onSuccess: ({ config: saved }) => {
            toast({
              title: saved ? `Saved as version ${saved.version}` : "Saved",
              description: "Deploy to apply it.",
              tone: "success",
            });
          },
          onError: (error) => {
            const message = isApiError(error, 409)
              ? "Someone else changed this config. Reload it, then make your change again."
              : errorMessage(error);
            setErrors((previous) => ({ ...previous, [part]: message }));
            if (isApiError(error, 409)) void config.refetch();
          },
          onSettled: () => setSaving(null),
        },
      );
    },
  };

  const undeployed =
    latest.data !== undefined &&
    (latest.data === null || latest.data.config_version < current.version);
  const canDelete = can("services:manage");

  return (
    <SettingsLayout nav={<SectionNav canDelete={canDelete} />}>
      <div className="mb-8 grid gap-3">
        <p className="text-sm text-muted-foreground">
          Each save is a new config version and applies on the next deploy.{" "}
          <span className="text-foreground tabular-nums">
            config v{current.version} · saved {formatRelativeTime(current.created_at)}
          </span>
        </p>
        {undeployed && latest.data ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 py-2 pr-2 pl-3.5 text-sm text-foreground">
            <span>
              v{current.version} isn't deployed yet (running v{latest.data.config_version})
            </span>
            {can("deployments:create") && environment ? (
              <Button
                size="sm"
                variant="primary"
                loading={deploy.isPending}
                onClick={() =>
                  deploy.mutate(
                    { serviceId, environmentId: environment.id },
                    {
                      onSuccess: () =>
                        toast({ title: `Deploying ${service.name}`, tone: "success" }),
                      onError: (error) =>
                        toast({
                          title: "Could not deploy",
                          description: errorMessage(error),
                          tone: "error",
                        }),
                    },
                  )
                }
              >
                {deploy.isPending ? null : <RocketIcon />}
                Deploy to apply
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <SettingsStack>
        <GeneralSection service={service} serviceId={serviceId} canEdit={context.canEdit} />
        <SourceSection config={current} context={context} />
        <BuildSection config={current} context={context} />
        <DeploySection config={current} context={context} />
        <ResourcesSection config={current} context={context} />
        <HealthcheckSection config={current} context={context} />
        <NetworkingSection config={current} context={context} />
        <PlacementSection config={current} context={context} />
        {canDelete ? (
          <div id="danger-zone" className="scroll-mt-20">
            <DeleteServiceSection
              workspaceId={workspaceId}
              projectId={projectId}
              service={service}
            />
          </div>
        ) : null}
      </SettingsStack>
    </SettingsLayout>
  );
}
