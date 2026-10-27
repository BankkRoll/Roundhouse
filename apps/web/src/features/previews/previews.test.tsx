import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, signInAs, USERS } from "../../mocks/db";
import { addPreviewEnvironment, PREVIEW_SEED } from "../../mocks/previews-db";
import { PROJECT_PATH, SEED, servicePath } from "../../test/phase1";
import { renderApp } from "../../test/render";

const PREVIEWS = `${PROJECT_PATH}/previews`;

const preview = (id: string) => db.previews.previews.find((row) => row.id === id)!;
const settings = () => db.previews.settings[SEED.project]!;

async function openPreviews() {
  const app = renderApp(PREVIEWS);
  const table = await screen.findByRole("table", { name: "Previews" });
  return { ...app, table };
}

const rowOf = (table: HTMLElement, pr: number) =>
  within(table)
    .getAllByRole("row")
    .find((row) => row.textContent?.includes(`#${pr}`))!;

describe("previews page", () => {
  it("lists open previews with their status, badges, head, services and expiry", async () => {
    const { table, user } = await openPreviews();
    expect(screen.getByRole("heading", { level: 1, name: "Previews" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Previews" })).toHaveAttribute("aria-current", "page");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.dataset.status)).toEqual([
      "active",
      "pending_approval",
      "fork_disabled",
    ]);

    const active = rowOf(table, 42);
    expect(within(active).getByRole("link", { name: "#42 Faster checkout" })).toHaveAttribute(
      "href",
      "https://github.com/acme/storefront/pull/42",
    );
    expect(active).toHaveTextContent("Active");
    expect(active).toHaveTextContent("4c1d2e3");
    expect(active).toHaveTextContent("expires in 2 days");
    expect(within(active).getByRole("link", { name: "web" })).toHaveAttribute(
      "href",
      "https://pr-42-web.preview.example.com",
    );
    expect(within(active).getByRole("img", { name: "web: active" })).toBeInTheDocument();
    expect(within(active).queryByText("fork")).not.toBeInTheDocument();

    const pending = rowOf(table, 57);
    expect(pending).toHaveTextContent("Needs approval");
    expect(pending).toHaveTextContent("mallory");
    expect(within(pending).getByText("fork")).toBeInTheDocument();
    expect(within(pending).getByText("secrets withheld")).toBeInTheDocument();
    expect(rowOf(table, 61)).toHaveTextContent("Forks off");

    expect(within(table).queryByText(/Old experiment/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Show closed" }));
    const closed = await screen.findByText(/Old experiment/);
    expect(closed.closest("tr")).toHaveTextContent("Closed");
    expect(closed.closest("tr")).toHaveTextContent("closed 5d ago");
  });

  it("approves the head commit on screen", async () => {
    const { table, user } = await openPreviews();
    await user.click(within(rowOf(table, 57)).getByRole("button", { name: "Approve #57" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve #57 at b7e6d5c?" });
    expect(dialog).toHaveTextContent("mallory/storefront");
    await user.click(within(dialog).getByRole("button", { name: "Approve and build" }));
    expect(await screen.findByText("Approved #57")).toBeInTheDocument();
    expect(preview(PREVIEW_SEED.pending)).toMatchObject({
      status: "creating",
      approved_sha: PREVIEW_SEED.pendingSha,
    });
    await waitFor(() => expect(rowOf(table, 57)).toHaveTextContent("Creating"));
    expect(db.audit.at(-1)).toMatchObject({ action: "preview.approved", target_id: "prv_57" });
  });

  it("refuses an approval once the pull request moved on, and shows the new head", async () => {
    const { table, user } = await openPreviews();
    await user.click(within(rowOf(table, 57)).getByRole("button", { name: "Approve #57" }));
    const dialog = await screen.findByRole("dialog", { name: /Approve #57/ });
    preview(PREVIEW_SEED.pending).head_sha = PREVIEW_SEED.newerSha;
    await user.click(within(dialog).getByRole("button", { name: "Approve and build" }));
    expect(await screen.findByText("#57 has new commits")).toBeInTheDocument();
    expect(
      screen.getByText("Nothing was approved. Review the new head commit, then approve that one."),
    ).toBeInTheDocument();
    await waitFor(() => expect(rowOf(table, 57)).toHaveTextContent("c0ffee0"));
    expect(preview(PREVIEW_SEED.pending)).toMatchObject({
      status: "pending_approval",
      approved_sha: null,
    });
  });

  it("hides Approve from developers but lets them redeploy and tear down", async () => {
    signInAs(USERS.member.id);
    const { table, user } = await openPreviews();
    const pending = rowOf(table, 57);
    expect(within(pending).queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
    expect(within(pending).getByRole("button", { name: "Tear down #57" })).toBeInTheDocument();
    await user.click(within(rowOf(table, 42)).getByRole("button", { name: "Redeploy #42" }));
    expect(await screen.findByText("Redeploying #42")).toBeInTheDocument();
  });

  it("hides every action from viewers and shows the settings read-only", async () => {
    signInAs(USERS.viewer.id);
    const { table } = await openPreviews();
    expect(within(table).queryAllByRole("button")).toEqual([]);
    expect(await screen.findByRole("switch", { name: "Build previews" })).toBeDisabled();
    expect(screen.getByLabelText("Base environment")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("tears a preview down after confirming", async () => {
    addPreviewEnvironment(db.deploy);
    const { table, user } = await openPreviews();
    await user.click(within(rowOf(table, 42)).getByRole("button", { name: "Tear down #42" }));
    const dialog = await screen.findByRole("dialog", { name: "Tear down #42?" });
    expect(preview(PREVIEW_SEED.active).status).toBe("active");
    await user.click(within(dialog).getByRole("button", { name: "Tear down" }));
    expect(await screen.findByText("Tore down #42")).toBeInTheDocument();
    expect(preview(PREVIEW_SEED.active)).toMatchObject({ status: "closed", environment_id: null });
    expect(db.deploy.environments.some((row) => row.id === PREVIEW_SEED.environment)).toBe(false);
    await waitFor(() => expect(within(table).queryByText(/Faster checkout/)).toBeNull());
  });

  it("requires a build node selector for fork approval, then saves the settings", async () => {
    const { user } = await openPreviews();
    const form = await screen.findByRole("form", { name: "Preview settings" });
    expect(within(form).getByLabelText("Pull requests from forks")).toHaveValue("approval");
    expect(within(form).getByRole("note")).toHaveTextContent("Fork builds run untrusted code");

    await user.click(within(form).getByRole("button", { name: "Remove build node selector pool" }));
    const ttl = within(form).getByLabelText("Expire after");
    await user.clear(ttl);
    await user.type(ttl, "24");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(
      await within(form).findByText(
        "Add at least one label. Fork builds run only on builders that carry it.",
      ),
    ).toBeInTheDocument();
    expect(settings().build_node_selector).toEqual({ pool: "untrusted" });
    expect(settings().ttl_hours).toBe(72);

    const builders = within(form).getByRole("group", { name: "Build node selector" });
    await user.click(within(builders).getByRole("button", { name: "Add" }));
    await user.type(within(form).getByLabelText("Build node selector 1 key"), "builder");
    await user.type(within(form).getByLabelText("Build node selector 1 value"), "forks");
    await user.click(within(form).getByRole("switch", { name: "Comment on the pull request" }));
    await user.click(within(form).getByRole("radio", { name: "Only these" }));
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Preview settings saved")).toBeInTheDocument();
    expect(settings()).toMatchObject({
      enabled: true,
      base_environment_id: SEED.production,
      services: [SEED.web],
      ttl_hours: 24,
      max_active: 5,
      caps: { replicas: 1, cpu_millis: 1000, memory_mb: 1024, volume_mb: 1024 },
      fork_policy: "approval",
      build_node_selector: { builder: "forks" },
      approval_label: "roundhouse:preview",
      comment: false,
      same_repo_secrets: "copy",
    });
    expect(db.audit.at(-1)?.action).toBe("preview.settings_updated");
  });

  it("checks numbers against the limits before saving", async () => {
    const { user } = await openPreviews();
    const form = await screen.findByRole("form", { name: "Preview settings" });
    const active = within(form).getByLabelText("Active previews");
    await user.clear(active);
    await user.type(active, "500");
    await user.selectOptions(within(form).getByLabelText("Pull requests from forks"), "disabled");
    expect(within(form).queryByRole("note")).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await within(form).findByText("Between 1 and 50.")).toBeInTheDocument();
    expect(settings().max_active).toBe(5);
    expect(settings().fork_policy).toBe("approval");
  });

  it("asks for the Pull request event until GitHub has sent one", async () => {
    db.previews.pullRequestEventsSeen = false;
    renderApp(PREVIEWS);
    const note = await screen.findByText(/No pull request event has reached this instance yet/);
    expect(note).toHaveTextContent("must subscribe to the Pull request event");
  });
});

describe("inside a preview environment", () => {
  it("shows the preview banner on project pages and lists the environment", async () => {
    addPreviewEnvironment(db.deploy);
    const { user } = renderApp(`${PROJECT_PATH}?env=pr-42`);
    const banner = await screen.findByRole("region", { name: "Preview environment" });
    await waitFor(() => expect(banner).toHaveTextContent("Preview for #42 · head 4c1d2e3"));
    expect(banner).toHaveTextContent("expires in 2 days");
    expect(within(banner).getByRole("link", { name: "#42" })).toHaveAttribute(
      "href",
      "https://github.com/acme/storefront/pull/42",
    );
    await user.click(screen.getByRole("button", { name: /^Environment: pr-42/ }));
    expect(await screen.findByRole("menuitemradio", { name: /pr-42/ })).toBeInTheDocument();
  });

  it("shows no banner in production", async () => {
    addPreviewEnvironment(db.deploy);
    renderApp(PROJECT_PATH);
    await screen.findByRole("button", { name: /^Environment: production/ });
    expect(screen.queryByRole("region", { name: "Preview environment" })).toBeNull();
  });

  it("marks withheld variables", async () => {
    addPreviewEnvironment(db.deploy);
    renderApp(`${servicePath(SEED.web, "variables")}?env=pr-42`);
    const list = await screen.findByRole("list", { name: "Variables list" });
    const secret = (await within(list).findByText("SESSION_SECRET")).closest("li")!;
    expect(within(secret).getByText("Withheld from preview")).toBeInTheDocument();
    const plain = within(list).getByText("NODE_ENV").closest("li")!;
    expect(within(plain).queryByText("Withheld from preview")).toBeNull();
  });
});
