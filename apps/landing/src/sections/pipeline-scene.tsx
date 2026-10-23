import { cn } from "@openrail/ui";
import { LockIcon } from "lucide-react";
import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import { useMediaQuery } from "../hooks";
import {
  type LogLine,
  progressForStage,
  ROLLBACK_LOG,
  STAGES,
  type StageId,
  stageAtProgress,
  stageStatuses,
  trackProgress,
} from "../model/pipeline";
import { useRevealOnce } from "../ui";

/** Height of the sticky header, from the variable the header measures. */
function headerHeight(): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--lp-header-h");
  return Number.parseFloat(value) || 0;
}

/** Screens the stage is held for while the stops advance. */
const HOLD = 4;

function Log({ lines }: { lines: readonly LogLine[] }) {
  return (
    <ol aria-label="Log" className="grid gap-1 font-mono text-[13px] leading-relaxed">
      {lines.map((line, index) => (
        <li
          key={line.text}
          className={cn(
            "lp-line-in break-words",
            line.tone === "muted" && "text-muted-foreground",
            line.tone === "success" && "text-success",
            line.tone === "accent" && "text-accent-text",
          )}
          style={{ "--i": index } as CSSProperties}
        >
          <code>{line.text}</code>
        </li>
      ))}
    </ol>
  );
}

function Row({ left, right, active }: { left: string; right: string; active?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-md px-3 py-2 text-[13px]",
        active ? "bg-accent-subtle text-foreground" : "bg-surface text-muted-foreground",
      )}
    >
      <code className="block min-w-0 truncate font-mono">{left}</code>
      <span className={cn("shrink-0", active && "text-accent-text")}>{right}</span>
    </div>
  );
}

