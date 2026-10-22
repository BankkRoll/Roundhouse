import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  CommandPalette,
  filterCommands,
  isCommandPaletteHotkey,
  type PaletteCommand,
  useCommandPaletteHotkey,
} from "./command-palette";

function command(id: string, label: string, extra: Partial<PaletteCommand> = {}): PaletteCommand {
  return { id, label, onSelect: vi.fn(), ...extra };
}

const COMMANDS = [
  command("home", "Go to Home", { group: "Navigation", hint: ["G", "H"] }),
  command("servers", "Go to Servers", { group: "Navigation", hint: ["G", "S"] }),
  command("settings", "Go to Settings", { group: "Navigation" }),
  command("add-server", "Add server", { group: "Actions", keywords: ["node", "machine"] }),
  command("invite", "Invite member", { group: "Actions", keywords: ["teammate"] }),
  command("theme", "Toggle theme", { group: "Actions", keywords: ["dark", "light"] }),
];

describe("filterCommands", () => {
  it("returns everything for an empty or blank query", () => {
    expect(filterCommands(COMMANDS, "")).toHaveLength(COMMANDS.length);
    expect(filterCommands(COMMANDS, "   ")).toHaveLength(COMMANDS.length);
  });

  it("ranks label prefixes above word prefixes above substrings", () => {
    const ids = filterCommands(COMMANDS, "se").map((c) => c.id);
    expect(ids[0]).toBe("servers");
    expect(ids).toContain("settings");
    expect(ids.indexOf("add-server")).toBeGreaterThan(ids.indexOf("settings"));
  });

  it("puts an exact label prefix first", () => {
    expect(filterCommands(COMMANDS, "add")[0]?.id).toBe("add-server");
  });

  it("matches keywords that are not in the label", () => {
    expect(filterCommands(COMMANDS, "teammate").map((c) => c.id)).toEqual(["invite"]);
    expect(filterCommands(COMMANDS, "dark").map((c) => c.id)).toEqual(["theme"]);
  });

  it("falls back to in-order fuzzy matching", () => {
    expect(filterCommands(COMMANDS, "gtsrv").map((c) => c.id)).toEqual(["servers"]);
  });

  it("is case-insensitive", () => {
    expect(filterCommands(COMMANDS, "INVITE").map((c) => c.id)).toEqual(["invite"]);
  });

  it("returns nothing when no command matches", () => {
    expect(filterCommands(COMMANDS, "zzzz")).toEqual([]);
  });

  it("does not mutate its input", () => {
    const copy = [...COMMANDS];
    filterCommands(COMMANDS, "se");
    expect(COMMANDS).toEqual(copy);
  });
});

describe("isCommandPaletteHotkey", () => {
  const base = { key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

  it("accepts Cmd+K and Ctrl+K", () => {
    expect(isCommandPaletteHotkey({ ...base, metaKey: true })).toBe(true);
    expect(isCommandPaletteHotkey({ ...base, ctrlKey: true })).toBe(true);
    expect(isCommandPaletteHotkey({ ...base, key: "K", ctrlKey: true })).toBe(true);
  });

  it("rejects plain K and other combinations", () => {
    expect(isCommandPaletteHotkey(base)).toBe(false);
    expect(isCommandPaletteHotkey({ ...base, metaKey: true, shiftKey: true })).toBe(false);
    expect(isCommandPaletteHotkey({ ...base, ctrlKey: true, altKey: true })).toBe(false);
    expect(isCommandPaletteHotkey({ ...base, key: "j", metaKey: true })).toBe(false);
  });

  it("ignores the hotkey during IME composition", () => {
    expect(isCommandPaletteHotkey({ ...base, ctrlKey: true, isComposing: true })).toBe(false);
  });
});

function Harness({ commands }: { commands: PaletteCommand[] }) {
  const [open, setOpen] = useState(false);
  useCommandPaletteHotkey(() => setOpen((value) => !value));
  return (
    <>
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <CommandPalette open={open} onOpenChange={setOpen} commands={commands} />
    </>
  );
}

function fresh() {
  return COMMANDS.map((c) => ({ ...c, onSelect: vi.fn() }));
}

describe("CommandPalette", () => {
  it("opens with Ctrl+K and closes with Escape", async () => {
    const user = userEvent.setup();
    render(<Harness commands={fresh()} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("combobox", { name: "Search commands" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("toggles closed when the hotkey is pressed again", async () => {
    render(<Harness commands={fresh()} />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByTestId("state")).toHaveTextContent("closed");
  });

  it("lists commands under their group headings", async () => {
    render(<CommandPalette open onOpenChange={() => {}} commands={fresh()} />);
    expect(screen.getByRole("group", { name: "Navigation" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Actions" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(COMMANDS.length);
  });

  it("filters as the user types and runs the top match on Enter", async () => {
    const user = userEvent.setup();
    const commands = fresh();
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} commands={commands} />);
    await user.type(screen.getByRole("combobox"), "invite");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(commands[4]?.onSelect).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("moves the selection with arrow keys and wraps around", async () => {
    const user = userEvent.setup();
    const commands = fresh();
    render(<CommandPalette open onOpenChange={() => {}} commands={commands} />);
    const input = screen.getByRole("combobox");
    const selected = () =>
      screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");

    expect(selected()).toHaveTextContent("Go to Home");
    expect(input).toHaveAttribute("aria-activedescendant", selected()?.id);

    await user.keyboard("{ArrowDown}");
    expect(selected()).toHaveTextContent("Go to Servers");

    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(selected()).toHaveTextContent("Toggle theme");

    await user.keyboard("{Home}");
    expect(selected()).toHaveTextContent("Go to Home");

    await user.keyboard("{End}{Enter}");
    expect(commands[5]?.onSelect).toHaveBeenCalledOnce();
  });

  it("resets the selection to the first result when the query changes", async () => {
    const user = userEvent.setup();
    render(<CommandPalette open onOpenChange={() => {}} commands={fresh()} />);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await user.type(screen.getByRole("combobox"), "go");
    const first = screen.getAllByRole("option")[0];
    expect(first).toHaveAttribute("aria-selected", "true");
  });

  it("runs a command on click", async () => {
    const user = userEvent.setup();
    const commands = fresh();
    render(<CommandPalette open onOpenChange={() => {}} commands={commands} />);
    await user.click(screen.getByRole("option", { name: /Add server/ }));
    expect(commands[3]?.onSelect).toHaveBeenCalledOnce();
  });

  it("shows an empty message when nothing matches and ignores Enter", async () => {
    const user = userEvent.setup();
    const commands = fresh();
    render(<CommandPalette open onOpenChange={() => {}} commands={commands} />);
    await user.type(screen.getByRole("combobox"), "qqqq{Enter}");
    expect(screen.getByText("No matching commands.")).toBeInTheDocument();
    for (const c of commands) expect(c.onSelect).not.toHaveBeenCalled();
  });

  it("clears the query when reopened", async () => {
    const user = userEvent.setup();
    render(<Harness commands={fresh()} />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.type(await screen.findByRole("combobox"), "theme");
    await user.keyboard("{Escape}");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("combobox")).toHaveValue("");
  });

  it("starts at the first command again when reopened", async () => {
    const user = userEvent.setup();
    render(<Harness commands={fresh()} />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await screen.findByRole("combobox");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await user.keyboard("{Escape}");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await screen.findByRole("combobox");
    const selected = screen
      .getAllByRole("option")
      .find((option) => option.getAttribute("aria-selected") === "true");
    expect(selected).toHaveTextContent("Go to Home");
  });
});
