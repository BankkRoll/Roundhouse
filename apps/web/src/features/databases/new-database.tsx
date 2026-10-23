/**
 * The database branch of the new-service flow (ADR 0004, "Add → Database"): pick an
 * engine, version and volume size, then review what will be created (the service, a
 * volume per environment, and its credential variables by name only) and apply.
 *
 * @module
 */
import {
  DATABASE_ENGINE_SPECS,
  DEFAULT_DATABASE_VOLUME_MB,
  MAX_VOLUME_MB,
  MIN_VOLUME_MB,
  SERVICE_DATABASE_ENGINES,
  type ServiceDatabaseEngine,
} from "@roundhouse/shared";
import { Button, ChoiceCards, DialogFooter, Label, Select, toast } from "@roundhouse/ui";
import { Switch } from "@roundhouse/ui/controls";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { FormField } from "../../components/form-field";
import { errorMessage } from "../../lib/api/client";
import type { Environment } from "../../lib/api/deploy-types";
import { useCreateDatabase } from "../../queries/databases";
import { suggestServiceName } from "../projects/new-service/source";
import { databaseMountPath, databaseVariableNames, databaseVersionLabel } from "./database-meta";

/** What step 1 of the flow picks. */
export interface DatabaseDraft {
  engine: ServiceDatabaseEngine;
  /** Registry version; `""` until an engine is picked, then its default. */
  version: string;
  /** Volume size in GiB as typed. */
  sizeGib: string;
}

/** The draft a new flow starts from: the default PostgreSQL with a 5 GiB volume. */
export function initialDatabaseDraft(): DatabaseDraft {
  return {
    engine: "postgres",
    version: DATABASE_ENGINE_SPECS.postgres.versions[0]!.version,
    sizeGib: String(DEFAULT_DATABASE_VOLUME_MB / 1024),
  };
}

/**
 * Parses the typed volume size.
 *
 * @param sizeGib - Size in GiB, up to two decimals.
 * @returns The size in MiB, or an error message.
 */
export function parseVolumeSize(sizeGib: string): number | string {
  const trimmed = sizeGib.trim();
  const mb = /^\d+(\.\d{1,2})?$/.test(trimmed) ? Math.round(Number(trimmed) * 1024) : Number.NaN;
  if (!Number.isFinite(mb) || mb < MIN_VOLUME_MB || mb > MAX_VOLUME_MB) {
    return `Enter a size from ${MIN_VOLUME_MB / 1024} to ${MAX_VOLUME_MB / 1024} GiB.`;
  }
  return mb;
}

const ENGINE_NOTES: Record<ServiceDatabaseEngine, string> = {
  postgres: "Relational, the usual choice.",
  mysql: "Relational, for MySQL apps.",
  redis: "Valkey, Redis-compatible. The default.",
  mongodb: "Document store.",
};

/** Props for {@link DatabaseFields}. */
export interface DatabaseFieldsProps {
  draft: DatabaseDraft;
  onChange: (draft: DatabaseDraft) => void;
  /** Error of the size field, shown after Continue. */
  sizeError?: string | null;
}

/**
 * Step 1 of adding a database: engine cards, a version select from the registry, and
 * the volume size.
 *
 * @param props - The draft, its setter and the size error.
 * @returns The fields.
 */
export function DatabaseFields({ draft, onChange, sizeError }: DatabaseFieldsProps) {
  const versionId = useId();
  const spec = DATABASE_ENGINE_SPECS[draft.engine];
  return (
    <div className="grid gap-4">
      <ChoiceCards<ServiceDatabaseEngine>
        label="Engine"
        showLabel
        value={draft.engine}
        onValueChange={(engine) =>
          onChange({
            ...draft,
            engine,
            version: DATABASE_ENGINE_SPECS[engine].versions[0]!.version,
          })
        }
        options={SERVICE_DATABASE_ENGINES.map((engine) => ({
          value: engine,
          label: engine === "redis" ? "Valkey" : DATABASE_ENGINE_SPECS[engine].name,
          description: ENGINE_NOTES[engine],
        }))}
        className="grid-cols-2 sm:grid-cols-4"
      />
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
        <div className="grid gap-1.5">
          <Label htmlFor={versionId}>Version</Label>
          <Select
            id={versionId}
            value={draft.version}
            onChange={(event) => onChange({ ...draft, version: event.target.value })}
          >
            {spec.versions.map((v, index) => (
              <option key={v.version} value={v.version}>
                {index === 0 ? `${v.label} (default)` : v.label}
              </option>
            ))}
          </Select>
        </div>
        <FormField
          label="Volume (GiB)"
          value={draft.sizeGib}
          onChange={(event) => onChange({ ...draft, sizeGib: event.target.value })}
          inputMode="decimal"
          error={sizeError}
          hint="Can grow later."
        />
      </div>
    </div>
  );
}

