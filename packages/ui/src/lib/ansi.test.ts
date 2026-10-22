import { describe, expect, it } from "vitest";
import { ansiColorCss, parseAnsi, stripAnsi, xterm256 } from "./ansi";

const ESC = "\x1b";

describe("parseAnsi", () => {
  it("returns plain text as one unstyled run", () => {
    expect(parseAnsi("hello world")).toEqual([{ text: "hello world", style: {} }]);
  });

  it("applies and resets SGR colors and attributes", () => {
    expect(parseAnsi(`${ESC}[1;31merror${ESC}[0m: boom`)).toEqual([
      { text: "error", style: { bold: true, fg: { kind: "palette", index: 1 } } },
      { text: ": boom", style: {} },
    ]);
  });

  it("supports bright, background, 256-color and truecolor codes", () => {
    const [bright, bg, cube, rgb] = parseAnsi(
      `${ESC}[92ma${ESC}[0;44mb${ESC}[0;38;5;196mc${ESC}[0;38;2;10;20;30md`,
    );
    expect(bright?.style.fg).toEqual({ kind: "palette", index: 10 });
    expect(bg?.style.bg).toEqual({ kind: "palette", index: 4 });
    expect(cube?.style.fg).toEqual({ kind: "rgb", r: 255, g: 0, b: 0 });
    expect(rgb?.style.fg).toEqual({ kind: "rgb", r: 10, g: 20, b: 30 });
  });

  it("accepts colon-separated subparameters", () => {
    expect(parseAnsi(`${ESC}[38:2:1:2:3mx`)[0]?.style.fg).toEqual({
      kind: "rgb",
      r: 1,
      g: 2,
      b: 3,
    });
  });

  it("treats an empty SGR as a reset", () => {
    expect(parseAnsi(`${ESC}[31ma${ESC}[mb`)[1]).toEqual({ text: "b", style: {} });
  });

  it("ignores out-of-range color channels instead of emitting them", () => {
    const [segment] = parseAnsi(`${ESC}[38;2;999;0;0mx`);
    expect(segment).toEqual({ text: "x", style: {} });
    expect(parseAnsi(`${ESC}[38;5;300mx`)[0]?.style.fg).toBeUndefined();
  });

  describe("hostile input", () => {
    it.each([
      ["cursor movement", `a${ESC}[2Jb${ESC}[10;10Hc`, "abc"],
      ["private modes", `${ESC}[?25lhidden cursor${ESC}[?25h`, "hidden cursor"],
      ["window title (OSC, BEL)", `${ESC}]0;pwned${"\x07"}ok`, "ok"],
      [
        "OSC 8 hyperlink (ST)",
        `${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`,
        "click",
      ],
      ["DCS string", `${ESC}Pq#0;2;0;0;0${ESC}\\after`, "after"],
      ["APC and PM strings", `${ESC}_x${ESC}\\${ESC}^y${ESC}\\z`, "z"],
      ["C1 CSI", `\x9b31mred`, "red"],
      ["C1 OSC", `\x9d0;title\x07rest`, "rest"],
      ["bell, backspace and NUL", "a\x07b\x08c\x00d", "abcd"],
      ["DEL and C1 controls", "a\x7fb\x85c", "abc"],
      ["markup", "<img src=x onerror=alert(1)>", "<img src=x onerror=alert(1)>"],
    ])("drops %s", (_, input, visible) => {
      expect(stripAnsi(input)).toBe(visible);
    });

    it("drops an unterminated OSC to the end of the line instead of looping", () => {
      expect(stripAnsi(`ok${ESC}]0;never terminated`)).toBe("ok");
    });

    it("drops an unterminated CSI", () => {
      expect(stripAnsi(`ok${ESC}[31`)).toBe("ok");
    });

    it("handles a trailing lone ESC", () => {
      expect(stripAnsi(`ok${ESC}`)).toBe("ok");
    });

    it("keeps tabs", () => {
      expect(stripAnsi("a\tb")).toBe("a\tb");
    });

    it("keeps only the last carriage-return frame, like a terminal", () => {
      expect(stripAnsi("10%\r50%\r100%")).toBe("100%");
      expect(stripAnsi("line\r")).toBe("line");
    });

    it("parses a pathological sequence in linear time", () => {
      const input = `${ESC}[${"1;".repeat(100_000)}31mx`;
      const started = performance.now();
      expect(stripAnsi(input)).toBe("x");
      expect(performance.now() - started).toBeLessThan(500);
    });
  });
});

describe("xterm256", () => {
  it("maps the cube and grayscale ramp", () => {
    expect(xterm256(1)).toEqual({ kind: "palette", index: 1 });
    expect(xterm256(16)).toEqual({ kind: "rgb", r: 0, g: 0, b: 0 });
    expect(xterm256(231)).toEqual({ kind: "rgb", r: 255, g: 255, b: 255 });
    expect(xterm256(232)).toEqual({ kind: "rgb", r: 8, g: 8, b: 8 });
  });
});

describe("ansiColorCss", () => {
  it("emits only well-formed constants", () => {
    expect(ansiColorCss({ kind: "palette", index: 3 })).toBe("var(--ansi-3)");
    expect(ansiColorCss({ kind: "palette", index: 99 })).toBe("var(--ansi-15)");
    expect(ansiColorCss({ kind: "rgb", r: 1.7, g: 2, b: 3 })).toBe("rgb(1 2 3)");
  });
});
