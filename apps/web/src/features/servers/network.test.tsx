import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { MESH_SEED } from "../../mocks/mesh-db";
import { seedMeshNetwork } from "../../mocks/mesh-handlers";
import { expectPath, findPageHeading, renderApp } from "../../test/render";

const SERVERS = `/w/${WORKSPACE_ID}/servers`;
const NETWORK = `${SERVERS}/network`;

describe("servers → network", () => {
  it("is a tab of the servers area", async () => {
    const { user, router } = renderApp(SERVERS);
    await findPageHeading("Servers");
    const nav = screen.getByRole("navigation", { name: "Servers" });
    expect(within(nav).getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await user.click(within(nav).getByRole("link", { name: "Network" }));
    await expectPath(router, NETWORK);
    expect(await screen.findByText("The private network is off")).toBeInTheDocument();
  });

  it("points owners at the setting while the mesh is off", async () => {
    renderApp(NETWORK);
    expect(await screen.findByText("The private network is off")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open network settings" })).toHaveAttribute(
      "href",
      `/w/${WORKSPACE_ID}/platform#network`,
    );
  });

  it("tells members who can turn it on", async () => {
    signInAs(USERS.member.id);
    renderApp(NETWORK);
    expect(await screen.findByText(/An instance owner can turn on/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open network settings" })).not.toBeInTheDocument();
  });

  it("shows figures, the diagram with a focusable line per pair, and the same facts as tables", async () => {
    seedMeshNetwork();
    const { user } = renderApp(NETWORK);
    expect(
      await screen.findByText(/Private network 10\.200\.0\.0\/16 · WireGuard/),
    ).toBeInTheDocument();

    const figures = screen.getByRole("group", { name: "Network at a glance" });
    expect(within(figures).getByRole("region", { name: "In the mesh" })).toHaveTextContent(
      "5 of 6",
    );
    expect(within(figures).getByRole("region", { name: "Ready" })).toHaveTextContent("4 of 5");
    expect(within(figures).getByRole("region", { name: "Relayed pairs" })).toHaveTextContent("1");
    expect(within(figures).getByRole("region", { name: "Down pairs" })).toHaveTextContent("5");

    const diagram = screen.getByRole("group", { name: /Network diagram/ });
    const lines = within(diagram).getAllByRole("button");
    expect(lines).toHaveLength(10);
    const relayed = within(diagram).getByRole("button", {
      name: /home-1 to lab-1: relayed via hel-1/,
    });
    expect(relayed).toHaveAttribute("data-path", "relayed");

    const details = screen.getByRole("complementary", { name: "Selected pair" });
    expect(details).toHaveTextContent(/Hover, focus or select a line/);
    act(() =>
      within(diagram)
        .getByRole("button", { name: /hel-1 to nbg-1: direct/ })
        .focus(),
    );
    expect(details).toHaveTextContent("Direct");
    expect(details).toHaveTextContent("hel-1 sees nbg-1 at 203.0.113.20:51820");
    expect(details).toHaveTextContent("received 182 MB · sent 96 MB");

    relayed.focus();
    await user.keyboard("{Enter}");
    expect(relayed).toHaveAttribute("aria-pressed", "true");
    fireEvent.blur(relayed);
    expect(details).toHaveTextContent("via hel-1");
    expect(details).toHaveTextContent(/Relayed pairs report through their tunnels/);

    const servers = screen.getByRole("table", { name: "Servers" });
    const hel = within(servers).getByRole("row", { name: /hel-1/ });
    expect(hel).toHaveTextContent("Relay");
    expect(hel).toHaveTextContent("10.200.1.1");
    expect(hel).toHaveTextContent("203.0.113.10:51820");
    expect(within(servers).getByRole("row", { name: /home-1/ })).toHaveTextContent("behind NAT");
    expect(within(servers).getByRole("row", { name: /office-1/ })).toHaveTextContent("Not ready");
    expect(within(servers).getByRole("row", { name: /fsn-1/ })).toHaveTextContent("Agent too old");

    const pairs = screen.getByRole("table", { name: "Pairs" });
    expect(within(pairs).getByRole("row", { name: /home-1 ↔ lab-1/ })).toHaveTextContent(
      "Relayedvia hel-1",
    );
    expect(
      within(pairs).getByRole("row", { name: /nbg-1 ↔ lab-1|lab-1 ↔ nbg-1/ }),
    ).toHaveTextContent("10m ago");
  });
});

describe("server detail → private network", () => {
  it("lists readiness with the exact fix for a dropped fwmark on nftables", async () => {
    seedMeshNetwork();
    renderApp(`${SERVERS}/${MESH_SEED.office}`);
    await findPageHeading("office-1");
    const section = await screen.findByRole("region", { name: "Private network" });
    expect(within(section).getByRole("alert")).toHaveTextContent(
      "Docker's nftables backend drops forwarded mesh packets",
    );
    const checks = within(section).getByRole("list", { name: "Readiness" });
    expect(checks).toHaveTextContent("Docker firewall: Failed");
    expect(checks).toHaveTextContent("/etc/docker/daemon.json");
    expect(
      within(checks).getByText(`"bridge-accept-fwmark": "0x2000000/0x2000000"`),
    ).toBeInTheDocument();
    expect(checks).toHaveTextContent("Reachability: Attention");
    expect(checks).toHaveTextContent("forward UDP 51820 to this server");
  });

  it("shows address, mode, endpoint and a health row per peer", async () => {
    seedMeshNetwork();
    renderApp(`${SERVERS}/${MESH_SEED.hel}`);
    const section = await screen.findByRole("region", { name: "Private network" });
    expect(
      within(section).getByRole("heading", { name: "Private network" }).parentElement,
    ).toHaveTextContent("Ready");
    expect(section).toHaveTextContent("10.200.1.1");
    expect(section).toHaveTextContent("Public · 203.0.113.10:51820");
    expect(section).toHaveTextContent("iptables · mesh packets accepted");
    expect(section).toHaveTextContent("Yes, for 1 pair behind NAT");
    const peers = within(section).getByRole("table", { name: "Peers" });
    expect(within(peers).getAllByRole("row")).toHaveLength(5);
    const nbg = within(peers).getByRole("row", { name: /nbg-1/ });
    expect(nbg).toHaveTextContent("Direct");
    expect(nbg).toHaveTextContent("203.0.113.20:51820");
    expect(within(peers).getByRole("row", { name: /office-1/ })).toHaveTextContent("never");
  });

  it("rotates the key after confirming, for admins only, one server at a time", async () => {
    seedMeshNetwork();
    signInAs(USERS.admin.id);
    const { user } = renderApp(`${SERVERS}/${MESH_SEED.nbg}`);
    const section = await screen.findByRole("region", { name: "Private network" });
    await user.click(within(section).getByRole("button", { name: "Rotate mesh key" }));
    const dialog = await screen.findByRole("dialog", { name: "Rotate the mesh key of nbg-1?" });
    expect(dialog).toHaveTextContent("pause for about two seconds");
    await user.click(within(dialog).getByRole("button", { name: "Rotate key" }));
    expect(await screen.findByText("Rotating the mesh key of nbg-1")).toBeInTheDocument();
    expect(db.mesh.nodes[MESH_SEED.nbg]?.rotating).toBe(true);
    expect(db.audit.at(-1)).toMatchObject({ action: "node.mesh_key_rotated" });
    await waitFor(() =>
      expect(within(section).getByRole("button", { name: "Rotate mesh key" })).toBeDisabled(),
    );
    expect(within(section).getByText("Rotating key")).toBeInTheDocument();
  });

  it("explains a refused rotation while another server rotates", async () => {
    seedMeshNetwork();
    db.mesh.nodes[MESH_SEED.nbg]!.rotating = true;
    const { user } = renderApp(`${SERVERS}/${MESH_SEED.hel}`);
    const section = await screen.findByRole("region", { name: "Private network" });
    await user.click(within(section).getByRole("button", { name: "Rotate mesh key" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Rotate key" }));
    expect(await within(dialog).findByText(/Servers rotate one at a time/)).toBeInTheDocument();
  });

  it("hides the rotate action from members and says when the mesh is off", async () => {
    seedMeshNetwork();
    signInAs(USERS.member.id);
    renderApp(`${SERVERS}/${MESH_SEED.hel}`);
    const section = await screen.findByRole("region", { name: "Private network" });
    expect(within(section).queryByRole("button", { name: "Rotate mesh key" })).toBeNull();
  });

  it("says the mesh is off on a new install", async () => {
    renderApp(`${SERVERS}/${MESH_SEED.hel}`);
    const section = await screen.findByRole("region", { name: "Private network" });
    expect(section).toHaveTextContent("The WireGuard mesh is off for this instance");
  });
});
