/**
 * The Phase 0 acceptance path, driven through a real browser against a real
 * control plane and a real Go agent:
 * fresh install → setup wizard → dashboard → add server → agent connects →
 * live usage shows → invite a teammate → they sign up and land with their role.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { E2E_MASTER_KEY } from "../constants.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SHOTS = join(import.meta.dirname, "..", "screenshots");
const isWindows = process.platform === "win32";

const OWNER = { name: "Mara Okafor", email: "mara@example.com", password: "correct horse battery" };

let agent: ChildProcess | undefined;
let agentDir: string;
let agentBin: string;

test.beforeAll(() => {
  agentDir = mkdtempSync(join(tmpdir(), "openrail-e2e-agent-"));
  agentBin = join(agentDir, isWindows ? "openrail-agent.exe" : "openrail-agent");
  const build = spawnSync("go", ["build", "-o", agentBin, "./agent/cmd/openrail-agent"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  expect(build.status).toBe(0);
});

test.afterAll(() => {
  if (agent && agent.exitCode === null) {
    if (isWindows) spawnSync("taskkill", ["/pid", String(agent.pid), "/T", "/F"]);
    else agent.kill("SIGKILL");
  }
  rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

test.describe
  .serial("first run", () => {
    let workspacePath = "";

    test("the root URL goes to the setup wizard on a fresh install", async ({ page }) => {
      await page.goto("/");
      await expect(page).toHaveURL(/\/setup/);
    });

    test("a fresh install sends dashboard visitors to the setup wizard", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page).toHaveURL(/\/setup/);
      await shot(page, "01-setup-master-key");
    });

    test("setup rejects the wrong master key, then completes with the right one", async ({
      page,
    }) => {
      await page.goto("/setup");
      // MASTER_KEY is already set on this instance, so the wizard skips the key step.
      await expect(page.getByRole("heading", { name: /create the admin account/i })).toBeVisible();

      await page.getByLabel("Master key").fill("d3JvbmctbWFzdGVyLWtleS1kZWZpbml0ZWx5LW5vdC1pdA==");
      await page.getByLabel("Your name").fill(OWNER.name);
      await page.getByLabel("Email").fill(OWNER.email);
      await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
      await page.getByLabel("Confirm password").fill(OWNER.password);
      await page.getByLabel("Workspace name").fill("Nightjar Labs");
      await shot(page, "02-setup-account");
      await page.getByRole("button", { name: "Create admin account" }).click();
      await expect(page.getByText(/master key/i).last()).toBeVisible();
      await shot(page, "03-setup-wrong-key");

      await page.getByLabel("Master key").fill(E2E_MASTER_KEY);
      await page.getByRole("button", { name: "Create admin account" }).click();
      await expect(page.getByText(/add your first server|add a server/i).first()).toBeVisible();
      await shot(page, "04-setup-add-server");
    });

    test("lands on Home with the workspace shell", async ({ page }) => {
      await signIn(page);
      await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
      workspacePath = new URL(page.url()).pathname.match(/^\/w\/[^/]+/)![0];
      await shot(page, "05-home-empty");
    });

    test("adding a server shows a live install command that flips to connected", async ({
      page,
    }) => {
      await signIn(page);
      await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
      await page.keyboard.press("g");
      await page.keyboard.press("s");
      await expect(page.getByRole("heading", { name: "Servers", level: 1 })).toBeVisible();
      await shot(page, "06-servers-empty");

      await page
        .getByRole("button", { name: /add server/i })
        .first()
        .click();
      const command = await page.getByText(/curl -fsSL .*install\.sh/).textContent();
      const token = command?.match(/--token (\S+)/)?.[1];
      expect(token).toMatch(/^njt_/);
      await shot(page, "07-add-server-dialog");

      const config = join(agentDir, "agent.yaml");
      const join_ = spawnSync(agentBin, [
        "join",
        "--url",
        new URL(page.url()).origin,
        "--token",
        token!,
        "--name",
        "hel-1",
        "--config",
        config,
      ]);
      expect(join_.status, join_.stderr.toString()).toBe(0);
      agent = spawn(agentBin, ["run", "--config", config]);

      await expect(page.getByText(/hel-1.*connected|connected/i).first()).toBeVisible({
        timeout: 30_000,
      });
      await shot(page, "08-add-server-connected");
      await page.keyboard.press("Escape");

      await expect(page.getByText("hel-1").first()).toBeVisible();
      await expect(page.getByText(/online/i).first()).toBeVisible();
      await expect(page.getByRole("meter").first()).toBeVisible({ timeout: 20_000 });
      await shot(page, "09-servers-online");
    });

    test("Home reflects the fleet and the activity feed", async ({ page }) => {
      await signIn(page);
      await expect(page.getByText(/1 online/i)).toBeVisible();
      await expect(page.getByText(/hel-1 connected/i).first()).toBeVisible();
      await shot(page, "10-home-fleet");
    });

    test("the command palette navigates", async ({ page }) => {
      await signIn(page);
      await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
      await page.keyboard.press(isWindows ? "Control+k" : "Meta+k");
      await expect(page.getByRole("dialog")).toBeVisible();
      await shot(page, "11-command-palette");
      await page.keyboard.type("audit");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/audit/);
      await expect(page.getByRole("cell", { name: "node.joined" }).first()).toBeVisible();
      await shot(page, "12-audit");
    });

    test("an invited teammate signs up and gets exactly their role", async ({ page, browser }) => {
      await signIn(page);
      await page.goto(`${workspacePath}/members`);
      await page
        .getByRole("button", { name: /invite/i })
        .first()
        .click();
      await page.getByLabel(/email/i).fill("priya@example.com");
      await page
        .getByRole("button", { name: /send|create|invite/i })
        .last()
        .click();
      const url = await page
        .getByText(/\/invite\//)
        .first()
        .textContent();
      expect(url).toContain("/invite/inv_");
      await shot(page, "13-invite-created");

      const other = await browser.newContext();
      const invitee = await other.newPage();
      await invitee.goto(url!.trim());
      await expect(invitee.getByText(/Nightjar Labs/)).toBeVisible();
      await shot(invitee, "14-invite-accept");
      await invitee.getByLabel(/name/i).first().fill("Priya Nair");
      await invitee
        .getByLabel(/^password/i)
        .first()
        .fill("another long password");
      const confirm = invitee.getByLabel(/confirm/i);
      if (await confirm.count()) await confirm.fill("another long password");
      await invitee.getByRole("button", { name: /accept|join|create/i }).click();
      await expect(invitee.getByRole("heading", { name: "Home" })).toBeVisible();

      await invitee.goto(`${workspacePath}/servers`);
      await expect(invitee.getByRole("button", { name: /add server/i })).toHaveCount(0);
      await shot(invitee, "15-viewer-servers");
      await other.close();
    });
  });

async function signIn(page: Page) {
  await page.goto("/login");
  if (!page.url().includes("/login")) return;
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
