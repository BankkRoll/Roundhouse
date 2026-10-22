import { Button, EmptyState, SectionLabel, Tooltip } from "@openrail/ui";
import { FolderKanbanIcon, PlusIcon } from "lucide-react";
import { PageHeader } from "../../components/page-header";
import { useMembership } from "../../queries/me";
import { ActivityCard } from "./activity-card";
import { FleetCard } from "./fleet-card";
import { StatRow } from "./stat-row";

function PhaseGatedButton({
  label,
  reason,
  primary,
}: {
  label: string;
  reason: string;
  primary?: boolean;
}) {
  // NOTE: aria-disabled instead of disabled: a disabled button gets no hover or focus, so
  // the tooltip explaining why it is unavailable could never appear.
  return (
    <Tooltip content={reason}>
      <Button
        variant={primary ? "primary" : "secondary"}
        aria-disabled="true"
        onClick={(event) => event.preventDefault()}
        className="aria-disabled:pointer-events-auto aria-disabled:cursor-not-allowed"
      >
        {primary ? <PlusIcon /> : null}
        {label}
      </Button>
    </Tooltip>
  );
}

/**
 * Workspace home: fleet stats, projects (empty until Phase 1), recent activity and a
 * per-server RAM overview.
 *
 * @param props - Workspace id.
 * @returns The page.
 */
export function HomePage({ workspaceId }: { workspaceId: string }) {
  const workspace = useMembership(workspaceId);

  return (
    <>
      <PageHeader
        title="Home"
        subline={`${workspace?.name ?? "Workspace"} · self-hosted control plane on Cloudflare`}
        actions={
          <>
            <PhaseGatedButton label="Browse templates" reason="Templates arrive in a later phase" />
            <PhaseGatedButton label="New project" reason="Projects arrive in Phase 1" primary />
          </>
        }
      />
      <StatRow workspaceId={workspaceId} />
      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section aria-labelledby="projects-heading">
          <SectionLabel id="projects-heading" className="mb-3">
            Projects
          </SectionLabel>
          <EmptyState
            icon={<FolderKanbanIcon />}
            eyebrow="Phase 1"
            title="No projects yet"
            description="Projects group the services you deploy onto your servers. They arrive in Phase 1; for now, connect the servers they will run on."
            className="py-16"
          />
        </section>
        <div className="grid content-start gap-4">
          <ActivityCard workspaceId={workspaceId} />
          <FleetCard workspaceId={workspaceId} />
        </div>
      </div>
    </>
  );
}
