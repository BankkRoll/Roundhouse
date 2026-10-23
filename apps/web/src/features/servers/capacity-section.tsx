import { SectionLabel, StackedBar } from "@roundhouse/ui";
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
    <section aria-labelledby="capacity-heading" className="mt-10">
      <div className="mb-3 flex items-center justify-between">
        <SectionLabel id="capacity-heading">Capacity planning</SectionLabel>
        <span className="flex items-center gap-1.5 font-mono text-[10px] text-subtle-foreground">
          <span className="size-2 rounded-sm bg-meter-fill" aria-hidden="true" /> system
        </span>
      </div>
      <div className="rounded-lg border border-border bg-surface">
        {reporting.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            Capacity appears once servers report usage.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {reporting.map((node) => (
              <li
                key={node.id}
                className="grid grid-cols-[8rem_1fr_auto] items-center gap-4 px-4 py-3"
              >
                <span className="truncate font-mono text-xs text-foreground">{node.name}</span>
                <StackedBar
                  label={`${node.name} RAM: ${formatBytesPair(node.mem_used, node.mem_total)} used by system`}
                  total={node.mem_total ?? 0}
                  segments={[{ label: "system", value: node.mem_used ?? 0 }]}
                />
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {formatBytesPair(node.mem_used, node.mem_total)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
