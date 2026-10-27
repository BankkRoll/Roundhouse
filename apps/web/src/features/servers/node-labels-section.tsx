import { Badge, SaveBar, SettingsRow, toast } from "@roundhouse/ui";
import { type FormEvent, useState } from "react";
import { SectionHeader } from "../../components/section-header";
import { errorMessage } from "../../lib/api/client";
import type { Node } from "../../lib/api/types";
import { useUpdateNodeLabels } from "../../queries/nodes";
import {
  fromPairs,
  KeyValueEditor,
  type KeyValuePair,
  toPairs,
} from "../services/settings/key-value-editor";
import { formatLabels, labelErrors, MAX_NODE_LABELS } from "./node-labels";

const HINT =
  "Service placement selectors and a project's preview build node selector match these labels. Changing them never moves running workloads.";

/** Props for {@link NodeLabelsSection}. */
export interface NodeLabelsSectionProps {
  workspaceId: string;
  node: Node;
  /** Whether the caller holds `nodes:manage`; read-only otherwise. */
  canEdit: boolean;
}

/**
 * A server's labels: an editable key/value list saved as a complete set, or the labels
 * as tags for people who can't change them.
 *
 * @param props - Workspace, node and edit permission.
 * @returns The section.
 */
export function NodeLabelsSection({ workspaceId, node, canEdit }: NodeLabelsSectionProps) {
  const update = useUpdateNodeLabels(workspaceId, node.id);
  const [pairs, setPairs] = useState<KeyValuePair[] | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const saved = toPairs(node.labels);
  const current = pairs ?? saved;
  const dirty =
    pairs !== null && JSON.stringify(fromPairs(pairs)) !== JSON.stringify(fromPairs(saved));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const problems = labelErrors(current);
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    update.mutate(fromPairs(current), {
      onSuccess: () => {
        setPairs(null);
        toast({ title: `Labels of ${node.name} saved`, tone: "success" });
      },
    });
  }

  return (
    <section aria-labelledby="labels-heading">
      <SectionHeader id="labels-heading" title="Labels" />
      {canEdit ? (
        <form onSubmit={onSubmit} noValidate aria-label="Labels">
          <SettingsRow
            label="Labels"
            description={HINT}
            control="wide"
            className="border-t border-border/70"
          >
            <KeyValueEditor
              label="Labels"
              hideLegend
              pairs={current}
              onChange={(next) => {
                setPairs(next);
                setErrors({});
              }}
              keyPlaceholder="pool"
              valuePlaceholder="untrusted"
              errors={errors}
              max={MAX_NODE_LABELS}
            />
            {update.isError ? (
              <p role="alert" className="mt-2 text-xs text-danger">
                {errorMessage(update.error)}
              </p>
            ) : null}
          </SettingsRow>
          <SaveBar
            dirty={dirty}
            saving={update.isPending}
            onDiscard={() => {
              setPairs(null);
              setErrors({});
              update.reset();
            }}
          />
        </form>
      ) : (
        <div className="border-t border-border/70 py-4">
          {saved.length === 0 ? (
            <p className="text-sm text-muted-foreground">No labels.</p>
          ) : (
            <ul aria-label="Labels" className="flex flex-wrap gap-1.5">
              {formatLabels(node.labels).map((label) => (
                <li key={label}>
                  <Badge className="font-mono">{label}</Badge>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted-foreground">{HINT}</p>
        </div>
      )}
    </section>
  );
}
