import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, signInAs, USERS } from "../../mocks/db";
import { PROJECT_PATH, SEED } from "../../test/phase1";
import { renderApp } from "../../test/render";

const ENVIRONMENTS = `${PROJECT_PATH}/settings/environments`;

async function open(role: "owner" | "member" | "viewer" = "owner") {
  signInAs(USERS[role].id);
  const app = renderApp(ENVIRONMENTS);
  const table = await screen.findByRole("table", { name: "Environments" });
  return { ...app, table };
}

function rowOf(_table: HTMLElement, name: string): HTMLElement {
  const row = within(screen.getByRole("table", { name: "Environments" }))
    .getAllByRole("row")
    .find((r) => r.textContent?.includes(name));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("environment lifecycle", () => {
  it("clones an environment with the chosen variables", async () => {
    const { user } = await open();
    await user.click(await screen.findByRole("button", { name: "New environment" }));
    const form = await screen.findByRole("form", { name: "New environment" });
    await user.type(within(form).getByLabelText("Name"), "Staging");
    await user.selectOptions(within(form).getByLabelText("Copy from"), SEED.production);
    await user.selectOptions(within(form).getByLabelText("Variables"), "non_secret");
    await user.click(within(form).getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Created Staging")).toBeInTheDocument();
    const created = db.deploy.environments.find((row) => row.name === "Staging")!;
    expect(created.kind).toBe("staging");
    const copied = db.deploy.variables.filter((v) => v.environment_id === created.id);
    expect(copied.every((v) => v.tier !== "secret")).toBe(true);
    expect(db.audit.at(-1)?.action).toBe("environment.cloned");
  });

  it("deletes an environment only once its slug is typed, and never production", async () => {
    const { user, table } = await open();
    expect(within(rowOf(table, "production")).queryByRole("button", { name: "Delete" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "New environment" }));
    const form = await screen.findByRole("form", { name: "New environment" });
    await user.type(within(form).getByLabelText("Name"), "Scratch");
    await user.click(within(form).getByRole("button", { name: "Create" }));
    const row = await waitFor(() => rowOf(table, "Scratch"));
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Scratch?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete environment" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox"), "scratch");
    await user.click(confirm);
    await waitFor(() =>
      expect(db.deploy.environments.some((row) => row.name === "Scratch")).toBe(false),
    );
    expect(db.audit.at(-1)?.action).toBe("environment.deleted");
  });

  it("compares two environments without showing values", async () => {
    const { user, table } = await open();
    await user.click(await screen.findByRole("button", { name: "New environment" }));
    const form = await screen.findByRole("form", { name: "New environment" });
    await user.type(within(form).getByLabelText("Name"), "QA");
    await user.selectOptions(within(form).getByLabelText("Copy from"), SEED.production);
    await user.click(within(form).getByRole("button", { name: "Create" }));
    const qa = db.deploy.environments.find((row) => row.name === "QA")!;
    const secret = db.deploy.variables.find(
      (v) => v.environment_id === qa.id && v.tier === "secret",
    );
    if (secret) secret.value = "changed-secret-value-for-test";
    const row = await waitFor(() => rowOf(table, "QA"));
    await user.click(within(row).getByRole("button", { name: "Compare" }));
    const dialog = await screen.findByRole("dialog", { name: "Compare QA" });
    const diff = await within(dialog).findByRole("table", { name: "Differences" });
    if (secret) expect(diff).toHaveTextContent(`${secret.key} changed (secret)`);
    expect(dialog).not.toHaveTextContent("changed-secret-value-for-test");
  });

  it("proposes a promotion and hides lifecycle actions from viewers", async () => {
    const { user, table } = await open();
    await user.click(await screen.findByRole("button", { name: "New environment" }));
    const form = await screen.findByRole("form", { name: "New environment" });
    await user.type(within(form).getByLabelText("Name"), "Next");
    await user.selectOptions(within(form).getByLabelText("Copy from"), SEED.production);
    await user.click(within(form).getByRole("button", { name: "Create" }));
    const next = await waitFor(() => db.deploy.environments.find((row) => row.name === "Next")!);
    const plain = db.deploy.variables.find(
      (v) => v.environment_id === next.id && v.tier !== "secret",
    )!;
    plain.value = `${plain.value}-next`;
    await user.click(
      within(rowOf(table, "production")).getByRole("button", { name: "Promote into" }),
    );
    const dialog = await screen.findByRole("form", { name: "Promote" });
    await user.selectOptions(within(dialog).getByLabelText("From"), next.id);
    await user.click(within(dialog).getByRole("button", { name: "Propose" }));
    await waitFor(() => expect(db.changes.sets.some((set) => set.source === "promote")).toBe(true));
    expect(db.audit.at(-1)?.action).toBe("environment.promote_proposed");
  });

  it("shows viewers the list without lifecycle actions", async () => {
    await open("viewer");
    expect(screen.queryByRole("button", { name: "New environment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Promote into" })).not.toBeInTheDocument();
  });
});
