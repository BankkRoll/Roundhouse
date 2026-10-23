import {
  API_TOKEN_PRESETS,
  type ApiTokenScope,
  type Role,
  scopesBeyondRole,
} from "@roundhouse/shared";
import {
  Button,
  Checkbox,
  CodeBlock,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
} from "@roundhouse/ui";
import { TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { FormField } from "../../components/form-field";
import { errorMessage } from "../../lib/api/client";
import type { CreatedApiToken } from "../../lib/api/deploy-types";
import { usePermissions } from "../../lib/permissions";
import { useCreateApiToken } from "../../queries/tokens";
import { ORDERED_SCOPES, SCOPE_CHOICES, SCOPE_LABELS, type ScopeChoice } from "./token-scopes";

/** Lifetimes offered when creating a token, in days; `null` never expires. */
export const TOKEN_EXPIRY_OPTIONS: readonly { days: number | null; label: string }[] = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
  { days: null, label: "Never" },
];

const DEFAULT_EXPIRY_INDEX = 2;
const MAX_NAME = 100;

/** Props for {@link CreateTokenDialog}. */
export interface CreateTokenDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function scopesOf(choice: ScopeChoice, custom: ReadonlySet<ApiTokenScope>): ApiTokenScope[] {
  return choice === "custom"
    ? ORDERED_SCOPES.filter((scope) => custom.has(scope))
    : [...API_TOKEN_PRESETS[choice]];
}

