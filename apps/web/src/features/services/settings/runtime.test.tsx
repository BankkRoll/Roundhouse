import { instanceTypeFor, type PlacementConfig } from "@roundhouse/shared";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { cloudflareMock, connectCloudflareMock } from "../../../mocks/cloudflare-handlers";
import { db, signInAs, USERS } from "../../../mocks/db";
import { SEED, servicePath } from "../../../test/phase1";
import { renderApp } from "../../../test/render";
import { eligibilityFailures } from "./runtime-section";

const SETTINGS = servicePath(SEED.web, "settings");

function latest(serviceId: string) {
  return db.deploy.configs
    .filter((c) => c.service_id === serviceId && c.environment_id === SEED.production)
    .sort((a, b) => b.version - a.version)[0]!;
}

async function openRuntime() {
  const app = renderApp(SETTINGS);
  const form = await screen.findByRole("form", { name: "Runtime" });
  return { ...app, form };
}

describe("Service → Settings → Runtime", () => {
  it("runs on nodes by default, with no Cloudflare fields", async () => {
    const { form } = await openRuntime();
    expect(within(form).getByRole("radio", { name: "Nodes" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(within(form).queryByLabelText("Max instances")).not.toBeInTheDocument();
  });

  it("links instance admins to Settings → Cloudflare when it isn't set up", async () => {
    const { user, form } = await openRuntime();
    await user.click(within(form).getByRole("radio", { name: "Cloudflare" }));
    expect(
      await within(form).findByRole("link", {
        name: "Connect an account in Settings → Cloudflare",
      }),
    ).toHaveAttribute("href", "/w/ws_acme/cloudflare");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await within(form.parentElement!).findByRole("alert")).toHaveTextContent(
      "Cloudflare isn't set up on this instance.",
    );
    expect(latest(SEED.web).version).toBe(3);
  });

  it("asks everyone else to find an instance admin", async () => {
    signInAs(USERS.admin.id);
    const { user, form } = await openRuntime();
    await user.click(within(form).getByRole("radio", { name: "Cloudflare" }));
    expect(
      await within(form).findByText(/Ask an instance admin to connect a Cloudflare account/),
    ).toBeInTheDocument();
  });

  it("shows the eligibility checklist, with the API's failures", async () => {
    connectCloudflareMock();
    cloudflareMock.serverFailures[SEED.web] = [
      {
        rule: "domains",
        message: "Custom domains must use Cloudflare for SaaS mode: shop.example.com",
      },
    ];
    cloudflareMock.warnings[SEED.web] = [
      "API_URL points at a private service Cloudflare can't reach",
    ];
    const { user, form } = await openRuntime();
    await user.click(within(form).getByRole("radio", { name: "Cloudflare" }));
    expect(
      await within(form).findByRole("list", { name: "Cloudflare warnings" }),
    ).toHaveTextContent("API_URL points at a private service");
    const list = within(form).getByRole("list", { name: "Cloudflare eligibility" });
    await within(list).findByText(/shop\.example\.com/);
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(7);
    expect(
      within(list).getByText("Custom domains use Cloudflare for SaaS").parentElement,
    ).toHaveTextContent(": fails");
    expect(within(list).getByText("Listens on an HTTP port").parentElement).toHaveTextContent(
      ": passes",
    );
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Fix the failing checks/)).toBeInTheDocument();
    expect(latest(SEED.web).version).toBe(3);
  });

  it("checks the chosen instance type against the resources as it changes", async () => {
    connectCloudflareMock();
    const { user, form } = await openRuntime();
    await user.click(within(form).getByRole("radio", { name: "Cloudflare" }));
    const type = within(form).getByLabelText("Instance type");
    expect(type).toHaveValue(instanceTypeFor(latest(SEED.web).resources));
    await user.selectOptions(type, "lite");
    expect(await within(form).findByText(/lite has 62 millicores/)).toBeInTheDocument();
  });

  it("validates max instances and sleep after", async () => {
    connectCloudflareMock();
    const { user, form } = await openRuntime();
    await user.click(within(form).getByRole("radio", { name: "Cloudflare" }));
    const max = within(form).getByLabelText("Max instances");
    await user.clear(max);
    await user.type(max, "101");
    expect(within(form).getByText("Enter a whole number from 1 to 100.")).toBeInTheDocument();
    const sleep = within(form).getByLabelText("Sleep after");
    expect(sleep).toHaveValue("10m");
    await user.clear(sleep);
    await user.type(sleep, "2d");
    expect(within(form).getByText(/from 1m to 24h/)).toBeInTheDocument();
    expect(within(form).getByText(/billed per 10 ms of active time/i)).toBeInTheDocument();
  });

  it("stages provider and Cloudflare settings as one placement change", async () => {
    connectCloudflareMock();
    const { user, form } = await openRuntime();
    await user.click(within(form).getByRole("radio", { name: "Cloudflare" }));
    await within(within(form).getByRole("list", { name: "Cloudflare eligibility" })).findAllByText(
      /./,
    );
    const max = within(form).getByLabelText("Max instances");
    await user.clear(max);
    await user.type(max, "3");
    const sleep = within(form).getByLabelText("Sleep after");
    await user.clear(sleep);
    await user.type(sleep, "5m");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved as version 4")).toBeInTheDocument();
    expect(latest(SEED.web).placement as PlacementConfig).toEqual({
      node_selector: {},
      provider: "cloudflare",
      cloudflare: {
        instance_type: instanceTypeFor(latest(SEED.web).resources),
        max_instances: 3,
        sleep_after: "5m",
      },
    });
  });

  it("switches back to nodes, keeping the Cloudflare settings for a quick return", async () => {
    connectCloudflareMock();
    const config = latest(SEED.web);
    config.placement = {
      node_selector: {},
      provider: "cloudflare",
      cloudflare: { instance_type: "standard-2", max_instances: 4, sleep_after: "15m" },
    } as PlacementConfig;
    const { user, form } = await openRuntime();
    await user.click(within(form).getByRole("radio", { name: "Nodes" }));
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(latest(SEED.web).version).toBe(4));
    expect(latest(SEED.web).placement as PlacementConfig).toMatchObject({
      provider: "nodes",
      cloudflare: { max_instances: 4 },
    });
  });

  it("shows the runtime while the service runs on Cloudflare", async () => {
    connectCloudflareMock();
    latest(SEED.web).placement = {
      node_selector: {},
      provider: "cloudflare",
      cloudflare: { instance_type: "standard-2", max_instances: 4, sleep_after: "15m" },
    } as PlacementConfig;
    cloudflareMock.runtimes[SEED.web] = {
      script_name: "rh-abcdefghijklmnopqrst",
      status: "active",
      generation: 2,
      application_id: "app_1",
      routes: ["web-prod-x1.apps.example.com/*"],
      workers_dev_url: null,
      instances: { total: 4, running: 1 },
      delete_after: null,
    };
    cloudflareMock.deployments[SEED.web] = [
      {
        id: "cfd_1",
        deployment_id: SEED.webActive,
        status: "failed",
        image_ref: "registry.cloudflare.com/acme/rh-web:dep_web_4",
        image_digest: null,
        instance_type: "standard-2",
        max_instances: 4,
        error: "Cloudflare API error 10021: container application limit reached",
        created_at: Date.now(),
      },
    ];
    const { form } = await openRuntime();
    expect(await within(form).findByText("rh-abcdefghijklmnopqrst")).toBeInTheDocument();
    expect(within(form).getByText("1 running of 4")).toBeInTheDocument();
    expect(within(form).getByText("web-prod-x1.apps.example.com/*")).toBeInTheDocument();
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "Cloudflare API error 10021: container application limit reached",
    );
  });

  it("isn't offered to cron or database services", async () => {
    const cron = db.deploy.services.find((service) => service.kind === "cron");
    if (cron) {
      renderApp(servicePath(cron.id, "settings"));
      await screen.findByText(/config v\d+/);
      expect(screen.queryByRole("form", { name: "Runtime" })).not.toBeInTheDocument();
    }
  });
});

describe("eligibilityFailures", () => {
  it("checks kind, port and resources here and takes the rest from the API", () => {
    const failures = eligibilityFailures(
      { kind: "app" },
      {
        networking: { port: null, generated_domain: false },
        resources: { cpu_millis: 500, memory_mb: 256 },
      },
      "lite",
      [
        { rule: "port", message: "stale" },
        { rule: "volume", message: "Services with a volume must run on nodes" },
      ],
    );
    expect(failures.map((failure) => failure.rule)).toEqual(["port", "resources", "volume"]);
    expect(failures[0]!.message).toBe("Set the port the app listens on");
  });
});
