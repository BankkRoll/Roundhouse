/**
 * Rotating a database's credentials (ADR 0004): the row that starts a rotation, or
 * finishes an interrupted one, the dialog choosing which principals change, and the
 * recent rotations with what each applied and redeployed. Passwords are never shown;
 * the API never returns them.
 *
 * @module
 */
import { databasePrincipals, type ServiceDatabaseEngine } from "@roundhouse/shared";
import { Badge, Button, Checkbox, Label, SettingsRow, toast } from "@roundhouse/ui";
import { TriangleAlertIcon } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import type { CredentialRotation, DatabasePrincipal } from "../../lib/api/data-client";
import type { Environment, Service } from "../../lib/api/deploy-types";
import { formatRelativeTime, formatTimestamp } from "../../lib/format";
import { usePermissions } from "../../lib/permissions";
import { useCredentialRotations, useRotateCredentials } from "../../queries/databases";
import { actionError } from "./backups-tab";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const STATUS: Record<CredentialRotation["status"], { label: string; tone: Tone }> = {
  running: { label: "Unfinished", tone: "warning" },
  succeeded: { label: "Rotated", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

const PRINCIPAL: Record<DatabasePrincipal, { label: string; description: string }> = {
  admin: { label: "Admin", description: "The engine's superuser, which apps connect as." },
  app: { label: "App user", description: "MySQL's application user (MYSQL_USER)." },
  readonly: { label: "Read-only", description: "The data browser's read-only user." },
};

/** Display order: the credential apps use first. */
const ORDER: readonly DatabasePrincipal[] = ["admin", "app", "readonly"];

/**
 * The principals an engine has, in display order. `app` exists only for MySQL.
 *
 * @param engine - The database engine.
 * @returns The principals.
 */
export function enginePrincipals(engine: ServiceDatabaseEngine): DatabasePrincipal[] {
  const present = new Set(databasePrincipals(engine).map((p) => p.principal));
  return ORDER.filter((principal) => present.has(principal));
}

const principalList = (principals: readonly DatabasePrincipal[]) =>
  principals.map((p) => PRINCIPAL[p].label.toLowerCase()).join(", ");

// -----------------------------------------------------------------------------
// Dialog
// -----------------------------------------------------------------------------

function RotateDialog({
  service,
  engine,
  environment,
  resuming,
  open,
  onOpenChange,
}: {
  service: Service;
  engine: ServiceDatabaseEngine;
  environment: Environment;
  /** The interrupted rotation to finish, if any. */
  resuming: CredentialRotation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rotate = useRotateCredentials(service.id, environment.id);
  const available = enginePrincipals(engine);
  const [selected, setSelected] = useState<ReadonlySet<DatabasePrincipal>>(new Set(available));
  const groupId = useId();
  const principals = resuming
    ? resuming.principals
    : available.filter((principal) => selected.has(principal));

  function toggle(principal: DatabasePrincipal, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(principal);
    else next.delete(principal);
    setSelected(next);
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          rotate.reset();
          setSelected(new Set(available));
        }
      }}
      title={
        resuming
          ? `Finish rotating ${service.name}'s credentials?`
          : `Rotate ${service.name}'s credentials?`
      }
      description={
        resuming
          ? `A rotation of the ${principalList(resuming.principals)} password${resuming.principals.length > 1 ? "s" : ""} started ${formatRelativeTime(resuming.created_at)} and didn't finish. Finishing it stores the passwords the database already accepted and redeploys.`
          : `New passwords are set in ${service.name} in ${environment.name} and stored as write-only variables. Nobody sees them.`
      }
      confirmLabel={resuming ? "Finish rotation" : "Rotate and redeploy"}
      confirmText={service.slug}
      confirmDisabled={principals.length === 0}
      pending={rotate.isPending}
      error={rotate.isError ? actionError(rotate.error) : null}
      onConfirm={() =>
        rotate.mutate(
          {
            confirm: service.slug,
            ...(principals.length === available.length && !resuming ? {} : { principals }),
          },
          {
            onSuccess: (rotation) => {
              onOpenChange(false);
              setSelected(new Set(available));
              toast({
                title:
                  rotation.status === "succeeded"
                    ? "Credentials rotated"
                    : `Rotation ${STATUS[rotation.status].label.toLowerCase()}`,
                description:
                  rotation.deployment_ids.length > 0
                    ? `Redeploying ${rotation.deployment_ids.length} service${rotation.deployment_ids.length > 1 ? "s" : ""}.`
                    : undefined,
                tone: rotation.status === "succeeded" ? "success" : "error",
              });
            },
          },
        )
      }
    >
      {resuming ? null : (
        <fieldset className="grid gap-2" aria-describedby={`${groupId}-hint`}>
          <legend className="mb-1 text-sm font-medium text-foreground">Passwords to rotate</legend>
          {available.map((principal) => {
            const id = `${groupId}-${principal}`;
            return (
              <div key={principal} className="flex items-start gap-2">
                <Checkbox
                  id={id}
                  checked={selected.has(principal)}
                  onChange={(event) => toggle(principal, event.target.checked)}
                />
                <Label htmlFor={id} className="grid gap-0.5 font-normal">
                  <span className="text-sm text-foreground">{PRINCIPAL[principal].label}</span>
                  <span className="text-xs text-muted-foreground">
                    {PRINCIPAL[principal].description}
                  </span>
                </Label>
              </div>
            );
          })}
          <p id={`${groupId}-hint`} className="text-xs text-muted-foreground">
            {principals.length === 0 ? "Choose at least one." : null}
          </p>
        </fieldset>
      )}
      <div
        role="note"
        className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-[13px] text-foreground"
      >
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <p>
          {service.name} and every service using these credentials are redeployed, so each restarts
          briefly. Anything still holding an old password stops connecting.
        </p>
      </div>
    </ConfirmDialog>
  );
}

