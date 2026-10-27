/**
 * `PreviewWorkflow`: pull request previews (ADR 0007) as retried steps.
 *
 * Two kinds of instance:
 * - `event` (instance `prv-<pr>-<hash of project, PR and delivery>`): one
 *   `pull_request` delivery for one project. Steps: `approver` (only for
 *   the approval label: the sender's permission, from GitHub's
 *   collaborators API), `apply` ({@link applyPreviewEvent}, D1 only), then
 *   `remove-label`, `teardown`, `create` or `deploy`, and `feedback`.
 * - `action` (instance `prv-<preview id>-<random>`): a dashboard approval
 *   (`approve`: label, then create or deploy), a redeploy, a create the
 *   minute tick admitted from the queue, or just `feedback`.
 *
 * GitHub calls run in their own steps and are best effort for feedback, so
 * GitHub being slow never holds a preview back; the webhook itself only
 * starts the instance and answers within GitHub's 10 s.
 *
 * @module
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createDb, githubInstallations, projects } from "@roundhouse/db";
import { eq } from "drizzle-orm";
import type { Env } from "../env";
import type { KeyEnv } from "../lib/crypto";
import { disposeRpc } from "../lib/deployments";
import { configuredOrigin } from "../lib/origin";
import {
  type AppliedEvent,
  type Approver,
  applyPreviewEvent,
  type PreviewStep,
  runCreateStep,
  runDeployStep,
  runTeardownStep,
} from "../lib/previews/engine";
import type { PreviewEvent } from "../lib/previews/events";
import {
  addLabel,
  collaboratorPermission,
  previewToken,
  removeLabel,
  syncPreviewFeedback,
} from "../lib/previews/github";
import { loadPreviewSettings } from "../lib/previews/settings";
import { findPreview } from "../lib/previews/view";

/** Parameters of a preview workflow instance. */
export type PreviewParams =
  | {
      kind: "event";
      project_id: string;
      delivery_id: string;
      /** Control plane origin when the delivery arrived. */
      origin: string;
      event: PreviewEvent;
    }
  | {
      kind: "action";
      preview_id: string;
      origin: string;
      action: "approve" | "create" | "deploy" | "feedback";
      /** For `approve`: what to run once the label is on. */
      next?: PreviewStep;
    };

const DB_STEP = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

const NETWORK_STEP = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

/**
 * Instance ID of an event instance: short, valid for Workflows, and the
 * same for a repeated start of one delivery, which Workflows then refuse.
 *
 * @param projectId - The project.
 * @param prNumber - The PR.
 * @param deliveryId - `X-GitHub-Delivery`.
 * @returns E.g. `prv-42-3f9a…`.
 */