/** Props for {@link DatabaseReview}. */
export interface DatabaseReviewProps {
  workspaceId: string;
  projectId: string;
  draft: DatabaseDraft;
  environments: readonly Environment[];
  /** The environment selected on the project page. */
  defaultEnvironmentId: string | undefined;
  /** Whether the caller may start deployments. */
  canDeploy: boolean;
  onBack: () => void;
  /** Called once the database exists, before navigating to it. */
  onCreated: () => void;
}

/**
 * Step 2 of adding a database: the environment it is applied (and first deployed) in,
 * its name, and a preview of everything that will be created, with credentials listed
 * by name and masked. The API generates the credentials; none are made or seen here.
 *
 * @param props - Ids, the draft, environments, permissions and navigation callbacks.
 * @returns The review form.
 */
export function DatabaseReview({
  workspaceId,
  projectId,
  draft,
  environments,
  defaultEnvironmentId,
  canDeploy,
  onBack,
  onCreated,
}: DatabaseReviewProps) {
  const navigate = useNavigate();
  const create = useCreateDatabase(projectId);
  const spec = DATABASE_ENGINE_SPECS[draft.engine];
  const [environmentId, setEnvironmentId] = useState(
    defaultEnvironmentId ?? environments[0]?.id ?? "",
  );
  const [name, setName] = useState(spec.name);
  const [deployNow, setDeployNow] = useState(canDeploy);
  const [error, setError] = useState<string | null>(null);
  const environmentFieldId = useId();
  const deployId = useId();
  const sizeMb = parseVolumeSize(draft.sizeGib);
  const slug = suggestServiceName(name) || spec.engine;
  const variables = databaseVariableNames(draft.engine);
  const environment = environments.find((env) => env.id === environmentId);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (typeof sizeMb === "string" || !environment) return;
    if (!name.trim()) {
      setError("Enter a name.");
      return;
    }
    setError(null);
    try {
      const created = await create.mutateAsync({
        engine: draft.engine,
        version: draft.version,
        size_mb: sizeMb,
        environment_id: environment.id,
        name: name.trim(),
        deploy: deployNow && canDeploy,
      });
      toast({
        title:
          created.deployment_ids.length > 0
            ? `Deploying ${created.service.name}`
            : `Added ${created.service.name}`,
        description: databaseVersionLabel(created.engine, created.version),
        tone: "success",
      });
      onCreated();
      await navigate({
        to: "/w/$workspaceId/p/$projectId/s/$serviceId/deployments",
        params: { workspaceId, projectId, serviceId: created.service.id },
        search: { env: environment.kind === "production" ? undefined : environment.slug },
      });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate aria-label="Review database">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={64}
          hint={`Referenced as \${{${slug}.${spec.connectionVariable}}}.`}
          autoFocus
        />
        <div className="grid content-start gap-1.5">
          <Label htmlFor={environmentFieldId}>Environment</Label>
          <Select
            id={environmentFieldId}
            value={environmentId}
            onChange={(event) => setEnvironmentId(event.target.value)}
          >
            {environments.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="rounded-md border border-border bg-background">
        <h3 className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
          Will be created
        </h3>
        <dl className="divide-y divide-border/70 text-sm">
          <div className="grid gap-1 px-3 py-2 sm:grid-cols-[7rem_1fr]">
            <dt className="text-muted-foreground">Service</dt>
            <dd className="text-foreground">
              <span className="font-mono">{slug}</span> ·{" "}
              {databaseVersionLabel(draft.engine, draft.version)} · port {spec.port}, private only
            </dd>
          </div>
          <div className="grid gap-1 px-3 py-2 sm:grid-cols-[7rem_1fr]">
            <dt className="text-muted-foreground">Volume</dt>
            <dd className="text-foreground">
              {typeof sizeMb === "number" ? `${Math.round((sizeMb / 1024) * 100) / 100} GiB` : "—"}{" "}
              at <span className="font-mono">{databaseMountPath(draft.engine, draft.version)}</span>
              {environments.length > 1
                ? `, one in each of ${environments.length} environments`
                : ""}
            </dd>
          </div>
          <div className="grid gap-1 px-3 py-2 sm:grid-cols-[7rem_1fr]">
            <dt className="text-muted-foreground">Variables</dt>
            <dd>
              <ul aria-label="Variables to create" className="grid gap-0.5 font-mono text-xs">
                {variables.map((variable) => (
                  <li key={variable.key} className="flex flex-wrap gap-x-2">
                    <span className="text-foreground">{variable.key}</span>
                    <span className="text-muted-foreground">
                      {variable.secret ? "•••••••• generated, write-only" : "plain"}
                    </span>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        </dl>
      </div>

      {canDeploy ? (
        <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-background px-3 py-2.5">
          <div className="grid gap-0.5">
            <Label htmlFor={deployId} className="text-sm text-foreground">
              Deploy now
            </Label>
            <p className="text-xs text-muted-foreground">
              Starts it in {environment?.name ?? "the environment"} right away.
            </p>
          </div>
          <Switch id={deployId} checked={deployNow} onCheckedChange={setDeployNow} />
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          {deployNow && canDeploy ? "Add and deploy" : "Add database"}
        </Button>
      </DialogFooter>
    </form>
  );
}