function StageVisual({ id, rolledBack }: { id: StageId; rolledBack: boolean }) {
  switch (id) {
    case "push":
      return (
        <div className="grid gap-2">
          <Row left="4f2c9e1  fix: retry stripe webhooks" right="main" active />
          <Row left="a91d03b  feat: invoice export" right="main" />
        </div>
      );
    case "build":
      return (
        <div className="grid gap-2">
          {[
            ["install dependencies", "cached", 100],
            ["pnpm build", "14.2s", 100],
            ["export image", "3 layers", 100],
          ].map(([label, value, width]) => (
            <div
              key={label as string}
              className="grid gap-1.5 rounded-md bg-surface px-3 py-2 text-[13px]"
            >
              <div className="flex justify-between">
                <span className="text-foreground">{label}</span>
                <code className="font-mono text-muted-foreground">{value}</code>
              </div>
              <span className="h-1 rounded-full bg-meter-track">
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${width}%` }}
                />
              </span>
            </div>
          ))}
        </div>
      );
    case "registry":
      return (
        <div className="grid gap-2">
          <Row left="registry/api@sha256:9c1e…a07f" right="187 MB" active />
          <Row left="r2://acme-registry/api" right="your account" />
        </div>
      );
    case "schedule":
      return (
        <div className="grid gap-2">
          <Row left="hetzner-fsn1  2.1 vCPU · 9.4 GB free" right="chosen" active />
          <Row left="ovh-gra  1.4 vCPU · 3.1 GB free" right="fits" />
          <Row left="home-nuc  83% RAM" right="skipped" />
        </div>
      );
    case "start":
      return (
        <div className="grid gap-2">
          <Row left="verify envelope  kid=k1" right="ed25519 ok" active />
          <Row left="api-7h2k  10.20.0.3:8080" right="starting" />
        </div>
      );
    case "health":
      return (
        <div className="grid gap-2">
          <Row left="GET /healthz" right="503" />
          <Row left="GET /healthz" right="200 · 41 ms" active />
        </div>
      );
    case "route":
      return (
        <div className="grid gap-2">
          <Row left="api.acme.dev → 10.20.0.3:8080" right="new" active />
          <Row left="api.acme.dev → 10.20.0.3:8081" right="draining" />
        </div>
      );
    case "live":
      return (
        <div className="grid gap-2">
          <div className="flex items-center gap-2 rounded-md bg-surface px-3 py-2.5 text-[14px]">
            <LockIcon className="size-3.5 text-success" aria-hidden="true" />
            <code className="font-mono text-foreground">https://api.acme.dev</code>
            <span className="ml-auto text-[13px] text-success">200 OK</span>
          </div>
          <Row
            left={rolledBack ? "dep_5q1x  a91d03b" : "dep_7h2k  4f2c9e1"}
            right={rolledBack ? "serving · rolled back" : "serving"}
            active
          />
          <Row left={rolledBack ? "dep_7h2k  4f2c9e1" : "dep_5q1x  a91d03b"} right="standby" />
        </div>
      );
  }
}

function StageCard({
  index,
  rolledBack,
  onRollback,
  fixed = false,
  headingLevel = "p",
}: {
  index: number;
  rolledBack: boolean;
  onRollback: (value: boolean) => void;
  /** Keep one height for every stop (the pinned scene). */
  fixed?: boolean;
  /** Render the stop name as a heading in the stacked list. */
  headingLevel?: "p" | "h3";
}) {
  const stage = STAGES[index] ?? STAGES[0]!;
  const isLive = stage.id === "live";
  const switchId = useId();
  const Name = headingLevel;
  return (
    <div
      data-ui
      data-testid={fixed ? "stage-card" : undefined}
      className={cn(
        "flex min-w-0 flex-col gap-5 overflow-hidden rounded-xl bg-[var(--lp-step)] p-5 font-sans sm:p-7",
        fixed && "h-[490px]",
      )}
    >
      <div key={`${stage.id}-head`} className="lp-fade grid gap-2">
        <div className="flex items-baseline justify-between gap-4">
          <Name className="text-[24px] font-semibold tracking-[-0.02em] text-foreground">
            {stage.label}
          </Name>
          <span className="shrink-0 text-[14px] text-muted-foreground">{stage.where}</span>
        </div>
        <p className="max-w-[52ch] text-[17px] text-foreground">{stage.detail}</p>
      </div>
      <div key={`${stage.id}-${rolledBack}`} className="lp-fade">
        <StageVisual id={stage.id} rolledBack={rolledBack} />
      </div>
      <div
        className={cn(
          "rounded-lg bg-[#08090a] p-4 text-[#e8eaed]",
          fixed ? "min-h-0 flex-1 overflow-hidden" : "min-h-[96px]",
        )}
      >
        <Log
          key={`${stage.id}-${rolledBack}`}
          lines={isLive && rolledBack ? ROLLBACK_LOG : stage.log}
        />
      </div>
      {isLive ? (
        <label
          htmlFor={switchId}
          className="flex cursor-pointer items-center justify-between gap-3 text-[14px]"
        >
          <span className="text-foreground">Roll back to dep_5q1x</span>
          <button
            id={switchId}
            type="button"
            role="switch"
            aria-checked={rolledBack}
            onClick={() => onRollback(!rolledBack)}
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              rolledBack ? "bg-accent" : "bg-meter-track",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-5 rounded-full bg-foreground transition-transform",
                rolledBack ? "translate-x-[22px] bg-accent-foreground" : "translate-x-[2px]",
              )}
            />
          </button>
        </label>
      ) : null}
    </div>
  );
}

function Stops({ active, onSelect }: { active: number; onSelect: (index: number) => void }) {
  const statuses = stageStatuses(active);
  const fill = STAGES.length > 1 ? active / (STAGES.length - 1) : 0;
  return (
    <ol aria-label="Stops from push to live" className="relative grid">
      <span
        aria-hidden="true"
        className="absolute top-[22px] bottom-[22px] left-[7px] w-0.5 rounded-full bg-meter-track"
      />
      <span
        aria-hidden="true"
        className="absolute top-[22px] left-[7px] w-0.5 rounded-full bg-accent transition-[height] duration-300"
        style={{ height: `calc((100% - 44px) * ${fill})` }}
      />
      {STAGES.map((stage, index) => {
        const status = statuses[index];
        return (
          <li key={stage.id}>
            <button
              type="button"
              onClick={() => onSelect(index)}
              aria-current={status === "active" ? "step" : undefined}
              data-stage={stage.id}
              data-status={status}
              className={cn(
                "group relative flex min-h-11 w-full cursor-pointer items-center gap-4 rounded-md pr-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                status === "active" && "bg-[var(--lp-step)]",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "relative z-10 ml-0 flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors duration-300",
                  status === "done" && "border-accent bg-accent",
                  status === "active" && "lp-pulse border-accent bg-background",
                  status === "pending" && "border-border-strong bg-background",
                )}
              />
              <span
                className={cn(
                  "text-[17px] transition-colors",
                  status === "active" ? "font-semibold text-foreground" : "",
                  status === "done" && "text-foreground",
                  status === "pending" && "text-muted-foreground group-hover:text-foreground",
                )}
              >
                {stage.label}
              </span>
              <span className="text-[14px] text-muted-foreground">{stage.where}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * "Push to live in eight stops" as a pinned scene: the header, the stop list and one stage
 * card are held together while scroll progress walks the stops. Phones and reduced motion
 * get the finished composition: the header, then every stop's card in order.
 *
 * @param props - Whether reduced motion is on.
 * @returns The section.
 */
export function PipelineScene({ reducedMotion }: { reducedMotion: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  useRevealOnce(ref);
  const wide = useMediaQuery("(min-width: 1024px)");
  const live = wide && !reducedMotion;
  const [progress, setProgress] = useState(0);
  const [rolledBack, setRolledBack] = useState(false);
  const active = stageAtProgress(progress);

  useEffect(() => {
    if (!live) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const element = trackRef.current;
      if (!element) return;
      const box = element.getBoundingClientRect();
      const offset = headerHeight();
      setProgress(trackProgress(box.top - offset, box.height, window.innerHeight - offset));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [live]);

  const jumpTo = (index: number) => {
    const element = trackRef.current;
    if (!element) return;
    const offset = headerHeight();
    const top = element.getBoundingClientRect().top + window.scrollY - offset;
    const distance = element.offsetHeight - (window.innerHeight - offset);
    window.scrollTo({ top: top + progressForStage(index) * distance, behavior: "smooth" });
  };

  const header = (
    <div className="grid gap-5 lg:grid-cols-12 lg:items-end lg:gap-[var(--lp-gap)]">
      <h2 id="deploys-title" className="lp-heading lg:col-span-6">
        Push to live in eight stops
      </h2>
      <p className="max-w-[46ch] text-foreground lg:col-span-5 lg:col-start-8">
        Your builder node builds the image, R2 in your account stores it, and the agent starts it
        behind Caddy once it is healthy. A rollback skips straight to the image you already have.
      </p>
    </div>
  );

  if (!live) {
    return (
      <section
        ref={ref}
        id="deploys"
        aria-labelledby="deploys-title"
        className="lp-section lp-wrap scroll-mt-16"
        data-testid="pipeline"
        data-mode="rest"
      >
        <div data-reveal>{header}</div>
        <ol aria-label="Stops from push to live" className="mt-12 grid gap-4 md:grid-cols-2">
          {STAGES.map((stage, index) => (
            <li
              key={stage.id}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)]"
              data-stage={stage.id}
            >
              <StageCard
                index={index}
                rolledBack={rolledBack}
                onRollback={setRolledBack}
                headingLevel="h3"
              />
            </li>
          ))}
        </ol>
      </section>
    );
  }

  const stage = STAGES[active] ?? STAGES[0]!;
  return (
    <section
      ref={ref}
      id="deploys"
      aria-labelledby="deploys-title"
      className="scroll-mt-[var(--lp-header-h)] pt-[var(--lp-space)]"
      data-testid="pipeline"
      data-mode="live"
      data-active={stage.id}
    >
      <div
        ref={trackRef}
        className="lp-scene scene is-live"
        data-scene="pipeline"
        style={{ "--hold": HOLD } as CSSProperties}
      >
        {/* The header, the stops and the card live in the held stage, so the reader always
            sees what the scene is while it advances. */}
        <div className="lp-scene-stage" data-testid="pipeline-stage">
          <div className="lp-wrap grid h-full content-center gap-[clamp(24px,5svh,56px)] py-6">
            {header}
            <div className="grid grid-cols-12 items-start gap-[var(--lp-gap)]">
              <div className="col-span-4">
                <Stops active={active} onSelect={jumpTo} />
              </div>
              <div className="col-span-8">
                <StageCard
                  index={active}
                  rolledBack={rolledBack}
                  onRollback={setRolledBack}
                  fixed
                />
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {`${stage.label}: ${stage.detail}`}
      </p>
    </section>
  );
}
