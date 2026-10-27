import { parseAsciicast } from "@roundhouse/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_LIMIT_S, Playback, type PlaybackSink, timeline } from "./playback";

const CAST = [
  JSON.stringify({ version: 2, width: 80, height: 24 }),
  '[0.5,"o","$ "]',
  '[1.0,"i","secret-password\\r"]',
  '[1.0,"o","ok\\r\\n"]',
  '[2.0,"r","100x30"]',
  '[2.0,"r","nonsense"]',
  '[60.0,"o","after a long idle"]',
].join("\n");

function sink() {
  const calls: string[] = [];
  const target: PlaybackSink = {
    write: (text) => calls.push(`o:${text}`),
    resize: (cols, rows) => calls.push(`r:${cols}x${rows}`),
    reset: () => calls.push("reset"),
  };
  return { calls, target };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("timeline", () => {
  it("keeps output and valid resizes, drops input, and shortens idle gaps", () => {
    const events = timeline(parseAsciicast(CAST));
    expect(events.map((e) => e.kind)).toEqual(["o", "o", "r", "o"]);
    expect(events.map((e) => e.data).join("|")).not.toContain("secret-password");
    expect(events.at(-1)!.time).toBe(2 + IDLE_LIMIT_S);
  });
});

describe("Playback", () => {
  it("writes events when they are due, at the chosen speed", () => {
    const { calls, target } = sink();
    const playback = new Playback(timeline(parseAsciicast(CAST)), target);
    playback.play();
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(calls).toEqual(["o:$ "]);
    playback.setSpeed(2);
    vi.advanceTimersByTime(250);
    expect(calls).toEqual(["o:$ ", "o:ok\r\n"]);
    vi.advanceTimersByTime(500);
    expect(calls.at(-1)).toBe("r:100x30");
    playback.setSpeed(4);
    vi.advanceTimersByTime(500);
    expect(calls.at(-1)).toBe("o:after a long idle");
    expect(playback.finished).toBe(true);
    expect(playback.playing).toBe(false);
    expect(playback.position()).toBe(playback.duration);
  });

  it("pauses, resumes where it was, and restarts from a clear screen", () => {
    const { calls, target } = sink();
    const changes = vi.fn();
    const playback = new Playback(timeline(parseAsciicast(CAST)), target, changes);
    playback.play();
    vi.advanceTimersByTime(700);
    playback.pause();
    expect(playback.position()).toBeCloseTo(0.7);
    vi.advanceTimersByTime(10_000);
    expect(calls).toEqual(["o:$ "]);
    playback.play();
    vi.advanceTimersByTime(300);
    expect(calls).toEqual(["o:$ ", "o:ok\r\n"]);
    playback.restart();
    expect(calls.at(-1)).toBe("reset");
    vi.advanceTimersByTime(500);
    expect(calls.at(-1)).toBe("o:$ ");
    expect(changes).toHaveBeenCalled();
    playback.dispose();
    vi.advanceTimersByTime(10_000);
    expect(calls.at(-1)).toBe("o:$ ");
  });

  it("plays again from the start once finished", () => {
    const { calls, target } = sink();
    const playback = new Playback(timeline(parseAsciicast(CAST)), target);
    playback.play();
    vi.runAllTimers();
    expect(playback.finished).toBe(true);
    playback.play();
    expect(calls.filter((c) => c === "reset")).toHaveLength(1);
  });
});
