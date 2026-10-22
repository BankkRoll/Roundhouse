import { describe, expect, it, vi } from "vitest";
import {
  createShortcutHandler,
  isEditableTarget,
  isOverlayOpen,
  type ShortcutKeyEvent,
} from "./shortcuts";

function keyEvent(key: string, overrides: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    target: document.body,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

function setup(timeoutMs = 1000) {
  let clock = 0;
  const goServers = vi.fn();
  const goHome = vi.fn();
  const help = vi.fn();
  const handler = createShortcutHandler(
    [
      { keys: ["g", "s"], run: goServers },
      { keys: ["g", "h"], run: goHome },
      { keys: ["?"], run: help },
    ],
    { timeoutMs, now: () => clock },
  );
  const press = (key: string, overrides?: Partial<ShortcutKeyEvent>) => {
    const event = keyEvent(key, overrides);
    handler(event);
    return event;
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  return { press, advance, goServers, goHome, help };
}

describe("createShortcutHandler", () => {
  it("runs a two-key sequence", () => {
    const { press, goServers, goHome } = setup();
    press("g");
    const second = press("s");
    expect(goServers).toHaveBeenCalledOnce();
    expect(goHome).not.toHaveBeenCalled();
    expect(second.preventDefault).toHaveBeenCalled();
  });

  it("is case-insensitive", () => {
    const { press, goHome } = setup();
    press("G");
    press("H");
    expect(goHome).toHaveBeenCalledOnce();
  });

  it("runs single-key bindings immediately", () => {
    const { press, help } = setup();
    press("?");
    expect(help).toHaveBeenCalledOnce();
  });

  it("does not run on the prefix alone", () => {
    const { press, goServers, goHome } = setup();
    const event = press("g");
    expect(goServers).not.toHaveBeenCalled();
    expect(goHome).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("resets when the second key comes too late", () => {
    const { press, advance, goServers } = setup(500);
    press("g");
    advance(501);
    press("s");
    expect(goServers).not.toHaveBeenCalled();
  });

  it("accepts the second key right at the timeout", () => {
    const { press, advance, goServers } = setup(500);
    press("g");
    advance(500);
    press("s");
    expect(goServers).toHaveBeenCalledOnce();
  });

  it("drops an unrelated key and restarts the sequence", () => {
    const { press, goServers } = setup();
    press("g");
    press("x");
    press("s");
    expect(goServers).not.toHaveBeenCalled();
    press("g");
    press("s");
    expect(goServers).toHaveBeenCalledOnce();
  });

  it("treats a repeated prefix as a fresh start", () => {
    const { press, goServers } = setup();
    press("g");
    press("g");
    press("s");
    expect(goServers).toHaveBeenCalledOnce();
  });

  it("clears the buffer after a match so the next key starts over", () => {
    const { press, goServers } = setup();
    press("g");
    press("s");
    press("s");
    expect(goServers).toHaveBeenCalledOnce();
  });

  it.each([
    ["metaKey", { metaKey: true }],
    ["ctrlKey", { ctrlKey: true }],
    ["altKey", { altKey: true }],
  ])("ignores keys pressed with %s", (_, modifier) => {
    const { press, goServers } = setup();
    press("g", modifier);
    press("s", modifier);
    expect(goServers).not.toHaveBeenCalled();
  });

  it("ignores events another handler already handled", () => {
    const { press, goServers } = setup();
    press("g");
    press("s", { defaultPrevented: true });
    expect(goServers).not.toHaveBeenCalled();
  });

  it("ignores named keys such as Shift or Escape", () => {
    const { press, goServers } = setup();
    press("g");
    press("Shift");
    press("s");
    expect(goServers).toHaveBeenCalledOnce();
  });

  it.each(["input", "textarea", "select"])("ignores keys typed into a %s", (tag) => {
    const { press, goServers } = setup();
    const target = document.createElement(tag);
    press("g", { target });
    press("s", { target });
    expect(goServers).not.toHaveBeenCalled();
  });

  it("ignores keys while an IME is composing", () => {
    const { press, goServers } = setup();
    press("g", { isComposing: true });
    press("s", { isComposing: true });
    press("g");
    press("Process");
    press("s");
    expect(goServers).toHaveBeenCalledOnce();
    press("g");
    press("s", { isComposing: true });
    expect(goServers).toHaveBeenCalledOnce();
  });

  it("does nothing while suspended", () => {
    let suspended = true;
    const run = vi.fn();
    const handler = createShortcutHandler([{ keys: ["g", "s"], run }], {
      isSuspended: () => suspended,
    });
    handler(keyEvent("g"));
    handler(keyEvent("s"));
    expect(run).not.toHaveBeenCalled();
    suspended = false;
    handler(keyEvent("g"));
    handler(keyEvent("s"));
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("isOverlayOpen", () => {
  it.each(["dialog", "alertdialog", "menu", "listbox"])("detects an open %s", (role) => {
    const element = document.createElement("div");
    element.setAttribute("role", role);
    document.body.append(element);
    expect(isOverlayOpen()).toBe(true);
    element.remove();
    expect(isOverlayOpen()).toBe(false);
  });

  it("ignores non-modal roles such as tooltips", () => {
    const root = document.createElement("div");
    root.innerHTML = '<div role="tooltip"></div><nav></nav>';
    expect(isOverlayOpen(root)).toBe(false);
  });
});

describe("isEditableTarget", () => {
  it("detects contenteditable elements", () => {
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    expect(isEditableTarget(div)).toBe(true);
  });

  it("returns false for plain elements and null", () => {
    expect(isEditableTarget(document.createElement("button"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
  });
});
