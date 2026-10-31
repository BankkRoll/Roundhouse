import { cn } from "@roundhouse/ui";
import type { CSSProperties, ReactNode } from "react";
import { SECURITY_POLICY_URL, SECURITY_REVIEW_URL, SECURITY_URL, sourceUrl } from "../links";
import { type Defence, type DefenceGroup, defencesIn } from "../model/defences";
import { buttonClass, ExternalLink, Section } from "../ui";
import { AdvisoryExplorer } from "./advisory-table";
import {
  AgentLogFragment,
  AuditFragment,
  HeadersFragment,
  VariablesFragment,
} from "./security-fragments";

const step = (i: number) => ({ "--i": i }) as CSSProperties;

const BLOCK_TITLE = "text-[clamp(28px,2.6vw,38px)] font-semibold leading-[1.08] tracking-[-0.03em]";

const QUIET_LINK =
  "rounded-sm text-[16px] text-muted-foreground underline decoration-muted-foreground/60 underline-offset-4 outline-none transition-colors hover:text-foreground hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** One defence: what it does, and a link to the code that does it. */
function DefenceRow({ item, index }: { item: Defence; index: number }) {
  return (
    <li
      id={`defence-${item.id}`}
      className="grid scroll-mt-28 content-start gap-2"
      data-reveal
      style={step(index + 2)}
    >
      <h4 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-foreground">
        {item.title}
      </h4>
      <p className="text-[17px] text-foreground">
        {item.body}{" "}
        <ExternalLink
          href={sourceUrl(item.evidence)}
          className={QUIET_LINK}
          aria-label={`See the code: ${item.title}`}
        >
          See the code
        </ExternalLink>
      </p>
    </li>
  );
}

/** The step-toned field a product picture sits on. */
function Mount({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg bg-[var(--lp-step)] p-4 sm:p-8 xl:p-12" data-reveal style={step(1)}>
      {children}
    </div>
  );
}

/**
 * One group of defences: its heading and one sentence beside a picture from the product,
 * then each defence in columns underneath.
 */
function DefenceGroupBlock({
  group,
  title,
  lead,
  picture,
  flip = false,
  className,
}: {
  group: DefenceGroup;
  title: string;
  lead: string;
  picture: ReactNode;
  /** Put the picture on the left. */
  flip?: boolean;
  className?: string;
}) {
  const items = defencesIn(group);
  return (
    <div className={cn("mt-[calc(var(--lp-space)*1.6)]", className)}>
      <div className="grid items-center gap-10 lg:grid-cols-12 lg:gap-[var(--lp-gap)]">
        <div className={cn("lg:col-span-5", flip && "lg:order-2 lg:col-start-8")}>
          <h3 id={`security-${group}`} className={BLOCK_TITLE} data-reveal>
            {title}
          </h3>
          <p className="lp-lead mt-5 max-w-[36ch] text-foreground" data-reveal style={step(1)}>
            {lead}
          </p>
        </div>
        <div
          className={cn(
            "lg:col-span-7",
            flip ? "lg:order-1 lg:col-start-1 lg:row-start-1" : "lg:col-start-6",
          )}
        >
          <Mount>{picture}</Mount>
        </div>
      </div>
      <ul
        className={cn(
          "mt-14 grid gap-x-[var(--lp-gap)] gap-y-10 sm:grid-cols-2",
          items.length % 3 === 0 ? "lg:grid-cols-3" : "xl:grid-cols-4",
        )}
      >
        {items.map((item, index) => (
          <DefenceRow key={item.id} item={item} index={index} />
        ))}
      </ul>
    </div>
  );
}

// A real table: its row rules are part of reading it across.
const REVIEW_ROW = "border-t border-[var(--lp-step-2)] align-top"; // taste-skill-ignore

/** What the October 2026 review found, as `docs/security/review-2026-10.md` lists it. */
const REVIEW_FINDINGS: readonly [severity: string, finding: string, status: string][] = [
  ["Medium", "A developer could copy a protected environment's secrets out of it", "Fixed"],
  ["Low", "Shell recordings could be watched before turning on two-factor", "Fixed"],
  ["Low", "An API token could create a child token that outlived it", "Fixed"],
  ["Low", "A captured command could be replayed before it expired", "Fixed"],
  ["Low", "The file decryptor accepted malformed headers", "Fixed"],
  ["Info", "A cipher counter could wrap, though nothing reached it", "Fixed"],
  ["Info", "A dependency advisory in a tool that never runs in production", "Accepted"],
  ["Info", "Go dependency scan: nothing reachable", "No action"],
];

