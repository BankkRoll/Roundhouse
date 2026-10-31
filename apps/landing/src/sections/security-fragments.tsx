/**
 * Pictures for the security section, made from the product's own interface: the agent's
 * log, a service's variables and the instance audit log. Each mirrors a real screen or
 * real output (the agent's log messages in `agent/internal/conn/conn.go`, the variables
 * tab and the instance audit page in `apps/web`) with sample names and values.
 *
 * @module
 */
import { Badge, cn } from "@roundhouse/ui";
import { CircleCheckIcon, LinkIcon, ShieldCheckIcon } from "lucide-react";
import type { CSSProperties } from "react";

// NOTE: Every fragment here is marked data-ui and reproduces the dashboard's own chrome,
// whose rules and borders are part of the interface being shown.
const FRAME = "overflow-hidden rounded-lg border border-border bg-background font-sans text-[13px]"; // taste-skill-ignore
const BAR = "flex items-center justify-between gap-3 border-b border-border px-4 py-3"; // taste-skill-ignore
const RULE_TOP = "border-t border-border"; // taste-skill-ignore
const ROW_RULE = "border-b border-border/70 last:border-b-0"; // taste-skill-ignore
const HEAD_RULE = "border-b border-border"; // taste-skill-ignore

type LogLevel = "INFO" | "WARN";

/** Lines the agent prints, with the attributes it logs; see `conn.go`. */
const AGENT_LOG: readonly [time: string, level: LogLevel, message: string, attrs: string][] = [
  [
    "09:14:02",
    "INFO",
    "connected to control plane",
    "url=wss://cp.example.com/v1/nodes/node_7f3k/connect",
  ],
  ["09:14:02", "INFO", "pinned control plane key id", "kid=k1"],
  ["09:14:02", "INFO", "welcomed by control plane", "msg_id=msg_0a1c"],
  ["09:16:40", "INFO", "received desired state", "msg_id=msg_0a2f generation=42 workload_count=3"],
  ["09:16:41", "WARN", "dropping control frame", "reason=bad_signature kid=k1"],
  ["09:16:44", "WARN", "dropping control frame", "reason=replayed kid=k1 msg_id=msg_0a2f"],
  ["09:17:05", "WARN", "dropping control frame", "reason=expired kid=k1"],
];

/**
 * The agent's own log on one server: it dialed out, pinned the control plane's key and
 * applied a signed command, then dropped a forged one, a replayed one and an expired one.
 *
 * @returns The fragment.
 */
export function AgentLogFragment() {
  return (
    <figure data-ui className={FRAME}>
      <div className={BAR}>
        <span className="font-medium text-foreground">home-nuc · roundhouse-agent</span>
        <span className="inline-flex items-center gap-1.5 text-success">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
          connected
        </span>
      </div>
      <pre className="overflow-x-auto px-4 py-4 font-mono text-[12.5px] leading-[1.8]">
        <code>
          {AGENT_LOG.map(([time, level, message, attrs], index) => (
            <span
              key={`${time}-${message}-${attrs}`}
              className="lp-line-in block whitespace-pre-wrap break-all"
              style={{ "--i": index } as CSSProperties}
            >
              <span className="text-muted-foreground">{time} </span>
              <span className={level === "WARN" ? "text-warning" : "text-success"}>{level} </span>
              <span className="text-foreground">{message} </span>
              <span className={cn(level === "WARN" ? "text-warning" : "text-muted-foreground")}>
                {attrs}
              </span>
            </span>
          ))}
        </code>
      </pre>
      <figcaption className={cn(RULE_TOP, "px-4 py-3 text-muted-foreground")}>
        A forged, a replayed and an expired command, each dropped before it ran.
      </figcaption>
    </figure>
  );
}

const MASK = "••••••••";

const VARIABLES: readonly {
  key: string;
  secret: boolean;
  value: string;
  badges?: readonly ("build" | "file")[];
}[] = [
  { key: "DATABASE_URL", secret: true, value: "fp 3f9a1c0e" },
  { key: "STRIPE_SECRET_KEY", secret: true, value: "fp 9b27d4aa" },
  { key: "SESSION_SECRET", secret: true, value: "fp 51e08c3b", badges: ["file"] },
  { key: "NPM_TOKEN", secret: true, value: "fp c4d2e719", badges: ["build"] },
  { key: "LOG_LEVEL", secret: false, value: "info" },
];

