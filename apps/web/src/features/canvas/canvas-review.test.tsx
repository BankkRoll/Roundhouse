import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { requireApprovalIn } from "../../mocks/changes-handlers";
import { db, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { broadcastRealtime } from "../../mocks/deploy-handlers";
import { PROJECT_PATH, SEED } from "../../test/phase1";
import { renderApp } from "../../test/render";

async function openCanvas(path = PROJECT_PATH) {
  const app = renderApp(path);
  const canvas = await screen.findByRole("group", { name: /Project canvas/ });
  await within(canvas).findByRole("button", { name: /^api / });
  return { ...app, canvas };
}

/** Stages `api` replicas → 3 from the panel, as whoever is signed in. */
async function stageReplicas(app: Awaited<ReturnType<typeof openCanvas>>) {
  const { canvas, user } = app;
  await user.click(within(canvas).getByRole("button", { name: /^api / }));
  const panel = await screen.findByRole("complementary", { name: "api" });
  const replicas = await within(panel).findByLabelText("Replicas");
  await waitFor(() => expect(replicas).toHaveValue("2"));
  await user.clear(replicas);
  await user.type(replicas, "3");
  await user.click(within(panel).getByRole("button", { name: "Stage" }));
  return screen.findByRole("region", { name: "Staged changes" });
}

async function openReview(app: Awaited<ReturnType<typeof openCanvas>>) {
  const bar = await screen.findByRole("region", { name: "Staged changes" });
  await app.user.click(within(bar).getByRole("button", { name: "Review" }));
  return screen.findByRole("dialog", { name: "Review changes" });
}

describe("change set review", () => {
  it("holds a protected environment's draft until someone else approves it", async () => {
    requireApprovalIn(SEED.production);
    signInAs(USERS.member.id);
    const member = await openCanvas();
    const bar = await stageReplicas(member);
    expect(within(bar).getByText("needs approval")).toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: "Deploy" })).not.toBeInTheDocument();

    let review = await openReview(member);
    expect(await within(review).findByText("Needs an approval first")).toBeInTheDocument();
    expect(within(review).getByRole("button", { name: "Apply and deploy" })).toBeDisabled();
    await member.user.type(within(review).getByLabelText("Note (optional)"), "Busy week ahead");
    await member.user.click(within(review).getByRole("button", { name: "Ask for review" }));
    expect(await within(review).findByText("in review")).toBeInTheDocument();
    expect(within(review).getByText("Busy week ahead")).toBeInTheDocument();
    expect(db.changes.sets[0]?.review_status).toBe("submitted");
    cleanup();

    signInAs(USERS.admin.id);
    const admin = await openCanvas();
    review = await openReview(admin);
    const approve = await within(review).findByRole("button", { name: /^Approve revision/ });
    await admin.user.click(approve);
    expect(await within(review).findByText(/^Approved by you/)).toBeInTheDocument();
    expect(
      await within(review).findByText("You approved this, so someone else applies it"),
    ).toBeInTheDocument();
    expect(within(review).getByRole("button", { name: "Apply and deploy" })).toBeDisabled();
    cleanup();

    signInAs(USERS.owner.id);
    const owner = await openCanvas();
    review = await openReview(owner);
    const apply = await within(review).findByRole("button", { name: "Apply and deploy" });
    await waitFor(() => expect(apply).toBeEnabled());
    await owner.user.click(apply);
    expect(await screen.findByText("Applied 1 change")).toBeInTheDocument();
  });

  it("never offers the author a review of their own changes", async () => {
    const app = await openCanvas();
    await stageReplicas(app);
    const review = await openReview(app);
    expect(await within(review).findByText(/someone else reviews it/)).toBeInTheDocument();
    expect(within(review).queryByRole("button", { name: /^Approve/ })).not.toBeInTheDocument();
  });

  it("lets a reviewer reject a draft, which then can't apply until it changes", async () => {
    signInAs(USERS.member.id);
    const member = await openCanvas();
    await stageReplicas(member);
    cleanup();

    signInAs(USERS.admin.id);
    const admin = await openCanvas();
    const review = await openReview(admin);
    await admin.user.type(
      await within(review).findByLabelText("Note (optional)"),
      "Scale staging first",
    );
    await admin.user.click(within(review).getByRole("button", { name: "Reject" }));
    expect(await within(review).findByText("rejected")).toBeInTheDocument();
    expect(within(review).getByText("Scale staging first")).toBeInTheDocument();
    expect(
      within(review).getByText("Rejected: change it or ask for another review"),
    ).toBeInTheDocument();
    expect(db.changes.sets[0]?.review_status).toBe("rejected");
  });
});

