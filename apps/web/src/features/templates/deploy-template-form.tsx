import { freeSlug, slugify } from "@roundhouse/shared";
import { Button, Checkbox, Input, Label, Select, toast } from "@roundhouse/ui";
import { SegmentedControl, Switch } from "@roundhouse/ui/controls";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { errorMessage, isApiError } from "../../lib/api/client";
import type {
  TemplateDeployment,
  TemplateDetail,
  TemplateInput,
} from "../../lib/api/templates-types";
import { usePermissions } from "../../lib/permissions";
import { pickEnvironment, projectQueryOptions, useProjects } from "../../queries/projects";
import { useCreateProjectFromTemplate, useDeployTemplate } from "../../queries/templates";

type Target = "new" | "existing";

const NUMBER = /^-?\d+(?:\.\d+)?$/;

/** Keys of every variable the template stores write-only, in template order. */
function writeOnlyKeys(template: TemplateDetail): string[] {
  const all = [...template.services.flatMap((s) => s.variables), ...template.shared_variables];
  return [...new Set(all.filter((v) => v.secret).map((v) => v.key))];
}

function initialValues(inputs: readonly TemplateInput[]): Record<string, string> {
  return Object.fromEntries(
    inputs.map((input) => [input.key, input.default ?? (input.type === "boolean" ? "false" : "")]),
  );
}

