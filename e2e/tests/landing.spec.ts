/**
 * Smoke test for the public landing page at `/`: it renders for anonymous visitors
 * without touching the API or any third party, every interactive piece responds, it fits
 * a 360px phone, and reduced motion stops the loops. Also saves full-page screenshots.
 */
import { join } from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";

const SHOTS = join(import.meta.dirname, "..", "screenshots");
const LANDING = "/";

interface PageProblems {
  console: string[];
  failed: string[];
  api: string[];
}

function watch(page: Page): PageProblems {
  const problems: PageProblems = { console: [], failed: [], api: [] };
  page.on("console", (message) => {
    if (message.type() === "error") problems.console.push(message.text());
  });
  page.on("pageerror", (error) => problems.console.push(error.message));
  page.on("requestfailed", (request) => problems.failed.push(request.url()));
  page.on("response", (response) => {
    if (response.status() >= 400) problems.failed.push(`${response.status()} ${response.url()}`);
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1") || url.pathname.startsWith("/api")) {
      problems.api.push(url.pathname);
    }
    if (url.protocol.startsWith("http") && url.hostname !== "127.0.0.1") {
      problems.failed.push(`third-party ${request.url()}`);
    }
  });
  return problems;
}

async function openLanding(page: Page) {
  await page.goto(LANDING);
  await expect(page.getByRole("heading", { level: 1, name: /your own railway/i })).toBeVisible();
}

async function scrollThrough(page: Page) {
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.8;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    window.scrollTo(0, 0);
  });
}

test.describe("landing page", () => {
  test("a visitor with no session stays on the landing page", async ({ browser }) => {
    const context = await browser.newContext();
    expect(await context.cookies()).toEqual([]);
    const page = await context.newPage();
    const problems = watch(page);
    await openLanding(page);
    await page.waitForTimeout(500);
    expect(new URL(page.url()).pathname).toBe(LANDING);
    await scrollThrough(page);
    await expect(page.getByTestId("third-party-readout")).toContainText("0");
    expect(problems.api, "the landing page must not call the API").toEqual([]);
    expect(problems.console).toEqual([]);
    expect(problems.failed).toEqual([]);
    await context.close();
  });

  test("schematic boxes explain themselves on hover and focus", async ({ page }) => {
    await openLanding(page);
    const diagram = page.getByTestId("architecture");
    await diagram.locator('[data-node="do"]').hover();
    await expect(page.getByRole("tooltip")).toContainText("Durable Object");
    await diagram.locator('[data-node="nuc"]').focus();
    await expect(page.getByRole("tooltip")).toContainText("NAT");
  });

  test("the Product menu works with the keyboard", async ({ page }) => {
    await openLanding(page);
    const trigger = page.getByRole("button", { name: "Product", exact: true });
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const panel = page.getByRole("region", { name: "Product" });
    await expect(panel.getByRole("link").first()).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(":focus")).toContainText("Data");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("scrolling walks the deploy from push to live, and it rolls back", async ({ page }) => {
    await openLanding(page);
    const pipeline = page.getByTestId("pipeline");
    await expect(pipeline).toHaveAttribute("data-mode", "live");
    await pipeline.locator('[data-stage="push"]').scrollIntoViewIfNeeded();
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(0, 220);
      await page.waitForTimeout(40);
      seen.add((await pipeline.getAttribute("data-active")) ?? "");
    }
    expect(seen).toContain("build");
    expect(seen).toContain("health");
    await pipeline.locator('[data-stage="push"]').click();
    await expect(pipeline).toHaveAttribute("data-active", "push", { timeout: 10_000 });
    await pipeline.locator('[data-stage="live"]').click();
    await expect(pipeline).toHaveAttribute("data-active", "live", { timeout: 10_000 });
    const log = pipeline.getByRole("list", { name: "Log" });
    await expect(log).toContainText("live  https://api.acme.dev");
    await pipeline.getByRole("switch", { name: /roll back/i }).click();
    await expect(log).toContainText("build skipped");
  });

  test("canvas edits are staged, reviewed and deployed", async ({ page }) => {
    await openLanding(page);
    const canvas = page.getByTestId("canvas");
    await canvas.scrollIntoViewIfNeeded();

    const web = canvas.locator('[data-node="web"]');
    const before = await web.boundingBox();
    await web.hover();
    await page.mouse.down();
    await page.mouse.move((before?.x ?? 0) + 60, (before?.y ?? 0) + 50, { steps: 6 });
    await page.mouse.up();
    const after = await web.boundingBox();
    expect(Math.round(after?.x ?? 0)).not.toBe(Math.round(before?.x ?? 0));

    await page.getByLabel("api · LOG_LEVEL").fill("debug");
    await expect(canvas.locator('[data-node="api"]')).toHaveAttribute("data-status", "staged");
    await page.getByRole("radio", { name: "Redis" }).click();
    await expect(canvas.getByTestId("staged-count")).toContainText("2 staged changes");
    await expect(page.getByRole("list", { name: "Staged changes" })).toContainText("info");
    await page.getByRole("button", { name: "Deploy", exact: true }).click();
    await expect(canvas.locator('[data-node="api"]')).toHaveAttribute("data-status", "active", {
      timeout: 10_000,
    });
    await expect(canvas.getByTestId("staged-count")).toContainText("Everything deployed");
  });

  test("tampering with a signed envelope is rejected", async ({ page }) => {
    await openLanding(page);
    const demo = page.getByTestId("envelope-demo");
    await demo.scrollIntoViewIfNeeded();
    await expect(demo).toHaveAttribute("data-result", "accepted");
    await demo.getByRole("switch", { name: /tamper/i }).click();
    await expect(demo).toHaveAttribute("data-result", "rejected");
    await expect(demo).toContainText("REJECTED · bad_signature");
    await expect(demo).not.toContainText("lacks Ed25519");
  });

  test("the calculator recomputes", async ({ page }) => {
    await openLanding(page);
    const calculator = page.getByTestId("calculator");
    await calculator.scrollIntoViewIfNeeded();
    await expect(calculator.getByTestId("self-total")).toContainText("$65.00");
    await expect(calculator).toContainText("2 rented servers with 8 vCPU and 16 GB RAM");
    const paas = calculator.getByTestId("paas-total");
    const before = await paas.textContent();
    await page.getByLabel("Average vCPU in use").fill("8");
    await expect(paas).not.toHaveText(before ?? "");
    await expect(calculator.getByTestId("self-total")).toContainText("$65.00");
  });

  test("fits a 360px screen without horizontal scrolling", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
    const page = await context.newPage();
    await openLanding(page);
    await scrollThrough(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "Menu" }).click();
    await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Menu" })).toBeHidden();
    await context.close();
  });

  test("reduced motion stops every loop and unpins the scene", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await openLanding(page);
    await expect(page.getByTestId("landing")).toHaveAttribute("data-motion", "paused");
    await expect(page.getByTestId("pipeline")).toHaveAttribute("data-mode", "rest");
    await scrollThrough(page);
    const running = await page.evaluate(
      () =>
        document.getAnimations().filter((animation) => animation.playState === "running").length,
    );
    expect(running).toBe(0);
    const packets = await page.evaluate(
      () =>
        [...document.querySelectorAll(".lp-packet")].filter(
          (packet) => getComputedStyle(packet).display !== "none",
        ).length,
    );
    expect(packets).toBe(0);
    await context.close();
  });
});

