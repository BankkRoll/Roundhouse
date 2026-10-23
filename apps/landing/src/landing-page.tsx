/**
 * The public site, built as a static page and published to GitHub Pages.
 *
 * Responsibilities:
 * - Say what the product is and show it working: every picture of the product is a live
 *   fragment of the real dashboard, and the visitor can forge a signed command and watch it
 *   refused.
 * - Make no API calls: there is no control plane behind it.
 * - Stay inside the CSP: no inline scripts and no third-party requests.
 *
 * @module
 */
import "./landing.css";
import { PRODUCT_NAME } from "@roundhouse/shared";
import { cn } from "@roundhouse/ui";
import { useEffect, useState } from "react";
import { useReducedMotion } from "./hooks";
import { CanvasSection } from "./sections/canvas-section";
import { CostSection } from "./sections/cost-section";
import { FaqSection } from "./sections/faq-section";
import { FeaturesList } from "./sections/features-list";
import { SiteFooter } from "./sections/footer";
import { SiteHeader } from "./sections/header";
import { Hero } from "./sections/hero";
import { InstallSection } from "./sections/install-section";
import { PipelineScene } from "./sections/pipeline-scene";
import { SecuritySection } from "./sections/security-section";

const DESCRIPTION =
  "Source-available, self-hosted platform for deploying apps. The control plane runs on your own Cloudflare account; your apps run on any Linux server.";

function useDocumentMeta() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${PRODUCT_NAME}: deploy to servers you own`;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const created = !meta;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    const previousDescription = meta.content;
    meta.content = DESCRIPTION;
    return () => {
      document.title = previousTitle;
      if (created) meta?.remove();
      else if (meta) meta.content = previousDescription;
    };
  }, []);
}

/**
 * The landing page.
 *
 * @returns Every section, from the header to the footer.
 */
export function LandingPage() {
  useDocumentMeta();
  const reducedMotion = useReducedMotion();
  const [armed, setArmed] = useState(false);

  // NOTE: Entrances are armed only after the first render, so content is never hidden when
  // the script is slow and reduced motion never hides anything at all.
  useEffect(() => {
    if (!reducedMotion) setArmed(true);
  }, [reducedMotion]);

  return (
    <div
      className={cn("lp-root min-h-dvh", armed && "lp-armed", reducedMotion && "lp-paused")}
      data-testid="landing"
      data-motion={reducedMotion ? "paused" : "running"}
    >
      <a
        href="#main"
        className="sr-only z-[70] rounded-md bg-accent px-4 py-3 text-accent-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main">
        <Hero paused={reducedMotion} />
        <PipelineScene reducedMotion={reducedMotion} />
        <CanvasSection reducedMotion={reducedMotion} />
        <SecuritySection />
        <CostSection />
        <FeaturesList />
        <InstallSection />
        <FaqSection />
      </main>
      <SiteFooter />
    </div>
  );
}
