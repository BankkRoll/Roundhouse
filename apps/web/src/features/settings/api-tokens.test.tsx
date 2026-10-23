import { API_TOKEN_PRESETS } from "@openrail/shared";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { SEED } from "../../mocks/deploy-db";
import { findPageHeading, renderApp } from "../../test/render";
import { presetOf, summarizeScopes } from "./token-scopes";

const TOKENS = `/w/${WORKSPACE_ID}/tokens`;
const DAY = 24 * 60 * 60 * 1000;

async function openPage() {
  const app = renderApp(TOKENS);
  await findPageHeading("API tokens");
  const table = await screen.findByRole("table");
  return { ...app, table };
}

function rowOf(table: HTMLElement, name: string) {
  return within(table).getByText(name).closest("tr")!;
}

describe("API tokens page", () => {
  it("lists every token with prefix, permissions, creator, last use, expiry and status", async () => {
    const { table } = await openPage();
    expect(screen.getByText(/^1 active. Tokens let CI/)).toBeInTheDocument();
    const ci = rowOf(table, "github-actions");
    expect(ci).toHaveTextContent("tok_c1Q9…");
    expect(ci).toHaveTextContent("Deploy · 8 scopes");
    expect(ci).toHaveTextContent("Ada Lovelace");
    expect(ci).toHaveTextContent("3h ago");
    expect(ci).toHaveTextContent(/in (79|80)d/);
    expect(within(ci).getByText("Active")).toBeInTheDocument();
    const laptop = rowOf(table, "old laptop");
    expect(laptop).toHaveTextContent("Read only · 5 scopes");
    expect(within(laptop).getByText("Revoked")).toBeInTheDocument();
    expect(within(laptop).queryByRole("button", { name: /Revoke/ })).not.toBeInTheDocument();
    const smoke = rowOf(table, "staging smoke test");
    expect(within(smoke).getByText("Expired")).toBeInTheDocument();
    expect(smoke).toHaveTextContent("Deleted user");
    expect(smoke).toHaveTextContent("never");
    expect(table.textContent).not.toContain("mockmock");
  });

  it("is a settings tab for owners and admins", async () => {
    renderApp(`/w/${WORKSPACE_ID}/settings`);
    const tabs = await screen.findByRole("navigation", { name: "Settings" });
    expect(within(tabs).getByRole("link", { name: "API tokens" })).toHaveAttribute("href", TOKENS);
  });

  it("creates a deploy token and shows its secret exactly once", async () => {
    const { user, table } = await openPage();
    await user.click(screen.getByRole("button", { name: "Create token" }));
    const dialog = await screen.findByRole("dialog", { name: "Create API token" });
    await user.type(within(dialog).getByLabelText("Name"), "ci-deploy");
    await user.click(within(dialog).getByRole("radio", { name: /^Deploy/ }));
    await user.selectOptions(within(dialog).getByLabelText("Expires after"), "30 days");
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));

    const done = await screen.findByRole("dialog", { name: "Token created" });
    const created = db.deploy.tokens.at(-1)!;
    expect(created).toMatchObject({ name: "ci-deploy", scopes: [...API_TOKEN_PRESETS.deploy] });
    expect(created.expires_at! - created.created_at).toBe(30 * DAY);
    expect(within(done).getByText(created.secret)).toBeInTheDocument();
    expect(within(done).getByText("You won't be able to see it again.")).toBeInTheDocument();
    expect(within(done).getByRole("button", { name: "Copy to clipboard" })).toBeInTheDocument();
    await user.click(within(done).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    expect(within(table).getByText("ci-deploy")).toBeInTheDocument();
    expect(screen.queryByText(created.secret)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create token" }));
    const again = await screen.findByRole("dialog", { name: "Create API token" });
    expect(within(again).getByLabelText("Name")).toHaveValue("");
  });

  it("validates the name and requires at least one custom scope", async () => {
    const { user } = await openPage();
    await user.click(screen.getByRole("button", { name: "Create token" }));
    const dialog = await screen.findByRole("dialog", { name: "Create API token" });
    await user.click(within(dialog).getByRole("radio", { name: /^Custom/ }));
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    expect(within(dialog).getByText(/Name the token/)).toBeInTheDocument();
    expect(within(dialog).getByText("Pick at least one permission.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Name"), "log-shipper");
    await user.click(within(dialog).getByRole("checkbox", { name: "Read the audit log" }));
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    await screen.findByRole("dialog", { name: "Token created" });
    expect(db.deploy.tokens.at(-1)).toMatchObject({
      name: "log-shipper",
      scopes: ["audit:read"],
      expires_at: expect.any(Number),
    });
  });

  it("disables scopes the caller's role can't grant", async () => {
    signInAs(USERS.admin.id);
    const { user } = await openPage();
    await user.click(screen.getByRole("button", { name: "Create token" }));
    const dialog = await screen.findByRole("dialog", { name: "Create API token" });
    await user.click(within(dialog).getByRole("radio", { name: /^Custom/ }));
    const scopes = within(dialog).getByRole("list", { name: "Scopes" });
    expect(
      within(scopes).getByRole("checkbox", { name: /Delete the workspace.*can't grant/ }),
    ).toBeDisabled();
    expect(within(scopes).getByRole("checkbox", { name: "Add and remove servers" })).toBeEnabled();
  });

  it("creates a token that never expires", async () => {
    const { user } = await openPage();
    await user.click(screen.getByRole("button", { name: "Create token" }));
    const dialog = await screen.findByRole("dialog", { name: "Create API token" });
    await user.type(within(dialog).getByLabelText("Name"), "forever");
    await user.selectOptions(within(dialog).getByLabelText("Expires after"), "Never");
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    await screen.findByRole("dialog", { name: "Token created" });
    expect(db.deploy.tokens.at(-1)).toMatchObject({
      name: "forever",
      expires_at: null,
      scopes: [...API_TOKEN_PRESETS.read],
    });
  });

  it("revokes a token after confirming", async () => {
    const { user, table } = await openPage();
    await user.click(
      within(rowOf(table, "github-actions")).getByRole("button", {
        name: "Revoke github-actions (tok_c1Q9…)",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Revoke github-actions (tok_c1Q9…)?",
    });
    expect(dialog).toHaveTextContent("stops working at once");
    await user.click(within(dialog).getByRole("button", { name: "Revoke token" }));
    expect(await screen.findByText("Revoked github-actions")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(rowOf(table, "github-actions")).getByText("Revoked")).toBeInTheDocument(),
    );
    expect(db.deploy.tokens.find((token) => token.id === SEED.ciToken)?.revoked_at).toEqual(
      expect.any(Number),
    );
    expect(db.audit.at(-1)).toMatchObject({ action: "token.revoked" });
  });

  it("explains itself to members, who can't manage tokens", async () => {
    signInAs(USERS.member.id);
    renderApp(TOKENS);
    expect(
      await screen.findByRole("heading", { name: "API tokens are for owners and admins" }),
    ).toBeInTheDocument();
    const tabs = screen.getByRole("navigation", { name: "Settings" });
    expect(within(tabs).queryByRole("link", { name: "API tokens" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create token" })).not.toBeInTheDocument();
  });

  it("offers the first token when there are none", async () => {
    db.deploy.tokens = [];
    renderApp(TOKENS);
    expect(await screen.findByRole("heading", { name: "No API tokens yet" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Create token" })).toHaveLength(2);
  });
});

describe("token scopes", () => {
  it("names presets and summarises custom sets", () => {
    expect(presetOf([...API_TOKEN_PRESETS.read].reverse())).toBe("read");
    expect(presetOf(["audit:read"])).toBe("custom");
    expect(summarizeScopes(["audit:read"])).toBe("Custom · 1 scope");
  });
});
