import { describe, expect, it } from "vitest";
import type { PresenceUser } from "../../lib/api/deploy-types";
import { PRESENCE_PALETTE, peerMarks, peerSummary } from "./presence";

const user = (id: string, name: string, patch: Partial<PresenceUser> = {}): PresenceUser => ({
  user_id: id,
  name,
  image: null,
  color: 3,
  environment_id: "env_1",
  selection: [],
  editing: null,
  ...patch,
});

describe("peerMarks", () => {
  it("marks other people's selections and edits in the same environment only", () => {
    const marks = peerMarks(
      [
        user("usr_me", "Me", { selection: ["svc_1"] }),
        user("usr_ada", "Ada Lovelace", {
          selection: ["svc_1"],
          editing: { service_id: "svc_2", part: "variables" },
        }),
        user("usr_bob", "Bob Builder", { environment_id: "env_2", selection: ["svc_1"] }),
      ],
      "usr_me",
      "env_1",
    );
    expect([...marks.keys()].sort()).toEqual(["svc_1", "svc_2"]);
    expect(marks.get("svc_1")).toEqual([
      { userId: "usr_ada", name: "Ada Lovelace", color: PRESENCE_PALETTE[3], editing: null },
    ]);
    expect(marks.get("svc_2")?.[0]?.editing).toBe("variables");
  });
});

describe("peerSummary", () => {
  it("names the editor first and counts the rest", () => {
    const ada = { userId: "a", name: "Ada Lovelace", color: "#000", editing: null };
    const bob = { userId: "b", name: "Bob Builder", color: "#000", editing: "config" as const };
    expect(peerSummary(undefined)).toBeNull();
    expect(peerSummary([ada])).toBe("Ada selected this");
    expect(peerSummary([ada, bob])).toBe("Bob and 1 more are editing settings");
    expect(peerSummary([bob])).toBe("Bob is editing settings");
  });
});
