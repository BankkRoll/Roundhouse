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

describe("provider-managed servers", () => {
  function addManaged(overrides: Partial<Parameters<typeof makeNode>[0]> = {}) {
    db.nodes.push({
      ...makeNode({
        id: "node_web1",
        name: "web-1",
        provider: "hetzner",
        provider_server_id: "48000001",
        ...overrides,
      }),
      workspace_id: WORKSPACE_ID,
    });
  }

  function connectHetzner() {
    db.providers.integrations.push({
      workspace_id: WORKSPACE_ID,
      provider: "hetzner",
      account_label: "demo@example.com",
      token_fingerprint: "a1b2c3d4",
      token_last4: "cdef",
      last_validated_at: Date.now(),
      updated_at: Date.now(),
    });
  }

  it("shows estimated costs on provisioned servers and a total per currency", async () => {
    addManaged({ estimated_monthly_cost: { monthly_cents: 451, currency: "EUR" } });
    db.nodes.push(
      {
        ...makeNode({
          id: "node_web2",
          name: "web-2",
          provider: "hetzner",
          provider_server_id: "48000002",
          estimated_monthly_cost: { monthly_cents: 812, currency: "EUR" },
        }),
        workspace_id: WORKSPACE_ID,
      },
      {
        ...makeNode({
          id: "node_do1",
          name: "do-1",
          provider: "digitalocean",
          provider_server_id: "9001",
          estimated_monthly_cost: { monthly_cents: 2400, currency: "USD" },
        }),
        workspace_id: WORKSPACE_ID,
      },
    );
    renderApp(SERVERS);
    await screen.findByRole("heading", { name: "web-1" });
    expect(card("web-1").getByText(/≈ €4\.51\/mo \(estimate\)/)).toBeInTheDocument();
    expect(card("do-1").getByText(/≈ \$24\.00\/mo \(estimate\)/)).toBeInTheDocument();
    expect(card("hel-1").queryByText(/estimate/)).not.toBeInTheDocument();
    const summary = screen.getByText(/Estimated cloud cost:/);
    expect(summary).toHaveTextContent(
      "Estimated cloud cost: ≈ $24.00/mo (1 server) + ≈ €12.63/mo (2 servers). Provider catalogue prices when each server was created, not your bill.",
    );
  });

  it("leaves the cost out when no server has an estimate", async () => {
    addManaged();
    renderApp(SERVERS);
    await screen.findByRole("heading", { name: "web-1" });
    expect(screen.queryByText(/Estimated cloud cost/)).not.toBeInTheDocument();
    expect(card("web-1").queryByText(/estimate/)).not.toBeInTheDocument();
  });

  it("shows the estimate on the detail page, labelled as one", async () => {
    addManaged({ estimated_monthly_cost: { monthly_cents: 451, currency: "EUR" } });
    renderApp(`${SERVERS}/node_web1`);
    const fact = await screen.findByText("Estimated cost");
    expect(fact.nextElementSibling).toHaveTextContent("≈ €4.51/mo (estimate)");
  });

  it("badges the provider, and warns when it deleted the server", async () => {
    addManaged({ provider_server_missing_at: Date.now() - 60_000 });
    renderApp(SERVERS);
    await screen.findByRole("heading", { name: "web-1" });
    const web = card("web-1");
    expect(web.getByText("Hetzner Cloud")).toBeInTheDocument();
    expect(web.getByText("Deleted at provider")).toBeInTheDocument();
    expect(card("hel-1").queryByText("Hetzner Cloud")).not.toBeInTheDocument();
    expect(card("fsn-1").queryByText("Deleted at provider")).not.toBeInTheDocument();
  });

  it("lists servers still being created as pending rows", async () => {
    const now = Date.now();
    const run = {
      provider: "hetzner" as const,
      plan: "cx22",
      region: "fsn1",
      builder: false,
      failure_reason: null,
      failure_message: null,
      ipv4: null,
      ipv6: null,
      node_id: null,
      cancel_requested_at: null,
      estimated_monthly_cost: null,
      created_at: now,
      updated_at: now,
      finished_at: null,
      workspace_id: WORKSPACE_ID,
    };
    db.providers.provisions.push(
      {
        ...run,
        id: "npr_1",
        name: "web-2",
        status: "creating",
        step: "create_server",
        server_id: null,
      },
      { ...run, id: "npr_2", name: "web-3", status: "cleanup_failed", step: null, server_id: "77" },
      { ...run, id: "npr_3", name: "web-4", status: "failed", step: null, server_id: null },
    );
    renderApp(SERVERS);
    const creating = await screen.findByRole("article", { name: "web-2 (creating server)" });
    expect(creating).toHaveTextContent("Hetzner Cloud · cx22 · fsn1");
    expect(creating).toHaveTextContent("Creating the server");
    expect(screen.getByRole("article", { name: "web-3 (cleanup failed)" })).toHaveTextContent(
      /may still exist at Hetzner Cloud and keep billing \(server 77\)/,
    );
    expect(screen.queryByText("web-4")).not.toBeInTheDocument();
  });

  it("shows the provider on the detail page and the missing-server notice", async () => {
    addManaged({ provider_server_missing_at: Date.now() - 60_000 });
    renderApp(`${SERVERS}/node_web1`);
    expect(await findPageHeading("web-1")).toBeInTheDocument();
    expect(screen.getAllByText("Hetzner Cloud").length).toBeGreaterThan(0);
    expect(screen.getByText("48000001")).toBeInTheDocument();
    expect(screen.getByText(/Hetzner Cloud no longer has this server/)).toBeInTheDocument();
  });

  it("warns that removing destroys the cloud server, unless it is kept", async () => {
    addManaged();
    connectHetzner();
    const requests: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.method === "DELETE") requests.push(new URL(request.url).search);
    });
    const { router, user } = renderApp(`${SERVERS}/node_web1`);
    await user.click(await screen.findByRole("button", { name: "Remove server" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove web-1?" });
    expect(dialog).toHaveTextContent(/destroys the server at Hetzner Cloud/);
    expect(within(dialog).getByRole("button", { name: "Destroy server" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("checkbox", { name: /Keep the server at Hetzner/ }));
    expect(dialog).toHaveTextContent(/keeps running, and billing, at Hetzner Cloud/);
    await user.click(within(dialog).getByRole("button", { name: "Remove server" }));
    await expectPath(router, SERVERS);
    expect(requests).toEqual(["?keep_server=true"]);
    expect(db.audit.some((entry) => entry.action === "node.deprovisioned")).toBe(false);
    server.events.removeAllListeners();
  });

  it("destroys the cloud server by default", async () => {
    addManaged();
    connectHetzner();
    const { router, user } = renderApp(`${SERVERS}/node_web1`);
    await user.click(await screen.findByRole("button", { name: "Remove server" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove web-1?" });
    await user.click(within(dialog).getByRole("button", { name: "Destroy server" }));
    await expectPath(router, SERVERS);
    expect(db.audit.some((entry) => entry.action === "node.deprovisioned")).toBe(true);
  });

  it("explains how to recover when the provider is no longer connected", async () => {
    addManaged();
    const { user } = renderApp(`${SERVERS}/node_web1`);
    await user.click(await screen.findByRole("button", { name: "Remove server" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove web-1?" });
    await user.click(within(dialog).getByRole("button", { name: "Destroy server" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      /Connect Hetzner Cloud to this workspace first.*or keep the server/,
    );
  });
});
