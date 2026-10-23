import { Button } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { PageHeader } from "../../components/page-header";
import { SectionHeader } from "../../components/section-header";
import { usePermissions } from "../../lib/permissions";
import { useMembership } from "../../queries/me";
import { ProjectsGrid } from "../projects/projects-grid";
import { useShellActions } from "../shell/shell-actions";
import { ActivityCard } from "./activity-card";
import { DeploysChart } from "./deploys-chart";
import { FleetCard } from "./fleet-card";
import { StatRow } from "./stat-row";

/**
 * Workspace home: headline figures, the projects, deploys this week, recent activity as
 * a tagged feed, and per-server RAM.
 *
 * @param props - Workspace id.
 * @returns The page.
 */
export function HomePage({ workspaceId }: { workspaceId: string }) {
  const workspace = useMembership(workspaceId);
  const { can } = usePermissions(workspaceId);
  const { openNewProject } = useShellActions();

  return (
    <>
      <PageHeader
        title="Home"
        subline={`${workspace?.name ?? "Workspace"} · self-hosted control plane on Cloudflare`}
        actions={
          <>
            <Button asChild variant="secondary">
              <Link to="/w/$workspaceId/templates" params={{ workspaceId }}>
                Browse templates
              </Link>
            </Button>
            {can("projects:manage") ? (
              <Button variant="primary" onClick={openNewProject}>
                <PlusIcon />
                New project
              </Button>
            ) : null}
          </>
        }
      />
      <StatRow workspaceId={workspaceId} />
      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,21rem)] xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] xl:gap-12">
        <div className="grid min-w-0 content-start gap-10">
          <section aria-labelledby="projects-heading">
            <SectionHeader id="projects-heading" title="Projects" />
            <ProjectsGrid workspaceId={workspaceId} />
          </section>
          <DeploysChart workspaceId={workspaceId} />
        </div>
        <div className="grid min-w-0 content-start gap-10">
          <ActivityCard workspaceId={workspaceId} />
          <FleetCard workspaceId={workspaceId} />
        </div>
      </div>
    </>
  );
}
