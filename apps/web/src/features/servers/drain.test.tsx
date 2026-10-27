import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { MESH_SEED } from "../../mocks/mesh-db";
import { seedMeshNetwork } from "../../mocks/mesh-handlers";
import { renderApp } from "../../test/render";

const SERVER = `/w/${WORKSPACE_ID}/servers/${MESH_SEED.hel}`;

describe("server maintenance", () => {
  it("drains after confirming, then resumes", async () => {
    seedMeshNetwork();
    signInAs(USERS.admin.id);
    const { user } = renderApp(SERVER);
    const section = await screen.findByRole("region", { name: "Maintenance" });
    await user.click(within(section).getByRole("button", { name: "Drain" }));
    const dialog = await screen.findByRole("dialog", { name: /^Drain / });
    expect(dialog).toHaveTextContent("safe to reboot");
    await user.click(within(dialog).getByRole("checkbox", { name: /Stop services with volumes/ }));
    await user.click(within(dialog).getByRole("button", { name: "Drain server" }));
    expect(await within(section).findByText("Drained")).toBeInTheDocument();
    expect(db.mesh.drains[MESH_SEED.hel]).toMatchObject({ force: true });
    expect(db.audit.at(-1)).toMatchObject({ action: "node.drain_started" });

    await user.click(await within(section).findByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(db.nodes.find((n) => n.id === MESH_SEED.hel)?.status).toBe("online"),
    );
    expect(db.audit.at(-1)).toMatchObject({ action: "node.resumed" });
  });

  it("lists the volume services that block a drain", async () => {
    seedMeshNetwork();
    const now = Date.now();
    db.nodes.find((n) => n.id === MESH_SEED.hel)!.status = "draining";
    db.mesh.drains[MESH_SEED.hel] = {
      id: "drn_1",
      node_id: MESH_SEED.hel,
      status: "blocked",
      force: false,
      moves: [
        {
          workload_id: "wl_1",
          deployment_id: "dep_1",
          service_id: "svc_web",
          environment_id: "env_1",
          replica: 0,
          state: "done",
          to_node_id: MESH_SEED.nbg,
          new_workload_id: "wl_2",
          error: null,
        },
      ],
      blocked: [{ service_id: "svc_pg", environment_id: "env_1", service_name: "postgres" }],
      error: null,
      started_by: null,
      started_at: now,
      finished_at: null,
    };
    renderApp(SERVER);
    const section = await screen.findByRole("region", { name: "Maintenance" });
    expect(await within(section).findByText("Blocked")).toBeInTheDocument();
    expect(within(section).getByRole("alert")).toHaveTextContent("postgres");
    expect(within(section).getByRole("table", { name: "Replica moves" })).toHaveTextContent(
      "Moved",
    );
  });

  it("hides the actions from members", async () => {
    seedMeshNetwork();
    signInAs(USERS.member.id);
    renderApp(SERVER);
    const section = await screen.findByRole("region", { name: "Maintenance" });
    expect(within(section).queryByRole("button", { name: "Drain" })).toBeNull();
  });
});
