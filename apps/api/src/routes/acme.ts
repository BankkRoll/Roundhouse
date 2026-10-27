/**
 * The public ACME HTTP-01 responder (ADR 0009): every ingress node's Caddy
 * proxies `http://<host>/.well-known/acme-challenge/<token>` for hostnames
 * it routes to `GET /v1/acme/http-01/{token}`, so whichever node a CA's
 * validation reaches answers for an order the control plane placed.
 *
 * SECURITY: unauthenticated by design. It reveals only key authorizations of
 * live HTTP-01 tokens, which ACME makes public anyway (RFC 8555 §8.3), and
 * answers 404 for anything else. Rate-limited per client IP (`ACME_LIMITER`,
 * 60 a minute).
 *
 * @module
 */
import { acmeChallenges } from "@roundhouse/db";
import { and, eq, gt } from "drizzle-orm";
import { clientIp, createRouter } from "../context";
import { HTTP01_PATH } from "../lib/certificates/manifest";
import { errorBody } from "../lib/errors";

/** RFC 8555 tokens: base64url, at least 128 bits. Anything else is never looked up. */
const TOKEN_RE = /^[A-Za-z0-9_-]{22,256}$/;

/** The HTTP-01 responder. */
export const acmeRoutes = createRouter().get(`${HTTP01_PATH}/:token`, async (c) => {
  const limiter = c.env.ACME_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: `acme:${clientIp(c) ?? "unknown"}` });
    if (!success) {
      c.header("retry-after", "60");
      return c.json(errorBody("rate_limited", "Too many requests; try again in a minute"), 429);
    }
  }
  const token = c.req.param("token");
  const notFound = () => c.text("Not found", 404);
  if (!TOKEN_RE.test(token)) return notFound();
  const [row] = await c
    .get("db")
    .select({ keyAuthorization: acmeChallenges.keyAuthorization })
    .from(acmeChallenges)
    .where(
      and(
        eq(acmeChallenges.token, token),
        eq(acmeChallenges.type, "http-01"),
        gt(acmeChallenges.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return notFound();
  c.header("cache-control", "no-store");
  c.header("content-type", "application/octet-stream");
  return c.body(row.keyAuthorization, 200);
});
