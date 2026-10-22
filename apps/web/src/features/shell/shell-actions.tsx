import { createContext, useContext } from "react";

/** Shell-level dialogs that any page or command can open. */
export interface ShellActions {
  /** Opens the add-server dialog, which mints a join token. */
  openAddServer: () => void;
  /** Opens the invite-member dialog. */
  openInviteMember: () => void;
}

/** Provides {@link ShellActions} to everything under the app shell. */
export const ShellActionsContext = createContext<ShellActions | null>(null);

/**
 * Reads the shell's actions.
 *
 * @returns The actions.
 * @throws When used outside the app shell.
 */
export function useShellActions(): ShellActions {
  const actions = useContext(ShellActionsContext);
  if (!actions) throw new Error("useShellActions must be used inside <AppShell>");
  return actions;
}
