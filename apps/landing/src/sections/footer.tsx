import { PRODUCT_NAME } from "@roundhouse/shared";
import { ArrowUpRightIcon, MoonIcon, SunIcon } from "lucide-react";
import { type MouseEvent, useLayoutEffect, useRef, useState } from "react";
import {
  CONTRIBUTING_URL,
  DEPLOY_URL,
  DOCS_URL,
  INSTALL_COMMAND,
  RELEASES_URL,
  REPO_URL,
  SECURITY_URL,
} from "../links";
import { buttonClass, CommandLine, ExternalLink } from "../ui";
import { useTheme } from "../use-theme";
import { goToSection } from "./header";

const PRODUCT_LINKS = [
  ["Push to live", "deploys"],
  ["Project canvas", "canvas"],
  ["Security", "security"],
  ["Pricing", "pricing"],
  ["Everything it does", "features"],
  ["FAQ", "faq"],
] as const;

const PROJECT_LINKS = [
  ["Docs", DOCS_URL],
  ["GitHub", REPO_URL],
  ["Releases", RELEASES_URL],
  ["Report a vulnerability", SECURITY_URL],
  ["Contributing", CONTRIBUTING_URL],
] as const;

function onSectionClick(event: MouseEvent<HTMLAnchorElement>) {
  const id = event.currentTarget.hash.slice(1);
  if (id && goToSection(id)) event.preventDefault();
}

/** Font size of the wordmark in view box units; the text is stretched to 1000 units wide. */
const WORDMARK_FONT_SIZE = 250;

/** Horizontal slack in view box units, so stretched glyph edges never clip. */
const WORDMARK_PAD_X = 6;

/**
 * Vertical space in view box units. The panel pads only its sides, so this is the whole gap
 * above and below the letters; kept well under the side margin so the panel stays short.
 */
const WORDMARK_PAD_Y = 28;

/**
 * Ink ascent and descent of the wordmark, from canvas text metrics.
 *
 * `getBBox` returns the font's whole line box, which leaves a band of empty descender space
 * under a word with no descenders; the canvas reports the glyphs' actual bounds.
 *
 * @param text - The rendered text element, for its computed font.
 * @returns The ink extents at {@link WORDMARK_FONT_SIZE}, or `null` without canvas support.
 */
function inkExtents(text: SVGTextElement): { ascent: number; descent: number } | null {
  const context = document.createElement("canvas").getContext?.("2d");
  if (!context) return null;
  const style = getComputedStyle(text);
  context.font = `${style.fontWeight} ${WORDMARK_FONT_SIZE}px ${style.fontFamily}`;
  const metrics = context.measureText(PRODUCT_NAME);
  const ascent = metrics.actualBoundingBoxAscent;
  const descent = metrics.actualBoundingBoxDescent;
  return ascent > 0 ? { ascent, descent } : null;
}

/** Gap between the mark and the name, as a fraction of the mark's size. */
const MARK_GAP = 0.14;

/** Ink extents before the font has loaded, close to Inter Bold's at {@link WORDMARK_FONT_SIZE}. */
const FALLBACK_INK = { ascent: 182, descent: 4 };

/**
 * The logo mark and the product name stretched across the footer. The mark is as tall as the
 * letters, and both share one view box measured from the glyphs once the font has loaded, so
 * no font metric guess can crop the tops of letters.
 *
 * @returns The wordmark.
 */
function Wordmark() {
  const textRef = useRef<SVGTextElement>(null);
  const [ink, setInk] = useState(FALLBACK_INK);

  useLayoutEffect(() => {
    const measure = () => {
      const text = textRef.current;
      if (!text) return;
      const measured = inkExtents(text);
      if (measured) setInk(measured);
    };
    measure();
    document.fonts?.ready.then(measure);
  }, []);

  const size = ink.ascent + ink.descent;
  const textX = size * (1 + MARK_GAP);
  const box = [
    -WORDMARK_PAD_X,
    -ink.ascent - WORDMARK_PAD_Y,
    textX + 1000 + WORDMARK_PAD_X * 2,
    size + WORDMARK_PAD_Y * 2,
  ].join(" ");

  return (
    <svg
      viewBox={box}
      role="img"
      aria-label={PRODUCT_NAME}
      className="block h-auto w-full overflow-visible"
      data-testid="wordmark"
    >
      {/* The mark's artwork spans 96–416 of its 512 grid; scale that span to the letter height. */}
      <g
        transform={`translate(0 ${-ink.ascent}) scale(${size / 320}) translate(-96 -96)`}
        className="fill-accent stroke-accent"
        data-testid="wordmark-mark"
      >
        <path d="M160 160 352 352M352 160 160 352" fill="none" strokeWidth="44" />
        <rect x="104" y="104" width="96" height="96" rx="20" stroke="none" />
        <rect x="312" y="104" width="96" height="96" rx="20" stroke="none" />
        <rect x="104" y="312" width="96" height="96" rx="20" stroke="none" />
        <rect x="312" y="312" width="96" height="96" rx="20" stroke="none" />
        <rect x="220" y="220" width="72" height="72" rx="14" stroke="none" />
      </g>
      <text
        ref={textRef}
        x={textX}
        y="0"
        textLength="1000"
        lengthAdjust="spacingAndGlyphs"
        className="fill-background font-sans font-bold"
        style={{ fontSize: WORDMARK_FONT_SIZE, letterSpacing: "-0.04em" }}
      >
        {PRODUCT_NAME}
      </text>
    </svg>
  );
}

