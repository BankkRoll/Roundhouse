import { NODE_STATUSES } from "@roundhouse/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NODE_STATUS_META, nodeStatusLabel, StatusBadge, StatusDot } from "./status";

describe("NODE_STATUS_META", () => {
  it("covers every node status from the shared package", () => {
    for (const status of NODE_STATUSES) {
      expect(NODE_STATUS_META[status].label).toBeTruthy();
    }
  });
});

describe("nodeStatusLabel", () => {
  it("labels known statuses and passes unknown ones through", () => {
    expect(nodeStatusLabel("online")).toBe("Online");
    expect(nodeStatusLabel("hibernating")).toBe("hibernating");
  });
});

describe("StatusDot", () => {
  it.each(NODE_STATUSES)("announces %s by default", (status) => {
    render(<StatusDot status={status} />);
    expect(screen.getByRole("img", { name: NODE_STATUS_META[status].label })).toHaveAttribute(
      "data-status",
      status,
    );
  });

  it("draws a cross for offline and a half circle for draining", () => {
    const { container, rerender } = render(<StatusDot status="offline" />);
    expect(container.querySelector("path")).toBeInTheDocument();
    expect(container.querySelector("circle")).not.toBeInTheDocument();
    rerender(<StatusDot status="draining" />);
    expect(container.querySelectorAll("circle")).toHaveLength(1);
    expect(container.querySelector("path")).toBeInTheDocument();
  });

  it("pulses while pending", () => {
    render(<StatusDot status="pending" />);
    expect(screen.getByRole("img")).toHaveClass("animate-pulse-dot");
  });

  it("hides itself from assistive tech when label is null", () => {
    const { container } = render(<StatusDot status="online" label={null} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders unknown statuses as a neutral dot", () => {
    render(<StatusDot status="hibernating" />);
    expect(screen.getByRole("img", { name: "hibernating" })).toBeInTheDocument();
  });
});

describe("StatusBadge", () => {
  it("shows the label once, without a duplicate accessible name", () => {
    render(<StatusBadge status="online" />);
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
