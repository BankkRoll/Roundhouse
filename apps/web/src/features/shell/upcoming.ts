/** Sections that exist in navigation but ship in a later phase. */
export type UpcomingFeature = "canvas" | "logs" | "templates" | "usage";

/** Copy for each upcoming section's placeholder. Update phases here as the roadmap moves. */
export const UPCOMING: Record<UpcomingFeature, { title: string; phase: string; body: string }> = {
  canvas: {
    title: "Canvas",
    phase: "Phase 1",
    body: "A live map of your services, how they connect, and which server each one runs on. It arrives with projects.",
  },
  logs: {
    title: "Logs",
    phase: "Later phase",
    body: "Search and live-tail logs from every service, with saved searches and level filters.",
  },
  templates: {
    title: "Templates",
    phase: "Later phase",
    body: "One-click starting points for databases, queues and common app stacks.",
  },
  usage: {
    title: "Usage",
    phase: "Later phase",
    body: "A cost estimator for your own servers: enter what each one costs per month and see spend by project.",
  },
};
