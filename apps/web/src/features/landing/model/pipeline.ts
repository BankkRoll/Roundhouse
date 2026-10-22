/**
 * Stage machine for the "git push to HTTPS URL" section: the stages, the few log lines each
 * one prints, and the pure mapping between scroll progress and the active stage. A
 * rollback reuses the same stages but skips the build, because the image is already in
 * the registry.
 *
 * @module
 */

/** Identifier of a deploy stage. */
export type StageId =
  | "push"
  | "build"
  | "registry"
  | "schedule"
  | "start"
  | "health"
  | "route"
  | "live";

/** A log line printed by a stage. */
export interface LogLine {
  text: string;
  /** Visual emphasis in the terminal. */
  tone?: "muted" | "success" | "accent";
}

/** One stage of the deploy pipeline. */
export interface Stage {
  id: StageId;
  /** Short label, e.g. "Build". */
  label: string;
  /** Where the stage runs, e.g. "builder node". */
  where: string;
  /** One-sentence explanation. */
  detail: string;
  /** What the terminal shows while this stage is active. */
  log: readonly LogLine[];
}

/** Stages in pipeline order. */
export const STAGES: readonly Stage[] = [
  {
    id: "push",
    label: "Push",
    where: "GitHub → Worker",
    detail: "A webhook tells your control plane a commit landed on the tracked branch.",
    log: [
      { text: "$ git push origin main", tone: "accent" },
      { text: "→ webhook  api@4f2c9e1  “fix: retry stripe webhooks”", tone: "muted" },
      { text: "queued  build dep_7h2k" },
    ],
  },
  {
    id: "build",
    label: "Build",
    where: "builder node",
    detail: "BuildKit and Railpack turn the source into an image, no Dockerfile required.",
    log: [
      { text: "railpack  node 22 · pnpm · start: node dist/server.js" },
      { text: "buildkit  #6 pnpm install --frozen-lockfile  CACHED", tone: "muted" },
      { text: "buildkit  #7 pnpm build  done in 14.2s", tone: "success" },
    ],
  },
  {
    id: "registry",
    label: "Registry",
    where: "R2",
    detail: "The image is pushed to a private registry backed by R2 in your own account.",
    log: [
      { text: "push  registry/api@sha256:9c1e…a07f" },
      { text: "layers  4 new · 11 reused · 187 MB → R2", tone: "muted" },
    ],
  },
  {
    id: "schedule",
    label: "Schedule",
    where: "Durable Object",
    detail: "The scheduler picks a server with room for the service and signs new desired state.",
    log: [
      { text: "fit  hetzner-fsn1  2.1 vCPU · 9.4 GB free", tone: "success" },
      { text: "skip  home-nuc  83% RAM", tone: "muted" },
      { text: "sign  desired_state gen=42  kid=k1" },
    ],
  },
  {
    id: "start",
    label: "Pull & start",
    where: "agent",
    detail: "The agent verifies the signed envelope, pulls the image and starts the container.",
    log: [
      { text: "verify  ed25519 ok · gen 42 > 41", tone: "success" },
      { text: "pull  sha256:9c1e…a07f" },
      { text: "start  api-7h2k  10.20.0.3:8080" },
    ],
  },
  {
    id: "health",
    label: "Health check",
    where: "agent",
    detail: "Traffic only moves once the new container answers its health check.",
    log: [
      { text: "GET /healthz → 503  (warming up)", tone: "muted" },
      { text: "GET /healthz → 200  41ms", tone: "success" },
    ],
  },
  {
    id: "route",
    label: "Route",
    where: "Caddy",
    detail: "Caddy points the domain at the new container and drains the old one.",
    log: [
      { text: "caddy  api.acme.dev → 10.20.0.3:8080  tls ok" },
      { text: "drain  api-5q1x  (kept for rollback)", tone: "muted" },
    ],
  },
  {
    id: "live",
    label: "Live",
    where: "HTTPS",
    detail: "The deployment is serving. The previous image stays ready for an instant rollback.",
    log: [{ text: "live  https://api.acme.dev  in 38s", tone: "success" }],
  },
];

/** Log shown at the live stage after rolling back. */
export const ROLLBACK_LOG: readonly LogLine[] = [
  { text: "$ rollback api → dep_5q1x", tone: "accent" },
  { text: "image already on the node · build skipped", tone: "muted" },
  { text: "rolled back  https://api.acme.dev  in 4s", tone: "success" },
];

/** How a stage should be drawn. */
export type StageStatus = "pending" | "active" | "done";

/**
 * Maps scroll progress through the pinned track to the active stage. Each stage owns an
 * equal slice of the track.
 *
 * @param progress - Progress from 0 (track top reaches the viewport top) to 1 (track end).
 * @param count - Number of stages. Defaults to {@link STAGES}' length.
 * @returns The active stage index, from 0 to `count - 1`.
 * @example
 * stageAtProgress(0.5, 8); // 4
 */
export function stageAtProgress(progress: number, count: number = STAGES.length): number {
  if (count <= 0) return 0;
  const clamped = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return Math.min(count - 1, Math.floor(clamped * count));
}

/**
 * Scroll progress that lands in the middle of a stage's slice, for "jump to stage".
 *
 * @param index - Stage index.
 * @param count - Number of stages. Defaults to {@link STAGES}' length.
 * @returns Progress between 0 and 1 that {@link stageAtProgress} maps back to `index`.
 */
export function progressForStage(index: number, count: number = STAGES.length): number {
  if (count <= 0) return 0;
  const safe = Math.min(count - 1, Math.max(0, Math.round(index)));
  return (safe + 0.5) / count;
}

/**
 * Reads scroll progress through a pinned track from its bounding box.
 *
 * @param top - Track top relative to the viewport (`getBoundingClientRect().top`).
 * @param height - Track height.
 * @param viewport - Viewport height.
 * @returns 0 before the track pins, 1 once it has scrolled past.
 */
export function trackProgress(top: number, height: number, viewport: number): number {
  const distance = height - viewport;
  if (distance <= 0) return top <= 0 ? 1 : 0;
  return Math.min(1, Math.max(0, -top / distance));
}

/**
 * Derives each stage's status from the active one.
 *
 * @param active - Active stage index.
 * @returns Status per stage, in {@link STAGES} order.
 */
export function stageStatuses(active: number): StageStatus[] {
  return STAGES.map((_, index) =>
    index < active ? "done" : index === active ? "active" : "pending",
  );
}
