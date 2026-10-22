import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, makeNode, signInAs, USERS, WORKSPACE_ID } from "../mocks/db";
import { findPageHeading, renderApp } from "../test/render";

const BASE = `/w/${WORKSPACE_ID}`;

describe("home page", () => {
  it("shows the workspace subline, New project, and the phase-gated templates action", async () => {
    renderApp(BASE);
    expect(await findPageHeading("Home")).toBeInTheDocument();
    expect(screen.getByText("Acme · self-hosted control plane on Cloudflare")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New project" })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(screen.getByRole("button", { name: "Browse templates" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("explains why templates are unavailable", async () => {
    const { router, user } = renderApp(BASE);
    const button = await screen.findByRole("button", { name: "Browse templates" });
    await user.hover(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Templates arrive in a later phase",
    );
    await user.click(button);
    expect(router.state.location.pathname).toBe(BASE);
  });

  it("hides New project from roles that can't create projects", async () => {
    signInAs(USERS.member.id);
    renderApp(BASE);
    await findPageHeading("Home");
    expect(screen.queryByRole("button", { name: "New project" })).not.toBeInTheDocument();
  });

  it("summarises the fleet from real node data", async () => {
    db.nodes.push(
      {
        ...makeNode({ id: "node_b", name: "fsn-2", status: "draining", mem_used: 4.6 * 1024 ** 3 }),
        workspace_id: WORKSPACE_ID,
      },
      {
        ...makeNode({ id: "node_c", name: "ams-1", status: "maintenance", mem_used: null }),
        workspace_id: WORKSPACE_ID,
      },
    );
    renderApp(BASE);
    const fleet = await screen.findByRole("region", { name: "Fleet" });
    await within(fleet).findByText("1 online");
    expect(fleet).toHaveTextContent("2 need attention · 50% RAM used");
    expect(within(fleet).getByRole("meter", { name: "Fleet memory usage" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
  });

  it("never shows invented costs, and counts services from real deployments", async () => {
    renderApp(BASE);
    const month = await screen.findByRole("region", { name: "This month" });
    expect(month).toHaveTextContent("—");
    expect(month.textContent).not.toMatch(/\$\d/);
    const services = await screen.findByRole("region", { name: "Services" });
    await waitFor(() => expect(services).toHaveTextContent("3 live · 1 deploying · 2 projects"));
    expect(services).toHaveTextContent(/^Services4/);
    expect(await screen.findByRole("region", { name: "Incidents" })).toHaveTextContent(
      "Nothing to report",
    );
  });

  it("reports failing services as incidents", async () => {
    const latest = db.deploy.deployments.find((row) => row.id === "dep_api_2");
    if (latest) latest.status = "crashed";
    renderApp(BASE);
    const incidents = await screen.findByRole("region", { name: "Incidents" });
    await waitFor(() => expect(incidents).toHaveTextContent("1 failing"));
    expect(incidents).toHaveTextContent("api");
  });

  it("lists recent activity from the audit log", async () => {
    renderApp(BASE);
    await screen.findByText("connected");
    const items = screen.getAllByRole("listitem");
    const activity = items.filter((item) => item.querySelector("time"));
    expect(activity[0]).toHaveTextContent(/^hel-1 connected\d/);
    expect(activity[1]).toHaveTextContent("Ada Lovelace invited erin@example.com");
    expect(activity.at(-1)).toHaveTextContent("Ada Lovelace created the workspace");
  });

  it("shows per-server RAM in the fleet card", async () => {
    renderApp(BASE);
    expect(await screen.findByRole("meter", { name: "hel-1 RAM used" })).toHaveAttribute(
      "aria-valuenow",
      "71",
    );
    expect(screen.getByRole("meter", { name: "fsn-1 RAM used" })).not.toHaveAttribute(
      "aria-valuenow",
    );
    expect(screen.getByRole("link", { name: "All servers →" })).toHaveAttribute(
      "href",
      `${BASE}/servers`,
    );
    expect(screen.getByText("Bars show RAM used.")).toBeInTheDocument();
  });

  it("tells members the activity feed is for admins", async () => {
    signInAs(USERS.member.id);
    renderApp(BASE);
    expect(
      await screen.findByText("Activity is visible to owners and admins."),
    ).toBeInTheDocument();
  });

  it("handles an empty fleet", async () => {
    db.nodes = [];
    renderApp(BASE);
    const fleet = await screen.findByRole("region", { name: "Fleet" });
    expect(await within(fleet).findByText("No servers")).toBeInTheDocument();
    expect(screen.getByText("No servers connected yet.")).toBeInTheDocument();
  });
});

describe("coming soon sections", () => {
  it.each([
    ["canvas", "Canvas", "Phase 2"],
    ["logs", "Logs", "Later phase"],
    ["templates", "Templates", "Later phase"],
    ["usage", "Usage", "Later phase"],
  ])("/%s explains which phase brings it", async (path, title, phase) => {
    renderApp(`${BASE}/${path}`);
    expect(await findPageHeading(title)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: `${title} is on the way` })).toBeInTheDocument();
    expect(screen.getByText(phase)).toBeInTheDocument();
  });
});

describe("settings page", () => {
  it("renames the workspace and updates the sidebar", async () => {
    const { user } = renderApp(`${BASE}/settings`);
    const input = await screen.findByLabelText("Name");
    await waitFor(() => expect(input).toHaveValue("Acme"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Enter a workspace name.")).toBeInTheDocument();

    await user.type(input, "Acme Robotics");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Workspace renamed")).toBeInTheDocument();
    expect(db.workspaces[0]?.name).toBe("Acme Robotics");
    expect(
      screen.getByRole("button", { name: "Workspace: Acme Robotics. Switch workspace" }),
    ).toBeInTheDocument();
  });

  it("keeps an in-progress edit when the saved name changes underneath it", async () => {
    const { user, queryClient } = renderApp(`${BASE}/settings`);
    const input = await screen.findByLabelText("Name");
    await waitFor(() => expect(input).toHaveValue("Acme"));
    await user.clear(input);
    await user.type(input, "Acme Rob");

    const [workspace] = db.workspaces;
    if (workspace) workspace.name = "Renamed Elsewhere";
    await queryClient.refetchQueries({ queryKey: ["workspaces", WORKSPACE_ID] });

    expect(input).toHaveValue("Acme Rob");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("follows the saved name while the field is untouched", async () => {
    const { queryClient } = renderApp(`${BASE}/settings`);
    const input = await screen.findByLabelText("Name");
    await waitFor(() => expect(input).toHaveValue("Acme"));
    const [workspace] = db.workspaces;
    if (workspace) workspace.name = "Renamed Elsewhere";
    await queryClient.refetchQueries({ queryKey: ["workspaces", WORKSPACE_ID] });
    await waitFor(() => expect(input).toHaveValue("Renamed Elsewhere"));
  });

  it("keeps the slug when renaming, like the API", async () => {
    const { user } = renderApp(`${BASE}/settings`);
    const input = await screen.findByLabelText("Name");
    await waitFor(() => expect(input).toHaveValue("Acme"));
    await user.clear(input);
    await user.type(input, "Acme Robotics");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Workspace renamed");
    expect(db.workspaces[0]?.slug).toBe("acme");
    expect(screen.getByText("/acme")).toBeInTheDocument();
  });

  it("shows the workspace id and no billing or plan UI", async () => {
    renderApp(`${BASE}/settings`);
    expect(await screen.findByText(WORKSPACE_ID)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/plan|billing|hosted edition|upgrade/i);
  });

  it("is read-only for members", async () => {
    signInAs(USERS.member.id);
    renderApp(`${BASE}/settings`);
    expect(await screen.findByLabelText("Name")).toBeDisabled();
    expect(
      screen.getByText("Only owners and admins can rename the workspace."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });
});

describe("leaving a workspace", () => {
  it("lets a member leave and lands them on the no-workspace page", async () => {
    signInAs(USERS.member.id);
    const { router, user } = renderApp(`${BASE}/settings`);
    await user.click(await screen.findByRole("button", { name: "Leave workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave Acme?" });
    await user.click(within(dialog).getByRole("button", { name: "Leave workspace" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/dashboard"));
    expect(
      await screen.findByRole("heading", { name: "You're not in a workspace yet" }),
    ).toBeInTheDocument();
    expect(db.memberships.some((row) => row.user_id === USERS.member.id)).toBe(false);
    expect(db.audit.at(-1)).toMatchObject({ action: "member.left", actor_id: USERS.member.id });
  });

  it("explains that the last owner cannot leave", async () => {
    const { user } = renderApp(`${BASE}/settings`);
    await user.click(await screen.findByRole("button", { name: "Leave workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave Acme?" });
    await user.click(within(dialog).getByRole("button", { name: "Leave workspace" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "A workspace must keep at least one owner",
    );
    expect(db.memberships.some((row) => row.user_id === USERS.owner.id)).toBe(true);
  });

  it("lets viewers leave using their membership from /v1/me", async () => {
    signInAs(USERS.viewer.id);
    const { user } = renderApp(`${BASE}/settings`);
    await user.click(await screen.findByRole("button", { name: "Leave workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave Acme?" });
    await user.click(within(dialog).getByRole("button", { name: "Leave workspace" }));
    await waitFor(() =>
      expect(db.memberships.some((row) => row.user_id === USERS.viewer.id)).toBe(false),
    );
  });
});
