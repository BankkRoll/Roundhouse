import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DATA_SEED } from "../../mocks/data-db";
import { db, makeNode, WORKSPACE_ID } from "../../mocks/db";
import { servicePath } from "../../test/phase1";
import { findPageHeading, renderApp } from "../../test/render";
import { describeServerKernel, describeServiceKernel } from "./kernel-warning";

const AFFECTED = "7.0.0-14-generic";
const mongo = { database: { engine: "mongodb", version: "8.0" } } as const;

function hel1() {
  return db.nodes.find((node) => node.id === "node_hel1")!;
}

/** Turns the seeded database into MongoDB 8.0 whose volume sits on hel-1. */
function seedMongo(kernel: string) {
  const service = db.deploy.services.find((s) => s.id === DATA_SEED.database)!;
  service.database = { engine: "mongodb", version: "8.0" };
  service.name = "mongodb";
  const node = hel1();
  node.kernel = kernel;
  // NOTE: The seeded heartbeat ages with the run, and a silent server reads as offline.
  node.last_heartbeat_at = Date.now();
}

describe("kernel warnings", () => {
  it("explain affected kernels only", () => {
    expect(describeServerKernel(AFFECTED)).toMatch(/^Linux kernel 7\.0\.0-14-generic is in 6\.19/);
    for (const kernel of ["6.8.0-45-generic", "7.0.14", "garbage", null]) {
      expect(describeServerKernel(kernel)).toBeNull();
    }
  });

  it("explain a service only for MongoDB 8.0+ on an affected kernel", () => {
    const node = { name: "hel-1", kernel: AFFECTED };
    expect(describeServiceKernel(mongo, node)).toBe(
      "hel-1 runs Linux kernel 7.0.0-14-generic, where MongoDB 8.0 and later exit at startup " +
        "(6.19 to 7.0.13). Upgrade the server's kernel to 7.0.14 or later, or move the volume to another server.",
    );
    expect(describeServiceKernel(mongo, { name: "hel-1", kernel: "7.0.14" })).toBeNull();
    expect(describeServiceKernel(mongo, undefined)).toBeNull();
    expect(
      describeServiceKernel({ database: { engine: "postgres", version: "18" } }, node),
    ).toBeNull();
    expect(describeServiceKernel({ database: null }, node)).toBeNull();
  });
});

describe("server page", () => {
  it("warns when the kernel can't run MongoDB 8.0+", async () => {
    hel1().kernel = AFFECTED;
    renderApp(`/w/${WORKSPACE_ID}/servers/node_hel1`);
    await findPageHeading("hel-1");
    const warning = await screen.findByText("MongoDB 8.0+ can't run on this kernel");
    const row = warning.closest("[role=status]") as HTMLElement;
    expect(row).toHaveTextContent(/Linux kernel 7\.0\.0-14-generic is in 6\.19 to 7\.0\.13/);
    expect(within(row).getByRole("link", { name: /SERVER-121912/ })).toHaveAttribute(
      "href",
      "https://jira.mongodb.org/browse/SERVER-121912",
    );
  });

  it("stays quiet on an unaffected kernel", async () => {
    db.nodes.push({
      ...makeNode({ id: "node_fixed", name: "fixed-1", kernel: "7.0.14-1-generic" }),
      workspace_id: WORKSPACE_ID,
    });
    renderApp(`/w/${WORKSPACE_ID}/servers/node_fixed`);
    await findPageHeading("fixed-1");
    expect(await screen.findByText("7.0.14-1-generic")).toBeInTheDocument();
    expect(screen.queryByText("MongoDB 8.0+ can't run on this kernel")).toBeNull();
  });
});

describe("MongoDB 8.0+ service on an affected kernel", () => {
  it("badges the header and explains it next to the volume's server", async () => {
    seedMongo(AFFECTED);
    renderApp(servicePath(DATA_SEED.database, "settings"));
    await findPageHeading("mongodb");
    const badge = await screen.findByText("Kernel");
    expect(badge).toHaveAccessibleDescription(/^hel-1 runs Linux kernel 7\.0\.0-14-generic/);
    const section = await screen.findByRole("region", { name: "Volume" });
    expect(
      await within(section).findByText("MongoDB can't start on this server"),
    ).toBeInTheDocument();
    expect(section).toHaveTextContent(/move the volume to another server/);
  });

  it("shows nothing once the kernel is fixed", async () => {
    seedMongo("7.0.14");
    renderApp(servicePath(DATA_SEED.database, "settings"));
    await findPageHeading("mongodb");
    const section = await screen.findByRole("region", { name: "Volume" });
    expect(await within(section).findByText("hel-1")).toBeInTheDocument();
    expect(screen.queryByText("Kernel")).toBeNull();
    expect(within(section).queryByText("MongoDB can't start on this server")).toBeNull();
  });

  it("fails a deploy with the scheduler's reason", async () => {
    seedMongo(AFFECTED);
    const { user } = renderApp(servicePath(DATA_SEED.database));
    await findPageHeading("mongodb");
    await user.click(screen.getByRole("button", { name: "Deploy" }));
    const table = await screen.findByRole("table");
    const reason =
      "Could not place replica 0: MongoDB 8.0 and later cannot start on Linux kernel " +
      "7.0.0-14-generic (6.19 to 7.0.13). Upgrade the server's kernel to 7.0.14 or later, " +
      "or place the service on another server.";
    expect(await within(table).findByText(reason)).toBeInTheDocument();
    await user.click(within(table).getAllByRole("link", { name: /^Deployment/ })[0]!);
    expect(await screen.findByRole("alert")).toHaveTextContent(reason);
  });
});
