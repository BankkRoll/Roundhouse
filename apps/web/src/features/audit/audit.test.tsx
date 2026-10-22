import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, makeAuditEntry, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { renderApp } from "../../test/render";

const AUDIT = `/w/${WORKSPACE_ID}/audit`;

function seedEntries(count: number) {
  const now = Date.now();
  db.audit = Array.from({ length: count }, (_, i) => ({
    ...makeAuditEntry({
      // Audit ids are ULIDs, so the newest entry has the highest id.
      id: `aud_${String(999 - i).padStart(3, "0")}`,
      action: `test.event_${i}`,
      created_at: now - i * 60_000,
    }),
    workspace_id: WORKSPACE_ID,
  }));
}

function bodyRows() {
  const [, body] = screen.getAllByRole("rowgroup");
  return within(body as HTMLElement).getAllByRole("row");
}

describe("audit log", () => {
  it("renders entries newest first in a log-style table", async () => {
    renderApp(AUDIT);
    expect(await screen.findByText("node.joined")).toBeInTheDocument();
    const rows = bodyRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("node.joined");
    expect(rows[0]).toHaveTextContent("hel-1node");
    expect(rows[0]).toHaveTextContent("node/node_hel1");
    expect(rows[1]).toHaveTextContent("Ada Lovelaceuser");
    expect(rows[0]).toHaveTextContent("198.51.100.7");
    expect(rows[2]).toHaveTextContent("workspace.created");
    expect(screen.getByText("End of audit log")).toBeInTheDocument();
  });

  it("pages through older entries with the cursor", async () => {
    seedEntries(120);
    const { user } = renderApp(AUDIT);
    await screen.findByText("test.event_0");
    expect(bodyRows()).toHaveLength(50);

    await user.click(screen.getByRole("button", { name: "Load older entries" }));
    await screen.findByText("test.event_99");
    expect(bodyRows()).toHaveLength(100);

    await user.click(screen.getByRole("button", { name: "Load older entries" }));
    await screen.findByText("test.event_119");
    expect(bodyRows()).toHaveLength(120);
    expect(screen.queryByRole("button", { name: "Load older entries" })).not.toBeInTheDocument();
    expect(screen.getByText("End of audit log")).toBeInTheDocument();
  });

  it("renders placeholders for missing actor, target and IP", async () => {
    db.audit = [
      {
        ...makeAuditEntry({
          actor_type: "system",
          actor_id: null,
          actor_name: null,
          target_type: null,
          target_id: null,
          ip: null,
        }),
        workspace_id: WORKSPACE_ID,
      },
    ];
    renderApp(AUDIT);
    await screen.findByText("node.joined");
    const [row] = bodyRows();
    expect(row).toHaveTextContent("system");
    expect(within(row as HTMLElement).getAllByText("—")).toHaveLength(2);
  });

  it("orders entries by id, as the API does, not by timestamp", async () => {
    const now = Date.now();
    db.audit = [
      { ...makeAuditEntry({ id: "aud_002", action: "test.second", created_at: now - 60_000 }) },
      { ...makeAuditEntry({ id: "aud_001", action: "test.first", created_at: now }) },
    ].map((entry) => ({ ...entry, workspace_id: WORKSPACE_ID }));
    renderApp(AUDIT);
    await screen.findByText("test.second");
    const rows = bodyRows();
    expect(rows[0]).toHaveTextContent("test.second");
    expect(rows[1]).toHaveTextContent("test.first");
  });

  it("records actions taken in the dashboard", async () => {
    const { user } = renderApp(`/w/${WORKSPACE_ID}/settings`);
    const input = await screen.findByLabelText("Name");
    await user.clear(input);
    await user.type(input, "Acme Robotics");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Workspace renamed");
    await user.click(screen.getByRole("link", { name: "Audit log" }));
    const [newest] = await waitFor(() => {
      const rows = bodyRows();
      expect(rows[0]).toHaveTextContent("workspace.renamed");
      return rows;
    });
    expect(newest).toHaveTextContent("Ada Lovelace");
  });

  it("shows an empty state", async () => {
    db.audit = [];
    renderApp(AUDIT);
    expect(await screen.findByRole("heading", { name: "No activity yet" })).toBeInTheDocument();
  });

  it("is limited to roles with audit:read", async () => {
    signInAs(USERS.member.id);
    renderApp(AUDIT);
    expect(
      await screen.findByRole("heading", { name: "The audit log is limited to admins" }),
    ).toBeInTheDocument();
  });
});