const linkClass =
  "inline-block py-1 text-[17px] text-foreground outline-none hover:text-accent-text focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The close of the page: a last invitation, a board of tiles
 * with the links and the install line, and the name at full width.
 *
 * @returns The footer.
 */
export function SiteFooter() {
  const theme = useTheme();
  return (
    <footer className="px-[var(--lp-margin)] pb-6">
      <div className="grid gap-8 pt-[var(--lp-space)] pb-[var(--lp-space)] lg:grid-cols-12 lg:items-end lg:gap-[var(--lp-gap)]">
        <p className="max-w-[30ch] text-[22px] leading-[1.2] tracking-[-0.02em] text-foreground sm:text-[clamp(24px,2.4vw,36px)] lg:col-span-8">
          Your servers are already paid for. Give them a control plane of their own.
        </p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 lg:col-span-4 lg:justify-end">
          <ExternalLink href={DEPLOY_URL} className={buttonClass("primary")}>
            Deploy to Cloudflare
          </ExternalLink>
          <ExternalLink
            href={REPO_URL}
            className="text-[16px] font-medium text-foreground underline decoration-muted-foreground underline-offset-4 hover:decoration-foreground"
          >
            Star on GitHub
          </ExternalLink>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-12">
        <div className="col-span-2 flex flex-col justify-between gap-6 rounded-lg bg-[var(--lp-step)] p-6 lg:col-span-5">
          <div>
            <h2 className="text-[22px] font-medium tracking-[-0.01em]">Add a server</h2>
            <CommandLine code={INSTALL_COMMAND} className="mt-4" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-[15px] text-muted-foreground">
            <span>{PRODUCT_NAME} is in early development.</span>
            <button
              type="button"
              onClick={theme.toggle}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md bg-[var(--lp-step-2)] px-4 text-[15px] text-foreground outline-none hover:bg-[var(--lp-field)] focus-visible:ring-2 focus-visible:ring-ring"
            >
              {theme.resolved === "dark" ? (
                <SunIcon className="size-4" aria-hidden="true" />
              ) : (
                <MoonIcon className="size-4" aria-hidden="true" />
              )}
              {theme.resolved === "dark" ? "Light theme" : "Dark theme"}
            </button>
          </div>
        </div>
        <nav aria-label="Product" className="rounded-lg bg-[var(--lp-step)] p-6 lg:col-span-2">
          <p className="mb-3 text-[15px] text-muted-foreground">Product</p>
          <ul>
            {PRODUCT_LINKS.map(([label, id]) => (
              <li key={id}>
                <a href={`#${id}`} onClick={onSectionClick} className={linkClass}>
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Project" className="rounded-lg bg-[var(--lp-step)] p-6 lg:col-span-2">
          <p className="mb-3 text-[15px] text-muted-foreground">Project</p>
          <ul>
            {PROJECT_LINKS.map(([label, href]) => (
              <li key={label}>
                <ExternalLink href={href} className={linkClass}>
                  {label}
                </ExternalLink>
              </li>
            ))}
          </ul>
        </nav>
        <ExternalLink
          href={DEPLOY_URL}
          className="group col-span-2 flex min-h-[220px] flex-col justify-between rounded-lg bg-accent p-6 text-accent-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background lg:col-span-3"
        >
          <span className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
            Deploy it yourself
          </span>
          <ArrowUpRightIcon
            className="size-12 self-end transition-transform group-hover:translate-x-1 group-hover:-translate-y-1"
            strokeWidth={2.5}
            aria-hidden="true"
          />
        </ExternalLink>
        <div
          className="col-span-2 rounded-lg bg-foreground px-[5%] py-[clamp(24px,4.5vw,72px)] lg:col-span-12"
          data-testid="wordmark-panel"
        >
          <Wordmark />
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-[15px] text-muted-foreground">
        <p>© 2026 {PRODUCT_NAME} contributors.</p>
        <ExternalLink
          href={REPO_URL}
          className="text-foreground underline decoration-muted-foreground underline-offset-2 hover:decoration-foreground"
        >
          github.com/BankkRoll/Roundhouse
        </ExternalLink>
      </div>
    </footer>
  );
}
