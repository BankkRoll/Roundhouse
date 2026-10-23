import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
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

function Section({
  title,
  description,
  dirty,
  part,
  context,
  onSubmit,
  onReset,
  children,
}: {
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
    <Card>
      <form onSubmit={submit} noValidate aria-label={title}>
        <CardHeader>
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <fieldset disabled={!context.canEdit} className="grid gap-4">
            {children}
          </fieldset>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          ) : null}
        </CardContent>
        {context.canEdit ? (
          <CardFooter className="justify-end">
            {dirty ? (
              <>
                <span className="mr-auto font-mono text-[11px] text-warning">unsaved</span>
                <Button variant="ghost" onClick={onReset}>
                  Reset
                </Button>
              </>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              disabled={!dirty}
              loading={context.saving === part}
            >
              Save
            </Button>
          </CardFooter>
        ) : null}
      </form>
    </Card>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  hint,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  hint?: string;
  suffix?: string;
}) {
  const number = Number(value);
  const error =
    value.trim() === "" || !Number.isInteger(number) || number < min || number > max
      ? `Enter a whole number from ${min} to ${max}.`
      : null;
  return (
    <FormField
      label={suffix ? `${label} (${suffix})` : label}
      value={value}
      inputMode="numeric"
      onChange={(event) => onChange(event.target.value)}
      error={error}
      hint={hint}
    />
  );
}

const isWhole = (value: string, min: number, max: number) => {
  const number = Number(value);
  return value.trim() !== "" && Number.isInteger(number) && number >= min && number <= max;
};

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
  const kindId = useId();

  return (
    <Section
      title="Source"
      description="Where the code comes from. Git sources deploy on every push to the branch."
      dirty={dirty}
      part="source"
      context={context}
      onReset={() => {
        setKind(source.type);
        setSubmitted(false);
      }}
      onSubmit={() => {
        setSubmitted(true);
        if (Object.values(errors).some(Boolean)) return;
        context.save("source", next);
      }}
    >
      <div className="grid max-w-xs gap-1.5">
        <Label htmlFor={kindId}>Type</Label>
        <Select
          id={kindId}
          value={kind}
          onChange={(event) => setKind(event.target.value as typeof kind)}
        >
          <option value="image">Docker image</option>
          <option value="git">Git repository</option>
        </Select>
      </div>
      {kind === "image" ? (
        <FormField
          label="Image"
          value={image}
          onChange={(event) => setImage(event.target.value)}
          error={show(errors.image ?? null)}
          inputClassName="font-mono"
          spellCheck={false}
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <FormField
            label="Repository URL"
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            error={show((errors as { repoUrl: string | null }).repoUrl)}
            spellCheck={false}
          />
          <FormField
            label="Branch"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            error={show((errors as { branch: string | null }).branch)}
            spellCheck={false}
          />
          <FormField
            label="Root directory"
            value={rootDir}
            onChange={(event) => setRootDir(event.target.value)}
            error={show((errors as { rootDir: string | null }).rootDir)}
            spellCheck={false}
          />
        </div>
      )}
    </Section>
  );
}

