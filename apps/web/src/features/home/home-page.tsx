import { Button, SectionLabel, Tooltip } from "@roundhouse/ui";
import { PlusIcon } from "lucide-react";
import { PageHeader } from "../../components/page-header";
import { usePermissions } from "../../lib/permissions";
import { useMembership } from "../../queries/me";
import { ProjectsGrid } from "../projects/projects-grid";
import { useShellActions } from "../shell/shell-actions";
import { ActivityCard } from "./activity-card";
import { FleetCard } from "./fleet-card";
import { StatRow } from "./stat-row";

function PhaseGatedButton({ label, reason }: { label: string; reason: string }) {
  // NOTE: aria-disabled instead of disabled: a disabled button gets no hover or focus, so
  // the tooltip explaining why it is unavailable could never appear.
  return (
    <Tooltip content={reason}>
      <Button
        variant="secondary"
        aria-disabled="true"
        onClick={(event) => event.preventDefault()}
        className="aria-disabled:pointer-events-auto aria-disabled:cursor-not-allowed"
      >
        {label}
      </Button>
    </Tooltip>
  );
}

/**
 * Workspace home: fleet and service stats, the projects grid, recent activity and a
 * per-server RAM overview.
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
            <PhaseGatedButton label="Browse templates" reason="Templates arrive in a later phase" />
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
      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section aria-labelledby="projects-heading">
          <SectionLabel id="projects-heading" className="mb-3">
            Projects
          </SectionLabel>
          <ProjectsGrid workspaceId={workspaceId} />
        </section>
        <div className="grid content-start gap-4">
          <ActivityCard workspaceId={workspaceId} />
          <FleetCard workspaceId={workspaceId} />
        </div>
      </div>
    </>
  );
}
