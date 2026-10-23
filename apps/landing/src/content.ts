/**
 * Copy for the landing page's feature grid, header mega menu and FAQ.
 *
 * @module
 */
import { JOIN_TOKEN_TTL_MS, PRODUCT_NAME } from "@openrail/shared";

/** Join-token lifetime in minutes, from the same constant the API uses. */
export const JOIN_TOKEN_MINUTES = Math.round(JOIN_TOKEN_TTL_MS / 60_000);

/** Icons the feature grid and menu know how to draw. */
export type FeatureIcon =
  | "server"
  | "users"
  | "history"
  | "box"
  | "database"
  | "hard-drive"
  | "archive"
  | "clock"
  | "network"
  | "git-branch"
  | "scroll"
  | "activity"
  | "layout"
  | "terminal"
  | "bot"
  | "shield"
  | "rocket"
  | "globe"
  | "undo"
  | "workflow"
  | "wrench";

/** A product feature. */
export interface Feature {
  title: string;
  body: string;
  icon: FeatureIcon;
  /** In-page section that demonstrates it, if any. */
  anchor?: string;
}

/** A themed group of features, used by the grid and the Product menu. */
export interface FeatureGroup {
  id: "deploy" | "data" | "networking" | "observability" | "tools";
  title: string;
  /** One-line pitch for the menu. */
  summary: string;
  icon: FeatureIcon;
  /** In-page section the group links to. */
  anchor: string;
  features: readonly Feature[];
}

/** Every feature, grouped. */
export const FEATURE_GROUPS: readonly FeatureGroup[] = [
  {
    id: "deploy",
    title: "Deploy",
    summary: "Push to deploy, previews and instant rollbacks.",
    icon: "rocket",
    anchor: "pipeline",
    features: [
      {
        title: "Services",
        body: "Push to deploy from Git. BuildKit and Railpack build it; your servers run it.",
        icon: "box",
        anchor: "pipeline",
      },
      {
        title: "Any language",
        body: "Railpack detects Node, Python, Go, Ruby, PHP and more. Bring a Dockerfile and it uses yours.",
        icon: "box",
      },
      {
        title: "Zero-downtime deploys",
        body: "Traffic moves to the new container only after it passes its health check.",
        icon: "activity",
        anchor: "pipeline",
      },
      {
        title: "Rollbacks",
        body: "Redeploy any earlier image in seconds. No rebuild, no waiting.",
        icon: "undo",
        anchor: "pipeline",
      },
      {
        title: "PR previews",
        body: "Every pull request gets its own environment and URL, torn down on merge.",
        icon: "git-branch",
      },
      {
        title: "Cron jobs",
        body: "Run a service on a schedule instead of keeping it up.",
        icon: "clock",
      },
    ],
  },
  {
    id: "data",
    title: "Data",
    summary: "Databases with volumes and backups to your R2.",
    icon: "database",
    anchor: "canvas",
    features: [
      {
        title: "Databases",
        body: "Postgres, MySQL, Redis and MongoDB as services with their own volumes.",
        icon: "database",
        anchor: "canvas",
      },
      {
        title: "Volumes",
        body: "Persistent storage pinned to a node, mounted into a service.",
        icon: "hard-drive",
      },
      {
        title: "Backups",
        body: "Scheduled database backups to R2 in your own Cloudflare account.",
        icon: "archive",
      },
    ],
  },
  {
    id: "networking",
    title: "Networking",
    summary: "Private DNS over WireGuard, HTTPS at the edge of every node.",
    icon: "network",
    anchor: "security",
    features: [
      {
        title: "Private networking",
        body: "Services reach each other at service.env.project.internal over the WireGuard mesh.",
        icon: "network",
        anchor: "security",
      },
      {
        title: "Domains & HTTPS",
        body: "Every service gets a generated domain, or bring your own. Caddy on each server keeps certificates current.",
        icon: "globe",
      },
      {
        title: "Signed control channel",
        body: "Agents dial out over WSS and verify every Ed25519-signed message before acting.",
        icon: "shield",
        anchor: "security",
      },
    ],
  },
  {
    id: "observability",
    title: "Observability",
    summary: "Logs, metrics, live server usage and an audit trail.",
    icon: "activity",
    anchor: "install",
    features: [
      {
        title: "Logs",
        body: "Build and runtime logs per deployment, streamed from the agent.",
        icon: "scroll",
      },
      {
        title: "Metrics",
        body: "Per-service CPU, memory and request metrics alongside the logs.",
        icon: "activity",
      },
      {
        title: "Servers & live usage",
        body: "Join any Linux box with one command and watch CPU, RAM and disk.",
        icon: "server",
        anchor: "install",
      },
      {
        title: "Audit log",
        body: "Every join, invite and role change, with who did it and when.",
        icon: "history",
      },
    ],
  },
  {
    id: "tools",
    title: "Developer tools",
    summary: "A visual canvas, a CLI, templates and an MCP server.",
    icon: "wrench",
    anchor: "canvas",
    features: [
      {
        title: "Project canvas",
        body: "See every service and how they connect. Stage changes, review, deploy.",
        icon: "workflow",
        anchor: "canvas",
      },
      {
        title: "Environments",
        body: "Every project starts with production. Add staging or more, each with its own config.",
        icon: "layout",
      },
      {
        title: "Shared variables",
        body: "Define a value once and reference it from every service. Change it in one place.",
        icon: "workflow",
      },
      {
        title: "CLI",
        body: "Deploy, tail logs and manage variables from your terminal.",
        icon: "terminal",
      },
      {
        title: "Templates",
        body: "Start from a ready-made stack instead of an empty project.",
        icon: "layout",
      },
      {
        title: "MCP server",
        body: "Let coding agents inspect and deploy your projects through a scoped API.",
        icon: "bot",
      },
      {
        title: "Members & roles",
        body: "Owner, admin, member and viewer. One install, many workspaces.",
        icon: "users",
      },
    ],
  },
];