// -----------------------------------------------------------------------------
// Rows
// -----------------------------------------------------------------------------

/** Props for {@link CredentialRotationRows}. */
export interface CredentialRotationRowsProps {
  workspaceId: string;
  service: Service;
  engine: ServiceDatabaseEngine;
  environment: Environment | undefined;
}

/**
 * The database section's credential rows: "Rotate credentials…", an offer to finish an
 * interrupted rotation, and the recent rotations.
 *
 * @param props - Workspace, the database service, its engine and the environment.
 * @returns Settings rows.
 */
export function CredentialRotationRows({
  workspaceId,
  service,
  engine,
  environment,
}: CredentialRotationRowsProps) {
  const { can } = usePermissions(workspaceId);
  const rotations = useCredentialRotations(service.id, environment?.id);
  const [dialog, setDialog] = useState<"rotate" | "finish" | null>(null);
  const canRotate = can("data:write") && can("variables:manage") && can("deployments:create");
  const recent = rotations.data?.rotations ?? [];
  const interrupted = recent.find((row) => row.status === "running") ?? null;

  return (
    <>
      <SettingsRow
        label="Credentials"
        description={`Generated when the database was added and stored write-only. Rotating sets new passwords, then redeploys ${service.name} and every service using them: a brief outage for each.`}
      >
        {canRotate && environment ? (
          <div className="md:flex md:justify-end">
            <Button variant="secondary" onClick={() => setDialog("rotate")}>
              Rotate credentials…
            </Button>
          </div>
        ) : undefined}
      </SettingsRow>
      {interrupted ? (
        <SettingsRow
          label="A rotation didn't finish"
          description={`The ${principalList(interrupted.principals)} password change started ${formatRelativeTime(interrupted.created_at)}${interrupted.error ? ` and stopped: ${interrupted.error}` : ""}. Until it finishes, the database may expect passwords the variables don't hold yet.`}
        >
          {canRotate ? (
            <div className="md:flex md:justify-end">
              <Button variant="primary" onClick={() => setDialog("finish")}>
                Finish rotation
              </Button>
            </div>
          ) : undefined}
        </SettingsRow>
      ) : null}
      {recent.length > 0 ? (
        <SettingsRow label="Recent rotations" control="wide">
          <ul aria-label="Recent rotations" className="divide-y divide-border/70">
            {recent.slice(0, 5).map((row) => (
              <li
                key={row.id}
                className="grid gap-x-4 gap-y-0.5 py-2 text-sm first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"
              >
                <span className="min-w-0 text-foreground">
                  {principalList(row.applied.length > 0 ? row.applied : row.principals)}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {row.status === "succeeded"
                      ? `${row.deployment_ids.length} redeploy${row.deployment_ids.length === 1 ? "" : "s"}`
                      : (row.error ?? `${row.applied.length} of ${row.principals.length} applied`)}
                  </span>
                </span>
                <Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge>
                <span
                  className="text-xs text-muted-foreground tabular-nums"
                  title={formatTimestamp(row.created_at)}
                >
                  {formatRelativeTime(row.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </SettingsRow>
      ) : null}
      {environment ? (
        <RotateDialog
          service={service}
          engine={engine}
          environment={environment}
          resuming={dialog === "finish" ? interrupted : null}
          open={dialog !== null}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
        />
      ) : null}
    </>
  );
}
