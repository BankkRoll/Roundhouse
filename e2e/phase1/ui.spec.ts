/**
 * The Phase 1 flow through the real dashboard, on the stack `api.test.mjs`
 * left behind (owner account, project, joined builder node):
 * create an image service → it deploys → its runtime logs show →
 * redeploy → roll back to the first deployment.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const ARTIFACTS = join(import.meta.dirname, ".artifacts");
const session = JSON.parse(readFileSync(join(ARTIFACTS, "session.json"), "utf8")) as {
  email: string;
  password: string;
  workspaceId: string;
};
const { projectId } = JSON.parse(readFileSync(join(ARTIFACTS, "ui.json"), "utf8")) as {
  projectId: string;
};

// Unique per run, so the spec can run again against a kept stack.
const SERVICE = `ui-whoami-${Date.now().toString(36)}`;

const WHOAMI =
  "traefik/whoami:v1.11.0@sha256:200689790a0a0ea48ca45992e0450bc26ccab5307375b41c84dfc4f2475937ab";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(session.email);
  await page.getByLabel("Password").fill(session.password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Deployment rows' status links, newest first. */
function deploymentLinks(page: Page) {
  return page
    .getByRole("region", { name: "Deployments" })
    .getByRole("link", { name: /^Deployment / });
}

test("create a service, deploy, read its logs, redeploy and roll back", async ({ page }) => {
  await signIn(page);
  await page.goto(`/w/${session.workspaceId}/p/${projectId}`);

  await page.getByRole("button", { name: "New service" }).click();
  const dialog = page.getByRole("dialog", { name: "New service" });
  await dialog.getByRole("textbox", { name: "Image" }).fill(WHOAMI);
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("textbox", { name: "Service name" }).fill(SERVICE);
  await dialog.getByRole("textbox", { name: "Port" }).fill("80");
  await dialog.getByRole("button", { name: "Create and deploy" }).click();

  await expect(page).toHaveURL(/\/s\/svc_[^/]+\/deployments/);
  await expect(page.getByRole("heading", { name: SERVICE, level: 1 })).toBeVisible();
  const rows = deploymentLinks(page);
  await expect(rows.first()).toHaveAccessibleName(/, active$/, { timeout: 3 * 60_000 });
  await expect(rows).toHaveCount(1);

  await page
    .getByRole("navigation", { name: "Service" })
    .getByRole("link", { name: "Logs" })
    .click();
  await expect(page.getByLabel(/^Runtime logs of /)).toContainText("Starting up on port 80", {
    timeout: 60_000,
  });

  await page
    .getByRole("navigation", { name: "Service" })
    .getByRole("link", { name: "Deployments" })
    .click();
  await page.getByRole("button", { name: "Deploy", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAccessibleName(/, active$/, { timeout: 3 * 60_000 });
  await expect(rows.nth(1)).toHaveAccessibleName(/, removed$/, { timeout: 60_000 });

  // Both deployments run the same image, so pick the older row by its status.
  await page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: /, removed$/ }) })
    .getByRole("button", { name: /^Actions for deployment / })
    .click();
  await page.getByRole("menuitem", { name: "Roll back to this" }).click();
  await page.getByRole("button", { name: "Roll back", exact: true }).click();

  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAccessibleName(/, active$/, { timeout: 3 * 60_000 });
  await expect(rows.nth(1)).toHaveAccessibleName(/, rolled back$/, { timeout: 60_000 });
  await expect(
    page
      .getByRole("row")
      .filter({ has: page.getByRole("link", { name: /, active$/ }) })
      .getByRole("cell", { name: "rollback" }),
  ).toBeVisible();
});
