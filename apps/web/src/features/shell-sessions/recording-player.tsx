/**
 * Plays one shell session's recording (ADR 0012 "Recording") in a read-only xterm.js
 * terminal: fetches the decrypted asciicast (asking for the password first when the
 * session isn't fresh), sizes the terminal to the recording, and replays its output and
 * resizes with play/pause, restart, 1x/2x/4x and a position readout. Keystrokes in the
 * recording are never shown (see `./playback`).
 *
 * @module
 */
import { type Asciicast, parseAsciicast } from "@roundhouse/shared";
import { Button, Skeleton } from "@roundhouse/ui";
import { PauseIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ErrorState } from "../../components/error-state";
import { errorMessage, isApiError } from "../../lib/api/client";
import { useShellRecording } from "../../queries/shell";
import { loadTerminal, type TerminalHandle } from "../services/shell/terminal";
import { IDLE_LIMIT_S, PLAYBACK_SPEEDS, Playback, type PlaybackSpeed, timeline } from "./playback";

/** Props for {@link RecordingPlayer}. */
export interface RecordingPlayerProps {
  /** `shl_…` of the session. */
  sessionId: string;
  /** Accessible name of the terminal, e.g. "Recording of web, replica 0". */
  label: string;
}

/** How often the position readout updates while playing, in ms. */
const READOUT_MS = 250;

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function refusal(error: unknown): string {
  if (isApiError(error, 404)) return "No recording is stored for this session.";
  if (isApiError(error, "reauth_required")) {
    return "Playing a recording needs a recent sign-in. Confirm your password to continue.";
  }
  if (isApiError(error, 403)) {
    return "You can't play this recording: it needs the audit log and the right to open a shell in its environment.";
  }
  return errorMessage(error, "Could not load the recording.");
}

/**
 * The player. Mount it only while it is shown: closing it drops the recording.
 *
 * @param props - Session id and the terminal's accessible name.
 * @returns The player.
 */
export function RecordingPlayer({ sessionId, label }: RecordingPlayerProps) {
  const recording = useShellRecording(sessionId);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const playbackRef = useRef<Playback | null>(null);

  const cast = useMemo((): Asciicast | Error | null => {
    if (recording.data === undefined) return null;
    try {
      return parseAsciicast(recording.data);
    } catch (cause) {
      return cause instanceof Error ? cause : new Error("Not a recording");
    }
  }, [recording.data]);

  useEffect(() => {
    if (!container || !cast || cast instanceof Error) return;
    let disposed = false;
    let terminal: TerminalHandle | null = null;
    let playback: Playback | null = null;
    const encoder = new TextEncoder();
    loadTerminal()
      .then((create) => {
        if (disposed) return;
        const term = create(container, { label, screenReaderMode: false, readOnly: true });
        terminal = term;
        const fitRecording = () => term.resize(cast.header.width, cast.header.height);
        fitRecording();
        playback = new Playback(
          timeline(cast),
          {
            write: (text) => term.write(encoder.encode(text)),
            resize: (cols, rows) => term.resize(cols, rows),
            reset: () => {
              term.reset();
              fitRecording();
            },
          },
          () => {
            setPosition(playback?.position() ?? 0);
            rerender();
          },
        );
        playbackRef.current = playback;
        playback.play();
      })
      .catch((cause: unknown) => {
        if (!disposed) setLoadError(errorMessage(cause, "Could not load the terminal."));
      });
    return () => {
      disposed = true;
      playback?.dispose();
      terminal?.dispose();
      playbackRef.current = null;
    };
  }, [container, cast, label]);

  const playback = playbackRef.current;
  const playing = playback?.playing ?? false;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setPosition(playbackRef.current?.position() ?? 0), READOUT_MS);
    return () => clearInterval(timer);
  }, [playing]);

  if (recording.isPending) return <Skeleton className="h-80 rounded-md" />;
  if (recording.isError) {
    return (
      <ErrorState message={refusal(recording.error)} onRetry={() => void recording.refetch()} />
    );
  }
  if (cast instanceof Error) {
    return <ErrorState message="This recording can't be read." />;
  }

  const duration = playback?.duration ?? 0;
  const speed = playback?.speed ?? 1;
  const percent = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  function toggle() {
    const current = playbackRef.current;
    if (!current) return;
    if (current.playing) current.pause();
    else current.play();
  }

  function setSpeed(next: PlaybackSpeed) {
    playbackRef.current?.setSpeed(next);
    rerender();
  }

  return (
    <div className="grid min-w-0 gap-3">
      {loadError ? (
        <p role="alert" className="text-sm text-danger">
          {loadError}
        </p>
      ) : null}
      <section
        aria-label="Recording"
        className="min-w-0 overflow-auto rounded-md border border-border bg-background"
      >
        <div ref={setContainer} className="min-h-72 w-max min-w-full p-2" />
      </section>
      <div
        role="progressbar"
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(position)}
        aria-valuetext={`${formatClock(position)} of ${formatClock(duration)}`}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" onClick={toggle} disabled={!playback}>
          {playing ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
          {playing ? "Pause" : "Play"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => playbackRef.current?.restart()}
          disabled={!playback}
        >
          <RotateCcwIcon aria-hidden="true" />
          Restart
        </Button>
        <fieldset className="flex items-center gap-1">
          <legend className="sr-only">Speed</legend>
          {PLAYBACK_SPEEDS.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={option === speed ? "secondary" : "ghost"}
              aria-pressed={option === speed}
              aria-label={`${option}x speed`}
              onClick={() => setSpeed(option)}
              disabled={!playback}
            >
              {option}x
            </Button>
          ))}
        </fieldset>
        <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
          {formatClock(position)} / {formatClock(duration)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Output only: keystrokes aren't replayed. Pauses longer than {IDLE_LIMIT_S} seconds are
        shortened.
      </p>
    </div>
  );
}
