import { JOIN_TOKEN_TTL_MS } from "@roundhouse/shared";
import { act, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { db, makeNode, WORKSPACE_ID } from "../../mocks/db";
import { apiError } from "../../mocks/handlers";
import { server } from "../../mocks/server";
import { renderWithProviders } from "../../test/render";
import { AddServerDialog } from "./add-server-dialog";
import { AddServerFlow } from "./add-server-flow";

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