describe("canvas resources", () => {
  it("connects two services with a drawn edge and disconnects them", async () => {
    const { canvas, user } = await openCanvas();
    await user.click(within(canvas).getByRole("button", { name: /^api / }));
    const panel = await screen.findByRole("complementary", { name: "api" });
    await user.selectOptions(within(panel).getByLabelText("Connect api to"), "worker");
    await user.click(within(panel).getByRole("button", { name: "Connect" }));
    const disconnect = await within(panel).findByRole("button", {
      name: "Disconnect api from worker",
    });
    expect(db.changes.edges).toEqual([
      expect.objectContaining({ from_service_id: SEED.api, to_service_id: SEED.worker }),
    ]);
    await user.click(disconnect);
    await waitFor(() => expect(db.changes.edges).toEqual([]));
  });

  it("stages a new volume and a custom domain for review", async () => {
    const { canvas, user } = await openCanvas();
    await user.click(within(canvas).getByRole("button", { name: /^worker / }));
    const panel = await screen.findByRole("complementary", { name: "worker" });
    const size = within(panel).getByLabelText("Size (MiB)");
    await user.clear(size);
    await user.type(size, "2048");
    await user.click(within(panel).getByRole("button", { name: "Add volume" }));
    await user.type(within(panel).getByLabelText("Add a domain"), "jobs.example.com");
    await user.click(within(panel).getByRole("button", { name: "Add" }));

    const bar = await screen.findByRole("region", { name: "Staged changes" });
    await waitFor(() => expect(bar).toHaveTextContent("2 changes"));
    const review = await openReview({ canvas, user } as Awaited<ReturnType<typeof openCanvas>>);
    expect(within(review).getByText("set worker volume to 2048 MiB")).toBeInTheDocument();
    expect(within(review).getByText("add domain jobs.example.com to worker")).toBeInTheDocument();
  });

  it("checks a volume size before staging anything", async () => {
    const { canvas, user } = await openCanvas();
    await user.click(within(canvas).getByRole("button", { name: /^worker / }));
    const panel = await screen.findByRole("complementary", { name: "worker" });
    const size = within(panel).getByLabelText("Size (MiB)");
    await user.clear(size);
    await user.type(size, "12");
    await user.click(within(panel).getByRole("button", { name: "Add volume" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent(/whole number of MiB/);
    expect(screen.queryByRole("region", { name: "Staged changes" })).not.toBeInTheDocument();
  });
});

describe("workspace canvas page", () => {
  it("lists open change sets across projects and links to their review", async () => {
    signInAs(USERS.member.id);
    const app = await openCanvas();
    await stageReplicas(app);
    cleanup();

    signInAs(USERS.owner.id);
    const { user } = renderApp(`/w/${WORKSPACE_ID}/canvas`);
    const list = await screen.findByRole("region", { name: /Staged changes/ });
    const link = await within(list).findByRole("link", { name: /Draft/ });
    expect(link).toHaveTextContent("1 change");
    await user.click(within(list).getByRole("radio", { name: "Waiting for review" }));
    expect(await within(list).findByText("Nothing waits for review")).toBeInTheDocument();
  });
});

describe("staging setting", () => {
  it("turns staged canvas edits off for the workspace", async () => {
    const { user } = renderApp(`/w/${WORKSPACE_ID}/settings`);
    const toggle = await screen.findByRole("switch", { name: "Stage canvas edits" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(await screen.findByText("Canvas edits now apply as saved")).toBeInTheDocument();
    expect(db.workspaces.find((w) => w.id === WORKSPACE_ID)?.staged_changes).toBe(false);
  });
});

describe("presence on the canvas", () => {
  it("outlines what others select and says who is editing what", async () => {
    const { canvas } = await openCanvas();
    broadcastRealtime(SEED.project, {
      type: "presence",
      users: [
        {
          user_id: USERS.admin.id,
          name: USERS.admin.name,
          image: null,
          color: 4,
          environment_id: SEED.production,
          selection: [SEED.api],
          editing: { service_id: SEED.api, part: "variables" },
        },
        {
          user_id: USERS.member.id,
          name: USERS.member.name,
          image: null,
          color: 2,
          environment_id: "env_elsewhere",
          selection: [SEED.web],
          editing: null,
        },
      ],
    });
    await waitFor(() =>
      expect(within(canvas).getByRole("button", { name: /^api / })).toHaveAccessibleName(
        /Bob is editing variables$/,
      ),
    );
    expect(within(canvas).getByRole("button", { name: /^web / })).not.toHaveAccessibleName(/Cara/);
  });
});
