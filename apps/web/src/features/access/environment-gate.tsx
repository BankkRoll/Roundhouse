/**
 * Environment protection where people act (ADR 0014): a hook that says whether the caller
 * may deploy, change config or change variables in the environment in view, and the
 * pieces that show it — a "Protected" badge, a disabled control with its reason, and a
 * note above an editor that protection makes read-only.
 *
 * Controls a project role can never use stay hidden as before; only refusals by
 * protection are shown disabled, because the person could act elsewhere and should know
 * why they can't here.
 *
 * @module
 */
import type { Action, ProtectedOperation } from "@roundhouse/shared";
import { Badge, Button, type ButtonProps, Tooltip } from "@roundhouse/ui";
import { LockIcon } from "lucide-react";
import { type ReactNode, useId } from "react";
import type { Environment } from "../../lib/api/deploy-types";
import { describeDenial, useProjectPermissions } from "../../lib/permissions";

/** What the caller may do in one environment, from {@link useEnvironmentGate}. */
export interface EnvironmentGate {
  /** Whether the environment is protected; `false` until known. */
  protected: boolean;
  /** Whether the caller may perform `action` here (protection included). */
  can: (action: Action) => boolean;
  /**
   * Why protection refuses `action` here, in a sentence, or `null` when it is allowed or
   * refused for another reason (the role can't do it anywhere, so the control is hidden).
   */
  locked: (action: Action) => string | null;
}

/**
 * Resolves the caller's access in one environment of a project from their effective
 * access (grants, team grants and protection rules included).
 *
 * @param workspaceId - Workspace id.
 * @param projectId - Project id.
 * @param environment - The environment in view, or `undefined` while it loads.
 * @returns The gate.
 * @example
 * const gate = useEnvironmentGate(workspaceId, projectId, environment);
 * gate.locked("deployments:create"); // "production is protected: only project admins…"
 */
export function useEnvironmentGate(
  workspaceId: string,
  projectId: string,
  environment: Pick<Environment, "id" | "name" | "protected"> | undefined,
): EnvironmentGate {
  const access = useProjectPermissions(workspaceId, projectId);
  const environmentId = environment?.id;
  return {
    protected:
      (environmentId ? access.isProtected(environmentId) : undefined) ??
      environment?.protected ??
      false,
    can: (action) => access.can(action, environmentId),
    locked: (action) =>
      access.denial(action, environmentId) === "environment_protected"
        ? describeDenial("environment_protected", action, environment?.name)
        : null,
  };
}

/** Action gated by each protected operation, for callers that think in operations. */
export const OPERATION_ACTION: Record<ProtectedOperation, Action> = {
  deploy: "deployments:create",
  config: "services:manage",
  variables: "variables:manage",
};

/**
 * "Protected" tag beside an environment's name.
 *
 * @param props - Optional class names.
 * @returns The badge.
 */
export function ProtectedBadge({ className }: { className?: string }) {
  return (
    <Badge
      tone="warning"
      className={className}
      title="Protected: its rules narrow who may deploy and change config and variables"
    >
      <LockIcon aria-hidden="true" className="size-3" />
      Protected
    </Badge>
  );
}

/** Props for {@link LockedButton}. */
export interface LockedButtonProps {
  /** Why the action is unavailable, shown on hover and focus and read by screen readers. */
  reason: string;
  children: ReactNode;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
}

/**
 * A disabled button that still explains itself: wrapped in a focusable element (disabled
 * buttons get no focus or pointer events) with the reason as its tooltip and description.
 *
 * @param props - Reason, label and button styling.
 * @returns The locked control.
 */
export function LockedButton({ reason, children, variant, size, className }: LockedButtonProps) {
  const reasonId = useId();
  return (
    <Tooltip content={reason}>
      <span
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a disabled button can't take focus, so its wrapper does, to announce the reason.
        tabIndex={0}
        aria-describedby={reasonId}
        className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Button variant={variant} size={size} className={className} disabled>
          <LockIcon aria-hidden="true" />
          {children}
        </Button>
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      </span>
    </Tooltip>
  );
}

/**
 * A one-line note above an editor that protection makes read-only for the caller.
 *
 * @param props - The reason.
 * @returns The note.
 */
export function LockedNote({ reason }: { reason: string }) {
  return (
    <p
      role="note"
      className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-foreground"
    >
      <LockIcon className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
      <span>{reason}</span>
    </p>
  );
}
