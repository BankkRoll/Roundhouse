import {
  PREVIEW_LIMITS,
  type PreviewForkPolicy,
  type PreviewSameRepoSecrets,
} from "@roundhouse/shared";
import {
  Checkbox,
  Input,
  SaveBar,
  Select,
  SettingsRow,
  SettingsSection,
  SettingsStack,
  toast,
} from "@roundhouse/ui";
import { Switch } from "@roundhouse/ui/controls";
import { ShieldAlertIcon } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { SettingsField } from "../../components/settings-field";
import { errorMessage } from "../../lib/api/client";
import type { Environment } from "../../lib/api/deploy-types";
import type { PreviewSettings, PreviewSettingsBody } from "../../lib/api/previews-client";
import { useSavePreviewSettings } from "../../queries/previews";
import { useProjectSummary } from "../../queries/projects";
import {
  fromPairs,
  KeyValueEditor,
  type KeyValuePair,
  toPairs,
} from "../services/settings/key-value-editor";

/** The form's editable copy of the settings; numbers stay text until saved. */
interface Draft {
  enabled: boolean;
  base_environment_id: string;
  services: string[] | null;
  ttl_hours: string;
  max_active: string;
  replicas: string;
  cpu_millis: string;
  memory_mb: string;
  volume_mb: string;
  skip_drafts: boolean;
  same_repo_secrets: PreviewSameRepoSecrets;
  fork_policy: PreviewForkPolicy;
  approval_label: string;
  node_selector: KeyValuePair[];
  build_node_selector: KeyValuePair[];
  comment: boolean;
}

type DraftErrors = Partial<Record<keyof Draft, string>> & {
  nodeSelectorRows?: Record<number, string>;
  buildSelectorRows?: Record<number, string>;
};

const LABEL_KEY = /^[A-Za-z0-9]([A-Za-z0-9._/-]*[A-Za-z0-9])?$/;

const SAME_REPO_SECRETS: Record<PreviewSameRepoSecrets, string> = {
  copy: "Copy from the base environment",
  omit: "Withhold, as for forks",
};

const FORK_POLICIES: Record<PreviewForkPolicy, string> = {
  disabled: "Never build",
  approval: "Build after a project admin approves",
};

function toDraft(settings: PreviewSettings, fallbackBase: string): Draft {
  return {
    enabled: settings.enabled,
    base_environment_id: settings.base_environment_id ?? fallbackBase,
    services: settings.services,
    ttl_hours: String(settings.ttl_hours),
    max_active: String(settings.max_active),
    replicas: String(settings.caps.replicas),
    cpu_millis: String(settings.caps.cpu_millis),
    memory_mb: String(settings.caps.memory_mb),
    volume_mb: String(settings.caps.volume_mb),
    skip_drafts: settings.skip_drafts,
    same_repo_secrets: settings.same_repo_secrets,
    fork_policy: settings.fork_policy,
    approval_label: settings.approval_label,
    node_selector: toPairs(settings.node_selector),
    build_node_selector: toPairs(settings.build_node_selector),
    comment: settings.comment,
  };
}

function integerIn(value: string, limit: { min: number; max: number }): number | string {
  const parsed = Number(value);
  if (!value.trim() || !Number.isInteger(parsed)) return "Enter a whole number.";
  if (parsed < limit.min || parsed > limit.max) {
    return `Between ${limit.min} and ${limit.max}.`;
  }
  return parsed;
}

function selectorErrors(pairs: readonly KeyValuePair[]): Record<number, string> {
  return Object.fromEntries(
    pairs.flatMap((pair, index) => {
      const key = pair.key.trim();
      if (!key && !pair.value) return [];
      if (!key || key.length > 63 || !LABEL_KEY.test(key)) {
        return [[index, "Expected a label key like pool or roundhouse.io/builder."]];
      }
      return pair.value.length > 63 ? [[index, "At most 63 characters."]] : [];
    }),
  );
}

/**
 * Checks a draft the way the API will, so mistakes show beside their field.
 *
 * @param draft - The form's values.
 * @returns The request body, or the problems by field.
 */
