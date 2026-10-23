// @vitest-environment node
import { describe, expect, it } from "vitest";

// NOTE: Vitest blanks CSS modules (even `?raw`), so the stylesheet is read from disk.
// The specifier is a variable because this package has no Node type definitions.
const fsModule = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
  readFileSync(path: URL, encoding: "utf8"): string;
};
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

type Palette = Record<string, string>;

function declarations(block: string): Palette {
  const palette: Palette = {};
  for (const [, name, value] of block.matchAll(/--([a-z-]+):\s*([^;]+);/g)) {
    if (name && value) palette[name] = value.trim();
  }
  return palette;
}

function blockAfter(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`No ${selector} block in styles.css`);
  return css.slice(start, css.indexOf("}", start));
}

const dark = declarations(blockAfter(":root"));
const lightOverrides = declarations(blockAfter(":root.light"));
const light: Palette = { ...dark, ...lightOverrides };

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) throw new Error(`Expected a #rrggbb colour, got ${hex}`);
  const channels = [0, 2, 4].map((i) => Number.parseInt(match[1]!.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** `#rrggbb` of `top` painted at `alpha` over `bottom`. */
function blend(top: string, bottom: string, alpha: number): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i, 3 + i), 16);
  return `#${[0, 2, 4]
    .map((i) =>
      Math.round(channel(top, i) * alpha + channel(bottom, i) * (1 - alpha))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const TEXT_ON_BACKGROUNDS = [
  "foreground",
  "muted-foreground",
  "subtle-foreground",
  "accent-text",
  "success",
  "warning",
  "danger",
  "info",
] as const;

describe.each([
  ["dark", dark],
  ["light", light],
])("%s palette", (_, palette) => {
  const token = (name: string) => {
    const value = palette[name];
    if (!value) throw new Error(`Missing --${name}`);
    return value;
  };

  it.each(TEXT_ON_BACKGROUNDS)("--%s text reaches 4.5:1 on background and surface", (name) => {
    expect(contrast(token(name), token("background"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(name), token("surface"))).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["accent-foreground", "accent"],
    ["danger-foreground", "danger"],
  ])("--%s reaches 4.5:1 on --%s buttons", (text, fill) => {
    expect(contrast(token(text), token(fill))).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["success", "success", 0.1],
    ["warning", "warning", 0.1],
    ["danger", "danger", 0.1],
    ["info", "info", 0.1],
    ["accent-text", "accent-subtle", 0.12],
  ])("--%s badge text reaches 4.5:1 on its tinted fill", (text, fill, alpha) => {
    // NOTE: Badges paint `bg-<tone>/10` over the page (accent: --accent-subtle, which is
    // the --ring colour at 12%), so text is measured against that blend.
    const tint = fill === "accent-subtle" ? token("ring") : token(fill);
    for (const base of ["background", "surface"]) {
      expect(contrast(token(text), blend(tint, token(base), alpha))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("draws state indicators (accent-text) at 3:1 or better", () => {
    expect(contrast(token("accent-text"), token("background"))).toBeGreaterThanOrEqual(3);
    expect(contrast(token("accent-text"), token("surface"))).toBeGreaterThanOrEqual(3);
  });
});

describe("light palette definitions", () => {
  it("keeps the prefers-color-scheme block identical to :root.light", () => {
    const media = declarations(blockAfter(":root:not(.dark)"));
    expect(media).toEqual(lightOverrides);
  });
});

describe("ANSI terminal colors", () => {
  const ansi = (selector: string) =>
    Object.fromEntries(
      [...blockAfter(selector).matchAll(/--ansi-(\d+):\s*([^;]+);/g)].map(([, n, v]) => [
        Number(n),
        (v ?? "").trim(),
      ]),
    );

  it.each([":root", ":root.light", ":root:not(.dark)"])("defines all 16 in %s", (selector) => {
    expect(Object.keys(ansi(selector))).toHaveLength(16);
  });

  it.each([
    ["dark", ":root", dark],
    ["light", ":root.light", light],
  ])("keeps the %s colors readable on the log background (3:1)", (_, selector, palette) => {
    const colors = ansi(selector);
    for (let index = 1; index < 16; index++) {
      if (index === 7 && selector === ":root.light") continue;
      expect(
        contrast(colors[index] as string, palette.background as string),
      ).toBeGreaterThanOrEqual(3);
    }
  });
});
