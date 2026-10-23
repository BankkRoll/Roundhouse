import { act, screen, waitFor, within } from "@testing-library/react";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { db, makeNode, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { apiError } from "../../mocks/handlers";
import { server } from "../../mocks/server";
import { useNode } from "../../queries/nodes";
import { expectPath, findPageHeading, renderApp, renderWithProviders } from "../../test/render";

const SERVERS = `/w/${WORKSPACE_ID}/servers`;

function PolledNode({ pollIntervalMs }: { pollIntervalMs: number }) {
  const node = useNode(WORKSPACE_ID, "node_gone", pollIntervalMs);
  return <p>{node.status}</p>;
}

function card(name: string) {
  const heading = screen.getByRole("heading", { name });
  const article = heading.closest("article");
  if (!article) throw new Error(`No card for ${name}`);
  return within(article);
}

describe("servers page", () => {
  it("renders a card per node with live usage", async () => {
    renderApp(SERVERS);
    expect(await findPageHeading("Servers")).toBeInTheDocument();
    expect(await screen.findByText("2 servers · 1 pending")).toBeInTheDocument();

    const hel = card("hel-1");
    expect(hel.getByText("hetzner/linux · hel1")).toBeInTheDocument();
    expect(hel.getByText("Online")).toBeInTheDocument();
    expect(hel.getByText("38% · 3.0/8 vCPU")).toBeInTheDocument();
    expect(hel.getByText("71% · 11.4/16 GB")).toBeInTheDocument();
    expect(hel.getByText("40% · 64/160 GB")).toBeInTheDocument();
    expect(hel.getByText("0 services · agent v0.1.0")).toBeInTheDocument();
    expect(hel.getByText(/^seen (just now|\d+s ago)$/)).toBeInTheDocument();
    expect(hel.getByRole("meter", { name: "hel-1 memory usage" })).toHaveAttribute(
      "data-tone",
      "warning",
    );
    expect(hel.getByRole("link", { name: "hel-1" })).toHaveAttribute(
      "href",
      `${SERVERS}/node_hel1`,
    );
  });

  it("renders nodes without a heartbeat using placeholders", async () => {
    renderApp(SERVERS);
    await screen.findByRole("heading", { name: "fsn-1" });
    const fsn = card("fsn-1");
    expect(fsn.getByText("Pending")).toBeInTheDocument();
    expect(fsn.getByText("server")).toBeInTheDocument();
    expect(fsn.getAllByText("—")).toHaveLength(3);
    for (const meter of fsn.getAllByRole("meter")) {
      expect(meter).toHaveAttribute("aria-valuetext", "—");
      expect(meter).toHaveAttribute("aria-valuenow", "0");
    }
    expect(fsn.getByText("0 services · agent not reporting")).toBeInTheDocument();
    expect(fsn.getByText("never connected")).toBeInTheDocument();
  });

  it("charts capacity only for nodes that report memory", async () => {
    renderApp(SERVERS);
    const section = await screen.findByRole("region", { name: "Capacity planning" });
    expect(within(section).getByText("hel-1")).toBeInTheDocument();
    expect(within(section).queryByText("fsn-1")).not.toBeInTheDocument();
    expect(
      within(section).getByRole("img", { name: /hel-1 RAM: 11\.4\/16 GB used by system/ }),
    ).toBeInTheDocument();
  });

  it("says when every server is reachable", async () => {
    db.nodes = db.nodes.filter((node) => node.status === "online");
    renderApp(SERVERS);
    expect(await screen.findByText("1 server · all reachable")).toBeInTheDocument();
  });

  it("calls out offline servers in the subline", async () => {
    db.nodes.push({
      ...makeNode({ id: "node_off", name: "ams-1", status: "offline" }),
      workspace_id: WORKSPACE_ID,
    });
    renderApp(SERVERS);
    expect(await screen.findByText("3 servers · 1 offline · 1 pending")).toBeInTheDocument();
    expect(card("ams-1").getByText("Offline")).toBeInTheDocument();
  });

  it("shows an empty state with an add button when there are no servers", async () => {
    db.nodes = [];
    const { user } = renderApp(SERVERS);
    expect(await screen.findByRole("heading", { name: "No servers yet" })).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: "Add server" });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1] as HTMLElement);
    expect(await screen.findByRole("dialog", { name: "Add a server" })).toBeInTheDocument();
    expect(await screen.findByText(/curl -fsSL/)).toBeInTheDocument();
  });

  it("hides Add server from roles that cannot manage nodes", async () => {
    signInAs(USERS.viewer.id);
    renderApp(SERVERS);
    await screen.findByRole("heading", { name: "hel-1" });
    expect(screen.queryByRole("button", { name: "Add server" })).not.toBeInTheDocument();
  });

  it("shows an error with retry when listing fails", async () => {
    let fail = true;
    server.use(
      http.get("*/v1/workspaces/:ws/nodes", () =>
        fail ? apiError(500, "internal", "Node list unavailable") : undefined,
      ),
    );
    const { user } = renderApp(SERVERS);
    expect(await screen.findByText("Node list unavailable")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "hel-1" })).toBeInTheDocument();
  });

  it("refreshes as nodes report in", async () => {
    const { queryClient } = renderApp(SERVERS);
    await screen.findByRole("heading", { name: "fsn-1" });
    const fsn = db.nodes.find((node) => node.id === "node_fsn1");
    if (fsn)
      Object.assign(fsn, {
        status: "online",
        cpu_percent: 5,
        cpu_total: 4,
        last_heartbeat_at: Date.now(),
      });
    await queryClient.refetchQueries({ queryKey: ["workspaces", WORKSPACE_ID, "nodes"] });
    await waitFor(() => expect(card("fsn-1").getByText("5% · 0.2/4 vCPU")).toBeInTheDocument());
  });
});

