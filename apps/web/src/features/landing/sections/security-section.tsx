import { cn } from "@openrail/ui";
import { CheckIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { type CSSProperties, useEffect, useId, useState } from "react";
import { JOIN_TOKEN_MINUTES } from "../content";
import {
  type DemoEnvelope,
  demoEnvelope,
  ENVELOPE_FIXTURE,
  fixtureVerify,
  TAMPERED_IMAGE,
  type VerifyResult,
  verifyEnvelope,
} from "../model/envelope";
import { Section } from "../ui";

type Verification =
  | { state: "checking" }
  | { state: "done"; result: VerifyResult; simulated: boolean };

function useVerification(envelope: DemoEnvelope): Verification {
  const [verification, setVerification] = useState<Verification>({ state: "checking" });
  useEffect(() => {
    let cancelled = false;
    setVerification({ state: "checking" });
    const options = {
      publicKey: ENVELOPE_FIXTURE.publicKey,
      nodeId: ENVELOPE_FIXTURE.nodeId,
      now: Date.now(),
    };
    verifyEnvelope(envelope, options)
      .then((result) => ({ result, simulated: false }))
      // COMPAT: Older browsers lack Ed25519 in WebCrypto; fall back to the known answer.
      .catch(async () => ({
        result: await verifyEnvelope(envelope, { ...options, verify: fixtureVerify }),
        simulated: true,
      }))
      .then(({ result, simulated }) => {
        if (!cancelled) setVerification({ state: "done", result, simulated });
      });
    return () => {
      cancelled = true;
    };
  }, [envelope]);
  return verification;
}

const UNTOUCHED = demoEnvelope(false);
const TAMPERED = demoEnvelope(true);

function elide(value: string) {
  return value.length <= 72 ? value : `${value.slice(0, 24)}…${value.slice(-44)}`;
}

type CheckState = "pending" | "pass" | "fail" | "skipped";

function Check({ label, state, skipped }: { label: string; state: CheckState; skipped?: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
          state === "pass" && "border-success bg-success/15 text-success",
          state === "fail" && "border-danger bg-danger/15 text-danger",
          (state === "pending" || state === "skipped") && "border-border-strong",
        )}
      >
        {state === "pass" ? <CheckIcon className="size-2.5" strokeWidth={3} /> : null}
        {state === "fail" ? <XIcon className="size-2.5" strokeWidth={3} /> : null}
      </span>
      <span
        className={cn(
          state === "skipped" ? "text-muted-foreground line-through" : "text-foreground",
        )}
      >
        {label}
      </span>
      <span className="ml-auto shrink-0 text-muted-foreground">
        {state === "skipped" ? skipped : state === "pending" ? "…" : state}
      </span>
    </li>
  );
}

/**
 * The live thing: a real signed control message (the protocol's test fixture), verified
 * with Ed25519 in the visitor's browser. Tampering with it in transit gets it refused.
 *
 * @returns The fragment.
 */
export function EnvelopeDemo() {
  const [tampered, setTampered] = useState(false);
  const envelope = tampered ? TAMPERED : UNTOUCHED;
  const verification = useVerification(envelope);
  const switchId = useId();
  const result = verification.state === "done" ? verification.result : null;
  const accepted = result?.ok === true;
  const image = envelope.payload.match(/"image":"([^"]+)"/)?.[1] ?? "";
  const [before, after] = envelope.payload.split(image);
  const signature: CheckState = !result
    ? "pending"
    : result.ok || result.reason !== "bad_signature"
      ? "pass"
      : "fail";
  const later: CheckState = !result ? "pending" : result.ok ? "pass" : "skipped";

  return (
    <div
      data-ui
      className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg bg-background font-sans text-[13px]"
      data-testid="envelope-demo"
      data-result={result ? (result.ok ? "accepted" : "rejected") : "checking"}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <span className="text-muted-foreground">control plane → home-nuc</span>
        <label
          htmlFor={switchId}
          className="flex cursor-pointer items-center gap-2.5 text-foreground"
        >
          Tamper in transit
          <button
            id={switchId}
            type="button"
            role="switch"
            aria-checked={tampered}
            onClick={() => setTampered((value) => !value)}
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              tampered ? "bg-danger" : "bg-meter-track",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-5 rounded-full bg-foreground transition-transform",
                tampered ? "translate-x-[22px]" : "translate-x-[2px]",
              )}
            />
          </button>
        </label>
      </div>
      <pre className="overflow-x-auto px-4 py-4 font-mono text-[12.5px] leading-[1.75] text-muted-foreground">
        <code>
          {"{\n"}
          {'  "v": 1,\n'}
          {`  "kid": "${envelope.kid}",\n`}
          {'  "payload": "'}
          <span className="whitespace-pre-wrap break-all">
            {elide(before ?? "")}
            <span
              className={cn(
                "rounded-sm px-0.5",
                tampered ? "bg-danger/20 text-danger" : "bg-accent-subtle text-accent-text",
              )}
            >
              {image}
            </span>
            {after}
          </span>
          {'",\n'}
          {`  "sig": "${envelope.sig.slice(0, 18)}…${envelope.sig.slice(-6)}"\n`}
          {"}"}
        </code>
      </pre>
      <ol className="grid gap-2 border-t border-border px-4 py-3" aria-label="Agent checks">
        <Check label="Ed25519 signature over the exact bytes, pinned key" state={signature} />
        <Check label="Parse the payload" state={later} skipped="never parsed" />
        <Check
          label="Right node, not expired, newer generation"
          state={later}
          skipped="never reached"
        />
      </ol>
      <div
        role="status"
        className={cn(
          "mt-auto flex items-start gap-3 px-4 py-3",
          accepted && "bg-success/10",
          result && !accepted && "lp-shake bg-danger/10",
        )}
      >
        {result ? (
          accepted ? (
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
          ) : (
            <XIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
          )
        ) : null}
        <div className="min-w-0">
          <p
            className={cn(
              "font-mono font-semibold",
              accepted ? "text-success" : result ? "text-danger" : "text-muted-foreground",
            )}
          >
            {!result
              ? "Verifying…"
              : result.ok
                ? `ACCEPTED · applying generation ${result.generation} (${result.image})`
                : `REJECTED · ${result.reason} · frame dropped`}
          </p>
          <p className="mt-0.5 text-muted-foreground">
            {result && !result.ok
              ? `Swapping the image for ${TAMPERED_IMAGE} breaks the signature, so the agent drops the frame before reading it.`
              : "Verified just now in your browser with WebCrypto, against the protocol's real signed test message."}
            {verification.state === "done" && verification.simulated
              ? " (This browser lacks Ed25519, so the known result is shown.)"
              : ""}
          </p>
        </div>
      </div>
    </div>
  );
}

