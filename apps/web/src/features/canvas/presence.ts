/**
 * Collaborators on the canvas (ADR 0006 "Presence"): who else has which service selected
 * or open for editing, from the project room's `presence` frames.
 *
 * @module
 */
import type { PresenceEditPart } from "@roundhouse/shared";
import type { PresenceUser } from "../../lib/api/deploy-types";

/**
 * Outline colours by presence colour index (`presenceColor`, 0–11). Picked to stay
 * distinct from each other and readable on both themes; a colour is never the only cue,
 * since every mark also carries the person's name.
 */
export const PRESENCE_PALETTE = [
  "#e5484d",
  "#f76b15",
  "#ffc53d",
  "#46a758",
  "#12a594",
  "#0090ff",
  "#3e63dd",
  "#8e4ec6",
  "#d6409f",
  "#a18072",
  "#7ce2fe",
  "#bdee63",
] as const;

/** Someone else's mark on one node. */
export interface PeerMark {
  userId: string;
  name: string;
  color: string;
  /** The part of the service they have open, if they are editing it. */
  editing: PresenceEditPart | null;
}

/** Words for {@link PeerMark.editing}. */
export const EDIT_PART_LABELS: Record<PresenceEditPart, string> = {
  service: "the service",
  config: "settings",
  variables: "variables",
  volume: "the volume",
  domains: "domains",
  connections: "connections",
};

/**
 * Other people's selections and edits in one environment, by node.
 *
 * @param users - The room's presence list.
 * @param selfId - The signed-in user, left out.
 * @param environmentId - The environment on screen; marks from others are ignored.
 * @returns Marks by service ID (or `new:<n>`), in presence order.
 */
export function peerMarks(
  users: readonly PresenceUser[],
  selfId: string | undefined,
  environmentId: string,
): Map<string, PeerMark[]> {
  const marks = new Map<string, PeerMark[]>();
  for (const user of users) {
    if (user.user_id === selfId || user.environment_id !== environmentId) continue;
    const color = PRESENCE_PALETTE[user.color % PRESENCE_PALETTE.length]!;
    const ids = new Set(user.selection);
    if (user.editing) ids.add(user.editing.service_id);
    for (const id of ids) {
      const list = marks.get(id) ?? [];
      list.push({
        userId: user.user_id,
        name: user.name,
        color,
        editing: user.editing?.service_id === id ? user.editing.part : null,
      });
      marks.set(id, list);
    }
  }
  return marks;
}

/**
 * What a node's presence badge says, e.g. "Ada is editing variables".
 *
 * @param marks - The node's marks.
 * @returns The text, or `null` when nobody else is on the node.
 */
export function peerSummary(marks: readonly PeerMark[] | undefined): string | null {
  if (!marks?.length) return null;
  const editor = marks.find((m) => m.editing);
  const first = (editor ?? marks[0])!.name.split(" ")[0];
  const others = marks.length - 1;
  const who = others > 0 ? `${first} and ${others} more` : first;
  if (editor?.editing) {
    return `${who} ${others > 0 ? "are" : "is"} editing ${EDIT_PART_LABELS[editor.editing]}`;
  }
  return `${who} selected this`;
}
