import { screen, waitFor, within } from "@testing-library/react";
import { http } from "msw";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { db, WORKSPACE_ID } from "../../mocks/db";
import { apiError } from "../../mocks/handlers";
import { server } from "../../mocks/server";
import { renderWithProviders } from "../../test/render";
import { CloudProviderPanel } from "./cloud-provider-panel";

const TOKEN = "hcloud-0123456789abcdef";

function connect(provider: "hetzner" | "vultr" = "hetzner") {
  db.providers.integrations.push({
    workspace_id: WORKSPACE_ID,
    provider,
    account_label: "demo@example.com",
    token_fingerprint: "a1b2c3d4",
    token_last4: "cdef",
    last_validated_at: Date.now(),
    updated_at: Date.now(),
  });
}

function Panel({ onDone }: { onDone: () => void }) {
  const [builder, setBuilder] = useState(false);
  return (
    <CloudProviderPanel
      workspaceId={WORKSPACE_ID}
      builder={builder}
      onBuilderChange={setBuilder}
      doneLabel="Done"
      onDone={onDone}
      pollIntervalMs={20}
    />
  );
}

function renderPanel(onDone = vi.fn()) {
  return { ...renderWithProviders(<Panel onDone={onDone} />), onDone };
}

describe("cloud provider panel", () => {
  it("connects with a write-only token, explaining rejected and read-only tokens", async () => {
    const { user, queryClient } = renderPanel();
    expect(await screen.findByRole("combobox", { name: "Provider" })).toHaveValue("hetzner");
    const form = screen.getByRole("form", { name: "Connect Hetzner Cloud" });
    expect(form).toHaveTextContent("Read & Write");
    expect(within(form).getByRole("link", { name: /Create a token/ })).toHaveAttribute(
      "href",
      "https://console.hetzner.cloud/projects",
    );
    const field = screen.getByLabelText("Hetzner Cloud API token");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");

    await user.click(screen.getByRole("button", { name: "Connect Hetzner Cloud" }));
    expect(screen.getByText("Paste the API token.")).toBeInTheDocument();

    await user.type(field, "bad-0123456789abcdef");
    await user.click(screen.getByRole("button", { name: "Connect Hetzner Cloud" }));
    expect(await screen.findByText("Hetzner Cloud rejected this token")).toBeInTheDocument();

    await user.clear(field);
    await user.type(field, "ro-0123456789abcdef");
    await user.click(screen.getByRole("button", { name: "Connect Hetzner Cloud" }));
    expect(await screen.findByText(/can't create servers \(missing: Read & Write\)/)).toBeVisible();

    await user.clear(field);
    await user.type(field, TOKEN);
    await user.click(screen.getByRole("button", { name: "Connect Hetzner Cloud" }));
    expect(await screen.findByText(/Connected as demo@example.com/)).toHaveTextContent(
      "Connected as demo@example.com · …cdef",
    );
    expect(screen.queryByLabelText("Hetzner Cloud API token")).not.toBeInTheDocument();
    expect(db.providers.integrations).toHaveLength(1);

    const cached = JSON.stringify([
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
      queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.variables),
    ]);
    expect(cached).not.toContain(TOKEN);
  });

  it("replaces and disconnects a token, forcing past servers it created", async () => {
    connect();
    db.nodes.push({ ...db.nodes[0]!, id: "node_managed", name: "web-9", provider_server_id: "42" });
    const { user } = renderPanel();
    await user.click(await screen.findByRole("button", { name: "Replace token" }));
    expect(screen.getByLabelText("Hetzner Cloud API token")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/1 server\(s\) were created/);
    await user.click(screen.getByRole("button", { name: "Disconnect anyway" }));
    expect(await screen.findByRole("form", { name: "Connect Hetzner Cloud" })).toBeInTheDocument();
    expect(db.providers.integrations).toHaveLength(0);
  });

  it("preselects the recommended plan and scopes regions to it", async () => {
    connect();
    const { user } = renderPanel();
    const recommended = await screen.findByRole("radio", { name: /^cx22/ });
    expect(recommended).toBeChecked();
    const row = recommended.closest("label") as HTMLElement;
    expect(within(row).getByText("Recommended")).toBeInTheDocument();
    expect(within(row).getByText("Cheapest plan that fits")).toBeInTheDocument();
    expect(row).toHaveTextContent("2 vCPU · 4 GB · 40 GB disk · amd64");
    expect(row).toHaveTextContent("€4.51/mo");

    const region = screen.getByRole("combobox", { name: "Region" });
    expect(region).toHaveValue("cx22@fsn1");
    expect(
      within(region)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Falkenstein (fsn1) · €4.51/mo",
      "Nuremberg (nbg1) · €5.01/mo",
      "Helsinki (hel1) · €5.51/mo",
    ]);
    await user.selectOptions(region, "cx22@hel1");
    await user.click(screen.getByRole("radio", { name: /^cx32/ }));
    expect(screen.getByRole("combobox", { name: "Region" })).toHaveValue("cx32@hel1");
    expect(screen.getByText(/billed by Hetzner Cloud/)).toHaveTextContent(
      "cx32 in Helsinki · €9.12/mo",
    );
  });

  it("asks for builder plans when the server builds images", async () => {
    connect();
    const requests: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.url.includes("/offers")) requests.push(new URL(request.url).search);
    });
    const { user } = renderPanel();
    await screen.findByRole("radio", { name: /^cx22/ });
    await user.click(screen.getByRole("checkbox", { name: "Builder node" }));
    await waitFor(() => expect(requests).toContain("?role=builder"));
    expect(await screen.findByText("Cheapest plan with room to build images")).toBeInTheDocument();
    server.events.removeAllListeners();
  });

  it("validates the name like the API does", async () => {
    connect();
    const { user } = renderPanel();
    const name = await screen.findByLabelText("Server name");
    expect((name as HTMLInputElement).value).toMatch(/^server-[a-z2-9]{4}$/);
    await user.clear(name);
    await user.type(name, "Web_1");
    expect(screen.getByText(/Use 1-63 lowercase letters/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create server" })).toBeDisabled();
  });

  it("creates the server and follows it until it joins", async () => {
    connect();
    const { user, onDone } = renderPanel();
    await screen.findByRole("radio", { name: /^cx22/ });
    const name = screen.getByLabelText("Server name");
    await user.clear(name);
    await user.type(name, "web-1");
    await user.click(screen.getByRole("button", { name: "Create server" }));

    const progress = await screen.findByRole("list", { name: "Provisioning progress" });
    expect(
      within(progress)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(expect.arrayContaining([expect.stringContaining("Creating server")]));
    expect(db.providers.provisions[0]).toMatchObject({
      provider: "hetzner",
      plan: "cx22",
      region: "fsn1",
      name: "web-1",
      builder: false,
    });

    expect(await screen.findByText(/joined\. Usage appears/)).toBeInTheDocument();
    const node = db.nodes.find((entry) => entry.name === "web-1");
    expect(node).toMatchObject({ provider: "hetzner", provider_server_id: expect.any(String) });
    expect(within(progress).getAllByText(/\(done\)/)).toHaveLength(3);
    expect(screen.getByRole("link", { name: "View server" })).toHaveAttribute(
      "href",
      `/w/${WORKSPACE_ID}/servers/${node?.id}`,
    );
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalled();
  });

  it("warns that a server whose cleanup failed may still bill", async () => {
    connect();
    const { user } = renderPanel();
    await screen.findByRole("radio", { name: /^cx22/ });
    const name = screen.getByLabelText("Server name");
    await user.clear(name);
    await user.type(name, "leak-1");
    await user.click(screen.getByRole("button", { name: "Create server" }));
    expect(await screen.findByText("Couldn't create the server")).toBeInTheDocument();
    expect(
      screen.getByText(/may still exist at Hetzner Cloud and keep billing/),
    ).toBeInTheDocument();
    expect(screen.getByText(/deleting the server failed/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Create server" })).toBeInTheDocument();
  });

  it("shows why provisioning was refused", async () => {
    connect();
    const { user } = renderPanel();
    await screen.findByRole("radio", { name: /^cx22/ });
    const name = screen.getByLabelText("Server name");
    await user.clear(name);
    await user.type(name, "hel-1");
    await user.click(screen.getByRole("button", { name: "Create server" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A server named hel-1 already exists",
    );
  });

  async function startServer(user: ReturnType<typeof renderPanel>["user"], serverName: string) {
    await screen.findByRole("radio", { name: /^cx22/ });
    const name = screen.getByLabelText("Server name");
    await user.clear(name);
    await user.type(name, serverName);
    await user.click(screen.getByRole("button", { name: "Create server" }));
    await screen.findByRole("list", { name: "Provisioning progress" });
  }

  it("cancels a server still being created once the provider has made it", async () => {
    connect();
    const { user } = renderPanel();
    await startServer(user, "slow-1");
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.getByText(/Anything already created at Hetzner Cloud is deleted/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel and delete" }));

    expect(
      await screen.findByText(/deleted as soon as Hetzner Cloud has finished creating it/),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Cancelled\. Nothing is left running/)).toHaveTextContent(
      /server \d+ was deleted/,
    );
    expect(db.providers.provisions[0]).toMatchObject({ status: "cancelled" });
    expect(db.audit.at(-1)).toMatchObject({
      action: "node.provision_cancelled",
      metadata: { from_status: "creating" },
    });
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start over" }));
    expect(await screen.findByRole("button", { name: "Create server" })).toBeInTheDocument();
  });

  it("asks before cancelling, and cancels a booting server at once", async () => {
    connect();
    const { user } = renderPanel();
    await startServer(user, "wait-1");
    await screen.findByText("Waiting for the server to start");
    await waitFor(() => expect(db.providers.provisions[0]?.status).toBe("booting"));

    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Keep creating" }));
    expect(db.providers.provisions[0]?.cancel_requested_at).toBeNull();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Cancel and delete" }));
    expect(await screen.findByText(/Cancelled\. Nothing is left running/)).toBeInTheDocument();
    expect(db.providers.provisions[0]).toMatchObject({ status: "cancelled" });
    expect(db.nodes.some((node) => node.name === "wait-1")).toBe(false);
  });

  it("explains a cancel the API refused", async () => {
    connect();
    server.use(
      http.post("*/v1/workspaces/:workspaceId/node-provisions/:provisionId/cancel", () =>
        apiError(403, "reauth_required", "Confirm your password to continue"),
      ),
    );
    const { user } = renderPanel();
    await startServer(user, "slow-2");
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Cancel and delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Confirm your password to continue Sign in again, then retry.",
    );
    expect(db.providers.provisions[0]?.cancel_requested_at).toBeNull();
  });
});
