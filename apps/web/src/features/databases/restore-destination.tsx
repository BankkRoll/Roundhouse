/**
 * Where a restore writes, shared by the backup and point-in-time restore dialogs: into a
 * new service (the default, with an optional slug and environment) or in place (with an
 * optional skip of the safety backup), and the request fields that choice makes.
 *
 * @module
 */
import { Checkbox, Input, Label, Select } from "@roundhouse/ui";
import { useId, useState } from "react";
import type { RestoreBody } from "../../lib/api/backups-client";
import type { Environment, Service } from "../../lib/api/deploy-types";
import { defaultRestoreSlug } from "./database-meta";

/** Where a restore writes. */
export type RestoreMode = RestoreBody["mode"];

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** A restore destination as a dialog edits it, from {@link useRestoreDestination}. */
export interface RestoreDestination {
  /** The effective mode: in place when a new service is unavailable. */
  mode: RestoreMode;
  setMode: (mode: RestoreMode) => void;
  slug: string;
  setSlug: (slug: string) => void;
  /** Why the slug is invalid, or `null`; an empty slug takes the default name. */
  slugError: string | null;
  targetEnvironmentId: string;
  setTargetEnvironmentId: (id: string) => void;
  skipSafety: boolean;
  setSkipSafety: (skip: boolean) => void;
  /** Back to a new service in the source environment. */
  reset: () => void;
}

/**
 * The state behind {@link RestoreDestinationFields}.
 *
 * @param environmentId - The source environment, where a new service goes by default.
 * @param newServiceAllowed - `false` forces in place, e.g. for a snapshot.
 * @returns The destination and its setters.
 */
export function useRestoreDestination(
  environmentId: string,
  newServiceAllowed = true,
): RestoreDestination {
  const [chosen, setMode] = useState<RestoreMode>("new_service");
  const [slug, setSlug] = useState("");
  const [targetEnvironmentId, setTargetEnvironmentId] = useState(environmentId);
  const [skipSafety, setSkipSafety] = useState(false);
  const trimmed = slug.trim();
  return {
    mode: newServiceAllowed ? chosen : "in_place",
    setMode,
    slug,
    setSlug,
    slugError:
      trimmed !== "" && !SLUG.test(trimmed)
        ? "Lowercase letters, digits and dashes, starting and ending with a letter or digit."
        : null,
    targetEnvironmentId,
    setTargetEnvironmentId,
    skipSafety,
    setSkipSafety,
    reset: () => {
      setMode("new_service");
      setSlug("");
      setTargetEnvironmentId(environmentId);
      setSkipSafety(false);
    },
  };
}

/**
 * The request fields a destination makes, with the typed slug as confirmation.
 *
 * @param destination - The dialog's destination.
 * @param confirm - What the person typed: the service's slug.
 * @param sourceEnvironmentId - The environment restored from; a new service there needs
 * no `target_environment_id`.
 * @returns Mode, confirmation and the mode's own options.
 */
export function destinationBody(
  destination: RestoreDestination,
  confirm: string,
  sourceEnvironmentId: string,
): Pick<RestoreBody, "mode" | "confirm" | "slug" | "target_environment_id" | "skip_safety_backup"> {
  const slug = destination.slug.trim();
  return destination.mode === "new_service"
    ? {
        mode: "new_service",
        confirm,
        ...(slug ? { slug } : {}),
        ...(destination.targetEnvironmentId !== sourceEnvironmentId
          ? { target_environment_id: destination.targetEnvironmentId }
          : {}),
      }
    : {
        mode: "in_place",
        confirm,
        ...(destination.skipSafety ? { skip_safety_backup: true } : {}),
      };
}

function ModeOption({
  mode,
  checked,
  disabled,
  title,
  description,
  onSelect,
}: {
  mode: RestoreMode;
  checked: boolean;
  disabled?: boolean;
  title: string;
  description: string;
  onSelect: (mode: RestoreMode) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-background px-3 py-2 transition-colors has-[:checked]:border-accent-text has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
      <input
        type="radio"
        name="restore-mode"
        value={mode}
        checked={checked}
        disabled={disabled}
        onChange={() => onSelect(mode)}
        className="mt-0.5 size-3.5 shrink-0 accent-accent-text focus-visible:ring-2 focus-visible:ring-ring"
      />
      <span className="grid gap-0.5">
        <span className="text-sm text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

/** Props for {@link RestoreDestinationFields}. */
export interface RestoreDestinationFieldsProps {
  destination: RestoreDestination;
  service: Service;
  /** The environment restored from. */
  environment: Environment;
  /** The project's environments, offered for a new service when there are several. */
  environments: readonly Environment[];
  /** Why a new service is unavailable, shown on its disabled option. */
  newServiceUnavailable?: string;
}

/**
 * The "Restore into" choice and the chosen mode's options.
 *
 * @param props - The destination, the service and its environments.
 * @returns The fields.
 */
export function RestoreDestinationFields({
  destination,
  service,
  environment,
  environments,
  newServiceUnavailable,
}: RestoreDestinationFieldsProps) {
  const skipId = useId();
  const slugId = useId();
  const envId = useId();
  const { mode, slugError } = destination;
  const target =
    environments.find((env) => env.id === destination.targetEnvironmentId) ?? environment;
  return (
    <>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium text-foreground">Restore into</legend>
        <ModeOption
          mode="new_service"
          checked={mode === "new_service"}
          disabled={newServiceUnavailable !== undefined}
          title="A new service"
          description={
            newServiceUnavailable ??
            `Adds a database of the same engine and version with fresh credentials, then restores into it. ${service.name} keeps running untouched.`
          }
          onSelect={destination.setMode}
        />
        <ModeOption
          mode="in_place"
          checked={mode === "in_place"}
          title={`${service.name}, in place`}
          description={`Replaces everything in ${service.name} in ${environment.name}. The database is stopped while it restores.`}
          onSelect={destination.setMode}
        />
      </fieldset>
      {mode === "new_service" ? (
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={slugId}>New service slug</Label>
            <Input
              id={slugId}
              value={destination.slug}
              placeholder={defaultRestoreSlug(service.slug, Date.now())}
              onChange={(event) => destination.setSlug(event.target.value)}
              aria-invalid={slugError ? true : undefined}
              aria-describedby={`${slugId}-hint`}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <p
              id={`${slugId}-hint`}
              className={slugError ? "text-xs text-danger" : "text-xs text-muted-foreground"}
            >
              {slugError ?? "Leave empty for the name shown; a number is added if it is taken."}
            </p>
          </div>
          {environments.length > 1 ? (
            <div className="grid gap-1.5">
              <Label htmlFor={envId}>Environment</Label>
              <Select
                id={envId}
                value={destination.targetEnvironmentId}
                onChange={(event) => destination.setTargetEnvironmentId(event.target.value)}
              >
                {environments.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            The new database is added and deployed in {target.name}, so this needs permission to
            manage services and variables and to deploy there.
          </p>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <Checkbox
            id={skipId}
            checked={destination.skipSafety}
            onChange={(event) => destination.setSkipSafety(event.target.checked)}
          />
          <Label htmlFor={skipId} className="grid gap-0.5 font-normal">
            <span className="text-sm text-foreground">Skip the safety backup</span>
            <span className="text-xs text-muted-foreground">
              By default the current data is backed up first, so the restore can be undone.
            </span>
          </Label>
        </div>
      )}
    </>
  );
}
