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

/** Space added around the glyph box so ascenders and the dot of the i never touch an edge. */
const WORDMARK_PAD = 6;

/**
 * The product name stretched across the panel. The SVG view box is measured from the glyphs
 * themselves once the font has loaded, so no font metric guess can crop the tops of letters.
 *
 * @returns The wordmark.
 */
function Wordmark() {
  const textRef = useRef<SVGTextElement>(null);
  const [box, setBox] = useState("0 -40 1000 300");

  useLayoutEffect(() => {
    const measure = () => {
      const text = textRef.current;
      if (!text || typeof text.getBBox !== "function") return;
      const { x, y, width, height } = text.getBBox();
      if (!width || !height) return;
      setBox(
        `${x - WORDMARK_PAD} ${y - WORDMARK_PAD} ${width + WORDMARK_PAD * 2} ${height + WORDMARK_PAD * 2}`,
      );
    };
    measure();
    document.fonts?.ready.then(measure);
  }, []);

  return (
    <svg
      viewBox={box}
      role="img"
      aria-label={PRODUCT_NAME}
      className="block h-auto w-full overflow-visible"
      data-testid="wordmark"
    >
      <text
        ref={textRef}
        x="0"
        y="0"
        textLength="1000"
        lengthAdjust="spacingAndGlyphs"
        className="fill-background font-sans font-bold"
        style={{ fontSize: 250, letterSpacing: "-0.04em" }}
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
          className="col-span-2 rounded-lg bg-foreground px-[3%] py-[3%] lg:col-span-12"
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
