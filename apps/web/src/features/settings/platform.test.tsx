import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { findPageHeading, renderApp } from "../../test/render";
import { githubPostUrl, submitGithubManifest } from "./github-manifest";

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
    await findPageHeading("Settings");
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
    expect(db.deploy.instance).toEqual({ apps_domain: "127.0.0.1.nip.io", tls_mode: "internal" });
  });

  it("shows the GitHub App, its installations and the install link", async () => {
    renderApp(PLATFORM);
    const installations = await screen.findByRole("list", { name: "Installations" });
    expect(installations).toHaveTextContent("acme");
    expect(screen.getByRole("link", { name: "Install on GitHub" })).toHaveAttribute(
      "href",
      db.deploy.github.app?.install_url,
    );
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
      await screen.findByRole("heading", { name: "Ingress settings are for owners" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Install on GitHub" })).toBeInTheDocument();
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