describe("node detail page", () => {
  it("shows facts, capabilities and usage", async () => {
    renderApp(`${SERVERS}/node_hel1`);
    expect(await findPageHeading("hel-1")).toBeInTheDocument();
    expect(screen.getByText("hetzner/linux · hel1")).toBeInTheDocument();
    for (const value of [
      "hel-1.example.com",
      "203.0.113.10",
      "linux/amd64",
      "6.8.0-45-generic",
      "27.3.1",
      "v0.1.0",
      "8 vCPU",
      "16 GB",
      "160 GB",
    ]) {
      expect(screen.getByText(value)).toBeInTheDocument();
    }
    expect(screen.getByText("load 1.42")).toBeInTheDocument();
    expect(screen.getByText("docker").closest("span")).toHaveTextContent("available");
    expect(screen.getByText("gvisor").closest("span")).toHaveTextContent("unavailable");
    expect(screen.getAllByRole("meter")).toHaveLength(3);
  });

  it("handles a node that has never reported", async () => {
    renderApp(`${SERVERS}/node_fsn1`);
    expect(await findPageHeading("fsn-1")).toBeInTheDocument();
    expect(screen.getByText("Waiting for the first heartbeat from the agent.")).toBeInTheDocument();
    expect(screen.getByText("Not reported yet.")).toBeInTheDocument();
    expect(screen.getByText("load —")).toBeInTheDocument();
    expect(screen.getByText("never")).toBeInTheDocument();
  });

  it("removes the server after confirmation", async () => {
    const { router, user } = renderApp(`${SERVERS}/node_hel1`);
    await user.click(await screen.findByRole("button", { name: "Remove server" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove hel-1?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(db.nodes.some((node) => node.id === "node_hel1")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Remove server" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Remove hel-1?" })).getByRole("button", {
        name: "Remove server",
      }),
    );
    await expectPath(router, SERVERS);
    expect(db.nodes.some((node) => node.id === "node_hel1")).toBe(false);
    expect(await screen.findByText("hel-1 removed")).toBeInTheDocument();
  });

  it("leaves before forgetting the node, so 'Server not found' never flashes", async () => {
    let detailRequestsAfterDelete = 0;
    let deleted = false;
    server.events.on("request:start", ({ request }) => {
      const { pathname } = new URL(request.url);
      if (request.method === "DELETE") deleted = true;
      else if (deleted && pathname.endsWith("/nodes/node_hel1")) detailRequestsAfterDelete += 1;
    });
    let flashed = false;
    const observer = new MutationObserver(() => {
      if (screen.queryByText("Server not found")) flashed = true;
    });
    const { router, user, queryClient } = renderApp(`${SERVERS}/node_hel1`);
    await user.click(await screen.findByRole("button", { name: "Remove server" }));
    observer.observe(document.body, { childList: true, subtree: true });
    await user.click(
      within(await screen.findByRole("dialog", { name: "Remove hel-1?" })).getByRole("button", {
        name: "Remove server",
      }),
    );
    await expectPath(router, SERVERS);
    await screen.findByText("hel-1 removed");
    observer.disconnect();
    server.events.removeAllListeners();

    expect(flashed).toBe(false);
    expect(detailRequestsAfterDelete).toBe(0);
    expect(queryClient.getQueryState(["workspaces", WORKSPACE_ID, "nodes", "node_hel1"])).toBe(
      undefined,
    );
  });

  it("stops polling a node once a request fails", async () => {
    let requests = 0;
    server.use(
      http.get("*/v1/workspaces/:ws/nodes/:id", () => {
        requests += 1;
        return apiError(404, "not_found", "Server not found");
      }),
    );
    renderWithProviders(<PolledNode pollIntervalMs={20} />);
    expect(await screen.findByText("error")).toBeInTheDocument();
    const settled = requests;
    await act(() => new Promise((resolve) => setTimeout(resolve, 120)));
    expect(requests).toBe(settled);
  });

  it("keeps the dialog open and shows the error when removal fails", async () => {
    server.use(
      http.delete("*/v1/workspaces/:ws/nodes/:id", () =>
        apiError(409, "node_busy", "Drain the node first."),
      ),
    );
    const { user } = renderApp(`${SERVERS}/node_hel1`);
    await user.click(await screen.findByRole("button", { name: "Remove server" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove hel-1?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove server" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Drain the node first.");
  });

  it("hides removal from members", async () => {
    signInAs(USERS.member.id);
    renderApp(`${SERVERS}/node_hel1`);
    await findPageHeading("hel-1");
    expect(screen.queryByRole("button", { name: "Remove server" })).not.toBeInTheDocument();
  });

  it("shows not found for unknown nodes", async () => {
    renderApp(`${SERVERS}/node_missing`);
    expect(await screen.findByRole("heading", { name: "Server not found" })).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Servers" })).toHaveAttribute(
      "href",
      SERVERS,
    );
  });
});
