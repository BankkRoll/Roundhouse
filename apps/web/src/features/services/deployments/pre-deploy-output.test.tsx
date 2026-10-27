import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CronRun } from "../../../lib/api/cron-client";
import type { DeploymentEvent } from "../../../lib/api/deploy-types";
import { db } from "../../../mocks/db";
import { SEED, servicePath } from "../../../test/phase1";
import { renderApp } from "../../../test/render";

const RUN_ID = "crn_predeploy1";

/** Adds a pre-deploy event to the seeded active web deployment's timeline. */
function addPreDeployEvent(
  type: "pre_deploy_started" | "pre_deploy_finished",
  message: string,
  data: DeploymentEvent["data"],
) {
  const deployment = db.deploy.deployments.find((row) => row.id === SEED.webActive)!;
  db.deploy.events.push({
    id: `dev_${type}`,
    deployment_id: SEED.webActive,
    type,
    message,
    data,
    created_at: deployment.created_at + 80_000,
  });
}

/** Records the pre-deploy command's run and its output, as the API keeps them. */
function addPreDeployRun() {
  const deployment = db.deploy.deployments.find((row) => row.id === SEED.webActive)!;
  const at = deployment.created_at + 75_000;
  const run: CronRun = {
    id: RUN_ID,
    project_id: SEED.project,
    service_id: SEED.web,
    environment_id: SEED.production,
    deployment_id: SEED.webActive,
    status: "succeeded",
    trigger: "pre_deploy",
    scheduled_for: at,
    attempt: 1,
    node_id: "node_hel1",
    exit_code: 0,
    missed_count: null,
    error: null,
    triggered_by: null,
    started_at: at + 1_000,
    finished_at: at + 4_000,
    created_at: at,
    updated_at: at + 4_000,
  };
  db.cron.runs.push(run);
  db.cron.logs[RUN_ID] = [{ ts: at + 2_000, stream: "stdout", text: "migrate: 3 applied" }];
}

async function openTimeline() {
  const app = renderApp(servicePath(SEED.web, `deployments/${SEED.webActive}`));
  await screen.findByRole("heading", { level: 2, name: "3f9c2b1" });
  const timeline = screen.getByRole("heading", { name: "Timeline" }).closest("section")!;
  return { ...app, timeline: timeline as HTMLElement };
}

describe("pre-deploy output from the deployment timeline", () => {
  it("offers View output on the pre-deploy event and opens that run's output", async () => {
    addPreDeployRun();
    addPreDeployEvent("pre_deploy_finished", "Pre-deploy command succeeded", {
      run_id: RUN_ID,
      status: "succeeded",
    });
    const { user, timeline } = await openTimeline();
    const item = within(timeline)
      .getByText("Pre-deploy command succeeded")
      .closest("li") as HTMLElement;
    const view = within(item).getByRole("button", { name: "View output" });
    expect(within(timeline).getAllByRole("button", { name: "View output" })).toHaveLength(1);

    await user.click(view);
    const panel = await screen.findByRole("dialog", { name: `Run ${RUN_ID}` });
    expect(within(panel).getByText("Pre-deploy")).toBeInTheDocument();
    expect(await within(panel).findByText("migrate: 3 applied")).toBeInTheDocument();
  });

  it("leaves View output off a pre-deploy event that names no run", async () => {
    addPreDeployEvent("pre_deploy_started", "Pre-deploy command started", null);
    const { timeline } = await openTimeline();
    expect(within(timeline).getByText("Pre-deploy command started")).toBeInTheDocument();
    expect(within(timeline).queryByRole("button", { name: "View output" })).not.toBeInTheDocument();
  });

  it("leaves View output off events that are not about a pre-deploy command", async () => {
    const { timeline } = await openTimeline();
    expect(within(timeline).getByText("Deployment is live")).toBeInTheDocument();
    expect(within(timeline).queryByRole("button", { name: "View output" })).not.toBeInTheDocument();
  });
});
