import { VARIABLE_NAME_RE } from "@roundhouse/shared";
import { Badge, Button, copyText, EmptyState, Input, Label, Skeleton, toast } from "@roundhouse/ui";
import { Switch } from "@roundhouse/ui/controls";
import { useQueries } from "@tanstack/react-query";
import {
  CheckIcon,
  ClipboardPasteIcon,
  CopyIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  RocketIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import { type FormEvent, useCallback, useId, useMemo, useState } from "react";
import { ErrorState } from "../../../components/error-state";
import { errorMessage, isApiError } from "../../../lib/api/client";
import { deployApi } from "../../../lib/api/deploy-client";
import { usePermissions } from "../../../lib/permissions";
import { useDeploy } from "../../../queries/deployments";
import { queryKeys } from "../../../queries/keys";
import {
  useSaveVariables,
  useServiceVariables,
  useSharedVariables,
} from "../../../queries/variables";
import { findService, useProjectEnvironment } from "../../projects/use-project-environment";
import type { ServicePageProps } from "../service-layout";
import { BulkPasteDialog } from "./bulk-paste-dialog";
import { ReferenceInput } from "./reference-input";
import {
  draftSize,
  EMPTY_DRAFT,
  errorsFromDetails,
  type FieldError,
  mapApiError,
  mergeRows,
  type ReferenceCatalog,
  referenceErrors,
  stageDelete,
  stageSet,
  toPutBody,
  unstage,
  type VariableRow,
  type VariablesDraft,
} from "./variables-model";

const MASK = "••••••••••••";

/** The value with each reference syntax error underlined, for showing where it is. */
function ErrorSpans({ value }: { value: string }) {
  const errors = referenceErrors(value);
  if (errors.length === 0) return null;
  const first = errors[0]!;
  return (
    <div role="alert" className="mt-1 grid gap-0.5 text-xs text-danger">
      <p>
        {first.message}{" "}
        <span className="font-mono">
          (characters {first.start + 1}–{first.end})
        </span>
      </p>
      <p className="truncate font-mono text-[11px] text-muted-foreground">
        {value.slice(0, first.start)}
        <mark className="rounded-[2px] bg-danger/15 text-danger underline decoration-wavy">
          {value.slice(first.start, first.end) || " "}
        </mark>
        {value.slice(first.end)}
      </p>
    </div>
  );
}

/** An error on a saved row, with the offending span of the value marked when known. */
function SpanError({ error, value }: { error: FieldError; value: string | undefined }) {
  const { start, end } = error;
  const span = value !== undefined && start !== undefined && end !== undefined && end >= start;
  return (
    <div role="alert" className="mt-0.5 grid gap-0.5 text-xs text-danger">
      <p>
        {error.message}
        {start !== undefined && end !== undefined ? (
          <span className="font-mono">
            {" "}
            (characters {start + 1}–{end})
          </span>
        ) : null}
      </p>
      {span ? (
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {value.slice(0, start)}
          <mark className="rounded-[2px] bg-danger/15 text-danger underline decoration-wavy">
            {value.slice(start, end) || " "}
          </mark>
          {value.slice(end)}
        </p>
      ) : null}
    </div>
  );
}

const CHANGE_BADGE: Record<
  VariableRow["change"],
  { label: string; tone: "accent" | "warning" | "danger" } | null
> = {
  none: null,
  added: { label: "new", tone: "accent" },
  changed: { label: "staged", tone: "warning" },
  deleted: { label: "deleted", tone: "danger" },
};

interface EditorState {
  key: string;
  value: string;
  isSecret: boolean;
  isNew: boolean;
}

function RowEditor({
  editor,
  catalog,
  onNamespace,
  onChange,
  onDone,
  onCancel,
  keyError,
}: {
  editor: EditorState;
  catalog: ReferenceCatalog;
  onNamespace: (slug: string) => void;
  onChange: (editor: EditorState) => void;
  onDone: () => void;
  onCancel: () => void;
  keyError: string | null;
}) {
  const keyId = useId();
  const valueId = useId();
  const secretId = useId();
  // NOTE: Syntax errors appear once the field is left or submitted, not while a
  // reference is still being typed (an unfinished `${{api` is not a mistake yet).
  const [checked, setChecked] = useState(false);
  const syntax = referenceErrors(editor.value).length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    if (syntax) return;
    onDone();
  }

  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) onCancel();
      }}
      className="grid gap-2 border-b border-border bg-muted/30 px-3 py-3 md:grid-cols-[14rem_minmax(0,1fr)_auto]"
      aria-label={editor.isNew ? "New variable" : `Edit ${editor.key}`}
    >
      <div className="grid content-start gap-1">
        <Label htmlFor={keyId}>Key</Label>
        <Input
          id={keyId}
          value={editor.key}
          readOnly={!editor.isNew}
          onChange={(event) => onChange({ ...editor, key: event.target.value.toUpperCase() })}
          placeholder="DATABASE_URL"
          aria-invalid={keyError ? true : undefined}
          className="font-mono text-xs"
          autoFocus={editor.isNew}
          spellCheck={false}
        />
        {keyError ? <p className="text-xs text-danger">{keyError}</p> : null}
      </div>
      <div className="grid content-start gap-1">
        <Label htmlFor={valueId}>Value</Label>
        <ReferenceInput
          id={valueId}
          value={editor.value}
          onValueChange={(value) => onChange({ ...editor, value })}
          catalog={catalog}
          onNamespace={onNamespace}
          placeholder={
            editor.isSecret && !editor.isNew ? "Enter a new value" : `value or \${{service.VAR}}`
          }
          aria-invalid={checked && syntax ? true : undefined}
          onBlur={() => setChecked(true)}
          autoFocus={!editor.isNew}
        />
        {checked ? <ErrorSpans value={editor.value} /> : null}
      </div>
      <div className="flex items-end gap-2">
        <div className="flex h-8 items-center gap-1.5">
          <Switch
            id={secretId}
            checked={editor.isSecret}
            onCheckedChange={(isSecret) => onChange({ ...editor, isSecret })}
          />
          <Label htmlFor={secretId}>Secret</Label>
        </div>
        <Button type="submit" variant="primary" size="sm" className="h-8">
          <CheckIcon />
          {editor.isNew ? "Add" : "Done"}
        </Button>
        <Button variant="ghost" size="sm" className="h-8" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * A service's variables: a table editor with write-only secrets (ADR 0014: they can be
 * replaced, never read back), bulk `.env` paste, `${{` reference autocomplete, and staged
 * changes saved together as one new version, then a prompt to deploy.
 *
 * @param props - Workspace, project and service ids.
 * @returns The tab.
 */
