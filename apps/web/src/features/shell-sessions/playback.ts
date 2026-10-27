/**
 * Replays an asciicast recording against a terminal on a timer: output and resizes in
 * order, at 1x, 2x or 4x, with pause, resume and restart. Input events are never
 * replayed: the output already shows what the shell echoed, and keystrokes the shell
 * didn't echo (passwords) must stay out of view.
 *
 * Long idle stretches are shortened to {@link IDLE_LIMIT_S}, so a session left open for an
 * hour doesn't play as an hour of nothing; times and the duration are on that shortened
 * timeline.
 *
 * @module
 */
import { type Asciicast, parseAsciicastSize } from "@roundhouse/shared";

/** Longest pause between two events in playback, in seconds. */
export const IDLE_LIMIT_S = 2;

/** Playback speeds offered. */
export const PLAYBACK_SPEEDS = [1, 2, 4] as const;

/** A playback speed. */
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/** One replayable event on the shortened timeline. */
export interface PlaybackEvent {
  /** Seconds from the start. */
  time: number;
  kind: "o" | "r";
  data: string;
}

/** Where playback writes. */
export interface PlaybackSink {
  write(text: string): void;
  resize(cols: number, rows: number): void;
  /** Clears the screen before a restart. */
  reset(): void;
}

/**
 * The replayable events of a recording: output and valid resizes, with idle gaps
 * capped at {@link IDLE_LIMIT_S}.
 *
 * @param cast - A parsed recording.
 * @returns The events, in order.
 * @example
 * timeline(parseAsciicast(text)).map((e) => e.kind); // ["o", "r", "o"]
 */
export function timeline(cast: Asciicast): PlaybackEvent[] {
  const out: PlaybackEvent[] = [];
  let previous = 0;
  let shifted = 0;
  for (const [time, kind, data] of cast.events) {
    const gap = Math.max(0, time - previous);
    previous = Math.max(previous, time);
    shifted += Math.min(gap, IDLE_LIMIT_S);
    if (kind === "o") out.push({ time: shifted, kind, data });
    else if (kind === "r" && parseAsciicastSize(data)) out.push({ time: shifted, kind, data });
  }
  return out;
}

/** Drives a {@link PlaybackSink} through a recording's events. */
export class Playback {
  private index = 0;
  /** Recording time at {@link anchor}, in seconds. */
  private elapsed = 0;
  /** Wall-clock ms when playback last started or changed speed. */
  private anchor = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private currentSpeed: PlaybackSpeed = 1;
  private running = false;
  /** Length of the shortened timeline, in seconds. */
  readonly duration: number;

  /**
   * @param events - From {@link timeline}.
   * @param sink - The terminal.
   * @param onChange - Called when playback starts, pauses or reaches the end.
   * @param now - Wall clock in ms; tests pass a fake one.
   */
  constructor(
    private readonly events: readonly PlaybackEvent[],
    private readonly sink: PlaybackSink,
    private readonly onChange: () => void = () => {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.duration = events.length ? events[events.length - 1]!.time : 0;
  }

  /** Whether it is playing. */
  get playing(): boolean {
    return this.running;
  }

  /** Whether every event has been written. */
  get finished(): boolean {
    return this.index >= this.events.length;
  }

  /** The current speed. */
  get speed(): PlaybackSpeed {
    return this.currentSpeed;
  }

  /**
   * The position on the shortened timeline.
   *
   * @returns Seconds, at most {@link duration}.
   */
  position(): number {
    const at = this.running
      ? this.elapsed + ((this.now() - this.anchor) / 1000) * this.currentSpeed
      : this.elapsed;
    return Math.min(at, this.duration);
  }

  /** Starts or resumes; from the start again once finished. */
  play(): void {
    if (this.running) return;
    if (this.finished) this.rewind();
    this.running = true;
    this.anchor = this.now();
    this.step();
    this.onChange();
  }

  /** Pauses where it is. */
  pause(): void {
    if (!this.running) return;
    this.elapsed = this.position();
    this.running = false;
    this.clear();
    this.onChange();
  }

  /**
   * Changes the speed without jumping.
   *
   * @param speed - 1, 2 or 4.
   */
  setSpeed(speed: PlaybackSpeed): void {
    this.elapsed = this.position();
    this.anchor = this.now();
    this.currentSpeed = speed;
    if (this.running) {
      this.clear();
      this.schedule();
    }
  }

  /** Clears the terminal and plays from the start. */
  restart(): void {
    this.clear();
    this.running = false;
    this.rewind();
    this.play();
  }

  /** Stops the timer for good. */
  dispose(): void {
    this.clear();
    this.running = false;
  }

  private rewind(): void {
    this.index = 0;
    this.elapsed = 0;
    this.sink.reset();
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Writes every event that is due, then waits for the next one. */
  private step(): void {
    const at = this.position();
    while (this.index < this.events.length && this.events[this.index]!.time <= at) {
      const event = this.events[this.index++]!;
      if (event.kind === "o") {
        this.sink.write(event.data);
      } else {
        const size = parseAsciicastSize(event.data);
        if (size) this.sink.resize(size.cols, size.rows);
      }
    }
    if (this.finished) {
      this.elapsed = this.duration;
      this.running = false;
      this.clear();
      this.onChange();
      return;
    }
    this.schedule();
  }

  private schedule(): void {
    const next = this.events[this.index];
    if (!next) return;
    const wait = Math.max(0, ((next.time - this.position()) / this.currentSpeed) * 1000);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.running) this.step();
    }, wait);
  }
}
