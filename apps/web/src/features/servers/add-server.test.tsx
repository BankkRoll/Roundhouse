import { JOIN_TOKEN_TTL_MS } from "@roundhouse/shared";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { db, makeNode, WORKSPACE_ID } from "../../mocks/db";
import { apiError } from "../../mocks/handlers";
import { server } from "../../mocks/server";
import { renderWithProviders } from "../../test/render";
import { AddServerDialog } from "./add-server-dialog";
import { AddServerFlow } from "./add-server-flow";
import { INSTALL_METHOD_STORAGE_KEY } from "./install-methods";

function connectNode(name = "hel-2") {
  db.nodes.push({
    ...makeNode({ id: `node_${name}`, name, status: "pending" }),
    workspace_id: WORKSPACE_ID,
  });
}

describe("AddServerDialog", () => {
  it("shows the install command, then flips to success when a new node appears", async () => {
    const onOpenChange = vi.fn();
    const { user } = renderWithProviders(
      <AddServerDialog
        workspaceId={WORKSPACE_ID}
        open
        onOpenChange={onOpenChange}
        pollIntervalMs={50}
      />,
    );

    expect(await screen.findByRole("dialog", { name: "Add a server" })).toBeInTheDocument();
    const command = await screen.findByText(
      /curl -fsSL .*install\.sh \| sudo bash -s -- --token njt_\w+/,
    );
    expect(command).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy to clipboard" })).toBeInTheDocument();
    expect(screen.getByText(/Expires in/)).toHaveTextContent(/Expires in (14:[0-5]\d|15:00)$/);
    expect(screen.getByText("Waiting for the server to connect…")).toBeInTheDocument();
    expect(db.joinTokens).toHaveLength(1);

    connectNode("hel-2");

    const status = await screen.findByText("connected", { exact: false });
    expect(status).toHaveTextContent("hel-2 connected");
    expect(screen.getByRole("link", { name: "View server" })).toHaveAttribute(
      "href",
      `/w/${WORKSPACE_ID}/servers/node_hel-2`,
    );
    await user.click(await screen.findByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("ignores nodes that existed before the dialog opened", async () => {
    renderWithProviders(
      <AddServerDialog
        workspaceId={WORKSPACE_ID}
        open
        onOpenChange={() => {}}
        pollIntervalMs={30}
      />,
    );
    await screen.findByText(/curl -fsSL/);
    await act(() => new Promise((resolve) => setTimeout(resolve, 120)));
    expect(screen.getByText("Waiting for the server to connect…")).toBeInTheDocument();
    expect(screen.queryByText(/connected$/)).not.toBeInTheDocument();
  });

  it("mints exactly one token per opening", async () => {
    renderWithProviders(
      <AddServerDialog
        workspaceId={WORKSPACE_ID}
        open
        onOpenChange={() => {}}
        pollIntervalMs={1000}
      />,
    );
    await screen.findByText(/curl -fsSL/);
    expect(db.joinTokens).toHaveLength(1);
  });

  it("renders nothing inside when closed", () => {
    renderWithProviders(
      <AddServerDialog workspaceId={WORKSPACE_ID} open={false} onOpenChange={() => {}} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(db.joinTokens).toHaveLength(0);
  });
});

describe("AddServerFlow", () => {
  it("lets the user retry when minting the token fails", async () => {
    let calls = 0;
    server.use(
      http.post("*/v1/workspaces/:ws/nodes/join-tokens", () => {
        calls += 1;
        if (calls === 1) return apiError(503, "unavailable", "Durable Object is waking up");
        return HttpResponse.json(
          {
            token: "njt_retry",
            expires_at: Date.now() + JOIN_TOKEN_TTL_MS,
            install_command: "curl retry | sh",
          },
          { status: 201 },
        );
      }),
    );
    const { user } = renderWithProviders(
      <AddServerFlow workspaceId={WORKSPACE_ID} pollIntervalMs={1000} onDone={() => {}} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Durable Object is waking up");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("curl retry | sh")).toBeInTheDocument();
  });

  it("offers a new token once the current one expires", async () => {
    let calls = 0;
    server.use(
      http.post("*/v1/workspaces/:ws/nodes/join-tokens", () => {
        calls += 1;
        return HttpResponse.json(
          {
            token: `njt_${calls}`,
            expires_at: calls === 1 ? Date.now() - 1000 : Date.now() + JOIN_TOKEN_TTL_MS,
            install_command: `curl token-${calls} | sh`,
          },
          { status: 201 },
        );
      }),
    );
    const { user } = renderWithProviders(
      <AddServerFlow workspaceId={WORKSPACE_ID} pollIntervalMs={1000} onDone={() => {}} />,
    );
    expect(await screen.findByText("Token expired")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for the server to connect…")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate new token" }));
    expect(await screen.findByText("curl token-2 | sh")).toBeInTheDocument();
    expect(screen.getByText("Waiting for the server to connect…")).toBeInTheDocument();
  });

  it("calls onDone with the custom label after a server connects", async () => {
    const onDone = vi.fn();
    const { user } = renderWithProviders(
      <AddServerFlow
        workspaceId={WORKSPACE_ID}
        pollIntervalMs={40}
        doneLabel="Go to dashboard"
        onDone={onDone}
      />,
    );
    await screen.findByText(/curl -fsSL/);
    connectNode("box-9");
    await user.click(await screen.findByRole("button", { name: "Go to dashboard" }));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("counts down to expiry", async () => {
    server.use(
      http.post("*/v1/workspaces/:ws/nodes/join-tokens", () =>
        HttpResponse.json(
          { token: "njt_x", expires_at: Date.now() + 90_500, install_command: "curl x | sh" },
          { status: 201 },
        ),
      ),
    );
    renderWithProviders(
      <AddServerFlow workspaceId={WORKSPACE_ID} pollIntervalMs={1000} onDone={() => {}} />,
    );
    const label = await screen.findByText(/Expires in/);
    expect(label).toHaveTextContent(/1:3\d/);
    await waitFor(() => expect(label).toHaveTextContent(/1:2\d|1:30/), { timeout: 3000 });
  });
});

describe("install method tabs", () => {
  async function openFlow(origin = "https://cp.example.com") {
    const app = renderWithProviders(
      <AddServerFlow
        workspaceId={WORKSPACE_ID}
        pollIntervalMs={1000}
        onDone={() => {}}
        origin={origin}
      />,
    );
    const tabs = await screen.findByRole("tablist", { name: "How to add the server" });
    const token = db.joinTokens[0]?.token ?? "";
    return { ...app, tabs, token };
  }

  it("shows the same token on every tab, with one countdown and waiting state", async () => {
    const { user, token } = await openFlow("http://localhost:5173");
    expect(screen.getByRole("tab", { name: "Linux server" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tabpanel")).toHaveTextContent(`--token ${token}`);
    expect(screen.getByText("Ubuntu 22.04 and 24.04, Debian 12", { exact: false })).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "This computer" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent(`pnpm dev:node ${token}`);
    expect(screen.getByRole("tabpanel")).toHaveTextContent(
      /from a clone of the Roundhouse repository/,
    );

    await user.click(screen.getByRole("tab", { name: "Linux server" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent(`--token ${token}`);
    expect(db.joinTokens).toHaveLength(1);
    expect(screen.getAllByText(/Expires in/)).toHaveLength(1);
    expect(screen.getAllByText("Waiting for the server to connect…")).toHaveLength(1);
  });

  it("appends --builder for a builder node, on the Linux and cloud-init tabs alike", async () => {
    const { user, token } = await openFlow();
    const panel = () => screen.getByRole("tabpanel");
    expect(panel()).not.toHaveTextContent("--builder");
    await user.click(screen.getByRole("checkbox", { name: "Builder node" }));
    expect(within(panel()).getByText(`--token ${token} --builder`, { exact: false })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Cloud-init" }));
    expect(screen.getByRole("checkbox", { name: "Builder node" })).toBeChecked();
    expect(panel()).toHaveTextContent("--builder");
  });

  it("builds cloud-init that keeps the token in a 0600 file, out of runcmd", async () => {
    const { user, token } = await openFlow();
    await user.click(screen.getByRole("tab", { name: "Cloud-init" }));
    const name = screen.getByLabelText("Server name");
    await user.clear(name);
    await user.type(name, "web-1");
    const userData = screen.getByText(/^#cloud-config/).textContent ?? "";
    expect(userData).toContain('permissions: "0600"');
    expect(userData).toContain(`content: ${JSON.stringify(`${token}\n`)}`);
    expect(userData).toContain("--token-file");
    expect(userData).toContain("--name 'web-1'");
    expect(userData).toContain("--proto '=https'");
    expect(userData).toContain("https://cp.example.com/install.sh");
    expect(userData).toMatch(/shred -u/);
    const runcmd = userData.slice(userData.indexOf("runcmd:"));
    expect(runcmd).not.toContain(token);
    expect(userData.split("\n").filter((line) => line.includes(token))).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Copy to clipboard" })).toBeInTheDocument();

    await user.clear(name);
    await user.type(name, "Bad Name");
    expect(screen.getByText(/must be 1-63 lowercase letters/)).toBeInTheDocument();
    expect(screen.queryByText(/^#cloud-config/)).not.toBeInTheDocument();
  });

  it.each([
    ["plain HTTP", "http://10.0.0.5:8787"],
    ["this machine", "https://localhost:8443"],
  ])("explains instead of showing cloud-init when the dashboard is on %s", async (_, origin) => {
    const { user } = await openFlow(origin);
    await user.click(screen.getByRole("tab", { name: "Cloud-init" }));
    expect(screen.getByText("Cloud servers can't use this address")).toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveTextContent(origin);
    expect(screen.queryByText(/#cloud-config/)).not.toBeInTheDocument();
  });

  it("offers the local Docker node only when the dashboard runs on this machine", async () => {
    const remote = await openFlow("https://cp.example.com");
    expect(within(remote.tabs).queryByRole("tab", { name: "This computer" })).toBeNull();
    remote.unmount();
    for (const origin of ["http://127.0.0.1:8787", "http://localhost:5173"]) {
      const local = await openFlow(origin);
      expect(within(local.tabs).getByRole("tab", { name: "This computer" })).toBeInTheDocument();
      local.unmount();
    }
  });

  it("offers a cloud provider tab without the join token countdown", async () => {
    const { user } = await openFlow();
    await user.click(screen.getByRole("tab", { name: "Cloud provider" }));
    expect(await screen.findByRole("combobox", { name: "Provider" })).toHaveValue("hetzner");
    expect(screen.queryByText(/Expires in/)).not.toBeInTheDocument();
    expect(screen.queryByText("Waiting for the server to connect…")).not.toBeInTheDocument();
    expect(localStorage.getItem(INSTALL_METHOD_STORAGE_KEY)).toBe("cloud");
  });

  it("moves between tabs with the arrow keys", async () => {
    const { user } = await openFlow("http://localhost:5173");
    screen.getByRole("tab", { name: "Linux server" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Cloud provider" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Cloud provider" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("tab", { name: "This computer" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "This computer" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("remembers the last tab picked, and copes without storage", async () => {
    const first = await openFlow();
    await first.user.click(screen.getByRole("tab", { name: "Cloud-init" }));
    expect(localStorage.getItem(INSTALL_METHOD_STORAGE_KEY)).toBe("cloud-init");
    first.unmount();
    await openFlow();
    expect(screen.getByRole("tab", { name: "Cloud-init" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    cleanup();

    localStorage.setItem(INSTALL_METHOD_STORAGE_KEY, "local");
    await openFlow("https://cp.example.com");
    expect(screen.getByRole("tab", { name: "Linux server" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    cleanup();

    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const blocked = await openFlow();
    await blocked.user.click(screen.getByRole("tab", { name: "Cloud-init" }));
    expect(screen.getByRole("tab", { name: "Cloud-init" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    getItem.mockRestore();
    setItem.mockRestore();
  });
});
