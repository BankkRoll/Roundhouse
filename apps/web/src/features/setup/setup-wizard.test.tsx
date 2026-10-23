import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { db, MASTER_KEY, makeNode, seedFreshInstall } from "../../mocks/db";
import { apiError } from "../../mocks/handlers";
import { MOCK_BACKUP_CODES, MOCK_TOTP_CODE } from "../../mocks/security-db";
import { server } from "../../mocks/server";
import { expectPath, findPageHeading, renderApp } from "../../test/render";

const ADMIN = {
  name: "Ada Lovelace",
  email: "ada@example.org",
  password: "analytical-engine-1843",
  workspace: "Engines Inc",
};

async function fillAccountForm(
  user: ReturnType<typeof renderApp>["user"],
  overrides: Partial<typeof ADMIN & { confirm: string }> = {},
) {
  const values = { ...ADMIN, confirm: overrides.password ?? ADMIN.password, ...overrides };
  await user.type(screen.getByLabelText("Your name"), values.name);
  await user.type(screen.getByLabelText("Email"), values.email);
  await user.type(screen.getByLabelText("Password"), values.password);
  await user.type(screen.getByLabelText("Confirm password"), values.confirm);
  await user.type(screen.getByLabelText("Workspace name"), values.workspace);
}

/** Turns on two-factor through the wizard's step 3 dialog. */
async function enrollTwoFactor(user: ReturnType<typeof renderApp>["user"]) {
  await screen.findByRole("heading", { name: "Turn on two-factor authentication" });
  await user.click(screen.getByRole("button", { name: "Set up two-factor" }));
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByLabelText("Password"), ADMIN.password);
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  expect(
    await within(dialog).findByRole("img", { name: "QR code for your authenticator app" }),
  ).toBeInTheDocument();
  await user.type(within(dialog).getByLabelText("Code from the app"), MOCK_TOTP_CODE);
  await user.click(within(dialog).getByRole("button", { name: "Turn on" }));
  expect(await within(dialog).findByText(MOCK_BACKUP_CODES[0]!)).toBeInTheDocument();
  const done = within(dialog).getByRole("button", { name: "Done" });
  expect(done).toBeDisabled();
  await user.click(within(dialog).getByLabelText("I've saved these codes somewhere safe"));
  await user.click(done);
}

function currentStep() {
  const progress = screen.getByRole("list", { name: "Setup progress" });
  return within(progress)
    .getAllByRole("listitem")
    .find((item) => item.getAttribute("aria-current") === "step")?.textContent;
}

