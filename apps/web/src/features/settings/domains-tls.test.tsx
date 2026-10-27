import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { findPageHeading, renderApp } from "../../test/render";

const PAGE = `/w/${WORKSPACE_ID}/domains-tls`;
const ZONE_ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-token-0123456789abcdef";

describe("Domains & TLS settings", () => {
  it("lets instance admins set the apps domain and TLS mode", async () => {
    const { user } = renderApp(PAGE);
    await findPageHeading("Domains & TLS");
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
    expect(await screen.findByText("Ingress settings saved")).toBeInTheDocument();
    expect(db.deploy.instance).toMatchObject({
      apps_domain: "127.0.0.1.nip.io",
      tls_mode: "internal",
    });
  });

  it("warns about acme with several ingress servers and switches to managed", async () => {
    const { user } = renderApp(PAGE);
    const form = await screen.findByRole("form", { name: "Ingress" });
    expect(within(form).getByText(/This install has 2 ingress servers/)).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Switch to managed" }));
    expect(within(form).getByLabelText("TLS mode")).toHaveValue("managed");
    expect(within(form).getByText(/50 new certificates per registered domain/)).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Ingress settings saved")).toBeInTheDocument();
    expect(db.deploy.instance.tls_mode).toBe("managed");

    const certificates = await screen.findByRole("table", { name: "Certificates" });
    expect(certificates).toHaveTextContent("web-production-x7k2.apps.example.com");
    expect(certificates).toHaveTextContent("Generated");
    expect(certificates).toHaveTextContent("Issued");
    expect(certificates).toHaveTextContent("2/2");
  });

  it("offers managed only when its prerequisites are met, and says what is missing", async () => {
    db.deploy.tls.managed_problems = ["PUBLIC_ORIGIN must be an https URL."];
    renderApp(PAGE);
    const form = await screen.findByRole("form", { name: "Ingress" });
    expect(
      within(form).getByRole("option", { name: /managed by the control plane/ }),
    ).toBeDisabled();
    expect(
      within(within(form).getByRole("list", { name: "Managed TLS prerequisites" })).getByText(
        "PUBLIC_ORIGIN must be an https URL.",
      ),
    ).toBeInTheDocument();
    expect(
      within(form).queryByRole("button", { name: "Switch to managed" }),
    ).not.toBeInTheDocument();
  });

  it("saves the ingress hostname and the ACME contact", async () => {
    const { user } = renderApp(PAGE);
    const custom = await screen.findByRole("form", { name: "Custom domains" });
    await user.type(within(custom).getByLabelText("Ingress hostname"), "Ingress.Example.com");
    await user.click(within(custom).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Ingress hostname saved")).toBeInTheDocument();
    expect(db.deploy.tls.ingress_hostname).toBe("ingress.example.com");

    const acme = screen.getByRole("form", { name: "Certificate authority" });
    expect(within(acme).getByLabelText("ACME directory URL")).toHaveValue(
      "https://acme-v02.api.letsencrypt.org/directory",
    );
    const email = within(acme).getByLabelText("Contact email");
    await user.type(email, "not-an-email");
    await user.click(within(acme).getByRole("button", { name: "Save" }));
    expect(within(acme).getByText(/Enter an email address/)).toBeInTheDocument();
    await user.clear(email);
    await user.type(email, "ops@example.com");
    await user.click(within(acme).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Certificate authority saved")).toBeInTheDocument();
    expect(db.deploy.tls.acme.email).toBe("ops@example.com");
  });

  it("connects a Cloudflare zone write-only, shows the API's refusal, and removes it", async () => {
    const { user } = renderApp(PAGE);
    const form = await screen.findByRole("form", { name: "Cloudflare DNS" });
    expect(within(form).getByText(/Zone → DNS → Edit and Zone → Zone → Read/)).toBeInTheDocument();
    await user.type(within(form).getByLabelText("Zone ID"), ZONE_ID);
    await user.type(within(form).getByLabelText("API token"), "invalid-token-0123456789");
    await user.click(within(form).getByRole("button", { name: "Connect zone" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The token can't use that zone");
    expect(db.deploy.tls.cloudflare_dns).toBeNull();

    await user.clear(within(form).getByLabelText("API token"));
    await user.type(within(form).getByLabelText("API token"), TOKEN);
    await user.click(within(form).getByRole("button", { name: "Connect zone" }));
    expect(await screen.findByText("Cloudflare zone example.com connected")).toBeInTheDocument();
    expect(db.deploy.tls.cloudflare_dns).toMatchObject({
      zone_id: ZONE_ID,
      zone_name: "example.com",
    });
    expect(within(form).queryByLabelText("API token")).not.toBeInTheDocument();
    expect(within(form).getByText("Connected")).toBeInTheDocument();
    expect(within(form).getByText(/Apps wildcard certificate/)).toHaveTextContent("available");
    expect(JSON.stringify(db.audit.at(-1))).not.toContain(TOKEN);

    await user.click(within(form).getByRole("button", { name: "Remove" }));
    const confirm = await screen.findByRole("dialog", {
      name: "Remove the Cloudflare zone example.com?",
    });
    await user.click(within(confirm).getByRole("button", { name: "Remove zone" }));
    await waitFor(() => expect(db.deploy.tls.cloudflare_dns).toBeNull());
    expect(await within(form).findByLabelText("Zone ID")).toBeInTheDocument();
  });

  it("asks for the password before saving with a stale session", async () => {
    db.sessionStale = true;
    const { user } = renderApp(PAGE);
    const custom = await screen.findByRole("form", { name: "Custom domains" });
    await user.type(within(custom).getByLabelText("Ingress hostname"), "ingress.example.com");
    await user.click(within(custom).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("dialog", { name: /Confirm/ })).toBeInTheDocument();
    expect(db.deploy.tls.ingress_hostname).toBeNull();
  });

  it("is in the instance settings for instance admins only", async () => {
    renderApp(`/w/${WORKSPACE_ID}/settings`);
    const tabs = await screen.findByRole("navigation", { name: "Settings" });
    expect(within(tabs).getByRole("link", { name: "Domains & TLS" })).toBeInTheDocument();
  });

  it("explains itself to workspace admins who aren't instance admins", async () => {
    signInAs(USERS.admin.id);
    renderApp(PAGE);
    expect(
      await screen.findByRole("heading", { name: "Domains & TLS are for instance admins" }),
    ).toBeInTheDocument();
    const tabs = screen.getByRole("navigation", { name: "Settings" });
    expect(within(tabs).queryByRole("link", { name: "Domains & TLS" })).not.toBeInTheDocument();
  });
});
