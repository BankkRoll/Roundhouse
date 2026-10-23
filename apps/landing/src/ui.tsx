import { cn, copyText } from "@roundhouse/ui";
import { CheckIcon, CopyIcon } from "lucide-react";
import {
  type KeyboardEventHandler,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Marks an element `.is-in` the first time it scrolls into view, which starts the
 * staggered entrance of its `[data-reveal]` children (see landing.css).
 *
 * @param ref - Element to watch.
 */
export function useRevealOnce(ref: RefObject<Element | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      element.classList.add("is-in");
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
}

/** Props for {@link Section}. */
export interface SectionProps {
  /** Anchor id used by the header links. */
  id: string;
  /** Id of the section's heading. */
  labelledBy: string;
  children: ReactNode;
  className?: string;
  /** Skip the default vertical padding (scenes and full-bleed sections set their own). */
  bare?: boolean;
}

/**
 * Page section with the page margins, the section rhythm and a one-time entrance.
 *
 * @param props - Anchor, heading id and content.
 * @returns The section.
 */
export function Section({ id, labelledBy, children, className, bare = false }: SectionProps) {
  const ref = useRef<HTMLElement>(null);
  useRevealOnce(ref);
  return (
    <section
      ref={ref}
      id={id}
      aria-labelledby={labelledBy}
      className={cn("scroll-mt-16", !bare && "lp-section lp-wrap", className)}
    >
      {children}
    </section>
  );
}

/**
 * Link that opens outside the app, with no referrer, matching the dashboard's policy.
 *
 * @param props - Anchor props.
 * @returns The anchor.
 */
export function ExternalLink({
  href,
  children,
  className,
  ...props
}: {
  href: string;
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
  role?: string;
  tabIndex?: number;
  onKeyDown?: KeyboardEventHandler<HTMLAnchorElement>;
  "data-menu-item"?: boolean;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className} {...props}>
      {children}
    </a>
  );
}

/**
 * Shell command as real code with a copy button. Long commands wrap at spaces first so flags
 * and URLs are not split mid-word.
 *
 * @param props - The command and optional classes.
 * @returns The command block.
 */
export function CommandLine({
  code,
  className,
  tone = "step",
}: {
  code: string;
  className?: string;
  /** Background tone: one step off the ground, or the deeper field. */
  tone?: "step" | "field";
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    if (!(await copyText(code))) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg p-4",
        tone === "step" ? "bg-[var(--lp-step-2)]" : "bg-[var(--lp-field)]",
        className,
      )}
    >
      <pre className="min-w-0 flex-1 whitespace-pre-wrap font-mono text-[14px] leading-relaxed text-foreground wrap-anywhere">
        <code>
          <span aria-hidden="true" className="select-none text-muted-foreground">
            ${" "}
          </span>
          {code}
        </code>
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy command"}
        className="-m-1 flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-[var(--lp-field)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-95"
      >
        {copied ? (
          <CheckIcon className="size-4 text-success" aria-hidden="true" />
        ) : (
          <CopyIcon className="size-4" aria-hidden="true" />
        )}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
}

/** Class recipe for the page's one button shape. */
export function buttonClass(variant: "primary" | "quiet" = "primary", className?: string) {
  return cn(
    "inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md px-5 text-[16px] font-medium outline-none transition-[background-color,color,transform] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.98]",
    variant === "primary"
      ? "bg-accent text-accent-foreground hover:bg-accent-hover"
      : "bg-[var(--lp-step-2)] text-foreground hover:bg-[var(--lp-field)]",
    className,
  );
}

/**
 * GitHub's mark, for links to the repository.
 *
 * @param props - Classes for sizing.
 * @returns The mark, hidden from assistive tech.
 */
export function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
