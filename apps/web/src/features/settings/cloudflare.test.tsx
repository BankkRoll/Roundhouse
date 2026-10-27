import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  cloudflareMock,
  connectCloudflareMock,
  REFUSED_CLOUDFLARE_TOKEN,
} from "../../mocks/cloudflare-handlers";
import { db, PASSWORD, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { renderApp } from "../../test/render";

const PAGE = `/w/${WORKSPACE_ID}/cloudflare`;
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-token-0123456789abcdefWXYZ";

describe("Settings → Cloudflare", () => {
  it("is listed under Instance for instance admins", async () => {
    renderApp(PAGE);
    const nav = await screen.findByRole("navigation", { name: "Settings" });
    expect(within(nav).getByRole("link", { name: "Cloudflare" })).toHaveAttribute("href", PAGE);
  });

  it("explains itself to everyone else", async () => {
    signInAs(USERS.admin.id);
    renderApp(PAGE);
    expect(await screen.findByText("Cloudflare is set up by instance admins")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(within(nav).queryByRole("link", { name: "Cloudflare" })).not.toBeInTheDocument();
  });

  it("connects an account after confirming the password, and never shows the token again", async () => {
    db.sessionStale = true;
    const { user } = renderApp(PAGE);
    const form = await screen.findByRole("form", { name: "Cloudflare account" });
    expect(within(form).getByText("Not set up")).toBeInTheDocument();
    await user.type(within(form).getByLabelText("Account ID"), ACCOUNT);
    const token = within(form).getByLabelText("API token");
    expect(token).toHaveAttribute("type", "password");
    await user.type(token, TOKEN);
    await user.click(within(form).getByRole("switch", { name: "Apps domain is proxied" }));
    await user.click(within(form).getByRole("button", { name: "Connect account" }));

    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(reauth).getByLabelText("Password"), PASSWORD);
    await user.click(within(reauth).getByRole("button", { name: "Confirm" }));

    expect(await within(form).findByText("Connected")).toBeInTheDocument();
    expect(cloudflareMock.token).toBe(TOKEN);
    expect(cloudflareMock.instance.apps_domain_proxied).toBe(true);
    expect(within(form).getByText("…WXYZ")).toBeInTheDocument();
    expect(within(form).queryByLabelText("API token")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(within(form).getByText(ACCOUNT)).toBeInTheDocument();
  });

  it("validates the fields and shows the API's refusal", async () => {
    const { user } = renderApp(PAGE);
    const form = await screen.findByRole("form", { name: "Cloudflare account" });
    await user.type(within(form).getByLabelText("Account ID"), "nope");
    await user.click(within(form).getByRole("button", { name: "Connect account" }));
    expect(within(form).getByText(/32-character account ID/)).toBeInTheDocument();
    expect(within(form).getByText("Enter the API token.")).toBeInTheDocument();

    await user.clear(within(form).getByLabelText("Account ID"));
    await user.type(within(form).getByLabelText("Account ID"), ACCOUNT);
    await user.type(within(form).getByLabelText("API token"), REFUSED_CLOUDFLARE_TOKEN);
    await user.click(within(form).getByRole("button", { name: "Connect account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/lacks Containers → Edit/);
    expect(cloudflareMock.instance.configured).toBe(false);
  });

  it("verifies the token check by check", async () => {
    connectCloudflareMock();
    cloudflareMock.checks[2] = {
      name: "Workers Routes",
      ok: false,
      message: "The token can't edit routes on apps.example.com.",
    };
    const { user } = renderApp(PAGE);
    await user.click(await screen.findByRole("button", { name: "Verify" }));
    const list = await screen.findByRole("list", { name: "Verification checks" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("Workers Scripts passed");
    expect(items[2]).toHaveTextContent("Workers Routes failed");
    expect(items[2]).toHaveTextContent("can't edit routes");
    expect(screen.getByText(/Some checks failed/)).toBeInTheDocument();
  });

  it("shows routing, the workers.dev subdomain, storage and the gateway as unavailable", async () => {
    connectCloudflareMock();
    renderApp(PAGE);
    expect(await screen.findByText("Proxied")).toBeInTheDocument();
    expect(screen.getByText("acme.workers.dev")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Image storage" })).toHaveAttribute(
      "aria-valuenow",
      "10",
    );
    expect(screen.getByText("5 GB of 50 GB")).toBeInTheDocument();
    expect(screen.getByText("Edge gateway (experimental)")).toBeInTheDocument();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("removes the account", async () => {
    connectCloudflareMock();
    const { user } = renderApp(PAGE);
    const form = await screen.findByRole("form", { name: "Cloudflare account" });
    await user.click(await within(form).findByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Remove account" }));
    await waitFor(() => expect(cloudflareMock.instance.configured).toBe(false));
    expect(await within(form).findByText("Not set up")).toBeInTheDocument();
  });
});
