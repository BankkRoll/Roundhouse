/**
 * The Phase 0 acceptance path, driven through a real browser against a real
 * control plane and a real Go agent:
 * fresh install → setup wizard → dashboard → add server → agent connects →
 * live usage shows → invite a teammate → they sign up and land with their role.
 *
 * Along the way every main page (login, setup, home, servers, a project, a
 * service's deployments, settings) is audited with axe in both themes, and the
 * run fails on any WCAG 2.1 A/AA violation.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { type Cookie, expect, type Page, test } from "@playwright/test";
import { E2E_MASTER_KEY } from "../constants.mjs";
import { secretFromUri, TotpSource } from "../two-factor.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SHOTS = join(import.meta.dirname, "..", "screenshots");
const isWindows = process.platform === "win32";

const OWNER = { name: "Mara Okafor", email: "mara@example.com", password: "correct horse battery" };

/** The admin's authenticator and backup codes, set when setup enrolls them. */
let codes: TotpSource | undefined;
let backupCodes: string[] = [];
/** The admin's session cookies, from the first sign-in through the form. */
let session: Cookie[] = [];

let agent: ChildProcess | undefined;
let agentDir: string;
let agentBin: string;

test.beforeAll(() => {
  agentDir = mkdtempSync(join(tmpdir(), "roundhouse-e2e-agent-"));
  agentBin = join(agentDir, isWindows ? "roundhouse-agent.exe" : "roundhouse-agent");
  const build = spawnSync("go", ["build", "-o", agentBin, "./agent/cmd/roundhouse-agent"], {
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

/**
 * Runs axe against the page as it is now, in the dark and light themes, and fails
 * with a readable list of WCAG 2.1 A/AA violations. While a modal dialog is open only
 * the dialog is audited: the page behind it is inert and dimmed by the backdrop, so its
 * contrast there is not what anyone reads.
 */
async function audit(page: Page, name: string) {
  const found: string[] = [];
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme });
    // NOTE: Theme colors transition; let them settle so contrast is measured on the end state.
    await page.waitForTimeout(250);
    const builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
    if (await page.locator("[role=dialog]").count()) {
      builder.include("[role=dialog]");
    }
    const results = await builder.analyze();
    for (const violation of results.violations) {
      const targets = violation.nodes.map((node) => node.target.join(" ")).join(", ");
      found.push(
        `[${colorScheme}] ${violation.id} (${violation.impact}): ${violation.help} → ${targets}`,
      );
    }
  }
  await page.emulateMedia({ colorScheme: "dark" });
  expect(found, `axe violations on ${name}`).toEqual([]);
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
      await audit(page, "setup");
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

      await expect(
        page.getByRole("heading", { name: "Turn on two-factor authentication" }),
      ).toBeVisible();
      await audit(page, "setup: two-factor");
      await page.getByRole("button", { name: "Set up two-factor" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Password").fill(OWNER.password);
      await dialog.getByRole("button", { name: "Continue" }).click();
      await expect(
        dialog.getByRole("img", { name: "QR code for your authenticator app" }),
      ).toBeVisible();
      await shot(page, "04a-setup-two-factor-qr");
      await audit(page, "setup: scan the QR code");
      const key = (await dialog.locator("p.select-all").textContent()) ?? "";
      codes = new TotpSource(secretFromUri(`otpauth://totp/x?secret=${key.replace(/\s+/g, "")}`));
      await dialog.getByLabel("Code from the app").fill(await codes.next());
      await dialog.getByRole("button", { name: "Turn on" }).click();
      const list = dialog.getByRole("list", { name: "Backup codes" });
      await expect(list).toBeVisible();
      backupCodes = (await list.getByRole("listitem").allTextContents()).map((c) => c.trim());
      expect(backupCodes).toHaveLength(10);
      await shot(page, "04b-setup-backup-codes");
      await audit(page, "setup: backup codes");
      await dialog.getByLabel("I've saved these codes somewhere safe").check();
      await dialog.getByRole("button", { name: "Done" }).click();

      await expect(page.getByText(/add your first server|add a server/i).first()).toBeVisible();
      await expect(page.getByRole("tab", { name: "Linux server" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await shot(page, "04-setup-add-server");
      await audit(page, "setup: first server");
    });

    test("lands on Home with the workspace shell", async ({ page }) => {
      await signIn(page);
      await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
      workspacePath = new URL(page.url()).pathname.match(/^\/w\/[^/]+/)![0];
      await shot(page, "05-home-empty");
      await audit(page, "home");
    });

    test("the sign-in page is accessible", async ({ browser }) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto("/login");
      await expect(page.getByRole("button", { name: /sign in|log in/i })).toBeVisible();
      await audit(page, "login");
      await context.close();
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
      await audit(page, "servers");

      await page
        .getByRole("button", { name: /add server/i })
        .first()
        .click();
      const command = await page.getByText(/curl -fsSL .*install\.sh/).textContent();
      const token = command?.match(/--token (\S+)/)?.[1];
      expect(token).toMatch(/^njt_/);
      await shot(page, "07-add-server-dialog");
      await audit(page, "add server: Linux");

      const dialog = page.getByRole("dialog", { name: "Add a server" });
      await dialog.getByRole("checkbox", { name: "Builder node" }).check();
      await expect(dialog.getByText(`--token ${token} --builder`)).toBeVisible();
      await dialog.getByRole("checkbox", { name: "Builder node" }).uncheck();
      await dialog.getByRole("tab", { name: "Cloud-init" }).click();
      await expect(dialog.getByText("Cloud servers can't use this address")).toBeVisible();
      await shot(page, "07b-add-server-cloud-init");
      await audit(page, "add server: cloud-init");
      await dialog.getByRole("tab", { name: "This computer" }).click();
      await expect(dialog.getByText(`pnpm dev:node ${token}`)).toBeVisible();
      await shot(page, "07c-add-server-this-computer");
      await audit(page, "add server: this computer");
      await dialog.getByRole("tab", { name: "This computer" }).press("ArrowLeft");
      await expect(dialog.getByRole("tab", { name: "Cloud-init" })).toBeFocused();
      await dialog.getByRole("tab", { name: "Cloud-init" }).press("ArrowLeft");
      const cloud = dialog.getByRole("tab", { name: "Cloud provider" });
      await expect(cloud).toBeFocused();
      await expect(cloud).toHaveAttribute("aria-selected", "true");
      // No provider is connected on a fresh install, so the tab asks for the first one's token.
      await expect(dialog.getByRole("form", { name: "Connect Hetzner Cloud" })).toBeVisible();
      await expect(dialog.getByLabel("Hetzner Cloud API token")).toBeVisible();
      await shot(page, "07d-add-server-cloud-provider");
      await audit(page, "add server: cloud provider");
      await dialog.getByRole("tab", { name: "Linux server" }).click();

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
        // The Linux default is /var/lib/roundhouse, which an unprivileged CI user can't create.
        "--data-dir",
        join(agentDir, "data"),
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
      await audit(page, "servers with a server online");
    });

    test("Home reflects the fleet and the activity feed", async ({ page }) => {
      await signIn(page);
      await expect(page.getByRole("region", { name: "Servers online" })).toContainText("1 of 1");
      await expect(page.getByText(/hel-1 connected/i).first()).toBeVisible();
      await shot(page, "10-home-fleet");
      await audit(page, "home with the fleet");
    });

    test("a project, its service and its deployments are accessible", async ({ page }) => {
      await signIn(page);
      await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
      await page.getByRole("button", { name: "New project" }).first().click();
      const create = page.getByRole("dialog", { name: "New project" });
      await create.getByLabel("Project name").fill("storefront");
      await create.getByRole("button", { name: "Create project" }).click();
      await expect(page.getByRole("heading", { name: "No services yet" })).toBeVisible();

      await page.getByRole("button", { name: "New service" }).first().click();
      const service = page.getByRole("dialog", { name: "New service" });
      await service.getByLabel("Image", { exact: true }).fill("nginx:1.27-alpine");
      await service.getByRole("button", { name: "Continue" }).click();
      await shot(page, "16-new-service");
      await audit(page, "new service");
      await service.getByRole("button", { name: "Create and deploy" }).click();
      await expect(page).toHaveURL(/\/s\/[^/]+/);
      await expect(page.getByRole("table")).toBeVisible();
      await shot(page, "17-service-deployments");
      await audit(page, "service deployments");
      await page
        .getByRole("link", { name: /^Deployment / })
        .first()
        .click();
      await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
      await audit(page, "deployment detail");
      await page.goBack();

      // The canvas is the project's default view; the list is its accessible alternative.
      await page.goto(new URL(page.url()).pathname.replace(/\/s\/.*$/, ""));
      const view = page.getByRole("radiogroup", { name: "View" });
      await expect(view.getByRole("radio", { name: "Canvas" })).toBeChecked();
      await shot(page, "18a-project-canvas");
      await audit(page, "project: canvas");
      await view.getByRole("radio", { name: "List" }).click();
      await expect(page).toHaveURL(/[?&]view=list/);
      await expect(page.getByRole("list", { name: "Services" })).toBeVisible();
      await shot(page, "18-project");
      await audit(page, "project: list");

      await page.goto("/dashboard");
      await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
      await expect(page.getByRole("link", { name: "storefront" }).first()).toBeVisible();
      await audit(page, "home with a project");
    });

    test("settings pages are accessible", async ({ page }) => {
      await signIn(page);
      for (const [path, name] of [
        ["settings", "settings: general"],
        ["members", "settings: members"],
        ["audit", "settings: audit log"],
        ["tokens", "settings: API tokens"],
        ["platform", "settings: platform"],
      ] as const) {
        await page.goto(`${workspacePath}/${path}`);
        await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();
        await page.waitForLoadState("networkidle");
        await audit(page, name);
      }

      await page.goto(`${workspacePath}/tokens`);
      await page.getByRole("button", { name: "Create token" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Create API token" });
      await dialog.getByLabel("Name").fill("github-actions");
      await dialog.getByRole("radio", { name: /^Deploy/ }).check();
      await shot(page, "19-create-token");
      await audit(page, "create API token");
      await dialog.getByRole("button", { name: "Create token" }).click();
      const created = page.getByRole("dialog", { name: "Token created" });
      await expect(created.getByText(/^tok_/)).toBeVisible();
      await shot(page, "20-token-created");
      await audit(page, "token created");
      await created.getByRole("button", { name: "Done" }).click();
      await expect(page.getByText("github-actions").first()).toBeVisible();
      await shot(page, "21-api-tokens");
      await audit(page, "settings: API tokens with a token");
    });

    test("cloud-init user data keeps the token out of every command line", async ({
      browser,
      baseURL,
    }) => {
      // NOTE: Cloud-init needs an https:// control plane. The browser is shown the local
      // one under a public https origin; requests are forwarded with that origin
      // rewritten, so the session cookie and CSRF checks behave as on a real host.
      const origin = "https://cp.example.test";
      const local = baseURL ?? "";
      const context = await browser.newContext();
      await context.route(`${origin}/**`, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const headers = { ...request.headers() };
        if (headers.origin) headers.origin = local;
        if (headers.referer) headers.referer = headers.referer.replace(origin, local);
        const response = await route.fetch({
          url: `${local}${url.pathname}${url.search}`,
          headers,
          maxRedirects: 0,
        });
        await route.fulfill({ response });
      });
      const page = await context.newPage();
      await page.goto(`${origin}/login`);
      await page.getByLabel("Email").fill(OWNER.email);
      await page.getByLabel("Password").fill(OWNER.password);
      await page.getByRole("button", { name: /sign in|log in/i }).click();
      await completeSecondFactor(page);
      await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
      await page.goto(`${origin}${workspacePath}/servers`);
      await page
        .getByRole("button", { name: /add server/i })
        .first()
        .click();
      const dialog = page.getByRole("dialog", { name: "Add a server" });
      await expect(dialog.getByRole("tab", { name: "This computer" })).toHaveCount(0);
      await dialog.getByRole("tab", { name: "Cloud-init" }).click();
      await dialog.getByLabel("Server name").fill("web-1");
      await dialog.getByRole("checkbox", { name: "Builder node" }).check();
      const userData = (await dialog.locator("pre code").textContent()) ?? "";
      const token = /content: "(njt_[^"\\]+)/.exec(userData)?.[1] ?? "";
      expect(token).toMatch(/^njt_/);
      expect(userData).toContain('permissions: "0600"');
      expect(userData).toContain(`curl --proto '=https' --tlsv1.2`);
      expect(userData).toContain(`'${origin}/install.sh'`);
      expect(userData).toContain("--token-file");
      expect(userData).toContain("--builder");
      expect(userData.slice(userData.indexOf("runcmd:"))).not.toContain(token);
      await shot(page, "07e-add-server-cloud-init-https");
      await audit(page, "add server: cloud-init on https");
      await context.close();
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
        .getByText(/\/invite#token=/)
        .first()
        .textContent();
      // The token rides in the fragment, which browsers never send to a server.
      expect(url).toMatch(/\/invite#token=inv_/);
      await shot(page, "13-invite-created");

      const other = await browser.newContext();
      const invitee = await other.newPage();
      await invitee.goto(url!.trim());
      await expect(invitee.getByText(/Nightjar Labs/)).toBeVisible();
      await expect(invitee).not.toHaveURL(/#/);
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

/**
 * Signs the admin in: through the form and the two-factor step the first time, then by
 * restoring that session's cookies.
 *
 * NOTE: Each form sign-in costs two requests against the per-IP auth limit (10 a
 * minute), so signing in through the UI in every test trips it once the suite is quick.
 */
async function signIn(page: Page) {
  if (session.length > 0) {
    await page.context().addCookies(session);
    await page.goto("/dashboard");
    await expect(page).not.toHaveURL(/\/(login|setup)/);
    return;
  }
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await completeSecondFactor(page);
  await expect(page).not.toHaveURL(/\/login/);
  session = await page.context().cookies();
}

/**
 * Answers the sign-in's two-factor step: an authenticator code while a fresh time
 * step is free (each is accepted once), else a backup code, else waits for a step.
 */
async function completeSecondFactor(page: Page) {
  const heading = page.getByRole("heading", { name: "Two-factor authentication" });
  await expect(heading).toBeVisible();
  if (!codes) throw new Error("setup did not enroll the admin in two-factor");
  const totp = codes.tryNext();
  if (totp === null && backupCodes.length > 0) {
    await page.getByRole("button", { name: "Use a backup code" }).click();
    await page.getByLabel("Backup code").fill(backupCodes.shift()!);
  } else {
    await page.getByLabel("Authentication code").fill(totp ?? (await codes.next()));
  }
  await audit(page, "sign-in: two-factor");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(heading).toBeHidden();
}
