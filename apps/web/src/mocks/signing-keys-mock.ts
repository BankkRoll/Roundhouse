/**
 * MSW handlers for the signing-key rollover routes (`apps/api/src/routes/signing-keys.ts`)
 * against {@link db}. Scheduling announces the new key to online servers at once; pending
 * ones learn it when they connect. `not_before` is honoured by the clock, so tests move it
 * into the past to make a rollover due.
 *
 * @module
 */
import { HttpResponse, http } from "msw";
import { KEY_ROUTES } from "../../../api/src/contracts";
import type { NodeSigningKeys, SigningKeyStatus } from "../lib/api/deploy-types";
import { apiError, currentUser, invalid, notFound, unauthorized } from "./common";
import { db } from "./db";

const path = (name: keyof typeof KEY_ROUTES) =>
  `*${KEY_ROUTES[name].path.replace(/\{([^}]+)\}/g, ":$1")}`;

const conflict = (message: string) => apiError(409, "conflict", message);

function requireAdmin(): Response | null {
  const user = currentUser();
  if (!user) return unauthorized();
  if (!user.instance_admin) {
    return apiError(403, "forbidden", "Only instance admins can perform instance:manage");
  }
  return null;
}

function pinsOf(node: (typeof db.nodes)[number]): string[] | null {
  const keys = db.signingKeys;
  if (keys.pins[node.id]) return keys.pins[node.id] ?? null;
  return node.status === "pending" ? null : [keys.current.kid];
}

function stateOf(node: (typeof db.nodes)[number]): NodeSigningKeys["state"] {
  const keys = db.signingKeys;
  const pins = pinsOf(node);
  if (keys.next) {
    if (pins?.includes(keys.next.kid)) return "ready";
    if (pins && !pins.includes(keys.current.kid)) return "rejoin_required";
    return node.status === "pending" ? "unknown" : "pending";
  }
  if (!pins) return "unknown";
  return pins.includes(keys.current.kid) ? "ready" : "rejoin_required";
}

/** The status as `GET /v1/instance/signing-keys` returns it. */
export function signingKeyStatus(now = Date.now()): SigningKeyStatus {
  const keys = db.signingKeys;
  const due = keys.next ? now >= keys.next.not_before : false;
  return {
    current: keys.current,
    signing_kid: keys.next && due ? keys.next.kid : keys.current.kid,
    next: keys.next && { ...keys.next, due },
    retired: keys.retired,
    nodes: db.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      workspace_id: node.workspace_id,
      protocol_version: 5,
      connected: node.status === "online" || node.status === "degraded",
      pinned_kids: pinsOf(node),
      state: stateOf(node),
    })),
  };
}

let sequence = 0;

/** Handlers for every signing-key route. */
export const signingKeyHandlers = [
  http.get(path("getSigningKeyStatus"), () => {
    const denied = requireAdmin();
    return denied ?? HttpResponse.json(signingKeyStatus());
  }),

  http.post(path("scheduleSigningKeyRollover"), async ({ request }) => {
    const denied = requireAdmin();
    if (denied) return denied;
    const body = (await request.json().catch(() => null)) as { delay_hours?: unknown } | null;
    const hours = body?.delay_hours ?? 24;
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > 720) {
      return invalid("delay_hours: Number must be an integer from 1 to 720");
    }
    const keys = db.signingKeys;
    if (keys.next) return conflict("A signing key rollover is already scheduled");
    const now = Date.now();
    sequence += 1;
    keys.next = {
      kid: `kmocknext${sequence}`,
      public_key: "3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hbeGdNrfx+FG+IK08=",
      not_before: now + hours * 3_600_000,
      scheduled_at: now,
    };
    for (const node of db.nodes) {
      if (node.status === "online" || node.status === "degraded") {
        keys.pins[node.id] = [...(pinsOf(node) ?? [keys.current.kid]), keys.next.kid];
      }
    }
    return HttpResponse.json(signingKeyStatus(now));
  }),

  http.post(path("completeSigningKeyRollover"), async ({ request }) => {
    const denied = requireAdmin();
    if (denied) return denied;
    const body = (await request.json().catch(() => null)) as { force?: unknown } | null;
    const keys = db.signingKeys;
    if (!keys.next) return notFound("Scheduled signing key rollover");
    const now = Date.now();
    if (now < keys.next.not_before) {
      return conflict("The new signing key isn't in use yet; complete the rollover after that");
    }
    const behind = signingKeyStatus(now).nodes.filter((n) => n.state !== "ready");
    if (behind.length && body?.force !== true) {
      return conflict(
        `${behind.length} node(s) don't pin the new signing key yet and would need a re-join; wait for them to reconnect, or complete with force`,
      );
    }
    keys.retired = { kid: keys.current.kid, retired_at: now };
    keys.current = { kid: keys.next.kid, public_key: keys.next.public_key };
    keys.next = null;
    return HttpResponse.json(signingKeyStatus(now));
  }),

  http.delete(path("cancelSigningKeyRollover"), () => {
    const denied = requireAdmin();
    if (denied) return denied;
    const keys = db.signingKeys;
    if (!keys.next) return notFound("Scheduled signing key rollover");
    if (Date.now() >= keys.next.not_before) {
      return conflict(
        "The new signing key is already in use; complete the rollover instead of cancelling it",
      );
    }
    keys.next = null;
    return HttpResponse.json(signingKeyStatus());
  }),
];
