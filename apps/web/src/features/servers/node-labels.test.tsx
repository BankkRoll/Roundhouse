import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { PROJECT_PATH } from "../../test/phase1";
import { renderApp } from "../../test/render";
import { labelErrors, matchesSelector } from "./node-labels";

const SERVERS = `/w/${WORKSPACE_ID}/servers`;
const hel1 = () => db.nodes.find((node) => node.id === "node_hel1")!;

describe("node labels", () => {
  it("validates keys and values like the API", () => {
    expect(labelErrors([{ key: "pool", value: "untrusted" }])).toEqual({});
    expect(labelErrors([{ key: "", value: "" }])).toEqual({});
    expect(Object.keys(labelErrors([{ key: "Pool", value: "x" }]))).toEqual(["0"]);
    expect(Object.keys(labelErrors([{ key: "pool", value: "-x" }]))).toEqual(["0"]);
    expect(
      labelErrors([
        { key: "pool", value: "a" },
        { key: "pool", value: "b" },
      ]),
    ).toEqual({ 1: "This key is already set." });
    expect(matchesSelector({ pool: "untrusted", region: "x" }, { pool: "untrusted" })).toBe(true);
    expect(matchesSelector({ pool: "trusted" }, { pool: "untrusted" })).toBe(false);
    expect(matchesSelector({}, {})).toBe(true);
  });

  it("edits a server's labels and saves the complete set", async () => {
    const { user } = renderApp(`${SERVERS}/node_hel1`);
    const form = await screen.findByRole("form", { name: "Labels" });
    expect(form).toHaveTextContent("preview build node selector match these labels");
    expect(within(form).getByLabelText("Labels 1 key")).toHaveValue("region");

    await user.click(within(form).getByRole("button", { name: "Add" }));
    await user.type(within(form).getByLabelText("Labels 2 key"), "Pool");
    await user.type(within(form).getByLabelText("Labels 2 value"), "untrusted");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await within(form).findByText(/Keys are lowercase letters/)).toBeInTheDocument();
    expect(hel1().labels).toEqual({ region: "eu-central" });

    const key = within(form).getByLabelText("Labels 2 key");
    await user.clear(key);
    await user.type(key, "pool");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Labels of hel-1 saved")).toBeInTheDocument();
    expect(hel1().labels).toEqual({ region: "eu-central", pool: "untrusted" });
    expect(db.audit.at(-1)).toMatchObject({
      action: "node.labels_updated",
      target_id: "node_hel1",
    });
  });

  it("shows labels read-only without nodes:manage", async () => {
    signInAs(USERS.member.id);
    renderApp(`${SERVERS}/node_hel1`);
    const list = await screen.findByRole("list", { name: "Labels" });
    expect(list).toHaveTextContent("region=eu-central");
    expect(screen.queryByRole("form", { name: "Labels" })).toBeNull();
    expect(screen.queryByLabelText("Labels 1 key")).toBeNull();
  });

  it("lists labels on the servers page", async () => {
    renderApp(SERVERS);
    const list = await screen.findByRole("list", { name: "Servers" });
    await waitFor(() => expect(list).toHaveTextContent("region=eu-central"));
  });
});

describe("preview build node selector", () => {
  const PREVIEWS = `${PROJECT_PATH}/previews`;

  it("warns when no server carries the build node selector's labels", async () => {
    renderApp(PREVIEWS);
    const form = await screen.findByRole("form", { name: "Preview settings" });
    expect(
      await within(form).findByText(
        /No server carries these labels, so fork preview builds will fail/,
      ),
    ).toBeInTheDocument();
    expect(within(form).getByRole("link", { name: "Servers" })).toHaveAttribute("href", SERVERS);
  });

  it("names the matching builders, and servers that match but can't build", async () => {
    hel1().labels = { pool: "untrusted" };
    const fsn1 = db.nodes.find((node) => node.id === "node_fsn1")!;
    fsn1.labels = { pool: "untrusted", tier: "spare" };
    const { user } = renderApp(PREVIEWS);
    const form = await screen.findByRole("form", { name: "Preview settings" });
    expect(await within(form).findByText(/Fork builds run on hel-1\./)).toBeInTheDocument();

    const builders = within(form).getByRole("group", { name: "Build node selector" });
    await user.click(within(builders).getByRole("button", { name: "Add" }));
    await user.type(within(builders).getByLabelText("Build node selector 2 key"), "tier");
    await user.type(within(builders).getByLabelText("Build node selector 2 value"), "spare");
    expect(await within(form).findByText(/fsn-1 matches but can't build/)).toBeInTheDocument();
  });
});
