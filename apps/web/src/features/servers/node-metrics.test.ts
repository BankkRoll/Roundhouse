import { describe, expect, it } from "vitest";
import { makeNode, makePendingNode } from "../../mocks/db";
import {
  bytesValue,
  cpuValue,
  fleetHeadline,
  nodeMeterRows,
  nodeSubtitle,
  summarizeFleet,
} from "./node-metrics";

const GiB = 1024 ** 3;

describe("cpuValue", () => {
  it("shows percent and cores in use", () => {
    expect(cpuValue({ cpu_percent: 38, cpu_total: 8 })).toBe("38% · 3.0/8 vCPU");
  });

  it("shows only the percent when the core count is unknown", () => {
    expect(cpuValue({ cpu_percent: 12.4, cpu_total: null })).toBe("12%");
  });

  it("is a placeholder before the first heartbeat", () => {
    expect(cpuValue({ cpu_percent: null, cpu_total: 8 })).toBe("—");
  });
});

describe("bytesValue", () => {
  it("shows percent and the used/total pair", () => {
    expect(bytesValue(11.4 * GiB, 16 * GiB)).toBe("71% · 11.4/16 GB");
  });

  it("is a placeholder when either side is unknown", () => {
    expect(bytesValue(null, 16 * GiB)).toBe("—");
    expect(bytesValue(1, null)).toBe("—");
  });
});

describe("nodeMeterRows", () => {
  it("builds CPU, RAM and Disk rows", () => {
    const rows = nodeMeterRows(makeNode());
    expect(rows.map((row) => row.label)).toEqual(["CPU", "RAM", "Disk"]);
    expect(rows[1]?.percent).toBeCloseTo(71.25);
    expect(rows[2]?.value).toBe("40% · 64/160 GB");
    expect(rows[0]?.meterLabel).toBe("hel-1 CPU usage");
  });

  it("uses null percents for a node with no usage yet", () => {
    const rows = nodeMeterRows(makePendingNode());
    expect(rows.every((row) => row.percent === null && row.value === "—")).toBe(true);
  });
});

describe("nodeSubtitle", () => {
  it("combines provider/os with the region", () => {
    expect(nodeSubtitle(makeNode())).toBe("hetzner/linux · hel1");
  });

  it("falls back to hostname, then IP, then the bare platform", () => {
    expect(nodeSubtitle(makeNode({ region: null }))).toBe("hetzner/linux · hel-1.example.com");
    expect(nodeSubtitle(makeNode({ region: null, hostname: null }))).toBe(
      "hetzner/linux · 203.0.113.10",
    );
    expect(
      nodeSubtitle(makeNode({ provider: "", region: null, hostname: null, public_ip: null })),
    ).toBe("linux");
    expect(nodeSubtitle(makePendingNode())).toBe("server");
  });
});

describe("summarizeFleet", () => {
  it("counts statuses and sums RAM only over reporting nodes", () => {
    const fleet = summarizeFleet([
      makeNode({ id: "a", mem_used: 4 * GiB, mem_total: 8 * GiB }),
      makeNode({ id: "b", status: "draining", mem_used: 2 * GiB, mem_total: 8 * GiB }),
      makeNode({ id: "c", status: "offline", mem_used: null }),
      makeNode({ id: "d", status: "degraded" }),
      makeNode({ id: "f", status: "maintenance", mem_used: null }),
      makePendingNode({ id: "e" }),
    ]);
    expect(fleet).toMatchObject({ total: 6, online: 1, offline: 1, attention: 3, pending: 1 });
    expect(fleet.memUsed).toBe(6 * GiB + 11.4 * GiB);
    expect(fleet.memTotal).toBe(32 * GiB);
  });

  it("reports null RAM percent for an empty or silent fleet", () => {
    expect(summarizeFleet([]).memPercent).toBeNull();
    expect(summarizeFleet([makePendingNode()]).memPercent).toBeNull();
  });
});

describe("fleetHeadline", () => {
  it("says all reachable when everything is online", () => {
    expect(fleetHeadline(summarizeFleet([makeNode(), makeNode({ id: "b" })]))).toBe(
      "2 servers · all reachable",
    );
  });

  it("uses the singular for one server", () => {
    expect(fleetHeadline(summarizeFleet([makeNode()]))).toBe("1 server · all reachable");
  });

  it("calls out offline, attention and pending nodes", () => {
    const fleet = summarizeFleet([
      makeNode({ status: "offline" }),
      makeNode({ status: "draining" }),
      makePendingNode(),
    ]);
    expect(fleetHeadline(fleet)).toBe("3 servers · 1 offline · 1 need attention · 1 pending");
  });

  it("handles an empty fleet", () => {
    expect(fleetHeadline(summarizeFleet([]))).toBe("0 servers");
  });
});
