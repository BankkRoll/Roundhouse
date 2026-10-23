import { StackedBar } from "@openrail/ui";
import { SectionHeader } from "../../components/section-header";
import type { Node } from "../../lib/api/types";
import { formatBytesPair } from "../../lib/format";

/**
 * RAM capacity per server as stacked bars. With no services yet, each bar has a single
 * "system" segment for everything in use; services will add their own segments.
 *
 * @param props - Nodes to chart.
 * @returns The section.
 */
export function CapacitySection({ nodes }: { nodes: readonly Node[] }) {
  const reporting = nodes.filter((node) => node.mem_used !== null && node.mem_total);
  return (
    <section aria-labelledby="capacity-heading" className="mt-12">
      <SectionHeader
        id="capacity-heading"
        title="Capacity planning"
        meta="RAM in use"
        action={
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-2 rounded-sm bg-meter-fill" aria-hidden="true" /> system
          </span>
        }
      />
      {reporting.length === 0 ? (
        <p className="text-sm text-muted-foreground">Capacity appears once servers report usage.</p>
      ) : (
        <ul className="divide-y divide-border/70 border-y border-border/70">
          {reporting.map((node) => (
            <li
              key={node.id}
              className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)_auto] items-center gap-4 py-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]"
            >
              <span className="truncate text-sm text-foreground">{node.name}</span>
              <StackedBar
                label={`${node.name} RAM: ${formatBytesPair(node.mem_used, node.mem_total)} used by system`}
                total={node.mem_total ?? 0}
                segments={[{ label: "system", value: node.mem_used ?? 0 }]}
              />
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatBytesPair(node.mem_used, node.mem_total)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