test("the footer runs full width and its wordmark is never clipped", async ({ browser }) => {
  for (const width of [390, 1440, 1920, 2560]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await openLanding(page);
    await page.evaluate(() => document.fonts.ready);
    const panel = page.getByTestId("wordmark-panel");
    await panel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const { text, box, viewport, margin } = await page.evaluate(() => {
      const glyphs = document.querySelector("[data-testid=wordmark] text") as SVGTextElement;
      const panelBox = document.querySelector("[data-testid=wordmark-panel]") as HTMLElement;
      const svg = document.querySelector("[data-testid=wordmark]") as SVGSVGElement;
      const header = document.querySelector("header > div") as HTMLElement;
      return {
        text: glyphs.getBoundingClientRect().toJSON(),
        box: svg.getBoundingClientRect().toJSON(),
        viewport: window.innerWidth,
        margin: {
          panelLeft: panelBox.getBoundingClientRect().left,
          panelRight: window.innerWidth - panelBox.getBoundingClientRect().right,
          headerLeft: Number.parseFloat(getComputedStyle(header).paddingLeft),
        },
      };
    });
    // The glyphs sit inside the drawing box, so the panel never crops a letter.
    expect(text.top, `top at ${width}`).toBeGreaterThanOrEqual(box.top - 0.5);
    expect(text.bottom, `bottom at ${width}`).toBeLessThanOrEqual(box.bottom + 0.5);
    expect(text.left).toBeGreaterThanOrEqual(box.left - 0.5);
    expect(text.right).toBeLessThanOrEqual(box.right + 0.5);
    // Edge to edge apart from the page gutter, at every width.
    expect(margin.panelLeft).toBeLessThanOrEqual(40);
    expect(Math.abs(margin.panelLeft - margin.panelRight)).toBeLessThanOrEqual(2);
    expect(viewport).toBe(width);
    await context.close();
  }
});

test("pinned stages fill the viewport below the header", async ({ browser }) => {
  for (const [width, height] of [
    [1440, 900],
    [1920, 1080],
    [2060, 1265],
    [1440, 768],
  ]) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    await openLanding(page);
    for (const [section, stage] of [
      ["deploys", "[data-testid=pipeline-stage]"],
      ["canvas", "[data-testid=canvas]"],
    ]) {
      const box = await page.evaluate(
        async ([id, selector]) => {
          const el = document.getElementById(id) as HTMLElement;
          const top = el.getBoundingClientRect().top + window.scrollY;
          window.scrollTo(0, top + el.offsetHeight * 0.45);
          await new Promise((resolve) => setTimeout(resolve, 400));
          const header = (document.querySelector("header") as HTMLElement).getBoundingClientRect();
          const rect = (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
          return {
            top: rect.top,
            bottom: rect.bottom,
            header: header.bottom,
            viewport: window.innerHeight,
          };
        },
        [section, stage],
      );
      expect(
        Math.abs(box.top - box.header),
        `${section} top at ${width}x${height}`,
      ).toBeLessThanOrEqual(3);
      expect(
        Math.abs(box.bottom - box.viewport),
        `${section} bottom at ${width}x${height}`,
      ).toBeLessThanOrEqual(3);
    }
    await expect(page.getByRole("heading", { name: "Push to live in eight stops" })).toBeAttached();
    await context.close();
  }
});

async function screenshot(browser: Browser, theme: "dark" | "light", width: number) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: theme,
  });
  const page = await context.newPage();
  await openLanding(page);
  await scrollThrough(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `landing-${theme}-${width}.png`), fullPage: true });
  await context.close();
}

test("screenshots for review", async ({ browser }) => {
  test.setTimeout(180_000);
  for (const theme of ["dark", "light"] as const) {
    for (const width of [1440, 390]) await screenshot(browser, theme, width);
  }
});
