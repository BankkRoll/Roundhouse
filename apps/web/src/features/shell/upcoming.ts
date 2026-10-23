/** Sections that exist in navigation but ship in a later phase. */
export type UpcomingFeature = "canvas" | "logs" | "usage";

/** Copy for each upcoming section's placeholder. Update phases here as the roadmap moves. */
export const UPCOMING: Record<UpcomingFeature, { title: string; phase: string; body: string }> = {
  canvas: {
    title: "Canvas",
    phase: "Phase 2",
    body: "A live map of your services, how they connect, and which server each one runs on. Until then, each project lists its services.",
  },
  logs: {
    title: "Logs",
    phase: "Later phase",
    body: "Search across every service at once, with saved searches and level filters. Live logs for one service are on its Logs tab today.",
  },
  usage: {
    title: "Usage",
    phase: "Later phase",
    body: "A cost estimator for your own servers: enter what each one costs per month and see spend by project.",
  },
};
