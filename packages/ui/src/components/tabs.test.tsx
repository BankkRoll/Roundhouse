import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Checkbox } from "./input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";
import { Tooltip } from "./tooltip";

function Example({ onChange = () => {} }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("one");
  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    >
      <TabsList label="Methods">
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
        <Tooltip content="Coming soon">
          <TabsTrigger value="three" disabled>
            Three
          </TabsTrigger>
        </Tooltip>
      </TabsList>
      <TabsContent value="one">First panel</TabsContent>
      <TabsContent value="two">Second panel</TabsContent>
      <TabsContent value="three">Third panel</TabsContent>
    </Tabs>
  );
}

describe("Tabs", () => {
  it("wires tabs to their panel and renders only the selected panel", () => {
    render(<Example />);
    const list = screen.getByRole("tablist", { name: "Methods" });
    expect(list).toHaveAttribute("aria-orientation", "horizontal");
    const one = screen.getByRole("tab", { name: "One" });
    expect(one).toHaveAttribute("aria-selected", "true");
    expect(one).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute("tabindex", "-1");
    const panel = screen.getByRole("tabpanel", { name: "One" });
    expect(panel).toHaveTextContent("First panel");
    expect(one).toHaveAttribute("aria-controls", panel.id);
    expect(screen.queryByText("Second panel")).not.toBeInTheDocument();
  });

  it("selects on click", async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.click(screen.getByRole("tab", { name: "Two" }));
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Second panel");
  });

  it("moves with arrow keys, Home and End, wrapping around", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Example onChange={onChange} />);
    await user.tab();
    expect(screen.getByRole("tab", { name: "One" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Two" })).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith("two");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Three" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "One" })).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith("one");
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Three" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "One" })).toHaveFocus();
  });

  it("keeps a disabled tab focusable but never selects it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Example onChange={onChange} />);
    const three = screen.getByRole("tab", { name: "Three" });
    expect(three).toHaveAttribute("aria-disabled", "true");
    expect(three).not.toBeDisabled();
    await user.click(three);
    expect(three).toHaveFocus();
    await user.keyboard("{Home}{End}");
    expect(three).toHaveFocus();
    expect(onChange).not.toHaveBeenCalledWith("three");
    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("Third panel")).not.toBeInTheDocument();
  });

  it("refuses to render outside <Tabs>", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<TabsTrigger value="x">X</TabsTrigger>)).toThrow(/inside <Tabs>/);
  });
});

describe("Checkbox", () => {
  it("is a native checkbox that its label toggles", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <label htmlFor="builder">
        <Checkbox id="builder" onChange={(event) => onChange(event.target.checked)} /> Builder node
      </label>,
    );
    const box = screen.getByRole("checkbox", { name: "Builder node" });
    await user.click(screen.getByText("Builder node"));
    expect(box).toBeChecked();
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
