import { DEPLOYMENT_STATUSES } from "@roundhouse/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AnsiText } from "./ansi-text";
import { AvatarStack } from "./avatar-stack";
import { SegmentedControl } from "./segmented-control";
import { Slider } from "./slider";
import { DEPLOYMENT_STATUS_META, StatusBadge, StatusDot, WORKLOAD_STATE_META } from "./status";
import { Switch } from "./switch";

describe("AnsiText", () => {
  it("renders colors as styles and never as markup", () => {
    const { container } = render(
      <AnsiText text={"\x1b[31m<script>alert(1)</script>\x1b[0m \x1b]8;;https://x\x1b\\link"} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("<script>alert(1)</script> link");
    expect((container.querySelector("span") as HTMLElement).style.color).toBe("var(--ansi-1)");
  });

  it("highlights search matches case-insensitively", () => {
    const { container } = render(<AnsiText text="GET /Cart 200" highlight="cart" />);
    expect(container.querySelector("mark")?.textContent).toBe("Cart");
  });
});

describe("StatusDot kinds", () => {
  it("labels every deployment status and pulses while in flight", () => {
    for (const status of DEPLOYMENT_STATUSES) {
      expect(DEPLOYMENT_STATUS_META[status].label).toBeTruthy();
    }
    render(<StatusDot status="building" kind="deployment" />);
    expect(screen.getByRole("img", { name: "Building" })).toHaveClass("animate-pulse-dot");
  });

  it("draws workload states and labels badges", () => {
    expect(WORKLOAD_STATE_META.unhealthy.shape).toBe("half");
    render(<StatusBadge status="crashed" kind="workload" />);
    expect(screen.getByText("Crashed")).toBeInTheDocument();
  });
});

describe("Switch", () => {
  it("toggles with the keyboard and exposes switch semantics", async () => {
    const onChange = vi.fn();
    render(
      <>
        <label htmlFor="s">Generated domain</label>
        <Switch id="s" onCheckedChange={onChange} />
      </>,
    );
    const toggle = screen.getByRole("switch", { name: "Generated domain" });
    toggle.focus();
    await userEvent.keyboard(" ");
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

function SliderHarness() {
  const [value, setValue] = useState(500);
  return (
    <Slider
      thumbLabel="CPU"
      valueText={`${value} m`}
      min={100}
      max={1000}
      step={100}
      value={[value]}
      onValueChange={([next]) => setValue(next ?? value)}
    />
  );
}

describe("Slider", () => {
  it("moves with arrow keys and announces its value text", async () => {
    render(<SliderHarness />);
    const thumb = screen.getByRole("slider", { name: "CPU" });
    thumb.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(thumb).toHaveAttribute("aria-valuenow", "600");
    expect(thumb).toHaveAttribute("aria-valuetext", "600 m");
  });
});

describe("SegmentedControl", () => {
  it("selects with arrow keys and never deselects", async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Log source"
        value="runtime"
        onValueChange={onChange}
        options={[
          { value: "runtime", label: "Runtime" },
          { value: "build", label: "Build" },
        ]}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Log source" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Runtime" }));
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("radio", { name: "Build" }));
    expect(onChange).toHaveBeenCalledWith("build");
  });
});

describe("AvatarStack", () => {
  it("names everyone and collapses the overflow", () => {
    render(
      <AvatarStack
        label="Viewing now"
        max={2}
        people={[
          { id: "1", name: "Ada Lovelace" },
          { id: "2", name: "Bob Builder" },
          { id: "3", name: "Cara Mel" },
        ]}
      />,
    );
    const stack = screen.getByRole("button", {
      name: "Viewing now: Ada Lovelace, Bob Builder, Cara Mel",
    });
    expect(stack).not.toHaveAttribute("aria-label");
    expect(stack).toHaveTextContent(/^ALBB.*\+1$/);
  });

  it("renders nothing for an empty room", () => {
    const { container } = render(<AvatarStack label="Viewing now" people={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
