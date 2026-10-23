import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, signInAs, USERS } from "../../../mocks/db";
import { SEED, servicePath } from "../../../test/phase1";
import { expectPath, renderApp } from "../../../test/render";

const SETTINGS = servicePath(SEED.web, "settings");

function latest(serviceId: string) {
  return db.deploy.configs
    .filter((c) => c.service_id === serviceId)
    .sort((a, b) => b.version - a.version)[0]!;
}

async function openSettings(path = SETTINGS) {
  const app = renderApp(path);
  await screen.findByText(/config v\d+/);
  const section = (name: string) => screen.getByRole("form", { name });
  return { ...app, section };
}

describe("service settings", () => {
  it("saves one part as a new version, keeping the others", async () => {
    const { user, section } = await openSettings();
    const deploy = section("Deploy");
    const replicas = within(deploy).getByLabelText("Replicas");
    expect(within(deploy).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(replicas);
    await user.type(replicas, "4");
    expect(within(deploy).getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(within(deploy).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved as version 4")).toBeInTheDocument();
    expect(latest(SEED.web)).toMatchObject({
      version: 4,
      deploy: { replicas: 4, drain_s: 10 },
      healthcheck: { type: "http", path: "/healthz" },
    });
    await waitFor(() => expect(screen.getByText(/config v4/)).toBeInTheDocument());
    expect(screen.getByText(/v4 isn't deployed yet \(running v3\)/)).toBeInTheDocument();
    expect(within(deploy).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("validates fields before saving", async () => {
    const { user, section } = await openSettings();
    const deploy = section("Deploy");
    await user.clear(within(deploy).getByLabelText("Replicas"));
    await user.type(within(deploy).getByLabelText("Replicas"), "50");
    expect(within(deploy).getByText("Enter a whole number from 0 to 20.")).toBeInTheDocument();
    await user.click(within(deploy).getByRole("button", { name: "Save" }));
    expect(latest(SEED.web).version).toBe(3);
  });

  it("sets resources with sliders and keyboard", async () => {
    const { user, section } = await openSettings();
    const resources = section("Resources");
    const cpu = within(resources).getByRole("slider", { name: "CPU" });
    expect(cpu).toHaveAttribute("aria-valuetext", "1 vCPU");
    cpu.focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(cpu).toHaveAttribute("aria-valuetext", "1.2 vCPU");
    const memory = within(resources).getByLabelText("Memory in MB");
    await user.clear(memory);
    await user.type(memory, "1024");
    expect(within(resources).getByRole("slider", { name: "Memory" })).toHaveAttribute(
      "aria-valuetext",
      "1 GB",
    );
    await user.click(within(resources).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(latest(SEED.web).resources).toEqual({ cpu_millis: 1200, memory_mb: 1024 }),
    );
  });

  it("switches the build to a Dockerfile with build args", async () => {
    const { user, section } = await openSettings();
    const build = section("Build");
    await user.selectOptions(within(build).getByLabelText("Builder"), "dockerfile");
    await user.type(within(build).getByLabelText("Dockerfile path"), "docker/Dockerfile.web");
    await user.click(within(build).getByRole("button", { name: "Add" }));
    await user.type(within(build).getByLabelText("Build arguments 1 key"), "NODE_VERSION");
    await user.type(within(build).getByLabelText("Build arguments 1 value"), "22");
    await user.click(within(build).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(latest(SEED.web).build).toEqual({
        builder: "dockerfile",
        dockerfile_path: "docker/Dockerfile.web",
        build_args: { NODE_VERSION: "22" },
      }),
    );
  });

  it("removes the health probe and edits networking and placement", async () => {
    const { user, section } = await openSettings();
    const health = section("Healthcheck");
    await user.selectOptions(within(health).getByLabelText("Probe"), "none");
    await user.click(within(health).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(latest(SEED.web).healthcheck).toBeNull());

    const networking = section("Networking");
    await user.click(within(networking).getByRole("switch", { name: "Generated domain" }));
    await user.click(within(networking).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(latest(SEED.web).networking).toEqual({ port: 3000, generated_domain: false }),
    );

    const placement = section("Placement");
    await user.click(within(placement).getByRole("button", { name: "Add" }));
    await user.type(within(placement).getByLabelText("Node selector 1 key"), "region");
    await user.type(within(placement).getByLabelText("Node selector 1 value"), "hel1");
    await user.click(within(placement).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(latest(SEED.web).placement).toEqual({ node_selector: { region: "hel1" } }),
    );
    expect(latest(SEED.web).version).toBe(6);
  });

  it("changes the source to an image", async () => {
    const { user, section } = await openSettings();
    const source = section("Source");
    await user.selectOptions(within(source).getByLabelText("Type"), "image");
    await user.click(within(source).getByRole("button", { name: "Save" }));
    expect(within(source).getByText(/Enter an image/)).toBeInTheDocument();
    await user.type(within(source).getByLabelText("Image"), "ghcr.io/acme/web:2");
    await user.click(within(source).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(latest(SEED.web).source).toEqual({ type: "image", image: "ghcr.io/acme/web:2" }),
    );
  });

  it("reports a concurrent edit and reloads the latest version", async () => {
    const { user, section } = await openSettings();
    const current = latest(SEED.web);
    db.deploy.configs.push({ ...current, id: "cfg_other", version: current.version + 1 });
    const deploy = section("Deploy");
    await user.clear(within(deploy).getByLabelText("Replicas"));
    await user.type(within(deploy).getByLabelText("Replicas"), "3");
    await user.click(within(deploy).getByRole("button", { name: "Save" }));
    expect(await within(deploy).findByRole("alert")).toHaveTextContent(
      "Someone else changed this config",
    );
    await waitFor(() => expect(screen.getByText(/config v4/)).toBeInTheDocument());
  });

  it("deletes the service after typing its name", async () => {
    const { user, router } = await openSettings();
    await user.click(screen.getByRole("button", { name: "Delete service" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete web?" });
    await user.type(within(dialog).getByLabelText(/to confirm/), "web");
    await user.click(within(dialog).getByRole("button", { name: "Delete service" }));
    await expectPath(router, `/w/ws_acme/p/${SEED.project}`);
    expect(db.deploy.services.find((s) => s.id === SEED.web)?.deleted).toBe(true);
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Services" })).queryByRole("link", { name: "web" }),
      ).toBeNull(),
    );
  });

  it("is read-only for viewers", async () => {
    signInAs(USERS.viewer.id);
    await openSettings();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Replicas")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Delete service" })).not.toBeInTheDocument();
  });
});

describe("domains tab", () => {
  it("shows the generated domain with copy and open, and custom domains as Phase 3", async () => {
    const { user } = renderApp(servicePath(SEED.web, "domains"));
    const list = await screen.findByRole("list", { name: "Domain list" });
    expect(
      within(list).getByRole("link", {
        name: /^web-production-x7k2\.apps\.example\.com\s*\(opens/,
      }),
    ).toHaveAttribute("href", "https://web-production-x7k2.apps.example.com");
    expect(list).toHaveTextContent("TLS issued");
    await user.click(within(list).getByRole("button", { name: /Copy/ }));
    expect(await navigator.clipboard.readText()).toBe(
      "https://web-production-x7k2.apps.example.com",
    );
    const custom = screen.getByRole("button", { name: "Add custom domain" });
    expect(custom).toHaveAttribute("aria-disabled", "true");
    expect(custom).toHaveAccessibleDescription(/arrive in Phase 3/);
  });

  it("explains how to get a domain when there is none", async () => {
    renderApp(servicePath(SEED.worker, "domains"));
    expect(await screen.findByRole("heading", { name: "No domains" })).toBeInTheDocument();
    expect(screen.getByText(/has no port/)).toBeInTheDocument();
  });
});
