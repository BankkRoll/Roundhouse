// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are variable references (`${{input.KEY}}`), not template literals.
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { db, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { SEED } from "../../mocks/deploy-db";
import { server } from "../../mocks/server";
import { TEMPLATE_FIXTURES } from "../../mocks/templates-db";
import { expectPath, findPageHeading, renderApp } from "../../test/render";

const BASE = `/w/${WORKSPACE_ID}`;

async function findList() {
  return screen.findByRole("list", { name: "Templates" });
}

function rowOf(list: HTMLElement, name: string) {
  const row = within(list)
    .getAllByRole("listitem")
    .find((item) => within(item).queryByRole("heading")?.textContent?.startsWith(name));
  if (!row) throw new Error(`No row for ${name}`);
  return row;
}

describe("template gallery", () => {
  it("lists templates and filters them by search and category", async () => {
    const { user } = renderApp(`${BASE}/templates`);
    expect(await findPageHeading("Templates")).toBeInTheDocument();
    const list = await findList();
    expect(within(list).getByRole("link", { name: "FastAPI" })).toHaveAttribute(
      "href",
      `${BASE}/templates/fastapi`,
    );
    const nginx = rowOf(list, "nginx");
    expect(nginx).toHaveTextContent("Static sites");
    expect(nginx).toHaveTextContent("1 service");
    expect(await within(nginx).findByText("nginx:stable-alpine")).toBeInTheDocument();
    expect(await within(rowOf(list, "Webhook relay")).findByText(/2 services/)).toBeVisible();

    const search = screen.getByRole("searchbox", { name: "Search templates" });
    await user.type(search, "python");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByRole("link", { name: "FastAPI" })).toBeInTheDocument();

    await user.clear(search);
    const categories = screen.getByRole("group", { name: "Category" });
    expect(
      within(categories)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      "All",
      "Starters",
      "Static sites",
      "Tools",
      "Monitoring",
      "Automation",
      "Databases",
    ]);
    await user.click(within(categories).getByRole("button", { name: "Monitoring" }));
    expect(within(categories).getByRole("button", { name: "Monitoring" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([expect.stringContaining("Uptime Kuma")]);

    await user.type(search, "zzz");
    expect(screen.getByRole("heading", { name: 'No templates match "zzz"' })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(search).toHaveValue("");
    expect(within(await findList()).getAllByRole("listitem").length).toBeGreaterThan(10);
  });

  it("shows unsupported templates disabled with what they need", async () => {
    renderApp(`${BASE}/templates`);
    const list = await findList();
    const postgres = rowOf(list, "App + Postgres");
    expect(postgres).toHaveAttribute("aria-disabled", "true");
    expect(postgres).toHaveTextContent("Needs databases");
    expect(within(postgres).queryByRole("link")).not.toBeInTheDocument();
    expect(rowOf(list, "File browser")).toHaveTextContent("Needs volumes");
    expect(rowOf(list, "n8n")).not.toHaveAttribute("aria-disabled");
  });

  it("opens the gallery from the new project dialog", async () => {
    const { router, user } = renderApp(BASE);
    await user.click(await screen.findByRole("button", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    await user.click(within(dialog).getByRole("button", { name: "Start from a template" }));
    await expectPath(router, `${BASE}/templates`);
    expect(await findPageHeading("Templates")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("template detail", () => {
  it("shows services, ports and variables without ever rendering secret values", async () => {
    renderApp(`${BASE}/templates/${TEMPLATE_FIXTURES.relay}`);
    expect(await findPageHeading("Webhook relay")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Docs/ })).toHaveAttribute(
      "href",
      "https://example.com/webhook-relay",
    );
    const services = screen.getByRole("region", { name: "Services" });
    expect(services).toHaveTextContent("relay --listen :8080");
    expect(services).toHaveTextContent("Port 8080 · public domain");
    expect(services).toHaveTextContent("No listener");
    expect(within(services).getAllByText("ghcr.io/example/webhook-relay:1")).toHaveLength(2);

    const relayVars = screen.getByRole("list", { name: "Variables of Relay" });
    const row = (key: string) =>
      within(relayVars)
        .getAllByRole("listitem")
        .find((item) => item.textContent?.startsWith(key));
    expect(row("RELAY_TOKEN")).toHaveTextContent("generated on deploy");
    expect(row("SIGNING_SECRET")).toHaveTextContent("write-only");
    expect(row("TARGET_URL")).toHaveTextContent("${{input.TARGET_URL}}");
    expect(screen.getByRole("list", { name: "Shared variables" })).toHaveTextContent(
      "RELAY_REGIONeu",
    );
    expect(document.body.textContent).not.toContain("${{input.SIGNING_SECRET}}");

    const secret = screen.getByLabelText("Signing secret");
    expect(secret).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Log level")).toHaveValue("info");
    expect(screen.getByLabelText("Retries")).toHaveValue("3");
    expect(screen.getByRole("switch", { name: "Verbose logging" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Deploy after creating" })).toBeChecked();
  });

  it("explains a template the control plane can't deploy", async () => {
    renderApp(`${BASE}/templates/${TEMPLATE_FIXTURES.postgres}`);
    expect(await findPageHeading("App + Postgres")).toBeInTheDocument();
    expect(screen.getByText("Needs databases")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deploy template" })).not.toBeInTheDocument();
  });

  it("checks required inputs before sending anything", async () => {
    const { user } = renderApp(`${BASE}/templates/${TEMPLATE_FIXTURES.relay}`);
    const before = db.deploy.projects.length;
    await user.click(await screen.findByRole("button", { name: "Deploy template" }));
    expect(screen.getByLabelText("Target URL")).toHaveAccessibleDescription("Required");
    expect(screen.getByLabelText("Signing secret")).toHaveAttribute("aria-invalid", "true");
    expect(db.deploy.projects).toHaveLength(before);
  });

  it("requires the write-only confirmation, then creates the project and opens it", async () => {
    const { router, user } = renderApp(`${BASE}/templates/${TEMPLATE_FIXTURES.relay}`);
    await user.type(await screen.findByLabelText("Target URL"), "http://hooks.internal:9000");
    await user.type(screen.getByLabelText("Signing secret"), "s3cret-value");
    const confirm = screen.getByRole("checkbox", { name: /2 variables will be write-only/ });
    expect(confirm).toHaveAccessibleDescription("SIGNING_SECRET, RELAY_TOKEN");

    const before = db.deploy.projects.length;
    await user.click(screen.getByRole("button", { name: "Deploy template" }));
    expect(screen.getByText("Confirm to continue.")).toBeInTheDocument();
    expect(db.deploy.projects).toHaveLength(before);

    await user.click(confirm);
    await user.click(screen.getByRole("button", { name: "Deploy template" }));
    const project = await waitFor(() => {
      const created = db.deploy.projects.find((row) => row.name === "Webhook relay");
      if (!created) throw new Error("not created yet");
      return created;
    });
    await expectPath(router, `${BASE}/p/${project.id}`);
    expect(await screen.findByText("Created Webhook relay from Webhook relay")).toBeInTheDocument();
    expect(db.deploy.variables.find((row) => row.key === "SIGNING_SECRET")?.tier).toBe("secret");
    expect(db.deploy.deployments.filter((row) => row.project_id === project.id)).toHaveLength(2);
    expect(db.audit.map((row) => row.action)).toEqual(
      expect.arrayContaining(["project.created", "service.created", "template.deployed"]),
    );
  });

  it("deploys a template into a new project named by the deployer", async () => {
    const { router, user } = renderApp(`${BASE}/templates/whoami`);
    const name = await screen.findByLabelText("Project name");
    expect(name).toHaveValue("whoami");
    await user.clear(name);
    await user.type(name, "Echo");
    expect(name).toHaveAccessibleDescription("Slug: echo");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Deploy after creating" }));
    await user.click(screen.getByRole("button", { name: "Deploy template" }));
    expect(await screen.findByText("Created Echo from whoami")).toBeInTheDocument();
    const project = db.deploy.projects.find((row) => row.name === "Echo");
    await expectPath(router, `${BASE}/p/${project?.id}`);
    expect(db.deploy.services.filter((row) => row.project_id === project?.id)).toHaveLength(1);
    expect(db.deploy.deployments.some((row) => row.project_id === project?.id)).toBe(false);
  });

  it("deploys into an environment of an existing project", async () => {
    const { router, user } = renderApp(`${BASE}/templates/whoami`);
    await user.click(await screen.findByRole("radio", { name: "Existing project" }));
    expect(screen.queryByLabelText("Project name")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deploy template" }));
    expect(screen.getByText("Choose a project.")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Project"), SEED.project);
    const environment = screen.getByLabelText("Environment");
    await waitFor(() => expect(environment).toHaveValue(SEED.production));
    await user.click(screen.getByRole("button", { name: "Deploy template" }));
    expect(await screen.findByText("Added whoami to storefront")).toBeInTheDocument();
    await expectPath(router, `${BASE}/p/${SEED.project}`);
    expect(
      db.deploy.services.find((row) => row.project_id === SEED.project && row.slug === "whoami"),
    ).toBeDefined();
  });

  it("puts an input problem the API reports on that input", async () => {
    server.use(
      http.post("*/v1/workspaces/:workspaceId/projects/from-template", () =>
        HttpResponse.json(
          {
            error: {
              code: "invalid_request",
              message: "inputs.TARGET_URL: Must be an internal address",
              details: [
                {
                  field: "inputs.TARGET_URL",
                  code: "invalid",
                  message: "Must be an internal address",
                },
              ],
            },
          },
          { status: 400 },
        ),
      ),
    );
    const { user } = renderApp(`${BASE}/templates/${TEMPLATE_FIXTURES.relay}`);
    const target = await screen.findByLabelText("Target URL");
    await user.type(target, "https://example.com");
    await user.type(screen.getByLabelText("Signing secret"), "s3cret-value");
    await user.click(screen.getByRole("checkbox", { name: /write-only/ }));
    await user.click(screen.getByRole("button", { name: "Deploy template" }));
    await waitFor(() => expect(target).toHaveAccessibleDescription("Must be an internal address"));
    expect(target).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lets members add templates to existing projects only", async () => {
    signInAs(USERS.member.id);
    renderApp(`${BASE}/templates/whoami`);
    expect(await screen.findByLabelText("Project")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "New project" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Project name")).not.toBeInTheDocument();
  });

  it("lets viewers browse but not deploy", async () => {
    signInAs(USERS.viewer.id);
    renderApp(`${BASE}/templates/whoami`);
    expect(await findPageHeading("whoami")).toBeInTheDocument();
    expect(
      screen.getByText(/Your role can browse templates but not deploy them/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deploy template" })).not.toBeInTheDocument();
  });

  it("reports a template that doesn't exist", async () => {
    renderApp(`${BASE}/templates/nope`);
    expect(await screen.findByRole("heading", { name: "Template not found" })).toBeVisible();
  });
});
