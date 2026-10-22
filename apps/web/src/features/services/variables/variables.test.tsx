import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { db, signInAs, USERS } from "../../../mocks/db";
import { server } from "../../../mocks/server";
import { SEED, servicePath } from "../../../test/phase1";
import { renderApp } from "../../../test/render";

const VARS = servicePath(SEED.web, "variables");
const ref = (body: string) => `\${{${body}`;

async function openVariables() {
  const app = renderApp(VARS);
  const list = await screen.findByRole("list", { name: "Variables list" });
  const rowOf = (key: string) => within(list).getByText(key).closest("li")!;
  return { ...app, list, rowOf };
}

function serviceVariable(key: string) {
  return db.deploy.variables.find((row) => row.owner_id === SEED.web && row.key === key);
}

describe("variables editor", () => {
  it("masks secrets and shows plain values", async () => {
    const { rowOf } = await openVariables();
    expect(rowOf("NODE_ENV")).toHaveTextContent("production");
    const secret = rowOf("DATABASE_URL");
    expect(secret).toHaveTextContent("secret");
    expect(secret).not.toHaveTextContent("hunter2");
    expect(secret).toHaveTextContent("••••");
    expect(within(secret).getByText("value hidden")).toHaveClass("sr-only");
  });

  it("reveals a secret through the audited reveal route, then hides it", async () => {
    const { user, rowOf } = await openVariables();
    await user.click(
      within(rowOf("DATABASE_URL")).getByRole("button", { name: "Reveal DATABASE_URL" }),
    );
    await waitFor(() => expect(rowOf("DATABASE_URL")).toHaveTextContent("hunter2"));
    expect(db.audit.at(-1)).toMatchObject({
      action: "variables.revealed",
      metadata: { keys: ["DATABASE_URL"] },
    });
    await user.click(
      within(rowOf("DATABASE_URL")).getByRole("button", { name: "Hide DATABASE_URL" }),
    );
    expect(rowOf("DATABASE_URL")).not.toHaveTextContent("hunter2");
  });

  it("stages adds, edits and deletes, saves them as one version and prompts a deploy", async () => {
    const { user, rowOf } = await openVariables();
    await user.click(screen.getByRole("button", { name: "Add variable" }));
    const form = screen.getByRole("form", { name: "New variable" });
    await user.type(within(form).getByLabelText("Key"), "log_level");
    await user.type(within(form).getByRole("combobox", { name: "Value" }), "debug");
    await user.click(within(form).getByRole("button", { name: "Add" }));
    expect(rowOf("LOG_LEVEL")).toHaveTextContent("new");

    await user.click(within(rowOf("NODE_ENV")).getByRole("button", { name: "Edit NODE_ENV" }));
    const edit = screen.getByRole("form", { name: "Edit NODE_ENV" });
    const value = within(edit).getByRole("combobox", { name: "Value" });
    await user.clear(value);
    await user.type(value, "staging{Enter}");
    expect(rowOf("NODE_ENV")).toHaveTextContent("staged");

    await user.click(
      within(rowOf("SESSION_SECRET")).getByRole("button", { name: "Delete SESSION_SECRET" }),
    );
    expect(rowOf("SESSION_SECRET")).toHaveTextContent("deleted");
    expect(screen.getByText("3 staged changes")).toBeInTheDocument();
    expect(serviceVariable("LOG_LEVEL")).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Saved as a new version/)).toBeInTheDocument();
    expect(serviceVariable("LOG_LEVEL")).toMatchObject({ value: "debug", version: 1 });
    expect(serviceVariable("NODE_ENV")).toMatchObject({ value: "staging", version: 3 });
    expect(serviceVariable("SESSION_SECRET")).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Deploy to apply" }));
    expect(await screen.findByText("Deploying web")).toBeInTheDocument();
    expect(db.deploy.deployments.at(-1)).toMatchObject({ service_id: SEED.web, status: "queued" });
  });

  it("replaces a secret without revealing it, and keeps it when left blank", async () => {
    const { user, rowOf } = await openVariables();
    await user.click(
      within(rowOf("DATABASE_URL")).getByRole("button", { name: "Edit DATABASE_URL" }),
    );
    const edit = screen.getByRole("form", { name: "Edit DATABASE_URL" });
    expect(within(edit).getByRole("combobox", { name: "Value" })).toHaveValue("");
    await user.click(within(edit).getByRole("button", { name: "Done" }));
    expect(screen.queryByText(/staged change/)).not.toBeInTheDocument();
    expect(db.audit.some((entry) => entry.action === "variables.revealed")).toBe(false);
  });

  it("bulk-pastes a .env file", async () => {
    const { user, rowOf } = await openVariables();
    await user.click(screen.getByRole("button", { name: "Paste .env" }));
    const dialog = await screen.findByRole("dialog", { name: "Paste .env" });
    const area = within(dialog).getByLabelText(".env contents");
    await user.click(area);
    await user.paste("# copied\nNODE_ENV=test\nexport CACHE_TTL=60\nbad line");
    expect(within(dialog).getByText("Line 4: Expected KEY=value")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Stage/ })).toBeDisabled();
    await user.keyboard("{Backspace>8/}");
    expect(
      within(dialog).getByText("2 variables · 1 will overwrite existing values"),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("switch", { name: "Mark all as secret" }));
    await user.click(within(dialog).getByRole("button", { name: "Stage 2 variables" }));
    expect(rowOf("CACHE_TTL")).toHaveTextContent("new");
    expect(rowOf("CACHE_TTL")).toHaveTextContent("secret");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(serviceVariable("CACHE_TTL")).toMatchObject({ value: "60", is_secret: true }),
    );
  });

  it("autocompletes references to services, shared variables and keys", async () => {
    const { user } = await openVariables();
    await user.click(screen.getByRole("button", { name: "Add variable" }));
    const form = screen.getByRole("form", { name: "New variable" });
    await user.type(within(form).getByLabelText("Key"), "API_KEY_REF");
    const input = within(form).getByRole("combobox", { name: "Value" });
    await user.type(input, "{{");
    await user.clear(input);
    await user.type(input, "$");
    await user.keyboard("{{{{");
    const list = await screen.findByRole("listbox", { name: "Reference suggestions" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(
      expect.arrayContaining([expect.stringMatching(/^shared\./), expect.stringMatching(/^api\./)]),
    );
    expect(input).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("api");
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["api.service", "API_URLthis service"]);
    await user.keyboard("{Enter}");
    expect(input).toHaveValue(ref("api."));
    const keys = await screen.findByRole("listbox", { name: "Reference suggestions" });
    await waitFor(() =>
      expect(within(keys).getByRole("option", { name: /LOG_LEVEL/ })).toBeInTheDocument(),
    );
    await user.keyboard("LOG{Enter}");
    expect(input).toHaveValue(ref("api.LOG_LEVEL}}"));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows reference syntax errors with their position before saving", async () => {
    const { user } = await openVariables();
    await user.click(screen.getByRole("button", { name: "Add variable" }));
    const form = screen.getByRole("form", { name: "New variable" });
    await user.type(within(form).getByLabelText("Key"), "BROKEN");
    await user.click(within(form).getByRole("combobox", { name: "Value" }));
    await user.paste(`http://${ref(" api.bad ref }}")}/x`);
    expect(within(form).queryByRole("alert")).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Add" }));
    const alert = within(form).getByRole("alert");
    expect(alert).toHaveTextContent(/Invalid reference/);
    expect(alert).toHaveTextContent("(characters 8–25)");
    expect(alert.querySelector("mark")).toHaveTextContent(ref(" api.bad ref }}"));
    expect(within(form).getByRole("combobox", { name: "Value" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.queryByText(/staged change/)).not.toBeInTheDocument();
  });

  it("shows the API's validation details on the right rows", async () => {
    server.use(
      http.put("*/v1/services/:serviceId/variables", () =>
        HttpResponse.json(
          {
            error: {
              code: "invalid_reference",
              message: "NODE_ENV: Reference is missing its closing }} (at 2-5)",
              details: [
                {
                  field: "NODE_ENV",
                  code: "unclosed_reference",
                  message: "Reference is missing its closing }}",
                  start: 2,
                  end: 5,
                },
              ],
            },
          },
          { status: 400 },
        ),
      ),
    );
    const { user, rowOf } = await openVariables();
    await user.click(within(rowOf("NODE_ENV")).getByRole("button", { name: "Edit NODE_ENV" }));
    const value = within(screen.getByRole("form", { name: "Edit NODE_ENV" })).getByRole(
      "combobox",
      {
        name: "Value",
      },
    );
    await user.clear(value);
    await user.type(value, "abcdefg{Enter}");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const alert = await within(rowOf("NODE_ENV")).findByRole("alert");
    expect(alert).toHaveTextContent("Reference is missing its closing }} (characters 3–5)");
    expect(alert.querySelector("mark")).toHaveTextContent("cde");
    expect(screen.getByText("1 staged change")).toBeInTheDocument();
  });

  it("lets members edit but not reveal", async () => {
    signInAs(USERS.member.id);
    const { rowOf } = await openVariables();
    expect(
      within(rowOf("DATABASE_URL")).queryByRole("button", { name: /Reveal/ }),
    ).not.toBeInTheDocument();
    expect(
      within(rowOf("DATABASE_URL")).getByRole("button", { name: "Edit DATABASE_URL" }),
    ).toBeInTheDocument();
  });

  it("is read-only for viewers, with secrets masked", async () => {
    signInAs(USERS.viewer.id);
    const { rowOf } = await openVariables();
    expect(screen.queryByRole("button", { name: "Add variable" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Paste .env" })).not.toBeInTheDocument();
    const secret = rowOf("SESSION_SECRET");
    expect(within(secret).queryByRole("button")).not.toBeInTheDocument();
    expect(secret).not.toHaveTextContent("s3cr3t");
  });
});
