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
    expect(row).toHaveTextContent(/Generated · Certificate expires in \d+ days/);
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
    expect(within(dialog).getByText(/delegating _acme-challenge/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Add domain" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/Wildcard domains need/);
    expect(db.deploy.domains.some((d) => d.hostname === "*.example.com")).toBe(false);

    await user.clear(input);
    await user.type(input, "x.apps.example.com");
    await user.click(within(dialog).getByRole("button", { name: "Add domain" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "That hostname belongs to this install.",
    );
  });

  it("adds a wildcard once managed TLS can issue it, with the delegation record", async () => {
    db.deploy.instance.tls_mode = "managed";
    db.deploy.tls.cloudflare_dns = {
      zone_id: "0123456789abcdef0123456789abcdef",
      zone_name: "example.com",
      api_token: "cf-token-0123456789abcdef",
      updated_at: Date.now(),
    };
    const { user } = await openDomains();
    await user.click(screen.getByRole("button", { name: "Add domain" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a custom domain" });
    await user.type(within(dialog).getByLabelText("Hostname"), "*.shop.test");
    await user.click(within(dialog).getByRole("button", { name: "Add domain" }));
    const records = await screen.findByRole("dialog", { name: "Create these DNS records" });
    expect(
      within(records).getByText(/_acme-challenge CNAME lets this install/),
    ).toBeInTheDocument();
    const table = within(records).getByRole("table", { name: "DNS records" });
    expect(table).toHaveTextContent("Certificate delegation");
    expect(table).toHaveTextContent("_acme-challenge.shop.test");
    expect(table).toHaveTextContent("_roundhouse.shop.test");
  });

  it("shows the certificate, the servers that answer, and changes HSTS with a typed preload confirmation", async () => {
    const { user } = await openDomains();
    await user.click(screen.getByRole("button", { name: "Add domain" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a custom domain" });
    await user.type(within(dialog).getByLabelText("Hostname"), "ready.example.com");
    await user.click(within(dialog).getByRole("button", { name: "Add domain" }));
    await user.click(await screen.findByRole("button", { name: "Done" }));

    const row = within(screen.getByRole("list", { name: "Domain list" })).getByRole("listitem", {
      name: "ready.example.com",
    });
    expect(row).toHaveTextContent(/Certificate expires in \d+ days/);
    await user.click(within(row).getByRole("button", { name: "Details" }));
    const details = within(row).getByRole("region", { name: "Details of ready.example.com" });
    expect(within(details).getByText("Let's Encrypt R11")).toBeInTheDocument();
    expect(within(details).getByText("Last updated")).toBeInTheDocument();
    expect(
      within(details).getByRole("list", { name: "Certificate on each server" }),
    ).toHaveTextContent("hel-1");
    expect(within(details).getByText(/the WireGuard mesh, not built yet/)).toBeInTheDocument();

    const hsts = within(details).getByRole("form", { name: "HSTS for ready.example.com" });
    await user.click(within(hsts).getByLabelText(/includeSubDomains/));
    await user.click(within(hsts).getByLabelText(/preload/));
    expect(within(hsts).getByRole("list", { name: "HSTS problems" })).toHaveTextContent(
      "Only a registered domain's apex",
    );
    await user.click(within(hsts).getByLabelText(/preload/));
    expect(within(hsts).getByRole("list", { name: "HSTS warnings" })).toHaveTextContent(
      "includeSubDomains makes browsers refuse",
    );
    await user.click(within(hsts).getByRole("button", { name: "Save HSTS" }));
    expect(await screen.findByText("HSTS saved for ready.example.com")).toBeInTheDocument();
    expect(db.deploy.domains.find((d) => d.hostname === "ready.example.com")!.hsts).toMatchObject({
      include_subdomains: true,
      preload: false,
    });
  });

  it("turns preload on for an apex only after the hostname is typed", async () => {
    const { user } = await openDomains();
    await user.click(screen.getByRole("button", { name: "Add domain" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a custom domain" });
    await user.type(within(dialog).getByLabelText("Hostname"), "example.org");
    await user.click(within(dialog).getByRole("button", { name: "Add domain" }));
    await user.click(await screen.findByRole("button", { name: "Done" }));
    const row = within(screen.getByRole("list", { name: "Domain list" })).getByRole("listitem", {
      name: "example.org",
    });
    await user.click(within(row).getByRole("button", { name: "Details" }));
    const hsts = within(row).getByRole("form", { name: "HSTS for example.org" });
    await user.click(within(hsts).getByLabelText(/includeSubDomains/));
    await user.click(within(hsts).getByLabelText(/preload/));
    await user.click(within(hsts).getByRole("button", { name: "Save HSTS" }));
    const confirm = await screen.findByRole("dialog", { name: "Allow preloading example.org?" });
    const button = within(confirm).getByRole("button", { name: "Turn on preload" });
    expect(button).toBeDisabled();
    await user.type(within(confirm).getByRole("textbox"), "example.org");
    await user.click(button);
    expect(await screen.findByText("HSTS saved for example.org")).toBeInTheDocument();
    expect(db.deploy.domains.find((d) => d.hostname === "example.org")!.hsts.preload).toBe(true);
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
