/**
 * Query keys for every cached resource. Workspace-scoped keys share a prefix so a whole
 * workspace can be invalidated at once.
 */
export const queryKeys = {
  setup: ["setup"] as const,
  me: ["me"] as const,
  invite: (token: string) => ["invites", token] as const,
  workspace: (workspaceId: string) => ["workspaces", workspaceId] as const,
  members: (workspaceId: string) => ["workspaces", workspaceId, "members"] as const,
  invites: (workspaceId: string) => ["workspaces", workspaceId, "invites"] as const,
  nodes: (workspaceId: string) => ["workspaces", workspaceId, "nodes"] as const,
  node: (workspaceId: string, nodeId: string) =>
    ["workspaces", workspaceId, "nodes", nodeId] as const,
  audit: (workspaceId: string) => ["workspaces", workspaceId, "audit"] as const,
};
