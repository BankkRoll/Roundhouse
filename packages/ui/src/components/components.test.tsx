import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityItem } from "./activity-item";
import { Avatar, avatarColorIndex, initials } from "./avatar";
import { Badge } from "./badge";
import { Button } from "./button";
import { CodeBlock } from "./code-block";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
import { EmptyState } from "./empty-state";
import { KbdHint } from "./kbd-hint";
import { ServerCard } from "./server-card";
import { StatCard } from "./stat-card";
import { tabTriggerClasses } from "./tabs";
import { clearToasts, Toaster, toast } from "./toast";

afterEach(() => {
  act(() => clearToasts());
  vi.unstubAllGlobals();
});

describe("Button", () => {
  it("defaults to type=button", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "button");
  });

  it("disables itself and marks busy while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders its child when asChild is set", () => {
    render(
      <Button asChild variant="primary">
        <a href="/servers">Servers</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Servers" });
    expect(link).toHaveAttribute("href", "/servers");
    expect(link.className).toContain("bg-accent");
  });
});

describe("Badge", () => {
  it("applies the tone classes", () => {
    render(<Badge tone="accent">Staged</Badge>);
    expect(screen.getByText("Staged").className).toContain("text-accent-text");
  });
});

describe("KbdHint", () => {
  it("renders each key and is hidden from assistive tech", () => {
    const { container } = render(<KbdHint keys={["G", "S"]} />);
    expect(container.querySelectorAll("kbd")).toHaveLength(2);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });
});

describe("Avatar", () => {
  it.each([
    ["Ada Lovelace", "AL"],
    ["grace", "GR"],
    ["Jean-Luc Picard", "JP"],
    ["ops@example.com", "OP"],
    ["first.last@example.com", "FL"],
    ["  ", "?"],
    ["", "?"],
  ])("initials(%j) is %s", (name, expected) => {
    expect(initials(name)).toBe(expected);
  });

  it("picks a stable color per seed", () => {
    expect(avatarColorIndex("usr_1")).toBe(avatarColorIndex("usr_1"));
    expect(avatarColorIndex("usr_1")).toBeGreaterThanOrEqual(0);
  });

  it("renders the initials", () => {
    render(<Avatar name="Ada Lovelace" />);
    expect(screen.getByText("AL")).toBeInTheDocument();
  });
});

describe("CodeBlock", () => {
  it("copies the exact code, without the prompt", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const onCopy = vi.fn();
    render(<CodeBlock code="curl -fsSL https://x | sh" prompt onCopy={onCopy} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
    expect(writeText).toHaveBeenCalledWith("curl -fsSL https://x | sh");
    expect(onCopy).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(screen.getByText("Copied to clipboard")).toBeInTheDocument();
  });

  it("falls back to execCommand when the clipboard API is unavailable", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;
    render(<CodeBlock code="echo hi" />);
    await userEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("stays in the idle state when copying fails", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    document.execCommand = vi.fn().mockReturnValue(false);
    render(<CodeBlock code="echo hi" />);
    await userEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
    expect(screen.getByRole("button", { name: "Copy to clipboard" })).toBeInTheDocument();
  });

  it("shows the label", () => {
    render(<CodeBlock code="x" label="Run on your server" />);
    expect(screen.getByText("Run on your server")).toBeInTheDocument();
  });
});

describe("Dialog", () => {
  it("opens from its trigger, is labelled, and closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove server</DialogTitle>
            <DialogDescription>This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog", { name: "Remove server" });
    expect(dialog).toHaveAccessibleDescription("This cannot be undone.");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes from the close button", async () => {
    const user = userEvent.setup();
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("tabTriggerClasses", () => {
  it("underlines the current tab with the AA-safe accent text colour", () => {
    expect(tabTriggerClasses).toContain("aria-[current=page]:border-accent-text");
    expect(tabTriggerClasses).not.toMatch(/border-accent(\s|$)/);
  });
});

describe("EmptyState", () => {
  it("renders the copy and action", () => {
    render(
      <EmptyState
        eyebrow="Phase 1"
        title="No projects yet"
        description="Projects arrive in Phase 1."
        action={<Button>Learn more</Button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "No projects yet" })).toBeInTheDocument();
    expect(screen.getByText("Phase 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Learn more" })).toBeInTheDocument();
  });
});

describe("StatCard", () => {
  it("is a labelled region with value and subline", () => {
    render(<StatCard label="Fleet" value="3 online" sub="1 needs attention" />);
    const region = screen.getByRole("region", { name: "Fleet" });
    expect(region).toHaveTextContent("3 online");
    expect(region).toHaveTextContent("1 needs attention");
  });
});

describe("ServerCard", () => {
  it("renders identity, status, meters and footer", () => {
    render(
      <ServerCard
        title="hel-1"
        meta="linux/amd64 · hel-1.example.com"
        status="online"
        metrics={[
          { label: "CPU", percent: 38, value: "38% · 8 vCPU" },
          { label: "RAM", percent: null, value: "—" },
        ]}
        footer="0 services · agent v0.1.0"
        footerAside="seen 4s ago"
      />,
    );
    expect(screen.getByRole("heading", { name: "hel-1" })).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getAllByRole("meter")).toHaveLength(2);
    expect(screen.getByText("0 services · agent v0.1.0")).toBeInTheDocument();
    expect(screen.getByText("seen 4s ago")).toBeInTheDocument();
  });
});

describe("ActivityItem", () => {
  it("renders actor, action, target and time", () => {
    render(
      <ul>
        <ActivityItem actor="Ada" action="added server" target="hel-1" time="4m" timestamp="x" />
      </ul>,
    );
    const item = screen.getByRole("listitem");
    expect(item).toHaveTextContent("Ada added server hel-1");
    expect(item.querySelector("time")).toHaveTextContent("4m");
  });
});

describe("toast", () => {
  it("shows toasts and dismisses them", async () => {
    const user = userEvent.setup();
    render(<Toaster />);
    act(() => {
      toast({ title: "Server removed", description: "hel-1 is gone", tone: "success" });
    });
    expect(await screen.findByText("Server removed")).toBeInTheDocument();
    expect(screen.getByText("hel-1 is gone")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss notification" }));
    await waitFor(() => expect(screen.queryByText("Server removed")).not.toBeInTheDocument());
  });

  it("returns increasing ids", () => {
    const a = toast({ title: "a" });
    const b = toast({ title: "b" });
    expect(b).toBeGreaterThan(a);
  });
});