function Field({
  id,
  label,
  required,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string | null;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="grid content-start gap-1.5">
      {/* NOTE: The required mark is CSS content so it stays out of the label's text; the
          control carries aria-required instead. */}
      <Label
        htmlFor={id}
        className={required ? "after:ml-0.5 after:text-danger after:content-['*']" : undefined}
      >
        {label}
      </Label>
      {children}
      {hint && !error ? (
        <p id={`${id}-hint`} className="text-xs text-subtle-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
  return (
    [hint && !error ? `${id}-hint` : null, error ? `${id}-error` : null]
      .filter(Boolean)
      .join(" ") || undefined
  );
}

function InputControl({
  input,
  value,
  error,
  onChange,
}: {
  input: TemplateInput;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const aria = {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-required": input.required || undefined,
    "aria-describedby": describedBy(id, input.description, error),
  } as const;
  if (input.type === "boolean") {
    return (
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={id}>{input.label}</Label>
          <Switch
            {...aria}
            checked={value === "true"}
            onCheckedChange={(checked) => onChange(checked ? "true" : "false")}
          />
        </div>
        {input.description ? (
          <p id={`${id}-hint`} className="text-xs text-subtle-foreground">
            {input.description}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <Field
      id={id}
      label={input.label}
      required={input.required}
      hint={input.description}
      error={error}
    >
      {input.type === "select" ? (
        <Select {...aria} value={value} onChange={(event) => onChange(event.target.value)}>
          {input.required && value ? null : <option value="">Choose…</option>}
          {(input.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          {...aria}
          type={input.type === "secret" ? "password" : "text"}
          inputMode={input.type === "number" ? "decimal" : undefined}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={input.type === "secret" ? undefined : "font-mono"}
        />
      )}
    </Field>
  );
}

function deployedToast(
  result: TemplateDeployment,
  template: TemplateDetail,
  target: Target,
  deploy: boolean,
) {
  const failed = result.deploy_errors;
  const title =
    target === "new"
      ? `Created ${result.project.name} from ${template.name}`
      : `Added ${template.name} to ${result.project.name}`;
  const names = new Map(result.services.map((s) => [s.id, s.name]));
  toast({
    title,
    tone: failed.length ? "error" : "success",
    description: failed.length
      ? `${failed.length === 1 ? "1 service" : `${failed.length} services`} couldn't start: ${failed
          .map((e) => `${names.get(e.service_id) ?? e.service_id}: ${e.message}`)
          .join("; ")}`
      : deploy
        ? "First deployments are queued."
        : "Deploy the services when you're ready.",
    durationMs: failed.length ? 10_000 : undefined,
  });
}

/** Props for {@link DeployTemplateForm}. */
export interface DeployTemplateFormProps {
  workspaceId: string;
  /** A supported template. */
  template: TemplateDetail;
}

/**
 * Deploys a template into a new project or an environment of an existing one: its
 * inputs, whether to start first deployments, and the write-only confirmation when it
 * stores generated or secret variables. Field problems the API reports for
 * `inputs.<KEY>` land on the matching input. Roles that can do neither target see why
 * instead of the form.
 *
 * @param props - Workspace and template.
 * @returns The form.
 */
export function DeployTemplateForm({ workspaceId, template }: DeployTemplateFormProps) {
  const navigate = useNavigate();
  const { can } = usePermissions(workspaceId);
  const canExisting = can("services:manage") && can("variables:manage");
  const canNew = can("projects:create") && canExisting;
  const canDeploy = can("deployments:create");
  const [chosen, setTarget] = useState<Target>("new");
  const [name, setName] = useState(template.name);
  const [projectId, setProjectId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [values, setValues] = useState(() => initialValues(template.inputs));
  const [deploy, setDeploy] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [serverWriteOnly, setServerWriteOnly] = useState<string[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const nameId = useId();
  const projectFieldId = useId();
  const environmentFieldId = useId();
  const deployId = useId();
  const confirmId = useId();

  const projects = useProjects(workspaceId, canExisting);
  const project = useQuery({ ...projectQueryOptions(projectId), enabled: projectId !== "" });
  const environments = project.data?.environments ?? [];
  const environment =
    environments.find((e) => e.id === environmentId) ?? pickEnvironment(environments);
  const create = useCreateProjectFromTemplate(workspaceId);
  const addTo = useDeployTemplate(workspaceId);
  const pending = create.isPending || addTo.isPending;

  if (!canExisting) {
    return (
      <p className="border-y border-border/70 py-4 text-sm text-muted-foreground">
        Your role can browse templates but not deploy them. Ask an owner or admin to deploy this
        one.
      </p>
    );
  }

  const keys = [...new Set([...writeOnlyKeys(template), ...serverWriteOnly])];
  const base = slugify(name, 40, "");
  const slug = base ? freeSlug(new Set(projects.data?.map((p) => p.slug)), base) : "";
  const willDeploy = deploy && canDeploy;
  // NOTE: Derived rather than initial state, so a role that loads after the first render
  // still lands on a target it may use.
  const target: Target = canNew ? chosen : "existing";

  function setValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setFieldErrors(({ [key]: _gone, ...rest }) => rest);
    setFormError(null);
  }

  function validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    for (const input of template.inputs) {
      const value = values[input.key]?.trim() ?? "";
      if (!value) {
        if (input.required) errors[input.key] = "Required";
      } else if (input.type === "number" && !NUMBER.test(value)) {
        errors[input.key] = "Enter a number";
      }
    }
    if (target === "new" && !name.trim()) errors.$name = "Enter a project name.";
    if (target === "existing" && !projectId) errors.$project = "Choose a project.";
    if (target === "existing" && projectId && !environment) {
      errors.$environment = "Choose an environment.";
    }
    if (keys.length > 0 && !confirmed) errors.$confirm = "Confirm to continue.";
    return errors;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;
    const inputs = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value.trim() !== ""),
    );
    const options = {
      template_id: template.id,
      inputs,
      deploy: willDeploy,
      confirm_write_only: confirmed,
    };
    try {
      const result =
        target === "new"
          ? await create.mutateAsync({ ...options, name: name.trim() })
          : await addTo.mutateAsync({
              projectId,
              body: { ...options, environment_id: environment?.id ?? "" },
            });
      deployedToast(result, template, target, willDeploy);
      await navigate({
        to: "/w/$workspaceId/p/$projectId",
        params: { workspaceId, projectId: result.project.id },
        search: {
          env: result.environment.kind === "production" ? undefined : result.environment.slug,
        },
      });
    } catch (cause) {
      if (isApiError(cause, "confirmation_required")) {
        setServerWriteOnly(cause.details.map((d) => d.field));
        setConfirmed(false);
        setFieldErrors({ $confirm: cause.message });
        return;
      }
      const mapped: Record<string, string> = {};
      if (isApiError(cause)) {
        for (const detail of cause.details) {
          if (detail.field.startsWith("inputs.")) {
            mapped[detail.field.slice("inputs.".length)] = detail.message;
          }
        }
      }
      if (Object.keys(mapped).length > 0) setFieldErrors(mapped);
      else setFormError(errorMessage(cause));
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-label={`Deploy ${template.name}`}
      className="grid gap-4 border-t border-border/70 pt-4"
    >
      {canNew ? (
        <SegmentedControl<Target>
          label="Deploy into"
          value={target}
          onValueChange={(next) => {
            setTarget(next);
            setFormError(null);
          }}
          options={[
            { value: "new", label: "New project" },
            { value: "existing", label: "Existing project" },
          ]}
          className="justify-self-start"
        />
      ) : null}

      {target === "new" ? (
        <Field
          id={nameId}
          label="Project name"
          required
          hint={slug ? `Slug: ${slug}${slug === base ? "" : ` (${base} is taken)`}` : null}
          error={fieldErrors.$name}
        >
          <Input
            id={nameId}
            aria-required
            value={name}
            maxLength={100}
            onChange={(event) => {
              setName(event.target.value);
              setFieldErrors(({ $name: _gone, ...rest }) => rest);
            }}
            aria-invalid={fieldErrors.$name ? true : undefined}
            aria-describedby={describedBy(nameId, slug, fieldErrors.$name)}
          />
        </Field>
      ) : (
        <>
          <Field id={projectFieldId} label="Project" required error={fieldErrors.$project}>
            <Select
              id={projectFieldId}
              aria-required
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setEnvironmentId("");
                setFieldErrors(({ $project: _gone, ...rest }) => rest);
              }}
              aria-invalid={fieldErrors.$project ? true : undefined}
              aria-describedby={describedBy(projectFieldId, null, fieldErrors.$project)}
            >
              <option value="">{projects.isPending ? "Loading…" : "Choose a project"}</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            id={environmentFieldId}
            label="Environment"
            required
            hint="Gets the template's variables and first deployments."
            error={fieldErrors.$environment}
          >
            <Select
              id={environmentFieldId}
              value={environment?.id ?? ""}
              disabled={!projectId || project.isPending}
              onChange={(event) => setEnvironmentId(event.target.value)}
              aria-describedby={describedBy(environmentFieldId, true, fieldErrors.$environment)}
            >
              {environments.length === 0 ? <option value="">—</option> : null}
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}

      {template.inputs.length > 0 ? (
        <fieldset className="grid gap-4 border-t border-border/70 pt-4">
          <legend className="sr-only">Inputs</legend>
          {template.inputs.map((input) => (
            <InputControl
              key={input.key}
              input={input}
              value={values[input.key] ?? ""}
              error={fieldErrors[input.key]}
              onChange={(value) => setValue(input.key, value)}
            />
          ))}
        </fieldset>
      ) : null}

      <div className="grid gap-1 border-t border-border/70 pt-4">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={deployId}>
            {target === "new" ? "Deploy after creating" : "Deploy after adding"}
          </Label>
          <Switch
            id={deployId}
            checked={willDeploy}
            disabled={!canDeploy}
            onCheckedChange={setDeploy}
            aria-describedby={`${deployId}-hint`}
          />
        </div>
        <p id={`${deployId}-hint`} className="text-xs text-subtle-foreground">
          {canDeploy
            ? "Starts a first deployment of every service."
            : "Your role can't start deployments; the services are created stopped."}
        </p>
      </div>

      {keys.length > 0 ? (
        <div className="grid gap-1.5 rounded-md border border-warning/30 bg-warning/5 p-3">
          <label htmlFor={confirmId} className="flex items-start gap-2 text-sm text-foreground">
            <Checkbox
              id={confirmId}
              checked={confirmed}
              onChange={(event) => {
                setConfirmed(event.target.checked);
                setFieldErrors(({ $confirm: _gone, ...rest }) => rest);
              }}
              aria-invalid={fieldErrors.$confirm ? true : undefined}
              aria-describedby={`${confirmId}-keys${fieldErrors.$confirm ? ` ${confirmId}-error` : ""}`}
              className="mt-0.5"
            />
            <span>
              {keys.length === 1 ? "1 variable" : `${keys.length} variables`} will be write-only.
              Nobody can read {keys.length === 1 ? "it" : "them"} back after deploy.
            </span>
          </label>
          <p id={`${confirmId}-keys`} className="pl-5.5 font-mono text-xs text-muted-foreground">
            {keys.join(", ")}
          </p>
          {fieldErrors.$confirm ? (
            <p id={`${confirmId}-error`} className="pl-5.5 text-xs text-danger">
              {fieldErrors.$confirm}
            </p>
          ) : null}
        </div>
      ) : null}

      {formError ? (
        <p role="alert" className="text-sm text-danger">
          {formError}
        </p>
      ) : null}

      <Button type="submit" variant="primary" loading={pending} className="justify-self-start">
        Deploy template
      </Button>
    </form>
  );
}
