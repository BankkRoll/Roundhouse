import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { clampPercent, Meter, MeterRow, meterTone, StackedBar } from "./meter";

describe("meterTone", () => {
  it.each([
    [0, "normal"],
    [70, "normal"],
    [70.1, "warning"],
    [90, "warning"],
    [90.1, "danger"],
    [100, "danger"],
  ] as const)("%d%% is %s", (percent, tone) => {
    expect(meterTone(percent)).toBe(tone);
  });
});

describe("clampPercent", () => {
  it("clamps into 0..100", () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(42.5)).toBe(42.5);
    expect(clampPercent(140)).toBe(100);
  });

  it("treats NaN and infinities as 0", () => {
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("Meter", () => {
  it("exposes the value through meter semantics", () => {
    render(<Meter value={71.4} label="Memory usage" valueText="71% · 11.4/16 GB" />);
    const meter = screen.getByRole("meter", { name: "Memory usage" });
    expect(meter).toHaveAttribute("aria-valuenow", "71");
    expect(meter).toHaveAttribute("aria-valuetext", "71% · 11.4/16 GB");
    expect(meter).toHaveAttribute("data-tone", "warning");
  });

  it("renders an empty track for unknown values, announced as unknown", () => {
    render(<Meter value={null} label="CPU usage" />);
    const meter = screen.getByRole("meter", { name: "CPU usage" });
    expect(meter).toHaveAttribute("aria-valuenow", "0");
    expect(meter).toHaveAttribute("aria-valuetext", "Unknown");
    expect(meter).toHaveAttribute("data-tone", "unknown");
    expect(meter).toBeEmptyDOMElement();
  });

  it("clamps the fill width", () => {
    render(<Meter value={250} label="Disk usage" />);
    const fill = screen.getByRole("meter").firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("100%");
    expect(screen.getByRole("meter")).toHaveAttribute("data-tone", "danger");
  });
});

describe("MeterRow", () => {
  it("shows the label and the mono value", () => {
    render(<MeterRow label="RAM" percent={38} value="38% · 3.0/8 GB" />);
    expect(screen.getByText("RAM")).toBeInTheDocument();
    expect(screen.getByText("38% · 3.0/8 GB")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "RAM usage" })).toHaveAttribute("aria-valuenow", "38");
  });
});

describe("StackedBar", () => {
  it("sizes segments relative to the total", () => {
    render(
      <StackedBar label="RAM by service" total={16} segments={[{ label: "system", value: 4 }]} />,
    );
    const bar = screen.getByRole("img", { name: "RAM by service" });
    const segment = bar.firstElementChild as HTMLElement;
    expect(segment.style.width).toBe("25%");
    expect(segment).toHaveAttribute("title", "system");
  });

  it("draws nothing when the total is zero", () => {
    render(<StackedBar label="empty" total={0} segments={[{ label: "system", value: 4 }]} />);
    expect(screen.getByRole("img", { name: "empty" })).toBeEmptyDOMElement();
  });
});