function toBody(draft: Draft): { body: PreviewSettingsBody } | { errors: DraftErrors } {
  const errors: DraftErrors = {};
  const number = (field: keyof Draft, limit: { min: number; max: number }) => {
    const result = integerIn(draft[field] as string, limit);
    if (typeof result === "string") errors[field] = result;
    return typeof result === "number" ? result : 0;
  };
  const ttl = number("ttl_hours", PREVIEW_LIMITS.ttlHours);
  const maxActive = number("max_active", PREVIEW_LIMITS.maxActive);
  const caps = {
    replicas: number("replicas", PREVIEW_LIMITS.replicas),
    cpu_millis: number("cpu_millis", PREVIEW_LIMITS.cpuMillis),
    memory_mb: number("memory_mb", PREVIEW_LIMITS.memoryMb),
    volume_mb: number("volume_mb", PREVIEW_LIMITS.volumeMb),
  };
  if (!draft.base_environment_id) errors.base_environment_id = "Choose an environment.";
  if (draft.services?.length === 0) errors.services = "Choose at least one service.";
  const label = draft.approval_label.trim();
  if (!label || label.length > 50 || label.includes(",")) {
    errors.approval_label = "1 to 50 characters, without commas.";
  }
  const nodeSelectorRows = selectorErrors(draft.node_selector);
  const buildSelectorRows = selectorErrors(draft.build_node_selector);
  if (Object.keys(nodeSelectorRows).length > 0) errors.nodeSelectorRows = nodeSelectorRows;
  if (Object.keys(buildSelectorRows).length > 0) errors.buildSelectorRows = buildSelectorRows;
  const buildSelector = fromPairs(draft.build_node_selector);
  if (draft.fork_policy === "approval" && Object.keys(buildSelector).length === 0) {
    errors.build_node_selector =
      "Add at least one label. Fork builds run only on builders that carry it.";
  }
  if (Object.keys(errors).length > 0) return { errors };
  return {
    body: {
      enabled: draft.enabled,
      base_environment_id: draft.base_environment_id,
      services: draft.services,
      ttl_hours: ttl,
      max_active: maxActive,
      caps,
      skip_drafts: draft.skip_drafts,
      same_repo_secrets: draft.same_repo_secrets,
      fork_policy: draft.fork_policy,
      approval_label: label,
      node_selector: fromPairs(draft.node_selector),
      build_node_selector: buildSelector,
      comment: draft.comment,
    },
  };
}

function FieldError({ id, error }: { id: string; error: string | undefined }) {
  return error ? (
    <p id={id} className="mt-1.5 text-xs text-danger">
      {error}
    </p>
  ) : null;
}

function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <SettingsRow label={label} description={description} htmlFor={id} control="switch">
      <Switch
        id={id}
        aria-describedby={`${id}-description`}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </SettingsRow>
  );
}

/** Props for {@link PreviewSettingsForm}. */
export interface PreviewSettingsFormProps {
  projectId: string;
  settings: PreviewSettings;
  /** The project's environments; preview environments are left out of the base choice. */
  environments: readonly Environment[];
  /** Whether the caller holds `previews:manage`; read-only otherwise. */
  canEdit: boolean;
}

/**
 * A project's preview settings: on or off, the base environment and services, lifetime
 * and limits, resource caps, how secrets and fork PRs are treated, and placement. Fork
 * approval requires a build node selector, so untrusted builds stay on dedicated
 * builders. Read-only without `previews:manage`.
 *
 * @param props - Project, saved settings, environments and edit permission.
 * @returns The form.
 */