function CreateForm({
  workspaceId,
  role,
  onCreated,
  onCancel,
}: {
  workspaceId: string;
  role: Role;
  onCreated: (created: CreatedApiToken) => void;
  onCancel: () => void;
}) {
  const create = useCreateApiToken(workspaceId);
  const [name, setName] = useState("");
  const [choice, setChoice] = useState<ScopeChoice>("read");
  const [custom, setCustom] = useState<ReadonlySet<ApiTokenScope>>(new Set());
  const [expiry, setExpiry] = useState(DEFAULT_EXPIRY_INDEX);
  const [nameError, setNameError] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const expiryId = useId();
  const scopesHintId = useId();
  const scopeIdPrefix = useId();
  const scopes = scopesOf(choice, custom);

  function toggle(scope: ApiTokenScope, on: boolean) {
    const next = new Set(custom);
    if (on) next.add(scope);
    else next.delete(scope);
    setCustom(next);
    setScopeError(null);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    setNameError(trimmed ? null : "Name the token after where it's used, like github-actions.");
    setScopeError(scopes.length > 0 ? null : "Pick at least one permission.");
    if (!trimmed || scopes.length === 0) return;
    create.mutate(
      {
        name: trimmed,
        scopes,
        expires_in_days: TOKEN_EXPIRY_OPTIONS[expiry]?.days ?? null,
      },
      { onSuccess: onCreated },
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-5" noValidate aria-label="Create API token">
      <FormField
        label="Name"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setNameError(null);
        }}
        placeholder="github-actions"
        maxLength={MAX_NAME}
        error={nameError}
        hint="Shown in the audit log next to everything the token does."
        autoFocus
        spellCheck={false}
      />
      <fieldset className="grid gap-2" aria-describedby={scopeError ? scopesHintId : undefined}>
        <legend className="mb-1 text-sm font-medium text-foreground">Permissions</legend>
        {(Object.keys(SCOPE_CHOICES) as ScopeChoice[]).map((option) => {
          const beyond =
            option === "custom" ? [] : scopesBeyondRole(role, API_TOKEN_PRESETS[option]);
          const disabled = beyond.length > 0;
          return (
            <label
              key={option}
              className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-background px-3 py-2 transition-colors has-[:checked]:border-accent-text has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
            >
              <input
                type="radio"
                name="scope-choice"
                value={option}
                checked={choice === option}
                disabled={disabled}
                onChange={() => {
                  setChoice(option);
                  setScopeError(null);
                }}
                className="mt-0.5 size-3.5 shrink-0 accent-accent-text focus-visible:ring-2 focus-visible:ring-ring"
              />
              <span className="grid gap-0.5">
                <span className="text-sm text-foreground">{SCOPE_CHOICES[option].label}</span>
                <span className="text-xs text-muted-foreground">
                  {disabled
                    ? `Needs ${beyond.join(", ")}, which your role can't grant.`
                    : SCOPE_CHOICES[option].description}
                </span>
              </span>
            </label>
          );
        })}
        {choice === "custom" ? (
          <ul
            aria-label="Scopes"
            className="grid max-h-56 gap-1 overflow-y-auto rounded-md border border-border bg-background p-2 sm:grid-cols-2"
          >
            {ORDERED_SCOPES.map((scope) => {
              const grantable = scopesBeyondRole(role, [scope]).length === 0;
              const id = `${scopeIdPrefix}-${scope.replace(":", "-")}`;
              return (
                <li key={scope}>
                  <label
                    htmlFor={id}
                    className="flex cursor-pointer items-start gap-2 rounded-sm px-1.5 py-1 text-xs text-foreground hover:bg-muted has-[:disabled]:cursor-not-allowed has-[:disabled]:text-muted-foreground has-[:disabled]:hover:bg-transparent"
                    title={grantable ? scope : `${scope}: your role can't grant this`}
                  >
                    <Checkbox
                      id={id}
                      checked={custom.has(scope)}
                      disabled={!grantable}
                      onChange={(event) => toggle(scope, event.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      {SCOPE_LABELS[scope]}
                      {grantable ? null : (
                        <span className="sr-only"> (your role can't grant this)</span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : null}
        {scopeError ? (
          <p id={scopesHintId} className="text-xs text-danger">
            {scopeError}
          </p>
        ) : null}
      </fieldset>
      <div className="grid max-w-56 gap-1.5">
        <Label htmlFor={expiryId}>Expires after</Label>
        <Select
          id={expiryId}
          value={expiry}
          onChange={(event) => setExpiry(Number(event.target.value))}
        >
          {TOKEN_EXPIRY_OPTIONS.map((option, index) => (
            <option key={option.label} value={index}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
      {create.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(create.error)}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          Create token
        </Button>
      </DialogFooter>
    </form>
  );
}

function SecretStep({ created, onDone }: { created: CreatedApiToken; onDone: () => void }) {
  return (
    <div className="grid gap-4">
      <p
        role="status"
        className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-foreground"
      >
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <span>
          Copy <span className="font-mono">{created.token.name}</span> now and store it somewhere
          safe, like your CI's secret store.{" "}
          <strong className="font-medium">You won't be able to see it again.</strong>
        </span>
      </p>
      <CodeBlock code={created.secret} label="API token" />
      <p className="text-xs text-muted-foreground">
        Send it as <span className="font-mono">Authorization: Bearer {"<token>"}</span>. If it
        leaks, revoke it here and create a new one.
      </p>
      <DialogFooter>
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

/**
 * Creates an API token: name, permissions (a preset or a hand-picked list, limited to
 * what the caller's role can grant) and lifetime, then shows the secret once with a copy
 * button. Closing the dialog forgets the secret.
 *
 * @param props - Workspace and controlled open state.
 * @returns The dialog.
 */
export function CreateTokenDialog({ workspaceId, open, onOpenChange }: CreateTokenDialogProps) {
  const { role } = usePermissions(workspaceId);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);

  function close() {
    onOpenChange(false);
    setCreated(null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{created ? "Token created" : "Create API token"}</DialogTitle>
          <DialogDescription>
            {created
              ? "This is the only time the token is shown."
              : "Tokens act for this workspace with the permissions you pick, for scripts, CI and the CLI."}
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <SecretStep created={created} onDone={close} />
        ) : open && role ? (
          <CreateForm
            workspaceId={workspaceId}
            role={role}
            onCreated={setCreated}
            onCancel={close}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
