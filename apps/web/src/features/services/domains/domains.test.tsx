import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, signInAs, USERS } from "../../../mocks/db";
import { SEED, servicePath } from "../../../test/phase1";
import { renderApp } from "../../../test/render";

async function openDomains(serviceId: string = SEED.web) {
  const app = renderApp(servicePath(serviceId, "domains"));
  const list = await screen.findByRole("list", { name: "Domain list" });
  return { ...app, list };
}

describe("domains", () => {
  it("shows the generated domain with copy and open", async () => {
    const { user, list } = await openDomains();
    const row = within(list).getByRole("listitem", {
      name: "web-production-x7k2.apps.example.com",
    });
    expect(
      within(row).getByRole("link", { name: /^web-production-x7k2\.apps\.example\.com\s*\(opens/ }),
    ).toHaveAttribute("href", "https://web-production-x7k2.apps.example.com");
    expect(row).toHaveTextContent("Generated · TLS issued");
    expect(within(row).getByText("Active")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Copy URL" }));
    expect(await navigator.clipboard.readText()).toBe(
      "https://web-production-x7k2.apps.example.com",
    );
  });

  it("adds a custom domain, shows the records to create, and checks it through to active", async () => {
    const { user } = await openDomains();
    await user.click(screen.getByRole("button", { name: "Add domain" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a custom domain" });
    await user.type(within(dialog).getByLabelText("Hostname"), "Shop.Example.com");
    await user.click(within(dialog).getByRole("button", { name: "Add domain" }));

    const records = await screen.findByRole("dialog", { name: "Create these DNS records" });
    const table = within(records).getByRole("table", { name: "DNS records" });
    expect(table).toHaveTextContent("CNAME");
    expect(table).toHaveTextContent("web-production-x7k2.apps.example.com");
    expect(table).toHaveTextContent("_roundhouse.shop.example.com");
    const stored = db.deploy.domains.find((d) => d.hostname === "shop.example.com")!;
    const txt = stored.records.find((r) => r.type === "TXT")!.value;
    expect(txt).toMatch(/^rh-verify=[0-9a-f]{64}$/);
    await user.click(within(records).getByRole("button", { name: "Copy TXT value" }));
    expect(await navigator.clipboard.readText()).toBe(txt);
    expect(within(records).getByText("Waiting for DNS")).toBeInTheDocument();

    await user.click(within(records).getByRole("button", { name: "Check now" }));
    expect(await within(records).findByText("Waiting for TXT")).toBeInTheDocument();
    await user.click(within(records).getByRole("button", { name: "Check now" }));
    expect(await within(records).findByText("Active")).toBeInTheDocument();
    expect(within(records).queryByRole("button", { name: "Check now" })).not.toBeInTheDocument();
    await user.click(within(records).getByRole("button", { name: "Done" }));

    const list = screen.getByRole("list", { name: "Domain list" });
    const row = within(list).getByRole("listitem", { name: "shop.example.com" });
    expect(within(row).getByText("Active")).toBeInTheDocument();
    expect(within(row).queryByRole("table")).not.toBeInTheDocument();
    expect(db.audit.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["domain.added", "domain.verified"]),
    );
  });

  it("validates the hostname before sending it and shows the API's refusals", async () => {
    const { user } = await openDomains();
    await user.click(screen.getByRole("button", { name: "Add domain" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a custom domain" });
    const input = within(dialog).getByLabelText("Hostname");
    await user.type(input, "*.example.com");
    await user.click(within(dialog).getByRole("button", { name: "Add domain" }));
    expect(within(dialog).getByText(/Wildcard domains aren't supported yet/)).toBeInTheDocument();
    expect(db.deploy.domains.some((d) => d.hostname === "*.example.com")).toBe(false);

    await user.clear(input);
    await user.type(input, "x.apps.example.com");
    await user.click(within(dialog).getByRole("button", { name: "Add domain" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "That hostname belongs to this install.",
    );
  });

  it("lists pending domains with their records and error, and removes after confirming", async () => {
    const { user } = await openDomains();
    await user.click(screen.getByRole("button", { name: "Add domain" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a custom domain" });
    await user.type(within(dialog).getByLabelText("Hostname"), "pending.example.com");
    await user.click(within(dialog).getByRole("button", { name: "Add domain" }));
    await user.click(await screen.findByRole("button", { name: "Done" }));

    const row = within(screen.getByRole("list", { name: "Domain list" })).getByRole("listitem", {
      name: "pending.example.com",
    });
    expect(within(row).getByText("Waiting for DNS")).toBeInTheDocument();
    expect(within(row).getByText(/No CNAME or A\/AAAA record found/)).toBeInTheDocument();
    expect(within(row).getByRole("table", { name: "DNS records" })).toBeInTheDocument();

    await user.click(within(row).getByRole("button", { name: "Remove" }));
    const confirm = await screen.findByRole("dialog", { name: "Remove pending.example.com?" });
    await user.click(within(confirm).getByRole("button", { name: "Remove domain" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("listitem", { name: "pending.example.com" }),
      ).not.toBeInTheDocument(),
    );
    expect(db.deploy.domains.some((d) => d.hostname === "pending.example.com")).toBe(false);
  });

  it("is read-only for viewers", async () => {
    signInAs(USERS.viewer.id);
    await openDomains();
    expect(screen.queryByRole("button", { name: "Add domain" })).not.toBeInTheDocument();
  });

  it("explains that a service without a port can't have domains", async () => {
    renderApp(servicePath(SEED.worker, "domains"));
    expect(await screen.findByText(/has no port/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add domain" })).not.toBeInTheDocument();
  });

  it("is also a section of the service settings", async () => {
    renderApp(servicePath(SEED.web, "settings"));
    const section = await screen.findByRole("region", { name: "Domains" });
    expect(
      await within(section).findByRole("listitem", {
        name: "web-production-x7k2.apps.example.com",
      }),
    ).toBeInTheDocument();
  });
});
