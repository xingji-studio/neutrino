import type { Buffer } from "./buffer.js";
import type { Key, MouseEvent } from "./input.js";
import type { App } from "../app.js";

/**
 * A screen's scrollbar, as seen by the app. Supplying this lets the app turn a
 * press/drag on the scrollbar column into scrolling, the same way a GUI does.
 */
export interface ScrollbarHandle {
  /** Column the bar is drawn in. */
  x: number;
  /** Inclusive row range of the groove. */
  top: number;
  bottom: number;
  /** Total scrollable lines and how many fit on screen. */
  total: number;
  viewport: number;
  /** Current topmost visible line. */
  offset: number;
  /** Scroll to the given offset (clamped by the screen). */
  scrollTo(offset: number): void;
}

export abstract class Screen {
  app!: App;

  abstract onKey(key: Key): void;

  onMouse(_ev: MouseEvent): void {}

  /**
   * Describe the on-screen scrollbar so the app can drag it, or null when this
   * screen has none / its content fits. Geometry is only valid right after a
   * render, which is exactly when the app needs it.
   */
  scrollbar(): ScrollbarHandle | null {
    return null;
  }

  /**
   * Rows this screen draws as persistent "chrome" (an input box, key hints, …)
   * that must be repainted on *every* frame, even when their contents are
   * unchanged.
   *
   * The renderer normally emits only rows whose cells changed, which is what
   * keeps redraws cheap. But the terminal can shift its own contents behind our
   * back — ConPTY reflowing the buffer mid-resize, a size-race repaint, a stray
   * scroll — and a diffed row would then stay stale forever (the classic
   * "input box swallowed by the log" artefact). Redrawing this small strip by
   * absolute position every frame makes it self-healing.
   */
  alwaysRepaintRows(): number[] {
    return [];
  }

  /**
   * Handle a bracketed (or detected) paste. `text` already has its newlines
   * flattened to spaces, so it can be inserted as a single line. Screens that
   * have no text input can leave this as a no-op.
   */
  onPaste(_text: string): void {}

  abstract render(buf: Buffer): void;

  /** Whether this screen currently shows a blinking text cursor. Used by the
   *  app to run (or stop) the cursor blink timer. */
  showsCursor(): boolean {
    return false;
  }

  onActivate(): void {}

  onDeactivate(): void {}
}
