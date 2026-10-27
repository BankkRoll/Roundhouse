/**
 * Typed endpoint functions for the environment lifecycle (ADR 0007): create or clone,
 * compare, propose a promotion, delete. Types come from the API's route contracts.
 *
 * @module
 */
import type {
  BodyOf,
  createEnvironment,
  EnvironmentDiff,
  promoteEnvironment,
} from "../../../../api/src/contracts";
import type { ChangeSet } from "./changes-types";
import { request } from "./client";
import type { Environment } from "./deploy-types";

export type { EnvironmentDiff };

/** `POST /v1/projects/{projectId}/environments` body. */
export type CreateEnvironmentBody = BodyOf<typeof createEnvironment>;

/** `POST /v1/environments/{environmentId}/promote` body. */
export type PromoteEnvironmentBody = BodyOf<typeof promoteEnvironment>;

const seg = encodeURIComponent;

/** Environment lifecycle endpoints. */
export const environmentsApi = {
  /**
   * Creates an environment, blank or cloned from another.
   *
   * @param projectId - Project id.
   * @param body - Name, kind and clone options.
   * @returns The new environment.
   */
  create: (projectId: string, body: CreateEnvironmentBody) =>
    request<Environment>("POST", `/v1/projects/${seg(projectId)}/environments`, { body }),
  /**
   * What differs between two environments; secrets compare by fingerprint.
   *
   * @param projectId - Project id.
   * @param base - Base environment id.
   * @param target - Target environment id.
   * @param signal - Abort signal.
   * @returns The diff, changed services first.
   */
  diff: (projectId: string, base: string, target: string, signal?: AbortSignal) =>
    request<EnvironmentDiff>("GET", `/v1/projects/${seg(projectId)}/environments/diff`, {
      query: { base, target },
      signal,
    }),
  /**
   * Proposes promoting one environment into another as a change set; never applies it.
   *
   * @param environmentId - Target environment id.
   * @param body - Source and what to include.
   * @returns The proposed change set.
   */
  promote: (environmentId: string, body: PromoteEnvironmentBody) =>
    request<ChangeSet>("POST", `/v1/environments/${seg(environmentId)}/promote`, { body }),
  /**
   * Deletes an environment; `confirm` must be its slug. Needs a fresh session.
   *
   * @param environmentId - Environment id.
   * @param confirm - The slug, typed to confirm.
   */
  remove: (environmentId: string, confirm: string) =>
    request<void>("DELETE", `/v1/environments/${seg(environmentId)}`, { query: { confirm } }),
};