function BuildSection({ config, context }: { config: ServiceConfig; context: SaveContext }) {
  const build = config.build;
  const [builder, setBuilder] = useState(build.builder);
  const [dockerfile, setDockerfile] = useState(build.dockerfile_path ?? "");
  const [args, setArgs] = useState<KeyValuePair[]>(toPairs(build.build_args));
  const builderId = useId();
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
      <div className="grid gap-3 md:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={builderId}>Builder</Label>
          <Select
            id={builderId}
            value={builder}
            onChange={(event) => setBuilder(event.target.value as typeof builder)}
          >
            <option value="railpack">Railpack (automatic)</option>
            <option value="dockerfile">Dockerfile</option>
          </Select>
        </div>
        {builder === "dockerfile" ? (
          <FormField
            label="Dockerfile path"
            value={dockerfile}
            onChange={(event) => setDockerfile(event.target.value)}
            placeholder="Dockerfile"
            hint="Relative to the root directory."
            spellCheck={false}
          />
        ) : null}
      </div>
      <KeyValueEditor
        label="Build arguments"
        pairs={args}
        onChange={setArgs}
        keyPlaceholder="NODE_VERSION"
        valuePlaceholder="22"
        errors={argErrors}
      />
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
  const policyId = useId();
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
      <div className="grid gap-3 md:grid-cols-2">
        <FormField
          label="Start command"
          value={start}
          onChange={(event) => setStart(event.target.value)}
          placeholder="Image default"
          inputClassName="font-mono"
          spellCheck={false}
        />
        <FormField
          label="Pre-deploy command"
          value={preDeploy}
          onChange={(event) => setPreDeploy(event.target.value)}
          placeholder="e.g. npm run migrate"
          hint="Runs once before the rollout."
          inputClassName="font-mono"
          spellCheck={false}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <NumberField
          label="Replicas"
          value={replicas}
          onChange={setReplicas}
          min={0}
          max={20}
          hint="0 stops the service."
        />
        <div className="grid content-start gap-1.5">
          <Label htmlFor={policyId}>Restart policy</Label>
          <Select
            id={policyId}
            value={policy}
            onChange={(event) => setPolicy(event.target.value as typeof policy)}
          >
            <option value="on_failure">On failure</option>
            <option value="always">Always</option>
            <option value="never">Never</option>
          </Select>
        </div>
        <NumberField label="Max retries" value={retries} onChange={setRetries} min={0} max={100} />
        <NumberField
          label="Drain"
          suffix="seconds"
          value={drain}
          onChange={setDrain}
          min={0}
          max={3600}
          hint="Old replicas keep serving this long."
        />
      </div>
    </Section>
  );
}

