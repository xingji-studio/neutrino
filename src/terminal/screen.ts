import type { Buffer } from "./buffer.js";
import type { Key, MouseEvent } from "./input.js";
import type { App } from "../app.js";

export abstract class Screen {
  app!: App;

  abstract onKey(key: Key): void;

  onMouse(_ev: MouseEvent): void {}

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