/** A question and its answer. */
export interface FaqEntry {
  question: string;
  answer: string;
}

/** Frequently asked questions. */
export const FAQ: readonly FaqEntry[] = [
  {
    question: "Why Cloudflare for the control plane?",
    answer:
      "A control plane needs a database, durable coordination, object storage, queues and an always-on endpoint. Workers, D1, Durable Objects, R2 and Queues provide all of that in your own account, for about $5 a month on Workers Paid, with nothing for you to patch or back up. Durable Objects can also hold one WebSocket per server, which is what lets agents dial out instead of exposing a port.",
  },
  {
    question: "What happens if Cloudflare is down?",
    answer:
      "Your apps keep running. They live on your servers, not on Cloudflare. The control plane sends each agent the full desired state, and an agent that loses its connection keeps its current workloads running and reconnects with backoff. What you lose during an outage is the ability to change things: deploys, scaling and the dashboard.",
  },
  {
    question: "Do I need Kubernetes?",
    answer:
      "No. Each server runs Docker and a small Go agent. There is no cluster to install, no etcd and no YAML to maintain.",
  },
  {
    question: "What does it cost?",
    answer: `${PRODUCT_NAME} has no hosted edition and no paid tiers. You pay Cloudflare for the control plane (about $5 a month on Workers Paid) and whoever you rent servers from. A server you already own costs nothing extra.`,
  },
  {
    question: "Can I use my home server?",
    answer:
      "Yes. Agents connect outbound, so a machine behind NAT or a home router works without port forwarding for management. To serve public traffic from it you still need a way in for HTTP, such as a forwarded 80/443 or a tunnel.",
  },
  {
    question: "How is it secured?",
    answer: `Servers expose no control port; agents dial out over WSS. Every control message is an Ed25519-signed envelope that the agent verifies against a key pinned at join, before parsing it. Join tokens are single-use and expire after ${JOIN_TOKEN_MINUTES} minutes, node credentials are stored only as hashes, and secrets at rest are encrypted with AES-GCM under keys derived from your MASTER_KEY with HKDF. Report vulnerabilities privately through GitHub security advisories.`,
  },
  {
    question: "Is it ready for production?",
    answer: `Not yet. ${PRODUCT_NAME} is in early development, and interfaces, the database schema and the agent protocol will change. Try it on servers you can rebuild, and follow the repository for releases.`,
  },
];