const CONNECTION = [
  ["Inbound control port", "none", "ok"],
  ["Control channel", "wss, dialed by the agent", "ok"],
  ["Connected for", "4 h 12 min", ""],
  ["Last heartbeat", "3 s ago", "ok"],
  ["Pinned signing key", "kid k1", ""],
  ["Applied generation", "42", ""],
  ["Join token", "used once, now void", ""],
] as const;

/**
 * The connection panel for one server, as the dashboard shows it: what is open, who dialed
 * whom, and which signed state it last applied.
 *
 * @returns The fragment.
 */
function ConnectionFragment() {
  return (
    <div
      data-ui
      className="flex h-full flex-col overflow-hidden rounded-lg bg-background font-sans text-[13px]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <span className="font-medium text-foreground">home-nuc · connection</span>
        <span className="inline-flex items-center gap-1.5 text-success">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
          online
        </span>
      </div>
      <dl className="grid flex-1 content-center">
        {CONNECTION.map(([label, value, tone]) => (
          <div
            key={label}
            className="flex items-baseline justify-between gap-4 border-b border-border px-4 py-2.5 last:border-b-0"
          >
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={cn("text-right", tone === "ok" ? "text-success" : "text-foreground")}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const FACTS = [
  [
    "No inbound port",
    "Agents dial out over WSS to their own Durable Object. Nothing on a server listens for commands, so it can sit behind NAT.",
  ],
  [
    "Signed commands",
    "Every control message is {v, kid, payload, sig}. The agent checks Ed25519 over the raw bytes, then parses.",
  ],
  [
    `${JOIN_TOKEN_MINUTES}-minute join tokens`,
    "A join token works once. The node credential it buys is stored only as a hash and can be revoked per server.",
  ],
  [
    "Encrypted at rest",
    "Keys come from your MASTER_KEY through HKDF-SHA256 and seal secrets with AES-GCM.",
  ],
  [
    "WireGuard between servers",
    "Private traffic between your servers rides an encrypted mesh, never the open internet.",
  ],
  [
    "Hardened plain Docker",
    "No Kubernetes and no gVisor: Docker with no-new-privileges, dropped capabilities and resource limits.",
  ],
] as const;

/**
 * "Only signed commands run": a board of tiles. The accent tile names the claim,
 * the large tile is the live envelope check, and the rest state the facts behind it.
 *
 * @returns The section.
 */
export function SecuritySection() {
  return (
    <Section id="security" labelledBy="security-title">
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <li
          className="flex min-h-[280px] flex-col justify-between rounded-lg bg-accent p-6 text-accent-foreground sm:col-span-2"
          data-reveal
        >
          <h2 id="security-title" className="lp-heading">
            Only signed commands run
          </h2>
          <p className="mt-6 max-w-[46ch] text-[17px]">
            Your servers never accept a connection from the control plane. They call it, and they
            refuse anything it did not sign. Flip the switch below to try.
          </p>
        </li>
        <li
          className="min-h-[280px] rounded-lg bg-[var(--lp-step)] p-4 sm:col-span-2 sm:p-6"
          data-reveal
          style={{ "--i": 1 } as CSSProperties}
        >
          <ConnectionFragment />
        </li>
        <li
          className="sm:col-span-2 lg:row-span-2"
          data-reveal
          style={{ "--i": 2 } as CSSProperties}
        >
          <EnvelopeDemo />
        </li>
        {FACTS.map(([title, body], index) => (
          <li
            key={title}
            className={cn(
              "flex flex-col gap-3 rounded-lg bg-[var(--lp-step)] p-6",
              index >= 4 && "lg:col-span-2",
            )}
            data-reveal
            style={{ "--i": 3 + index } as CSSProperties}
          >
            <h3 className="text-[24px] font-semibold leading-tight tracking-[-0.025em]">{title}</h3>
            <p className="text-[16px] text-foreground">{body}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