function ResourceControl({
  label,
  value,
  onChange,
  bounds,
  apiMax,
  format,
  unit,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  bounds: { min: number; max: number; step: number };
  apiMax: number;
  format: (value: number) => string;
  unit: string;
}) {
  const inputId = useId();
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between">
        <Label htmlFor={inputId}>{label}</Label>
        <span className="font-mono text-xs text-foreground tabular-nums">{format(value)}</span>
      </div>
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
        <div className="flex items-center gap-1">
          <Input
            id={inputId}
            aria-label={`${label} in ${unit === "m" ? "millicores" : unit}`}
            value={String(value)}
            inputMode="numeric"
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isInteger(next) && next >= 0 && next <= apiMax) onChange(next);
            }}
            className="h-7 w-20 text-right font-mono text-xs"
          />
          <span className="font-mono text-[11px] text-subtle-foreground">{unit}</span>
        </div>
      </div>
    </div>
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
      <div className="grid gap-6 md:grid-cols-2">
        <ResourceControl
          label="CPU"
          value={cpu}
          onChange={setCpu}
          bounds={CPU_SLIDER}
          apiMax={64_000}
          format={formatCpu}
          unit="m"
        />
        <ResourceControl
          label="Memory"
          value={memory}
          onChange={setMemory}
          bounds={MEMORY_SLIDER}
          apiMax={262_144}
          format={formatMemoryMb}
          unit="MB"
        />
      </div>
      {!valid ? (
        <p className="text-xs text-danger">
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
  const typeId = useId();
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
      title="Healthcheck"
      description="Traffic moves to a new replica only after its probe passes. Without one, a running container counts as healthy."
      dirty={dirty}
      part="healthcheck"
      context={context}
      onReset={() => setType(probe?.type ?? "none")}
      onSubmit={() => {
        if (valid) context.save("healthcheck", next);
      }}
    >
      <div className="grid max-w-xs gap-1.5">
        <Label htmlFor={typeId}>Probe</Label>
        <Select
          id={typeId}
          value={type}
          onChange={(event) => setType(event.target.value as typeof type)}
        >
          <option value="none">None</option>
          <option value="http">HTTP</option>
          <option value="tcp">TCP</option>
        </Select>
      </div>
      {type !== "none" ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {type === "http" ? (
            <FormField
              label="Path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              error={pathError}
              inputClassName="font-mono"
            />
          ) : null}
          <FormField
            label="Port"
            value={port}
            onChange={(event) => setPort(event.target.value)}
            placeholder={config.networking.port ? String(config.networking.port) : "service port"}
            error={typeof parsedPort === "string" ? parsedPort : null}
            hint="Defaults to the service port."
            inputMode="numeric"
          />
          <NumberField
            label="Interval"
            suffix="s"
            value={interval}
            onChange={setInterval}
            min={1}
            max={3600}
          />
          <NumberField
            label="Timeout"
            suffix="s"
            value={timeout}
            onChange={setTimeoutValue}
            min={1}
            max={300}
          />
          <NumberField label="Retries" value={retries} onChange={setRetries} min={0} max={100} />
          <NumberField
            label="Start period"
            suffix="s"
            value={startPeriod}
            onChange={setStartPeriod}
            min={0}
            max={3600}
          />
        </div>
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
      <div className="grid max-w-xs">
        <FormField
          label="Port"
          value={port}
          onChange={(event) => setPort(event.target.value)}
          error={typeof parsed === "string" ? parsed : null}
          hint="Leave empty for workers that don't listen."
          inputMode="numeric"
        />
      </div>
      <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-background px-3 py-2.5">
        <div className="grid gap-0.5">
          <Label htmlFor={domainId} className="text-sm text-foreground">
            Generated domain
          </Label>
          <p className="text-xs text-muted-foreground">
            {parsed === null
              ? "Needs a port."
              : "A hostname under the instance's apps domain, routed to this port."}
          </p>
        </div>
        <Switch
          id={domainId}
          checked={generated && parsed !== null}
          disabled={parsed === null || typeof parsed === "string"}
          onCheckedChange={setGenerated}
        />
      </div>
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
      <KeyValueEditor
        label="Node selector"
        pairs={pairs}
        onChange={setPairs}
        keyPlaceholder="region"
        valuePlaceholder="eu-central"
        errors={errors}
        max={16}
      />
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
    <Card>
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
        <CardHeader>
          <div>
            <CardTitle>General</CardTitle>
            <CardDescription>
              Renaming keeps the slug <span className="font-mono">{service.slug}</span>, so
              references keep working.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid max-w-sm">
          <FormField
            label="Service name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={error}
            disabled={!canEdit}
          />
        </CardContent>
        {canEdit ? (
          <CardFooter className="justify-end">
            <Button type="submit" variant="primary" disabled={!dirty} loading={update.isPending}>
              Save
            </Button>
          </CardFooter>
        ) : null}
      </form>
    </Card>
  );
}

function DangerZone({
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
    <Card className="border-danger/40">
      <CardHeader>
        <div>
          <CardTitle>Delete service</CardTitle>
          <CardDescription>
            Stops every replica, removes its domains, and deletes its deployments and variables.
          </CardDescription>
        </div>
      </CardHeader>
      <CardFooter className="justify-end">
        <Button variant="danger" onClick={() => setConfirming(true)}>
          Delete service
        </Button>
      </CardFooter>
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
    </Card>
  );
}

/**
 * Every part of a service's config, one form per part. Each save writes a new immutable
 * version (guarded by `expected_version`, so concurrent editors can't overwrite each
 * other) and takes effect on the next deploy, which the banner offers.
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
      <div className="grid gap-4" aria-busy="true">
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

  return (
    <div className="grid max-w-4xl gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-xs text-muted-foreground">
        <span>
          config v{current.version} · saved {formatRelativeTime(current.created_at)}
        </span>
        {undeployed && latest.data ? (
          <span className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1 text-warning">
            v{current.version} isn't deployed yet (running v{latest.data.config_version})
            {can("deployments:create") && environment ? (
              <Button
                size="sm"
                variant="primary"
                className="h-6"
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
          </span>
        ) : null}
      </div>
      <GeneralSection service={service} serviceId={serviceId} canEdit={context.canEdit} />
      <SourceSection config={current} context={context} />
      <BuildSection config={current} context={context} />
      <DeploySection config={current} context={context} />
      <ResourcesSection config={current} context={context} />
      <HealthcheckSection config={current} context={context} />
      <NetworkingSection config={current} context={context} />
      <PlacementSection config={current} context={context} />
      {can("services:manage") ? (
        <DangerZone workspaceId={workspaceId} projectId={projectId} service={service} />
      ) : null}
    </div>
  );
}