describe("setup wizard", () => {
  it("walks from master key to admin account to first server", async () => {
    seedFreshInstall(false);
    const { router, user } = renderApp("/setup");

    expect(
      await screen.findByRole("heading", { name: "Configure the master key" }),
    ).toBeInTheDocument();
    expect(currentStep()).toContain("Master key");
    expect(screen.getByText("npx wrangler secret put MASTER_KEY")).toBeInTheDocument();

    const suggested = screen.getByText(/^[A-Za-z0-9+/]{43}=$/).textContent ?? "";
    expect(atob(suggested)).toHaveLength(32);

    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Still no MASTER_KEY");

    db.setup.master_key_configured = true;
    db.masterKey = suggested;
    await user.click(screen.getByRole("button", { name: "Check again" }));

    expect(
      await screen.findByRole("heading", { name: "Create the admin account" }),
    ).toBeInTheDocument();
    expect(currentStep()).toContain("Admin");
    expect(screen.getByLabelText("Master key")).toHaveValue(suggested);

    await fillAccountForm(user);
    await user.click(screen.getByRole("button", { name: "Create admin account" }));

    await screen.findByRole("heading", { name: "Turn on two-factor authentication" });
    expect(currentStep()).toContain("Two-factor");
    await enrollTwoFactor(user);
    expect(db.security.twoFactor[db.users[0]!.id]).toBeDefined();

    expect(
      await screen.findByRole("heading", { name: "Add your first server" }),
    ).toBeInTheDocument();
    expect(currentStep()).toContain("First server");
    expect(await screen.findByText(/curl -fsSL .*install\.sh/)).toBeInTheDocument();
    expect(db.users[0]).toMatchObject({ name: ADMIN.name, email: ADMIN.email });
    expect(db.workspaces[0]?.name).toBe(ADMIN.workspace);

    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    const workspaceId = db.workspaces[0]?.id ?? "";
    await expectPath(router, `/w/${workspaceId}`);
    expect(await findPageHeading("Home")).toBeInTheDocument();
  });

  it("starts at the account step with an empty key when MASTER_KEY already exists", async () => {
    seedFreshInstall(true);
    renderApp("/setup");
    expect(
      await screen.findByRole("heading", { name: "Create the admin account" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Master key")).toHaveValue("");
  });

  it("never persists the suggested key", async () => {
    seedFreshInstall(false);
    renderApp("/setup");
    const suggested = (await screen.findByText(/^[A-Za-z0-9+/]{43}=$/)).textContent ?? "";
    expect(JSON.stringify({ ...localStorage })).not.toContain(suggested);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(suggested);
    expect(window.location.href).not.toContain(suggested);
  });

  it("validates the form before calling the API", async () => {
    seedFreshInstall(true);
    const { user } = renderApp("/setup");
    await screen.findByRole("heading", { name: "Create the admin account" });
    await fillAccountForm(user, { password: "too-short", confirm: "not-the-same", email: "nope" });
    await user.click(screen.getByRole("button", { name: "Create admin account" }));

    expect(screen.getByText("Paste the MASTER_KEY you stored on the Worker.")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Use at least 12 characters.")).toBeInTheDocument();
    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
    expect(db.users).toHaveLength(0);
  });

  it("rejects a master key that does not match the Worker secret", async () => {
    seedFreshInstall(true);
    const { user } = renderApp("/setup");
    await screen.findByRole("heading", { name: "Create the admin account" });
    await user.type(screen.getByLabelText("Master key"), "not-the-key");
    await fillAccountForm(user);
    await user.click(screen.getByRole("button", { name: "Create admin account" }));

    expect(
      await screen.findByText("This does not match the MASTER_KEY secret on the Worker."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Master key")).toHaveAttribute("aria-invalid", "true");
    expect(db.users).toHaveLength(0);
  });

  it("sends the master key with the setup request", async () => {
    seedFreshInstall(true);
    let body: Record<string, unknown> = {};
    server.use(
      http.post("*/v1/setup", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ user_id: "usr_x", workspace_id: "ws_x" }, { status: 201 });
      }),
    );
    const { user } = renderApp("/setup");
    await screen.findByRole("heading", { name: "Create the admin account" });
    await user.type(screen.getByLabelText("Master key"), `  ${MASTER_KEY}  `);
    await fillAccountForm(user);
    await user.click(screen.getByRole("button", { name: "Create admin account" }));
    await waitFor(() =>
      expect(body).toEqual({
        master_key: MASTER_KEY,
        name: ADMIN.name,
        email: ADMIN.email,
        password: ADMIN.password,
        workspace_name: ADMIN.workspace,
      }),
    );
  });

  it("goes back to the master key step when the API says the key is missing", async () => {
    seedFreshInstall(true);
    const { user } = renderApp("/setup");
    await screen.findByRole("heading", { name: "Create the admin account" });
    db.setup.master_key_configured = false;
    await user.type(screen.getByLabelText("Master key"), MASTER_KEY);
    await fillAccountForm(user);
    await user.click(screen.getByRole("button", { name: "Create admin account" }));
    expect(
      await screen.findByRole("heading", { name: "Configure the master key" }),
    ).toBeInTheDocument();
  });

  it("sends people to sign in when someone else finished setup first", async () => {
    seedFreshInstall(true);
    const { router, user } = renderApp("/setup");
    await screen.findByRole("heading", { name: "Create the admin account" });
    db.setup.needs_setup = false;
    db.sessionUserId = null;
    await user.type(screen.getByLabelText("Master key"), MASTER_KEY);
    await fillAccountForm(user);
    await user.click(screen.getByRole("button", { name: "Create admin account" }));
    await expectPath(router, "/login");
  });

  it("forgets the master key and password once the form is gone", async () => {
    seedFreshInstall(true);
    const { router, user } = renderApp("/setup");
    await screen.findByRole("heading", { name: "Create the admin account" });
    await user.type(screen.getByLabelText("Master key"), MASTER_KEY);
    await fillAccountForm(user);
    await user.click(screen.getByRole("button", { name: "Create admin account" }));
    await enrollTwoFactor(user);
    await screen.findByRole("heading", { name: "Add your first server" });
    const cache = router.options.context.queryClient.getMutationCache();
    await waitFor(() => {
      const state = JSON.stringify(cache.getAll().map((mutation) => mutation.state));
      expect(state).not.toContain(MASTER_KEY);
      expect(state).not.toContain(ADMIN.password);
      expect(state).not.toContain(MOCK_BACKUP_CODES[0]);
      expect(state).not.toContain("otpauth://");
    });
  });

  it("shows unexpected errors inline", async () => {
    seedFreshInstall(true);
    server.use(http.post("*/v1/setup", () => apiError(500, "internal", "D1 is unavailable")));
    const { user } = renderApp("/setup");
    await screen.findByRole("heading", { name: "Create the admin account" });
    await user.type(screen.getByLabelText("Master key"), MASTER_KEY);
    await fillAccountForm(user);
    await user.click(screen.getByRole("button", { name: "Create admin account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("D1 is unavailable");
  });

  it("lets the admin skip two-factor for now and land on the dashboard", async () => {
    seedFreshInstall(true);
    const { router, user } = renderApp("/setup");
    await screen.findByRole("heading", { name: "Create the admin account" });
    await user.type(screen.getByLabelText("Master key"), MASTER_KEY);
    await fillAccountForm(user);
    await user.click(screen.getByRole("button", { name: "Create admin account" }));
    await screen.findByRole("heading", { name: "Turn on two-factor authentication" });
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    const workspaceId = db.workspaces[0]?.id ?? "";
    await expectPath(router, `/w/${workspaceId}`);
    expect(await screen.findByRole("link", { name: "Set up two-factor" })).toBeInTheDocument();
  });

  it("asks for PUBLIC_ORIGIN before the account when it is missing", async () => {
    seedFreshInstall(true);
    db.setup.public_origin_configured = false;
    const { user } = renderApp("/setup");
    expect(await screen.findByRole("heading", { name: "Set the public URL" })).toBeInTheDocument();
    expect(screen.getByText("npx wrangler secret put PUBLIC_ORIGIN")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Still no PUBLIC_ORIGIN");
    db.setup.public_origin_configured = true;
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(
      await screen.findByRole("heading", { name: "Create the admin account" }),
    ).toBeInTheDocument();
  });

  it("finishes when the first server connects", async () => {
    seedFreshInstall(true);
    const { router, user } = renderApp("/setup");
    await screen.findByRole("heading", { name: "Create the admin account" });
    await user.type(screen.getByLabelText("Master key"), MASTER_KEY);
    await fillAccountForm(user);
    await user.click(screen.getByRole("button", { name: "Create admin account" }));
    await enrollTwoFactor(user);
    await screen.findByText(/curl -fsSL/);
    await screen.findByText("Waiting for the server to connect…");

    const workspaceId = db.workspaces[0]?.id ?? "";
    db.nodes.push({
      ...makeNode({ id: "node_new", name: "first-box" }),
      workspace_id: workspaceId,
    });
    await router.options.context.queryClient.refetchQueries({
      queryKey: ["workspaces", workspaceId, "nodes"],
    });

    expect(await screen.findByText("first-box")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Go to dashboard" }));
    await expectPath(router, `/w/${workspaceId}`);
  });
});
