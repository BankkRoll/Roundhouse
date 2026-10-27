/**
 * `CertificateWorkflow`: one issuance attempt of a control-plane certificate
 * (ADR 0009, `managed` TLS mode). Instance ID `<certificate id>-<attempt>`;
 * the minute tick starts it (`lib/certificates/schedule.ts`) and the steps
 * are those of `runCertificateAttempt` (`lib/certificates/pipeline.ts`).
 *
 * Each step is retried on transport trouble; a definitive answer from the
 * CA or Cloudflare ends the attempt at once, and the next one is scheduled
 * with backoff.
 *
 * @module
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createDb } from "@roundhouse/db";
import type { Env } from "../env";
import type { Steps } from "../lib/certificates/order";
import {
  type CertificateAttempt,
  failureMessage,
  isDefinitive,
  isPublicError,
  PUBLIC_ERROR_PREFIX,
  runCertificateAttempt,
} from "../lib/certificates/pipeline";

/** Parameters of one attempt. */
export type CertificateParams = CertificateAttempt;

const STEP = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

/**
 * Adapts the workflow's `step` to {@link Steps}, classifying errors so that
 * refusals aren't retried and their reasons survive the step boundary.
 *
 * @param step - The workflow step API.
 * @returns The step runner.
 */
export function workflowSteps(step: WorkflowStep): Steps {
  return {
    do: async <T>(name: string, fn: () => Promise<T>) =>
      (await step.do(name, STEP, async () => {
        try {
          return (await fn()) as never;
        } catch (err) {
          if (!isPublicError(err)) throw err;
          const message = `${PUBLIC_ERROR_PREFIX}${failureMessage(err)}`;
          throw isDefinitive(err) ? new NonRetryableError(message) : new Error(message);
        }
      })) as T,
    sleep: (name, ms) => step.sleep(name, ms),
  };
}

/** One issuance attempt. */
export class CertificateWorkflow extends WorkflowEntrypoint<Env, CertificateParams> {
  override async run(
    event: Readonly<WorkflowEvent<CertificateParams>>,
    step: WorkflowStep,
  ): Promise<{ outcome: string }> {
    const outcome = await runCertificateAttempt(
      this.env,
      createDb(this.env.DB),
      event.payload,
      workflowSteps(step),
    );
    return { outcome };
  }
}
