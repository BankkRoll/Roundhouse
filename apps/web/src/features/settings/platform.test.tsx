import { screen, waitFor, within } from "@testing-library/react";
import { http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { external } from "../../lib/external";
import { db, SIGNING_KID, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { apiError } from "../../mocks/handlers";
import { server } from "../../mocks/server";
import { findPageHeading, renderApp } from "../../test/render";
import { githubPostUrl, submitGithubManifest } from "./github-manifest";
import { MCP_DOCS_URL } from "./platform-page";

const PLATFORM = `/w/${WORKSPACE_ID}/platform`;

afterEach(() => vi.restoreAllMocks());

describe("GitHub manifest submission", () => {
  it("posts the manifest to GitHub in a hidden form", () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
    const form = submitGithubManifest(
      { name: "Roundhouse", default_events: ["push"] },
      "https://github.com/settings/apps/new?state=abc",
    );
    expect(form.method).toBe("post");
    expect(form.action).toBe("https://github.com/settings/apps/new?state=abc");
    const input = form.querySelector("input[name=manifest]") as HTMLInputElement;
    expect(input.type).toBe("hidden");
    expect(JSON.parse(input.value)).toEqual({ name: "Roundhouse", default_events: ["push"] });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each([
    "http://github.com/settings/apps/new",
    "https://github.com.evil.example/settings/apps/new",
    "https://evil.example/settings/apps/new",
    "https://github.com/login",
    "javascript:alert(1)",
    "not a url",
  ])("refuses to post anywhere but GitHub's App page: %s", (url) => {
    expect(() => githubPostUrl(url)).toThrow();
  });
});

describe("platform settings", () => {
  it("lets owners set the apps domain and TLS mode", async () => {
    const { user } = renderApp(PLATFORM);
    await findPageHeading("Platform");
    const form = await screen.findByRole("form", { name: "Ingress" });
    const domain = within(form).getByLabelText("Apps domain");
    expect(domain).toHaveValue("apps.example.com");
    await user.clear(domain);
    await user.type(domain, "Not A Host");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(within(form).getByText(/Enter a hostname/)).toBeInTheDocument();
    await user.clear(domain);
    await user.type(domain, "127.0.0.1.nip.io");
    await user.selectOptions(within(form).getByLabelText("TLS mode"), "internal");
    expect(within(form).getByText(/local CA/)).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Platform settings saved")).toBeInTheDocument();
    expect(db.deploy.instance).toEqual({
      apps_domain: "127.0.0.1.nip.io",
      tls_mode: "internal",
      log_retention_days: 7,
      mcp_enabled: false,
    });
  });

  it("lets instance admins turn MCP on and off, off by default, with a link to the docs", async () => {
    const { user } = renderApp(PLATFORM);
    const toggle = await screen.findByRole("switch", { name: "Allow coding agents" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/While off, \/mcp answers 404 to everyone/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "How agents connect" })).toHaveAttribute(
      "href",
      MCP_DOCS_URL,
    );
    expect(MCP_DOCS_URL).toMatch(/apps\/api\/README\.md#mcp$/);

    await user.click(toggle);
    expect(await screen.findByText("MCP enabled")).toBeInTheDocument();
    expect(db.deploy.instance.mcp_enabled).toBe(true);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(db.audit.at(-1)).toMatchObject({
      action: "instance.settings_updated",
      metadata: { mcp_enabled: true },
    });

    await user.click(toggle);
    expect(await screen.findByText("MCP disabled")).toBeInTheDocument();
    expect(db.deploy.instance.mcp_enabled).toBe(false);
  });

  it("explains a refused MCP toggle that needs a fresh sign-in", async () => {
    server.use(
      http.patch("*/v1/instance/settings", () =>
        apiError(403, "reauth_required", "Confirm your password to continue"),
      ),
    );
    const { user } = renderApp(PLATFORM);
    await user.click(await screen.findByRole("switch", { name: "Allow coding agents" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Confirm your password to continue Sign in again, then retry.",
    );
    expect(db.deploy.instance.mcp_enabled).toBe(false);
  });

  it("lets owners choose how long logs are kept, and says where changes are recorded", async () => {
    const { user } = renderApp(PLATFORM);
    const form = await screen.findByRole("form", { name: "Logs" });
    expect(screen.getByText(/recorded in the instance audit log/)).toBeInTheDocument();
    const days = within(form).getByLabelText("Keep logs for (days)");
    expect(days).toHaveValue(7);
    const save = within(form).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.clear(days);
    await user.type(days, "400");
    await user.click(save);
    expect(within(form).getByText(/from 1 to 365/)).toBeInTheDocument();
    await user.clear(days);
    await user.type(days, "30");
    await user.click(save);
    expect(await screen.findByText("Log retention saved")).toBeInTheDocument();
    expect(db.deploy.instance.log_retention_days).toBe(30);
    expect(db.audit.at(-1)).toMatchObject({
      action: "instance.settings_updated",
      metadata: { log_retention_days: 30 },
    });
  });

  it("schedules, cancels and completes a signing key rollover", async () => {
    const { user } = renderApp(PLATFORM);
    const section = (await screen.findByRole("heading", { name: "Signing keys" })).closest(
      "section",
    ) as HTMLElement;
    expect(await within(section).findByText(SIGNING_KID)).toBeInTheDocument();
    expect(within(section).getByText("No rollover scheduled.")).toBeInTheDocument();

    await user.selectOptions(within(section).getByLabelText("Switch after"), "72");
    await user.click(within(section).getByRole("button", { name: "Schedule rollover" }));
    expect(await screen.findByText("Signing key rollover scheduled")).toBeInTheDocument();
    const next = db.signingKeys.next;
    expect(next).not.toBeNull();
    expect((next?.not_before ?? 0) - (next?.scheduled_at ?? 0)).toBe(72 * 3_600_000);
    expect(await within(section).findByText(next?.kid ?? "")).toBeInTheDocument();
    expect(within(section).getByText("Rollover scheduled")).toBeInTheDocument();
    // The pending server hasn't connected, so it is listed as not ready.
    expect(within(section).getByRole("list", { name: "Servers not ready" })).toHaveTextContent(
      "Not connected yet",
    );

    await user.click(within(section).getByRole("button", { name: "Cancel rollover" }));
    expect(await screen.findByText("Signing key rollover cancelled")).toBeInTheDocument();
    expect(db.signingKeys.next).toBeNull();

    await user.click(await within(section).findByRole("button", { name: "Schedule rollover" }));
    await screen.findByText("Rollover scheduled");
    const due = db.signingKeys.next;
    if (due) due.not_before = Date.now() - 1;
    await user.click(within(section).getByRole("button", { name: "Cancel rollover" }));
    expect(await within(section).findByRole("alert")).toHaveTextContent(/already in use/);
  });

  it("completes a due rollover only once the admin accepts the servers left behind", async () => {
    db.signingKeys.next = {
      kid: "knext",
      public_key: "3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hbeGdNrfx+FG+IK08=",
      not_before: Date.now() - 1000,
      scheduled_at: Date.now() - 86_400_000,
    };
    const { user } = renderApp(PLATFORM);
    const complete = await screen.findByRole("button", { name: "Complete rollover" });
    expect(screen.getByText("Rollover due")).toBeInTheDocument();
    expect(complete).toBeDisabled();
    await user.click(screen.getByLabelText("Complete anyway"));
    await user.click(complete);
    expect(await screen.findByText("Signing key rollover completed")).toBeInTheDocument();
    expect(db.signingKeys).toMatchObject({
      current: { kid: "knext" },
      next: null,
      retired: { kid: SIGNING_KID },
    });
    expect(await screen.findByText(/Servers still pinned to it must re-join/)).toBeInTheDocument();
  });

  it("explains a refused rollover that needs a fresh sign-in", async () => {
    server.use(
      http.post("*/v1/instance/signing-keys/rotate", () =>
        apiError(403, "reauth_required", "Confirm your password to continue"),
      ),
    );
    const { user } = renderApp(PLATFORM);
    await user.click(await screen.findByRole("button", { name: "Schedule rollover" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Confirm your password to continue Sign in again, then retry.",
    );
    expect(db.signingKeys.next).toBeNull();
  });

  it("shows the GitHub App and its installations, and installs through a claim", async () => {
    const assign = vi.spyOn(external, "assign").mockImplementation(() => {});
    db.deploy.github.installations.push({
      ...db.deploy.github.installations[0]!,
      id: "ghi_legacy",
      account_login: "legacy-org",
      verified: false,
    });
    const { user } = renderApp(PLATFORM);
    const installations = await screen.findByRole("list", { name: "Installations" });
    expect(installations).toHaveTextContent("acme");
    const items = within(installations).getAllByRole("listitem");
    expect(within(items[0]!).queryByText("Unverified")).not.toBeInTheDocument();
    expect(within(items[1]!).getByText("Unverified")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Install on GitHub" }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    const url = new URL(assign.mock.calls[0]![0]);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${db.deploy.github.app?.html_url}/installations/new`,
    );
    const state = url.searchParams.get("state");
    expect(db.deploy.github.states.map((row) => row.state)).toContain(state);
  });

  it("creates the GitHub App through the manifest flow", async () => {
    db.deploy.github.app = null;
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
    const { user } = renderApp(PLATFORM);
    const form = await screen.findByRole("form", { name: "Create GitHub App" });
    await user.type(within(form).getByLabelText("Organization (optional)"), "-bad");
    await user.click(within(form).getByRole("button", { name: "Create GitHub App" }));
    expect(within(form).getByText(/organization login/)).toBeInTheDocument();
    await user.clear(within(form).getByLabelText("Organization (optional)"));
    await user.type(within(form).getByLabelText("Organization (optional)"), "acme");
    await user.click(within(form).getByRole("button", { name: "Create GitHub App" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const posted = submit.mock.contexts[0] as HTMLFormElement;
    expect(posted.action).toMatch(
      /^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=ghs_/,
    );
    const manifest = JSON.parse(
      (posted.querySelector("input[name=manifest]") as HTMLInputElement).value,
    );
    expect(manifest).toMatchObject({ default_events: ["push"], public: false });
    expect(db.deploy.github.states).toHaveLength(1);
  });

  it("shows owners-only copy to admins, who can still install the App", async () => {
    signInAs(USERS.admin.id);
    renderApp(PLATFORM);
    expect(
      await screen.findByRole("heading", { name: "Instance settings are for owners" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Install on GitHub" })).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Logs" })).not.toBeInTheDocument();
  });

  it("is a settings tab for owners and admins only", async () => {
    renderApp(`/w/${WORKSPACE_ID}/settings`);
    const tabs = await screen.findByRole("navigation", { name: "Settings" });
    expect(within(tabs).getByRole("link", { name: "Platform" })).toBeInTheDocument();
  });

  it("hides the tab from members", async () => {
    signInAs(USERS.member.id);
    renderApp(`/w/${WORKSPACE_ID}/settings`);
    const tabs = await screen.findByRole("navigation", { name: "Settings" });
    expect(within(tabs).queryByRole("link", { name: "Platform" })).not.toBeInTheDocument();
  });
});

describe("GitHub setup landing page", () => {
  it.each([
    ["status=installed", "GitHub App installed"],
    ["status=requested", "Installation requested"],
    ["error=exchange_failed", "GitHub App wasn't created"],
    ["error=installation_not_found", "Installation not found"],
    ["error=installation_claimed", "Already used by another workspace"],
    ["error=authorization_required", "GitHub didn't confirm who you are"],
    ["error=authorization_failed", "Couldn't check your GitHub access"],
    ["error=installation_not_accessible", "That installation isn't yours to add"],
    ["error=link_used", "This install link was already used"],
    ["error=link_expired", "This install link expired"],
    ["error=not_account_admin", "You don't administer that GitHub account"],
    ["", "GitHub setup didn't finish"],
  ])("explains ?%s", async (query, title) => {
    renderApp(`/settings/github?${query}`);
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Platform settings" })).toHaveAttribute(
      "href",
      PLATFORM,
    );
  });
});
