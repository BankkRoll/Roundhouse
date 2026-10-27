import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, WORKSPACE_ID } from "../../mocks/db";
import { renderApp } from "../../test/render";

const PLATFORM = `/w/${WORKSPACE_ID}/platform`;

describe("platform → registry storage", () => {
  it("saves a bucket with write-only secrets, then goes back to the builder's disk", async () => {
    const { user } = renderApp(PLATFORM);
    const form = await screen.findByRole("form", { name: "Registry storage" });
    expect(within(form).getByText("Builder disk")).toBeInTheDocument();
    await user.type(within(form).getByLabelText("Endpoint"), "https://s3.example.com");
    await user.type(within(form).getByLabelText("Bucket"), "acme-registry");
    await user.type(within(form).getByLabelText("Read-write access key ID"), "AKIARW");
    await user.type(within(form).getByLabelText("Read-write secret"), "rw-secret");
    await user.type(within(form).getByLabelText("Read-only access key ID"), "AKIARO");
    await user.type(within(form).getByLabelText("Read-only secret"), "ro-secret");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Registry storage saved")).toBeInTheDocument();
    expect(db.mesh.registry).toMatchObject({
      bucket: "acme-registry",
      readonly_secret_access_key: "ro-secret",
    });
    expect(within(form).getByLabelText("Read-write secret")).toHaveValue("");

    await user.click(within(form).getByRole("button", { name: "Use builder disk" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Use builder disk" }));
    expect(await screen.findByText("Builds stay on the builder's disk")).toBeInTheDocument();
    expect(db.mesh.registry).toBeNull();
  });

  it("asks for both secrets the first time", async () => {
    const { user } = renderApp(PLATFORM);
    const form = await screen.findByRole("form", { name: "Registry storage" });
    await user.type(within(form).getByLabelText("Endpoint"), "https://s3.example.com");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await within(form).findByText("Enter the read-write secret.")).toBeInTheDocument();
    expect(within(form).getByText("Enter the read-only secret.")).toBeInTheDocument();
  });
});
