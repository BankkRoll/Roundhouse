import { useSearch } from "@tanstack/react-router";
import type { Environment, ProjectDetail } from "../../lib/api/deploy-types";
import { pickEnvironment, useProject } from "../../queries/projects";

/** A project and the environment its pages are showing. */
export interface ProjectEnvironment {
  project: ReturnType<typeof useProject>;
  /** The selected environment; `undefined` while the project loads. */
  environment: Environment | undefined;
  /**
   * The `env` search param to carry on links inside the project: the selected slug, or
   * `undefined` for production so default URLs stay clean.
   */
  envParam: string | undefined;
}

/**
 * Resolves the environment selected by the `?env=` search param (production when absent
 * or unknown) for a project's pages.
 *
 * @param projectId - Project id.
 * @returns The project query, the environment, and the param to keep on links.
 */
export function useProjectEnvironment(projectId: string): ProjectEnvironment {
  const search = useSearch({ strict: false }) as { env?: string };
  const project = useProject(projectId);
  const environment = project.data
    ? pickEnvironment(project.data.environments, search.env)
    : undefined;
  return {
    project,
    environment,
    envParam: environment && environment.kind !== "production" ? environment.slug : undefined,
  };
}

/**
 * Finds a service in a project by id.
 *
 * @param project - Project detail, or `undefined` while loading.
 * @param serviceId - Service id.
 * @returns The service, if the project has it.
 */
export function findService(project: ProjectDetail | undefined, serviceId: string) {
  return project?.services.find((service) => service.id === serviceId);
}
