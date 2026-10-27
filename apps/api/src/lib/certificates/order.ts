/**
 * One ACME order, from `newOrder` to the downloaded chain (ADR 0009,
 * "Orders"), written as named steps so `CertificateWorkflow` can persist
 * each one and resume after a restart, and tests can run the same code
 * inline. Storage-agnostic: challenges are made answerable by a
 * {@link ChallengeSolver} and the certificate key comes from a
 * {@link CertificateKeySource}, so the Pebble suite drives it without D1.
 *
 * Steps:
 * 1. `order`: places the order, with `replaces` on a renewal (RFC 9773 §5).
 * 2. `challenges`: picks each pending authorization's challenge and has the
 *    solver present it.
 * 3. `propagate-<n>` (DNS-01 only): waits until public DNS shows the TXT
 *    records, so the CA's first look succeeds.
 * 4. `respond`: tells the CA the challenges are ready.
 * 5. `poll-<n>`: waits for `ready` (or `invalid`, reported with the CA's
 *    reason per name).
 * 6. `finalize`: a CSR over the key source's key; then `poll-final-<n>`
 *    until `valid`.
 * 7. `download`: the chain, checked to name every requested hostname.
 *
 * @module
 */
import {
  type AcmeAuthorization,
  type AcmeClient,
  AcmeError,
  type AcmeOrder,
  createCsr,
  parseCertificateChain,
} from "../acme";

/** Persisted, resumable work: `CertificateWorkflow`'s `step`, or an inline runner. */
export interface Steps {
  /** Runs `fn` once; a resumed run gets the recorded result. Results must be JSON. */
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Waits without holding the isolate. */
  sleep(name: string, ms: number): Promise<void>;
}

/** Runs every step at once and skips sleeps; for tests and one-shot tools. */
export const inlineSteps: Steps = {
  do: (_name, fn) => fn(),
  sleep: async () => {},
};

/** One challenge to make answerable. */
export interface PresentedChallenge {
  type: "http-01" | "dns-01";
  token: string;
  /** The authorization's name, without `*.` for a wildcard. */
  identifier: string;
  wildcard: boolean;
  /** HTTP-01: the response body. */
  keyAuthorization: string;
  /** DNS-01: the TXT value. */
  dnsValue: string | null;
}

/** Makes challenges answerable and tidies up afterwards. */
export interface ChallengeSolver {
  /** Publishes one challenge; must be safe to repeat for the same token. */
  present(c: PresentedChallenge): Promise<void>;
  /** Whether the CA can see it yet (DNS propagation); HTTP-01 is visible at once. */
  visible(c: PresentedChallenge): Promise<boolean>;
}

/** The certificate's key pair, created once per order and reused on a retried finalize. */
export interface CertificateKeySource {
  keyPair(): Promise<CryptoKeyPair>;
}

/** What to order. */
export interface OrderRequest {
  hostnames: string[];
  challenge: "http-01" | "dns-01";
  /** ARI certificate ID of the certificate this renews. */
  replaces: string | null;
}

/** An order that ended without a certificate, with a reason safe to show. */
export class OrderFailedError extends Error {
  override name = "OrderFailedError";
}

/** Longest the CA gets to reach `ready` or `valid` before the attempt gives up. */
const POLLS = 40;
const MIN_POLL_MS = 2_000;
const MAX_POLL_MS = 30_000;
/** DNS-01 records get this many looks, {@link PROPAGATION_WAIT_MS} apart. */
const PROPAGATION_LOOKS = 30;
const PROPAGATION_WAIT_MS = 10_000;

interface PlacedOrder {
  url: string;
  finalize: string;
  authorizations: string[];
  status: AcmeOrder["status"];
}

const pollDelay = (client: AcmeClient) =>
  Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, client.lastRetryAfterMs ?? MIN_POLL_MS));

function describeProblem(p: { detail?: string; type?: string } | undefined): string {
  return (p?.detail || p?.type || "no reason given").slice(0, 300);
}

async function placeOrder(client: AcmeClient, req: OrderRequest): Promise<PlacedOrder> {
  const place = async (replaces: string | null) => {
    const o = await client.newOrder(req.hostnames, replaces ? { replaces } : {});
    return { url: o.url, finalize: o.finalize, authorizations: o.authorizations, status: o.status };
  };
  try {
    return await place(req.replaces);
  } catch (err) {
    // NOTE: a CA refuses `replaces` for a certificate already replaced or
    // unknown to it (RFC 9773 §5); the renewal then goes ahead as a plain
    // order, at the cost of the rate-limit exemption.
    if (
      req.replaces &&
      err instanceof AcmeError &&
      (err.is("alreadyReplaced") || err.is("malformed"))
    ) {
      return place(null);
    }
    throw err;
  }
}

function pickChallenge(authz: AcmeAuthorization, type: "http-01" | "dns-01") {
  const c = authz.challenges.find((ch) => ch.type === type);
  if (!c) {
    throw new OrderFailedError(
      `The CA offered no ${type} challenge for ${authz.identifier.value}.`,
    );
  }
  return c;
}

