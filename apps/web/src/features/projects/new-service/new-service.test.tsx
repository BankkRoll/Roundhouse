import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, signInAs, USERS, WORKSPACE_ID } from "../../../mocks/db";
import { PROJECT_PATH, SEED } from "../../../test/phase1";
import { findPageHeading, renderApp } from "../../../test/render";

async function openFlow() {
  const app = renderApp(PROJECT_PATH);
  await findPageHeading("storefront");
  await app.user.click(screen.getByRole("button", { name: "New service" }));
  const dialog = await screen.findByRole("dialog", { name: "New service" });
  return { ...app, dialog };
}

describe("new service flow", () => {
  it("creates a service from a Docker image and deploys it", async () => {
    const { user, dialog, router } = await openFlow();
    expect(within(dialog).getByRole("list", { name: "New service progress" })).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Docker image/ })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(within(dialog).getByText(/Enter an image/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Image"), "Redis:7");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(within(dialog).getByText("Repository names must be lowercase.")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Image"));
    await user.type(within(dialog).getByLabelText("Image"), "redis:7");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));

    expect(within(dialog).getByLabelText("Service name")).toHaveValue("redis");
    const port = within(dialog).getByLabelText("Port");
    await user.clear(port);
    await user.type(port, "6379");
    await user.click(within(dialog).getByRole("switch", { name: "Generated domain" }));
    expect(within(dialog).getByRole("switch", { name: "Deploy now" })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Create and deploy" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/\/s\/svc_mock\d+\/deployments$/),
    );
    const service = db.deploy.services.at(-1)!;
    expect(service).toMatchObject({ name: "redis", slug: "redis" });
    expect(db.deploy.configs.find((c) => c.service_id === service.id)).toMatchObject({
      source: { type: "image", image: "redis:7" },
      networking: { port: 6379, generated_domain: false },
    });
    expect(db.deploy.deployments.at(-1)).toMatchObject({
      service_id: service.id,
      status: "queued",
    });
    expect(await screen.findByText("Deploying redis")).toBeInTheDocument();
  });

  it("creates a service from a connected GitHub repository without deploying", async () => {
    const { user, dialog } = await openFlow();
    await user.click(within(dialog).getByRole("radio", { name: /GitHub repository/ }));
    expect(
      await within(dialog).findByRole("radio", { name: "Connected repositories" }),
    ).toHaveAttribute("aria-checked", "true");
    await user.type(within(dialog).getByLabelText("Search repositories"), "bill");
    const repos = within(dialog).getByRole("group", { name: "Repository" });
    expect(within(repos).getAllByRole("radio")).toHaveLength(1);
    await user.click(within(repos).getByRole("radio", { name: /acme\/billing/ }));
    expect(within(dialog).getByLabelText("Branch")).toHaveValue("trunk");
    await user.clear(within(dialog).getByLabelText("Root directory"));
    await user.type(within(dialog).getByLabelText("Root directory"), "services/billing");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));

    expect(within(dialog).getByLabelText("Service name")).toHaveValue("billing");
    await user.click(within(dialog).getByRole("switch", { name: "Deploy now" }));
    await user.click(within(dialog).getByRole("button", { name: "Create service" }));
    await waitFor(() => expect(db.deploy.services.at(-1)?.name).toBe("billing"));
    const service = db.deploy.services.at(-1)!;
    expect(db.deploy.configs.find((c) => c.service_id === service.id)?.source).toEqual({
      type: "git",
      repo_url: "https://github.com/acme/billing.git",
      branch: "trunk",
      root_dir: "services/billing",
      github_installation_id: SEED.installation,
    });
    expect(db.deploy.deployments.some((d) => d.service_id === service.id)).toBe(false);
    expect(await screen.findByText("Created billing")).toBeInTheDocument();
  });

  it("builds a public repository by URL when no GitHub App exists", async () => {
    db.deploy.github.app = null;
    const { user, dialog } = await openFlow();
    await user.click(within(dialog).getByRole("radio", { name: /GitHub repository/ }));
    expect(await within(dialog).findByText(/only public repositories/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Repository URL"), "git@github.com:a/b.git");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(within(dialog).getByText(/Use an https:\/\/ URL/)).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Repository URL"));
    await user.type(
      within(dialog).getByLabelText("Repository URL"),
      "https://github.com/acme/docs.git",
    );
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await user.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(within(dialog).getByLabelText("Repository URL")).toHaveValue(
      "https://github.com/acme/docs.git",
    );
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await user.click(within(dialog).getByRole("button", { name: "Create and deploy" }));
    await waitFor(() => expect(db.deploy.services.at(-1)?.name).toBe("docs"));
    expect(db.deploy.builds.at(-1)).toMatchObject({ status: "queued" });
  });

  it("creates a service whose name is taken, with a suffixed slug", async () => {
    const { user, dialog } = await openFlow();
    await user.type(within(dialog).getByLabelText("Image"), "ghcr.io/acme/web:1");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(within(dialog).getByLabelText("Service name")).toHaveValue("web");
    await user.click(within(dialog).getByRole("button", { name: "Create and deploy" }));
    await waitFor(() => expect(db.deploy.services.at(-1)).toMatchObject({ slug: "web-2" }));
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("accepts the reserved name shared, which the API suffixes", async () => {
    const { user, dialog } = await openFlow();
    await user.type(within(dialog).getByLabelText("Image"), "nginx:1.27");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    const name = within(dialog).getByLabelText("Service name");
    await user.clear(name);
    await user.type(name, "shared");
    await user.click(within(dialog).getByRole("button", { name: "Create and deploy" }));
    await waitFor(() =>
      expect(db.deploy.services.at(-1)).toMatchObject({ name: "shared", slug: "shared-2" }),
    );
  });

  it("deploys the first service of a project created moments ago", async () => {
    const { user, router } = renderApp(`/w/${WORKSPACE_ID}`);
    await findPageHeading("Home");
    await user.click(screen.getByRole("button", { name: "New project" }));
    const create = await screen.findByRole("dialog", { name: "New project" });
    await user.type(within(create).getByLabelText("Project name"), "lake");
    await user.click(within(create).getByRole("button", { name: "Create project" }));
    await screen.findByRole("heading", { name: "No services yet" });
    await user.click(screen.getAllByRole("button", { name: "New service" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "New service" });
    await user.type(within(dialog).getByLabelText("Image"), "nginx:1.27-alpine");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await user.click(within(dialog).getByRole("button", { name: "Create and deploy" }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/deployments$/));
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByText(/Missing queryFn/)).not.toBeInTheDocument();
  });

  it("creates a cron job with a previewed schedule, zone and timeout", async () => {
    const { user, dialog, router } = await openFlow();
    await user.click(within(dialog).getByRole("radio", { name: /Cron job/ }));
    expect(within(dialog).getByRole("radio", { name: "Docker image" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.type(within(dialog).getByLabelText("Image"), "ghcr.io/acme/cleanup:2");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));

    expect(within(dialog).getByText("cron · image · ghcr.io/acme/cleanup:2")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Port")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("switch", { name: "Generated domain" }),
    ).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("switch", { name: "Deploy now" }));
    await user.click(within(dialog).getByRole("button", { name: "Create service" }));
    expect(within(dialog).getByText("Enter a schedule.")).toBeInTheDocument();
    expect(db.deploy.services.some((row) => row.name === "cleanup")).toBe(false);

    const schedule = within(dialog).getByLabelText("Schedule");
    await user.type(schedule, "0 3 * *");
    expect(within(dialog).getByText("Expected 5 fields, got 4.")).toBeInTheDocument();
    await user.type(schedule, " *");
    await user.selectOptions(within(dialog).getByLabelText("Time zone"), "Europe/Berlin");
    expect(document.getElementById(schedule.getAttribute("aria-describedby")!)).toHaveTextContent(
      /^At 03:00, every day \(Europe\/Berlin\) · next: /,
    );
    const timeout = within(dialog).getByLabelText("Timeout (seconds)");
    await user.clear(timeout);
    await user.type(timeout, "5");
    await user.click(within(dialog).getByRole("button", { name: "Create service" }));
    expect(within(dialog).getByText(/from 10 to 86400/)).toBeInTheDocument();
    await user.clear(timeout);
    await user.type(timeout, "600");
    await user.click(within(dialog).getByRole("button", { name: "Create service" }));

    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/s\/svc_mock\d+\/runs$/));
    const service = db.deploy.services.at(-1)!;
    expect(service).toMatchObject({ name: "cleanup", kind: "cron" });
    expect(db.deploy.configs.find((c) => c.service_id === service.id)).toMatchObject({
      source: { type: "image", image: "ghcr.io/acme/cleanup:2" },
      networking: { port: null, generated_domain: false },
      cron: {
        schedule: "0 3 * * *",
        timezone: "Europe/Berlin",
        timeout_s: 600,
        concurrency: "forbid",
      },
    });
  });

  it("is keyboard operable and closes with Escape", async () => {
    const { user, dialog } = await openFlow();
    expect(within(dialog).getByLabelText("Image")).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("is not offered to viewers", async () => {
    signInAs(USERS.viewer.id);
    renderApp(PROJECT_PATH);
    await findPageHeading("storefront");
    expect(screen.queryByRole("button", { name: "New service" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Deploy / })).not.toBeInTheDocument();
  });
});