export async function previewEventInstanceId(
  projectId: string,
  prNumber: number,
  deliveryId: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${projectId}\n${prNumber}\n${deliveryId}`),
    ),
  );
  const hex = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `prv-${prNumber}-${hex}`;
}

/**
 * Starts an `action` instance for a preview.
 *
 * @param env - Bindings with `PREVIEW_WORKFLOW`.
 * @param params - The action.
 */
export async function startPreviewAction(
  env: Pick<Env, "PREVIEW_WORKFLOW">,
  params: Extract<PreviewParams, { kind: "action" }>,
): Promise<void> {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  disposeRpc(
    await env.PREVIEW_WORKFLOW.create({
      id: `${params.preview_id.toLowerCase().replace(/_/g, "-")}-${suffix}`,
      params,
    }),
  );
}

/** Runs one preview event or action. */
export class PreviewWorkflow extends WorkflowEntrypoint<Env, PreviewParams> {
  override async run(event: Readonly<WorkflowEvent<PreviewParams>>, step: WorkflowStep) {
    const params = event.payload;
    const origin = configuredOrigin(this.env) ?? params.origin;
    if (params.kind === "event") return this.onEvent(step, params, origin);
    return this.onAction(step, params, origin);
  }

  private keys(): KeyEnv {
    if (!this.env.MASTER_KEY?.trim()) throw new Error("MASTER_KEY is not configured");
    return this.env;
  }

  private async onEvent(
    step: WorkflowStep,
    params: Extract<PreviewParams, { kind: "event" }>,
    origin: string,
  ): Promise<{ step: PreviewStep; preview_id: string | null }> {
    const { event } = params;
    const installation = await step.do("installation", DB_STEP, async () => {
      const db = createDb(this.env.DB);
      const [row] = await db
        .select({ id: githubInstallations.id, workspaceId: githubInstallations.workspaceId })
        .from(githubInstallations)
        .where(eq(githubInstallations.installationId, event.installation_id))
        .limit(1);
      const [project] = await db
        .select({ workspaceId: projects.workspaceId })
        .from(projects)
        .where(eq(projects.id, params.project_id))
        .limit(1);
      // SECURITY: re-checked here, not just when the delivery was matched:
      // the installation must still belong to the project's workspace.
      return row && project && row.workspaceId === project.workspaceId
        ? { ref: row.id, workspaceId: row.workspaceId }
        : null;
    });
    if (!installation) return { step: "none", preview_id: null };

    const approver = await step.do("approver", NETWORK_STEP, async (): Promise<Approver | null> => {
      if (event.action !== "labeled" || event.sender.bot) return null;
      const db = createDb(this.env.DB);
      const settings = await loadPreviewSettings(db, params.project_id);
      if (!settings || event.label !== settings.approvalLabel) return null;
      const token = await previewToken(
        db,
        this.keys(),
        {
          workspaceId: installation.workspaceId,
          installationRef: installation.ref,
          repoFullName: event.base.repo_full_name,
        },
        { metadata: "read" },
      );
      return {
        login: event.sender.login,
        permission: await collaboratorPermission(
          token,
          event.base.repo_full_name,
          event.sender.login,
        ),
      };
    });

    const applied: AppliedEvent = await step.do("apply", DB_STEP, () =>
      applyPreviewEvent(
        { db: createDb(this.env.DB) },
        {
          projectId: params.project_id,
          event,
          installationRef: installation.ref,
          approver,
          now: Date.now(),
        },
      ),
    );
    if (!applied.previewId) return { step: "none", preview_id: null };
    const previewId = applied.previewId;

    if (applied.removeLabel) {
      const label = applied.removeLabel;
      await step.do("remove-label", NETWORK_STEP, async () => {
        const db = createDb(this.env.DB);
        try {
          const token = await previewToken(
            db,
            this.keys(),
            {
              workspaceId: installation.workspaceId,
              installationRef: installation.ref,
              repoFullName: event.base.repo_full_name,
            },
            { pull_requests: "write" },
          );
          await removeLabel(token, event.base.repo_full_name, event.number, label);
        } catch (err) {
          console.warn(
            "removing the approval label failed",
            err instanceof Error ? err.message : err,
          );
        }
      });
    }
    await this.runStep(step, applied.step, previewId, origin, applied.teardownEnvironmentId);
    if (applied.feedback) await this.feedback(step, previewId, origin);
    return { step: applied.step, preview_id: previewId };
  }

  private async onAction(
    step: WorkflowStep,
    params: Extract<PreviewParams, { kind: "action" }>,
    origin: string,
  ): Promise<{ step: PreviewStep; preview_id: string }> {
    let run: PreviewStep = "none";
    if (params.action === "approve") {
      await step.do("add-label", NETWORK_STEP, async () => {
        const db = createDb(this.env.DB);
        const preview = await findPreview(db, params.preview_id);
        const settings = preview ? await loadPreviewSettings(db, preview.projectId) : undefined;
        const [project] = preview
          ? await db.select().from(projects).where(eq(projects.id, preview.projectId)).limit(1)
          : [];
        if (!preview || !settings || !project) return;
        try {
          const token = await previewToken(
            db,
            this.keys(),
            {
              workspaceId: project.workspaceId,
              installationRef: preview.installationRef,
              repoFullName: preview.repoFullName,
            },
            { pull_requests: "write" },
          );
          await addLabel(token, preview.repoFullName, preview.prNumber, settings.approvalLabel);
        } catch (err) {
          console.warn(
            "adding the approval label failed",
            err instanceof Error ? err.message : err,
          );
        }
      });
      run = params.next ?? "none";
    } else if (params.action === "create" || params.action === "deploy") {
      run = params.action;
    }
    await this.runStep(step, run, params.preview_id, origin, null);
    await this.feedback(step, params.preview_id, origin);
    return { step: run, preview_id: params.preview_id };
  }

  private async runStep(
    step: WorkflowStep,
    which: PreviewStep,
    previewId: string,
    origin: string,
    teardownEnvironmentId: string | null,
  ): Promise<void> {
    const ctx = () => ({ db: createDb(this.env.DB), env: this.env });
    if (which === "teardown" && teardownEnvironmentId) {
      await step.do("teardown", DB_STEP, async () => {
        const preview = await findPreview(createDb(this.env.DB), previewId);
        if (preview) await runTeardownStep(ctx(), preview.projectId, teardownEnvironmentId);
      });
    } else if (which === "create") {
      await step.do("create", DB_STEP, () => runCreateStep(ctx(), this.keys(), previewId, origin));
    } else if (which === "deploy") {
      await step.do("deploy", DB_STEP, () => runDeployStep(ctx(), previewId, origin));
    }
  }

  private feedback(step: WorkflowStep, previewId: string, origin: string): Promise<boolean> {
    return step.do("feedback", NETWORK_STEP, () =>
      syncPreviewFeedback(this.env, createDb(this.env.DB), previewId, origin),
    );
  }
}
