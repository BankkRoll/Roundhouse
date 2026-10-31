import type { Action } from "@roundhouse/shared";
import type { EnvironmentGate } from "../access/environment-gate";

const ACTION_WORDS: Partial<Record<Action, string>> = {
  "backups:manage": "manage backups",
  "backups:restore": "restore backups",
  "services:manage": "change service settings",
  "deployments:create": "deploy",
};

/**
 * Why the caller can't take an action that needs every one of `actions` in the
 * environment, for a locked control: protection's own sentence when protection refuses
 * it, otherwise the permission the role lacks.
 *
 * @param gate - The environment gate.
 * @param actions - Everything the action needs, most specific first.
 * @param what - The action, as the start of a sentence, e.g. "Restoring to a point in time".
 * @returns The reason, or `null` when the caller may.
 * @example
 * lockReason(gate, ["backups:restore"], "Restoring");
 * // "Restoring needs permission to restore backups. Ask a project admin for more access."
 */
export function lockReason(
  gate: Pick<EnvironmentGate, "can" | "locked">,
  actions: readonly Action[],
  what: string,
): string | null {
  for (const action of actions) {
    if (gate.can(action)) continue;
    return (
      gate.locked(action) ??
      `${what} needs permission to ${ACTION_WORDS[action] ?? action}. Ask a project admin for more access.`
    );
  }
  return null;
}
