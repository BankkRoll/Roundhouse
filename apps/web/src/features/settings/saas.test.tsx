import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, WORKSPACE_ID } from "../../mocks/db";
import { SEED, servicePath } from "../../test/phase1";
import { renderApp } from "../../test/render";

const PAGE = `/w/${WORKSPACE_ID}/domains-tls`;
const ZONE_ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-saas-token-0123456789abcdef";

describe("Cloudflare for SaaS settings", () => {
  it("connects a zone with a write-only token, then explains a refused switch", async () => {
    const { user } = renderApp(PAGE);
    const form = await screen.findByRole("form", { name: "Cloudflare for SaaS" });
    expect(within(form).getByText("Direct")).toBeInTheDocument();
    expect(within(form).getByText("0 of 100 included")).toBeInTheDocument();
    await user.type(within(form).getByLabelText("Zone ID"), ZONE_ID);
    await user.type(within(form).getByLabelText("API token"), TOKEN);
    await user.click(within(form).getByRole("checkbox", { name: /Cloudflare only/ }));
    await user.click(within(form).getByRole("button", { name: "Connect zone" }));
    expect(await screen.findByText("Cloudflare for SaaS zone saved")).toBeInTheDocument();
    expect(await within(form).findByText("customers.saas.example.com")).toBeInTheDocument();
    expect(within(form).getByText("Cloudflare only")).toBeInTheDocument();
    expect(form).not.toHaveTextContent(TOKEN);
    expect(db.deploy.tls.saas?.api_token).toBe(TOKEN);

    await user.click(within(form).getByRole("button", { name: "Use Cloudflare for SaaS" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(/managed first/);
  });

  it("switches custom domains to Cloudflare once managed TLS and the mesh are on", async () => {
    db.deploy.instance.tls_mode = "managed";
    db.deploy.instance.mesh_enabled = true;
    db.deploy.tls.saas = {
      zone_id: ZONE_ID,
      zone_name: "saas.example.com",
      cname_target: "customers.saas.example.com",
      fallback_origin: "origin.saas.example.com",
      fallback_status: "active",
      fallback_errors: [],
      enterprise: false,
      ingress_firewall: "off",
      updated_at: Date.now(),
      api_token: TOKEN,
    };
    const { user } = renderApp(PAGE);
    const form = await screen.findByRole("form", { name: "Cloudflare for SaaS" });
    await user.click(within(form).getByRole("button", { name: "Use Cloudflare for SaaS" }));
    expect(
      await screen.findByText("Custom domains now go through Cloudflare for SaaS"),
    ).toBeInTheDocument();
    expect(db.deploy.tls.custom_domains_mode).toBe("cloudflare_saas");
  });
});

describe("a Cloudflare for SaaS domain", () => {
  it("shows Cloudflare's status and errors in its details", async () => {
    const domain = db.deploy.domains.find((d) => d.service_id === SEED.web)!;
    domain.mode = "cloudflare_saas";
    domain.cf = {
      status: "pending",
      ssl_status: "pending_validation",
      errors: ["custom hostname does not CNAME to this zone"],
    };
    const { user } = renderApp(servicePath(SEED.web, "domains"));
    const list = await screen.findByRole("list", { name: "Domain list" });
    const row = within(list).getByRole("listitem", { name: domain.hostname });
    await user.click(within(row).getByRole("button", { name: "Details" }));
    const facts = within(row).getByLabelText("Cloudflare for SaaS");
    expect(facts).toHaveTextContent("pending_validation");
    expect(within(row).getByText(/does not CNAME/)).toBeInTheDocument();
  });
});