export function PreviewSettingsForm({
  projectId,
  settings,
  environments,
  canEdit,
}: PreviewSettingsFormProps) {
  const save = useSavePreviewSettings(projectId);
  const bases = environments.filter((entry) => entry.kind !== "preview" && !entry.preview_id);
  const fallbackBase = bases.find((entry) => entry.kind === "production")?.id ?? bases[0]?.id ?? "";
  const initial = useMemo(() => toDraft(settings, fallbackBase), [settings, fallbackBase]);
  const [edited, setEdited] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const draft = edited ?? initial;
  const dirty = edited !== null && JSON.stringify(edited) !== JSON.stringify(initial);
  const summary = useProjectSummary(projectId, draft.base_environment_id || undefined);
  const gitServices = (summary.data?.services ?? []).filter(
    (entry) => entry.source?.type === "git",
  );
  const ids = {
    base: useId(),
    services: useId(),
    sameRepo: useId(),
    forkPolicy: useId(),
    build: useId(),
    field: useId(),
  };
  const disabled = !canEdit;

  const set = <K extends keyof Draft>(field: K, value: Draft[K]) => {
    setEdited({ ...draft, [field]: value });
    if (errors[field]) setErrors({ ...errors, [field]: undefined });
  };

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaveError(null);
    const result = toBody(draft);
    if ("errors" in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    save.mutate(result.body, {
      onSuccess: () => {
        setEdited(null);
        toast({ title: "Preview settings saved", tone: "success" });
      },
      onError: (cause) => setSaveError(errorMessage(cause)),
    });
  }

  const capField = (
    field: "replicas" | "cpu_millis" | "memory_mb" | "volume_mb",
    label: string,
  ) => (
    <div className="grid gap-1 text-xs text-muted-foreground">
      <label htmlFor={`${ids.field}-${field}`}>{label}</label>
      <Input
        id={`${ids.field}-${field}`}
        inputMode="numeric"
        value={draft[field]}
        onChange={(event) => set(field, event.target.value)}
        disabled={disabled}
        aria-invalid={errors[field] ? true : undefined}
        className="tabular-nums"
      />
      {errors[field] ? <span className="text-danger">{errors[field]}</span> : null}
    </div>
  );

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Preview settings">
      <SettingsStack>
        <SettingsSection
          title="Settings"
          description="Every preview copies the base environment's services, variables and config."
        >
          <SwitchRow
            label="Build previews"
            description="Create an environment for each open pull request."
            checked={draft.enabled}
            onChange={(value) => set("enabled", value)}
            disabled={disabled}
          />
          <SettingsRow
            label="Base environment"
            description="Copied by every preview."
            htmlFor={ids.base}
          >
            <Select
              id={ids.base}
              aria-describedby={`${ids.base}-description`}
              value={draft.base_environment_id}
              onChange={(event) => set("base_environment_id", event.target.value)}
              disabled={disabled}
              aria-invalid={errors.base_environment_id ? true : undefined}
            >
              {bases.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
            <FieldError id={`${ids.base}-error`} error={errors.base_environment_id} />
          </SettingsRow>
          <SettingsRow
            label="Services"
            description="Git services built at the pull request's head. Others run the base environment's image."
          >
            <fieldset className="grid gap-2" disabled={disabled} aria-label="Services">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="radio"
                  name={ids.services}
                  checked={draft.services === null}
                  onChange={() => set("services", null)}
                  className="accent-accent"
                />
                All git services
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="radio"
                  name={ids.services}
                  checked={draft.services !== null}
                  onChange={() =>
                    set("services", draft.services ?? gitServices.map((entry) => entry.service.id))
                  }
                  className="accent-accent"
                />
                Only these
              </label>
              {draft.services !== null ? (
                <div className="grid gap-1.5 pl-6">
                  {gitServices.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      The base environment has no git services.
                    </p>
                  ) : null}
                  {gitServices.map(({ service }) => (
                    <div key={service.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`${ids.field}-${service.id}`}
                        checked={draft.services?.includes(service.id) ?? false}
                        onChange={(event) =>
                          set(
                            "services",
                            event.target.checked
                              ? [...(draft.services ?? []), service.id]
                              : (draft.services ?? []).filter((id) => id !== service.id),
                          )
                        }
                      />
                      <label
                        htmlFor={`${ids.field}-${service.id}`}
                        className="text-sm text-foreground"
                      >
                        {service.name}
                      </label>
                    </div>
                  ))}
                </div>
              ) : null}
              <FieldError id={`${ids.services}-error`} error={errors.services} />
            </fieldset>
          </SettingsRow>
          <SwitchRow
            label="Skip draft pull requests"
            description="A draft gets a preview once it is marked ready for review."
            checked={draft.skip_drafts}
            onChange={(value) => set("skip_drafts", value)}
            disabled={disabled}
          />
          <SwitchRow
            label="Comment on the pull request"
            description="One comment per pull request with each service's status and link, kept up to date."
            checked={draft.comment}
            onChange={(value) => set("comment", value)}
            disabled={disabled}
          />
        </SettingsSection>

        <SettingsSection
          title="Lifetime and limits"
          description="Previews cost real servers; these keep them in check."
        >
          <SettingsField
            label="Expire after"
            description="Hours without a push before a preview is torn down."
            hint={`${PREVIEW_LIMITS.ttlHours.min} to ${PREVIEW_LIMITS.ttlHours.max} hours.`}
            inputMode="numeric"
            value={draft.ttl_hours}
            onChange={(event) => set("ttl_hours", event.target.value)}
            error={errors.ttl_hours}
            disabled={disabled}
          />
          <SettingsField
            label="Active previews"
            description="More pull requests wait in a queue until one closes."
            hint={`At most ${PREVIEW_LIMITS.maxActive.max}.`}
            inputMode="numeric"
            value={draft.max_active}
            onChange={(event) => set("max_active", event.target.value)}
            error={errors.max_active}
            disabled={disabled}
          />
          <SettingsRow
            label="Resource caps"
            description="Upper bounds for each preview service; lower base values are kept."
            control="wide"
          >
            <fieldset aria-label="Resource caps" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {capField("replicas", "Replicas")}
              {capField("cpu_millis", "CPU (millicores)")}
              {capField("memory_mb", "Memory (MB)")}
              {capField("volume_mb", "Volume (MB)")}
            </fieldset>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection
          title="Secrets and forks"
          description="A preview never receives another environment's database data."
        >
          <SettingsRow
            label="Same-repository secrets"
            description="Authors of these pull requests already have write access."
            htmlFor={ids.sameRepo}
          >
            <Select
              id={ids.sameRepo}
              aria-describedby={`${ids.sameRepo}-description`}
              value={draft.same_repo_secrets}
              onChange={(event) =>
                set("same_repo_secrets", event.target.value as PreviewSameRepoSecrets)
              }
              disabled={disabled}
            >
              {(Object.keys(SAME_REPO_SECRETS) as PreviewSameRepoSecrets[]).map((value) => (
                <option key={value} value={value}>
                  {SAME_REPO_SECRETS[value]}
                </option>
              ))}
            </Select>
          </SettingsRow>
          <SettingsRow
            label="Pull requests from forks"
            description="Secrets are always withheld from fork previews."
            htmlFor={ids.forkPolicy}
          >
            <Select
              id={ids.forkPolicy}
              aria-describedby={`${ids.forkPolicy}-description`}
              value={draft.fork_policy}
              onChange={(event) => set("fork_policy", event.target.value as PreviewForkPolicy)}
              disabled={disabled}
            >
              {(Object.keys(FORK_POLICIES) as PreviewForkPolicy[]).map((value) => (
                <option key={value} value={value}>
                  {FORK_POLICIES[value]}
                </option>
              ))}
            </Select>
          </SettingsRow>
          {draft.fork_policy === "approval" ? (
            <>
              <div
                role="note"
                className="my-3 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-foreground"
              >
                <ShieldAlertIcon
                  className="mt-0.5 size-4 shrink-0 text-warning"
                  aria-hidden="true"
                />
                <span>
                  Fork builds run untrusted code. Give them a dedicated builder node that never
                  builds this project's other environments, and label it so only it matches the
                  build node selector below. Every new commit needs a fresh approval.
                </span>
              </div>
              <SettingsRow
                label="Build node selector"
                description="Fork pull requests build only on servers carrying every label. Required for approval."
                control="wide"
              >
                <KeyValueEditor
                  label="Build node selector"
                  hideLegend
                  pairs={draft.build_node_selector}
                  onChange={(pairs) => set("build_node_selector", pairs)}
                  keyPlaceholder="pool"
                  valuePlaceholder="untrusted"
                  errors={errors.buildSelectorRows}
                  disabled={disabled}
                  max={16}
                />
                <FieldError id={`${ids.build}-error`} error={errors.build_node_selector} />
              </SettingsRow>
              <SettingsField
                label="Approval label"
                description="Adding this label on GitHub approves the pull request's current commit, like Approve here."
                value={draft.approval_label}
                onChange={(event) => set("approval_label", event.target.value)}
                error={errors.approval_label}
                disabled={disabled}
                maxLength={50}
                inputClassName="font-mono"
              />
            </>
          ) : null}
        </SettingsSection>

        <SettingsSection
          title="Placement"
          description="Where preview workloads run, merged over each service's own selector."
        >
          <SettingsRow
            label="Node selector"
            description="Label pairs a server must carry to run previews. Empty runs them anywhere the service may run."
            control="wide"
          >
            <KeyValueEditor
              label="Node selector"
              hideLegend
              pairs={draft.node_selector}
              onChange={(pairs) => {
                setEdited({ ...draft, node_selector: pairs });
                setErrors({ ...errors, nodeSelectorRows: undefined });
              }}
              keyPlaceholder="pool"
              valuePlaceholder="previews"
              errors={errors.nodeSelectorRows}
              disabled={disabled}
              max={16}
            />
          </SettingsRow>
        </SettingsSection>
      </SettingsStack>
      {saveError ? (
        <p role="alert" className="mt-4 text-sm text-danger">
          {saveError}
        </p>
      ) : null}
      {canEdit ? (
        <SaveBar
          dirty={dirty}
          saving={save.isPending}
          onDiscard={() => {
            setEdited(null);
            setErrors({});
            setSaveError(null);
          }}
        />
      ) : null}
    </form>
  );
}