export function VariablesTab({ workspaceId, projectId, serviceId }: ServicePageProps) {
  const { project, environment } = useProjectEnvironment(projectId);
  const service = findService(project.data, serviceId);
  const { can } = usePermissions(workspaceId);
  const canManage = can("variables:manage");
  const variables = useServiceVariables(serviceId, environment?.id);
  const shared = useSharedVariables(projectId, environment?.id, canManage);
  const save = useSaveVariables(serviceId, environment?.id ?? "");
  const deploy = useDeploy();
  const [draft, setDraft] = useState<VariablesDraft>(EMPTY_DRAFT);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, FieldError>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedPrompt, setSavedPrompt] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [namespaces, setNamespaces] = useState<ReadonlySet<string>>(new Set());

  const others = useMemo(
    () => (project.data?.services ?? []).filter((entry) => entry.id !== serviceId),
    [project.data, serviceId],
  );
  const otherVariables = useQueries({
    queries: others
      .filter((entry) => namespaces.has(entry.slug))
      .map((entry) => ({
        queryKey: queryKeys.variables(entry.id, environment?.id ?? ""),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          deployApi.listServiceVariables(entry.id, environment?.id ?? "", signal),
        enabled: Boolean(environment),
        staleTime: 60_000,
      })),
  });
  const rows = useMemo(() => mergeRows(variables.data ?? [], draft), [variables.data, draft]);
  const catalog = useMemo<ReferenceCatalog>(() => {
    const loaded = others.filter((entry) => namespaces.has(entry.slug));
    return {
      services: others.map((entry) => entry.slug),
      ownKeys: rows.filter((row) => row.change !== "deleted").map((row) => row.key),
      sharedKeys: (shared.data ?? []).map((variable) => variable.key),
      serviceKeys: Object.fromEntries(
        loaded.map((entry, index) => [
          entry.slug,
          (otherVariables[index]?.data?.variables ?? []).map((variable) => variable.key),
        ]),
      ),
    };
  }, [others, namespaces, rows, shared.data, otherVariables]);
  const onNamespace = useCallback(
    (slug: string) =>
      setNamespaces((current) => (current.has(slug) ? current : new Set([...current, slug]))),
    [],
  );

  const savedKeys = useMemo(
    () => new Set((variables.data ?? []).map((v) => v.key)),
    [variables.data],
  );
  const pending = draftSize(draft);

  function startEdit(row: VariableRow) {
    setKeyError(null);
    setEditor({
      key: row.key,
      value: row.value ?? "",
      isSecret: row.isSecret,
      isNew: false,
    });
  }

  function commitEditor() {
    if (!editor) return;
    const key = editor.key.trim();
    if (!VARIABLE_NAME_RE.test(key)) {
      setKeyError("Use letters, digits and _; don't start with a digit.");
      return;
    }
    if (editor.isNew && rows.some((row) => row.key === key && row.change !== "deleted")) {
      setKeyError(`${key} already exists; edit it instead.`);
      return;
    }
    const untouchedSecret =
      !editor.isNew &&
      editor.value === "" &&
      savedKeys.has(key) &&
      !draft.set.has(key) &&
      rows.find((row) => row.key === key)?.value === null;
    if (untouchedSecret) {
      // The saved secret is unknown here, so a blank field means "keep it" and it can't
      // be unmasked without typing the value again.
      if (editor.isSecret) {
        setEditor(null);
      } else {
        setKeyError("Enter the value again to store it unmasked.");
      }
      return;
    }
    setDraft((current) =>
      stageSet(current, key, { value: editor.value, isSecret: editor.isSecret }),
    );
    setFieldErrors(({ [key]: _fixed, ...rest }) => rest);
    setSavedPrompt(false);
    setEditor(null);
  }

  function onSave() {
    if (!environment) return;
    const invalid = [...draft.set].find(([, staged]) => referenceErrors(staged.value).length > 0);
    if (invalid) {
      const syntax = referenceErrors(invalid[1].value)[0]!;
      setFieldErrors({
        [invalid[0]]: {
          key: invalid[0],
          field: "value",
          message: syntax.message,
          start: syntax.start,
          end: syntax.end,
        },
      });
      return;
    }
    const { body, setKeys } = toPutBody(draft);
    setSaveError(null);
    setFieldErrors({});
    save.mutate(body, {
      onSuccess: () => {
        setDraft(EMPTY_DRAFT);
        setSavedPrompt(true);
        toast({ title: "Variables saved", description: "Deploy to apply them.", tone: "success" });
      },
      onError: (error) => {
        if (isApiError(error, 400) && error.details.length > 0) {
          setFieldErrors(errorsFromDetails(error.details));
          setSaveError(errorMessage(error));
          return;
        }
        const mapped = isApiError(error, 400)
          ? mapApiError(error.message, setKeys, (body.delete ?? []) as string[])
          : null;
        if (mapped) setFieldErrors({ [mapped.key]: mapped });
        else setSaveError(errorMessage(error));
      },
    });
  }

  function onDeploy() {
    if (!environment) return;
    deploy.mutate(
      { serviceId, environmentId: environment.id },
      {
        onSuccess: () => {
          setSavedPrompt(false);
          toast({ title: `Deploying ${service?.name ?? "service"}`, tone: "success" });
        },
        onError: (error) =>
          toast({ title: "Could not deploy", description: errorMessage(error), tone: "error" }),
      },
    );
  }

  if (variables.isPending) {
    return (
      <div className="grid gap-2" aria-busy="true">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-10" />
        ))}
      </div>
    );
  }
  if (variables.isError) {
    return (
      <ErrorState
        message={errorMessage(variables.error)}
        onRetry={() => void variables.refetch()}
      />
    );
  }

  const editorFor = (key: string | null) =>
    editor && (key === null ? editor.isNew : !editor.isNew && editor.key === key) ? (
      <RowEditor
        editor={editor}
        catalog={catalog}
        onNamespace={onNamespace}
        onChange={(next) => {
          setEditor(next);
          setKeyError(null);
        }}
        onDone={commitEditor}
        onCancel={() => setEditor(null)}
        keyError={keyError}
      />
    ) : null;

  return (
    <section aria-label="Variables" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {rows.length} {rows.length === 1 ? "variable" : "variables"} in{" "}
          <span className="font-mono text-foreground">{environment?.name}</span>. Reference others
          with <code className="font-mono text-xs text-foreground">{`\${{service.VAR}}`}</code> or{" "}
          <code className="font-mono text-xs text-foreground">{`\${{shared.VAR}}`}</code>.
        </p>
        {canManage ? (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setBulkOpen(true)}>
              <ClipboardPasteIcon />
              Paste .env
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setKeyError(null);
                setEditor({ key: "", value: "", isSecret: false, isNew: true });
              }}
            >
              <PlusIcon />
              Add variable
            </Button>
          </div>
        ) : null}
      </div>

      {savedPrompt && pending === 0 ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent-text/40 bg-accent-subtle px-4 py-2.5"
        >
          <p className="text-sm text-foreground">
            Saved as a new version. Running replicas keep the old values until you deploy.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSavedPrompt(false)}>
              Later
            </Button>
            {can("deployments:create") ? (
              <Button variant="primary" size="sm" loading={deploy.isPending} onClick={onDeploy}>
                {deploy.isPending ? null : <RocketIcon />}
                Deploy to apply
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        {editorFor(null)}
        {rows.length === 0 && !editor ? (
          <EmptyState
            icon={<KeyRoundIcon />}
            title="No variables"
            description={
              canManage
                ? "Add configuration and secrets here; they're injected into every replica when you deploy."
                : "This service has no variables."
            }
            className="m-4 border-none"
          />
        ) : (
          <ul aria-label="Variables list">
            {rows.map((row) => {
              const badge = CHANGE_BADGE[row.change];
              const plain = row.value ?? undefined;
              const masked = plain === undefined;
              const error = fieldErrors[row.key] ?? null;
              return (
                <li key={row.key} className="border-b border-border last:border-0">
                  {editorFor(row.key) ?? (
                    <div
                      className="grid items-center gap-x-3 gap-y-1 px-3 py-2 md:grid-cols-[14rem_minmax(0,1fr)_auto]"
                      data-change={row.change}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={`truncate font-mono text-xs ${row.change === "deleted" ? "text-subtle-foreground line-through" : "text-foreground"}`}
                        >
                          {row.key}
                        </span>
                        {row.isSecret ? <Badge>secret</Badge> : null}
                        {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
                      </div>
                      <div className="min-w-0">
                        <span
                          className={`block truncate font-mono text-xs ${masked ? "tracking-widest text-subtle-foreground" : "text-muted-foreground"}`}
                        >
                          {masked ? (
                            <>
                              <span aria-hidden="true">{MASK}</span>
                              <span className="sr-only">value hidden</span>
                            </>
                          ) : (
                            plain || <span className="italic">empty</span>
                          )}
                        </span>
                        {error ? <SpanError error={error} value={plain} /> : null}
                      </div>
                      <div className="flex items-center justify-end gap-0.5">
                        {!masked && plain ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Copy ${row.key}`}
                            onClick={() =>
                              void copyText(plain).then((ok) =>
                                toast({
                                  title: ok ? `Copied ${row.key}` : "Could not copy",
                                  tone: ok ? "success" : "error",
                                }),
                              )
                            }
                          >
                            <CopyIcon />
                          </Button>
                        ) : null}
                        {canManage ? (
                          row.change === "none" ? (
                            <>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Edit ${row.key}`}
                                onClick={() => startEdit(row)}
                              >
                                <PencilIcon />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Delete ${row.key}`}
                                onClick={() => {
                                  setDraft((current) => stageDelete(current, row.key, true));
                                  setSavedPrompt(false);
                                }}
                              >
                                <Trash2Icon />
                              </Button>
                            </>
                          ) : (
                            <>
                              {row.change !== "deleted" ? (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`Edit ${row.key}`}
                                  onClick={() => startEdit(row)}
                                >
                                  <PencilIcon />
                                </Button>
                              ) : null}
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Undo changes to ${row.key}`}
                                onClick={() => setDraft((current) => unstage(current, row.key))}
                              >
                                <Undo2Icon />
                              </Button>
                            </>
                          )
                        ) : null}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {pending > 0 ? (
        <div className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-strong bg-surface-raised px-4 py-2.5 shadow-xl shadow-black/30">
          <div className="grid gap-0.5">
            <p className="text-sm text-foreground">
              {pending} staged {pending === 1 ? "change" : "changes"}
            </p>
            {saveError ? (
              <p role="alert" className="text-xs text-danger">
                {saveError}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Saving writes a new version of this service's variables.
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(EMPTY_DRAFT);
                setFieldErrors({});
                setSaveError(null);
              }}
            >
              Discard
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={onSave}>
              Save changes
            </Button>
          </div>
        </div>
      ) : null}

      <BulkPasteDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        existingKeys={savedKeys}
        onApply={(entries, secret) => {
          setDraft((current) =>
            entries.reduce(
              (next, entry) => stageSet(next, entry.key, { value: entry.value, isSecret: secret }),
              current,
            ),
          );
          setSavedPrompt(false);
          toast({
            title: `Staged ${entries.length} ${entries.length === 1 ? "variable" : "variables"}`,
            tone: "success",
          });
        }}
      />
    </section>
  );
}
