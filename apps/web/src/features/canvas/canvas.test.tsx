import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, signInAs, USERS } from "../../mocks/db";
import { PROJECT_PATH, SEED } from "../../test/phase1";
import { renderApp } from "../../test/render";

const STAGED_SECRET = "canvas-only-secret-Pq8Lm3Zx";

async function openCanvas(path = PROJECT_PATH) {
  const app = renderApp(path);
  const canvas = await screen.findByRole("group", { name: /Project canvas/ });
  await within(canvas).findByRole("button", { name: /^api / });
  return { ...app, canvas };
}

function latestApiConfig() {
  return db.deploy.configs
    .filter((c) => c.service_id === SEED.api && c.environment_id === SEED.production)
    .sort((a, b) => b.version - a.version)[0]!;
}

describe("project canvas", () => {
  it("draws every service as a labelled, focusable node with its status in words", async () => {
    const { canvas } = await openCanvas();
    const web = within(canvas).getByRole("button", { name: /^web / });
    await waitFor(() => expect(web).toHaveAccessibleName("web web Active, app service"));
    expect(within(canvas).getAllByRole("button").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole("list", { name: "Edge legend" })).toHaveTextContent("private network");
  });

  it("stages a config edit from the panel, reviews it and applies it with a deploy", async () => {
    const { canvas, user } = await openCanvas();
    const before = latestApiConfig().version;
    await user.click(within(canvas).getByRole("button", { name: /^api / }));
    const panel = await screen.findByRole("complementary", { name: "api" });
    const replicas = await within(panel).findByLabelText("Replicas");
    await waitFor(() => expect(replicas).toHaveValue("2"));
    await user.clear(replicas);
    await user.type(replicas, "3");
    await user.click(within(panel).getByRole("button", { name: "Stage" }));

    const bar = await screen.findByRole("region", { name: "Staged changes" });
    expect(bar).toHaveTextContent("1 change");
    expect(latestApiConfig().version).toBe(before);

    await user.click(within(bar).getByRole("button", { name: "Review" }));
    const review = await screen.findByRole("dialog", { name: "Review changes" });
    const row = within(review).getByRole("row", { name: /deploy\.replicas/ });
    expect(row).toHaveTextContent("2");
    expect(row).toHaveTextContent("3");
    expect(await within(review).findByText("config changed")).toBeInTheDocument();
    await user.click(within(review).getByRole("button", { name: "Apply and deploy" }));

    expect(await screen.findByText("Applied 1 change")).toBeInTheDocument();
    expect(latestApiConfig()).toMatchObject({ version: before + 1, deploy: { replicas: 3 } });
    expect(db.deploy.deployments.at(-1)).toMatchObject({
      service_id: SEED.api,
      trigger: "change_set",
    });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Staged changes" })).not.toBeInTheDocument(),
    );
  });

  it("stages a secret only with confirmation and never shows its value", async () => {
    const { canvas, user } = await openCanvas();
    await user.click(within(canvas).getByRole("button", { name: /^api / }));
    const panel = await screen.findByRole("complementary", { name: "api" });
    await user.type(within(panel).getByLabelText("Name"), "PAYMENTS_KEY");
    await user.type(within(panel).getByLabelText("Value"), STAGED_SECRET);
    await user.click(within(panel).getByLabelText("Secret (write-only)"));
    await user.click(within(panel).getByRole("button", { name: "Stage" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("can never be read back");
    await user.click(within(panel).getByLabelText(/Nobody can read this value back/));
    await user.click(within(panel).getByRole("button", { name: "Stage" }));

    const bar = await screen.findByRole("region", { name: "Staged changes" });
    await user.click(within(bar).getByRole("button", { name: "Review" }));
    const review = await screen.findByRole("dialog", { name: "Review changes" });
    const row = within(review).getByRole("row", { name: /PAYMENTS_KEY/ });
    expect(row).toHaveTextContent(/secret · [0-9a-f]{8}/);
    expect(document.body.innerHTML).not.toContain(STAGED_SECRET);
  });

  it("moves a node with the arrow keys and saves the layout", async () => {
    const { canvas, user } = await openCanvas();
    within(canvas)
      .getByRole("button", { name: /^worker / })
      .focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    await waitFor(() => expect(db.changes.layouts[SEED.project]?.version).toBe(1), {
      timeout: 2000,
    });
    expect(db.changes.layouts[SEED.project]?.positions[SEED.worker]).toBeDefined();
    expect(await screen.findByText(/^Moved worker$/)).toBeInTheDocument();
  });

  it("refuses to apply a conflicted change until it is resolved", async () => {
    const { canvas, user } = await openCanvas();
    await user.click(within(canvas).getByRole("button", { name: /^api / }));
    const panel = await screen.findByRole("complementary", { name: "api" });
    const replicas = await within(panel).findByLabelText("Replicas");
    await waitFor(() => expect(replicas).toHaveValue("2"));
    await user.clear(replicas);
    await user.type(replicas, "4");
    await user.click(within(panel).getByRole("button", { name: "Stage" }));
    const latest = latestApiConfig();
    db.deploy.configs.push({
      ...latest,
      id: "cfg_direct",
      version: latest.version + 1,
      deploy: { ...latest.deploy, replicas: 6 },
    });

    const bar = await screen.findByRole("region", { name: "Staged changes" });
    await user.click(within(bar).getByRole("button", { name: "Review" }));
    const review = await screen.findByRole("dialog", { name: "Review changes" });
    await user.click(within(review).getByRole("button", { name: "Apply and deploy" }));
    expect(await within(review).findByRole("alert")).toHaveTextContent(/conflict/);
    await user.click(await within(review).findByRole("button", { name: "Keep mine" }));
    await waitFor(() =>
      expect(within(review).queryByRole("button", { name: "Keep mine" })).not.toBeInTheDocument(),
    );
    await user.click(within(review).getByRole("button", { name: "Apply without deploying" }));
    expect(await screen.findByText("Applied 1 change")).toBeInTheDocument();
    expect(latestApiConfig().deploy.replicas).toBe(4);
  });

  it("discards the draft after confirmation", async () => {
    const { canvas, user } = await openCanvas();
    await user.click(within(canvas).getByRole("button", { name: /^web / }));
    const panel = await screen.findByRole("complementary", { name: "web" });
    await user.click(within(panel).getByRole("button", { name: "Stage deletion" }));
    const bar = await screen.findByRole("region", { name: "Staged changes" });
    await waitFor(() =>
      expect(
        within(canvas).getByRole("button", { name: /^web .*, staged for deletion$/ }),
      ).toBeInTheDocument(),
    );
    await user.click(within(bar).getByRole("button", { name: "Discard" }));
    const dialog = await screen.findByRole("dialog", { name: "Discard staged changes?" });
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Staged changes" })).not.toBeInTheDocument(),
    );
    expect(db.changes.sets[0]?.status).toBe("discarded");
    expect(db.deploy.services.find((s) => s.id === SEED.web)?.deleted).toBeFalsy();
  });

  it("opens a change set an agent proposed from its review link", async () => {
    db.changes.sets.push({
      id: "chs_agent",
      project_id: SEED.project,
      environment_id: SEED.production,
      status: "open",
      is_draft: false,
      source: "mcp",
      title: "Proposed by agent",
      revision: 2,
      created_by: USERS.owner.id,
      created_by_token: "tok_agent",
      applied_by: null,
      applied_at: null,
      error: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      changes: [
        {
          id: "stg_agent",
          seq: 1,
          target_key: `var:${SEED.api}:LOG_LEVEL`,
          op: {
            type: "variable.set",
            scope: "service",
            service: SEED.api,
            key: "LOG_LEVEL",
            confirm_write_only: false,
            acknowledge_public: false,
            fingerprint: "0badc0de",
            staged_tier: "plain",
          },
          summary: "set api.LOG_LEVEL",
          diff: [
            {
              path: "/variables/LOG_LEVEL",
              before: null,
              after: { tier: "plain", fingerprint: "0badc0de" },
            },
          ],
          status: "pending",
          conflict: null,
          created_by: USERS.owner.id,
          created_at: Date.now(),
          updated_at: Date.now(),
          value: "debug",
          base_version: null,
        },
      ],
    });
    renderApp(`${PROJECT_PATH}?review=chs_agent`);
    const review = await screen.findByRole("dialog", { name: "Review changes" });
    expect(within(review).getByText("set api.LOG_LEVEL")).toBeInTheDocument();
    expect(within(review).getByRole("row", { name: /LOG_LEVEL/ })).toHaveTextContent(
      "plain · 0badc0de",
    );
  });

  it("lets viewers look but not edit", async () => {
    signInAs(USERS.viewer.id);
    const { canvas, user } = await openCanvas();
    await user.click(within(canvas).getByRole("button", { name: /^api / }));
    const panel = await screen.findByRole("complementary", { name: "api" });
    expect(await within(panel).findByLabelText("Replicas")).toBeDisabled();
    expect(within(panel).queryByRole("button", { name: "Stage deletion" })).not.toBeInTheDocument();
  });
});
