import { describe, expect, it } from "vitest";
import { nextMenuItem } from "./menu";

const GROUPS = [0, 0, 0, 1, 1, 2];

describe("nextMenuItem", () => {
  it("walks items in order with up and down, wrapping at the ends", () => {
    expect(nextMenuItem("ArrowDown", -1, GROUPS)).toBe(0);
    expect(nextMenuItem("ArrowDown", 2, GROUPS)).toBe(3);
    expect(nextMenuItem("ArrowDown", 5, GROUPS)).toBe(0);
    expect(nextMenuItem("ArrowUp", 0, GROUPS)).toBe(5);
    expect(nextMenuItem("ArrowUp", 4, GROUPS)).toBe(3);
  });

  it("jumps to the first item of the next or previous group", () => {
    expect(nextMenuItem("ArrowRight", 1, GROUPS)).toBe(3);
    expect(nextMenuItem("ArrowRight", 4, GROUPS)).toBe(5);
    expect(nextMenuItem("ArrowRight", 5, GROUPS)).toBe(0);
    expect(nextMenuItem("ArrowLeft", 3, GROUPS)).toBe(0);
    expect(nextMenuItem("ArrowLeft", 0, GROUPS)).toBe(5);
    expect(nextMenuItem("ArrowRight", -1, GROUPS)).toBe(0);
  });

  it("supports Home and End and ignores other keys", () => {
    expect(nextMenuItem("Home", 4, GROUPS)).toBe(0);
    expect(nextMenuItem("End", 1, GROUPS)).toBe(5);
    expect(nextMenuItem("Enter", 1, GROUPS)).toBeNull();
    expect(nextMenuItem("ArrowDown", 0, [])).toBeNull();
  });
});
