import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api/client";
import {
  db,
  INVITE_TOKEN,
  PASSWORD,
  seedFreshInstall,
  signInAs,
  USERS,
  WORKSPACE_ID,
} from "../../mocks/db";
import { apiError } from "../../mocks/handlers";
import { server } from "../../mocks/server";
import { expectPath, findPageHeading, renderApp } from "../../test/render";
import { signInErrorMessage } from "./login-page";

describe("route guards", () => {
  it("sends a fresh install to the setup wizard", async () => {
    seedFreshInstall();
    const { router } = renderApp("/dashboard");
    await expectPath(router, "/setup");
  });

  it("sends signed-out visitors to the login page", async () => {
    signInAs(null);
    const { router } = renderApp("/dashboard");
    await expectPath(router, "/login");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("remembers the deep link a signed-out visitor asked for", async () => {
    signInAs(null);
    const { router } = renderApp(`/w/${WORKSPACE_ID}/servers`);
    await expectPath(router, "/login");
    expect(router.state.location.search).toEqual({ redirect: `/w/${WORKSPACE_ID}/servers` });
  });

  it("opens the first workspace for signed-in users", async () => {
    const { router } = renderApp("/dashboard");
    await expectPath(router, `/w/${WORKSPACE_ID}`);
    expect(await findPageHeading("Home")).toBeInTheDocument();
  });

  it("redirects away from workspaces the user is not a member of", async () => {
    const { router } = renderApp("/w/ws_someone_else/servers");
    await expectPath(router, `/w/${WORKSPACE_ID}`);
  });

  it("asks people without a workspace to get an invite, and lets them sign out", async () => {
    db.memberships = db.memberships.filter((row) => row.user_id !== USERS.viewer.id);
    signInAs(USERS.viewer.id);
    const { router, user } = renderApp("/dashboard");
    expect(
      await screen.findByRole("heading", { name: "You're not in a workspace yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Ask a workspace admin to send you an invite link/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Workspace name")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await expectPath(router, "/login");
    expect(db.sessionUserId).toBeNull();
  });

  it("keeps finished installs out of the setup wizard", async () => {
    const { router } = renderApp("/setup");
    await expectPath(router, `/w/${WORKSPACE_ID}`);
  });

  it("shows the router error page when /v1/me fails unexpectedly", async () => {
    server.use(http.get("*/v1/me", () => apiError(500, "internal", "Database unavailable")));
    renderApp("/dashboard");
    expect(await screen.findByText("Database unavailable")).toBeInTheDocument();
  });

  it("shows not found for unknown URLs", async () => {
    renderApp("/definitely/not/a/page");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  });

  it("navigates to sign in exactly once when the guard finds no session", async () => {
    signInAs(null);
    const { router } = renderApp(`/w/${WORKSPACE_ID}/servers`);
    const visits: string[] = [];
    const unsubscribe = router.subscribe("onResolved", ({ toLocation }) => {
      visits.push(toLocation.href);
    });
    await expectPath(router, "/login");
    await new Promise((resolve) => setTimeout(resolve, 50));
    unsubscribe();
    expect(visits.filter((href) => href.startsWith("/login"))).toHaveLength(1);
    expect(router.state.location.search).toEqual({ redirect: `/w/${WORKSPACE_ID}/servers` });
  });
});

describe("login", () => {
  it("redirects to setup when the instance needs setup", async () => {
    seedFreshInstall();
    const { router } = renderApp("/login");
    await expectPath(router, "/setup");
  });

  it("skips the form when already signed in", async () => {
    const { router } = renderApp(
      `/login?redirect=${encodeURIComponent(`/w/${WORKSPACE_ID}/servers`)}`,
    );
    await expectPath(router, `/w/${WORKSPACE_ID}/servers`);
  });

  it("signs in and continues to the requested page", async () => {
    signInAs(null);
    const { router, user } = renderApp(`/w/${WORKSPACE_ID}/servers`);
    await screen.findByRole("heading", { name: "Sign in" });
    await user.type(screen.getByLabelText("Email"), USERS.admin.email);
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await expectPath(router, `/w/${WORKSPACE_ID}/servers`);
    expect(await findPageHeading("Servers")).toBeInTheDocument();
    expect(db.sessionUserId).toBe(USERS.admin.id);
  });

  it("goes home after signing in without a redirect", async () => {
    signInAs(null);
    const { router, user } = renderApp("/login");
    await user.type(await screen.findByLabelText("Email"), USERS.owner.email);
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await expectPath(router, `/w/${WORKSPACE_ID}`);
  });

  it("ignores off-site redirect targets", async () => {
    signInAs(null);
    const { router, user } = renderApp(`/login?redirect=${encodeURIComponent("//evil.example/x")}`);
    await user.type(await screen.findByLabelText("Email"), USERS.owner.email);
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await expectPath(router, `/w/${WORKSPACE_ID}`);
  });

  it("says the credentials are wrong only for a 401", async () => {
    signInAs(null);
    const { router, user } = renderApp("/login");
    await user.type(await screen.findByLabelText("Email"), USERS.owner.email);
    await user.type(screen.getByLabelText("Password"), "wrong-password-123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password.");
    expect(router.state.location.pathname).toBe("/login");
  });

  it.each([
    [
      429,
      () => apiError(429, "rate_limited", "Too many attempts; try again in a minute"),
      "Too many attempts, try again in a minute.",
    ],
    [
      503,
      () => apiError(503, "master_key_missing", "MASTER_KEY is not configured."),
      "npx wrangler secret put MASTER_KEY",
    ],
    [
      403,
      () => HttpResponse.json({ message: "Invalid origin" }, { status: 403 }),
      "The server refused this sign-in request.",
    ],
  ])("explains a %i instead of blaming the password", async (_, respond, message) => {
    signInAs(null);
    server.use(http.post("*/api/auth/sign-in/email", respond));
    const { user } = renderApp("/login");
    await user.type(await screen.findByLabelText("Email"), USERS.owner.email);
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent("Invalid email or password");
  });

  it("validates empty fields without calling the API", async () => {
    signInAs(null);
    const { user } = renderApp("/login");
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your email and password.");
  });

  it("reports network failures", async () => {
    signInAs(null);
    server.use(http.post("*/api/auth/sign-in/email", () => HttpResponse.error()));
    const { user } = renderApp("/login");
    await user.type(await screen.findByLabelText("Email"), USERS.owner.email);
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server");
  });
});

describe("signInErrorMessage", () => {
  it("passes through other API messages and non-API errors", () => {
    expect(signInErrorMessage(new ApiError(500, "internal", "Internal error"))).toBe(
      "Internal error",
    );
    expect(signInErrorMessage(new Error("boom"))).toBe("boom");
  });
});

describe("sign out", () => {
  it("keeps the session and the page when the server refuses to sign out", async () => {
    server.use(http.post("*/api/auth/sign-out", () => apiError(500, "internal", "D1 is down")));
    const { router, user } = renderApp(`/w/${WORKSPACE_ID}`);
    await findPageHeading("Home");
    await user.click(screen.getByRole("button", { name: /^Ada Lovelace, account menu$/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByText("Could not sign out")).toBeInTheDocument();
    expect(screen.getByText("D1 is down")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/w/${WORKSPACE_ID}`);
    expect(db.sessionUserId).toBe(USERS.owner.id);
    expect(screen.getByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
  });
});

describe("invite", () => {
  const INVITE = `/invite#token=${INVITE_TOKEN}`;

  beforeEach(() => sessionStorage.clear());

  it("lets a new person create an account and join, without flashing the signed-in view", async () => {
    signInAs(null);
    const { router, user, queryClient } = renderApp(INVITE);
    expect(await screen.findByRole("heading", { name: "Join Acme" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("erin@example.com");
    await user.type(screen.getByLabelText("Your name"), "Erin");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.type(screen.getByLabelText("Confirm password"), "different");
    await user.click(screen.getByRole("button", { name: "Create account and join" }));
    expect(screen.getByText("Use at least 12 characters.")).toBeInTheDocument();
    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Password"));
    await user.clear(screen.getByLabelText("Confirm password"));
    await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
    await user.type(screen.getByLabelText("Confirm password"), "a-long-enough-password");

    let flashed = false;
    const observer = new MutationObserver(() => {
      if (screen.queryByRole("button", { name: "Accept invite" })) flashed = true;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    await user.click(screen.getByRole("button", { name: "Create account and join" }));
    await expectPath(router, `/w/${WORKSPACE_ID}`);
    await findPageHeading("Home");
    observer.disconnect();

    expect(flashed).toBe(false);
    expect(db.users.find((u) => u.email === "erin@example.com")?.name).toBe("Erin");
    expect(db.invites[0]?.accepted_at).toEqual(expect.any(Number));
    // SECURITY: The password must not linger in the mutation cache after the form unmounts.
    await waitFor(() =>
      expect(
        JSON.stringify(
          queryClient
            .getMutationCache()
            .getAll()
            .map((m) => m.state),
        ),
      ).not.toContain("a-long-enough-password"),
    );
  });

  it("lets a signed-in user with the invited email accept with one click", async () => {
    const invite = db.invites[0];
    if (invite) invite.email = USERS.viewer.email;
    db.memberships = db.memberships.filter((row) => row.user_id !== USERS.viewer.id);
    signInAs(USERS.viewer.id);
    const { router, user } = renderApp(INVITE);
    expect(await screen.findByText(USERS.viewer.email)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accept invite" }));
    await expectPath(router, `/w/${WORKSPACE_ID}`);
  });

  it("stops a different signed-in account up front and offers to sign out", async () => {
    signInAs(USERS.viewer.id);
    const { router, user } = renderApp(INVITE);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You're signed in as dan@example.com; this invite is for erin@example.com.",
    );
    expect(screen.queryByRole("button", { name: "Accept invite" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out to continue" }));
    expect(
      await screen.findByRole("button", { name: "Create account and join" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/invite");
    expect(db.sessionUserId).toBeNull();
  });

  it("explains invalid links", async () => {
    signInAs(null);
    renderApp("/invite#token=inv_nope");
    expect(await screen.findByRole("heading", { name: "Invite unavailable" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/login");
  });

  it.each([
    ["expired", { expires_at: Date.now() - 1000 }],
    ["already used", { accepted_at: Date.now() - 1000 }],
  ])("treats %s invites as unavailable (the API answers 404)", async (_, change) => {
    signInAs(null);
    Object.assign(db.invites[0] ?? {}, change);
    renderApp(INVITE);
    expect(await screen.findByRole("heading", { name: "Invite unavailable" })).toBeInTheDocument();
  });

  it("asks people who already have an account to sign in first", async () => {
    signInAs(null);
    const invite = db.invites[0];
    if (invite) invite.email = USERS.member.email;
    const { user } = renderApp(INVITE);
    await user.type(await screen.findByLabelText("Your name"), "Cara");
    await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
    await user.type(screen.getByLabelText("Confirm password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: "Create account and join" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An account with this email exists; sign in first",
    );
    expect(screen.getByRole("link", { name: "Sign in first" })).toBeInTheDocument();
  });

  it("links existing users to sign in first and come back", async () => {
    signInAs(null);
    renderApp(INVITE);
    const link = await screen.findByRole("link", { name: "Sign in first" });
    expect(link.getAttribute("href")).toBe(`/login?redirect=${encodeURIComponent("/invite")}`);
  });

  it("takes the token out of the address bar and sends it only in request bodies", async () => {
    signInAs(null);
    const requests: { url: string; body: string }[] = [];
    const onRequest = ({ request }: { request: Request }) => {
      void request
        .clone()
        .text()
        .then((body) => requests.push({ url: request.url, body }));
    };
    server.events.on("request:start", onRequest);
    try {
      const { router } = renderApp(INVITE);
      expect(await screen.findByRole("heading", { name: "Join Acme" })).toBeInTheDocument();
      expect(router.state.location.hash).toBe("");
      expect(router.state.location.href).not.toContain(INVITE_TOKEN);
      await waitFor(() =>
        expect(requests.some((r) => r.url.endsWith("/v1/invites/lookup"))).toBe(true),
      );
    } finally {
      server.events.removeListener("request:start", onRequest);
    }
    for (const r of requests) expect(r.url).not.toContain(INVITE_TOKEN);
    expect(requests.find((r) => r.url.endsWith("/v1/invites/lookup"))?.body).toBe(
      JSON.stringify({ token: INVITE_TOKEN }),
    );
  });

  it("keeps working after a reload or the sign-in detour, then forgets the token", async () => {
    signInAs(null);
    const first = renderApp(INVITE);
    expect(await screen.findByRole("heading", { name: "Join Acme" })).toBeInTheDocument();
    first.unmount();

    const { router, user } = renderApp("/invite");
    expect(await screen.findByRole("heading", { name: "Join Acme" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Your name"), "Erin");
    await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
    await user.type(screen.getByLabelText("Confirm password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: "Create account and join" }));
    await expectPath(router, `/w/${WORKSPACE_ID}`);
    expect(sessionStorage.length).toBe(0);
  });

  it("asks for the full link when there is no token", async () => {
    signInAs(null);
    renderApp("/invite");
    expect(await screen.findByRole("heading", { name: "Invite unavailable" })).toBeInTheDocument();
    expect(screen.getByText(/needs the full invite link/)).toBeInTheDocument();
  });

  it("forgets a token the API refused", async () => {
    signInAs(null);
    renderApp("/invite#token=inv_nope");
    expect(await screen.findByRole("heading", { name: "Invite unavailable" })).toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.length).toBe(0));
  });
});