async function failureReason(client: AcmeClient, order: PlacedOrder, o: AcmeOrder) {
  const reasons: string[] = [];
  for (const url of order.authorizations) {
    const a = await client.getAuthorization(url).catch(() => null);
    if (!a || a.status === "valid") continue;
    const failed = a.challenges.find((c) => c.status === "invalid" && c.error);
    const name = `${a.wildcard ? "*." : ""}${a.identifier.value}`;
    reasons.push(`${name}: ${describeProblem(failed?.error ?? { type: a.status })}`);
  }
  return reasons.length ? reasons.join("; ") : describeProblem(o.error);
}

async function pollUntil(
  client: AcmeClient,
  steps: Steps,
  order: PlacedOrder,
  prefix: string,
  done: (o: AcmeOrder) => boolean,
): Promise<AcmeOrder> {
  for (let i = 0; i < POLLS; i++) {
    const o = await steps.do(`${prefix}-${i}`, () => client.getOrder(order.url));
    if (o.status === "invalid") {
      const reason = await steps.do(`${prefix}-reason`, () => failureReason(client, order, o));
      throw new OrderFailedError(`The CA refused the order: ${reason}`);
    }
    if (done(o)) return o;
    await steps.sleep(`${prefix}-wait-${i}`, pollDelay(client));
  }
  throw new OrderFailedError("The CA didn't finish the order in time; it will be retried.");
}

/**
 * Runs one order to its chain.
 *
 * @param deps - The account's client, the solver, the key source and the step runner.
 * @param req - Names, challenge type and the certificate being replaced.
 * @returns The PEM chain, leaf first.
 * @throws {OrderFailedError} When the CA refuses or the order stalls.
 */
export async function runOrder(
  deps: {
    client: AcmeClient;
    solver: ChallengeSolver;
    key: CertificateKeySource;
    steps: Steps;
  },
  req: OrderRequest,
): Promise<{ chainPem: string; orderUrl: string }> {
  const { client, solver, key, steps } = deps;
  const order = await steps.do("order", () => placeOrder(client, req));

  const challenges = await steps.do("challenges", async () => {
    const out: (PresentedChallenge & { url: string })[] = [];
    for (const url of order.authorizations) {
      const authz = await client.getAuthorization(url);
      if (authz.status === "valid") continue;
      if (authz.status !== "pending") {
        throw new OrderFailedError(
          `The authorization for ${authz.identifier.value} is ${authz.status}.`,
        );
      }
      const c = pickChallenge(authz, req.challenge);
      const presented: PresentedChallenge = {
        type: req.challenge,
        token: c.token,
        identifier: authz.identifier.value,
        wildcard: authz.wildcard === true,
        keyAuthorization: await client.keyAuthorization(c.token),
        dnsValue: req.challenge === "dns-01" ? await client.dns01Value(c.token) : null,
      };
      await solver.present(presented);
      out.push({ ...presented, url: c.url });
    }
    return out;
  });

  if (challenges.some((c) => c.type === "dns-01")) {
    for (let i = 0; ; i++) {
      const seen = await steps.do(`propagate-${i}`, async () => {
        for (const c of challenges) if (!(await solver.visible(c))) return false;
        return true;
      });
      if (seen) break;
      if (i + 1 >= PROPAGATION_LOOKS) {
        throw new OrderFailedError(
          "The DNS-01 TXT record never became visible in public DNS; check the zone and any _acme-challenge CNAME.",
        );
      }
      await steps.sleep(`propagate-wait-${i}`, PROPAGATION_WAIT_MS);
    }
  }

  if (challenges.length) {
    await steps.do("respond", async () => {
      for (const c of challenges) await client.respondToChallenge(c.url);
      return true;
    });
  }

  const ready = await pollUntil(client, steps, order, "poll", (o) =>
    ["ready", "processing", "valid"].includes(o.status),
  );

  if (ready.status === "ready") {
    await steps.do("finalize", async () => {
      const csr = await createCsr(await key.keyPair(), req.hostnames);
      const o = await client.finalize(order.finalize, csr);
      return o.status;
    });
  }
  const valid = await pollUntil(client, steps, order, "poll-final", (o) => o.status === "valid");
  if (!valid.certificate)
    throw new OrderFailedError("The CA marked the order valid without a certificate.");
  const certificateUrl = valid.certificate;

  const chainPem = await steps.do("download", async () => {
    const pem = await client.downloadCertificate(certificateUrl);
    const leaf = parseCertificateChain(pem);
    // The CA certifies exactly the names ordered, wildcards included.
    const missing = req.hostnames.filter((h) => !leaf.subjectAltNames.includes(h));
    if (missing.length) {
      throw new OrderFailedError(`The issued certificate doesn't name ${missing.join(", ")}.`);
    }
    return pem;
  });
  return { chainPem, orderUrl: order.url };
}