function VariableRow({
  row,
  withheld = false,
}: {
  row: (typeof VARIABLES)[number];
  withheld?: boolean;
}) {
  return (
    <li
      className={cn(
        ROW_RULE,
        "grid gap-x-4 gap-y-1 px-4 py-2.5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className="truncate font-mono text-xs text-foreground">{row.key}</code>
        {row.secret ? <Badge>secret</Badge> : null}
        {row.badges?.map((badge) => (
          <Badge key={badge}>{badge}</Badge>
        ))}
        {withheld ? <Badge tone="info">Withheld from preview</Badge> : null}
      </div>
      <code className="block min-w-0 truncate font-mono text-xs">
        {row.secret ? (
          <>
            <span aria-hidden="true" className="tracking-widest text-subtle-foreground">
              {MASK}
            </span>
            <span className="sr-only">value hidden</span>
            {withheld ? null : <span className="ml-2 text-muted-foreground">{row.value}</span>}
          </>
        ) : (
          <span className="text-muted-foreground">{row.value}</span>
        )}
      </code>
    </li>
  );
}

/**
 * A service's variables as the dashboard lists them: secrets masked and told apart by
 * fingerprint, and the same service's preview of a fork pull request with its secret
 * withheld.
 *
 * @returns The fragment.
 */
export function VariablesFragment() {
  const forkRow = VARIABLES[1];
  return (
    <div className="grid gap-3">
      <div data-ui className={FRAME}>
        <div className={BAR}>
          <span className="font-medium text-foreground">api · production · Variables</span>
        </div>
        <ul>
          {VARIABLES.map((row) => (
            <VariableRow key={row.key} row={row} />
          ))}
        </ul>
        <p className={cn(RULE_TOP, "px-4 py-3 text-muted-foreground")}>
          Secrets can never be shown again, not to you and not to admins. You can replace them, and
          fingerprints tell values apart.
        </p>
      </div>
      {forkRow ? (
        <div data-ui className={FRAME}>
          <div className={BAR}>
            <span className="font-medium text-foreground">api · pr-128 · Variables</span>
            <span className="text-muted-foreground">from a fork</span>
          </div>
          <ul>
            <VariableRow row={forkRow} withheld />
          </ul>
        </div>
      ) : null}
    </div>
  );
}

const AUDIT: readonly [action: string, actor: string, seq: number, time: string][] = [
  ["auth.reauthenticated", "Dana Okafor", 1284, "1 min ago"],
  ["instance.key_rotation_started", "Dana Okafor", 1283, "2 min ago"],
  ["node.join_token_created", "Dana Okafor", 1282, "6 min ago"],
  ["auth.two_factor_enabled", "Sam Reyes", 1281, "1 h ago"],
  ["auth.account_locked", "Sam Reyes", 1280, "1 h ago"],
  ["auth.sign_in_failed", "Sam Reyes", 1279, "1 h ago"],
];

/**
 * The instance audit log after "Verify chain": the result line and the newest sealed
 * entries, each with its sequence number.
 *
 * @returns The fragment.
 */
export function AuditFragment() {
  return (
    <div data-ui className={cn(FRAME, "p-4")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[16px] font-semibold text-foreground">Instance audit log</span>
        <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-strong bg-muted px-3 font-medium text-foreground">
          <LinkIcon className="size-3.5" aria-hidden="true" />
          Verify chain
        </span>
      </div>
      <p className="mt-4 flex items-start gap-2 rounded-md border border-success/30 bg-success/10 p-3 text-foreground">
        <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
        <span>
          Chain intact: 1284 entries checked up to #1284, against 21 checkpoints kept outside the
          database.
        </span>
      </p>
      <table className="mt-4 w-full text-left">
        <caption className="sr-only">Newest instance audit entries</caption>
        <thead className="text-muted-foreground">
          <tr className={HEAD_RULE}>
            <th scope="col" className="py-2 pr-3 font-normal">
              Action
            </th>
            <th scope="col" className="hidden py-2 pr-3 font-normal sm:table-cell">
              Actor
            </th>
            <th scope="col" className="py-2 pr-3 font-normal">
              Entry
            </th>
            <th scope="col" className="py-2 text-right font-normal">
              Time
            </th>
          </tr>
        </thead>
        <tbody>
          {AUDIT.map(([action, actor, seq, time]) => (
            <tr key={seq} className={ROW_RULE}>
              <td className="max-w-0 truncate py-2 pr-3 text-foreground sm:max-w-none">
                <code className="font-mono text-xs">{action}</code>
              </td>
              <td className="hidden py-2 pr-3 text-foreground sm:table-cell">{actor}</td>
              <td className="py-2 pr-3 text-muted-foreground">
                <span className="inline-flex items-center gap-1 text-xs tabular-nums">
                  #{seq}
                  <CircleCheckIcon
                    className="size-3.5 text-success"
                    aria-label="Sealed"
                    role="img"
                  />
                </span>
              </td>
              <td className="py-2 text-right whitespace-nowrap text-muted-foreground tabular-nums">
                {time}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The dashboard's response headers, verbatim from `apps/web/public/_headers`. */
const HEADERS: readonly [name: string, value: string][] = [
  [
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com; object-src 'none'",
  ],
  ["x-frame-options", "DENY"],
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "no-referrer"],
  ["permissions-policy", "camera=(), microphone=(), geolocation=()"],
  ["server", "cloudflare"],
];

/**
 * What the dashboard answers with, as a terminal shows it: served by Cloudflare, with a
 * policy that allows only its own scripts and no framing.
 *
 * @returns The fragment.
 */
export function HeadersFragment() {
  return (
    <figure data-ui className={FRAME}>
      <div className={BAR}>
        <span className="font-medium text-foreground">Terminal</span>
        <span className="text-muted-foreground">your control plane</span>
      </div>
      <pre className="overflow-x-auto px-4 py-4 font-mono text-[12.5px] leading-[1.8]">
        <code>
          <span className="block text-muted-foreground">
            <span aria-hidden="true">$ </span>curl -sI https://cp.example.com/
          </span>
          <span className="block text-success">HTTP/2 200</span>
          {HEADERS.map(([name, value], index) => (
            <span
              key={name}
              className="lp-line-in block whitespace-pre-wrap break-all"
              style={{ "--i": index } as CSSProperties}
            >
              <span className="text-foreground">{name}:</span>{" "}
              <span className="text-muted-foreground">{value}</span>
            </span>
          ))}
        </code>
      </pre>
      <figcaption className={cn(RULE_TOP, "px-4 py-3 text-muted-foreground")}>
        Served from your Cloudflare account. No server of yours runs the dashboard.
      </figcaption>
    </figure>
  );
}
