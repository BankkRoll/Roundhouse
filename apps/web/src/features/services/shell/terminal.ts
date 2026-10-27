/**
 * The terminal emulator behind the Shell tab, loaded on first connect so xterm.js and
 * its stylesheet stay out of every other page's bundle. The rest of the tab talks to
 * the small {@link TerminalHandle} interface, which tests replace (jsdom has no canvas).
 *
 * @module
 */

/** Disposes a subscription. */
export interface Disposable {
  dispose(): void;
}

/** What the Shell tab needs from a terminal. */
export interface TerminalHandle {
  /** Current size in cells. */
  readonly cols: number;
  readonly rows: number;
  /** Writes output bytes. */
  write(bytes: Uint8Array): void;
  /** Writes a notice in the dashboard's words, not the process's. */
  writeNotice(text: string): void;
  /** Keystrokes and pastes, as text. */
  onData(listener: (data: string) => void): Disposable;
  /** Raw bytes some mouse modes report, one character per byte. */
  onBinary(listener: (data: string) => void): Disposable;
  /**
   * Fits the terminal to its element.
   *
   * @returns The size afterwards.
   */
  fit(): { cols: number; rows: number };
  /** Clears the screen and scrollback for a new session. */
  reset(): void;
  focus(): void;
  blur(): void;
  /** Turns xterm's screen reader support (a live, readable text buffer) on or off. */
  setScreenReaderMode(enabled: boolean): void;
  /**
   * Lets the page take keys before the shell sees them.
   *
   * @param handler - Returns `false` to keep a key from the shell.
   */
  onKey(handler: (event: KeyboardEvent) => boolean): void;
  dispose(): void;
}

/** Options for {@link CreateTerminal}. */
export interface TerminalOptions {
  /** Accessible name of the terminal's input. */
  label: string;
  screenReaderMode: boolean;
}

/** Mounts a terminal in an element. */
export type CreateTerminal = (element: HTMLElement, options: TerminalOptions) => TerminalHandle;

let loading: Promise<CreateTerminal> | null = null;

/**
 * Loads xterm.js, its fit and web-links addons and its stylesheet, once.
 *
 * @returns A factory for terminals.
 */
export function loadTerminal(): Promise<CreateTerminal> {
  loading ??= Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-web-links"),
    import("@xterm/xterm/css/xterm.css"),
  ])
    .then(([{ Terminal }, { FitAddon }, { WebLinksAddon }]) => {
      const create: CreateTerminal = (element, options) => {
        const styles = getComputedStyle(document.documentElement);
        const token = (name: string, fallback: string) =>
          styles.getPropertyValue(name).trim() || fallback;
        const terminal = new Terminal({
          convertEol: false,
          cursorBlink: true,
          fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
          fontSize: 13,
          scrollback: 5000,
          screenReaderMode: options.screenReaderMode,
          theme: {
            background: token("--background", "#0b0c0d"),
            foreground: token("--foreground", "#e8eaed"),
          },
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.loadAddon(new WebLinksAddon());
        terminal.open(element);
        terminal.textarea?.setAttribute("aria-label", options.label);
        return {
          get cols() {
            return terminal.cols;
          },
          get rows() {
            return terminal.rows;
          },
          write: (bytes) => terminal.write(bytes),
          writeNotice: (text) => terminal.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`),
          onData: (listener) => terminal.onData(listener),
          onBinary: (listener) => terminal.onBinary(listener),
          fit: () => {
            // NOTE: fit() throws while the element is hidden or detached (no renderer
            // dimensions yet); the next resize fits it.
            try {
              fit.fit();
            } catch {}
            return { cols: terminal.cols, rows: terminal.rows };
          },
          reset: () => terminal.reset(),
          focus: () => terminal.focus(),
          blur: () => terminal.blur(),
          setScreenReaderMode: (enabled) => {
            terminal.options.screenReaderMode = enabled;
          },
          onKey: (handler) => terminal.attachCustomKeyEventHandler(handler),
          dispose: () => terminal.dispose(),
        };
      };
      return create;
    })
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}
