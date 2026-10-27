import { Link } from "@tanstack/react-router";
import { ServerIcon, TriangleAlertIcon } from "lucide-react";
import { useNodes } from "../../queries/nodes";
import { matchesSelector } from "../servers/node-labels";

/** Props for {@link MatchingBuilders}. */
export interface MatchingBuildersProps {
  workspaceId: string;
  /** The build node selector as currently edited. */
  selector: Readonly<Record<string, string>>;
}

/**
 * Which servers a preview build node selector matches right now, with a warning when
 * none does (fork builds would then fail) or when none of them can build.
 *
 * @param props - Workspace and selector.
 * @returns The hint, or nothing while the selector is empty or servers can't be read.
 */
export function MatchingBuilders({ workspaceId, selector }: MatchingBuildersProps) {
  const nodes = useNodes(workspaceId, false);
  if (Object.keys(selector).length === 0 || !nodes.data) return null;
  const matches = nodes.data.filter((node) => matchesSelector(node.labels, selector));
  const builders = matches.filter((node) => node.capabilities?.builder);
  const serversLink = (
    <Link
      to="/w/$workspaceId/servers"
      params={{ workspaceId }}
      className="underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      Servers
    </Link>
  );
  if (builders.length === 0) {
    return (
      <p role="status" className="mt-2 flex items-start gap-1.5 text-xs text-warning">
        <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <span>
          {matches.length === 0
            ? "No server carries these labels, so fork preview builds will fail. "
            : `${matches.map((node) => node.name).join(", ")} ${matches.length === 1 ? "matches but can't" : "match but can't"} build. `}
          Label a dedicated builder under {serversLink}.
        </span>
      </p>
    );
  }
  return (
    <p role="status" className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
      <ServerIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span>
        Fork builds run on {builders.map((node) => node.name).join(", ")}. Keep{" "}
        {builders.length === 1 ? "it" : "them"} out of this project's other build pools.
      </span>
    </p>
  );
}