function ReviewTable() {
  return (
    <table className="mt-8 w-full text-left text-[16px]">
      <caption className="sr-only">Findings of the October 2026 security review</caption>
      <thead className="text-muted-foreground">
        <tr>
          <th scope="col" className="py-2 pr-4 font-normal">
            Severity
          </th>
          <th scope="col" className="py-2 pr-4 font-normal">
            Finding
          </th>
          <th scope="col" className="py-2 text-right font-normal">
            Status
          </th>
        </tr>
      </thead>
      <tbody>
        {REVIEW_FINDINGS.map(([severity, finding, status]) => (
          <tr key={finding} className={REVIEW_ROW}>
            <td className="py-3 pr-4 text-muted-foreground">{severity}</td>
            <th scope="row" className="py-3 pr-4 font-normal text-foreground">
              {finding}
            </th>
            <td
              className={cn(
                "py-3 text-right whitespace-nowrap",
                status === "Fixed" ? "text-success" : "text-muted-foreground",
              )}
            >
              {status}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * "Secure by the way it's built": the design choices that keep a self-hosted install
 * safe, grouped by what they protect, each group with a picture from the product and
 * each choice with a link to its code; then published advisories from comparable
 * platforms, filterable by kind of flaw against those choices; then how to report a
 * vulnerability and what the last review found.
 *
 * @returns The section.
 */
export function SecuritySection() {
  return (
    <Section id="security" labelledBy="security-title">
      <div className="grid gap-6 lg:grid-cols-12 lg:gap-[var(--lp-gap)]">
        <h2 id="security-title" className="lp-heading lg:col-span-6" data-reveal>
          Secure by the way it's built
        </h2>
        <p
          className="max-w-[44ch] self-end text-[17px] text-foreground lg:col-span-6"
          data-reveal
          style={step(1)}
        >
          A deploy platform holds the keys to every server and secret you give it. Roundhouse is
          built so a forged message, a leaked password or a stolen session reaches as little as
          possible. Each claim below links to the code that makes it true.
        </p>
      </div>

      <DefenceGroupBlock
        group="servers"
        title="Servers only take signed orders"
        lead="The agent on each server acts on nothing it can't verify, and here is its own log saying so."
        picture={<AgentLogFragment />}
        className="mt-[calc(var(--lp-space)*0.9)]"
      />
      <DefenceGroupBlock
        group="secrets"
        title="Secrets you can set, not read"
        lead="Once a secret is saved, only the server that runs or builds your app can use it."
        picture={<VariablesFragment />}
        flip
      />
      <DefenceGroupBlock
        group="account"
        title="Guarded sign-ins, honest history"
        lead="The people who can change the most have to prove it the most, and their changes land in a record that shows tampering."
        picture={<AuditFragment />}
      />
      <DefenceGroupBlock
        group="control-plane"
        title="Less control plane to attack"
        lead="Your dashboard is a Worker in your own Cloudflare account, strict about what it trusts."
        picture={<HeadersFragment />}
        flip
      />

      <div className="mt-[calc(var(--lp-space)*1.6)]">
        <div className="grid gap-6 lg:grid-cols-12 lg:gap-[var(--lp-gap)]">
          <h3 id="security-elsewhere" className="lp-heading lg:col-span-6" data-reveal>
            What went wrong elsewhere
          </h3>
          <p
            className="max-w-[52ch] self-end text-[17px] text-foreground lg:col-span-6"
            data-reveal
            style={step(1)}
          >
            Self-hosted deploy platforms control every server they deploy to, so their flaws are
            serious. These are published advisories for comparable platforms, matched against the
            choices above.
          </p>
        </div>
        <div className="mt-12">
          <AdvisoryExplorer />
        </div>
      </div>

      <div
        className={cn(
          "mt-[calc(var(--lp-space)*1.6)] grid gap-12 lg:grid-cols-12 lg:gap-[var(--lp-gap)]",
          "rounded-lg bg-[var(--lp-step)] px-5 py-10 sm:p-10 lg:p-14",
        )}
      >
        <div className="lg:col-span-5">
          <h3 id="security-report" className="lp-heading" data-reveal>
            Found a hole? Tell us privately
          </h3>
          <p className="mt-6 max-w-[42ch] text-[17px] text-foreground" data-reveal style={step(1)}>
            Report it through GitHub's private advisories, not a public issue. We aim to reply
            within three business days and to fix critical and high issues within 30 days, and we
            credit you in the advisory.
          </p>
          <div className="mt-8 grid justify-items-start gap-4" data-reveal style={step(2)}>
            <ExternalLink href={SECURITY_URL} className={buttonClass("primary")}>
              Report a vulnerability
            </ExternalLink>
            <ExternalLink href={SECURITY_POLICY_URL} className={QUIET_LINK}>
              Read the security policy
            </ExternalLink>
          </div>
        </div>
        <div className="lg:col-span-6 lg:col-start-7" data-reveal style={step(1)}>
          <h3 id="security-review" className={BLOCK_TITLE}>
            Reviewed in the open
          </h3>
          <p className="mt-6 max-w-[56ch] text-[17px] text-foreground">
            In October 2026 the code was read the way an attacker would read it. All eight findings
            are public with what was done about each, and the encryption code passes the RFC 8439
            and C2SP test vectors.
          </p>
          <ReviewTable />
          <ExternalLink href={SECURITY_REVIEW_URL} className={cn(QUIET_LINK, "mt-6 inline-block")}>
            Read the October 2026 review
          </ExternalLink>
        </div>
      </div>
    </Section>
  );
}
