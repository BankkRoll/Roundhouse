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
  projects: (workspaceId: string) => ["workspaces", workspaceId, "projects"] as const,
  githubStatus: (workspaceId: string) => ["workspaces", workspaceId, "github"] as const,
  githubRepositories: (workspaceId: string) =>
    ["workspaces", workspaceId, "github", "repositories"] as const,
  project: (projectId: string) => ["projects", projectId] as const,
  sharedVariables: (projectId: string, environmentId: string) =>
    ["projects", projectId, "variables", environmentId] as const,
  service: (serviceId: string) => ["services", serviceId] as const,
  serviceConfig: (serviceId: string, environmentId: string) =>
    ["services", serviceId, "config", environmentId] as const,
  variables: (serviceId: string, environmentId: string) =>
    ["services", serviceId, "variables", environmentId] as const,
  deployments: (serviceId: string, environmentId: string) =>
    ["services", serviceId, "deployments", environmentId] as const,
  latestDeployment: (serviceId: string, environmentId: string) =>
    ["services", serviceId, "deployments", environmentId, "latest"] as const,
  domains: (serviceId: string, environmentId: string) =>
    ["services", serviceId, "domains", environmentId] as const,
  deployment: (deploymentId: string) => ["deployments", deploymentId] as const,
  logs: (source: "deployment" | "build", id: string) => ["logs", source, id] as const,
  instanceSettings: ["instance", "settings"] as const,
};
