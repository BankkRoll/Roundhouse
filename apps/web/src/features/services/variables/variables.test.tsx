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
    expect(secret).toHaveTextContent(/fp [a-f0-9]{8}/);
    expect(rowOf("NODE_ENV")).not.toHaveTextContent(/fp [a-f0-9]{8}/);
  });

  it("never offers to reveal a secret (ADR 0014: write-only)", async () => {
    const { rowOf } = await openVariables();
    expect(within(rowOf("DATABASE_URL")).queryByRole("button", { name: /Reveal/ })).toBeNull();
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
    const confirm = await screen.findByRole("dialog", { name: "Store these values write-only?" });
    await user.click(within(confirm).getByRole("button", { name: "Store write-only" }));
    await waitFor(() =>
      expect(serviceVariable("CACHE_TTL")).toMatchObject({ value: "60", tier: "secret" }),
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

  it("asks before storing a value write-only, listing the keys, and saves once confirmed", async () => {
    const { user, rowOf } = await openVariables();
    await user.click(screen.getByRole("button", { name: "Add variable" }));
    const form = screen.getByRole("form", { name: "New variable" });
    await user.type(within(form).getByLabelText("Key"), "WEBHOOK_TOKEN");
    await user.type(within(form).getByRole("combobox", { name: "Value" }), "not-a-real-token");
    await user.click(within(form).getByRole("switch", { name: "Secret" }));
    await user.click(within(form).getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const dialog = await screen.findByRole("dialog", { name: "Store this value write-only?" });
    expect(dialog).toHaveTextContent("can never be shown again");
    expect(within(dialog).getByText("WEBHOOK_TOKEN")).toBeInTheDocument();
    expect(serviceVariable("WEBHOOK_TOKEN")).toBeUndefined();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("1 staged change")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Store this value write-only?" })).getByRole(
        "button",
        { name: "Store write-only" },
      ),
    );
    await waitFor(() =>
      expect(serviceVariable("WEBHOOK_TOKEN")).toMatchObject({ tier: "secret", version: 1 }),
    );
    const row = rowOf("WEBHOOK_TOKEN");
    expect(row).not.toHaveTextContent("not-a-real-token");
    expect(within(row).getByText("value hidden")).toBeInTheDocument();
    expect(row).toHaveTextContent(/fp [a-f0-9]{8}/);
  });

  it("locks the secret switch for a recognised credential and explains why", async () => {
    const { user } = await openVariables();
    await user.click(screen.getByRole("button", { name: "Add variable" }));
    const form = screen.getByRole("form", { name: "New variable" });
    await user.type(within(form).getByLabelText("Key"), "REPLICA_URL");
    await user.type(
      within(form).getByRole("combobox", { name: "Value" }),
      "postgres://app:not-a-real-password@db.example.test/app",
    );
    const toggle = within(form).getByRole("switch", { name: "Secret" });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAccessibleDescription(/always stored as a write-only secret/);
  });

  it("asks before shipping a credential-looking public variable to browsers", async () => {
    const { user } = await openVariables();
    await user.click(screen.getByRole("button", { name: "Add variable" }));
    const form = screen.getByRole("form", { name: "New variable" });
    await user.type(within(form).getByLabelText("Key"), "VITE_DB");
    await user.type(
      within(form).getByRole("combobox", { name: "Value" }),
      "postgres://app:not-a-real-password@db.example.test/app",
    );
    const toggle = within(form).getByRole("switch", { name: "Secret" });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/VITE_ variables ship to the browser/);
    await user.click(within(form).getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const dialog = await screen.findByRole("dialog", { name: "Ship VITE_DB to every browser?" });
    await user.click(within(dialog).getByRole("button", { name: "Store as public" }));
    await waitFor(() => expect(serviceVariable("VITE_DB")).toMatchObject({ tier: "plain" }));
  });

  it("explains a protected environment to developers and offers no edits", async () => {
    const production = db.deploy.environments.find((row) => row.id === SEED.production)!;
    production.protected = true;
    signInAs(USERS.member.id);
    const { rowOf } = await openVariables();
    expect(await screen.findByRole("note")).toHaveTextContent(
      "production is protected: only project admins and people its rules list can change variables here.",
    );
    expect(screen.queryByRole("button", { name: "Add variable" })).not.toBeInTheDocument();
    expect(
      within(rowOf("NODE_ENV")).queryByRole("button", { name: "Edit NODE_ENV" }),
    ).not.toBeInTheDocument();
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

  it("turns build-time on for a secret with a flags-only write", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.put("*/v1/services/:serviceId/variables", async ({ request }) => {
        bodies.push(await request.clone().json());
      }),
    );
    const before = { ...serviceVariable("SESSION_SECRET")! };
    const { user, rowOf } = await openVariables();
    const toggle = within(rowOf("SESSION_SECRET")).getByRole("switch", {
      name: "Available at build: SESSION_SECRET",
    });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(
      /BuildKit secrets read with RUN --mount=type=secret/,
    );
    expect(toggle).toHaveAccessibleDescription(/fork and PR preview builds never get/);
    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(rowOf("SESSION_SECRET")).toHaveTextContent("staged");
    expect(rowOf("SESSION_SECRET")).toHaveTextContent(/fp [a-f0-9]{8}/);

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Saved as a new version/)).toBeInTheDocument();
    expect(bodies).toEqual([
      {
        set: [{ key: "SESSION_SECRET", available_at_build: true }],
        delete: [],
        confirm_write_only: false,
      },
    ]);
    expect(serviceVariable("SESSION_SECRET")).toMatchObject({
      value: before.value,
      tier: "secret",
      available_at_build: true,
      mount_as_file: false,
      version: before.version + 1,
    });
    expect(
      within(rowOf("SESSION_SECRET")).getByRole("switch", {
        name: "Available at build: SESSION_SECRET",
      }),
    ).toBeChecked();
    expect(rowOf("SESSION_SECRET")).not.toHaveTextContent("staged");
  });

  it("mounts a secret as a file from the editor without re-entering it", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.put("*/v1/services/:serviceId/variables", async ({ request }) => {
        bodies.push(await request.clone().json());
      }),
    );
    const { user, rowOf } = await openVariables();
    await user.click(
      within(rowOf("DATABASE_URL")).getByRole("button", { name: "Edit DATABASE_URL" }),
    );
    const edit = screen.getByRole("form", { name: "Edit DATABASE_URL" });
    const file = within(edit).getByRole("switch", { name: "Mount as file" });
    expect(file).toHaveAccessibleDescription(
      /read-only file at \/run\/secrets\/DATABASE_URL .*docker inspect.*DATABASE_URL_FILE=\/run\/secrets\/DATABASE_URL/,
    );
    expect(
      within(edit).getByRole("switch", { name: "Available at build" }),
    ).toHaveAccessibleDescription(
      /BuildKit secret: read it with RUN --mount=type=secret,id=DATABASE_URL/,
    );
    await user.click(file);
    await user.click(within(edit).getByRole("button", { name: "Done" }));
    expect(
      within(rowOf("DATABASE_URL")).getByRole("switch", { name: "Mount as file: DATABASE_URL" }),
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Saved as a new version/)).toBeInTheDocument();
    expect(bodies).toEqual([
      expect.objectContaining({ set: [{ key: "DATABASE_URL", mount_as_file: true }] }),
    ]);
    expect(serviceVariable("DATABASE_URL")).toMatchObject({
      value: "postgres://store:hunter2@db.internal:5432/store",
      mount_as_file: true,
    });
  });

  it("toggling a flag back drops the staged change", async () => {
    const { user, rowOf } = await openVariables();
    const toggle = within(rowOf("NODE_ENV")).getByRole("switch", {
      name: "Mount as file: NODE_ENV",
    });
    await user.click(toggle);
    expect(screen.getByText("1 staged change")).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.queryByText(/staged change/)).not.toBeInTheDocument();
  });

  it("prevents build-time where the API would refuse it, and says why", async () => {
    const { user } = await openVariables();
    await user.click(screen.getByRole("button", { name: "Add variable" }));
    const form = screen.getByRole("form", { name: "New variable" });
    await user.type(within(form).getByLabelText("Key"), "PATH");
    const build = within(form).getByRole("switch", { name: "Available at build" });
    expect(build).toBeDisabled();
    expect(build).toHaveAccessibleDescription(/PATH is reserved for the builder's own environment/);

    const key = within(form).getByLabelText("Key");
    await user.clear(key);
    await user.type(key, "DB_ARG");
    expect(build).toBeEnabled();
    await user.click(within(form).getByRole("combobox", { name: "Value" }));
    await user.paste(ref("DATABASE_URL}}"));
    expect(build).toBeDisabled();
    expect(build).toHaveAccessibleDescription(
      /DB_ARG references a secret.*RUN --mount=type=secret,id=DB_ARG/,
    );
    await user.click(within(form).getByRole("switch", { name: "Secret" }));
    expect(build).toBeEnabled();
  });

  it("shows the API's build-time refusal on the variable's switch", async () => {
    const message =
      "NODE_ENV references a secret; make it a secret variable with available_at_build and read it with RUN --mount=type=secret,id=NODE_ENV";
    server.use(
      http.put("*/v1/services/:serviceId/variables", () =>
        HttpResponse.json(
          {
            error: {
              code: "build_arg_secret",
              message,
              details: [{ field: "NODE_ENV", code: "build_arg_secret", message }],
            },
          },
          { status: 400 },
        ),
      ),
    );
    const { user, rowOf } = await openVariables();
    const toggle = within(rowOf("NODE_ENV")).getByRole("switch", {
      name: "Available at build: NODE_ENV",
    });
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const alert = await within(rowOf("NODE_ENV")).findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(toggle).toHaveAttribute("aria-invalid", "true");
    expect(toggle).toHaveAccessibleDescription(
      /NODE_ENV references a secret; make it a secret variable/,
    );
    expect(screen.getByText("1 staged change")).toBeInTheDocument();
  });

  it("disables the flag switches with the reason in a protected environment", async () => {
    const production = db.deploy.environments.find((row) => row.id === SEED.production)!;
    production.protected = true;
    signInAs(USERS.member.id);
    const { rowOf } = await openVariables();
    await screen.findByRole("note");
    for (const name of ["Available at build: NODE_ENV", "Mount as file: NODE_ENV"]) {
      const toggle = within(rowOf("NODE_ENV")).getByRole("switch", { name });
      expect(toggle).toBeDisabled();
      expect(toggle).toHaveAccessibleDescription(/production is protected/);
    }
  });

  it("shows flags to viewers as badges, not switches", async () => {
    Object.assign(serviceVariable("SESSION_SECRET")!, {
      available_at_build: true,
      mount_as_file: true,
    });
    signInAs(USERS.viewer.id);
    const { rowOf } = await openVariables();
    const secret = rowOf("SESSION_SECRET");
    expect(within(secret).queryByRole("switch")).not.toBeInTheDocument();
    expect(within(secret).getByText("build")).toBeInTheDocument();
    expect(within(secret).getByText("file")).toBeInTheDocument();
    expect(within(rowOf("NODE_ENV")).queryByText("build")).not.toBeInTheDocument();
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
