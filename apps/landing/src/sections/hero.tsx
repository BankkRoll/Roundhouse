import { PRODUCT_NAME } from "@openrail/shared";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { DEPLOY_URL, INSTALL_COMMAND, REPO_URL } from "../links";
import { buttonClass, CommandLine, ExternalLink, useRevealOnce } from "../ui";
import { ArchitectureDiagram } from "./architecture-diagram";

/**
 * Counts requests this page made to any origin but its own, from the Resource Timing API.
 * The schematic prints it, so the page proves its own "no third parties" claim.
 *
 * @returns The count, or `null` where Resource Timing is unavailable.
 */
function useThirdPartyRequests(): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (typeof performance?.getEntriesByType !== "function") return;
    const read = () => {
      const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      setCount(entries.filter((entry) => !entry.name.startsWith(location.origin)).length);
    };
    read();
    const id = setInterval(read, 3000);
    return () => clearInterval(id);
  }, []);
  return count;
}

const step = (i: number) => ({ "--i": i }) as CSSProperties;

/**
 * First screen: what this is and the one action on the left; on the right, a step lighter,
 * the live architecture schematic that explains how it fits together.
 *
 * @param props - Whether looping animations are paused.
 * @returns The hero.
 */
export function Hero({ paused }: { paused: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useRevealOnce(ref);
  const thirdParty = useThirdPartyRequests();

  return (
    <section
      ref={ref}
      id="top"
      aria-labelledby="hero-title"
      className="grid min-h-[calc(100svh-68px)] lg:grid-cols-2"
    >
      <div className="flex flex-col justify-center gap-8 px-[var(--lp-margin)] py-14 lg:py-20 lg:pr-[var(--lp-margin)] lg:pl-[var(--lp-edge-v)]">
        <h1 id="hero-title" className="lp-display" data-reveal style={step(0)}>
          Deploy to servers <br />
          you own
        </h1>
        <p className="lp-lead max-w-[38ch] text-foreground" data-reveal style={step(1)}>
          Push to Git and {PRODUCT_NAME} builds, ships and serves your apps on any Linux server. The
          control plane runs in your own Cloudflare account for about $5 a month.
        </p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3" data-reveal style={step(2)}>
          <ExternalLink href={DEPLOY_URL} className={buttonClass("primary")}>
            Deploy to Cloudflare
          </ExternalLink>
          <ExternalLink
            href={REPO_URL}
            className="min-h-11 content-center rounded-sm text-[16px] font-medium text-foreground underline decoration-muted-foreground underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Star on GitHub
          </ExternalLink>
        </div>
        <div className="grid max-w-[560px] gap-3" data-reveal style={step(3)}>
          <p className="lp-small text-muted-foreground">Then add a server with one line:</p>
          <CommandLine code={INSTALL_COMMAND} />
          <p className="lp-small text-muted-foreground">
            Early development. Not ready for production yet.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-center bg-[var(--lp-step)] px-[var(--lp-margin)] py-10 lg:py-16">
        <div className="w-full max-w-[560px]" data-reveal style={step(2)}>
          <ArchitectureDiagram paused={paused} thirdPartyRequests={thirdParty} />
        </div>
      </div>
    </section>
  );
}
