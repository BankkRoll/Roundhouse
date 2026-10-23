import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { WORKSPACE_ID } from "../../mocks/db";
import { apiError } from "../../mocks/handlers";
import { server } from "../../mocks/server";
import { findPageHeading, renderApp, renderWithProviders } from "../../test/render";
import { ConsentPage } from "./consent-page";
import { decodeForwardedRequest } from "./forwarded-request";

const PARAMS = {
  response_type: "code",
  client_id: "https://agent.example/client.json",
  redirect_uri: "http://127.0.0.1:43123/callback",
  state: '{"n":1}',
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  resource: "https://cp.example/mcp",
  scope: "projects:read services:read variables:manage",
};

const CONSENT = {
  client: {
    client_id: PARAMS.client_id,
    name: "Agent Smith",
    domain: "agent.example",
    logo_uri: null,
    client_uri: null,
  },
  redirect_uri: PARAMS.redirect_uri,
  scopes: ["projects:read", "services:read", "variables:manage"],
  workspaces: [
    {
      id: WORKSPACE_ID,
      name: "Acme",
      role: "owner",
      grantable_scopes: ["projects:read", "services:read", "variables:manage"],
    },
    {
      id: "ws_other",
      name: "Other",
      role: "viewer",
      grantable_scopes: ["projects:read", "services:read"],
    },
  ],
  consent_token: "ticket",
  expires_at: Date.now() + 600_000,
};

function encode(params: Record<string, string>) {
  return btoa(JSON.stringify(params)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("forwarded authorization requests", () => {
  it("round-trips the parameters, opaque state included, and drops anything else", () => {
    expect(decodeForwardedRequest(encode(PARAMS))).toEqual(PARAMS);
    expect(decodeForwardedRequest(encode({ client_id: "x", extra: "y" }))).toEqual({
      client_id: "x",
    });
    expect(decodeForwardedRequest("not base64!")).toEqual({});
    expect(decodeForwardedRequest(undefined)).toEqual({});
  });
});

describe("consent screen", () => {
  it("names the client and its domain, ticks read scopes, and approves with the chosen ones", async () => {
    let posted: Record<string, unknown> | undefined;
    server.use(
      http.get("*/v1/oauth/authorization", ({ request }) => {
        expect(new URL(request.url).searchParams.get("state")).toBe(PARAMS.state);
        return HttpResponse.json(CONSENT);
      }),
      http.post("*/v1/oauth/authorization", async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ redirect_to: `${PARAMS.redirect_uri}?code=oac_x&state=s` });
      }),
    );
    const navigate = vi.fn();
    const { user } = renderWithProviders(<ConsentPage params={PARAMS} navigate={navigate} />);
    expect(await screen.findByRole("heading", { name: "Connect Agent Smith" })).toBeInTheDocument();
    expect(screen.getByText("agent.example")).toBeInTheDocument();
    expect(screen.getByText("127.0.0.1:43123")).toBeInTheDocument();

    const permissions = screen.getByRole("list", { name: "Permissions" });
    const manage = within(permissions).getByRole("checkbox", { name: /Set and delete variables/ });
    expect(within(permissions).getByRole("checkbox", { name: /See projects/ })).toBeChecked();
    expect(manage).not.toBeChecked();
    await user.click(manage);
    await user.click(screen.getByRole("button", { name: "Authorize" }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(`${PARAMS.redirect_uri}?code=oac_x&state=s`),
    );
    expect(posted).toEqual({
      request: PARAMS,
      consent_token: "ticket",
      decision: "approve",
      workspace_id: WORKSPACE_ID,
      scopes: ["projects:read", "services:read", "variables:manage"],
    });
  });

  it("disables what the role in the chosen workspace can't grant, and denies", async () => {
    let posted: Record<string, unknown> | undefined;
    server.use(
      http.get("*/v1/oauth/authorization", () => HttpResponse.json(CONSENT)),
      http.post("*/v1/oauth/authorization", async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ redirect_to: `${PARAMS.redirect_uri}?error=access_denied` });
      }),
    );
    const navigate = vi.fn();
    const { user } = renderWithProviders(<ConsentPage params={PARAMS} navigate={navigate} />);
    await user.selectOptions(await screen.findByLabelText("Workspace"), "ws_other");
    expect(screen.getByRole("checkbox", { name: /Set and delete variables/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(posted).toMatchObject({ decision: "deny", consent_token: "ticket" });
    expect(posted).not.toHaveProperty("scopes");
  });

  it("explains a request the API rejects", async () => {
    server.use(
      http.get("*/v1/oauth/authorization", () =>
        apiError(400, "invalid_request", "invalid_client: Client metadata document: HTTP 404"),
      ),
    );
    renderWithProviders(<ConsentPage params={PARAMS} navigate={vi.fn()} />);
    expect(
      await screen.findByRole("heading", { name: "This sign-in link can't be used" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("HTTP 404");
  });

  it("is served at /authorize from the forwarded request", async () => {
    server.use(
      http.get("*/v1/oauth/authorization", ({ request }) => {
        const query = Object.fromEntries(new URL(request.url).searchParams);
        expect(query).toEqual(PARAMS);
        return HttpResponse.json(CONSENT);
      }),
    );
    renderApp(`/authorize?request=${encode(PARAMS)}`);
    expect(await screen.findByRole("heading", { name: "Connect Agent Smith" })).toBeInTheDocument();
  });
});

describe("MCP clients settings", () => {
  const CLIENTS = [
    {
      id: "oag_1",
      client_id: PARAMS.client_id,
      name: "Agent Smith",
      domain: "agent.example",
      workspace: { id: WORKSPACE_ID, name: "Acme" },
      scopes: ["workspace:read", "projects:read", "services:read", "variables:read", "nodes:read"],
      created_at: Date.now() - 3_600_000,
      last_used_at: null,
      expires_at: Date.now() + 86_400_000,
    },
  ];

  it("lists connected clients and disconnects one", async () => {
    let deleted: string | undefined;
    server.use(
      http.get("*/v1/oauth/grants", () => HttpResponse.json({ clients: deleted ? [] : CLIENTS })),
      http.delete("*/v1/oauth/grants/:id", ({ params }) => {
        deleted = String(params.id);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user } = renderApp(`/w/${WORKSPACE_ID}/mcp-clients`);
    await findPageHeading("MCP clients");
    const nav = await screen.findByRole("navigation", { name: "Settings" });
    expect(within(nav).getByRole("link", { name: "MCP clients" })).toBeInTheDocument();
    expect(await screen.findByText("Agent Smith")).toBeInTheDocument();
    expect(screen.getByText(/Read only · 5 scopes/)).toBeInTheDocument();
    expect(screen.getByText(/never used/)).toBeInTheDocument();
    expect(screen.getByText(`${window.location.origin}/mcp`)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Disconnect Agent Smith from Acme" }));
    const dialog = await screen.findByRole("dialog", { name: "Disconnect Agent Smith?" });
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(deleted).toBe("oag_1"));
    expect(await screen.findByText("No MCP clients connected")).toBeInTheDocument();
  });
});
