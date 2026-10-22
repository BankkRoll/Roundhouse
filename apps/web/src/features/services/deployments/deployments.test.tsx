import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, signInAs, USERS } from "../../../mocks/db";
import { pushRealtime, SEED, servicePath } from "../../../test/phase1";
import { expectPath, findPageHeading, renderApp } from "../../../test/render";

async function openWeb() {
  const app = renderApp(servicePath(SEED.web));
  await findPageHeading("web");
  const table = await screen.findByRole("table");
  return { ...app, table };
}

function row(table: HTMLElement, ref: string) {
  return within(table)
    .getByRole("link", { name: new RegExp(`^Deployment ${ref}`) })
    .closest("tr")!;
}

describe("deployments tab", () => {
  it("lists deployments with status, commit, trigger, duration and age", async () => {
    const { table } = await openWeb();
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    const current = row(table, "3f9c2b1");
    expect(current).toHaveTextContent(/active/i);
    expect(current).toHaveTextContent("current");
    expect(current).toHaveTextContent("Fix cart totals rounding");
    expect(current).toHaveTextContent("git push");
    expect(current).toHaveTextContent("1m 40s");
    expect(current).toHaveTextContent("2h ago");
    expect(row(table, "5c4b3a2")).toHaveTextContent("Build failed: pnpm build exited with code 1");
  });

  it("deploys from the header and shows the new deployment", async () => {
    const { user, table } = await openWeb();
    await user.click(screen.getByRole("button", { name: "Deploy" }));
    expect(await screen.findByText("Deploying web")).toBeInTheDocument();
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(6));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent(/queued/i);
  });

  it("redeploys the same commit", async () => {
    const { user, table } = await openWeb();
    await user.click(
      within(row(table, "a1b2c3d")).getByRole("button", { name: /Actions for deployment/ }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Redeploy" }));
    expect(await screen.findByText("Redeploying")).toBeInTheDocument();
    expect(db.deploy.builds.at(-1)?.commit_sha).toBe("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
  });

  it("rolls back to a previous successful deployment after confirming", async () => {
    const { user, table } = await openWeb();
    await user.click(within(row(table, "3f9c2b1")).getByRole("button", { name: /Actions/ }));
    expect(screen.queryByRole("menuitem", { name: "Roll back to this" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(within(row(table, "5c4b3a2")).getByRole("button", { name: /Actions/ }));
    expect(screen.queryByRole("menuitem", { name: "Roll back to this" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(within(row(table, "a1b2c3d")).getByRole("button", { name: /Actions/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Roll back to this" }));
    const dialog = await screen.findByRole("dialog", { name: "Roll back to a1b2c3d?" });
    expect(dialog).toHaveTextContent("v2");
    await user.click(within(dialog).getByRole("button", { name: "Roll back" }));
    expect(await screen.findByText("Rolling back")).toBeInTheDocument();
    expect(db.deploy.deployments.at(-1)).toMatchObject({
      trigger: "rollback",
      rollback_of: SEED.webOld,
    });
    await waitFor(() => expect(within(table).getAllByRole("row")[1]).toHaveTextContent("rollback"));
  });

  it("cancels an in-flight deployment optimistically", async () => {
    const { user } = renderApp(servicePath(SEED.worker));
    const table = await screen.findByRole("table");
    await user.click(within(table).getByRole("button", { name: /Actions/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Cancel deployment" }));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent(/cancelled/i);
    expect(await screen.findByText("Deployment cancelled")).toBeInTheDocument();
    expect(db.deploy.deployments.find((d) => d.id === SEED.workerDeploying)?.status).toBe(
      "cancelled",
    );
  });

  it("restores the row when the API refuses to cancel", async () => {
    const { user } = renderApp(servicePath(SEED.worker));
    const table = await screen.findByRole("table");
    db.deploy.deployments.find((d) => d.id === SEED.workerDeploying)!.status = "active";
    await user.click(within(table).getByRole("button", { name: /Actions/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Cancel deployment" }));
    expect(await screen.findByText("Could not cancel")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(table).getAllByRole("row")[1]).toHaveTextContent(/deploying|active/i),
    );
  });

  it("updates rows live from the socket", async () => {
    const { table } = await openWeb();
    const failed = db.deploy.deployments.find((d) => d.id === SEED.webFailed)!;
    pushRealtime({
      type: "deployment.updated",
      deployment: {
        ...failed,
        build: db.deploy.builds.find((b) => b.id === failed.build_id) ?? null,
        failure_reason: "Superseded by dep_x",
        updated_at: Date.now(),
      },
    });
    await waitFor(() => expect(row(table, "5c4b3a2")).toHaveTextContent("Superseded by dep_x"));
  });

  it("hides deploy actions from viewers", async () => {
    signInAs(USERS.viewer.id);
    const { user, table } = await openWeb();
    expect(screen.queryByRole("button", { name: "Deploy" })).not.toBeInTheDocument();
    await user.click(within(row(table, "a1b2c3d")).getByRole("button", { name: /Actions/ }));
    expect(await screen.findByRole("menuitem", { name: "View logs" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Redeploy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Roll back to this" })).not.toBeInTheDocument();
  });
});

describe("deployment detail", () => {
  it("shows the timeline, replicas and actions", async () => {
    const { user, router } = renderApp(servicePath(SEED.web, `deployments/${SEED.webActive}`));
    expect(await screen.findByRole("heading", { level: 2, name: "3f9c2b1" })).toBeInTheDocument();
    const timeline = screen.getByRole("heading", { name: "Timeline" }).closest("div.rounded-lg")!;
    expect(within(timeline as HTMLElement).getAllByRole("listitem")).toHaveLength(8);
    expect(timeline).toHaveTextContent("Traffic switched to the new replicas");
    const replicas = screen.getByRole("heading", { name: "Replicas" }).closest("div.rounded-lg")!;
    const rows = within(replicas as HTMLElement)
      .getAllByRole("row")
      .slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^#0hel-1Healthy/),
      expect.stringMatching(/^#1hel-1Healthy/),
    ]);
    await user.click(screen.getByRole("button", { name: "Build logs" }));
    await expectPath(router, servicePath(SEED.web, "logs"));
    expect(router.state.location.search).toMatchObject({
      deployment: SEED.webActive,
      source: "build",
    });
  });

  it("appends live timeline events", async () => {
    renderApp(servicePath(SEED.worker, `deployments/${SEED.workerDeploying}`));
    expect(await screen.findByText("Scheduled 1 replica on hel-1")).toBeInTheDocument();
    pushRealtime({
      type: "deployment.event",
      event: {
        id: "dev_live",
        deployment_id: SEED.workerDeploying,
        type: "status_changed",
        message: "Waiting for health checks",
        data: null,
        created_at: Date.now(),
      },
    });
    expect(await screen.findByText("Waiting for health checks")).toBeInTheDocument();
  });

  it("resolves the short /deployments/:id link to its service page", async () => {
    const { router } = renderApp(`/deployments/${SEED.apiActive}`);
    await expectPath(router, servicePath(SEED.api, `deployments/${SEED.apiActive}`));
  });
});
